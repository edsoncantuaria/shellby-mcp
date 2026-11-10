import { resolve } from "node:path"
import { getAgentIdentity } from "../../agent/context.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import { withApplyPatchToolHint } from "./apply-patch-guidance.js"
import { ShellSessionError, type ShellSnapshot } from "./session.js"
import type { ShellSessionManager } from "./session-manager.js"
import {
  DEFAULT_SHELL_ID,
  type ShellBatchCommandOutput,
  type ShellListOutput,
  type ShellPollOutput,
  type ShellRunOutput,
  shellCloseInputSchema,
  shellCloseOutputSchema,
  shellListOutputSchema,
  shellPollInputSchema,
  shellPollOutputSchema,
  shellResetInputSchema,
  shellResetOutputSchema,
  shellRunInputSchema,
  shellRunOutputSchema,
} from "./shell-contracts.js"

// Absent from real shell names, so shells of callers without a conversation stay recognizable.
const CONVERSATION_SEPARATOR = "\u0000"

export function registerShellExecutionTools(
  registerTool: ToolRegistrar,
  shells: ShellSessionManager
): void {
  const workspaceDescription = JSON.stringify(shells.initialCwd)

  registerTool(
    "shell_run",
    {
      description: `Run commands in a persistent configured shell. It runs in the background and never appears on the user's screen. Provide exactly one of command or commands. Shells cwd start in ${workspaceDescription}. Use concise slugs for _id arguments.`,
      inputSchema: shellRunInputSchema,
      outputSchema: shellRunOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) => {
      try {
        const { shell_id, ...commandInput } = input
        const snapshot = await shells.runCommand(conversationShellId(shell_id), {
          ...commandInput,
          signal: ctx.mcpReq.signal,
        })
        return snapshotResult(snapshot, shell_id)
      } catch (error) {
        return toolError(error)
      }
    }
  )

  registerTool(
    "shell_poll",
    {
      description:
        "Continue a shell_run from next_cursor. Returns on completion or yield expiry. If next_cursor is returned, continue only if more output is needed.",
      inputSchema: shellPollInputSchema,
      outputSchema: shellPollOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, ctx) => {
      try {
        const { shell_id, ...pollInput } = input
        const snapshot = await shells.pollCommand(conversationShellId(shell_id), {
          ...pollInput,
          signal: ctx.mcpReq.signal,
        })
        return pollSnapshotResult(snapshot)
      } catch (error) {
        return toolError(error)
      }
    }
  )
}

