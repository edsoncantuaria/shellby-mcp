import {
  fillRef,
  focusIsSecret,
  focusRef,
  locateRef,
  pageText,
  scrollAt,
  snapshotPage,
} from "./page-scripts.js"
import { classifyUrl, hmacHex, parseKeyCombo, redactUrl, siteKey } from "./policy.js"

const GROUP_TITLE = "Shellby"
const RECONNECT_ALARM = "shellby-reconnect"
const KEEPALIVE_MS = 20_000
const LOAD_TIMEOUT_MS = 15_000
const CAPTURE_TIMEOUT_MS = 5_000
const LOG_LIMIT = 200
const WHEEL_TICK = 120
const MOUSE_BUTTONS = {
  click: { button: "left", clickCount: 1 },
  double_click: { button: "left", clickCount: 2 },
  right_click: { button: "right", clickCount: 1 },
}
const SCROLL_DELTAS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }

class CommandError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// ---- Connection -------------------------------------------------------------------------------

let socket
let connecting = false
let keepalive

async function setStatus(status) {
  await chrome.storage.session.set({ status })
  await chrome.action.setBadgeText({ text: status === "connected" ? "ON" : "" })
}

async function connect() {
  if (socket || connecting) return
  connecting = true
  try {
    const { pairing, paused } = await chrome.storage.local.get(["pairing", "paused"])
    if (paused) return await setStatus("paused")
    if (!pairing) return await setStatus("unpaired")
    open(pairing)
  } finally {
    connecting = false
  }
}

