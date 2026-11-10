import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { createServer, type Server as HttpServer } from "node:http"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler } from "@modelcontextprotocol/server"
import type { Request, Response } from "express"
import type { ChatDelivery } from "../agent/chat-delivery.js"
import { runWithAgent } from "../agent/context.js"
import { createDashboardRouter } from "../agent/dashboard-routes.js"
import type { AgentObserver } from "../agent/observer.js"
import { ShellbyAuthError, type ShellbyAuthStore } from "../auth/store.js"
import { MCP_CONFIG } from "../config.js"
import { log, withLogContext } from "../logging.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import { asRecord } from "../utils.js"
import type { McpAuditLogger, McpAuditRequest } from "./audit/audit-log.js"
import { ensureTunnelSecret } from "./tunnel-secret.js"

const MCP_ROUTE = /^\/mcp$/u

interface RequestRuntimeContext {
  auditRequest?: McpAuditRequest
}

export interface RunningMcpServer {
  host: string
  port: number
  url: string
  tunnelPort?: number
  close: () => Promise<void>
}

export interface McpHttpServices {
  createMcpServer: McpServerFactory
  auditLogger?: McpAuditLogger
  authStore?: ShellbyAuthStore
  agentObserver?: AgentObserver
  chatDelivery?: ChatDelivery
}

export interface McpHttpProfileOverrides {
  host?: string
  port?: number
  instanceId?: string
  tunnel?: { port: number; secretFile: string } | false
  authMode?: "chatgpt" | "hybrid"
}

