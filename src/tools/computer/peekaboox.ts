import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { MCP_CONFIG } from "../../config.js"
import { encodeImageForMcp } from "../image/image-encoding.js"

const execFileAsync = promisify(execFile)

export class PeekabooXError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PeekabooXError"
  }
}

export interface PeekabooXClientOptions {
  executable?: string
  socketPath?: string
  baseArgs?: string[]
  timeoutMs?: number
}

/** Serialize desktop operations so separate MCP calls cannot interleave input actions. */
export class PeekabooXClient {
  private readonly executable: string
  private readonly socketPath: string
  private readonly baseArgs: string[]
  private readonly timeoutMs: number
  private tail: Promise<void> = Promise.resolve()

  constructor(options: PeekabooXClientOptions = {}) {
    this.executable = options.executable ?? MCP_CONFIG.peekaboox.executable ?? "peekaboox"
    this.socketPath = options.socketPath ?? MCP_CONFIG.peekaboox.socketPath
    this.baseArgs = options.baseArgs ?? []
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  run(args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.enqueue(async () => {
      const output = await this.execute(args, signal)
      return parseJsonObject(output)
    }, signal)
  }

  observe(
    args: string[],
    signal?: AbortSignal
  ): Promise<{
    metadata: Record<string, unknown>
    imageData: string
    mimeType: "image/jpeg"
  }> {
    return this.enqueue(async () => {
      const directory = await mkdtemp(join(tmpdir(), "shellby-peekaboox-"))
      try {
        const outputPath = join(directory, "capture.png")
        const output = await this.execute(
          ["capture", "--output", outputPath, "--json", ...args],
          signal
        )
        const metadata = parseJsonObject(output)
        const image = await encodeImageForMcp(await readFile(outputPath))
        return { metadata, imageData: image.data, mimeType: image.mimeType }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, signal)
  }

  private enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const running = this.tail.then(async () => {
      signal?.throwIfAborted()
      return work()
    })
    this.tail = running.then(
      () => undefined,
      () => undefined
    )
    return running
  }

  private async execute(args: string[], signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const { stdout } = await execFileAsync(
        this.executable,
        [...this.baseArgs, "--daemon", "--socket", this.socketPath, ...args],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal: combined }
      )
      return stdout
    } catch (error) {
      const detail = error instanceof Error ? error.message : JSON.stringify(error)
      if (combined.aborted) {
        throw new PeekabooXError(
          signal?.aborted ? "Computer Use request was cancelled." : "PeekabooX timed out.",
          { cause: error }
        )
      }
      throw new PeekabooXError(
        `PeekabooX failed: ${detail}. Check \`npm run status\`, \`npm run logs\`, and \`npm run setup:computer\`.`,
        { cause: error }
      )
    }
  }
}

function parseJsonObject(output: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    throw new PeekabooXError(`PeekabooX returned invalid JSON: ${output.slice(0, 300)}`, {
      cause: error,
    })
  }
  if (!isRecord(parsed)) {
    throw new PeekabooXError("PeekabooX returned an unexpected response.")
  }
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
