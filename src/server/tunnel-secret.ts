import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const SECRET_PATTERN = /^[a-f0-9]{64}$/u

/** A bearer secret in the MCP URL; the Cloudflare origin exposes no other route. */
export function ensureTunnelSecret(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (!isExistsError(error)) throw error
  }
  return readTunnelSecret(path)
}

export function readTunnelSecret(path: string): string {
  const info = statSync(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error(
      `Cloudflare URL secret at ${path} must be an owner-only regular file (mode 0600).`
    )
  const secret = readFileSync(path, "utf8").trim()
  if (!SECRET_PATTERN.test(secret)) throw new Error(`Invalid Cloudflare URL secret at ${path}.`)
  return secret
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}
