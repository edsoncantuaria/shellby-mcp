import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

export interface AgentIdentity {
  readonly sessionId: string
  readonly agent: string
  readonly taskSlug?: string
}

interface StoredAgentIdentity {
  sessionId: string
  agent: string
  taskSlug?: string
}

const agents = new Map<string, StoredAgentIdentity>()
const currentAgent = new AsyncLocalStorage<StoredAgentIdentity>()

export function runWithAgent<T>(sessionId: string | undefined, callback: () => T): T {
  return sessionId ? currentAgent.run(agentForSession(sessionId), callback) : callback()
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

function agentForSession(sessionId: string): StoredAgentIdentity {
  const known = agents.get(sessionId)
  if (known) return known

  const identity = { sessionId, agent: `agent-${agents.size + 1}` }
  agents.set(sessionId, identity)
  return identity
}
