import {
  attachFiles,
  fillRef,
  focusIsSecret,
  focusRef,
  locateRef,
  pageText,
  scrollAt,
  snapshotPage,
  viewportSize,
} from "./page-scripts.js"
import { classifyUrl, hmacHex, parseKeyCombo, redactUrl, siteKey } from "./policy.js"

const GROUP_TITLE = "Shellby"
const RECONNECT_ALARM = "shellby-reconnect"
const KEEPALIVE_MS = 20_000
const LOAD_TIMEOUT_MS = 15_000
const CAPTURE_TIMEOUT_MS = 5_000
const LOG_LIMIT = 200
const WHEEL_TICK = 120
const MAX_FRAMES_READ = 30
const MAX_RECORDING_FRAMES = 120
const MAX_RECORDING_CHARS = 24 * 1024 * 1024
const RECORD_SETTLE_MS = 250
const DRAG_STEPS = 10
const SUBFRAME_REF = /^ref_(\d+)_\d+$/u
const CONTEXT_GONE = /context/iu
const NO_NODE = /no node/iu
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

async function browserIdentity() {
  const stored = await chrome.storage.local.get(["browserId", "browserName"])
  const browserId = stored.browserId ?? crypto.randomUUID()
  if (!stored.browserId) await chrome.storage.local.set({ browserId })
  return { browser_id: browserId, name: stored.browserName || `Chrome ${browserId.slice(0, 4)}` }
}

