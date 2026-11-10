#!/usr/bin/env node
// Installs, checks, or removes the Shellby Desktop GNOME Shell extension for the
// current user. The extension is what lets Computer Use see and drive a GNOME
// Wayland session; see linux/README.md.
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("./gnome-extension", import.meta.url))
const helper = fileURLToPath(new URL("./shellby-desktop", import.meta.url))
const metadata = JSON.parse(readFileSync(join(source, "metadata.json"), "utf8"))
const uuid = metadata.uuid
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const target = join(dataHome, "gnome-shell", "extensions", uuid)
const mode = process.argv[2] ?? "--install"
const applicationsDir = join(dataHome, "applications")
const ACCESSIBILITY_FLAG = "--force-renderer-accessibility"
const OVERRIDE_MARKER = "X-Shellby-Accessibility"
const GECKO_ACCESSIBILITY_ENV = "GNOME_ACCESSIBILITY=1"
const WEBENGINE_ENV = [
  "QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1",
  `QTWEBENGINE_CHROMIUM_FLAGS=${ACCESSIBILITY_FLAG}`,
]
const JAVA_BRIDGE_JAR = "/usr/share/java/java-atk-wrapper.jar"
const JAVA_BRIDGE_CLASS = "org.GNOME.Accessibility.AtkWrapper"
const JNI_DIRS = ["/usr/lib/x86_64-linux-gnu/jni", "/usr/lib/aarch64-linux-gnu/jni"]
const SYSTEM_APPLICATION_DIRS = [
  "/usr/share/applications",
  "/var/lib/snapd/desktop/applications",
  "/var/lib/flatpak/exports/share/applications",
  join(dataHome, "flatpak", "exports", "share", "applications"),
]
// Files that only Chromium-based programs ship next to their executable.
const CHROMIUM_FILES = ["chrome_100_percent.pak", "v8_context_snapshot.bin"]
const MAJOR_VERSION = /(\d+)/u
const EXEC_LINE = /^Exec=(.*)$/gmu
const EXEC_LINE_ONCE = /^Exec=(.*)$/mu
const JAVA_BRIDGE_ARGS =
  / -Xbootclasspath\/a:\S*java-atk-wrapper\S* -Dsun\.boot\.library\.path=\S+ -Djavax\.accessibility\.assistive_technologies=\S+/gu
const JBR_ENV_PREFIX = /^Exec=env "JAVA_TOOL_OPTIONS=[^"]*" /gmu
const NO_DISPLAY = /^NoDisplay=true$/mu
const GECKO_PROGRAM = /^(firefox|thunderbird|librewolf|zen)/u
const GECKO_APP_ID = /(firefox|thunderbird|librewolf|zen)/iu
const CHROMIUM_APP_ID = /(chrome|chromium|brave|edge|vivaldi|opera)/iu
const ELECTRON_SCRIPT = /electron|chrome-sandbox/iu
const ENTRY_HEADER = /^(\[Desktop Entry\])$/mu
const DESKTOP_SUFFIX = /\.desktop$/u
const MARKER_LINE = /^X-Shellby-Accessibility=.*\n/mu
const QUOTED_ITEM = /'([^']+)'/gu

if (mode === "--status") {
  const status = spawnSync(helper, ["permissions", "status", "--json"], { encoding: "utf8" })
  if (status.error) fail(`The Computer Use helper could not run: ${status.error.message}`)
  let summary
  try {
    summary = JSON.parse(status.stdout).summary
  } catch {
    fail(`The Computer Use helper failed: ${status.stderr.trim() || status.stdout.trim()}`)
  }
  console.log(`extension files: ${existsSync(target) ? target : "not installed"}`)
  console.log(summary)
} else if (mode === "--launchers") {
  const launchers = enableAccessibilityLaunchers()
  if (launchers.length > 0) console.log(`Accessibility enabled for: ${launchers.join(", ")}.`)
} else if (mode === "--uninstall") {
  run("gnome-extensions", ["disable", uuid])
  rmSync(target, { recursive: true, force: true })
  removeAccessibilityLaunchers()
  console.log(`Removed ${target}. Log out and back in to unload the extension.`)
} else if (mode === "--install") {
  install()
} else {
  fail("Usage: node linux/install-extension.mjs [--install | --status | --launchers | --uninstall]")
}