function open(pairing) {
  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/`)
  const link = { secret: pairing.secret, authenticated: false, nonce: undefined }
  socket = ws
  ws.onmessage = (event) => {
    onMessage(ws, link, JSON.parse(event.data)).catch(() => ws.close())
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = undefined
    clearInterval(keepalive)
    detachAll()
    setStatus("disconnected")
  }
  clearInterval(keepalive)
  // Socket traffic is what keeps a Manifest V3 service worker alive.
  keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }))
  }, KEEPALIVE_MS)
}

function disconnect() {
  const ws = socket
  socket = undefined
  clearInterval(keepalive)
  detachAll()
  ws?.close()
}

async function onMessage(ws, link, message) {
  if (message.type === "challenge" && !link.nonce) {
    link.nonce = crypto.randomUUID() + crypto.randomUUID()
    link.challenge = message.nonce
    const proof = await hmacHex(link.secret, `client:${message.nonce}`)
    ws.send(JSON.stringify({ type: "auth", proof, nonce: link.nonce }))
    return
  }
  if (message.type === "authenticated" && link.nonce) {
    // Only a server that also holds the secret may issue commands.
    const expected = await hmacHex(link.secret, `server:${link.challenge}:${link.nonce}`)
    if (message.proof !== expected) throw new Error("Bridge failed to authenticate.")
    link.authenticated = true
    await setStatus("connected")
    return
  }
  if (message.type === "call" && link.authenticated) {
    await handleCall(ws, message)
    return
  }
  throw new Error("Unexpected bridge message.")
}

async function handleCall(ws, { id, method, params }) {
  let response
  try {
    const handler = METHODS.get(method)
    if (!handler) throw new CommandError("UNKNOWN_METHOD", `Unknown method ${method}.`)
    response = { type: "result", id, ok: true, result: await handler(params) }
  } catch (error) {
    const code = error.code ?? "EXTENSION_ERROR"
    response = { type: "result", id, ok: false, error: { code, message: error.message } }
  }
  ws.send(JSON.stringify(response))
}

// ---- Trust boundary: the Shellby tab group and user-approved sites ------------------------------

async function isShellbyTab(tab) {
  if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return false
  const group = await chrome.tabGroups.get(tab.groupId)
  return group.title === GROUP_TITLE
}

async function requireTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab || !(await isShellbyTab(tab)))
    throw new CommandError("TAB_NOT_IN_GROUP", `Tab ${tabId} is not in the Shellby tab group.`)
  return tab
}

const approvalWindows = new Map()

async function askApproval(origin) {
  const existing = approvalWindows.get(origin)
  if (existing !== undefined) {
    await chrome.windows.update(existing, { focused: true }).catch(() => undefined)
    return
  }
  const page = chrome.runtime.getURL(`approve.html?origin=${encodeURIComponent(origin)}`)
  const created = await chrome.windows.create({
    url: page,
    type: "popup",
    width: 460,
    height: 300,
    focused: true,
  })
  approvalWindows.set(origin, created.id)
}

async function requireSite(url) {
  const verdict = classifyUrl(url)
  if (verdict.kind === "blank") return
  if (verdict.kind === "protected")
    throw new CommandError("PROTECTED_URL", "Shellby may only act on http(s) pages.")
  const key = siteKey(verdict.origin)
  const decision = (await chrome.storage.local.get(key))[key]
  if (decision === "allow") return
  if (decision === "deny")
    throw new CommandError("SITE_DENIED", `The user denied Shellby access to ${verdict.origin}.`)
  await askApproval(verdict.origin)
  throw new CommandError(
    "SITE_APPROVAL_REQUIRED",
    `Approval for ${verdict.origin} is waiting in Chrome. Ask the user to answer it, then retry.`
  )
}

/** Run a read, then confirm the tab did not move to an unapproved site while it ran. */
async function readingTab(tabId, capture) {
  await requireSite((await requireTab(tabId)).url)
  const result = await capture()
  await requireSite((await requireTab(tabId)).url)
  return result
}

// ---- Debugger sessions --------------------------------------------------------------------------

const sessions = new Map()

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params)
}

function attach(tabId) {
  let session = sessions.get(tabId)
  if (!session) {
    session = { ready: startSession(tabId), consoleLog: [], network: new Map(), world: undefined }
    sessions.set(tabId, session)
    session.ready.catch(() => sessions.delete(tabId))
  }
  return session.ready.then(() => session)
}

async function startSession(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3")
  await Promise.all(["Page.enable", "Runtime.enable", "Network.enable"].map((m) => send(tabId, m)))
  // Lets background tabs keep focus-dependent behavior without stealing the user's window.
  await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true })
}

function detachAll() {
  for (const tabId of sessions.keys()) detach(tabId)
}

function detach(tabId) {
  sessions.delete(tabId)
  chrome.debugger.detach({ tabId }).catch(() => undefined)
}

function pushBounded(list, entry) {
  list.push(entry)
  if (list.length > LOG_LIMIT) list.shift()
}

function formatRemoteValue(arg) {
  return arg.value === undefined ? (arg.description ?? arg.type) : String(arg.value)
}

function resetIfOriginChanged(session, url) {
  const verdict = classifyUrl(url)
  const origin = verdict.kind === "site" ? verdict.origin : undefined
  // Logs from one site must not be readable once the tab is on another.
  if (session.origin !== undefined && origin !== session.origin) {
    session.consoleLog.length = 0
    session.network.clear()
  }
  session.origin = origin
}

const EVENT_HANDLERS = {
  "Runtime.consoleAPICalled": (session, { type, args }) => {
    const text = args.map(formatRemoteValue).join(" ").slice(0, 2_000)
    pushBounded(session.consoleLog, { level: type, text })
  },
  "Runtime.exceptionThrown": (session, { exceptionDetails }) => {
    const text = exceptionDetails.exception?.description ?? exceptionDetails.text
    pushBounded(session.consoleLog, { level: "error", text: text.slice(0, 2_000) })
  },
  "Runtime.executionContextsCleared": (session) => {
    session.world = undefined
  },
  "Page.frameNavigated": (session, { frame }) => {
    if (frame.parentId) return
    session.world = undefined
    resetIfOriginChanged(session, frame.url)
  },
  "Network.requestWillBeSent": (session, { requestId, request, type }) => {
    session.network.set(requestId, {
      method: request.method,
      url: redactUrl(request.url).slice(0, 1_000),
      type,
    })
    if (session.network.size > LOG_LIMIT)
      session.network.delete(session.network.keys().next().value)
  },
  "Network.responseReceived": (session, { requestId, response }) => {
    const entry = session.network.get(requestId)
    if (entry) entry.status = response.status
  },
  "Network.loadingFailed": (session, { requestId, errorText }) => {
    const entry = session.network.get(requestId)
    if (entry) entry.failed = errorText
  },
}

async function isolatedWorld(tabId, session) {
  if (session.world === undefined) {
    const { frameTree } = await send(tabId, "Page.getFrameTree")
    const { executionContextId } = await send(tabId, "Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "shellby",
    })
    session.world = executionContextId
  }
  return session.world
}

async function runInWorld(tabId, fn, ...args) {
  const session = await attach(tabId)
  const contextId = await isolatedWorld(tabId, session)
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
  const { result, exceptionDetails } = await send(tabId, "Runtime.evaluate", {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
  })
  if (exceptionDetails) {
    throw new CommandError(
      "PAGE_SCRIPT_FAILED",
      exceptionDetails.exception?.description ?? exceptionDetails.text
    )
  }
  return result.value
}

// ---- Commands -----------------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForLoad(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  await sleep(50)
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === "complete") return tab
    await sleep(100)
  }
  return chrome.tabs.get(tabId)
}

function describeTab(tab) {
  return { tab_id: tab.id, url: tab.url, title: tab.title, active: tab.active }
}

async function shellbyGroupId(windowId) {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId })
  return groups[0]?.id
}

async function listTabs() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE })
  const perGroup = await Promise.all(groups.map(({ id }) => chrome.tabs.query({ groupId: id })))
  return perGroup.flat().map(describeTab)
}

async function createTab({ url }) {
  if (url) await requireSite(url)
  const tab = await chrome.tabs.create({ url: url ?? "about:blank", active: false })
  const existing = await shellbyGroupId(tab.windowId)
  const groupId = await chrome.tabs.group({
    tabIds: [tab.id],
    ...(existing === undefined ? {} : { groupId: existing }),
  })
  if (existing === undefined)
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "green" })
  return describeTab(url ? await waitForLoad(tab.id) : tab)
}

async function closeTab({ tabId }) {
  await requireTab(tabId)
  await chrome.tabs.remove(tabId)
  return "closed"
}

async function historyTarget(tabId, direction) {
  const { currentIndex, entries } = await send(tabId, "Page.getNavigationHistory")
  const entry = entries[currentIndex + (direction === "back" ? -1 : 1)]
  if (!entry) throw new CommandError("NO_HISTORY", `There is no ${direction} entry.`)
  return entry
}

async function navigate({ tabId, url, history }) {
  await requireTab(tabId)
  await attach(tabId)
  if (history) {
    const entry = await historyTarget(tabId, history)
    await requireSite(entry.url)
    await send(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id })
  } else {
    await requireSite(url)
    const { errorText } = await send(tabId, "Page.navigate", { url })
    if (errorText) throw new CommandError("NAVIGATION_FAILED", errorText)
  }
  await waitForLoad(tabId)
  const tab = await requireTab(tabId)
  await requireSite(tab.url)
  return describeTab(tab)
}

function read({ tabId, format, query, interactiveOnly, maxChars }) {
  return readingTab(tabId, () =>
    format === "text"
      ? runInWorld(tabId, pageText, { maxChars })
      : runInWorld(tabId, snapshotPage, { interactiveOnly, query, maxChars })
  )
}

function timeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new CommandError("CAPTURE_TIMEOUT", "Chrome did not render the tab in time.")
    }),
  ])
}

function screenshot({ tabId }) {
  return readingTab(tabId, async () => {
    await attach(tabId)
    const { cssLayoutViewport } = await send(tabId, "Page.getLayoutMetrics")
    const capture = () => send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 85 })
    const { data } = await timeout(capture(), CAPTURE_TIMEOUT_MS).catch(async (error) => {
      if (error.code !== "CAPTURE_TIMEOUT") throw error
      // Chrome may not paint a hidden tab; showing it is the only way to get pixels.
      await chrome.tabs.update(tabId, { active: true })
      return timeout(capture(), CAPTURE_TIMEOUT_MS)
    })
    return { data, width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight }
  })
}

function assertFresh(outcome, ref) {
  if (outcome?.stale)
    throw new CommandError("STALE_REF", `${ref} is gone. Call browser_read for fresh refs.`)
  return outcome
}

async function pointFor(tabId, { ref, x, y }) {
  if (!ref) return { x, y }
  return assertFresh(await runInWorld(tabId, locateRef, ref), ref)
}

function mouse(tabId, type, point, extra) {
  return send(tabId, "Input.dispatchMouseEvent", { type, x: point.x, y: point.y, ...extra })
}

async function mouseAction(tabId, params) {
  const point = await pointFor(tabId, params)
  await mouse(tabId, "mouseMoved", point)
  const buttons = MOUSE_BUTTONS[params.action]
  if (!buttons) return
  await mouse(tabId, "mousePressed", point, buttons)
  await mouse(tabId, "mouseReleased", point, buttons)
}

async function refuseIfSecretFocused(tabId) {
  if (await runInWorld(tabId, focusIsSecret)) {
    throw new CommandError(
      "SECRET_FIELD",
      "The focused field holds a password or payment value. Ask the user to fill it."
    )
  }
}

async function typeAction(tabId, { ref, text }) {
  if (ref) assertFresh(await runInWorld(tabId, focusRef, ref), ref)
  await refuseIfSecretFocused(tabId)
  await send(tabId, "Input.insertText", { text })
}

async function keyAction(tabId, { key }) {
  const parsed = parseKeyCombo(key)
  if (!parsed) throw new CommandError("INVALID_KEY", `Unknown key combination ${key}.`)
  if (parsed.text) await refuseIfSecretFocused(tabId)
  const base = {
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.vk,
    modifiers: parsed.modifiers,
  }
  await send(tabId, "Input.dispatchKeyEvent", {
    ...base,
    type: parsed.text ? "keyDown" : "rawKeyDown",
    ...(parsed.text ? { text: parsed.text } : {}),
  })
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" })
}

async function fillAction(tabId, { ref, value }) {
  const outcome = assertFresh(await runInWorld(tabId, fillRef, ref, value), ref)
  if (outcome.secret)
    throw new CommandError("SECRET_FIELD", "That field holds a password or payment value.")
  if (outcome.unsupported)
    throw new CommandError("NOT_FILLABLE", `Cannot fill <${outcome.unsupported}>; use type.`)
  if (outcome.noOption) throw new CommandError("NO_OPTION", `No option matches ${value}.`)
}

async function scrollAction(tabId, { x, y, direction, amount = 3 }) {
  const [horizontal, vertical] = SCROLL_DELTAS[direction]
  const distance = amount * WHEEL_TICK
  // Synthetic wheel events need a painting compositor, so they do nothing in a background tab.
  await runInWorld(tabId, scrollAt, {
    x,
    y,
    left: horizontal * distance,
    top: vertical * distance,
  })
}

const ACTIONS = {
  click: mouseAction,
  double_click: mouseAction,
  right_click: mouseAction,
  hover: mouseAction,
  type: typeAction,
  key: keyAction,
  fill: fillAction,
  scroll: scrollAction,
  scroll_to: pointFor,
}

async function act({ tabId, ...params }) {
  await requireSite((await requireTab(tabId)).url)
  await attach(tabId)
  await ACTIONS[params.action](tabId, params)
  return "done"
}

function evaluate({ tabId, expression }) {
  return readingTab(tabId, async () => {
    await attach(tabId)
    const { result, exceptionDetails } = await send(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (exceptionDetails) {
      throw new CommandError(
        "EVALUATION_FAILED",
        exceptionDetails.exception?.description ?? exceptionDetails.text
      )
    }
    return { value: result.value ?? null, type: result.type }
  })
}

function logs({ tabId, kind, pattern, errorsOnly, limit }) {
  return readingTab(tabId, async () => {
    const session = await attach(tabId)
    const needle = pattern?.toLowerCase()
    const entries = kind === "console" ? session.consoleLog : [...session.network.values()]
    const isError = (entry) =>
      entry.level === "error" || entry.failed !== undefined || entry.status >= 400
    return entries
      .filter((entry) => !errorsOnly || isError(entry))
      .filter((entry) => !needle || JSON.stringify(entry).toLowerCase().includes(needle))
      .slice(-limit)
  })
}

const METHODS = new Map([
  ["tabs.list", listTabs],
  ["tabs.create", createTab],
  ["tabs.close", closeTab],
  ["navigate", navigate],
  ["read", read],
  ["screenshot", screenshot],
  ["act", act],
  ["evaluate", evaluate],
  ["logs", logs],
])

// ---- Browser events: registered synchronously so a restarted worker receives them --------------

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const session = sessions.get(tabId)
  if (session) EVENT_HANDLERS[method]?.(session, params)
})

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  sessions.delete(tabId)
  // Dismissing Chrome's debugging banner revokes Shellby's access to that tab.
  if (reason === "canceled_by_user") chrome.tabs.ungroup(tabId).catch(() => undefined)
})

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.groupId === undefined || !sessions.has(tabId)) return
  isShellbyTab(tab).then((inGroup) => {
    if (!inGroup) detach(tabId)
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId)
})

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [origin, id] of approvalWindows) {
    if (id === windowId) approvalWindows.delete(origin)
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.pairing || changes.paused)) return
  disconnect()
  connect()
})

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === RECONNECT_ALARM) connect()
})

chrome.runtime.onInstalled.addListener(() => {
  connect()
})
chrome.runtime.onStartup.addListener(() => {
  connect()
})
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
connect()
