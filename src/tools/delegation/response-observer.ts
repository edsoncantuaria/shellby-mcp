import type { CDPSession, Page } from "playwright-core"

import type { ChatGptDelegationActivity } from "./contracts.js"
import { type ChatGptTurnCompletion, ChatGptTurnTracker } from "./turn-protocol.js"

export interface AssistantResponseObservation {
  response: Promise<ChatGptTurnCompletion>
  dispose(): Promise<void>
}

const SSE_EVENT_BOUNDARY_RE = /\r?\n\r?\n/u

/** Observe one submitted turn from raw CDP HTTP SSE or the turn WebSocket; first exact completion wins. */
export async function observeAssistantResponse(
  page: Page,
  input: {
    prompt: string
    onActivity?: (activity?: ChatGptDelegationActivity) => void
    onConversationId?: (conversationId: string) => void
  }
): Promise<AssistantResponseObservation> {
  const webSocketTracker = new ChatGptTurnTracker(
    input.prompt,
    input.onActivity,
    input.onConversationId
  )
  const httpTracker = new ChatGptTurnTracker(input.prompt, input.onActivity, input.onConversationId)
  const requestIds = new Set<string>()
  const buffers = new Map<string, string>()
  const knownTurnIds = new Set(
    await page
      .locator("section[data-turn-id][data-turn]")
      .evaluateAll((sections) =>
        sections
          .map((section) => section.getAttribute("data-turn-id"))
          .filter((id): id is string => Boolean(id))
      )
  )
  let cdp: CDPSession | undefined
  let domPoll: NodeJS.Timeout | undefined
  let domPolling = false
  let settled = false
  let resolveResponse!: (response: ChatGptTurnCompletion) => void
  let rejectResponse!: (error: unknown) => void
  const response = new Promise<ChatGptTurnCompletion>((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  // Disposal before submission rejects a response nobody awaits yet; that must not
  // surface as an unhandled rejection in place of the error that caused the disposal.
  response.catch(() => undefined)

  const cleanup = async (): Promise<void> => {
    page.off("close", pageCloseHandler)
    if (domPoll) clearInterval(domPoll)
    await cdp?.detach().catch(() => undefined)
    cdp = undefined
  }

  const finish = (result?: ChatGptTurnCompletion): void => {
    if (!result || settled) return
    settled = true
    resolveResponse(result)
    void cleanup()
  }

  const feedHttp = (requestId: string, text: string): void => {
    if (settled || !text) return
    let buffer = (buffers.get(requestId) ?? "") + text
    let match = SSE_EVENT_BOUNDARY_RE.exec(buffer)
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome incorrectly treats RegExp.exec() result as always truthy.
    while (match) {
      const end = match.index + match[0].length
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end)
      finish(httpTracker.ingestSse(block))
      if (settled) return
      match = SSE_EVENT_BOUNDARY_RE.exec(buffer)
    }
    buffers.set(requestId, buffer)
  }

  const frameHandler = (event: { response?: { payloadData?: string } }): void => {
    const payload = event.response?.payloadData
    if (!payload || settled) return
    try {
      finish(webSocketTracker.ingestFrame(payload))
    } catch {
      // Ignore unrelated or malformed private-protocol frames.
    }
  }

  const requestHandler = (event: {
    requestId: string
    request?: { url?: string; method?: string }
  }): void => {
    if (settled || event.request?.method !== "POST" || !isConversationEndpoint(event.request.url))
      return
    requestIds.add(event.requestId)
    buffers.set(event.requestId, "")
  }

  const responseHandler = (event: { requestId: string }): void => {
    if (settled || !requestIds.has(event.requestId) || !cdp) return
    void cdp
      .send("Network.streamResourceContent", { requestId: event.requestId })
      .then((result) => {
        const bufferedData = typeof result.bufferedData === "string" ? result.bufferedData : ""
        if (bufferedData)
          feedHttp(event.requestId, Buffer.from(bufferedData, "base64").toString("utf8"))
      })
      .catch(() => undefined)
  }

  const dataHandler = (event: { requestId: string; data?: string }): void => {
    if (settled || !requestIds.has(event.requestId) || !event.data) return
    feedHttp(event.requestId, Buffer.from(event.data, "base64").toString("utf8"))
  }

  const loadingFinishedHandler = (event: { requestId: string }): void => {
    if (settled || !requestIds.has(event.requestId) || !cdp) return
    void cdp
      .send("Network.getResponseBody", { requestId: event.requestId })
      .then((result) => {
        if (settled || typeof result.body !== "string") return
        const body = result.base64Encoded
          ? Buffer.from(result.body, "base64").toString("utf8")
          : result.body
        const fallback = new ChatGptTurnTracker(
          input.prompt,
          input.onActivity,
          input.onConversationId
        )
        finish(fallback.ingestSse(body))
      })
      .catch(() => undefined)
  }

  const pageCloseHandler = (): void => {
    if (settled) return
    settled = true
    rejectResponse(new Error("ChatGPT managed page closed while a subagent turn was running."))
    void cleanup()
  }

  const pollCompletedDomTurn = async (): Promise<void> => {
    if (settled || domPolling || page.isClosed()) return
    domPolling = true
    try {
      const text = await completedDomResponse(page, knownTurnIds, input.prompt)
      if (text && !settled) finish({ text })
    } catch {
      // Navigation and transient DOM replacement are handled on the next poll.
    } finally {
      domPolling = false
    }
  }

  try {
    cdp = await page.context().newCDPSession(page)
    await cdp.send("Network.enable")
    cdp.on("Network.webSocketFrameReceived", frameHandler)
    cdp.on("Network.requestWillBeSent", requestHandler)
    cdp.on("Network.responseReceived", responseHandler)
    cdp.on("Network.dataReceived", dataHandler)
    cdp.on("Network.loadingFinished", loadingFinishedHandler)
    page.on("close", pageCloseHandler)
    domPoll = setInterval(() => void pollCompletedDomTurn(), 1_000)
  } catch (error) {
    await cleanup()
    throw error
  }

  return {
    response,
    async dispose() {
      if (!settled) {
        settled = true
        rejectResponse(new Error("ChatGPT subagent response observation was disposed."))
      }
      await cleanup()
    },
  }
}

async function completedDomResponse(
  page: Page,
  knownTurnIds: ReadonlySet<string>,
  prompt: string
): Promise<string | undefined> {
  const sections = await page.locator("section[data-turn-id][data-turn]").all()
  const normalizedPrompt = prompt.replace(/\s+/gu, " ").trim()
  let matchingUser = false
  for (const section of sections) {
    const role = await section.getAttribute("data-turn")
    if (role === "user") {
      const id = await section.getAttribute("data-turn-id")
      const content = (await section.textContent())?.replace(/\s+/gu, " ").trim() ?? ""
      matchingUser = Boolean(id && !knownTurnIds.has(id) && content.includes(normalizedPrompt))
    } else if (matchingUser && role === "assistant") {
      if ((await section.locator('[data-testid="copy-turn-action-button"]').count()) === 0)
        return undefined
      const text = await section.locator('[data-message-author-role="assistant"]').textContent()
      return text?.trim() || undefined
    }
  }
  return undefined
}

function isConversationEndpoint(value?: string): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.hostname === "chatgpt.com" && url.pathname === "/backend-api/f/conversation"
  } catch {
    return false
  }
}