function install() {
  const version = run("gnome-shell", ["--version"])
  const major = version.status === 0 ? version.stdout.match(MAJOR_VERSION)?.[1] : undefined
  if (!major) fail("GNOME Shell was not found. Shellby Desktop supports GNOME on Wayland only.")
  if (
    !(metadata["shell-version"].includes(major) || process.argv.includes("--allow-untested-shell"))
  ) {
    fail(
      `GNOME Shell ${major} is not in the extension's tested versions (${metadata["shell-version"].join(", ")}). ` +
        "Review linux/gnome-extension/extension.js against this Shell version and add it to metadata.json, or install anyway with --allow-untested-shell."
    )
  }
  const bindings = run("python3", [
    "-c",
    "import gi; gi.require_version('Atspi', '2.0'); gi.require_version('Gdk', '3.0'); gi.require_version('GdkPixbuf', '2.0'); import cairo",
  ])
  if (bindings.status !== 0) {
    fail(
      "Missing Python bindings. Install them with: sudo apt install python3-gi python3-gi-cairo gir1.2-atspi-2.0 gir1.2-gtk-3.0"
    )
  }

  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })
  if (!metadata["shell-version"].includes(major)) {
    const installed = { ...metadata, "shell-version": [...metadata["shell-version"], major] }
    writeFileSync(join(target, "metadata.json"), `${JSON.stringify(installed, null, 2)}\n`)
  }
  console.log(`Installed ${uuid} to ${target}`)

  // A running Wayland shell only discovers new extensions at login, so
  // `gnome-extensions enable` can fail here; the settings key still takes effect.
  if (run("gnome-extensions", ["enable", uuid]).status !== 0) {
    const current = run("gsettings", ["get", "org.gnome.shell", "enabled-extensions"])
    if (current.status !== 0) fail(`Could not read enabled extensions: ${current.stderr.trim()}`)
    const enabled = [...current.stdout.matchAll(QUOTED_ITEM)].map((match) => match[1])
    if (!enabled.includes(uuid)) {
      const value = `[${[...enabled, uuid].map((item) => `'${item}'`).join(", ")}]`
      const updated = run("gsettings", ["set", "org.gnome.shell", "enabled-extensions", value])
      if (updated.status !== 0) fail(`Could not enable the extension: ${updated.stderr.trim()}`)
    }
  }
  const launchers = enableAccessibilityLaunchers()
  if (launchers.length > 0) {
    console.log(
      `Accessibility enabled for: ${launchers.join(", ")}. Reopen those apps to apply it.`
    )
  }
  console.log("Enabled. Log out and back in, then run: node linux/install-extension.mjs --status")
}

function enableAccessibilityLaunchers() {
  const changed = []
  for (const { name, path, text } of installedLaunchers()) {
    if (text.includes(OVERRIDE_MARKER)) continue
    const engine = launcherEngine(name, text)
    if (engine === "webengine") {
      const flags = WEBENGINE_ENV.map((item) => `--env=${item}`)
      if (run("flatpak", ["override", "--user", ...flags, appId(name)]).status === 0) {
        changed.push(appId(name))
      }
      continue
    }
    if (!engine) continue
    const edit = {
      chromium: withChromiumFlag,
      gecko: withGeckoEnvironment,
      java: withJavaBridge,
      jbr: withJetBrainsRuntimeBridge,
    }[engine]
    const origin = path === join(applicationsDir, name) ? "patched" : "copy"
    const flagged = text
      .replace(EXEC_LINE, (_line, command) => `Exec=${edit(command, name)}`)
      .replace(ENTRY_HEADER, `$1\n${OVERRIDE_MARKER}=${origin}`)
    mkdirSync(applicationsDir, { recursive: true })
    writeFileSync(join(applicationsDir, name), flagged)
    changed.push(appId(name))
  }
  return changed
}

function removeAccessibilityLaunchers() {
  for (const { name, path, text } of installedLaunchers()) {
    if (launcherEngine(name, text) === "webengine") {
      const unset = WEBENGINE_ENV.map((item) => `--unset-env=${item.split("=")[0]}`)
      run("flatpak", ["override", "--user", ...unset, appId(name)])
    }
    if (path !== join(applicationsDir, name)) continue
    if (text.includes(`${OVERRIDE_MARKER}=copy`)) rmSync(path)
    else if (text.includes(`${OVERRIDE_MARKER}=patched`)) {
      writeFileSync(
        path,
        text
          .replaceAll(` ${ACCESSIBILITY_FLAG}`, "")
          .replaceAll(`env ${GECKO_ACCESSIBILITY_ENV} `, "")
          .replaceAll(JAVA_BRIDGE_ARGS, "")
          .replace(JBR_ENV_PREFIX, "Exec=")
          .replace(MARKER_LINE, "")
      )
    }
  }
}

/** Every visible launcher, with the user's own copy taking precedence. */
function installedLaunchers() {
  const launchers = new Map()
  for (const directory of [applicationsDir, ...SYSTEM_APPLICATION_DIRS]) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (!name.endsWith(".desktop") || launchers.has(name) || !statSync(path).isFile()) continue
      const text = readFileSync(path, "utf8")
      if (!NO_DISPLAY.test(text) && EXEC_LINE_ONCE.test(text))
        launchers.set(name, { name, path, text })
    }
  }
  return [...launchers.values()]
}

