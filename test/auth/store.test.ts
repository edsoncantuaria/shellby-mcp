import assert from "node:assert/strict"
import { readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import process from "node:process"
import test from "node:test"
import { ShellbyAuthError, ShellbyAuthStore } from "../../src/auth/store.js"
import { tempDir } from "../helpers/temp.js"

test("creates durable auth state with owner-only permissions", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-")
  const filePath = join(root, ".shellby", "auth.json")
  const auth = new ShellbyAuthStore(filePath)

  const first = await auth.ensureState()
  const second = await new ShellbyAuthStore(filePath).ensureState()

  assert.deepEqual(first, { version: 2, subjects: [], openSlots: 1 })
  assert.deepEqual(second, first)
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), first)

  if (process.platform !== "win32") {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(filePath))).mode & 0o777, 0o700)
  }
})

test("first tool call binds one subject and later calls require it", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-bind-")
  const auth = new ShellbyAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  assert.deepEqual((await auth.authorizeToolCall("subject-a")).subjects, ["subject-a"])
  assert.deepEqual((await auth.authorizeToolCall("subject-a")).subjects, ["subject-a"])
  await assert.rejects(
    () => auth.authorizeToolCall("subject-b"),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "subject_mismatch"
  )
})

test("concurrent first tool calls bind exactly one subject", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-race-")
  const auth = new ShellbyAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  const results = await Promise.allSettled([
    auth.authorizeToolCall("subject-a"),
    auth.authorizeToolCall("subject-b"),
  ])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
})

test("an opened slot binds exactly one more subject", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-slot-")
  const filePath = join(root, "auth.json")
  const auth = new ShellbyAuthStore(filePath)
  await auth.ensureState()
  await auth.authorizeToolCall("subject-a")

  assert.equal((await auth.openSlot()).openSlots, 1)
  assert.deepEqual(await auth.authorizeToolCall("subject-a"), {
    version: 2,
    subjects: ["subject-a"],
    openSlots: 1,
  })
  assert.deepEqual(await auth.authorizeToolCall("subject-b"), {
    version: 2,
    subjects: ["subject-a", "subject-b"],
    openSlots: 0,
  })
  await assert.rejects(
    () => auth.authorizeToolCall("subject-c"),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "subject_mismatch"
  )
  assert.deepEqual((await new ShellbyAuthStore(filePath).readState()).subjects, [
    "subject-a",
    "subject-b",
  ])
  assert.ok((await auth.authorizeToolCall("subject-a")).subjects.includes("subject-a"))
})

test("version 1 state keeps its binding and stays closed to other subjects", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-v1-")
  const filePath = join(root, "auth.json")
  await writeFile(filePath, `${JSON.stringify({ version: 1, subject: "subject-a" })}\n`, {
    mode: 0o600,
  })
  const auth = new ShellbyAuthStore(filePath)

  assert.deepEqual(await auth.ensureState(), {
    version: 2,
    subjects: ["subject-a"],
    openSlots: 0,
  })
  await assert.rejects(
    () => auth.authorizeToolCall("subject-b"),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "subject_mismatch"
  )

  await writeFile(filePath, `${JSON.stringify({ version: 1, subject: null })}\n`, { mode: 0o600 })
  assert.deepEqual(await auth.readState(), { version: 2, subjects: [], openSlots: 1 })
})

test("reset clears every bound subject", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-reset-")
  const auth = new ShellbyAuthStore(join(root, "auth.json"))
  await auth.ensureState()
  await auth.authorizeToolCall("subject-a")
  await auth.openSlot()
  await auth.authorizeToolCall("subject-b")

  assert.deepEqual(await auth.reset(), { version: 2, subjects: [], openSlots: 1 })
})

test("malformed auth state fails closed instead of being replaced", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-invalid-")
  const filePath = join(root, "auth.json")
  await writeFile(filePath, "not-json\n", { mode: 0o600 })
  const auth = new ShellbyAuthStore(filePath)

  await assert.rejects(
    () => auth.ensureState(),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "state_invalid"
  )
  assert.equal(await readFile(filePath, "utf8"), "not-json\n")
})

test("hybrid mode authorizes verified tunnel requests without openai subject", async (t) => {
  const root = await tempDir(t, "shellby-mcp-auth-hybrid-")
  const auth = new ShellbyAuthStore(join(root, "auth.json"))
  await auth.ensureState()

  // First bind a ChatGPT subject
  await auth.authorizeToolCall({
    openaiSubject: "chatgpt-user-1",
    tunnelAuth: true,
    mode: "hybrid",
  })
  assert.deepEqual((await auth.readState()).subjects, ["chatgpt-user-1"])

  // Another ChatGPT subject is rejected
  await assert.rejects(
    () =>
      auth.authorizeToolCall({ openaiSubject: "chatgpt-user-2", tunnelAuth: true, mode: "hybrid" }),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "subject_mismatch"
  )

  // Gemini / non-OpenAI caller with tunnel verification is authorized
  const geminiState = await auth.authorizeToolCall({ tunnelAuth: true, mode: "hybrid" })
  assert.deepEqual(geminiState.subjects, ["chatgpt-user-1"])

  // Unverified remote caller without openai subject is rejected
  await assert.rejects(
    () => auth.authorizeToolCall({ tunnelAuth: false, mode: "hybrid" }),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "subject_missing"
  )

  // chatgpt mode rejects tunnel callers without openai subject
  await assert.rejects(
    () => auth.authorizeToolCall({ tunnelAuth: true, mode: "chatgpt" }),
    (error: unknown) => error instanceof ShellbyAuthError && error.code === "subject_missing"
  )
})