async function onMessage(ws, link, message) {
  if (message.type === "challenge" && !link.nonce) {
    link.nonce = crypto.randomUUID() + crypto.randomUUID()
    link.challenge = message.nonce
    const proof = await hmacHex(link.secret, `client:${message.nonce}`)
    const identity = await browserIdentity()
    ws.send(JSON.stringify({ type: "auth", proof, nonce: link.nonce, ...identity }))
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

async function originApproved(origin) {
  const key = siteKey(origin)
  return (await chrome.storage.local.get(key))[key] === "allow"
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

function send(tabId, method, params, sessionId) {
  return chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params)
}

function attach(tabId) {
  let session = sessions.get(tabId)
  if (!session) {
    session = {
      ready: startSession(tabId),
      consoleLog: [],
      network: new Map(),
      worlds: new Map(),
      children: new Set(),
      frameOrdinals: new Map(),
      nextFrameOrdinal: 1,
    }
    sessions.set(tabId, session)
    session.ready.catch(() => sessions.delete(tabId))
  }
  return session.ready.then(() => session)
}

function autoAttachFrames(tabId, sessionId) {
  // Cross-site iframes run in their own renderer and are separate debugger targets.
  return send(
    tabId,
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    sessionId
  )
}

async function startSession(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3")
  const domains = ["Page.enable", "DOM.enable", "Runtime.enable", "Network.enable"]
  await Promise.all(domains.map((domain) => send(tabId, domain)))
  // Lets background tabs keep focus-dependent behavior without stealing the user's window.
  await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true })
  await autoAttachFrames(tabId)
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
    session.worlds.clear()
  },
  "Page.frameNavigated": (session, { frame }, source) => {
    session.worlds.delete(frame.id)
    if (!frame.parentId && !source.sessionId) resetIfOriginChanged(session, frame.url)
  },
  "Input.dragIntercepted": (session, { data }) => {
    session.dragData = data
  },
  "Target.attachedToTarget": (session, { sessionId, targetInfo }, { tabId }) => {
    if (targetInfo.type !== "iframe") return
    session.children.add(sessionId)
    for (const domain of ["Page.enable", "DOM.enable"]) {
      send(tabId, domain, undefined, sessionId).catch(() => undefined)
    }
    autoAttachFrames(tabId, sessionId).catch(() => undefined)
  },
  "Target.detachedFromTarget": (session, { sessionId }) => {
    session.children.delete(sessionId)
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

/** Every frame reachable in the tab, across the page and its out-of-process iframe targets. */
async function listFrames(tabId, session) {
  const frames = new Map()
  let mainId
  const collect = async (sessionId) => {
    const { frameTree } = await send(tabId, "Page.getFrameTree", undefined, sessionId)
    if (!sessionId) mainId = frameTree.frame.id
    const walk = (node, sessionRoot) => {
      frames.set(node.frame.id, {
        id: node.frame.id,
        parentId: node.frame.parentId,
        url: node.frame.url,
        sessionId,
        sessionRoot,
      })
      for (const child of node.childFrames ?? []) walk(child, false)
    }
    walk(frameTree, true)
  }
  await collect()
  // A frame also seen from its parent is owned by its own target, so those are collected last.
  await Promise.all([...session.children].map((id) => collect(id).catch(() => undefined)))
  for (const frame of frames.values()) {
    if (frame.id === mainId) frame.ordinal = 0
    else {
      if (!session.frameOrdinals.has(frame.id))
        session.frameOrdinals.set(frame.id, session.nextFrameOrdinal++)
      frame.ordinal = session.frameOrdinals.get(frame.id)
    }
  }
  return { frames, main: frames.get(mainId) }
}

/** A subframe is its own site: being embedded in an approved page grants it nothing. */
async function frameApproved(frame, frames) {
  const verdict = classifyUrl(frame.url)
  if (verdict.kind === "site") return originApproved(verdict.origin)
  // about:blank, about:srcdoc, blob: and data: frames are authored by their parent.
  const parent = frames.get(frame.parentId)
  return parent ? frameApproved(parent, frames) : false
}

async function isolatedWorld(tabId, session, frame) {
  let world = session.worlds.get(frame.id)
  if (world === undefined) {
    const { executionContextId } = await send(
      tabId,
      "Page.createIsolatedWorld",
      { frameId: frame.id, worldName: "shellby" },
      frame.sessionId
    )
    world = executionContextId
    session.worlds.set(frame.id, world)
  }
  return world
}

async function evaluateInWorld(tabId, session, frame, expression) {
  const contextId = await isolatedWorld(tabId, session, frame)
  return send(
    tabId,
    "Runtime.evaluate",
    { expression, contextId, returnByValue: true, awaitPromise: true },
    frame.sessionId
  )
}

async function runInFrame(tabId, session, frame, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
  const { result, exceptionDetails } = await evaluateInWorld(
    tabId,
    session,
    frame,
    expression
  ).catch((error) => {
    // A cached world dies with its document; one retry covers navigation races.
    if (!CONTEXT_GONE.test(error.message)) throw error
    session.worlds.delete(frame.id)
    return evaluateInWorld(tabId, session, frame, expression)
  })
  if (exceptionDetails) {
    throw new CommandError(
      "PAGE_SCRIPT_FAILED",
      exceptionDetails.exception?.description ?? exceptionDetails.text
    )
  }
  return result.value
}

/** The frame a ref belongs to, refusing frames the user has not approved. */
async function frameForRef(tabId, ref) {
  const session = await attach(tabId)
  const context = await listFrames(tabId, session)
  const match = ref ? SUBFRAME_REF.exec(ref) : undefined
  if (!match) return { session, context, frame: context.main }
  const ordinal = Number(match[1])
  const frame = [...context.frames.values()].find((item) => item.ordinal === ordinal)
  if (!frame) throw new CommandError("STALE_REF", `${ref} is gone. Call browser_read again.`)
  if (!(await frameApproved(frame, context.frames)))
    throw new CommandError("FRAME_NOT_APPROVED", `${ref} is in a frame the user has not approved.`)
  return { session, context, frame }
}

/** Where a frame's viewport origin sits in the top-level viewport used for input events. */
async function frameOffset(tabId, session, frame, context) {
  if (frame.id === context.main.id) return { x: 0, y: 0 }
  for (const sessionId of [undefined, ...session.children]) {
    const box = await ownerBox(tabId, frame.id, sessionId)
    if (box) {
      if (!sessionId) return box
      // Box models are relative to their own target, so nested targets add up.
      const root = [...context.frames.values()].find(
        (item) => item.sessionId === sessionId && item.sessionRoot
      )
      const base = await frameOffset(tabId, session, root, context)
      return { x: box.x + base.x, y: box.y + base.y }
    }
  }
  throw new CommandError("FRAME_GONE", "That frame is no longer in the page.")
}

async function ownerBox(tabId, frameId, sessionId) {
  try {
    const { backendNodeId } = await send(tabId, "DOM.getFrameOwner", { frameId }, sessionId)
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId)
    const { model } = await send(tabId, "DOM.getBoxModel", { backendNodeId }, sessionId)
    return { x: model.content[0], y: model.content[1] }
  } catch {
    // Expected: this target does not own the frame, so the caller tries the next one.
  }
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
  await captureRecordingFrame(tabId)
  return describeTab(tab)
}

