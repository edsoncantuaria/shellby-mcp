import { join } from "node:path"
import type { AgentChatDeliveryResult } from "../../agent/chat-delivery.js"
import { type AgentIdentity, getAgentIdentity } from "../../agent/context.js"
import { MCP_CONFIG } from "../../config.js"
import { log } from "../../logging.js"
import {
  type ChatGptCloneRunRequest,
  type ChatGptCloneSelfRequest,
  type ChatGptDelegationCallContext,
  ChatGptDelegationError,
  type ChatGptDelegationPollResult,
  type ChatGptDelegationService,
  type ChatGptSubagentRequest,
} from "./contracts.js"
import type { GeminiTab, GeminiTabs } from "./gemini-browser.js"
import {
  GEMINI_SNAPSHOT_SCRIPT,
  GEMINI_TRANSCRIPT_SCRIPT,
  type GeminiPageSnapshot,
  type GeminiSendOutcome,
  type GeminiTranscriptEntry,
  geminiMarkerScript,
  geminiSendScript,
  isGeminiConversationUrl,
  isGeminiUrl,
} from "./gemini-page.js"
import { createDelegationStore } from "./store.js"

const DEFAULT_POLL_MS = 1_500
const COMPOSER_TIMEOUT_MS = 30_000
const TURN_TIMEOUT_MS = 30 * 60_000
const AGENT_IDLE_TTL_MS = 30 * 60_000
const CLEANUP_INTERVAL_MS = 60_000
/** The extension reconnects when Chrome restarts its service worker. */
const MAX_CONSECUTIVE_READ_FAILURES = 5
/** Text must hold still this many polls, since the stop button can vanish between stream chunks. */
const STABLE_POLLS_TO_FINISH = 2
const MAX_CLONE_CONTEXT_CHARS = 30_000
const GEMINI_START_URL = "https://gemini.google.com/app"
const INJECTED_PROMPT = `Oververbosity: 1.\n\nDo not use \`subagent\`${MCP_CONFIG.tools.computer ? " or `computer_*`" : ""} tools.`

interface GeminiAgent {
  parent: AgentIdentity | undefined
  agentId: string
  kind: "subagent" | "clone"
  tabId?: number
  conversationUrl?: string
  turnCount: number
  lastUsedAt: number
  submitting: boolean
  activeTurn?: GeminiTurn
}

interface GeminiTurn {
  turnId: string
  agentId: string
  parentSession: string
  status: "running" | "completed" | "failed"
  activityAt: number
  hasText: boolean
  response?: string
  errorCode?: string
  errorMessage?: string
  settled: Promise<void>
  settle: () => void
}