export async function startMcpHttpServer(
  services: McpHttpServices,
  profileOverrides: McpHttpProfileOverrides = {}
): Promise<RunningMcpServer> {
  const host = profileOverrides.host ?? MCP_CONFIG.host
  const port = profileOverrides.port ?? MCP_CONFIG.port
  const instanceId = profileOverrides.instanceId ?? MCP_CONFIG.instanceId
  const authMode = profileOverrides.authMode ?? MCP_CONFIG.auth.mode
  const tunnel =
    profileOverrides.tunnel ??
    (port !== 0 && MCP_CONFIG.cloudflared.enabled
      ? { port: MCP_CONFIG.cloudflared.originPort, secretFile: MCP_CONFIG.cloudflared.secretFile }
      : false)
  const { createMcpServer, auditLogger, authStore, agentObserver, chatDelivery } = services
  const requestRuntime = new AsyncLocalStorage<RequestRuntimeContext>()

  const app = createMcpExpressApp({ host, jsonLimit: "1mb" })
  const mcpHandler = createMcpHandler(
    () => {
      const requestContext = requestRuntime.getStore()
      return createMcpServer({
        auditRequest: requestContext?.auditRequest,
        agentObserver,
      })
    },
    {
      legacy: "stateless",
      onerror: reportMcpError,
    }
  )
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: reportMcpError })

  app.get("/healthz", (_req, res) => {
    res.setHeader("x-shellby-instance", instanceId)
    res.json({ ok: true })
  })

  if (agentObserver) app.use("/ui", createDashboardRouter(agentObserver, chatDelivery))

  const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = requestSessionId(req)
    await runWithAgent(sessionId, async () => {
      const auditRequest = auditLogger?.startRequest(req.body)
      let auditFinished = false
      const finishAudit = (state: "finished" | "closed") => {
        if (auditFinished) return
        auditFinished = true
        auditRequest?.finishTransport({ httpStatus: res.statusCode, state })
      }
      res.once("finish", () => finishAudit("finished"))
      res.once("close", () => finishAudit("closed"))

      await requestRuntime.run({ auditRequest }, () => nodeMcpHandler(req, res, req.body))
    })
  }

  app.all(MCP_ROUTE, async (req: Request, res: Response) => {
    if (
      req.method === "POST" &&
      authStore &&
      isTrustedRemoteRequest(req) &&
      containsToolCall(req.body)
    ) {
      try {
        await authStore.authorizeToolCall({
          openaiSubject: req.get("x-openai-subject"),
          tunnelAuth: req.get("x-shellby-tunnel-auth") === "1",
          mode: authMode,
        })
      } catch (error) {
        remoteAuthError(res, error)
        return
      }
    }
    await handleMcpRequest(req, res)
  })

  const httpServer = createServer((req, res) => {
    // A Cloudflare hostname accidentally pointed at the local listener must not bypass the secret route.
    if (tunnel && req.headers["cf-connecting-ip"]) {
      res.writeHead(404).end()
      return
    }
    if (req.url?.split("?")[0] !== "/mcp") return app(req, res)
    const requestId = randomUUID()
    withLogContext({ request_id: requestId }, () => {
      const started = performance.now()
      log("info", "http.started", { method: req.method })
      res.once("close", () => {
        log(res.writableFinished && res.statusCode < 400 ? "info" : "warn", "http.finished", {
          request_id: requestId,
          http_status: res.statusCode,
          outcome: res.writableFinished ? "finished" : "disconnected",
          duration_ms: Math.round(performance.now() - started),
        })
      })
      app(req, res)
    })
  })
  let boundPort: number
  let tunnelServer: HttpServer | undefined
  let tunnelPort: number | undefined
  try {
    await listen(httpServer, port, host)

    const address = httpServer.address()
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address.")
    }
    boundPort = address.port
    if (tunnel) {
      const secret = ensureTunnelSecret(tunnel.secretFile)
      tunnelServer = createServer((req, res) => {
        const [path, query] = (req.url ?? "").split("?", 2)
        log("info", "tunnel.inbound", {
          method: req.method,
          path,
          userAgent: req.headers["user-agent"],
          hasSecret: path === `/${secret}/mcp`,
        })
        if (path !== `/${secret}/mcp`) {
          res.writeHead(404).end()
          return
        }
        if (req.method === "HEAD") {
          res.writeHead(204, { "x-shellby-instance": instanceId }).end()
          return
        }
        req.url = `/mcp${query === undefined ? "" : `?${query}`}`
        req.headers.host = `${host}:${boundPort}`
        req.headers["x-shellby-remote"] = "1"
        req.headers["x-shellby-tunnel-auth"] = "1"
        app(req, res)
      })
      await listen(tunnelServer, tunnel.port, host)
      const tunnelAddress = tunnelServer.address()
      if (!tunnelAddress || typeof tunnelAddress === "string")
        throw new Error("Cloudflare origin did not expose a TCP address.")
      tunnelPort = tunnelAddress.port
    }
  } catch (error) {
    const httpClose = closeHttpServerIfListening(httpServer)
    await Promise.allSettled([
      mcpHandler.close(),
      httpClose,
      ...(tunnelServer ? [closeHttpServerIfListening(tunnelServer)] : []),
    ])
    throw error
  }

  let closed = false
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}/mcp`,
    tunnelPort,
    close: async () => {
      if (closed) return
      closed = true
      const results = await Promise.allSettled([
        mcpHandler.close(),
        closeHttpServerIfListening(httpServer),
        ...(tunnelServer ? [closeHttpServerIfListening(tunnelServer)] : []),
      ])
      for (const result of results) {
        if (result.status === "rejected")
          log("error", "http.cleanup_failed", { err: result.reason })
      }
    },
  }
}

function containsToolCall(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload]
  return requests.some((value) => {
    const request = asRecord(value)
    if (request?.method !== "tools/call") return false
    const params = asRecord(request.params)
    return typeof params?.name === "string" && params.name.length > 0
  })
}

function isTrustedRemoteRequest(req: Request): boolean {
  return req.get("x-shellby-remote") === "1"
}

function requestSessionId(req: Request): string | undefined {
  const value =
    req.get("mcp-session-id")?.trim() ??
    req.get("x-openai-session")?.trim() ??
    req.get("x-gemini-session")?.trim()
  return value || undefined
}

function reportMcpError(error: Error): void {
  log("error", "mcp.transport_failed", { err: error })
  console.error("MCP handler error:", error)
}

function remoteAuthError(res: Response, error: unknown): void {
  log("warn", "auth.rejected", { err: error })
  if (error instanceof ShellbyAuthError) {
    if (error.code === "subject_missing" || error.code === "subject_mismatch") {
      jsonRpcError(res, 403, -32002, "Remote MCP access denied.")
      return
    }
    jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
    return
  }

  console.error("Remote MCP authentication failed:", error)
  jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  })
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function closeHttpServerIfListening(server: HttpServer): Promise<void> {
  return server.listening ? closeHttpServer(server) : Promise.resolve()
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