/** Which accessibility switch a launcher's program needs, if any. */
function launcherEngine(name, text) {
  const tokens = text.match(EXEC_LINE_ONCE)[1].split(" ")
  const program = tokens[programIndex(tokens)]
  if (basename(program) === "flatpak") return flatpakEngine(appId(name))
  if (GECKO_PROGRAM.test(basename(program))) return "gecko"
  if (basename(program) === "java")
    return tokens.includes("-jar") && javaBridgeLibrary() ? "java" : undefined
  if (program.startsWith("/snap/bin/")) {
    if (existsSync(jetBrainsRuntimeLibraries(program)) && javaBridgeLibrary()) return "jbr"
    const found = run("find", [
      `/snap/${basename(program)}/current/`,
      "-maxdepth",
      "4",
      "-name",
      CHROMIUM_FILES[1],
      "-print",
      "-quit",
    ])
    return found.stdout.trim() ? "chromium" : undefined
  }
  const located = program.includes("/") ? program : run("which", [program]).stdout.trim()
  if (!(located && existsSync(located))) return
  const resolved = realpathSync(located)
  if (CHROMIUM_FILES.some((file) => existsSync(join(dirname(resolved), file)))) return "chromium"
  const head = readFileSync(resolved).subarray(0, 4096).toString("latin1")
  return head.startsWith("#!") && ELECTRON_SCRIPT.test(head) ? "chromium" : undefined
}

function flatpakEngine(id) {
  const manifest = run("flatpak", ["info", "--show-metadata", id]).stdout
  if (manifest.includes("qtwebengine")) return "webengine"
  if (manifest.includes("electronjs") || CHROMIUM_APP_ID.test(id)) return "chromium"
  return GECKO_APP_ID.test(id) ? "gecko" : undefined
}

function javaBridgeLibrary() {
  if (!existsSync(JAVA_BRIDGE_JAR)) return
  return JNI_DIRS.find((dir) => existsSync(join(dir, "libatk-wrapper.so")))
}

function appId(name) {
  return name.replace(DESKTOP_SUFFIX, "")
}

/** Index of the executable in a launcher command, past any `env VAR=value` prefix. */
function programIndex(tokens) {
  if (basename(tokens[0]) !== "env") return 0
  const index = tokens.findIndex((token, position) => position > 0 && !token.includes("="))
  return index === -1 ? 0 : index
}

function withChromiumFlag(command, name) {
  const tokens = command.split(" ")
  const program = programIndex(tokens)
  // Flatpak forwards to the app only what comes after the app ID.
  const after = basename(tokens[program]) === "flatpak" ? tokens.indexOf(appId(name)) : program
  tokens.splice((after === -1 ? program : after) + 1, 0, ACCESSIBILITY_FLAG)
  return tokens.join(" ")
}

// The bridge loads from the boot class path, so its library must be on the boot library path.
function withJavaBridge(command) {
  const tokens = command.split(" ")
  const program = programIndex(tokens)
  const runtimeLibraries = join(dirname(dirname(realpathSync(tokens[program]))), "lib")
  tokens.splice(
    program + 1,
    0,
    `-Xbootclasspath/a:${JAVA_BRIDGE_JAR}`,
    `-Dsun.boot.library.path=${runtimeLibraries}:${javaBridgeLibrary()}`,
    `-Djavax.accessibility.assistive_technologies=${JAVA_BRIDGE_CLASS}`
  )
  return tokens.join(" ")
}

function jetBrainsRuntimeLibraries(program) {
  return `/snap/${basename(program)}/current/jbr/lib`
}

// IDEs bundle their own runtime and take JVM options only from the environment.
function withJetBrainsRuntimeBridge(command) {
  const program = command.split(" ")[0]
  const options = [
    `-Xbootclasspath/a:${JAVA_BRIDGE_JAR}`,
    `-Dsun.boot.library.path=${jetBrainsRuntimeLibraries(program)}:${javaBridgeLibrary()}`,
    `-Djavax.accessibility.assistive_technologies=${JAVA_BRIDGE_CLASS}`,
  ].join(" ")
  return `env "JAVA_TOOL_OPTIONS=${options}" ${command}`
}

function withGeckoEnvironment(command) {
  if (basename(command.split(" ")[0]) !== "flatpak")
    return `env ${GECKO_ACCESSIBILITY_ENV} ${command}`
  return command.replace(" run ", ` run --env=${GECKO_ACCESSIBILITY_ENV} `)
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
