const { execFileSync } = require("node:child_process")
const { chmodSync, mkdirSync } = require("node:fs")
const { join } = require("node:path")
const { homedir } = require("node:os")
const process = require("node:process")
const { resolve } = require("node:path")
const { loadPublicConfig } = require("./dist/public-config.cjs")
const { ngrokConfigFiles } = require("./scripts/ngrok-config.cjs")

const shellbyConfig = loadPublicConfig(join(__dirname, ".shellby", "config.toml"))

const apps = [
  {
    name: "shellby-mcp",
    script: "dist/index.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    kill_timeout: 10_000,
  },
]

// GNOME uses linux/shellby-desktop, which needs no daemon.
const gnomeDesktop = (process.env.XDG_CURRENT_DESKTOP ?? "").split(":").includes("GNOME")
if (process.platform === "linux" && shellbyConfig.tools.computer && !gnomeDesktop) {
  const daemon = execFileSync("/usr/bin/which", ["peekabooxd"], { encoding: "utf8" }).trim()
  const configured = shellbyConfig.state_dir
  let stateDir
  if (configured === "~") stateDir = homedir()
  else if (configured.startsWith("~/")) stateDir = join(homedir(), configured.slice(2))
  else stateDir = resolve(__dirname, configured)
  const socketDir = join(stateDir, "peekaboox")
  mkdirSync(socketDir, { recursive: true, mode: 0o700 })
  chmodSync(socketDir, 0o700)
  apps.push({
    name: "shellby-peekabooxd",
    script: daemon,
    args: [
      "run",
      "--profile",
      "operator",
      "--socket",
      join(socketDir, "daemon.sock"),
      "--no-grpc",
      "--no-emergency-hotkey",
    ],
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    kill_timeout: 10_000,
  })
}

if (shellbyConfig.ngrok.enabled) {
  const ngrokExecutable = execFileSync("/usr/bin/which", ["ngrok"], { encoding: "utf8" }).trim()
  const ngrokArgs = ["http", `http://127.0.0.1:${shellbyConfig.port}`]
  for (const path of ngrokConfigFiles(shellbyConfig, __dirname, ngrokExecutable))
    ngrokArgs.push("--config", path)
  if (shellbyConfig.ngrok.url) ngrokArgs.push("--url", shellbyConfig.ngrok.url)
  if (shellbyConfig.ngrok.pooling_enabled) ngrokArgs.push("--pooling-enabled")
  ngrokArgs.push("--traffic-policy-file=./ngrok-traffic-policy.yml", "--inspect=false")
  apps.push({
    name: "shellby-ngrok",
    script: ngrokExecutable,
    args: ngrokArgs,
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
  })
}

if (shellbyConfig.cloudflared.enabled) {
  const cloudflaredExecutable = execFileSync("/usr/bin/which", ["cloudflared"], {
    encoding: "utf8",
  }).trim()
  apps.push({
    name: "shellby-cloudflared",
    script: cloudflaredExecutable,
    args: [
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:0",
      "run",
      "--token-file",
      shellbyConfig.cloudflared.token_file.replace(/^~(?=\/|$)/u, homedir()),
    ],
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
  })
}

module.exports = {
  apps,
}
