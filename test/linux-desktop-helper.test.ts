import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { tempDir } from "./helpers/temp.js"

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

function runPython(body: string) {
  const script = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("helper", ${JSON.stringify(helper)})
module = importlib.util.module_from_spec(importlib.util.spec_from_loader("helper", loader))
loader.exec_module(module)
${body}
`
  const result = spawnSync("python3", ["-B", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/shellby-test-bus" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test("text search prefers a field's content over a title that contains it", { skip }, () => {
  const found = runPython(`
elements = [
    {"id": "E1", "role": "panel", "label": "alfa beta", "interactive": False},
    {"id": "E2", "role": "text", "label": "", "value": "alfa beta", "interactive": True},
]
print(json.dumps(module.find_element({"elements": elements}, query="beta")["id"]))
`)
  assert.equal(found, "E2")
})

test("symbols on Shift+AltGr are planned with both modifiers held", { skip }, () => {
  const plan = runPython(`
class Key:
    def __init__(self, level): self.level, self.group = level, 0
levels = {0x7e: 3, 0x61: 0, 0xfe03: 2}
class Keymap:
    def get_entries_for_keyval(self, keyval):
        return (keyval in levels, [Key(levels[keyval])] if keyval in levels else [])
keyboard = object.__new__(module.Keyboard)
keyboard.group, keyboard.keymap = 0, Keymap()
print(json.dumps([keyboard.plan("~"), keyboard.plan("a"), keyboard.plan("日")]))
`)
  assert.deepEqual(plan, [[0x7e, [0xffe1, 0xfe03]], [0x61, []], null])
})

test("input fails instead of reporting success behind a system dialog", { skip }, () => {
  const codes = runPython(`
desktop = object.__new__(module.Desktop)
codes = []
for state in ('{"dialog": true, "locked": false}', '{"dialog": false, "locked": true}'):
    desktop.call = lambda method, parameters=None: state
    try:
        desktop.ensure_input_available()
    except module.Fail as failure:
        codes.append(failure.code)
desktop.call = lambda method, parameters=None: '{"dialog": false, "locked": false}'
desktop.ensure_input_available()
print(json.dumps(codes))
`)
  assert.deepEqual(codes, ["SYSTEM_DIALOG_ACTIVE", "SCREEN_LOCKED"])
})

test("borrowed focus hands focus and pointer back unless foreground", { skip }, () => {
  const calls = runPython(`
module.time.sleep = lambda seconds: None
class Fake:
    def __init__(self): self.log = []
    def windows(self): return [{"id": 1, "focused": True}, {"id": 2, "focused": False}]
    def pointer_position(self): return [5.0, 6.0]
    def pointer_warp(self, x, y): self.log.append(["warp", x, y])
    def focus(self, window): self.log.append(["focus", window["id"]])
    def window_action(self, window_id, action): self.log.append([action, window_id])
target = {"id": 2, "focused": False, "minimized": False}
background, foreground = Fake(), Fake()
with module.borrowed_focus(background, target, {}, restore_pointer=True):
    background.log.append(["act"])
with module.borrowed_focus(foreground, target, {"--foreground": True}, restore_pointer=True):
    foreground.log.append(["act"])
print(json.dumps([background.log, foreground.log]))
`)
  assert.deepEqual(calls, [
    [["focus", 2], ["act"], ["focus", 1], ["warp", 5, 6]],
    [["focus", 2], ["act"]],
  ])
})

test("text that never reaches its field is reported", { skip }, () => {
  const outcome = runPython(`
module.time.sleep = lambda seconds: None
ticks = iter(range(100))
module.time.monotonic = lambda: next(ticks)
module.field_length = lambda field: 3
results = []
for arguments in (("field", 3, "abc", False), ("field", 3, "abc\\n", False), ("field", 3, "abc", True)):
    try:
        module.confirm_delivery(*arguments)
        results.append("ok")
    except module.Fail as failure:
        results.append(failure.code)
print(json.dumps(results))
`)
  assert.deepEqual(outcome, ["INPUT_NOT_DELIVERED", "ok", "ok"])
})

test("OCR rows become text lines and a query aims at its words", { skip }, () => {
  const result = runPython(`
header = "level\\tpage\\tblock\\tpar\\tline\\tword\\tleft\\ttop\\twidth\\theight\\tconf\\ttext"
rows = [
    "5\\t1\\t1\\t1\\t1\\t1\\t10\\t20\\t30\\t10\\t90\\tNovo",
    "5\\t1\\t1\\t1\\t1\\t2\\t50\\t20\\t40\\t10\\t90\\tJogo",
    "5\\t1\\t1\\t1\\t1\\t3\\t99\\t20\\t40\\t10\\t10\\truido",
]
lines = module.parse_ocr("\\n".join([header, *rows]))
print(json.dumps([lines[0]["label"], module.narrow_to_words(lines[0], "jogo")["x"]]))
`)
  assert.deepEqual(result, ["Novo Jogo", 50])
})

test("installer enables and reverts accessibility on detected launchers", { skip }, async (t) => {
  const root = await tempDir(t, "shellby-launchers-")
  const applications = join(root, "applications")
  const runtime = join(root, "electron-app")
  await mkdir(applications, { recursive: true })
  await mkdir(runtime, { recursive: true })
  await writeFile(join(runtime, "chrome_100_percent.pak"), "")
  await writeFile(join(runtime, "app"), "binary", { mode: 0o755 })
  await writeFile(
    join(applications, "shellby-test-electron.desktop"),
    `[Desktop Entry]\nName=App\nExec=${join(runtime, "app")} %U\n`
  )
  const installer = fileURLToPath(new URL("../linux/install-extension.mjs", import.meta.url))
  const env = {
    ...process.env,
    XDG_DATA_HOME: root,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/shellby-test-bus",
  }
  const launcher = join(applications, "shellby-test-electron.desktop")

  assert.equal(spawnSync(process.execPath, [installer, "--launchers"], { env }).status, 0)
  assert.match(await readFile(launcher, "utf8"), /app --force-renderer-accessibility %U/u)

  assert.equal(spawnSync(process.execPath, [installer, "--uninstall"], { env }).status, 0)
  const restored = await readFile(launcher, "utf8")
  assert.doesNotMatch(restored, /force-renderer-accessibility|X-Shellby/u)
})
