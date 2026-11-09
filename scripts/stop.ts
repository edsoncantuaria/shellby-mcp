import { spawnSync } from "node:child_process"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
for (const args of [
  ["--import", "tsx", join(root, "scripts/pm2.ts"), "stop", "ecosystem.config.cjs"],
  ["--import", "tsx", join(root, "scripts/chatgpt/browser.mjs"), "--stop"],
  ["--import", "tsx", join(root, "scripts/pm2.ts"), "kill"],
]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
}
