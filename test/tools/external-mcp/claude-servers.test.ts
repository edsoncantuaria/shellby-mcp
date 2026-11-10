import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

import { readClaudeMcpServers } from "../../../src/public-config.cjs"

async function settingsPath(t: TestContext, content: string) {
  const root = await mkdtemp(join(tmpdir(), "shellby-claude-servers-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, ".claude.json")
  await writeFile(path, content)
  return path
}

function warnings(t: TestContext) {
  const warn = t.mock.method(console, "warn", () => undefined)
  return () => warn.mock.calls.map((call) => String(call.arguments[0]))
}

test("imports user-scope stdio servers and ignores Claude's own fields", async (t) => {
  const path = await settingsPath(
    t,
    JSON.stringify({
      oauthAccount: { token: "unrelated" },
      mcpServers: {
        godot: { type: "stdio", command: "node", args: ["index.js"], env: { A: "1" } },
        untyped: { command: "tool" },
      },
      projects: { "/x": { mcpServers: { scoped: { command: "other" } } } },
    })
  )

  assert.deepEqual(readClaudeMcpServers(path, []), {
    godot: { command: "node", args: ["index.js"], cwd: undefined, env: { A: "1" } },
    untyped: { command: "tool", args: [], cwd: undefined, env: {} },
  })
})

test("imports remote servers that need no static headers", async (t) => {
  const seen = warnings(t)
  const path = await settingsPath(
    t,
    JSON.stringify({
      mcpServers: {
        remote: { type: "http", url: "https://mcp.example.test/mcp" },
        insecure: { type: "http", url: "http://mcp.example.test/mcp" },
      },
    })
  )

  assert.deepEqual(readClaudeMcpServers(path, []), {
    remote: { url: "https://mcp.example.test/mcp" },
  })
  assert.equal(seen().length, 1)
})

test("leaves excluded servers out without warning", async (t) => {
  const seen = warnings(t)
  const path = await settingsPath(
    t,
    JSON.stringify({ mcpServers: { keep: { command: "a" }, whatsapp: { command: "b" } } })
  )

  assert.deepEqual(Object.keys(readClaudeMcpServers(path, ["whatsapp"])), ["keep"])
  assert.deepEqual(seen(), [])
})

test("skips unusable servers by name without exposing their settings", async (t) => {
  const seen = warnings(t)
  const path = await settingsPath(
    t,
    JSON.stringify({
      mcpServers: {
        remote: { type: "http", url: "https://example.test", headers: { Authorization: "secret" } },
        "Bad Name": { command: "a" },
        badenv: { command: "a", env: { TOKEN: 123 } },
        good: { command: "a" },
      },
    })
  )

  assert.deepEqual(Object.keys(readClaudeMcpServers(path, [])), ["good"])
  assert.equal(seen().length, 3)
  assert.equal(seen().join("\n").includes("secret"), false)
})

test("imports nothing from a missing or corrupt file without quoting it", async (t) => {
  const seen = warnings(t)
  const path = await settingsPath(t, '{"mcpServers": {"a": "secret-value",')

  assert.deepEqual(readClaudeMcpServers(path, []), {})
  assert.deepEqual(readClaudeMcpServers(`${path}.missing`, []), {})
  assert.equal(seen().length, 2)
  assert.equal(seen().join("\n").includes("secret-value"), false)
})