/** Delegated agents in Gemini tabs of the dedicated Chrome that ChatGPT agents also use. */
export type GeminiDelegationService = Omit<ChatGptDelegationService, "ensureProject">

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Tab, turn, and persistence bookkeeping share one closure, as in the ChatGPT service.
export function createGeminiDelegationService(
  browser: GeminiTabs,
  options: { pollMs?: number } = {}
): GeminiDelegationService {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const store = createDelegationStore(join(MCP_CONFIG.stateDir, "gemini-subagents.sqlite"))
  const agents = new Map<string, GeminiAgent>()
  const turns = new Map<string, GeminiTurn>()
  const pendingEvents = new Map<string, string[]>()
  let disposed = false

  const cleanupTimer = setInterval(() => void closeIdleTabs(), CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  function evaluate<T>(tabId: number, expression: string, signal?: AbortSignal): Promise<T> {
    return browser.evaluate<T>(tabId, expression, signal)
  }

  function agentKey(parent: AgentIdentity | undefined, agentId: string): string {
    return `${parent?.sessionId ?? ""}\0${agentId}`
  }

  function findAgent(parent: AgentIdentity | undefined, agentId: string): GeminiAgent | undefined {
    const key = agentKey(parent, agentId)
    const known = agents.get(key)
    if (known) return known
    const saved = store.status === "available" ? store.get(parent, agentId) : undefined
    if (!saved) return undefined
    const restored: GeminiAgent = {
      parent,
      agentId,
      kind: saved.kind,
      conversationUrl: saved.conversationUrl,
      turnCount: saved.turnCount,
      lastUsedAt: Date.now(),
      submitting: false,
    }
    agents.set(key, restored)
    return restored
  }

  function createAgent(
    parent: AgentIdentity | undefined,
    agentId: string,
    kind: GeminiAgent["kind"]
  ): GeminiAgent {
    const limit = MCP_CONFIG.chatGpt.maxDelegatedAgents
    const owned = [...agents.values()].filter((entry) => entry.parent === parent)
    const known = new Set([
      ...owned.map((entry) => entry.agentId),
      ...(store.status === "available" ? store.list(parent).map((entry) => entry.agentId) : []),
    ])
    if (known.size >= limit) {
      throw new ChatGptDelegationError(
        "AGENT_LIMIT_REACHED",
        `This main agent already has the maximum ${limit} delegated agents. Reuse one of these agent IDs: ${[...known].join(", ")}.`
      )
    }
    const agent: GeminiAgent = {
      parent,
      agentId,
      kind,
      turnCount: 0,
      lastUsedAt: Date.now(),
      submitting: false,
    }
    agents.set(agentKey(parent, agentId), agent)
    return agent
  }

  function saveAgent(agent: GeminiAgent): void {
    if (!agent.conversationUrl || store.status !== "available") return
    store.set(agent.parent, agent.agentId, {
      conversationUrl: agent.conversationUrl,
      turnCount: agent.turnCount,
      kind: agent.kind,
    })
  }

  async function geminiTabs(signal?: AbortSignal): Promise<GeminiTab[]> {
    return (await browser.list(signal)).filter((tab) => isGeminiUrl(tab.url))
  }

  async function ensureTab(agent: GeminiAgent, signal?: AbortSignal): Promise<number> {
    if (agent.tabId !== undefined) {
      const open = await geminiTabs(signal)
      if (open.some((tab) => tab.tabId === agent.tabId)) return agent.tabId
      agent.tabId = undefined
    }
    if (agent.turnCount > 0 && !agent.conversationUrl) {
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        `Agent ${agent.agentId} lost its tab before its conversation URL was saved.`
      )
    }
    agent.tabId = await browser.open(agent.conversationUrl ?? GEMINI_START_URL, signal)
    return agent.tabId
  }

  async function waitForComposer(tabId: number, signal?: AbortSignal): Promise<GeminiPageSnapshot> {
    const deadline = Date.now() + COMPOSER_TIMEOUT_MS
    while (Date.now() < deadline) {
      const snapshot = await evaluate<GeminiPageSnapshot | null>(
        tabId,
        GEMINI_SNAPSHOT_SCRIPT,
        signal
      )
      if (snapshot?.ready) return snapshot
      await delay(pollMs, signal)
    }
    throw new ChatGptDelegationError(
      "CHATGPT_UI_CHANGED",
      `Could not find the Gemini composer within ${COMPOSER_TIMEOUT_MS} ms.`
    )
  }

  function assertSent(outcome: GeminiSendOutcome, agentId: string): void {
    if (outcome === "sent") return
    if (outcome === "busy" || outcome === "draft") {
      throw new ChatGptDelegationError(
        "AGENT_BUSY",
        `Agent ${agentId}'s Gemini chat is ${outcome === "busy" ? "still responding" : "holding an unsent draft"}.`
      )
    }
    throw new ChatGptDelegationError("CHATGPT_UI_CHANGED", `Gemini send failed: ${outcome}.`)
  }

  async function submit(
    agent: GeminiAgent,
    prompt: string,
    signal: AbortSignal | undefined
  ): Promise<string> {
    if (agent.submitting || agent.activeTurn) {
      throw new ChatGptDelegationError(
        "AGENT_BUSY",
        `Agent ${agent.agentId} already has an active turn.`
      )
    }
    agent.submitting = true
    try {
      const tabId = await ensureTab(agent, signal)
      const before = await waitForComposer(tabId, signal)
      assertSent(
        await evaluate<GeminiSendOutcome>(tabId, geminiSendScript(prompt), signal),
        agent.agentId
      )

      agent.turnCount += 1
      agent.lastUsedAt = Date.now()
      const turn = createTurn(agent)
      agent.activeTurn = turn
      saveAgent(agent)
      void watchTurn(agent, turn, tabId, before.users)
      return turn.turnId
    } finally {
      agent.submitting = false
    }
  }

  function createTurn(agent: GeminiAgent): GeminiTurn {
    let settle = (): void => undefined
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const turn: GeminiTurn = {
      turnId: `${agent.agentId}_turn_${agent.turnCount}`,
      agentId: agent.agentId,
      parentSession: agent.parent?.sessionId ?? "",
      status: "running",
      activityAt: Date.now(),
      hasText: false,
      settled,
      settle,
    }
    turns.set(turnKey(turn.parentSession, turn.turnId), turn)
    return turn
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One polling loop owns retry, persistence, and settlement so a turn cannot settle twice.
  async function watchTurn(
    agent: GeminiAgent,
    turn: GeminiTurn,
    tabId: number,
    usersBefore: number
  ): Promise<void> {
    const deadline = Date.now() + TURN_TIMEOUT_MS
    const progress = turnProgress(usersBefore)
    let readFailures = 0
    // biome-ignore lint/nursery/noUnmodifiedLoopCondition: dispose() sets this from outside the loop.
    while (Date.now() < deadline && !disposed) {
      await delay(pollMs)
      let snapshot: GeminiPageSnapshot | null
      try {
        snapshot = await evaluate<GeminiPageSnapshot | null>(tabId, GEMINI_SNAPSHOT_SCRIPT)
        readFailures = 0
      } catch (error) {
        readFailures += 1
        const lost = error instanceof ChatGptDelegationError && error.code === "AGENT_TARGET_LOST"
        if (lost || readFailures >= MAX_CONSECUTIVE_READ_FAILURES) return finish(agent, turn, error)
        continue
      }
      if (!snapshot) continue

      if (isGeminiConversationUrl(snapshot.url) && agent.conversationUrl !== snapshot.url) {
        agent.conversationUrl = snapshot.url
        saveAgent(agent)
      }
      const state = progress(snapshot)
      if (state === "finished") return finish(agent, turn, undefined, snapshot.text)
      if (state === "advanced") {
        turn.activityAt = Date.now()
        turn.hasText = snapshot.text.length > 0
      }
    }
    finish(
      agent,
      turn,
      new ChatGptDelegationError("AGENT_TARGET_LOST", "The Gemini turn did not finish in time.")
    )
  }

  function finish(agent: GeminiAgent, turn: GeminiTurn, error: unknown, response?: string): void {
    if (error === undefined) {
      turn.status = "completed"
      turn.response = response
    } else {
      turn.status = "failed"
      turn.errorCode = error instanceof ChatGptDelegationError ? error.code : "subagent_failed"
      turn.errorMessage = error instanceof Error ? error.message : String(error)
      log("warn", "delegation.gemini_turn_failed", { err: error, turn_id: turn.turnId })
    }
    agent.activeTurn = undefined
    agent.lastUsedAt = Date.now()
    const events = pendingEvents.get(turn.parentSession) ?? []
    events.push(`agent_finished agent_id=${turn.agentId} turn_id=${turn.turnId}`)
    pendingEvents.set(turn.parentSession, events)
    turn.settle()
  }

  async function ask(
    request: ChatGptSubagentRequest,
    { signal }: ChatGptDelegationCallContext
  ): Promise<string> {
    const parent = getAgentIdentity()
    const agent =
      findAgent(parent, request.agentId) ?? createAgent(parent, request.agentId, "subagent")
    const prompt =
      agent.turnCount === 0 ? `${request.prompt}\n\n---\n\n${INJECTED_PROMPT}` : request.prompt
    return submit(agent, prompt, signal)
  }

  /**
   * Gemini has no branch feature to drive, so a clone is a new chat seeded with what the source
   * conversation has loaded. Gemini only renders recent turns, so older ones may be missing.
   */
  async function cloneSelf(
    request: ChatGptCloneSelfRequest,
    { signal }: ChatGptDelegationCallContext
  ): Promise<string> {
    if (!isGeminiConversationUrl(request.sourceConversationUrl)) {
      throw new ChatGptDelegationError(
        "AGENT_TARGET_LOST",
        "clone_self requires a gemini.google.com/app/<id> conversation URL."
      )
    }
    const parent = getAgentIdentity()
    if (findAgent(parent, request.cloneId)) {
      throw new ChatGptDelegationError("AGENT_BUSY", `Clone ${request.cloneId} already exists.`)
    }
    const transcript = await readTranscript(request.sourceConversationUrl, signal)
    const agent = createAgent(parent, request.cloneId, "clone")
    try {
      return await submit(agent, cloneSeed(transcript, request.prompt), signal)
    } catch (error) {
      agents.delete(agentKey(parent, request.cloneId))
      if (agent.tabId !== undefined) await browser.close(agent.tabId)
      throw error
    }
  }

  async function readTranscript(url: string, signal?: AbortSignal): Promise<string> {
    const tabId = await browser.open(url, signal)
    try {
      await waitForComposer(tabId, signal)
      // The composer renders before the saved conversation does.
      await delay(Math.max(pollMs, 2_000), signal)
      const entries = await evaluate<GeminiTranscriptEntry[]>(
        tabId,
        GEMINI_TRANSCRIPT_SCRIPT,
        signal
      )
      return entries.map((entry) => `${entry.role}: ${entry.text}`).join("\n\n")
    } finally {
      await browser.close(tabId)
    }
  }

  async function cloneRun(
    request: ChatGptCloneRunRequest,
    { signal }: ChatGptDelegationCallContext
  ): Promise<string> {
    const agent = findAgent(getAgentIdentity(), request.cloneId)
    if (agent?.kind !== "clone") {
      throw new ChatGptDelegationError("AGENT_TARGET_LOST", `${request.cloneId} is not a clone.`)
    }
    return submit(agent, request.prompt, signal)
  }

  async function poll(
    turnId: string,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<ChatGptDelegationPollResult> {
    const turn = turns.get(turnKey(getAgentIdentity()?.sessionId ?? "", turnId))
    if (!turn) throw new ChatGptDelegationError("UNKNOWN_TURN", `Unknown turn ${turnId}.`)
    if (turn.status === "running" && waitMs > 0) {
      await Promise.race([turn.settled, delay(waitMs, signal)])
    }
    if (turn.status === "running") {
      return {
        status: "running",
        activity: turn.hasText ? "Generating response" : "Working",
        activityAgeMs: Date.now() - turn.activityAt,
      }
    }
    return {
      status: turn.status,
      response: turn.response,
      errorCode: turn.errorCode,
      errorMessage: turn.errorMessage,
    }
  }

  function drainEvents(): string[] {
    const session = getAgentIdentity()?.sessionId ?? ""
    const events = pendingEvents.get(session) ?? []
    pendingEvents.delete(session)
    return events
  }

  /**
   * Any Gemini chat open in the dedicated Chrome that no subagent owns is the user's, so a lone
   * one is the target. With several, only one whose page shows the agent's marker qualifies.
   */
  async function findAgentChat(marker: string): Promise<number | undefined> {
    const delegated = new Set([...agents.values()].map((agent) => agent.tabId))
    const candidates = (await geminiTabs()).filter(
      (tab) => !delegated.has(tab.tabId) && isGeminiConversationUrl(tab.url)
    )
    if (candidates.length <= 1) return candidates[0]?.tabId
    const showing: number[] = []
    for (const { tabId } of candidates) {
      if (await evaluate<boolean>(tabId, geminiMarkerScript(marker))) showing.push(tabId)
    }
    return showing.length === 1 ? showing[0] : undefined
  }

  async function deliverToAgentChat(
    marker: string,
    claimMessage: () => string | undefined
  ): Promise<AgentChatDeliveryResult> {
    const tabId = await findAgentChat(marker)
    if (tabId === undefined) return "missing"
    const snapshot = await evaluate<GeminiPageSnapshot | null>(tabId, GEMINI_SNAPSHOT_SCRIPT)
    if (!snapshot?.ready) return "missing"
    if (snapshot.generating) return "busy"
    if (snapshot.draft) return "draft"
    const message = claimMessage()
    if (message === undefined) return "sent"
    assertSent(await evaluate<GeminiSendOutcome>(tabId, geminiSendScript(message)), "main")
    return "sent"
  }

  async function closeIdleTabs(): Promise<void> {
    const now = Date.now()
    for (const agent of agents.values()) {
      if (agent.tabId === undefined || agent.activeTurn || agent.submitting) continue
      if (now - agent.lastUsedAt < AGENT_IDLE_TTL_MS || !agent.conversationUrl) continue
      const tabId = agent.tabId
      agent.tabId = undefined
      await browser.close(tabId)
    }
  }

  async function dispose(): Promise<void> {
    disposed = true
    clearInterval(cleanupTimer)
    const open = [...agents.values()].flatMap((agent) => agent.tabId ?? [])
    await Promise.allSettled(open.map((tabId) => browser.close(tabId)))
    await browser.disconnect()
    store.close()
  }

  return {
    ask,
    cloneSelf,
    cloneRun,
    poll,
    drainEvents,
    deliverToAgentChat,
    dispose,
  }
}

/** Tells apart a turn still waiting, one whose text moved, and one that has finished. */
function turnProgress(usersBefore: number) {
  let previousText = ""
  let stablePolls = 0
  return (snapshot: GeminiPageSnapshot): "waiting" | "advanced" | "finished" => {
    if (snapshot.users <= usersBefore || snapshot.models < snapshot.users) return "waiting"
    if (snapshot.text !== previousText) {
      previousText = snapshot.text
      stablePolls = 0
      return "advanced"
    }
    if (snapshot.generating || !snapshot.text) return "waiting"
    stablePolls += 1
    return stablePolls >= STABLE_POLLS_TO_FINISH ? "finished" : "waiting"
  }
}

function turnKey(parentSession: string, turnId: string): string {
  return `${parentSession}\0${turnId}`
}

function cloneSeed(transcript: string, prompt: string): string {
  const context = transcript.slice(-MAX_CLONE_CONTEXT_CHARS)
  return `You are continuing the conversation below as an independent copy of its assistant.\n\n<conversation>\n${context}\n</conversation>\n\n${prompt}\n\n---\n\n${INJECTED_PROMPT}`
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ChatGptDelegationError("REQUEST_ABORTED", "The Gemini request was cancelled."))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ChatGptDelegationError("REQUEST_ABORTED", "The Gemini request was cancelled."))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
