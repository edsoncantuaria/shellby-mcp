import { MCP_CONFIG } from "../src/config.js"
import { ensureTunnelSecret } from "../src/server/tunnel-secret.js"

const { port, secretFile } = MCP_CONFIG.browserBridge
const secret = ensureTunnelSecret(secretFile, "Browser bridge secret")
if (!MCP_CONFIG.tools.browser)
  console.warn("tools.browser is false: set it to true in .shellby/config.toml and restart.")
console.log("Paste this into the Shellby extension popup. Anyone holding it can drive the bridge.")
console.log(`shellby:${port}:${secret}`)