function originOf(frame) {
  const verdict = classifyUrl(frame.url)
  return verdict.kind === "site" ? verdict.origin : frame.url
}

async function readFrame(tabId, session, frame, options) {
  const refPrefix = frame.ordinal === 0 ? "" : `${frame.ordinal}_`
  if (options.format === "text") {
    const page = await runInFrame(tabId, session, frame, pageText, options)
    return { ...page, body: page.text }
  }
  const page = await runInFrame(tabId, session, frame, snapshotPage, { ...options, refPrefix })
  return { ...page, body: page.tree }
}

function read({ tabId, format, query, interactiveOnly, maxChars, requestFrameOrigin }) {
  return readingTab(tabId, async () => {
    const session = await attach(tabId)
    const context = await listFrames(tabId, session)
    const { frames, main } = context
    if (requestFrameOrigin) {
      const present = [...frames.values()].some((item) => originOf(item) === requestFrameOrigin)
      if (!present)
        throw new CommandError("FRAME_NOT_FOUND", `No frame from ${requestFrameOrigin} is here.`)
      await requireSite(requestFrameOrigin)
    }

    const options = { format, query, interactiveOnly, maxChars }
    const top = await readFrame(tabId, session, main, options)
    const sections = [top.body]
    let remaining = maxChars - top.body.length
    let truncated = top.truncated
    const subframes = [...frames.values()].filter((item) => item.id !== main.id)
    for (const frame of subframes.slice(0, MAX_FRAMES_READ)) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (await frameApproved(frame, frames)) {
        const page = await readFrame(tabId, session, frame, { ...options, maxChars: remaining })
          // A frame can vanish mid-read; the rest of the page is still worth returning.
          .catch(() => ({ body: "(frame unavailable)", truncated: false }))
        sections.push(`--- frame ${frame.ordinal} ${frame.url.slice(0, 200)}\n${page.body}`)
        remaining -= page.body.length
        truncated ||= page.truncated
      } else {
        sections.push(
          `--- frame ${frame.ordinal} ${originOf(frame).slice(0, 200)} (not approved; use request_frame_origin to ask the user)`
        )
      }
    }
    return { url: top.url, title: top.title, content: sections.join("\n"), truncated }
  })
}

function timeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new CommandError("CAPTURE_TIMEOUT", "Chrome did not render the tab in time.")
    }),
  ])
}

async function captureTab(tabId, quality) {
  const capture = () => send(tabId, "Page.captureScreenshot", { format: "jpeg", quality })
  const { data } = await timeout(capture(), CAPTURE_TIMEOUT_MS).catch(async (error) => {
    if (error.code !== "CAPTURE_TIMEOUT") throw error
    // Chrome may not paint a hidden tab; showing it is the only way to get pixels.
    await chrome.tabs.update(tabId, { active: true })
    return timeout(capture(), CAPTURE_TIMEOUT_MS)
  })
  return data
}

/** The captured area in CSS pixels. Layout metrics would leave out the scrollbars it includes. */
async function viewport(tabId) {
  const session = await attach(tabId)
  const { main } = await listFrames(tabId, session)
  return runInFrame(tabId, session, main, viewportSize)
}

function screenshot({ tabId }) {
  return readingTab(tabId, async () => {
    await attach(tabId)
    const size = await viewport(tabId)
    return { data: await captureTab(tabId, 85), ...size }
  })
}

