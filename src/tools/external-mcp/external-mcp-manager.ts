import { join } from "node:path"
import process from "node:process"
import type { CallToolResult, Tool, Transport } from "@modelcontextprotocol/client"
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { MCP_CONFIG } from "../../config.js"
import { createStoredAuthProvider } from "./external-mcp-oauth.js"

const STDERR_TAIL_CHARS = 4_000
const MAX_TOOL_LIST_PAGES = 100
const DESKTOP_SESSION_ENV = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
]

export type ExternalMcpServerConfig =
  | { command: string; args: string[]; cwd?: string; env: Record<string, string> }
  | { url: string }

export interface ExternalMcpManagerOptions {
  connectTimeoutMs?: number
  callTimeoutMs?: number
  loginDir?: string
}

export interface ExternalMcpToolList {
  instructions?: string
  tools: Tool[]
}

interface ExternalMcpConnection {
  client: Client
  ready: Promise<Client>
}

export function externalMcpLoginPath(
  server: string,
  loginDir = MCP_CONFIG.externalMcp.loginDir
): string {
  return join(loginDir, `${server}.json`)
}

/**
 * Own the configured MCP servers for the whole Shellby process.
 *
 * Each server connects on first use and is shared across conversations, because the applications
 * behind these servers hold one piece of live state. A server that exits or a remote connection
 * that breaks is reconnected by the next call; the call it interrupted is reported and never
 * replayed.
 */
export class ExternalMcpManager {
  readonly serverNames: string[]
  private readonly configs: ReadonlyMap<string, ExternalMcpServerConfig>
  private readonly connections = new Map<string, ExternalMcpConnection>()
  private readonly connectTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly loginDir: string
  private closed = false

  constructor(
    servers: Record<string, ExternalMcpServerConfig>,
    options: ExternalMcpManagerOptions = {}
  ) {
    this.configs = new Map(Object.entries(servers))
    this.serverNames = [...this.configs.keys()]
    this.connectTimeoutMs = options.connectTimeoutMs ?? MCP_CONFIG.externalMcp.connectTimeoutMs
    this.callTimeoutMs = options.callTimeoutMs ?? MCP_CONFIG.externalMcp.callTimeoutMs
    this.loginDir = options.loginDir ?? MCP_CONFIG.externalMcp.loginDir
  }

  async listTools(server: string, signal?: AbortSignal): Promise<ExternalMcpToolList> {
    return this.run(server, "tools/list", this.connectTimeoutMs, async (client) => {
      const tools: Tool[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: this.connectTimeoutMs,
          signal,
        })
        tools.push(...result.tools)
        cursor = result.nextCursor
        if (!cursor) return { instructions: client.getInstructions(), tools }
      }
      throw new Error("The server returned too many pages of tools.")
    })
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    return this.run(server, tool, this.callTimeoutMs, (client) =>
      client.callTool({ name: tool, arguments: args }, { timeout: this.callTimeoutMs, signal })
    )
  }

  async close(): Promise<void> {
    this.closed = true
    const open = [...this.connections.values()]
    this.connections.clear()
    await Promise.allSettled(open.map(({ client }) => client.close()))
  }

  private async run<T>(
    server: string,
    operation: string,
    timeoutMs: number,
    action: (client: Client) => Promise<T>
  ): Promise<T> {
    const client = await this.connect(server)
    try {
      return await action(client)
    } catch (error) {
      if (this.isBrokenRemoteConnection(server, error)) this.reconnectLater(server, client)
      throw describeCallFailure(server, operation, timeoutMs, error)
    }
  }

  /** An HTTP session has no process to watch, so a transport failure is the only signal it died. */
  private isBrokenRemoteConnection(server: string, error: unknown): boolean {
    const config = this.configs.get(server)
    if (!config || !("url" in config) || error instanceof ProtocolError) return false
    return !(error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout)
  }

  private reconnectLater(server: string, client: Client): void {
    if (this.connections.get(server)?.client === client) this.connections.delete(server)
    void client.close().catch(() => undefined)
  }

  private connect(server: string): Promise<Client> {
    const existing = this.connections.get(server)
    if (existing) return existing.ready
    const config = this.configs.get(server)
    if (!config) throw new Error(`External MCP server "${server}" is not configured.`)
    if (this.closed) throw new Error("External MCP servers are shutting down.")

    const client = new Client(
      { name: MCP_CONFIG.server.name, version: MCP_CONFIG.server.version },
      { capabilities: {} }
    )
    let stderrTail = ""
    const transport = this.createTransport(server, config, (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS)
    })

    const forget = () => {
      if (this.connections.get(server) === connection) this.connections.delete(server)
    }
    const connection: ExternalMcpConnection = {
      client,
      ready: client.connect(transport, { timeout: this.connectTimeoutMs }).then(
        () => client,
        async (error: unknown) => {
          forget()
          await client.close().catch(() => undefined)
          throw describeStartFailure(server, error, stderrTail)
        }
      ),
    }
    client.onclose = forget
    this.connections.set(server, connection)
    return connection.ready
  }

  private createTransport(
    server: string,
    config: ExternalMcpServerConfig,
    onStderr: (chunk: string) => void
  ): Transport {
    if ("url" in config) {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: createStoredAuthProvider(
          externalMcpLoginPath(server, this.loginDir),
          config.url
        ),
      })
    }
    // The SDK passes only a safe default environment, so Shellby's own secrets stay out of the child.
    // Applications such as Blender and Godot still need the desktop session to open a window.
    const transport = new StdioClientTransport({
      ...config,
      env: { ...desktopSessionEnv(), ...config.env },
      stderr: "pipe",
    })
    transport.stderr?.on("data", (chunk: Buffer | string) => onStderr(chunk.toString()))
    return transport
  }
}

function desktopSessionEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of DESKTOP_SESSION_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function needsLogin(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpAuthentication)
  )
}

function loginRequiredError(server: string, error: unknown): Error {
  return new Error(
    `External MCP server "${server}" needs a login. Ask the user to run \`npm run mcp:login -- ${server}\` in the Shellby folder, then call again.`,
    { cause: error }
  )
}

function describeStartFailure(server: string, error: unknown, stderrTail: string): Error {
  if (needsLogin(error)) return loginRequiredError(server, error)
  const stderr = stderrTail.trim()
  return new Error(
    `External MCP server "${server}" failed to start: ${errorMessage(error)}${stderr ? `\n\nServer stderr:\n${stderr}` : ""}`,
    { cause: error }
  )
}

function describeCallFailure(
  server: string,
  tool: string,
  timeoutMs: number,
  error: unknown
): Error {
  if (needsLogin(error)) return loginRequiredError(server, error)
  const call = `External MCP call ${server}/${tool}`
  if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
    return new Error(
      `${call} did not finish within ${Math.round(timeoutMs / 1_000)} seconds. It may still be running, so check the application's state before retrying.`,
      { cause: error }
    )
  }
  if (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed) {
    return new Error(
      `${call} lost its server before finishing, so its outcome is unknown. The server starts again on the next call; check the application's state before retrying.`,
      { cause: error }
    )
  }
  return new Error(`${call} failed: ${errorMessage(error)}`, { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
