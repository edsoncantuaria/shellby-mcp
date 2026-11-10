import assert from "node:assert/strict"
import test from "node:test"
import { type AgentIdentity, agentChatMarker } from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"

test("tracks current and recent tool activity for one agent", () => {
  let timestamp = 1_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = {
    sessionId: "session-a",
    agent: "agent-1",
    provider: "chatgpt",
    taskSlug: "dashboard",
  }

  const callId = observer.startTool(agent, "shell_run", { command: "npm test" })
  assert.ok(callId)
  assert.deepEqual(observer.listAgents()[0]?.current, {
    id: callId,
    tool: "shell_run",
    summary: "npm test",
    detail: "npm test",
    detailLanguage: "bash",
    startedAt: 1_000,
    status: "running",
  })

  timestamp = 1_500
  observer.finishTool(agent, callId)
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.current, undefined)
  assert.equal(snapshot?.recent[0]?.status, "completed")
  assert.equal(snapshot?.recent[0]?.finishedAt, 1_500)
})

test("queues and delivers steering instructions once", () => {
  let timestamp = 2_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = {
    sessionId: "session-a",
    agent: "agent-1",
    provider: "chatgpt",
    taskSlug: "dashboard",
  }

  observer.startTool(agent, "shell_run", { command: "npm test" })
  const instruction = observer.queueInstruction("agent-1", " Focus only on the dashboard. ")
  assert.equal(instruction?.message, "Focus only on the dashboard.")

  timestamp = 2_500
  assert.deepEqual(observer.drainInstructions(agent), [
    "Human instruction: Focus only on the dashboard.",
  ])
  assert.deepEqual(observer.drainInstructions(agent), [])
  assert.equal(observer.listAgents()[0]?.instructions[0]?.deliveredAt, 2_500)
})

test("cancels queued steering instructions before delivery", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", provider: "chatgpt" }

  observer.startTool(agent, "shell_run", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Do not run tests")
  assert.ok(instruction)
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), true)
  assert.deepEqual(observer.drainInstructions(agent), [])
  assert.deepEqual(observer.listAgents()[0]?.instructions, [])
})

test("does not cancel an instruction after it is delivered", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", provider: "chatgpt" }

  observer.startTool(agent, "shell_run", { command: "pwd" })
  const instruction = observer.queueInstruction("agent-1", "Keep going")
  assert.ok(instruction)
  assert.deepEqual(observer.drainInstructions(agent), ["Human instruction: Keep going"])
  assert.equal(observer.cancelInstruction("agent-1", instruction.id), false)
})

test("keeps steering instructions scoped to the intended agent", () => {
  const observer = createAgentObserver()
  const first: AgentIdentity = { sessionId: "session-a", agent: "agent-1", provider: "chatgpt" }
  const second: AgentIdentity = { sessionId: "session-b", agent: "agent-2", provider: "chatgpt" }

  observer.startTool(first, "shell_run", { command: "pwd" })
  observer.startTool(second, "shell_run", { command: "pwd" })
  observer.queueInstruction("agent-2", "Second agent only")

  assert.deepEqual(observer.drainInstructions(first), [])
  assert.deepEqual(observer.drainInstructions(second), ["Human instruction: Second agent only"])
})

test("emits snapshots when agent state changes", () => {
  const observer = createAgentObserver()
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", provider: "chatgpt" }
  const events: string[] = []
  const unsubscribe = observer.subscribe((event) => events.push(`${event.type}:${event.agent.id}`))

  const callId = observer.startTool(agent, "fetch_url", { url: "https://example.com" })
  observer.finishTool(agent, callId)
  unsubscribe()

  assert.deepEqual(events, ["agent_changed:agent-1", "agent_changed:agent-1"])
})

test("keeps concurrent tool calls from the same agent", () => {
  let timestamp = 3_000
  const observer = createAgentObserver(() => timestamp)
  const agent: AgentIdentity = { sessionId: "session-a", agent: "agent-1", provider: "chatgpt" }

  const first = observer.startTool(agent, "shell_run", { command: "npm test" })
  timestamp = 3_100
  const second = observer.startTool(agent, "fetch_url", { url: "https://example.com" })
  assert.equal(observer.listAgents()[0]?.current?.id, second)

  timestamp = 3_200
  observer.finishTool(agent, second)
  assert.equal(observer.listAgents()[0]?.current?.id, first)

  timestamp = 3_300
  observer.finishTool(agent, first)
  const snapshot = observer.listAgents()[0]
  assert.equal(snapshot?.current, undefined)
  assert.deepEqual(
    snapshot?.recent.map((call) => call.id),
    [first, second]
  )
})

test("claims pending instructions for chat delivery and returns them on failure", () => {
  const observer = createAgentObserver(() => 3_000)
  const agent: AgentIdentity = {
    sessionId: "session-a",
    agent: "agent-1",
    provider: "chatgpt",
    taskSlug: "dashboard",
  }
  const callId = observer.startTool(agent, "shell_run", { command: "npm test" })
  observer.queueInstruction("agent-1", "first")
  observer.queueInstruction("agent-1", "second")
  assert.equal(observer.chatDeliveryTarget("agent-1")?.busy, true)
  observer.finishTool(agent, callId)
  assert.deepEqual(observer.chatDeliveryTarget("agent-1"), {
    marker: agentChatMarker("session-a"),
    provider: "chatgpt",
    busy: false,
    pending: true,
  })

  const claimed = observer.claimInstructions("agent-1")
  assert.deepEqual(
    claimed.map((instruction) => instruction.message),
    ["first", "second"]
  )
  assert.equal(observer.chatDeliveryTarget("agent-1")?.pending, false)
  assert.deepEqual(observer.drainInstructions(agent), [])

  observer.releaseInstructions(
    "agent-1",
    claimed.map((instruction) => instruction.id)
  )
  assert.deepEqual(observer.drainInstructions(agent), [
    "Human instruction: first",
    "Human instruction: second",
  ])
})
