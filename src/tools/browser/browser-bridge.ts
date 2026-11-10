import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { type RawData, type WebSocket, WebSocketServer } from "ws"
import { z } from "zod"
import { log } from "../../logging.js"

const AUTH_TIMEOUT_MS = 5_000
const CALL_TIMEOUT_MS = 30_000
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024
const CLOSE_UNAUTHORIZED = 4401
const CLOSE_REPLACED = 4409

const authMessage = z.object({
  type: z.literal("auth"),
  proof: z.string(),
  nonce: z.string().min(32),
  browser_id: z.uuid(),
  name: z.string().trim().min(1).max(60),
})

const resultMessage = z.object({
  type: z.literal("result"),
  id: z.number(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

export class BrowserBridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BrowserBridgeError"
    this.code = code
  }
}

export interface BrowserBridgeOptions {
  host: string
  port: number
  secret: string
  /** The only Origin allowed to open the socket; web pages cannot forge it. */
  allowedOrigin: string
  callTimeoutMs?: number
}

interface PendingCall {
  socket: WebSocket
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface BrowserConnection {
  id: string
  name: string
  socket: WebSocket
}

export interface ConnectedBrowser {
  id: string
  name: string
}

export type BrowserCaller = Pick<BrowserBridge, "call" | "browsers">

/**
 * Loopback channel to the Shellby Chrome extension. It listens on its own port so the public
 * tunnel, which forwards to the MCP port, can never reach it. Tab scope and site approval are
 * enforced by the extension; this side only proves both ends hold the pairing secret.
 */
export class BrowserBridge {
  private readonly options: BrowserBridgeOptions
  private server: WebSocketServer | undefined
  private readonly connections = new Map<string, BrowserConnection>()
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 0

  constructor(options: BrowserBridgeOptions) {
    this.options = options
  }

  get port(): number {
    const address = this.server?.address()
    if (!address || typeof address === "string") throw new Error("Browser bridge is not listening.")
    return address.port
  }

  async start(): Promise<void> {
    const { host, port, allowedOrigin } = this.options
    const server = new WebSocketServer({
      host,
      port,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      verifyClient: ({ origin }: { origin: string }) => origin === allowedOrigin,
    })
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", (error) => {
        reject(
          new Error(
            `Browser bridge could not listen on ${host}:${port}: ${error.message}. Stop whatever holds that port or set tools.browser = false.`,
            { cause: error }
          )
        )
      })
    })
    server.on("error", (error) => log("error", "browser.bridge_failed", { err: error }))
    server.on("connection", (socket) => this.authenticate(socket))
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const call of [...this.pending.values()]) {
      call.reject(new BrowserBridgeError("EXTENSION_DISCONNECTED", "Shellby is shutting down."))
    }
    if (!server) return
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  browsers(): ConnectedBrowser[] {
    return [...this.connections.values()].map(({ id, name }) => ({ id, name }))
  }

  /** `browser` is a name or ID, and may be omitted only while one browser is connected. */
  call<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    browser?: string
  ): Promise<T> {
    let socket: WebSocket
    try {
      socket = this.select(browser).socket
    } catch (error) {
      return Promise.reject(error)
    }
    if (signal?.aborted) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId
      const settle = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this.pending.delete(id)
      }
      const onAbort = () => {
        settle()
        reject(abortError())
      }
      const timer = setTimeout(() => {
        settle()
        reject(new BrowserBridgeError("TIMEOUT", `Chrome did not answer ${method} in time.`))
      }, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS)
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        socket,
        resolve: (value) => {
          settle()
          // biome-ignore lint/nursery/noUnsafeTypeAssertion: each method's caller owns its result shape.
          resolve(value as T)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
      })
      socket.send(JSON.stringify({ type: "call", id, method, params }))
    })
  }

  /** Mutual HMAC challenge: the secret never crosses the socket, in either direction. */
  private authenticate(socket: WebSocket): void {
    const serverNonce = randomBytes(32).toString("hex")
    const timer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED), AUTH_TIMEOUT_MS)
    socket.on("error", (error) => log("warn", "browser.socket_failed", { err: error }))
    socket.once("close", () => clearTimeout(timer))
    socket.once("message", (data) => {
      clearTimeout(timer)
      const auth = authMessage.safeParse(parseJson(data))
      if (!auth.success || !this.proofMatches(auth.data.proof, `client:${serverNonce}`)) {
        log("warn", "browser.auth_rejected")
        socket.close(CLOSE_UNAUTHORIZED)
        return
      }
      const proof = this.hmac(`server:${serverNonce}:${auth.data.nonce}`)
      socket.send(JSON.stringify({ type: "authenticated", proof }))
      this.adopt({ id: auth.data.browser_id, name: auth.data.name, socket })
    })
    socket.send(JSON.stringify({ type: "challenge", nonce: serverNonce }))
  }

  private select(browser: string | undefined): BrowserConnection {
    const connected = [...this.connections.values()]
    if (connected.length === 0) {
      throw new BrowserBridgeError(
        "EXTENSION_DISCONNECTED",
        "The Shellby Chrome extension is not connected. Ask the user to open Chrome and pair the extension with `npm run browser:pair`."
      )
    }
    const names = connected.map(({ name }) => name).join(", ")
    if (browser === undefined) {
      const [only] = connected
      if (only && connected.length === 1) return only
      throw new BrowserBridgeError(
        "BROWSER_AMBIGUOUS",
        `Several browsers are connected (${names}). Pass browser.`
      )
    }
    const wanted = browser.toLowerCase()
    const matches = connected.filter(
      ({ id, name }) => id === browser || name.toLowerCase() === wanted
    )
    const [match] = matches
    if (match && matches.length === 1) return match
    throw new BrowserBridgeError(
      "UNKNOWN_BROWSER",
      `No single browser matches ${browser}. Connected: ${names}.`
    )
  }

  private adopt(connection: BrowserConnection): void {
    const { id, socket } = connection
    const previous = this.connections.get(id)
    this.connections.set(id, connection)
    if (previous) {
      this.rejectPending(previous.socket, "The Chrome extension reconnected.")
      previous.socket.close(CLOSE_REPLACED)
    }
    socket.on("message", (data) => this.receive(socket, data))
    socket.once("close", () => {
      if (this.connections.get(id)?.socket !== socket) return
      this.connections.delete(id)
      this.rejectPending(socket, "The Chrome extension disconnected.")
    })
    log("info", "browser.extension_connected")
  }

  private receive(socket: WebSocket, data: RawData): void {
    const message = resultMessage.safeParse(parseJson(data))
    if (!message.success) return // Keepalive pings carry no result.
    const call = this.pending.get(message.data.id)
    if (call?.socket !== socket) return
    if (message.data.ok) call.resolve(message.data.result)
    else {
      const { code = "EXTENSION_ERROR", message: text = "The extension reported a failure." } =
        message.data.error ?? {}
      call.reject(new BrowserBridgeError(code, text))
    }
  }

  private rejectPending(socket: WebSocket, reason: string): void {
    for (const call of [...this.pending.values()]) {
      if (call.socket === socket)
        call.reject(new BrowserBridgeError("EXTENSION_DISCONNECTED", reason))
    }
  }

  private hmac(value: string): string {
    return createHmac("sha256", this.options.secret).update(value).digest("hex")
  }

  private proofMatches(proof: string, value: string): boolean {
    const expected = Buffer.from(this.hmac(value))
    const actual = Buffer.from(proof)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
}

function abortError(): BrowserBridgeError {
  return new BrowserBridgeError("ABORTED", "The browser call was cancelled.")
}

function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(data.toString())
  } catch {
    return undefined
  }
}
