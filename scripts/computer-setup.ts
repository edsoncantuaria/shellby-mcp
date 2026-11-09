import { spawnSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath } from "node:url"

if (process.platform === "darwin") {
  const script = fileURLToPath(new URL("./peekaboo-permissions.mjs", import.meta.url))
  const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
    stdio: "inherit",
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else if (
  process.platform === "linux" &&
  (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").includes("GNOME")
) {
  const script = fileURLToPath(new URL("../linux/install-extension.mjs", import.meta.url))
  const statusOnly = process.argv.includes("--status")
  const result = spawnSync(process.execPath, [script, statusOnly ? "--status" : "--install"], {
    stdio: "inherit",
  })
  if (result.error) throw result.error
  process.exitCode = process.argv.includes("--optional") ? 0 : (result.status ?? 1)
} else if (process.platform === "linux") {
  const result = spawnSync("peekaboox", ["doctor", "--json"], { encoding: "utf8" })
  if (result.error || result.status !== 0) {
    console.error(
      "PeekabooX doctor could not run. Install PeekabooX 1.1.2+ or disable tools.computer."
    )
    if (result.stderr) console.error(result.stderr.trim())
    process.exitCode = process.argv.includes("--optional") ? 0 : 1
  } else {
    const report: unknown = JSON.parse(result.stdout)
    const categories = isRecord(report) && Array.isArray(report.categories) ? report.categories : []
    const checks = isRecord(report) && Array.isArray(report.checks) ? report.checks : []
    for (const category of categories) {
      if (isRecord(category)) console.log(`${category.name}: ${category.status}`)
    }
    for (const check of checks) {
      if (isRecord(check) && check.status !== "ok") console.log(`${check.name}: ${check.detail}`)
    }
    console.log(
      "PeekabooX on Wayland may need portal screen sharing, wtype for text, and ydotool for hotkeys/scrolling. Re-run this diagnostic after installing them."
    )
  }
} else {
  console.error("Computer Use supports macOS and Linux only.")
  process.exitCode = 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
