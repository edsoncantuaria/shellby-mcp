import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"

import { parse } from "smol-toml"
import { z } from "zod"

// CommonJS lets the built loader serve PM2's ecosystem file as well as the ESM runtime.
const defaultConfigPath = resolve(__dirname, "../.shellby/config.toml")
const httpUrl = z
  .url()
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "URL must use http or https"
  )
const cdpEndpoint = httpUrl.refine((value) => {
  const url = new URL(value)
  const managedLocal =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  return managedLocal && url.port.length > 0
}, "CDP endpoint must use http://127.0.0.1:<port> or http://localhost:<port>")

const publicConfigSchema = z.object({
  state_dir: z.string().trim().min(1).default("~/.shellby"),
  port: z.number().int().min(1).max(65535).default(3333),
  workspace: z.string().trim().min(1).default("~/Desktop/agent-workspace"),
  shell: z.object({
    path: z
      .string()
      .trim()
      .min(1)
      .default(process.platform === "linux" ? "/bin/bash" : "/bin/zsh"),
    rtk: z.boolean().default(false),
  }),
  chatgpt: z.object({
    cdp_endpoint: cdpEndpoint.default("http://127.0.0.1:9222"),
    browser_executable: z.string().trim().min(1).optional(),
    project_url: httpUrl.default("https://chatgpt.com/"),
    max_delegated_agents: z.number().int().positive().default(3),
  }),
  ngrok: z.object({
    enabled: z.boolean().default(true),
    api_port: z.number().int().min(1).max(65535).default(4040),
    url: httpUrl.optional(),
    pooling_enabled: z.boolean().default(false),
  }),
  cloudflared: z.object({
    enabled: z.boolean().default(false),
    public_url: z
      .url()
      .refine((value) => {
        const url = new URL(value)
        return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash
      }, "Use an HTTPS origin URL without a path, query, or fragment")
      .optional(),
    token_file: z.string().trim().min(1).optional(),
  }),
  auth: z
    .object({
      mode: z.enum(["chatgpt", "hybrid"]).default("chatgpt"),
    })
    .default({ mode: "chatgpt" }),
  mcp: z.object({
    name: z.string().trim().min(1).optional(),
    tool_output: z.enum(["compact", "structured"]).default("compact"),
  }),
  ui: z.object({ enabled: z.boolean().default(false) }),
  logging: z.object({ enabled: z.boolean().default(false) }),
  tools: z.object({
    review: z.boolean().default(true),
    shell: z.boolean().default(true),
    apply_patch: z.boolean().default(true),
    file_read: z.boolean().default(true),
    file_write: z.boolean().default(true),
    clones: z.boolean().default(true),
    subagents: z.boolean().default(true),
    web: z.boolean().default(true),
    skills: z.boolean().default(true),
    image: z.boolean().default(true),
    computer: z.boolean().default(process.platform === "darwin"),
    browser: z.boolean().default(false),
  }),
})

export type ShellbyPublicConfig = z.infer<typeof publicConfigSchema>
export const DEFAULT_PUBLIC_CONFIG = publicConfigSchema.parse(
  resolveConfigObject(publicConfigSchema, {}, "", () => undefined)
)

export function loadPublicConfig(path = defaultConfigPath): ShellbyPublicConfig {
  if (!existsSync(path))
    throw new Error(`Shellby config is missing at ${path}. Run \`npm run setup\` first.`)

  const source = readFileSync(path, "utf8")
  let value: unknown
  try {
    value = parse(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Invalid Shellby config syntax at ${path}: ${message}. Fix the TOML syntax; the file has not been changed.`,
      { cause: error }
    )
  }

  if (isRecord(value) && isRecord(value.chatgpt) && value.chatgpt.cdp_endpoint !== undefined) {
    const suppliedEndpoint = cdpEndpoint.safeParse(value.chatgpt.cdp_endpoint)
    if (!suppliedEndpoint.success) {
      throw new Error(
        "chatgpt.cdp_endpoint must be an HTTP loopback URL with an explicit port; remote CDP is not supported."
      )
    }
  }

  const warn = (message: string) => console.warn(`Shellby config warning (${path}): ${message}`)
  const config = publicConfigSchema.parse(resolveConfigObject(publicConfigSchema, value, "", warn))
  if (config.ngrok.pooling_enabled && !config.ngrok.url) {
    warn("ngrok.pooling_enabled requires a valid ngrok.url; using default false.")
    config.ngrok.pooling_enabled = false
  }
  if (config.ngrok.enabled && config.cloudflared.enabled) {
    throw new Error(
      "Enable only one public tunnel: set ngrok.enabled = false or cloudflared.enabled = false."
    )
  }
  return config
}

function resolveConfigObject(
  schema: z.ZodObject,
  value: unknown,
  prefix: string,
  warn: (message: string) => void
): Record<string, unknown> {
  const input = resolveConfigInput(value, prefix, warn)
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.shape, key))
      warn(`Unknown setting ${prefix ? `${prefix}.` : ""}${key}; ignoring it.`)
  }

  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const path = prefix ? `${prefix}.${key}` : key
    const supplied = Object.hasOwn(input, key) ? input[key] : undefined
    const resolved = resolveConfigValue(field, supplied, path, warn)
    if (resolved !== undefined) result[key] = resolved
  }
  return result
}

function resolveConfigInput(
  value: unknown,
  prefix: string,
  warn: (message: string) => void
): Record<string, unknown> {
  if (value === undefined) return {}
  if (isRecord(value)) return value
  warn(`${prefix} must be a TOML table; using defaults for this section.`)
  return {}
}

function resolveConfigValue(
  field: z.ZodType,
  supplied: unknown,
  path: string,
  warn: (message: string) => void
): unknown {
  if (field instanceof z.ZodObject) return resolveConfigObject(field, supplied, path, warn)

  const parsed = field.safeParse(supplied)
  const resolved = parsed.success ? parsed.data : field.parse(undefined)
  if (!parsed.success) {
    const fallback =
      resolved === undefined
        ? "ignoring this optional setting"
        : `using default ${JSON.stringify(resolved)}`
    warn(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}; ${fallback}.`)
  }
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
