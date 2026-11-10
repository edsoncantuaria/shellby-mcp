import { getAgentIdentity } from "../../agent/context.js"
import { ChatGptDelegationError, type ChatGptDelegationService } from "./contracts.js"

/** Sends each delegated agent to the chat product its caller is running in. */
export function createDelegationRouter(
  chatGpt: ChatGptDelegationService,
  gemini: Omit<ChatGptDelegationService, "ensureProject">
): ChatGptDelegationService {
  const forCaller = () => (getAgentIdentity()?.provider === "gemini" ? gemini : chatGpt)

  return {
    ask: (request, context) => forCaller().ask(request, context),
    cloneSelf: (request, context) => forCaller().cloneSelf(request, context),
    cloneRun: (request, context) => forCaller().cloneRun(request, context),
    poll: (turnId, waitMs, signal) => forCaller().poll(turnId, waitMs, signal),
    ensureProject(request, context) {
      if (getAgentIdentity()?.provider === "gemini") {
        throw new ChatGptDelegationError(
          "UNSUPPORTED_FOR_GEMINI",
          "chatgpt_project only works from ChatGPT."
        )
      }
      return chatGpt.ensureProject(request, context)
    },
    drainEvents: () => forCaller().drainEvents(),
    deliverToAgentChat: (marker, claimMessage, provider) =>
      (provider === "gemini" ? gemini : chatGpt).deliverToAgentChat(marker, claimMessage, provider),
    dispose: async () => {
      await Promise.all([chatGpt.dispose(), gemini.dispose()])
    },
  }
}
