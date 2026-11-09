import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { MCP_CONFIG } from "../../src/config.js"
import { createChatGptDelegationService } from "../../src/tools/delegation/chatgpt-service.js"
import { createDelegationStore } from "../../src/tools/delegation/store.js"
import { startMcpHttpServer } from "../integrations/helpers.js"

const LIVE_TEST_ENABLED = process.env.RUN_LIVE_SUBAGENT_TESTS === "1" && !process.env.CI
const LIVE_AGENT_ID = "live-subagent-integration"
const SECOND_AGENT_ID = "live-subagent-independent"
const LIVE_TIMEOUT_MS = 4 * 60_000
const LIVE_PROCESS_HARD_CAP_MS = 5 * 60_000
const POLL_WAIT_MS = 30_000
const ARTIFACT_DIR = new URL("./artifacts/", import.meta.url)

if (LIVE_TEST_ENABLED) {
  const hardExitTimer = setTimeout(() => {
    console.error("Live subagent test exceeded the 5-minute process hard cap; forcing exit.")
    process.exit(124)
  }, LIVE_PROCESS_HARD_CAP_MS)
  hardExitTimer.unref()
}

interface StructuredRunTurn {
  agent_id: string
  turn_id?: string
  status: "running" | "failed"
  error?: string
}

interface StructuredResultTurn {
  turn_id: string
  status: "running" | "completed" | "failed"
  activity?: string
  activity_age_ms?: number
  response?: string
  error?: string
}

interface PollDiagnostic {
  elapsed_ms: number
  status: StructuredResultTurn["status"]
  activity?: string
  activity_age_ms?: number
  response_present: boolean
  model_text_excerpt?: string
}

