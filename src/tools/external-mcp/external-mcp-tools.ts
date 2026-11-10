import type { CallToolResult } from "@modelcontextprotocol/client"
import { z } from "zod"
import { MCP_CONFIG } from "../../config.js"
import type { ToolRegistrar } from "../../mcp/tool-registration-boundary.js"
import { tokenPrefix } from "../../tokenizer.js"
import { encodeImageForMcp, ImageEncodingError } from "../image/image-encoding.js"
import type { ExternalMcpManager } from "./external-mcp-manager.js"

type ContentBlock = CallToolResult["content"][number]

export function registerExternalMcpTools(
  registerTool: ToolRegistrar,
  manager: ExternalMcpManager
): void {
  const server = z.enum(manager.serverNames).describe("Configured MCP server.")

  registerTool(
    "mcp_list_tools",
    {
      description:
        "List the tools of a configured MCP server, with their input schemas and the server's usage instructions. Call this before mcp_call.",
      inputSchema: z.object({ server }),
      nativeContent: true,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ server: name }, ctx) => {
      const { instructions, tools } = await manager.listTools(name, ctx.mcpReq.signal)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              instructions,
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            }),
          },
        ],
      }
    }
  )

  registerTool(
    "mcp_call",
    {
      description:
        "Call a tool of a configured MCP server. Use mcp_list_tools first to learn the tool's name and arguments.",
      inputSchema: z.object({
        server,
        tool: z.string().min(1).describe("Tool name from mcp_list_tools."),
        arguments: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Arguments matching the tool's input schema."),
      }),
      nativeContent: true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ server: name, tool, arguments: args }, ctx) =>
      projectExternalResult(await manager.callTool(name, tool, args, ctx.mcpReq.signal))
  )
}

/** Fit an external result into the limits every other Shellby tool already honors. */
async function projectExternalResult(result: CallToolResult): Promise<CallToolResult> {
  const maxTokens = MCP_CONFIG.externalMcp.maxOutputTokens
  let remainingTokens = maxTokens
  let truncated = false
  const content: ContentBlock[] = []

  const pushText = (text: string) => {
    const prefix = tokenPrefix(text, remainingTokens)
    remainingTokens -= prefix.tokenCount
    truncated ||= prefix.truncated
    if (prefix.value) content.push({ type: "text", text: prefix.value })
  }

  const blocks: ContentBlock[] =
    result.content.length === 0 && result.structuredContent !== undefined
      ? [{ type: "text", text: JSON.stringify(result.structuredContent) }]
      : result.content

  for (const block of blocks) {
    if (block.type === "text") pushText(block.text)
    else if (block.type === "image") content.push(await reencodeImage(block.data, block.mimeType))
    else if (block.type === "resource_link") content.push(block)
    else if (block.type === "resource" && "text" in block.resource) pushText(block.resource.text)
    else content.push({ type: "text", text: `[Omitted binary ${block.type} content.]` })
  }

  if (truncated) {
    content.push({ type: "text", text: `[Output truncated at ${maxTokens} tokens.]` })
  }
  return { content, ...(result.isError ? { isError: true } : {}) }
}

async function reencodeImage(data: string, mimeType: string): Promise<ContentBlock> {
  try {
    const encoded = await encodeImageForMcp(Buffer.from(data, "base64"))
    return { type: "image", data: encoded.data, mimeType: encoded.mimeType }
  } catch (error) {
    if (!(error instanceof ImageEncodingError)) throw error
    return { type: "text", text: `[Omitted ${mimeType} image. ${error.code}: ${error.message}]` }
  }
}
