import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"

import { asRecord } from "../../utils.js"
import { type PeekabooClient, PeekabooError, type PeekabooResult } from "./peekaboo.js"

export const appInput = z.string().min(1).describe("App name, bundle or desktop ID, or PID:12345.")
export const snapshotInput = z
  .string()
  .min(1)
  .describe("Snapshot ID from computer_observe or computer_inspect.")
export const windowIdInput = z.number().int().positive().describe("Window ID from computer_list.")

export const targetFields = {
  app: appInput.optional(),
  window_id: windowIdInput.optional(),
  snapshot_id: snapshotInput.optional(),
}

export function addTargetArgs(
  args: string[],
  target: { app?: string; window_id?: number; snapshot_id?: string }
): void {
  if (target.app !== undefined) args.push("--app", target.app)
  if (target.window_id !== undefined) args.push("--window-id", String(target.window_id))
  if (target.snapshot_id !== undefined) args.push("--snapshot", target.snapshot_id)
}

export async function callPeekaboo(
  peekaboo: PeekabooClient,
  args: string[],
  signal: AbortSignal,
  fallbackSummary: string
): Promise<CallToolResult> {
  try {
    return commandResult(await peekaboo.run(args, signal), fallbackSummary)
  } catch (error) {
    return peekabooToolError(error)
  }
}

export function commandResult(result: PeekabooResult, fallbackSummary: string): CallToolResult {
  const summary =
    typeof result.summary === "string"
      ? result.summary
      : (result.messages?.find((message) => message.trim()) ?? fallbackSummary)
  const structuredContent = asStructuredContent(result.data)
  return {
    content: [{ type: "text", text: summary }],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

export function peekabooToolError(error: unknown): CallToolResult {
  if (error instanceof PeekabooError) {
    return {
      content: [
        {
          type: "text",
          text: `${error.code}: ${error.message}${error.details ? ` (${error.details})` : ""}`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  }
}

function asStructuredContent(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null
  return asRecord(value) ?? { value }
}
