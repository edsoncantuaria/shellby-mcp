---
summary: "HTTP authorization, ngrok trust boundary, protocol compatibility, and connection lifetime."
paths:
  - src/server/http-server.ts
  - src/auth/
  - ngrok-traffic-policy.yml
  - test/integrations/http-transport.ts
---

# HTTP Transport

## Trust boundary

[http-server.ts](../../src/server/http-server.ts) uses `createMcpExpressApp` with localhost Host/Origin guards. Direct loopback clients remain unauthenticated and retain local-user authority. Host/Origin protection is not caller authentication.

[ngrok-traffic-policy.yml](../../ngrok-traffic-policy.yml) admits the `com.openai.chatgpt` IP category, exposes only exact `/mcp`, removes an incoming remote marker, then adds `X-Shellby-Remote: 1` and rewrites Host to `localhost`. The marker means the deployment boundary already checked origin. A replacement proxy must preserve an equivalent contract.

For marked POST requests containing a named `tools/call`, [auth/store.ts](../../src/auth/store.ts) requires `X-OpenAI-Subject`. The state holds an allowlist of bound subjects plus a count of open slots. A new installation has one open slot: the first call binds its subject before dispatch, even if its tool is unknown or fails. An unknown subject binds only while a slot is open and consumes it; otherwise it is rejected. `npm run auth:add` opens one more slot after operator confirmation, so additional ChatGPT accounts are admitted one at a time and never implicitly. Every bound subject has the same full authority. Legacy single-subject state is read as one bound subject with no open slot. Subject state survives restart in `<state_dir>/auth.json`; missing/invalid state fails closed. HTTP errors never echo the subject. Shellby does not use MCP OAuth or per-tool security schemes.

`X-OpenAI-Session` supplies coordination context, never authorization. [Agent Context](./agent-context.md) owns initialization, task labels, and caller-scoped state. Historical header evidence: [2026-08-09 observation](../raw/openai-mcp-identity-observation-2026-08-09.md).

## Routes and lifetime

- Exact `/mcp` uses a regex route because Express was initialized before strict routing could be enabled; `/mcp/` stays distinct.
- `/healthz` returns health plus `X-Shellby-Instance`, derived from repository and state directory. Startup uses it to reject another copy on the selected port; it is not authentication.
- Optional `/ui` routes share loopback guards but have no subject binding. Checked-in ngrok policy excludes them. Dashboard details: [Agent Context](./agent-context.md).

`createMcpHandler` obtains short-lived servers from the bound factory. Its modern path supports MCP `2026-07-28`; explicit `legacy: "stateless"` keeps the older protocol path on the same registrations. SDK owns serving, streaming, and teardown. HTTP owns request context, auth, and [audit correlation](./operations/audit-logging.md); [composition](./architecture-map.md) owns capability lifetime.

No retained MCP HTTP session ID is required. Integration tests exercise an existing client after an isolated restart at the same URL. Process-local capabilities and `start_here` state still reset; changed schemas/instructions may require client refresh.

Validate with [transport integration cases](../../test/integrations/http-transport.ts), [auth cases](../../test/integrations/auth.ts), and [auth-store tests](../../test/auth/store.test.ts), through the runner in [Build and Test](./operations/build-and-test.md).
