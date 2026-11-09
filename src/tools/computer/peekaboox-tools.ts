import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import type { PeekabooXClient } from "./peekaboox.js"

const shortText = z.string().trim().min(1).max(500)
const coordinate = z.number().int().nonnegative()
const chordPattern = /^[A-Za-z0-9_+-]+$/u

export function registerPeekabooXTools(registerTool: ToolRegistrar, client: PeekabooXClient): void {
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  const action = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }

  registerTool(
    "computer_list",
    {
      description: "List Linux desktop windows, applications, or PeekabooX permission diagnostics.",
      inputSchema: z.object({
        kind: z.enum(["windows", "apps", "permissions"]).default("windows"),
      }),
      nativeContent: true,
      annotations: readOnly,
    },
    async ({ kind }, ctx) => {
      let args: string[]
      if (kind === "windows") args = ["windows", "--backend", "at-spi", "--limit", "100", "--json"]
      else if (kind === "apps") args = ["app", "list", "--json"]
      else args = ["doctor", "--json"]
      return runJson(client, args, ctx.mcpReq.signal)
    }
  )

  registerTool(
    "computer_observe",
    {
      description:
        "Capture the Linux desktop or an app/window with PeekabooX and return an image. A Wayland portal may ask for screen-sharing permission.",
      inputSchema: z.object({
        app: shortText.optional(),
        window_id: shortText.optional(),
        title_regex: shortText.optional(),
      }),
      nativeContent: true,
      annotations: readOnly,
    },
    async ({ app, window_id, title_regex }, ctx) => {
      const args: string[] = []
      if (app) args.push("--app", app)
      if (window_id) args.push("--window-id", window_id)
      if (title_regex) args.push("--title-regex", title_regex)
      try {
        const result = await client.observe(args, ctx.mcpReq.signal)
        return {
          content: [
            { type: "text" as const, text: "Captured Linux desktop with PeekabooX." },
            { type: "image" as const, data: result.imageData, mimeType: result.mimeType },
          ],
          structuredContent: result.metadata,
        }
      } catch (error) {
        return computerError(error)
      }
    }
  )

  registerTool(
    "computer_inspect",
    {
      description:
        "Find live accessible Linux desktop elements using a PeekabooX selector. Results are not snapshot IDs; inspect again after the UI changes.",
      inputSchema: z.object({
        selector: shortText,
        app: shortText.optional(),
        window_id: shortText.optional(),
        vision_fallback: z.boolean().default(false),
      }),
      nativeContent: true,
      annotations: readOnly,
    },
    async ({ selector, app, window_id, vision_fallback }, ctx) => {
      const args = ["elements", "--selector", selector, "--limit", "100", "--json"]
      if (app) args.push("--app", app)
      if (window_id) args.push("--window-id", window_id)
      if (vision_fallback) args.push("--vision-fallback")
      return runJson(client, args, ctx.mcpReq.signal)
    }
  )

  registerTool(
    "computer_click",
    {
      description:
        "Click exact coordinates or a semantic selector on the Linux desktop through PeekabooX.",
      inputSchema: z
        .object({
          x: coordinate.optional(),
          y: coordinate.optional(),
          selector: shortText.optional(),
          dry_run: z.boolean().default(false),
        })
        .superRefine((value, context) => {
          if (
            Boolean(value.selector) === (value.x !== undefined && value.y !== undefined) ||
            (value.x === undefined) !== (value.y === undefined)
          ) {
            context.addIssue({
              code: "custom",
              message: "Provide either selector or both x and y.",
            })
          }
        }),
      nativeContent: true,
      annotations: action,
    },
    async ({ x, y, selector, dry_run }, ctx) => {
      const args = ["click", "--json"]
      if (selector) args.push("--selector", selector)
      else args.push("--x", String(x), "--y", String(y))
      if (dry_run) args.push("--dry-run")
      return runJson(client, args, ctx.mcpReq.signal)
    }
  )

  registerTool(
    "computer_type",
    {
      description:
        "Type text into the focused Linux application through PeekabooX. Requires a working Wayland text backend.",
      inputSchema: z.object({
        text: z.string().min(1).max(20_000),
        dry_run: z.boolean().default(false),
      }),
      nativeContent: true,
      annotations: action,
    },
    async ({ text, dry_run }, ctx) =>
      runJson(
        client,
        ["type", "--text", text, "--json", ...(dry_run ? ["--dry-run"] : [])],
        ctx.mcpReq.signal
      )
  )

  registerTool(
    "computer_hotkey",
    {
      description:
        "Send a key chord such as ctrl+s through PeekabooX. Requires a working Wayland hotkey backend.",
      inputSchema: z.object({
        chord: z.string().regex(chordPattern).max(100),
        dry_run: z.boolean().default(false),
      }),
      nativeContent: true,
      annotations: action,
    },
    async ({ chord, dry_run }, ctx) =>
      runJson(
        client,
        ["hotkey", chord, "--json", ...(dry_run ? ["--dry-run"] : [])],
        ctx.mcpReq.signal
      )
  )

  registerTool(
    "computer_scroll",
    {
      description: "Scroll the focused Linux desktop window through PeekabooX.",
      inputSchema: z.object({
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().positive().max(100).default(3),
        dry_run: z.boolean().default(false),
      }),
      nativeContent: true,
      annotations: action,
    },
    async ({ direction, amount, dry_run }, ctx) =>
      runJson(
        client,
        [
          "scroll",
          direction,
          "--amount",
          String(amount),
          "--json",
          ...(dry_run ? ["--dry-run"] : []),
        ],
        ctx.mcpReq.signal
      )
  )
}

async function runJson(
  client: PeekabooXClient,
  args: string[],
  signal: AbortSignal
): Promise<CallToolResult> {
  try {
    const result = await client.run(args, signal)
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    return computerError(error)
  }
}

function computerError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  }
}
