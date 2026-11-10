import process from "node:process"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { MCP_CONFIG } from "../src/config.js"
import { createMcpServerFactory } from "../src/mcp/server-factory.js"
import { startMcpHttpServer } from "../src/server/http-server.js"
import { countTokens, OUTPUT_TOKEN_ENCODING } from "../src/tokenizer.js"
import { BrowserBridge } from "../src/tools/browser/browser-bridge.js"
import { PeekabooClient } from "../src/tools/computer/peekaboo.js"
import { PeekabooXClient } from "../src/tools/computer/peekaboox.js"
import { createChatGptDelegationService } from "../src/tools/delegation/chatgpt-service.js"
import { createShellSession } from "../src/tools/shell/session.js"
import { createShellSessionManager } from "../src/tools/shell/session-manager.js"
import { WebPageOpener } from "../src/tools/web/web-open.js"

const requestedNames = new Set(process.argv.slice(2))
const shells = MCP_CONFIG.tools.shell
  ? createShellSessionManager({
      createShell: () => createShellSession({ cwd: MCP_CONFIG.workspace }),
    })
  : undefined
const peekaboo =
  MCP_CONFIG.tools.computer && process.platform === "darwin"
    ? new PeekabooClient({ localOnly: true })
    : undefined
const peekaboox =
  MCP_CONFIG.tools.computer && process.platform === "linux" ? new PeekabooXClient() : undefined
const chatGptDelegation =
  MCP_CONFIG.tools.clones || MCP_CONFIG.tools.subagents
    ? createChatGptDelegationService()
    : undefined
const webPageOpener = MCP_CONFIG.tools.web ? new WebPageOpener() : undefined
// Never started: listing schemas only needs the service to exist.
const browserBridge = MCP_CONFIG.tools.browser
  ? new BrowserBridge({
      host: MCP_CONFIG.host,
      port: 0,
      secret: "",
      allowedOrigin: MCP_CONFIG.browserBridge.extensionOrigin,
    })
  : undefined
const running = await startMcpHttpServer(
  {
    createMcpServer: createMcpServerFactory({
      shellManager: shells,
      peekaboo,
      peekaboox,
      chatGptDelegation,
      webPageOpener,
      browserBridge,
    }),
  },
  { port: 0 }
)
const client = new Client(
  { name: "shellby-mcp-schema-viewer", version: MCP_CONFIG.server.version },
  { versionNegotiation: { mode: "auto" } }
)
const transport = new StreamableHTTPClientTransport(new URL(running.url))

try {
  await client.connect(transport)
  const { tools } = await client.listTools()
  const selected =
    requestedNames.size === 0 ? tools : tools.filter((tool) => requestedNames.has(tool.name))

  if (requestedNames.size > 0) {
    const foundNames = new Set(selected.map((tool) => tool.name))
    const missing = [...requestedNames].filter((name) => !foundNames.has(name))
    if (missing.length > 0) {
      throw new Error(`Unknown tool${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`)
    }
  }

  const compactSchema = JSON.stringify(selected)
  process.stdout.write(
    `Token count (${OUTPUT_TOKEN_ENCODING}): ${countTokens(compactSchema)}\n\n${JSON.stringify(selected, null, 2)}\n`
  )
} finally {
  await client.close().catch(() => undefined)
  await running.close()
  await Promise.allSettled([
    shells?.close() ?? Promise.resolve(),
    peekaboo?.close() ?? Promise.resolve(),
    chatGptDelegation?.dispose() ?? Promise.resolve(),
  ])
}
