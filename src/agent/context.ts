import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

/** The chat product an agent is running in. */
export type AgentProvider = "chatgpt" | "gemini"

export interface AgentIdentity {
  readonly sessionId: string
  readonly agent: string
  readonly provider: AgentProvider
  readonly taskSlug?: string
}

interface StoredAgentIdentity {
  sessionId: string
  agent: string
  provider: AgentProvider
  taskSlug?: string
}

const agents = new Map<string, StoredAgentIdentity>()
const currentAgent = new AsyncLocalStorage<StoredAgentIdentity>()

export function runWithAgent<T>(
  sessionId: string | undefined,
  callback: () => T,
  provider: AgentProvider = "chatgpt"
): T {
  return sessionId ? currentAgent.run(agentForSession(sessionId, provider), callback) : callback()
}

export function getAgentIdentity(): AgentIdentity | undefined {
  return currentAgent.getStore()
}

export function setAgentTaskSlug(taskSlug: string): void {
  const identity = currentAgent.getStore()
  if (identity) identity.taskSlug = taskSlug
}

/**
 * Stable text placed in `start_here` results. It is the one identifier present on both sides: the
 * MCP session and the conversation stored by ChatGPT.
 */
export function agentChatMarker(sessionId: string): string {
  return `shellby-agent:${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`
}

function agentForSession(sessionId: string, provider: AgentProvider): StoredAgentIdentity {
  const known = agents.get(sessionId)
  if (known) return known

  const position = [...agents.values()].filter((entry) => entry.provider === provider).length + 1
  const agent = `${provider === "gemini" ? "gemini" : "agent"}-${position}`
  const identity = { sessionId, agent, provider }
  agents.set(sessionId, identity)
  return identity
}
