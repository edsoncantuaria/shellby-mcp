---
summary: "Caller identity, task labels, dashboard observation/steering, and why lineage is not inferred."
paths:
  - src/agent/context.ts
  - src/agent/observer.ts
  - src/agent/dashboard-routes.ts
  - src/agent/tool-call-presentation.ts
  - src/server/http-server.ts
---

# Agent Context

[context.ts](../../src/agent/context.ts) maps each opaque `X-OpenAI-Session` to one canonical process-local `AgentIdentity`: session ID, readable `agent-N` alias, and optional task slug. AsyncLocalStorage carries that identity through a request. Successful `start_here` sets the task slug; aliases and initialization disappear on restart. Headerless requests have no identity. Each identity also records its `provider`: Google's MCP client is recognized by its `Google` user agent, and its aliases are `gemini-N`. Gemini has not been seen sending a per-conversation ID, so tunnel calls without one share the `gemini:shared` session; concurrent Gemini chats therefore look like one agent and share its shells.

[HTTP Transport](./http-transport.md) owns authorization. [MCP Tool Surface](./mcp-tool-surface.md) owns startup gating. Audit, review, instruction deduplication, delegation, and steering share the canonical identity; do not invent parallel session registries.

## Dashboard ownership

When enabled, one [observer](../../src/agent/observer.ts) tracks concurrent calls, bounded recent history, and queued instructions. [tool-call-presentation.ts](../../src/agent/tool-call-presentation.ts) owns displayed summaries. Call completion means the callback returned; a returned tool error need not appear as observer `failed`.

[dashboard-routes.ts](../../src/agent/dashboard-routes.ts) owns snapshot/SSE, steering queue/cancellation, and static `/ui`/`/ui/editor` serving. Steering targets observed `agent-N` identities and drains in submission order on a later tool response. [chat-delivery.ts](../../src/agent/chat-delivery.ts) also sends it into the agent's open tab in the managed Chrome when no tool is running, so an idle agent receives it, through the [Gemini tab](./subagents/gemini-browser-subagents.md) for Gemini agents. It cannot interrupt upstream generation or a pending tool, and it never replaces a draft in the composer. State disappears on restart.

`start_here` results carry `agentChatMarker(sessionId)`, the deterministic identifier present in both the MCP session and ChatGPT's stored tool results; only tool messages can claim a conversation. Each open conversation is read once in a throwaway background tab. Frontend contracts and presentation belong to the [UI wiki](../../ui/wiki/AGENTS.md).

## No inferred lineage

Browser-backed agents do not expose a proven identifier join to incoming MCP sessions. An earlier experiment matched CDP tool calls to MCP requests by tool name/time window; repeated calls and races produced false self/parent associations. Argument matching would remain heuristic. Reconsider lineage only after proving a deterministic identifier on both sides.

Delegated turns capture their launching identity; [completion/events](./subagents/subagent-completion.md) route back to that owner without classifying later callers as children.

Tests: [context](../../test/agent/context.test.ts), [observer](../../test/agent/observer.test.ts), and [startup integration](../../test/integrations/session-initialization.ts).
