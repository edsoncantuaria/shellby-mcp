import { spawn, spawnSync } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { MCP_CONFIG } from "../../src/config.ts"

const setup = process.argv.includes("--setup")
const auto = process.argv.includes("--auto")
const optional = process.argv.includes("--optional")
const stop = process.argv.includes("--stop")
const endpoint = new URL(MCP_CONFIG.chatGpt.cdpEndpoint)
const profileDir = join(MCP_CONFIG.stateDir, "chatgpt-chrome")
const markerPath = join(profileDir, ".configured")
// Chrome's own desktop user agent keeps ChatGPT on the web app whose turn protocol
// Shellby observes; a mobile user agent is served a different mobile-web surface.
const compactWindowSize = "430,900"
const configured = await exists(markerPath)
let cdpReady = await isCdpReady(endpoint)
if (stop) {
  const pid = findManagedChromePid()
  if (pid) {
    process.kill(pid, "SIGTERM")
    console.log(`Stopped Shellby Chrome (PID ${pid}).`)
  } else console.log("Shellby Chrome: not running")
  process.exit(0)
}

if (!isLocalEndpoint(endpoint)) {
  console.log(`ChatGPT browser: using configured CDP endpoint ${endpoint.href}`)
  process.exit(0)
}

const outdatedChrome = cdpReady ? findManagedChrome() : undefined
if (outdatedChrome?.command.includes(" --user-agent=")) {
  // Started by an older Shellby with the mobile user agent: relaunch it below.
  process.kill(outdatedChrome.pid, "SIGTERM")
  if (await isPortStillOccupied(endpoint)) {
    fail("Shellby Chrome did not stop for its relaunch. Close it and retry.")
  }
  console.log("ChatGPT browser: relaunching without the mobile user agent")
  cdpReady = false
}

if (cdpReady && !findManagedChromePid()) {
  fail(
    `CDP endpoint ${endpoint.href} is already in use by another Chrome profile. Give this copy a different chatgpt.cdp_endpoint port or close that browser first.`
  )
}
if (!cdpReady && (await isPortStillOccupied(endpoint))) {
  fail(
    `CDP port ${endpoint.port} is occupied by a process that is not serving Chrome DevTools. Change chatgpt.cdp_endpoint or stop that process.`
  )
}

if (!setup && !configured) {
  let message
  if (cdpReady) message = "ChatGPT browser: existing CDP session detected (not managed by setup)"
  else if (auto)
    message = "ChatGPT browser: not configured (run `npm run setup:chatgpt` to enable subagents)"
  else message = "ChatGPT browser is not configured. Run `npm run setup:chatgpt` first."
  console.log(message)
  process.exit(0)
}

if (cdpReady) {
  if (setup && !configured) {
    fail(
      `${endpoint.host} is already serving a Chrome DevTools session. Close that debug Chrome or configure a different chatgpt.cdp_endpoint before setup.`
    )
  }
  if (process.platform === "darwin") {
    if (auto) hideManagedChrome()
    else showManagedChrome()
  }
  console.log("ChatGPT browser: already running")
  if (setup) console.log("Sign into ChatGPT in that dedicated Chrome window if needed.")
  process.exit(0)
}

