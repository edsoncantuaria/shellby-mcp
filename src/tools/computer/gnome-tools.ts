import { z } from "zod"
import { getAgentIdentity } from "../../agent/context.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import type { PeekabooClient, PeekabooObservationTarget } from "./peekaboo.js"
import { SCREEN_IMAGE_META_KEY, SCREEN_VIEWER_URI } from "./screen-viewer.js"
import {
  addTargetArgs,
  appInput,
  callPeekaboo,
  peekabooToolError,
  targetFields,
  windowIdInput,
} from "./tool-shared.js"

const HOLD_KEYS_PATTERN = /^[A-Za-z0-9_+]+$/u

/** Tools only the GNOME helper implements. */
export function registerGnomeTools(registerTool: ToolRegistrar, peekaboo: PeekabooClient): void {
  const action = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }

  registerTool(
    "computer_show",
    {
      description:
        "Show the user a screenshot of their desktop, an app, or a window in this chat. Use this whenever they ask to see their screen or for a print; computer_observe only shows it to you.",
      inputSchema: z.object({ app: appInput.optional(), window_id: windowIdInput.optional() }),
      nativeContent: true,
      annotations: { ...action, readOnlyHint: true },
      _meta: {
        "openai/outputTemplate": SCREEN_VIEWER_URI,
        "openai/toolInvocation/invoking": "Capturing the screen",
        "openai/toolInvocation/invoked": "Screenshot ready",
      },
    },
    async ({ app, window_id }, ctx) => {
      let target: PeekabooObservationTarget = { kind: "screen", screenIndex: 0 }
      if (window_id !== undefined)
        target = { kind: "window", windowId: window_id, ...(app ? { app } : {}) }
      else if (app !== undefined) target = { kind: "app", app }
      try {
        const { imageData, mimeType } = await peekaboo.observe(
          { target, annotate: false, noWebFocus: true },
          ctx.mcpReq.signal
        )
        // Only ChatGPT runs the viewer widget; other clients get a standard MCP image.
        if (getAgentIdentity()?.provider === "gemini") {
          return {
            content: [
              { type: "image" as const, data: imageData, mimeType },
              { type: "text" as const, text: "Screenshot of the user's desktop." },
            ],
          }
        }
        return {
          content: [{ type: "text" as const, text: "The screenshot is displayed to the user." }],
          _meta: { [SCREEN_IMAGE_META_KEY]: `data:${mimeType};base64,${imageData}` },
        }
      } catch (error) {
        return peekabooToolError(error)
      }
    }
  )

  registerTool(
    "computer_move",
    {
      description:
        "Move the pointer by a relative amount, for games and apps that capture the mouse.",
      inputSchema: z.object({
        ...targetFields,
        dx: z.number().int().min(-10_000).max(10_000),
        dy: z.number().int().min(-10_000).max(10_000),
        steps: z.number().int().min(1).max(240).optional(),
        duration_ms: z.number().int().min(0).max(10_000).optional(),
      }),
      nativeContent: true,
      annotations: action,
    },
    async (input, ctx) => {
      const args = ["move", "--dx", String(input.dx), "--dy", String(input.dy)]
      addTargetArgs(args, input)
      if (input.steps !== undefined) args.push("--steps", String(input.steps))
      if (input.duration_ms !== undefined) args.push("--duration", String(input.duration_ms))
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Pointer moved.")
    }
  )

  registerTool(
    "computer_hold",
    {
      description:
        "Hold keys or mouse buttons down for games. Input still held after 30 seconds is released automatically.",
      inputSchema: z.object({
        ...targetFields,
        action: z.enum(["down", "up", "tap", "release"]).default("tap"),
        keys: z
          .string()
          .regex(HOLD_KEYS_PATTERN)
          .optional()
          .describe("Keys joined with +, such as w or shift+w."),
        button: z.enum(["left", "right", "middle"]).optional(),
        duration_ms: z.number().int().min(0).max(10_000).optional().describe("Hold time for tap."),
      }),
      nativeContent: true,
      annotations: action,
    },
    async (input, ctx) => {
      const args = ["hold", "--action", input.action]
      addTargetArgs(args, input)
      if (input.keys !== undefined) args.push("--keys", input.keys)
      if (input.button !== undefined) args.push("--button", input.button)
      if (input.duration_ms !== undefined) args.push("--duration", String(input.duration_ms))
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Hold completed.")
    }
  )

  registerTool(
    "computer_clipboard",
    {
      description: "Read or replace the desktop clipboard text.",
      inputSchema: z
        .object({ action: z.enum(["get", "set"]), text: z.string().optional() })
        .superRefine((value, context) => {
          if (value.action === "set" && value.text === undefined) {
            context.addIssue({ code: "custom", message: "text is required for set." })
          }
        }),
      nativeContent: true,
      annotations: action,
    },
    async ({ action: clipboardAction, text }, ctx) => {
      const args = ["clipboard", clipboardAction]
      if (text !== undefined && clipboardAction === "set") args.push("--text", text)
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Clipboard read.")
    }
  )

  registerTool(
    "computer_window_place",
    {
      description: "Move a window to another screen or workspace.",
      inputSchema: z
        .object({
          app: appInput.optional(),
          window_id: windowIdInput.optional(),
          screen_index: z.number().int().nonnegative().optional(),
          workspace: z.number().int().nonnegative().max(35).optional(),
        })
        .superRefine((value, context) => {
          if (value.app === undefined && value.window_id === undefined) {
            context.addIssue({ code: "custom", message: "Supply app or window_id." })
          }
          if (value.screen_index === undefined && value.workspace === undefined) {
            context.addIssue({ code: "custom", message: "Supply screen_index or workspace." })
          }
        }),
      nativeContent: true,
      annotations: action,
    },
    async (input, ctx) => {
      const args = ["window", "place"]
      addTargetArgs(args, input)
      if (input.screen_index !== undefined) args.push("--screen", String(input.screen_index))
      if (input.workspace !== undefined) args.push("--workspace", String(input.workspace))
      return callPeekaboo(peekaboo, args, ctx.mcpReq.signal, "Window placed.")
    }
  )
}
