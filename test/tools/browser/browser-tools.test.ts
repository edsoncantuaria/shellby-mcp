import assert from "node:assert/strict"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
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
import { tempDir } from "../../helpers/temp.js"

type Call = [string, Record<string, unknown>]

async function connect(
  t: TestContext,
  respond: (method: string) => unknown,
  recordingsDir?: string
) {
  const calls: Call[] = []
  const bridge: BrowserCaller = {
    call: (async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])
      return respond(method)
    }) as BrowserCaller["call"],
    browsers: () => [{ id: "abc", name: "Home" }],
  }
  const server = new McpServer({ name: "browser-test", version: "1.0.0" })
  registerBrowserTools(
    createToolRegistrar(server, { structuredOutput: false }),
    bridge,
    recordingsDir
  )
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
      {
        tabId: 4,
        format: "tree",
        query: undefined,
        interactiveOnly: false,
        maxChars: 20_000,
        requestFrameOrigin: undefined,
      },
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
    { tab_id: 1, action: "drag", ref: "ref_1" },
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

test("lists browsers without a round trip to Chrome", async (t) => {
  const { client, calls } = await connect(t, () => "unused")
  const result = await client.callTool({ name: "browser_tabs", arguments: { action: "browsers" } })
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: "abc", name: "Home" }])
  assert.deepEqual(calls, [])
})

test("accepts refs from inside iframes and drag targets", async (t) => {
  const { client, calls } = await connect(t, () => "done")
  await client.callTool({
    name: "browser_act",
    arguments: { tab_id: 1, action: "drag", ref: "ref_2_7", to_x: 5, to_y: 6 },
  })
  assert.equal(calls[0]?.[1].ref, "ref_2_7")
  assert.equal(calls[0]?.[1].to_x, 5)
})

test("browser_resize needs a size or reset, not both", async (t) => {
  const { client, calls } = await connect(t, () => ({ width: 400, height: 800 }))
  const invalid = [
    { tab_id: 1 },
    { tab_id: 1, width: 400 },
    { tab_id: 1, width: 400, height: 800, reset: true },
  ]
  for (const args of invalid) {
    const result = await client.callTool({ name: "browser_resize", arguments: args })
    assert.equal(result.isError, true, JSON.stringify(args))
  }
  assert.deepEqual(calls, [])
  await client.callTool({ name: "browser_resize", arguments: { tab_id: 1, reset: true } })
  assert.equal(calls[0]?.[0], "resize")
})

test("uploads send file bytes with a name and type", async (t) => {
  const dir = await tempDir(t, "shellby-upload-")
  const path = join(dir, "note.txt")
  await writeFile(path, "hello")
  const { client, calls } = await connect(t, () => "attached")
  await client.callTool({ name: "browser_upload", arguments: { tab_id: 1, paths: [path] } })
  assert.deepEqual(calls[0]?.[1].files, [
    { name: "note.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") },
  ])
})

test("refuses directories without contacting Chrome", async (t) => {
  const dir = await tempDir(t, "shellby-upload-")
  const { client, calls } = await connect(t, () => "attached")
  const result = await client.callTool({
    name: "browser_upload",
    arguments: { tab_id: 1, paths: [dir] },
  })
  assert.equal(result.isError, true)
  assert.match(textOf(result), /NOT_A_FILE/u)
  assert.deepEqual(calls, [])
})

test("a stopped recording becomes an animated GIF with one frame size", async (t) => {
  const dir = await tempDir(t, "shellby-recording-")
  const frame = async (width: number, background: string) =>
    (
      await sharp({ create: { width, height: 100, channels: 3, background } })
        .jpeg()
        .toBuffer()
    ).toString("base64")
  const frames = [await frame(200, "#ff0000"), await frame(300, "#00ff00")]
  const { client } = await connect(t, () => ({ frames, skipped: 1 }), dir)
  const result = await client.callTool({
    name: "browser_record",
    arguments: { tab_id: 3, action: "stop" },
  })
  assert.match(textOf(result), /2 frames, 1 skipped/u)
  const [name] = await readdir(dir)
  const metadata = await sharp(await readFile(join(dir, name ?? "")), { pages: -1 }).metadata()
  assert.equal(metadata.format, "gif")
  assert.equal(metadata.pages, 2)
  assert.equal(metadata.width, 200)
})
