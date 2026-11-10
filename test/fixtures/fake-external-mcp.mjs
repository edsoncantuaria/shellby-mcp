#!/usr/bin/env node
import process from "node:process"

import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

// The test runner also executes every file under test/; only serve when a test asks for it.
if (process.argv[2] !== "--serve") process.exit(0)

// 1x1 opaque PNG.
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const server = new McpServer(
  { name: "fake-external-mcp", version: "1.0.0" },
  { instructions: "Fake server instructions." }
)
const text = (value) => ({ content: [{ type: "text", text: value }] })

server.registerTool(
  "echo",
  { description: "Echo a value.", inputSchema: z.object({ value: z.string() }) },
  async ({ value }) => text(JSON.stringify({ value, pid: process.pid }))
)
server.registerTool("env", { description: "Read test variables." }, async () =>
  text(
    JSON.stringify({
      configured: process.env.CONFIGURED_VALUE,
      parentSecret: process.env.SHELLBY_TEST_PARENT_SECRET,
      display: process.env.DISPLAY,
    })
  )
)
server.registerTool("image", { description: "Return an image." }, async () => ({
  content: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }],
}))
server.registerTool("big", { description: "Return more text than Shellby keeps." }, async () =>
  text("word ".repeat(40_000))
)
server.registerTool("audio", { description: "Return binary audio." }, async () => ({
  content: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
}))
server.registerTool("fails", { description: "Report a tool error." }, async () => ({
  isError: true,
  content: [{ type: "text", text: "remote tool failed" }],
}))
server.registerTool("crash", { description: "Exit before answering." }, async () => {
  process.exit(1)
})
server.registerTool("slow", { description: "Never answer." }, async () => {
  await new Promise(() => undefined)
  return text("unreachable")
})

await server.connect(new StdioServerTransport())