async function resize({ tabId, width, height, reset }) {
  await requireSite((await requireTab(tabId)).url)
  await attach(tabId)
  if (reset) await send(tabId, "Emulation.clearDeviceMetricsOverride")
  else {
    await send(tabId, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    })
  }
  return viewport(tabId)
}

async function captureRecordingFrame(tabId) {
  const session = sessions.get(tabId)
  const recording = session?.recording
  if (!recording) return
  try {
    await sleep(RECORD_SETTLE_MS)
    const verdict = classifyUrl((await requireTab(tabId)).url)
    // Recording must never capture a site the user has not approved.
    if (verdict.kind === "site" && !(await originApproved(verdict.origin))) {
      recording.skipped += 1
      return
    }
    const data = await captureTab(tabId, 60)
    recording.frames.push(data)
    recording.chars += data.length
    while (
      recording.frames.length > MAX_RECORDING_FRAMES ||
      recording.chars > MAX_RECORDING_CHARS
    ) {
      recording.chars -= recording.frames.shift().length
      recording.skipped += 1
    }
  } catch {
    // A lost frame must not fail the user-visible action that triggered it.
    recording.skipped += 1
  }
}

async function record({ tabId, action }) {
  await requireSite((await requireTab(tabId)).url)
  const session = await attach(tabId)
  if (action === "start") {
    session.recording = { frames: [], chars: 0, skipped: 0 }
    await captureRecordingFrame(tabId)
    return "recording"
  }
  const recording = session.recording
  if (!recording) throw new CommandError("NOT_RECORDING", "This tab is not being recorded.")
  session.recording = undefined
  if (action === "discard") return "discarded"
  await captureRecordingFrame(tabId)
  return { frames: recording.frames, skipped: recording.skipped }
}

function assertFresh(outcome, ref) {
  if (outcome?.stale)
    throw new CommandError("STALE_REF", `${ref} is gone. Call browser_read for fresh refs.`)
  return outcome
}

/** Coordinates can land in an embedded frame, which needs the same approval as a ref would. */
async function refuseUnapprovedPoint(tabId, session, point) {
  let located
  try {
    located = await send(tabId, "DOM.getNodeForLocation", {
      x: Math.round(point.x),
      y: Math.round(point.y),
    })
  } catch (error) {
    if (NO_NODE.test(error.message)) return
    throw error
  }
  const { node } = await send(tabId, "DOM.describeNode", { backendNodeId: located.backendNodeId })
  const { frames } = await listFrames(tabId, session)
  const frame = frames.get(node.frameId ?? located.frameId)
  if (frame && !(await frameApproved(frame, frames)))
    throw new CommandError(
      "FRAME_NOT_APPROVED",
      "That point is in a frame the user has not approved."
    )
}

async function pointFor(tabId, { ref, x, y }) {
  if (!ref) {
    await refuseUnapprovedPoint(tabId, await attach(tabId), { x, y })
    return { x, y }
  }
  const { session, context, frame } = await frameForRef(tabId, ref)
  const local = assertFresh(await runInFrame(tabId, session, frame, locateRef, ref), ref)
  const offset = await frameOffset(tabId, session, frame, context)
  return { x: local.x + offset.x, y: local.y + offset.y }
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
  const session = await attach(tabId)
  const { frames } = await listFrames(tabId, session)
  // Payment forms usually live in a cross-site iframe, so every frame has to be asked.
  const checks = [...frames.values()].map((frame) =>
    runInFrame(tabId, session, frame, focusIsSecret).catch(() => false)
  )
  if ((await Promise.all(checks)).some(Boolean)) {
    throw new CommandError(
      "SECRET_FIELD",
      "The focused field holds a password or payment value. Ask the user to fill it."
    )
  }
}