const chrome = await findChrome()
if (!chrome) {
  const message = MCP_CONFIG.chatGpt.browserExecutable
    ? `Configured Chrome executable ${JSON.stringify(MCP_CONFIG.chatGpt.browserExecutable)} is missing or not executable.`
    : "Chrome/Chromium was not found. Set chatgpt.browser_executable to its absolute path."
  if (auto || optional) {
    console.warn(`ChatGPT browser: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

await mkdir(profileDir, { recursive: true })
const port = endpoint.port
const child = spawn(
  chrome,
  [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    ...(process.platform === "linux" && process.env.WAYLAND_DISPLAY
      ? ["--ozone-platform=wayland"]
      : []),
    `--user-data-dir=${profileDir}`,
    `--window-size=${compactWindowSize}`,
    "--force-dark-mode", // Enables dark mode for Chrome UI
    "--enable-features=WebUIDarkMode", // Enables WebUI dark mode flag
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-breakpad",
    "--no-first-run",
    "--no-default-browser-check",
    MCP_CONFIG.chatGpt.projectUrl,
  ],
  { detached: true, stdio: "ignore" }
)
child.unref()

if (!(await waitForCdp(endpoint))) {
  const locked = await exists(join(profileDir, "SingletonLock"))
  const message = locked
    ? `Chrome did not expose CDP at ${endpoint.href}; profile ${profileDir} is locked. Close the other Chrome process using this profile and retry.`
    : `Chrome launched but CDP did not become available at ${endpoint.href}. Check the graphical session, browser executable, and Chrome logs.`
  if (auto || optional) {
    console.warn(`ChatGPT browser: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

await writeFile(markerPath, "configured\n", "utf8")
if (auto && process.platform === "darwin") hideManagedChrome()
console.log("ChatGPT browser: running")
if (setup) {
  console.log(
    "Sign into ChatGPT in the dedicated Chrome window. Future `npm start` runs will launch this profile automatically."
  )
}

async function findChrome() {
  if (MCP_CONFIG.chatGpt.browserExecutable) {
    const browserExecutable = MCP_CONFIG.chatGpt.browserExecutable
    return (await isExecutable(browserExecutable)) ? browserExecutable : null
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ]

  const available = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        return null
      }
    })
  )
  return available.find((candidate) => candidate !== null)
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function waitForCdp(url, attemptsRemaining = 40) {
  if (await isCdpReady(url)) return true
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (attemptsRemaining <= 1) return false
  return waitForCdp(url, attemptsRemaining - 1)
}

async function isCdpReady(url) {
  try {
    const versionUrl = new URL("/json/version", url)
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(500) })
    if (!response.ok) return false
    const payload = await response.json()
    return typeof payload.webSocketDebuggerUrl === "string"
  } catch {
    return false
  }
}

function isLocalEndpoint(url) {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
}

function hideManagedChrome() {
  if (process.platform !== "darwin") return false
  const pid = findManagedChromePid()
  if (!pid) return false

  // JXA exposes no-argument Objective-C selectors as properties. Reading
  // `.hide` invokes NSRunningApplication.hide() for this exact Chrome PID.
  const script = `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).hide`
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    stdio: "ignore",
    timeout: 1_000,
  })
  return !result.error && result.status === 0
}

function showManagedChrome() {
  if (process.platform !== "darwin") return false
  const pid = findManagedChromePid()
  if (!pid) return false

  const script = `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions($.NSApplicationActivateIgnoringOtherApps)`
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    stdio: "ignore",
    timeout: 1_000,
  })
  return !result.error && result.status === 0
}

function findManagedChromePid() {
  return findManagedChrome()?.pid
}

function findManagedChrome() {
  const result = spawnSync("/bin/ps", ["-eo", "pid=,args="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0 || !result.stdout) return

  const profileArg = `--user-data-dir=${profileDir}`
  const portArg = `--remote-debugging-port=${endpoint.port}`
  for (const line of result.stdout.split("\n")) {
    const command = `${line} `
    if (!command.includes(` ${profileArg} `) || !command.includes(` ${portArg} `)) continue
    const match = line.trim().match(/^(\d+)\s/u)
    if (match) return { pid: Number(match[1]), command }
  }
}

// A Chrome that is shutting down keeps its CDP port open without answering it.
async function isPortStillOccupied(url, attemptsRemaining = 40) {
  if (!(await isPortOccupied(url))) return false
  if (attemptsRemaining <= 1) return true
  await new Promise((resolve) => setTimeout(resolve, 250))
  return isPortStillOccupied(url, attemptsRemaining - 1)
}

async function isPortOccupied(url) {
  const { connect } = await import("node:net")
  return new Promise((resolve) => {
    const socket = connect(Number(url.port), url.hostname)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function fail(message) {
  if (optional) {
    console.warn(`ChatGPT browser setup skipped: ${message}`)
    process.exit(0)
  }
  console.error(message)
  process.exit(1)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
