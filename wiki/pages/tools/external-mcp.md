---
summary: "Bridge to stdio and remote MCP servers: operator-declared servers, OAuth logins, shared lifetime, result limits, and failure semantics."
paths:
  - src/tools/external-mcp/
  - src/public-config.cts
  - src/config.ts
---

# External MCP Bridge

`mcp_list_tools` and `mcp_call` let the ChatGPT side use other MCP servers: local stdio ones such as Blender or Godot, and remote HTTP ones such as Cloudflare. [external-mcp-manager.ts](../../../src/tools/external-mcp/external-mcp-manager.ts) owns the client connections and child processes; [external-mcp-tools.ts](../../../src/tools/external-mcp/external-mcp-tools.ts) owns the tool contracts and result projection.

## Why two generic tools

Republishing each external tool would add dozens of entries to `tools/list` and tie that list to which servers happen to be reachable. Two tools keep the surface fixed; the cost is one `mcp_list_tools` round trip before the first call.

## Trust boundary

Servers come only from the operator: `[external_mcp.<name>]` in `.shellby/config.toml`, or the user-scope `mcpServers` of `~/.claude.json` when `[claude_mcp] enabled = true`. A TOML declaration wins over an imported server of the same name, and `exclude` removes imported names. With no server, neither tool is published. Callers choose a declared name and cannot supply a command, arguments, working directory, or environment. Children start without a shell and receive the SDK's safe default environment, the desktop session variables that let applications open windows, and their configured `env`, so the rest of Shellby's environment does not reach them.

[public-config.cts](../../../src/public-config.cts) reads the Claude file once at startup, so changes need a restart. An unreadable file or unusable entry only warns, and warnings name servers without quoting their settings because entries can hold credentials. Remote entries without static headers are imported; those with headers, project-scope servers, plugin servers, and claude.ai connectors are not. Claude's `${VAR}` expansion is not applied.

The client declares no capabilities, so external servers cannot request sampling, elicitation, or roots. A declared server can still run arbitrary code, as `execute_blender_code` does; this matches the authority `shell_run` already grants.

## Lifetime

One shared manager is built in [src/index.ts](../../../src/index.ts), because the MCP server factory runs per request. A server starts on first use, concurrent first calls share that start, and every conversation shares the process, matching the single live application behind it. Agents working in the same application are not isolated from each other.

A server that exits is started again by the next call. The interrupted call is reported as having an unknown outcome and is never replayed, because external calls may be stateful. A timed-out call may likewise still be running. Start failures include the tail of the server's stderr and affect only that server.

## Results

External text is bounded by the shared token limit in [config.ts](../../../src/config.ts), with a visible truncation notice. Images go through [shared image encoding](./files-and-images.md). Audio and binary resources are replaced with a visible note. `structuredContent` is rendered only when a server returned no content blocks. `mcp_list_tools` is not truncated: a partial schema would produce invalid calls, and its size is set by the operator's chosen server.

## Remote servers and logins

A server declared with `url` uses Streamable HTTP. HTTPS is required except on loopback, so a token never crosses the network in clear text. [external-mcp-oauth.ts](../../../src/tools/external-mcp/external-mcp-oauth.ts) owns both halves of authorization.

Only `npm run mcp:login -- <server>` starts a browser authorization. It listens on an ephemeral loopback port, ignores callbacks without its `state`, registers a fresh OAuth client for that port, and stores the result only on success, so a failed login leaves the previous one working. Tools can only report that a login is needed; they cannot begin one.

At runtime the store is read on each request, so a login applies without a restart. Each login is bound to its URL, which keeps a config edit from sending a token elsewhere. Concurrent 401s share one refresh because the SDK has no single flight and servers that rotate refresh tokens reject the second use. A missing login fails before dynamic registration, so unauthenticated calls do not create OAuth clients. A rejected grant asks for a new login; other refresh errors are reported as they are, since they may be transient.

A remote transport failure drops the connection so the next call reconnects; protocol errors and timeouts keep it. The failed call is not replayed.

Validate with [stdio integration tests](../../../test/integrations/external-mcp.ts) and [OAuth tests](../../../test/tools/external-mcp/remote-oauth.test.ts).
