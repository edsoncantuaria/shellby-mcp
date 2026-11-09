#!/usr/bin/env node
// Installs, checks, or removes the Shellby Desktop GNOME Shell extension for the
// current user. The extension is what lets Computer Use see and drive a GNOME
// Wayland session; see linux/README.md.
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("./gnome-extension", import.meta.url))
const helper = fileURLToPath(new URL("./shellby-desktop", import.meta.url))
const metadata = JSON.parse(readFileSync(join(source, "metadata.json"), "utf8"))
const uuid = metadata.uuid
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const target = join(dataHome, "gnome-shell", "extensions", uuid)
const mode = process.argv[2] ?? "--install"
const MAJOR_VERSION = /(\d+)/u
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
} else if (mode === "--uninstall") {
  run("gnome-extensions", ["disable", uuid])
  rmSync(target, { recursive: true, force: true })
  console.log(`Removed ${target}. Log out and back in to unload the extension.`)
} else if (mode === "--install") {
  install()
} else {
  fail("Usage: node linux/install-extension.mjs [--install | --status | --uninstall]")
}

function install() {
  const version = run("gnome-shell", ["--version"])
  const major = version.status === 0 ? version.stdout.match(MAJOR_VERSION)?.[1] : undefined
  if (!major) fail("GNOME Shell was not found. Shellby Desktop supports GNOME on Wayland only.")
  if (!metadata["shell-version"].includes(major)) {
    fail(
      `GNOME Shell ${major} is not in the extension's tested versions (${metadata["shell-version"].join(", ")}). ` +
        "Review linux/gnome-extension/extension.js against this Shell version and add it to metadata.json."
    )
  }
  const bindings = run("python3", [
    "-c",
    "import gi; gi.require_version('Atspi', '2.0'); gi.require_version('GdkPixbuf', '2.0'); import cairo",
  ])
  if (bindings.status !== 0) {
    fail(
      "Missing Python bindings. Install them with: sudo apt install python3-gi python3-gi-cairo gir1.2-atspi-2.0"
    )
  }

  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })
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
  console.log("Enabled. Log out and back in, then run: node linux/install-extension.mjs --status")
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
