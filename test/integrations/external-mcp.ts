import assert from "node:assert/strict"
import process from "node:process"
import type { TestContext } from "node:test"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  ExternalMcpManager,
  type ExternalMcpManagerOptions,
  type ExternalMcpServerConfig,
} from "../../src/tools/external-mcp/external-mcp-manager.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-external-mcp.mjs", import.meta.url))
const FAKE_SERVER: ExternalMcpServerConfig = {
  command: process.execPath,
  args: [FIXTURE, "--serve"],
  env: { CONFIGURED_VALUE: "from-config" },
}
const TIMEOUT = { timeout: 30_000 }

async function connect(
  t: TestContext,
  servers: Record<string, ExternalMcpServerConfig> = { fake: FAKE_SERVER },
  options: ExternalMcpManagerOptions = {}
) {
  const manager = new ExternalMcpManager(servers, options)
  const running = await startMcpHttpServer({
    externalMcp: manager,
    profile: {
      tools: {
        shell: false,
        clones: false,
        subagents: false,
        web: false,
        computer: false,
        externalMcp: true,
      },
    },
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "external-mcp-integration-client")
  t.after(() => connected.client.close())
  const call = (tool: string, args: Record<string, unknown> = {}, server = "fake") =>
    connected.client.callTool({
      name: "mcp_call",
      arguments: { server, tool, arguments: args },
    })
  return { client: connected.client, manager, call }
}

function firstText(result: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["call"]>>) {
  const block = result.content[0]
  assert.equal(block?.type, "text")
  return block?.type === "text" ? block.text : ""
}

test("omits external MCP tools when no server is configured", TIMEOUT, async (t) => {
  const running = await startMcpHttpServer({
    profile: {
      tools: { shell: false, clones: false, subagents: false, web: false, computer: false },
    },
  })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "external-mcp-disabled-client")
  t.after(() => connected.client.close())

  const { tools } = await connected.client.listTools()
  assert.equal(
    tools.some((tool) => tool.name.startsWith("mcp_")),
    false
  )
})

test("lists a configured server's tools, schemas, and instructions", TIMEOUT, async (t) => {
  const { client } = await connect(t)

  const result = await client.callTool({ name: "mcp_list_tools", arguments: { server: "fake" } })
  assert.equal(result.isError, undefined)
  const block = result.content[0]
  assert.ok(block?.type === "text")
  const listed = JSON.parse(block.text)
  assert.equal(listed.instructions, "Fake server instructions.")
  const echo = listed.tools.find((tool: { name: string }) => tool.name === "echo")
  assert.equal(echo.description, "Echo a value.")
  assert.deepEqual(echo.inputSchema.required, ["value"])
})

test("rejects a server the operator did not configure", TIMEOUT, async (t) => {
  const { call } = await connect(t)

  const result = await call("echo", { value: "x" }, "not-configured")
  assert.equal(result.isError, true)
})

test("passes arguments through and shares one process per server", TIMEOUT, async (t) => {
  const { call } = await connect(t)

  const [first, second] = await Promise.all([
    call("echo", { value: "a" }),
    call("echo", { value: "b" }),
  ])
  const a = JSON.parse(firstText(first))
  const b = JSON.parse(firstText(second))
  assert.deepEqual([a.value, b.value], ["a", "b"])
  assert.equal(a.pid, b.pid)
})

test(
  "gives a server its configured environment and the desktop session only",
  TIMEOUT,
  async (t) => {
    const originalDisplay = process.env.DISPLAY
    process.env.SHELLBY_TEST_PARENT_SECRET = "must-not-leak"
    process.env.DISPLAY = ":test"
    t.after(() => {
      delete process.env.SHELLBY_TEST_PARENT_SECRET
      if (originalDisplay === undefined) delete process.env.DISPLAY
      else process.env.DISPLAY = originalDisplay
    })
    const { call } = await connect(t)

    assert.deepEqual(JSON.parse(firstText(await call("env"))), {
      configured: "from-config",
      display: ":test",
    })
  }
)

test("returns external images as native encoded content", TIMEOUT, async (t) => {
  const { call } = await connect(t)

  const result = await call("image")
  assert.equal(result.isError, undefined)
  const block = result.content[0]
  assert.ok(block?.type === "image")
  assert.equal(block.mimeType, "image/jpeg")
  assert.ok(block.data.length > 0)
})

test("bounds external text and says when it was cut", TIMEOUT, async (t) => {
  const { call } = await connect(t)

  const result = await call("big")
  assert.ok(firstText(result).length < "word ".repeat(40_000).length)
  const last = result.content.at(-1)
  assert.ok(last?.type === "text")
  assert.match(last.text, /truncated at \d+ tokens/)
})

test("reports binary content it cannot forward", TIMEOUT, async (t) => {
  const { call } = await connect(t)

  assert.equal(firstText(await call("audio")), "[Omitted binary audio content.]")
})

test("forwards a tool error from the external server", TIMEOUT, async (t) => {
  const { call } = await connect(t)

  const result = await call("fails")
  assert.equal(result.isError, true)
  assert.equal(firstText(result), "remote tool failed")
})

test("reports a crash without replaying it, then restarts the server", TIMEOUT, async (t) => {
  const { call } = await connect(t)
  const before = JSON.parse(firstText(await call("echo", { value: "a" })))

  const crashed = await call("crash")
  assert.equal(crashed.isError, true)
  assert.match(firstText(crashed), /outcome is unknown/)

  const after = JSON.parse(firstText(await call("echo", { value: "b" })))
  assert.equal(after.value, "b")
  assert.notEqual(after.pid, before.pid)
})

test("reports a call that exceeds its time limit", TIMEOUT, async (t) => {
  const { call } = await connect(t, undefined, { callTimeoutMs: 200 })

  const result = await call("slow")
  assert.equal(result.isError, true)
  assert.match(firstText(result), /may still be running/)
})

test("a server that cannot start does not affect the others", TIMEOUT, async (t) => {
  const { call } = await connect(t, {
    fake: FAKE_SERVER,
    broken: {
      command: process.execPath,
      args: ["-e", "console.error('boom from stderr'); process.exit(3)"],
      env: {},
    },
  })

  const failed = await call("anything", {}, "broken")
  assert.equal(failed.isError, true)
  assert.match(firstText(failed), /"broken" failed to start/)
  assert.match(firstText(failed), /boom from stderr/)

  assert.equal(JSON.parse(firstText(await call("echo", { value: "ok" }))).value, "ok")
})

test("close stops the servers and refuses new work", TIMEOUT, async (t) => {
  const { call, manager } = await connect(t)
  const { pid } = JSON.parse(firstText(await call("echo", { value: "a" })))

  await manager.close()

  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  const result = await call("echo", { value: "b" })
  assert.equal(result.isError, true)
  assert.match(firstText(result), /shutting down/)
})