export function registerShellManagementTools(
  registerTool: ToolRegistrar,
  shells: ShellSessionManager
): void {
  registerTool(
    "shell_reset",
    {
      description: "Reset a stuck shell.",
      inputSchema: shellResetInputSchema,
      outputSchema: shellResetOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const { shell_id, ...resetInput } = input
        const result = await shells.resetShell(conversationShellId(shell_id), resetInput)
        return {
          structuredContent: { ...result, shell_id },
          content: [],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  registerTool(
    "shell_list",
    {
      description: "List open persistent shells.",
      outputSchema: shellListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const visible = conversationShells(shells.listShells())
        const result = {
          shells: visible,
          count: visible.length,
          limit: shells.maximumShells,
          idle_timeout_ms: shells.idleTimeoutMilliseconds,
        }
        return {
          structuredContent: result,
          content: [],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )

  registerTool(
    "shell_close",
    {
      description: `Close a named shell and discard its state. The ${DEFAULT_SHELL_ID} shell must be reset instead.`,
      inputSchema: shellCloseInputSchema,
      outputSchema: shellCloseOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ shell_id }) => {
      try {
        if (shell_id === DEFAULT_SHELL_ID) {
          throw new ShellSessionError(
            "protected_shell",
            `The ${JSON.stringify(DEFAULT_SHELL_ID)} shell cannot be closed. Use shell_reset to recover it if needed.`
          )
        }
        await shells.closeShell(conversationShellId(shell_id))
        const result = { shell_id, closed: true as const }
        return {
          structuredContent: result,
          content: [],
        }
      } catch (error) {
        return toolError(error)
      }
    }
  )
}

/** Prefix that keeps one ChatGPT conversation's shells apart from every other's. */
function conversationPrefix(): string {
  const identity = getAgentIdentity()
  return identity ? `${identity.agent}${CONVERSATION_SEPARATOR}` : ""
}

function conversationShellId(shellId: string): string {
  return `${conversationPrefix()}${shellId}`
}

function conversationShells(listed: ShellListOutput["shells"]): ShellListOutput["shells"] {
  const prefix = conversationPrefix()
  return listed
    .filter(({ shell_id }) =>
      prefix ? shell_id.startsWith(prefix) : !shell_id.includes(CONVERSATION_SEPARATOR)
    )
    .map((shell) => {
      const shell_id = shell.shell_id.slice(prefix.length)
      return { ...shell, shell_id, can_close: shell_id !== DEFAULT_SHELL_ID }
    })
}

function withoutConversationPrefix(message: string): string {
  const prefix = conversationPrefix()
  return prefix ? message.replaceAll(JSON.stringify(prefix).slice(1, -1), "") : message
}

function snapshotResult(snapshot: ShellSnapshot, shellId: string) {
  const structuredContent = compactShellSnapshot(snapshot, shellId)
  return {
    structuredContent,
    content: [],
  }
}

function pollSnapshotResult(snapshot: ShellSnapshot) {
  if (snapshot.cursor_expired) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "cursor_expired: Output before the requested cursor is no longer retained. Rerun the command if complete output is required.",
        },
      ],
    }
  }

  const structuredContent: ShellPollOutput = {
    status: snapshot.status,
    ...(snapshot.exit_code !== null ? { exit_code: snapshot.exit_code } : {}),
    output: withApplyPatchToolHint(snapshot.output),
  }
  if (snapshot.status === "running" || snapshot.output_truncated)
    structuredContent.next_cursor = snapshot.next_cursor
  if (snapshot.dropped_output_bytes > 0)
    structuredContent.dropped_output_bytes = snapshot.dropped_output_bytes
  if (snapshot.commands)
    structuredContent.commands = compactBatchCommands(snapshot.commands, snapshot.cwd)

  return {
    structuredContent,
    content: [],
  }
}

function compactBatchCommands(
  commands: NonNullable<ShellSnapshot["commands"]>,
  cwd: string
): ShellBatchCommandOutput[] {
  return commands.map((command) => ({
    run: command.run,
    command: command.command,
    ...(resolve(cwd, command.path) === cwd ? {} : { path: command.path }),
    status: command.status,
    exit_code: command.exit_code,
    ...(command.dropped_output_bytes ? { dropped_output_bytes: command.dropped_output_bytes } : {}),
  }))
}

function compactShellSnapshot(snapshot: ShellSnapshot, shellId: string): ShellRunOutput {
  const compact: ShellRunOutput = {
    status: snapshot.status,
    ...(snapshot.exit_code !== null ? { exit_code: snapshot.exit_code } : {}),
    cwd: snapshot.cwd,
    output: withApplyPatchToolHint(snapshot.output),
  }
  if (shellId !== DEFAULT_SHELL_ID) compact.shell_id = shellId
  if (snapshot.status === "running" || snapshot.output_truncated) {
    compact.request_id = snapshot.request_id
    compact.next_cursor = snapshot.next_cursor
  }
  if (snapshot.cursor_expired) compact.cursor_expired = true
  if (snapshot.output_truncated) compact.output_truncated = true
  if (snapshot.dropped_output_bytes > 0)
    compact.dropped_output_bytes = snapshot.dropped_output_bytes
  if (snapshot.commands) compact.commands = compactBatchCommands(snapshot.commands, snapshot.cwd)
  return compact
}

function toolError(error: unknown) {
  const text =
    error instanceof ShellSessionError
      ? `${error.code}: ${withoutConversationPrefix(error.message)}`
      : `internal_error: ${error instanceof Error ? error.message : String(error)}`
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  }
}
