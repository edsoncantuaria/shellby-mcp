import process from "node:process"
import { MCP_CONFIG } from "../src/config.js"
import { externalMcpLoginPath } from "../src/tools/external-mcp/external-mcp-manager.js"
import { loginExternalMcpServer } from "../src/tools/external-mcp/external-mcp-oauth.js"

const remoteServers = Object.entries(MCP_CONFIG.externalMcp.servers).flatMap(
  ([serverName, config]) => ("url" in config ? [{ name: serverName, url: config.url }] : [])
)
const name = process.argv[2]
const server = remoteServers.find((candidate) => candidate.name === name)

if (!server) {
  const available = remoteServers.map((candidate) => candidate.name).join(", ") || "none"
  console.error(`Usage: npm run mcp:login -- <server>\nRemote MCP servers: ${available}`)
  process.exit(1)
}

try {
  await loginExternalMcpServer({
    url: server.url,
    storePath: externalMcpLoginPath(server.name),
    onAuthorizationUrl: (url) => {
      console.log(`Open this URL to sign in to "${server.name}":\n\n${url}\n`)
    },
  })
  console.log(`Signed in to "${server.name}". A running Shellby uses this login on its next call.`)
} catch (error) {
  console.error(`Login failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
