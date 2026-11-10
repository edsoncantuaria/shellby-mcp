import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import express from "express"
import { z } from "zod"

import { ExternalMcpManager } from "../../../src/tools/external-mcp/external-mcp-manager.js"
import { loginExternalMcpServer } from "../../../src/tools/external-mcp/external-mcp-oauth.js"
import { tempDir } from "../../helpers/temp.js"

const TIMEOUT = { timeout: 20_000 }

async function startRemote(t: TestContext, requireAuth: boolean) {
  const state = {
    registrations: 0,
    refreshes: 0,
    initializes: 0,
    deny: false,
    failNext: false,
    bearers: [] as string[],
    access: new Set<string>(),
    refresh: new Set<string>(),
    codes: new Map<string, string>(),
    counter: 0,
  }
  const issueTokens = () => {
    state.counter += 1
    const tokens = { access: `access-${state.counter}`, refresh: `refresh-${state.counter}` }
    state.access.add(tokens.access)
    state.refresh.add(tokens.refresh)
    return {
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      token_type: "Bearer",
      expires_in: 3600,
    }
  }

  const handler = toNodeHandler(
    createMcpHandler(() => {
      const server = new McpServer({ name: "fake-remote", version: "1.0.0" })
      server.registerTool(
        "echo",
        { description: "Echo.", inputSchema: z.object({ value: z.string() }) },
        async ({ value }) => ({ content: [{ type: "text", text: value }] })
      )
      return server
    })
  )
  const app = createMcpExpressApp({ host: "127.0.0.1" })
  app.use(express.urlencoded({ extended: false }))
  let base = ""

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({ resource: `${base}/mcp`, authorization_servers: [base] })
  })
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    })
  })
  app.post("/register", (req, res) => {
    state.registrations += 1
    res.status(201).json({ ...req.body, client_id: `client-${state.registrations}` })
  })
  app.get("/authorize", (req, res) => {
    const target = new URL(String(req.query.redirect_uri))
    target.searchParams.set("state", String(req.query.state))
    target.searchParams.set("iss", base)
    if (state.deny) target.searchParams.set("error", "access_denied")
    else {
      state.codes.set("the-code", String(req.query.code_challenge))
      target.searchParams.set("code", "the-code")
    }
    res.redirect(target.toString())
  })
  app.post("/token", (req, res) => {
    if (req.body.grant_type === "authorization_code") {
      const challenge = createHash("sha256").update(req.body.code_verifier).digest("base64url")
      if (state.codes.get(req.body.code) !== challenge) {
        res.status(400).json({ error: "invalid_grant" })
        return
      }
      res.json(issueTokens())
      return
    }
    // Refresh tokens are single use, like servers that rotate them.
    if (!state.refresh.delete(req.body.refresh_token)) {
      res.status(400).json({ error: "invalid_grant" })
      return
    }
    state.refreshes += 1
    res.json(issueTokens())
  })
  app.all("/mcp", async (req, res) => {
    const bearer = req.get("authorization")?.replace(/^Bearer /u, "")
    if (bearer) state.bearers.push(bearer)
    if (requireAuth && (!bearer || !state.access.has(bearer))) {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
        )
        .end()
      return
    }
    if (req.body?.method === "initialize") state.initializes += 1
    if (state.failNext && req.body?.method === "tools/call") {
      state.failNext = false
      res.status(500).end()
      return
    }
    await handler(req, res, req.body)
  })

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  return { state, url: `${base}/mcp` }
}

async function setup(t: TestContext, requireAuth: boolean) {
  const remote = await startRemote(t, requireAuth)
  const loginDir = await tempDir(t, "shellby-remote-mcp-")
  const manager = new ExternalMcpManager(
    { remote: { url: remote.url } },
    { loginDir, connectTimeoutMs: 5_000, callTimeoutMs: 5_000 }
  )
  t.after(() => manager.close())
  const storePath = join(loginDir, "remote.json")
  const login = () =>
    loginExternalMcpServer({
      url: remote.url,
      storePath,
      onAuthorizationUrl: async (url) => {
        await fetch(url)
      },
    })
  const echo = async (value: string) => {
    const result = await manager.callTool("remote", "echo", { value })
    const block = result.content[0]
    return block?.type === "text" ? block.text : undefined
  }
  return { ...remote, manager, loginDir, storePath, login, echo }
}