async function typeAction(tabId, { ref, text }) {
  if (ref) {
    const { session, frame } = await frameForRef(tabId, ref)
    assertFresh(await runInFrame(tabId, session, frame, focusRef, ref), ref)
    // Script focus does not move keyboard focus into another frame; a real click does.
    if (frame.ordinal !== 0) await mouseAction(tabId, { ref, action: "click" })
  }
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
  const { session, frame } = await frameForRef(tabId, ref)
  const outcome = assertFresh(await runInFrame(tabId, session, frame, fillRef, ref, value), ref)
  if (outcome.secret)
    throw new CommandError("SECRET_FIELD", "That field holds a password or payment value.")
  if (outcome.unsupported)
    throw new CommandError("NOT_FILLABLE", `Cannot fill <${outcome.unsupported}>; use type.`)
  if (outcome.noOption) throw new CommandError("NO_OPTION", `No option matches ${value}.`)
}

async function scrollAction(tabId, { ref, x, y, direction, amount = 3 }) {
  const [horizontal, vertical] = SCROLL_DELTAS[direction]
  const distance = amount * WHEEL_TICK
  const { session, frame } = await frameForRef(tabId, ref)
  const local = ref
    ? assertFresh(await runInFrame(tabId, session, frame, locateRef, ref), ref)
    : { x, y }
  // Synthetic wheel events need a painting compositor, so they do nothing in a background tab.
  await runInFrame(tabId, session, frame, scrollAt, {
    ...local,
    left: horizontal * distance,
    top: vertical * distance,
  })
}

async function dragAction(tabId, params) {
  const session = await attach(tabId)
  const to = await pointFor(tabId, { ref: params.to_ref, x: params.to_x, y: params.to_y })
  const from = await pointFor(tabId, params)
  const held = { button: "left", buttons: 1 }
  session.dragData = undefined
  // HTML5 drag sources start an OS-level drag that synthetic mouse moves cannot complete.
  await send(tabId, "Input.setInterceptDrags", { enabled: true })
  try {
    await mouse(tabId, "mouseMoved", from)
    await mouse(tabId, "mousePressed", from, { ...held, clickCount: 1 })
    for (let step = 1; step <= DRAG_STEPS; step += 1) {
      const progress = step / DRAG_STEPS
      await mouse(
        tabId,
        "mouseMoved",
        { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress },
        held
      )
      if (step === 1) await sleep(100)
      if (session.dragData) break
    }
    if (session.dragData) {
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await send(tabId, "Input.dispatchDragEvent", { type, ...to, data: session.dragData })
      }
    }
    await mouse(tabId, "mouseReleased", to, { button: "left", clickCount: 1 })
  } finally {
    session.dragData = undefined
    await send(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => undefined)
  }
}

async function upload({ tabId, ref, files }) {
  await requireSite((await requireTab(tabId)).url)
  const { session, frame } = await frameForRef(tabId, ref)
  const outcome = await runInFrame(tabId, session, frame, attachFiles, ref, files)
  assertFresh(outcome, ref)
  if (outcome.inputCount !== undefined) {
    throw new CommandError(
      "FILE_INPUT_AMBIGUOUS",
      `The page has ${outcome.inputCount} file inputs. Pass the ref of the right one.`
    )
  }
  if (outcome.notFileInput) throw new CommandError("NOT_FILE_INPUT", `${ref} is not a file input.`)
  if (outcome.singleOnly) throw new CommandError("SINGLE_FILE_ONLY", "That input accepts one file.")
  await captureRecordingFrame(tabId)
  return "attached"
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
  drag: dragAction,
}

async function act({ tabId, ...params }) {
  await requireSite((await requireTab(tabId)).url)
  await attach(tabId)
  await ACTIONS[params.action](tabId, params)
  await captureRecordingFrame(tabId)
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
  ["resize", resize],
  ["upload", upload],
  ["record", record],
  ["act", act],
  ["evaluate", evaluate],
  ["logs", logs],
])

// ---- Browser events: registered synchronously so a restarted worker receives them --------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = sessions.get(source.tabId)
  if (session) EVENT_HANDLERS[method]?.(session, params, source)
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
  if (area !== "local" || !(changes.pairing || changes.paused || changes.browserName)) return
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
