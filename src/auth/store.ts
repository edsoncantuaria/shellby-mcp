import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"

import { isRecord } from "../utils.js"

const AUTH_STATE_VERSION = 2

export interface ShellbyAuthState {
  version: typeof AUTH_STATE_VERSION
  /** ChatGPT subjects allowed to make remote tool calls. */
  subjects: string[]
  /** Unknown subjects that may still bind; each binding consumes one slot. */
  openSlots: number
}

export type ShellbyAuthErrorCode =
  | "state_missing"
  | "state_invalid"
  | "subject_missing"
  | "subject_mismatch"

export interface AuthorizeToolCallOptions {
  openaiSubject?: string
  tunnelAuth?: boolean
  mode?: "chatgpt" | "hybrid"
}

export class ShellbyAuthError extends Error {
  constructor(
    readonly code: ShellbyAuthErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ShellbyAuthError"
  }
}

export class ShellbyAuthStore {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string) {}

  async ensureState(): Promise<ShellbyAuthState> {
    return this.withMutation(async () => {
      try {
        return await this.readState()
      } catch (error) {
        if (!(error instanceof ShellbyAuthError) || error.code !== "state_missing") throw error
      }

      const state = unboundState()
      await ensurePrivateDirectory(dirname(this.filePath))
      try {
        await writeFile(this.filePath, serializeState(state), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        })
        await chmod(this.filePath, 0o600)
        return state
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error
        return this.readState()
      }
    })
  }

  async readState(): Promise<ShellbyAuthState> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        // biome-ignore lint/style/useErrorCause: ShellbyAuthError accepts ErrorOptions as its third argument and forwards the cause to Error.
        throw new ShellbyAuthError(
          "state_missing",
          "Shellby MCP authentication state is missing.",
          {
            cause: error,
          }
        )
      }
      throw error
    }

    const state = parseState(raw)
    await ensurePrivateDirectory(dirname(this.filePath))
    await chmod(this.filePath, 0o600)
    return state
  }

  async authorizeToolCall(
    subjectOrOptions: string | undefined | AuthorizeToolCallOptions
  ): Promise<ShellbyAuthState> {
    const { openaiSubject, tunnelAuth, mode } =
      typeof subjectOrOptions === "object" && subjectOrOptions !== null
        ? {
            openaiSubject: subjectOrOptions.openaiSubject,
            tunnelAuth: Boolean(subjectOrOptions.tunnelAuth),
            mode: subjectOrOptions.mode ?? "hybrid",
          }
        : {
            openaiSubject: subjectOrOptions,
            tunnelAuth: false,
            mode: "chatgpt" as const,
          }

    if (isValidSubject(openaiSubject)) {
      return this.withMutation(async () => {
        const state = await this.readState()
        if (state.subjects.includes(openaiSubject)) return state
        if (state.openSlots === 0) {
          throw new ShellbyAuthError(
            "subject_mismatch",
            "This Shellby MCP installation is bound to a different ChatGPT user."
          )
        }
        const boundState: ShellbyAuthState = {
          ...state,
          subjects: [...state.subjects, openaiSubject],
          openSlots: state.openSlots - 1,
        }
        await writeStateAtomically(this.filePath, boundState)
        return boundState
      })
    }

    if (mode === "hybrid" && tunnelAuth) {
      return this.readState()
    }

    throw new ShellbyAuthError(
      "subject_missing",
      "OpenAI subject is required for remote tool calls."
    )
  }

  /** Let one more unknown ChatGPT subject bind on its next remote tool call. */
  async openSlot(): Promise<ShellbyAuthState> {
    return this.withMutation(async () => {
      const state = await this.readState()
      const opened: ShellbyAuthState = { ...state, openSlots: state.openSlots + 1 }
      await writeStateAtomically(this.filePath, opened)
      return opened
    })
  }

  async reset(): Promise<ShellbyAuthState> {
    return this.withMutation(async () => {
      const state = unboundState()
      await writeStateAtomically(this.filePath, state)
      return state
    })
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function parseState(raw: string): ShellbyAuthState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw invalidState("Shellby MCP authentication state is malformed.", error)
  }

  if (!isRecord(parsed)) {
    throw invalidState("Shellby MCP authentication state must be an object.")
  }
  const state = parsed
  if (state.version === 1) {
    // Version 1 stored a single subject; null meant the first caller could still bind.
    const subject = state.subject
    if (subject === null) return unboundState()
    if (!isValidSubject(subject)) {
      throw invalidState("Shellby MCP authentication subject is invalid.")
    }
    return { version: AUTH_STATE_VERSION, subjects: [subject], openSlots: 0 }
  }
  if (state.version !== AUTH_STATE_VERSION) {
    throw invalidState("Shellby MCP authentication state version is unsupported.")
  }
  const { subjects, openSlots } = state
  if (
    !Array.isArray(subjects) ||
    !subjects.every(isValidSubject) ||
    new Set(subjects).size !== subjects.length
  ) {
    throw invalidState("Shellby MCP authentication subjects are invalid.")
  }
  if (typeof openSlots !== "number" || !Number.isSafeInteger(openSlots) || openSlots < 0) {
    throw invalidState("Shellby MCP authentication open slots are invalid.")
  }
  return { version: AUTH_STATE_VERSION, subjects, openSlots }
}

function unboundState(): ShellbyAuthState {
  return { version: AUTH_STATE_VERSION, subjects: [], openSlots: 1 }
}

async function writeStateAtomically(filePath: string, state: ShellbyAuthState): Promise<void> {
  const directory = dirname(filePath)
  await ensurePrivateDirectory(directory)
  const temporaryPath = join(directory, `.auth-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(temporaryPath, serializeState(state), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

function serializeState(state: ShellbyAuthState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isValidSubject(subject: unknown): subject is string {
  return typeof subject === "string" && subject.length > 0 && subject.length <= 512
}

function invalidState(message: string, cause?: unknown): ShellbyAuthError {
  return new ShellbyAuthError("state_invalid", message, cause === undefined ? undefined : { cause })
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
