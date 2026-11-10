import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import sharp from "sharp"

import { createToolRegistrar } from "../../../src/mcp/tool-registration-boundary.js"
import {
  BrowserBridgeError,
  type BrowserCaller,
} from "../../../src/tools/browser/browser-bridge.js"
import { registerBrowserTools } from "../../../src/tools/browser/browser-tools.js"

type Call = [string, Record<string, unknown>]

async function connect(t: TestContext, respond: (method: string) => unknown) {
  const calls: Call[] = []
  const bridge: BrowserCaller = {
    call: (async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])
      return respond(method)
    }) as BrowserCaller["call"],
  }
  const server = new McpServer({ name: "browser-test", version: "1.0.0" })
  registerBrowserTools(createToolRegistrar(server, { structuredOutput: false }), bridge)
  const client = new Client({ name: "browser-test-client", version: "1.0.0" })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  t.after(() => Promise.all([client.close(), server.close()]))
  return { client, calls }
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text: string }[]
  return first?.text ?? ""
}

test("forwards browser_read with translated parameter names", async (t) => {
  const { client, calls } = await connect(t, () => ({ tree: "- button [ref_1]" }))
  const result = await client.callTool({ name: "browser_read", arguments: { tab_id: 4 } })
  assert.equal(result.isError, undefined)
  assert.match(textOf(result), /ref_1/u)
  assert.deepEqual(calls, [
    [
      "read",
      { tabId: 4, format: "tree", query: undefined, interactiveOnly: false, maxChars: 20_000 },
    ],
  ])
})

test("reports the extension's approval error to the model", async (t) => {
  const { client } = await connect(t, () => {
    throw new BrowserBridgeError("SITE_APPROVAL_REQUIRED", "waiting in Chrome")
  })
  const result = await client.callTool({
    name: "browser_tabs",
    arguments: { action: "create", url: "https://a.example/" },
  })
  assert.equal(result.isError, true)
  assert.equal(textOf(result), "SITE_APPROVAL_REQUIRED: waiting in Chrome")
})

test("rejects actions missing their target before reaching Chrome", async (t) => {
  const { client, calls } = await connect(t, () => "done")
  const cases = [
    { tab_id: 1, action: "click" },
    { tab_id: 1, action: "fill", ref: "ref_1" },
    { tab_id: 1, action: "scroll" },
    { tab_id: 1, action: "click", ref: "#selector" },
  ]
  for (const args of cases) {
    const result = await client.callTool({ name: "browser_act", arguments: args })
    assert.equal(result.isError, true, JSON.stringify(args))
  }
  assert.deepEqual(calls, [])
})

test("only web URLs are accepted for navigation", async (t) => {
  const { client, calls } = await connect(t, () => ({}))
  const result = await client.callTool({
    name: "browser_navigate",
    arguments: { tab_id: 1, url: "chrome://settings" },
  })
  assert.equal(result.isError, true)
  assert.deepEqual(calls, [])
})

test("screenshots are scaled to viewport coordinates", async (t) => {
  const capture = await sharp({
    create: { width: 400, height: 200, channels: 3, background: "#123456" },
  })
    .jpeg()
    .toBuffer()
  const { client } = await connect(t, () => ({
    data: capture.toString("base64"),
    width: 200,
    height: 100,
  }))
  const result = await client.callTool({ name: "browser_screenshot", arguments: { tab_id: 1 } })
  const [image] = result.content as { data: string }[]
  const metadata = await sharp(Buffer.from(image?.data ?? "", "base64")).metadata()
  assert.deepEqual([metadata.width, metadata.height], [200, 100])
})