test("uses a remote server that requires no login", TIMEOUT, async (t) => {
  const { manager, echo, state } = await setup(t, false)

  const { tools } = await manager.listTools("remote")
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["echo"]
  )
  assert.equal(await echo("hello"), "hello")
  assert.equal(state.registrations, 0)
})

test("asks for a login, then uses it without a restart", TIMEOUT, async (t) => {
  const { echo, login, state, storePath, loginDir } = await setup(t, true)

  await assert.rejects(echo("a"), /needs a login.*npm run mcp:login -- remote/su)
  assert.equal(state.registrations, 0)

  await login()
  assert.equal(await echo("a"), "a")
  assert.equal((await stat(storePath)).mode & 0o777, 0o600)
  assert.equal((await stat(loginDir)).mode & 0o777, 0o700)
})

test("shares one refresh between concurrent expired calls", TIMEOUT, async (t) => {
  const { echo, login, state, storePath } = await setup(t, true)
  await login()
  await echo("connect")

  state.access.clear()
  assert.deepEqual(await Promise.all([echo("a"), echo("b"), echo("c")]), ["a", "b", "c"])
  assert.equal(state.refreshes, 1)
  assert.equal(JSON.parse(await readFile(storePath, "utf8")).tokens.access_token, "access-2")
})

test("a revoked login asks to sign in again and never leaks its token", TIMEOUT, async (t) => {
  const { echo, login, state } = await setup(t, true)
  await login()
  await echo("connect")

  state.access.clear()
  state.refresh.clear()
  const failure = await echo("a").catch((error: Error) => error)
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /needs a login/u)
  assert.doesNotMatch(failure.message, /access-1|refresh-1/u)

  await login()
  assert.equal(await echo("b"), "b")
})

test("a refused login keeps the stored one", TIMEOUT, async (t) => {
  const { echo, login, state, storePath } = await setup(t, true)
  await login()
  const stored = await readFile(storePath, "utf8")

  state.deny = true
  await assert.rejects(login(), /refused the login: access_denied/u)

  assert.equal(await readFile(storePath, "utf8"), stored)
  assert.equal(await echo("still"), "still")
})

test("ignores a callback without the login's state", TIMEOUT, async (t) => {
  const { url, loginDir, state } = await setup(t, true)
  const storePath = join(loginDir, "other.json")

  await loginExternalMcpServer({
    url,
    storePath,
    onAuthorizationUrl: async (authorizationUrl) => {
      const forged = new URL(String(authorizationUrl.searchParams.get("redirect_uri")))
      forged.searchParams.set("code", "forged")
      forged.searchParams.set("state", "wrong")
      assert.equal((await fetch(forged)).status, 404)
      await fetch(authorizationUrl)
    },
  })

  assert.equal(state.counter, 1)
})

test("never sends a login to a different URL", TIMEOUT, async (t) => {
  const { echo, login, state, storePath, url } = await setup(t, true)
  await login()
  const stored = JSON.parse(await readFile(storePath, "utf8"))
  await writeFile(storePath, JSON.stringify({ ...stored, url: `${url}/old` }))

  await assert.rejects(echo("a"), /needs a login/u)
  assert.deepEqual(state.bearers, [])
})

test("reconnects after a broken remote call without replaying it", TIMEOUT, async (t) => {
  const { echo, state } = await setup(t, false)
  await echo("connect")
  const initializes = state.initializes

  state.failNext = true
  await assert.rejects(echo("lost"), /External MCP call remote\/echo failed/u)
  assert.equal(await echo("again"), "again")
  assert.equal(state.initializes, initializes + 1)
})

test("a login can time out", TIMEOUT, async (t) => {
  const { url, loginDir } = await setup(t, true)

  await assert.rejects(
    loginExternalMcpServer({
      url,
      storePath: join(loginDir, "timeout.json"),
      timeoutMs: 100,
      onAuthorizationUrl: () => undefined,
    }),
    /Timed out/u
  )
})