test("live MCP runs two independent agents concurrently and continues one conversation", {
  skip: !LIVE_TEST_ENABLED,
  timeout: LIVE_TIMEOUT_MS,
}, async (t) => {
  const contextKey = `LIVE_CTX_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const secondContextKey = `LIVE_CTX_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const firstPrompt = [
    "This is a live subagent lifecycle test. Do not use tools.",
    `Remember this exact context key for the next turn: ${contextKey}`,
    "Reply briefly and include the context key in your response.",
  ].join("\n")
  const artifact: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    agent_id: LIVE_AGENT_ID,
    context_key: contextKey,
    second_context_key: secondContextKey,
  }
  const pollTimeline: Record<string, PollDiagnostic[]> = {}
  artifact.poll_timeline = pollTimeline

  t.after(async () => {
    await writeLiveArtifact(artifact).catch(() => undefined)
  })

  try {
    const running = await startMcpHttpServer({
      chatGptDelegation: createChatGptDelegationService(),
      profile: {
        tools: {
          review: false,
          shell: false,
          applyPatch: false,
          fileRead: false,
          fileWrite: false,
          clones: false,
          subagents: true,
          web: false,
          skills: false,
          image: false,
          computer: false,
        },
      },
    })
    t.after(() => running.close().catch(() => undefined))

    const client = new Client(
      { name: "live-subagent-integration-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    )
    t.after(() => client.close().catch(() => undefined))
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))

    t.diagnostic("Production MCP server started")

    const firstRun = await client.callTool({
      name: "subagent_run",
      arguments: {
        agents: [
          { agent_id: LIVE_AGENT_ID, prompt: firstPrompt },
          {
            agent_id: SECOND_AGENT_ID,
            prompt: `This is a live independent agent test. Do not use tools. Reply briefly and include this exact key: ${secondContextKey}`,
          },
        ],
      },
    })
    const firstRunTurns = getRunTurns(toolText(firstRun.content))
    if (firstRunTurns.some((turn) => turn.status === "failed"))
      t.diagnostic(`Initial MCP response: ${toolText(firstRun.content)}`)
    t.diagnostic(
      `Initial submissions: ${firstRunTurns.map((turn) => `${turn.agent_id}: ${turn.status}${turn.error ? ` (${turn.error})` : ""}`).join("; ")}`
    )
    assert.equal(firstRunTurns.length, 2)
    const firstRunTurn = firstRunTurns.find((turn) => turn.agent_id === LIVE_AGENT_ID)
    const secondRunTurn = firstRunTurns.find((turn) => turn.agent_id === SECOND_AGENT_ID)
    assert.ok(firstRunTurn && secondRunTurn)
    assert.equal(firstRunTurn.agent_id, LIVE_AGENT_ID)
    assert.equal(
      firstRunTurn.status,
      "running",
      firstRunTurn.error ?? "subagent_run did not start turn 1"
    )
    assert.ok(firstRunTurn.turn_id)
    assert.equal(secondRunTurn.status, "running", secondRunTurn.error)
    assert.ok(secondRunTurn.turn_id)
    assert.notEqual(firstRunTurn.turn_id, secondRunTurn.turn_id)
    t.diagnostic(`Turn 1 submitted: ${firstRunTurn.turn_id}`)

    const [firstCompletion, independentCompletion] = await Promise.all([
      waitForCompletedTurn(client, firstRunTurn.turn_id, (entry) => {
        ;(pollTimeline.turn_1 ??= []).push(entry)
        t.diagnostic(formatPollDiagnostic("Turn 1", entry))
      }),
      waitForCompletedTurn(client, secondRunTurn.turn_id, (entry) => {
        ;(pollTimeline.independent ??= []).push(entry)
        t.diagnostic(formatPollDiagnostic("Independent", entry))
      }),
    ])
    const firstResponse = firstCompletion.turn.response ?? ""
    assert.ok(firstResponse.trim(), "Turn 1 must return a non-empty response")
    assert.ok(firstResponse.includes(contextKey), "Turn 1 must include the supplied context key")
    assert.ok(!firstResponse.includes(secondContextKey), "Agent responses must remain separate")
    assert.ok(independentCompletion.turn.response?.includes(secondContextKey))
    assert.ok(!independentCompletion.turn.response?.includes(contextKey))
    const store = createDelegationStore(join(MCP_CONFIG.stateDir, "subagents.sqlite"))
    t.after(() => store.close())
    const firstConversation = store.get(undefined, LIVE_AGENT_ID)?.conversationUrl
    const independentConversation = store.get(undefined, SECOND_AGENT_ID)?.conversationUrl
    assert.ok(firstConversation && independentConversation, "Both conversations must be persisted")
    assert.notEqual(
      firstConversation,
      independentConversation,
      "Agents must have distinct conversations"
    )
    t.diagnostic("Turn 1 completed with a non-empty response containing the supplied context key")

    artifact.turn_1 = {
      turn_id: firstRunTurn.turn_id,
      mcp_response: firstResponse,
      independent_turn_id: secondRunTurn.turn_id,
      independent_response: independentCompletion.turn.response,
    }

    const secondPrompt =
      "What exact context key did I ask you to remember in my immediately previous message? Include that key in your response."
    const secondRun = await client.callTool({
      name: "subagent_run",
      arguments: {
        agents: [{ agent_id: LIVE_AGENT_ID, prompt: secondPrompt }],
      },
    })
    const continuationTurn = getRunTurns(toolText(secondRun.content))[0]!
    assert.equal(continuationTurn.agent_id, LIVE_AGENT_ID)
    assert.equal(
      continuationTurn.status,
      "running",
      continuationTurn.error ?? "subagent_run did not start turn 2"
    )
    assert.ok(continuationTurn.turn_id)
    t.diagnostic(`Turn 2 submitted on same agent: ${continuationTurn.turn_id}`)

    const secondCompletion = await waitForCompletedTurn(
      client,
      continuationTurn.turn_id,
      (entry) => {
        ;(pollTimeline.turn_2 ??= []).push(entry)
        t.diagnostic(formatPollDiagnostic("Turn 2", entry))
      }
    )
    const secondResponse = secondCompletion.turn.response?.trim()
    assert.ok(secondResponse, "Turn 2 must return a non-empty response")
    assert.ok(
      secondResponse.includes(contextKey),
      "Turn 2 must recover context that was only supplied in Turn 1"
    )

    t.diagnostic(
      "Turn 2 recovered context supplied only through Turn 1 using the same public agent_id"
    )

    artifact.turn_2 = {
      turn_id: continuationTurn.turn_id,
      mcp_response: secondResponse,
      recovered_turn_1_context: true,
    }
    artifact.result = "pass"

    t.diagnostic("LIVE SUBAGENT INTEGRATION: PASS")
    t.diagnostic(
      `Sanitized evidence: ${join(new URL(ARTIFACT_DIR).pathname, "subagent-live-last.json")}`
    )
  } catch (error) {
    artifact.result = "fail"
    artifact.failure = serializeError(error)
    artifact.failed_at = new Date().toISOString()
    t.diagnostic(
      `LIVE SUBAGENT INTEGRATION: FAIL ${error instanceof Error ? error.message : String(error)}`
    )
    throw error
  }
})

