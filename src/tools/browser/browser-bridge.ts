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
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type BrowserCaller = Pick<BrowserBridge, "call">

/**
 * Loopback channel to the Shellby Chrome extension. It listens on its own port so the public
 * tunnel, which forwards to the MCP port, can never reach it. Tab scope and site approval are
 * enforced by the extension; this side only proves both ends hold the pairing secret.
 */
export class BrowserBridge {
  private readonly options: BrowserBridgeOptions
  private server: WebSocketServer | undefined
  private active: WebSocket | undefined
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
    this.rejectPending("Shellby is shutting down.")
    if (!server) return
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const socket = this.active
    if (!socket) {
      return Promise.reject(
        new BrowserBridgeError(
          "EXTENSION_DISCONNECTED",
          "The Shellby Chrome extension is not connected. Ask the user to open Chrome and pair the extension with `npm run browser:pair`."
        )
      )
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
      this.adopt(socket)
    })
    socket.send(JSON.stringify({ type: "challenge", nonce: serverNonce }))
  }

  private adopt(socket: WebSocket): void {
    const previous = this.active
    this.active = socket
    if (previous) {
      this.rejectPending("The Chrome extension reconnected.")
      previous.close(CLOSE_REPLACED)
    }
    socket.on("message", (data) => this.receive(data))
    socket.once("close", () => {
      if (this.active !== socket) return
      this.active = undefined
      this.rejectPending("The Chrome extension disconnected.")
    })
    log("info", "browser.extension_connected")
  }

  private receive(data: RawData): void {
    const message = resultMessage.safeParse(parseJson(data))
    if (!message.success) return // Keepalive pings carry no result.
    const call = this.pending.get(message.data.id)
    if (!call) return
    if (message.data.ok) call.resolve(message.data.result)
    else {
      const { code = "EXTENSION_ERROR", message: text = "The extension reported a failure." } =
        message.data.error ?? {}
      call.reject(new BrowserBridgeError(code, text))
    }
  }

  private rejectPending(reason: string): void {
    for (const call of [...this.pending.values()])
      call.reject(new BrowserBridgeError("EXTENSION_DISCONNECTED", reason))
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
