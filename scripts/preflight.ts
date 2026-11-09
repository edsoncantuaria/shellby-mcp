import { spawnSync } from "node:child_process"
import { constants, existsSync } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))

export interface PublicRuntimeCheck {
  errors: string[]
  pm2Path: string
}

export async function checkPublicRuntime(
  ngrokEnabled = true,
  shellPath?: string,
  computerEnabled = false,
  cloudflared?: { enabled: boolean; publicUrl?: string; tokenFile?: string; originPort: number }
): Promise<PublicRuntimeCheck> {
  const errors: string[] = []

  if (process.platform !== "darwin" && process.platform !== "linux") {
    errors.push("Shellby supports macOS and Linux only.")
  }
  if (!isSupportedArchitecture(process.arch)) {
    errors.push("Shellby supports arm64 and x64 only.")
  }
  if (shellPath) {
    try {
      await access(shellPath, constants.X_OK)
    } catch {
      errors.push(
        `Configured shell ${JSON.stringify(shellPath)} is not executable. Set shell.path to an installed Bash or Zsh executable.`
      )
    }
  }

  if (!isSupportedNodeVersion(process.versions.node)) {
    errors.push(`Node.js 22.18.0+ is required. Current version: ${process.versions.node}.`)
  }

  const pm2Path = join(repoRoot, "node_modules", ".bin", "pm2")
  try {
    await access(pm2Path, constants.X_OK)
  } catch {
    errors.push("Local dependencies are missing. Run `npm ci` first.")
  }

  if (computerEnabled && process.platform === "linux") {
    checkPeekabooXRuntime(errors)
  }
  if (cloudflared?.enabled) await checkCloudflaredRuntime(cloudflared, ngrokEnabled, errors)

  if (!ngrokEnabled) return { errors, pm2Path }

  const ngrokExecutable = "ngrok"
  const ngrokVersion = spawnSync(ngrokExecutable, ["version"], { encoding: "utf8" })
  if (hasErrorCode(ngrokVersion.error, "ENOENT")) {
    errors.push("ngrok is not installed. Install the ngrok CLI and ensure it is on PATH.")
  } else if (ngrokVersion.status !== 0) {
    errors.push(
      `ngrok could not run${ngrokVersion.stderr?.trim() ? `: ${ngrokVersion.stderr.trim()}` : "."}`
    )
  } else if (!(await hasNgrokAuth(ngrokExecutable))) {
    errors.push("ngrok is not authenticated. Run `ngrok config add-authtoken <your-token>`.")
  }

  return { errors, pm2Path }
}

async function checkCloudflaredRuntime(
  config: { publicUrl?: string; tokenFile?: string; originPort: number },
  ngrokEnabled: boolean,
  errors: string[]
): Promise<void> {
  if (ngrokEnabled) errors.push("Enable only one public tunnel: disable ngrok or cloudflared.")
  if (!config.publicUrl) errors.push("Set cloudflared.public_url to your HTTPS tunnel hostname.")
  if (config.originPort > 65535)
    errors.push("The Cloudflare origin port exceeds 65535; lower the Shellby MCP port.")
  if (!config.tokenFile) {
    errors.push("Set cloudflared.token_file to an owner-only file containing the tunnel token.")
  } else {
    try {
      const info = await stat(config.tokenFile)
      if (
        !info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        !(await readFile(config.tokenFile, "utf8")).trim()
      )
        errors.push("Cloudflare tunnel token must be a nonempty owner-only file (mode 0600).")
    } catch {
      errors.push(`Cloudflare tunnel token file is missing or unreadable at ${config.tokenFile}.`)
    }
  }
  const cli = spawnSync("cloudflared", ["version"], { encoding: "utf8" })
  if (cli.error || cli.status !== 0)
    errors.push("cloudflared is missing or cannot run. Install the Cloudflare Tunnel CLI on PATH.")
}

function checkPeekabooXRuntime(errors: string[]): void {
  const cli = spawnSync("peekaboox", ["--version"], { encoding: "utf8" })
  if (hasErrorCode(cli.error, "ENOENT")) {
    errors.push(
      "PeekabooX is missing. Install PeekabooX 1.1.2+ and put peekaboox and peekabooxd on PATH, or set tools.computer = false."
    )
  } else {
    const version = cli.stdout.trim().match(/^peekaboox (\d+)\.(\d+)\.(\d+)/u)
    const numbers = version?.slice(1).map(Number)
    const [major = 0, minor = 0, patch = 0] = numbers ?? []
    if (cli.status !== 0 || !numbers || major !== 1 || minor < 1 || (minor === 1 && patch < 2)) {
      errors.push(
        `PeekabooX 1.1.2+ is required; peekaboox --version returned ${JSON.stringify(cli.stdout.trim() || cli.stderr.trim())}.`
      )
    }
  }
  const daemon = spawnSync("peekabooxd", ["run", "--help"], { encoding: "utf8" })
  if (daemon.error || daemon.status !== 0) {
    errors.push(
      "PeekabooX daemon is missing or cannot run. Install peekabooxd from the same PeekabooX release."
    )
  }
}

export function isSupportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return major > 22 || (major === 22 && minor >= 18)
}

export function isSupportedArchitecture(arch: string): boolean {
  return arch === "arm64" || arch === "x64"
}

export function checkRtkRuntime(enabled: boolean, executable?: string): string | undefined {
  if (!enabled) return
  if (!executable)
    return "RTK is enabled but not installed. Install RTK and ensure it is on PATH, then restart Shellby."

  const result = spawnSync(executable, ["rewrite", "--help"], { encoding: "utf8" })
  if (
    result.error ||
    result.status !== 0 ||
    !result.stdout.includes("Rewrite a raw command to its RTK equivalent")
  ) {
    return `shell.rtk points to an incompatible \`rtk\` executable at ${executable}. Install RTK Token Killer, then restart Shellby.`
  }
}

export function printPreflightErrors(errors: readonly string[]): void {
  console.error("Setup cannot continue:\n")
  for (const error of errors) console.error(`- ${error}`)
}

async function hasNgrokAuth(ngrokExecutable: string): Promise<boolean> {
  const check = spawnSync(ngrokExecutable, ["config", "check"], { encoding: "utf8" })
  if (check.status !== 0) return false

  const output = `${check.stdout ?? ""}\n${check.stderr ?? ""}`
  const match = output.match(/Valid configuration file at (.+)$/mu)
  if (!match?.[1]) return false

  try {
    const config = await readFile(expandHome(match[1].trim()), "utf8")
    return /^\s*authtoken\s*:\s*\S+/mu.test(config)
  } catch {
    return false
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadPublicConfig, DEFAULT_PUBLIC_CONFIG } = await import("../src/public-config.cjs")
  const configPath = join(repoRoot, ".shellby", "config.toml")
  const config = existsSync(configPath) ? loadPublicConfig(configPath) : DEFAULT_PUBLIC_CONFIG
  const { errors } = await checkPublicRuntime(
    config.ngrok.enabled,
    config.shell.path,
    config.tools.computer,
    {
      enabled: config.cloudflared.enabled,
      publicUrl: config.cloudflared.public_url,
      tokenFile: config.cloudflared.token_file
        ? expandHome(config.cloudflared.token_file)
        : undefined,
      originPort: config.port + 1,
    }
  )
  if (errors.length > 0) {
    printPreflightErrors(errors)
    process.exitCode = 1
  } else {
    console.log("Preflight passed.")
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
