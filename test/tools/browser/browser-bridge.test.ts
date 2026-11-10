import assert from "node:assert/strict"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import test, { type TestContext } from "node:test"
import { WebSocket } from "ws"

import { MCP_CONFIG } from "../../../src/config.js"
import {
  BrowserBridge,
  type BrowserBridgeError,
} from "../../../src/tools/browser/browser-bridge.js"

const SECRET = "a".repeat(64)
const ORIGIN = "chrome-extension://abc"

async function startBridge(t: TestContext, callTimeoutMs?: number): Promise<BrowserBridge> {
  const bridge = new BrowserBridge({
    host: "127.0.0.1",
    port: 0,
    secret: SECRET,
    allowedOrigin: ORIGIN,
    callTimeoutMs,
  })
  await bridge.start()
  t.after(() => bridge.close())
  return bridge
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())))
  })
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code))
  })
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex")
}

function open(bridge: BrowserBridge, origin = ORIGIN): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${bridge.port}/`, { origin })
}

async function pair(bridge: BrowserBridge, secret = SECRET) {
  const socket = open(bridge)
  const challenge = await nextMessage(socket)
  const nonce = randomBytes(32).toString("hex")
  const reply = nextMessage(socket)
  socket.send(
    JSON.stringify({ type: "auth", proof: hmac(secret, `client:${challenge.nonce}`), nonce })
  )
  return { socket, challenge, nonce, reply }
}

test("authenticates both ends and round-trips a call", async (t) => {
  const bridge = await startBridge(t)
  const { socket, challenge, nonce, reply } = await pair(bridge)
  const authenticated = await reply
  assert.equal(authenticated.type, "authenticated")
  assert.equal(authenticated.proof, hmac(SECRET, `server:${challenge.nonce}:${nonce}`))

  const incoming = nextMessage(socket)
  const call = bridge.call<string>("read", { tabId: 7 })
  const request = await incoming
  assert.deepEqual(
    { method: request.method, params: request.params },
    { method: "read", params: { tabId: 7 } }
  )
  socket.send(JSON.stringify({ type: "result", id: request.id, ok: true, result: "page" }))
  assert.equal(await call, "page")
  socket.close()
})

test("never adopts a client without the secret", async (t) => {
  const bridge = await startBridge(t)
  const { socket } = await pair(bridge, "b".repeat(64))
  assert.equal(await closed(socket), 4401)
  await assert.rejects(bridge.call("read", {}), { code: "EXTENSION_DISCONNECTED" })
})

test("refuses the upgrade from any other origin", async (t) => {
  const bridge = await startBridge(t)
  const socket = open(bridge, "https://evil.example")
  const error = await new Promise<Error>((resolve) => {
    socket.once("error", resolve)
  })
  assert.match(error.message, /401/u)
})

test("surfaces extension errors with their code", async (t) => {
  const bridge = await startBridge(t)
  const { socket, reply } = await pair(bridge)
  await reply
  const incoming = nextMessage(socket)
  const call = bridge.call("read", {})
  const request = await incoming
  socket.send(
    JSON.stringify({
      type: "result",
      id: request.id,
      ok: false,
      error: { code: "SITE_DENIED", message: "no" },
    })
  )
  await assert.rejects(call, (error: BrowserBridgeError) => error.code === "SITE_DENIED")
  socket.close()
})

test("rejects in-flight calls on disconnect, timeout, and abort", async (t) => {
  const bridge = await startBridge(t, 30)
  const { socket, reply } = await pair(bridge)
  await reply

  await assert.rejects(bridge.call("read", {}), { code: "TIMEOUT" })

  const controller = new AbortController()
  const aborted = bridge.call("read", {}, controller.signal)
  controller.abort()
  await assert.rejects(aborted, { code: "ABORTED" })

  const dropped = bridge.call("read", {})
  socket.close()
  await assert.rejects(dropped, { code: "EXTENSION_DISCONNECTED" })
})

test("a newer authenticated connection replaces the old one", async (t) => {
  const bridge = await startBridge(t)
  const first = await pair(bridge)
  await first.reply
  const pending = bridge.call("read", {}).catch((error: BrowserBridgeError) => error.code)
  const firstClosed = closed(first.socket)
  const second = await pair(bridge)
  await second.reply
  assert.equal(await pending, "EXTENSION_DISCONNECTED")
  assert.equal(await firstClosed, 4409)
  second.socket.close()
})

test("the configured origin is the identity derived from the manifest key", async () => {
  const manifestUrl = new URL("../../../browser-extension/manifest.json", import.meta.url)
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as { key: string }
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
  const id = [...digest.slice(0, 32)]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("")
  assert.equal(MCP_CONFIG.browserBridge.extensionOrigin, `chrome-extension://${id}`)
})
