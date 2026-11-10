import { setTimeout as delay } from "node:timers/promises"

import { log } from "../logging.js"
import type { AgentProvider } from "./context.js"
import type { AgentObserver } from "./observer.js"

export type AgentChatDeliveryResult = "sent" | "busy" | "draft" | "missing"

/** Types into the chat tab that owns an agent's conversation. */
export interface AgentChatTransport {
  /**
   * Calls `claimMessage` only once the chat is ready, immediately before typing. It may return
   * undefined when another path already delivered the instructions.
   */
  deliverToAgentChat(
    marker: string,
    claimMessage: () => string | undefined,
    provider: AgentProvider
  ): Promise<AgentChatDeliveryResult>
}

export interface ChatDelivery {
  deliver(agentId: string): void
}

const DEFAULT_POLL_MS = 3_000
const DEFAULT_MAX_WAIT_MS = 30 * 60_000
/** A conversation can gain its marker, or its tab can open, shortly after the instruction. */
const DEFAULT_MISSING_GIVE_UP_MS = 3 * 60_000

/**
 * Moves queued steering instructions into the agent's open chat as soon as it is free. Instructions
 * stay queued for the next tool response while the agent is busy, or when no chat tab is known.
 */
export function createChatDelivery(
  observer: AgentObserver,
  transport: AgentChatTransport,
  options: { pollMs?: number; maxWaitMs?: number; missingGiveUpMs?: number } = {}
): ChatDelivery {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const missingGiveUpMs = options.missingGiveUpMs ?? DEFAULT_MISSING_GIVE_UP_MS
  const pumping = new Set<string>()

  async function pump(agentId: string): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    let missingSince: number | undefined
    while (Date.now() < deadline) {
      const target = observer.chatDeliveryTarget(agentId)
      if (!target?.pending) return
      if (!target.busy) {
        const missing = (await attempt(agentId, target.marker, target.provider)) === "missing"
        missingSince = missing ? (missingSince ?? Date.now()) : undefined
        if (missingSince !== undefined && Date.now() - missingSince >= missingGiveUpMs) return
      }
      await delay(pollMs, undefined, { ref: false })
    }
    log("warn", "agent.chat_delivery_timed_out", { agent_id: agentId })
  }

  async function attempt(
    agentId: string,
    marker: string,
    provider: AgentProvider
  ): Promise<AgentChatDeliveryResult> {
    let claimedIds: string[] = []
    try {
      return await transport.deliverToAgentChat(
        marker,
        () => {
          const claimed = observer.claimInstructions(agentId)
          claimedIds = claimed.map((instruction) => instruction.id)
          return claimed.length > 0
            ? claimed.map((instruction) => instruction.message).join("\n\n")
            : undefined
        },
        provider
      )
    } catch (error) {
      observer.releaseInstructions(agentId, claimedIds)
      log("warn", "agent.chat_delivery_failed", { agent_id: agentId, err: error })
      return "missing"
    }
  }

  return {
    deliver(agentId) {
      if (pumping.has(agentId)) return
      pumping.add(agentId)
      void pump(agentId).finally(() => pumping.delete(agentId))
    },
  }
}
