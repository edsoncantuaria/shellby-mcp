import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { createChatDelivery } from "./agent/chat-delivery.js"
import { createAgentObserver } from "./agent/observer.js"
import { ShellbyAuthStore } from "./auth/store.js"
import { MCP_CONFIG } from "./config.js"
import { log, startRuntimeLogging } from "./logging.js"
import { createMcpServerFactory } from "./mcp/server-factory.js"
import { McpAuditLogger } from "./server/audit/audit-log.js"
import { startMcpHttpServer } from "./server/http-server.js"
import { ensureTunnelSecret } from "./server/tunnel-secret.js"
import { BrowserBridge } from "./tools/browser/browser-bridge.js"
import { CursorHostManager } from "./tools/computer/cursor-host.js"
import { PeekabooClient } from "./tools/computer/peekaboo.js"
import { PeekabooXClient } from "./tools/computer/peekaboox.js"
import { createChatGptDelegationService } from "./tools/delegation/chatgpt-service.js"
import { createDelegationRouter } from "./tools/delegation/delegation-router.js"
import { createGeminiTabs } from "./tools/delegation/gemini-browser.js"
import { createGeminiDelegationService } from "./tools/delegation/gemini-service.js"
import { ExternalMcpManager } from "./tools/external-mcp/external-mcp-manager.js"
import { createShellSession } from "./tools/shell/session.js"
import { createShellSessionManager } from "./tools/shell/session-manager.js"
import { WebPageOpener } from "./tools/web/web-open.js"

const runtimeLogging = MCP_CONFIG.logging.enabled
  ? await startRuntimeLogging(MCP_CONFIG.stateDir)
  : undefined
log("info", "server.starting", { version: MCP_CONFIG.server.version })
const auditLogPath = fileURLToPath(new URL("../agent-commands.yaml", import.meta.url))
const auditLogger = new McpAuditLogger(auditLogPath)
const agentObserver = MCP_CONFIG.ui.enabled ? createAgentObserver() : undefined
const authStore = new ShellbyAuthStore(join(MCP_CONFIG.stateDir, "auth.json"))
await authStore.ensureState()
const computerBackend = MCP_CONFIG.tools.computer ? MCP_CONFIG.computerBackend : undefined
const peekaboo =
  computerBackend === "peekaboo" ? new PeekabooClient({ localOnly: true }) : undefined
const peekaboox = computerBackend === "peekaboox" ? new PeekabooXClient() : undefined
const webPageOpener = MCP_CONFIG.tools.web ? new WebPageOpener() : undefined
const externalMcp = MCP_CONFIG.tools.externalMcp
  ? new ExternalMcpManager(MCP_CONFIG.externalMcp.servers)
  : undefined
const browserBridge = MCP_CONFIG.tools.browser
  ? new BrowserBridge({
      host: MCP_CONFIG.host,
      port: MCP_CONFIG.browserBridge.port,
      secret: ensureTunnelSecret(MCP_CONFIG.browserBridge.secretFile, "Browser bridge secret"),
      allowedOrigin: MCP_CONFIG.browserBridge.extensionOrigin,
    })
  : undefined
const chatGptAgents =
  MCP_CONFIG.tools.clones || MCP_CONFIG.tools.subagents
    ? createChatGptDelegationService()
    : undefined
const geminiAgents = chatGptAgents && createGeminiDelegationService(createGeminiTabs())
const chatGptDelegation =
  chatGptAgents && geminiAgents && createDelegationRouter(chatGptAgents, geminiAgents)
const chatDelivery =
  agentObserver && chatGptDelegation
    ? createChatDelivery(agentObserver, chatGptDelegation)
    : undefined
const cursorHost =
  peekaboo && process.platform === "darwin"
    ? new CursorHostManager({ executable: MCP_CONFIG.peekaboo.cursorHostExecutable })
    : undefined
const cursorHostStarted = cursorHost?.start() ?? false

const shells = MCP_CONFIG.tools.shell
  ? createShellSessionManager({
      createShell: (initialState) =>
        createShellSession({ cwd: MCP_CONFIG.workspace, initialState }),
    })
  : undefined

let running: Awaited<ReturnType<typeof startMcpHttpServer>>
try {
  await shells?.startDefault()
  await browserBridge?.start()
  running = await startMcpHttpServer({
    createMcpServer: createMcpServerFactory({
      shellManager: shells,
      peekaboo,
      peekaboox,
      chatGptDelegation,
      geminiChat: geminiAgents,
      webPageOpener,
      externalMcp,
      browserBridge,
    }),
    auditLogger,
    authStore,
    agentObserver,
    chatDelivery,
  })
} catch (error) {
  log("fatal", "server.startup_failed", { err: error })
  await closeRuntimeServices()
  await runtimeLogging?.close()
  throw error
}
log("info", "server.started", { url: running.url, runtime_log: runtimeLogging?.path })
if (runtimeLogging) console.log(`Runtime log: ${runtimeLogging.path} (npm run logs:runtime)`)
console.log(`Local shell MCP server: ${running.url}`)
if (MCP_CONFIG.ui.enabled) console.log(`Agent dashboard: http://${running.host}:${running.port}/ui`)
console.log("Remote MCP authentication: trusted ChatGPT origin + bound OpenAI subject")
console.log(`Default workspace: ${MCP_CONFIG.workspace}`)
console.log(
  `Shell tools: ${shells ? `enabled (${MCP_CONFIG.shell.path}, max ${shells.maximumShells})` : "disabled"}`
)
console.log(`Agent MCP audit log: ${auditLogPath}`)
let computerStatus = "disabled"
if (peekaboo) computerStatus = `enabled via Peekaboo CLI (${MCP_CONFIG.peekaboo.executable})`
if (peekaboox) computerStatus = `enabled via PeekabooX (${MCP_CONFIG.peekaboox.executable})`
console.log(`Computer Use: ${computerStatus}`)
console.log(`External MCP servers: ${externalMcp?.serverNames.join(", ") ?? "none"}`)
console.log(
  `Chrome bridge: ${browserBridge ? `enabled on ${MCP_CONFIG.host}:${browserBridge.port}` : "disabled"}`
)
if (cursorHost) console.log(`Agent cursor: ${cursorHostStarted ? "enabled" : "disabled"}`)
console.log(
  `ChatGPT agents: ${chatGptDelegation ? `enabled via attach-only CDP ${MCP_CONFIG.chatGpt.cdpEndpoint}` : "disabled"}`
)

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  log("info", "server.stopping", { signal })
  console.log(`Received ${signal}; shutting down.`)
  try {
    await running.close()
  } finally {
    await closeRuntimeServices()
  }
}

async function closeRuntimeServices(): Promise<void> {
  const services = [
    ["shells", shells?.close()],
    ["peekaboo", peekaboo?.close()],
    ["delegation", chatGptDelegation?.dispose()],
    ["cursor", cursorHost?.close()],
    ["external_mcp", externalMcp?.close()],
    ["browser", browserBridge?.close()],
  ] as const
  const results = await Promise.allSettled(services.map(([, closing]) => closing))
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      log("error", "server.cleanup_failed", { service: services[index]?.[0], err: result.reason })
    }
  })
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(
      async () => {
        log("info", "server.stopped")
        await runtimeLogging?.close()
        process.exit(0)
      },
      async (error) => {
        log("fatal", "server.shutdown_failed", { err: error })
        await runtimeLogging?.close()
        console.error("Shutdown failed:", error)
        process.exit(1)
      }
    )
  })
}