function getRunTurns(text: string): StructuredRunTurn[] {
  const pattern =
    /^- agent_id=("(?:\\.|[^"\\])*"|\S+)(?: turn_id=("(?:\\.|[^"\\])*"|\S+))? status=(running|failed)(?: error=("(?:\\.|[^"\\])*"|\S+))?$/gmu
  const turns = [...text.matchAll(pattern)].map((match) => ({
    agent_id: decodeCompactScalar(match[1]!),
    ...(match[2] ? { turn_id: decodeCompactScalar(match[2]) } : {}),
    status: match[3] as StructuredRunTurn["status"],
    ...(match[4] ? { error: decodeCompactScalar(match[4]) } : {}),
  }))
  assert.ok(turns.length > 0, "subagent_run must return live turns")
  return turns
}

async function waitForCompletedTurn(
  client: Client,
  turnId: string,
  onPoll?: (diagnostic: PollDiagnostic) => void
): Promise<{ turn: StructuredResultTurn; observedTexts: string[] }> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS - 15_000
  const startedAt = Date.now()
  const observedTexts: string[] = []

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await client.callTool({
      name: "subagent_result",
      arguments: {
        turn_ids: [turnId],
        wait_ms: Math.min(POLL_WAIT_MS, Math.max(0, remaining)),
      },
    })
    const text = toolText(result.content)
    observedTexts.push(text)
    const turn = parseResultTurn(text)
    onPoll?.({
      elapsed_ms: Date.now() - startedAt,
      status: turn.status,
      activity: turn.activity,
      activity_age_ms: turn.activity_age_ms,
      response_present: typeof turn.response === "string" && turn.response.length > 0,
      model_text_excerpt: excerpt(observedTexts.at(-1) ?? ""),
    })
    if (turn.status === "completed") return { turn, observedTexts }
    if (turn.status === "failed")
      throw new Error(`Live subagent turn failed: ${turn.error ?? turnId}`)
  }

  throw new Error(`Timed out waiting for live subagent turn ${turnId}`)
}

function formatPollDiagnostic(label: string, entry: PollDiagnostic): string {
  const activity = entry.activity ? ` activity=${JSON.stringify(entry.activity)}` : ""
  const age = entry.activity_age_ms === undefined ? "" : ` activity_age_ms=${entry.activity_age_ms}`
  return `${label} poll +${entry.elapsed_ms}ms status=${entry.status}${activity}${age} response=${entry.response_present ? "yes" : "no"}`
}

function excerpt(value: string, max = 800): string | undefined {
  if (!value) return undefined
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      const record =
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : undefined
      return record?.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

async function writeLiveArtifact(artifact: Record<string, unknown>): Promise<void> {
  const directory = new URL(ARTIFACT_DIR)
  await mkdir(directory, { recursive: true })
  await writeFile(
    new URL("subagent-live-last.json", directory),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  )
}

function parseResultTurn(text: string): StructuredResultTurn {
  const match = text.match(
    /^---- turn_id=("(?:\\.|[^"\\])*"|\S+) status=(running|completed|failed)(?: activity=("(?:\\.|[^"\\])*"|\S+))?(?: activity_age_ms=(\d+))? ----(?:\n\n([\s\S]*))?$/u
  )
  assert.ok(match, "subagent_result must return exactly one live turn")
  const status = match[2] as StructuredResultTurn["status"]
  const body = match[5]
  return {
    turn_id: decodeCompactScalar(match[1]!),
    status,
    ...(match[3] ? { activity: decodeCompactScalar(match[3]) } : {}),
    ...(match[4] ? { activity_age_ms: Number(match[4]) } : {}),
    ...(status === "completed" && body ? { response: body } : {}),
    ...(status === "failed" && body ? { error: body } : {}),
  }
}

function decodeCompactScalar(value: string): string {
  return value.startsWith('"') ? (JSON.parse(value) as string) : value
}
