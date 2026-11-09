import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import process from "node:process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const helper = fileURLToPath(new URL("../linux/shellby-desktop", import.meta.url))
const bindings = spawnSync("python3", [
  "-c",
  "import gi; gi.require_version('Atspi', '2.0'); gi.require_version('GdkPixbuf', '2.0')",
])
const skip =
  process.platform !== "linux" || bindings.status !== 0
    ? "requires Linux with python3-gi and AT-SPI bindings"
    : false

function runWithoutDesktop(args: string[]) {
  const result = spawnSync(helper, [...args, "--no-remote", "--json"], {
    encoding: "utf8",
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/shellby-test-bus" },
  })
  return { status: result.status, envelope: JSON.parse(result.stdout) }
}

test("desktop helper reports an unreachable session as a Peekaboo error envelope", { skip }, () => {
  const { status, envelope } = runWithoutDesktop(["see", "--mode", "frontmost"])
  assert.equal(status, 1)
  assert.equal(envelope.success, false)
  assert.equal(envelope.error.code, "SESSION_BUS_UNAVAILABLE")
  assert.equal(typeof envelope.error.message, "string")
})

test("desktop helper rejects unknown commands before touching the desktop", { skip }, () => {
  const unknown = runWithoutDesktop(["teleport"])
  assert.equal(unknown.status, 1)
  assert.equal(unknown.envelope.error.code, "INVALID_ARGUMENTS")
})

test("desktop helper permission status names the missing extension", { skip }, () => {
  const { status, envelope } = runWithoutDesktop(["permissions", "status", "--all-sources"])
  assert.equal(status, 0)
  assert.equal(envelope.data.desktop_extension, "SESSION_BUS_UNAVAILABLE")
  assert.equal(envelope.data.accessibility, "unavailable")
  assert.match(envelope.summary, /install-extension\.mjs/u)
})
