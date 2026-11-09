import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { PeekabooXClient } from "../../src/tools/computer/peekaboox.js"
import { connectClient, startMcpHttpServer } from "./helpers.js"

test("Linux Computer Use registers PeekabooX tools and preserves real command failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shellby-peekaboox-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logPath = join(directory, "commands.jsonl")
  const fixture = fileURLToPath(new URL("../fixtures/fake-peekaboox.mjs", import.meta.url))
  const peekaboox = new PeekabooXClient({
    executable: process.execPath,
    baseArgs: [fixture, logPath],
    socketPath: join(directory, "daemon.sock"),
  })
  const running = await startMcpHttpServer({ peekaboox })
  t.after(() => running.close())
  const connected = await connectClient(running.url, "peekaboox-client")
  t.after(() => connected.client.close())

  const tools = await connected.client.listTools()
  assert.deepEqual(
    tools.tools.filter((tool) => tool.name.startsWith("computer_")).map((tool) => tool.name),
    [
      "computer_list",
      "computer_observe",
      "computer_inspect",
      "computer_click",
      "computer_type",
      "computer_hotkey",
      "computer_scroll",
    ]
  )

  const windows = await connected.client.callTool({
    name: "computer_list",
    arguments: { kind: "windows" },
  })
  assert.deepEqual(windows.structuredContent, { windows: [{ id: "atspi:1", title: "Fixture" }] })

  const observed = await connected.client.callTool({ name: "computer_observe", arguments: {} })
  assert.equal(observed.isError, undefined, JSON.stringify(observed))
  assert.deepEqual(
    observed.content.map((part) => part.type),
    ["text", "image"]
  )

  const click = await connected.client.callTool({
    name: "computer_click",
    arguments: { x: 10, y: 20, dry_run: true },
  })
  assert.deepEqual(click.structuredContent, { command: "click", dry_run: true })
  const typed = await connected.client.callTool({
    name: "computer_type",
    arguments: { text: "hello" },
  })
  assert.equal(typed.isError, true)
  assert.match(typed.content[0]?.type === "text" ? typed.content[0].text : "", /install wtype/u)

  const calls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.ok(calls.every((args) => args[0] === "--daemon" && args[1] === "--socket"))
  assert.ok(calls.some((args) => args.includes("--dry-run") && args.includes("--x")))
})
