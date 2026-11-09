import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"
import { ShellbyAuthStore } from "../src/auth/store.js"
import { readTunnelSecret } from "../src/server/tunnel-secret.js"
import { tempDir } from "./helpers/temp.js"
import { startMcpHttpServer } from "./integrations/helpers.js"

test("Cloudflare origin exposes only a secret MCP route and binds remote subjects", async (t) => {
  const root = await tempDir(t, "shellby-cloudflared-")
  const authStore = new ShellbyAuthStore(join(root, "auth.json"))
  await authStore.ensureState()
  const secretFile = join(root, "tunnel-secret")
  const running = await startMcpHttpServer({
    authStore,
    http: { tunnel: { port: 0, secretFile }, authMode: "chatgpt" },
    profile: {
      tools: {
        review: false,
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        clones: false,
        subagents: false,
        web: false,
        skills: false,
        image: false,
        computer: false,
      },
    },
  })
  t.after(() => running.close())
  assert.ok(running.tunnelPort)
  const origin = `http://127.0.0.1:${running.tunnelPort}`
  const secret = readTunnelSecret(secretFile)
  assert.equal((await fetch(`${origin}/mcp`, { method: "HEAD" })).status, 404)
  assert.equal((await fetch(`${origin}/${secret}/mcp`, { method: "HEAD" })).status, 204)
  assert.equal((await fetch(`${origin}/${secret}/healthz`)).status, 404)
  assert.equal(
    (await fetch(running.url, { headers: { "cf-connecting-ip": "203.0.113.1" } })).status,
    404
  )

  const call = (subject?: string) =>
    fetch(`${origin}/${secret}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(subject ? { "x-openai-subject": subject } : {}),
        "x-shellby-remote": "0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unknown", arguments: {} },
      }),
    })
  assert.equal((await call()).status, 403)
  assert.deepEqual((await authStore.readState()).subjects, [])
  await call("owner-a")
  assert.deepEqual((await authStore.readState()).subjects, ["owner-a"])
  assert.equal((await call("other-owner")).status, 403)
})

test("Cloudflare origin in hybrid mode allows both bound ChatGPT user and Gemini callers", async (t) => {
  const root = await tempDir(t, "shellby-cloudflared-hybrid-")
  const authStore = new ShellbyAuthStore(join(root, "auth.json"))
  await authStore.ensureState()
  const secretFile = join(root, "tunnel-secret")
  const running = await startMcpHttpServer({
    authStore,
    http: { tunnel: { port: 0, secretFile }, authMode: "hybrid" },
    profile: {
      tools: {
        review: false,
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        clones: false,
        subagents: false,
        web: false,
        skills: false,
        image: false,
        computer: false,
      },
    },
  })
  t.after(() => running.close())
  assert.ok(running.tunnelPort)
  const origin = `http://127.0.0.1:${running.tunnelPort}`
  const secret = readTunnelSecret(secretFile)

  const call = (subject?: string, sessionId?: string) =>
    fetch(`${origin}/${secret}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(subject ? { "x-openai-subject": subject } : {}),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unknown", arguments: {} },
      }),
    })

  // 1. ChatGPT call binds owner-a
  const first = await call("owner-a")
  assert.notEqual(first.status, 403)
  assert.deepEqual((await authStore.readState()).subjects, ["owner-a"])

  // 2. Gemini call without subject over secret tunnel succeeds
  const gemini = await call(undefined, "gemini-session-123")
  assert.notEqual(gemini.status, 403)

  // 3. Different ChatGPT user is rejected
  const impostor = await call("other-chatgpt-user")
  assert.equal(impostor.status, 403)
})
