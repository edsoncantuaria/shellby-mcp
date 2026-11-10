import assert from "node:assert/strict"
import test from "node:test"
import { type AgentChatDeliveryResult, createChatDelivery } from "../../src/agent/chat-delivery.js"
import type { AgentIdentity } from "../../src/agent/context.js"
import { createAgentObserver } from "../../src/agent/observer.js"
import { latestToolResultMarker } from "../../src/tools/delegation/chatgpt-browser.js"

const agent: AgentIdentity = {
  sessionId: "session-a",
  agent: "agent-1",
  provider: "chatgpt",
  taskSlug: "dashboard",
}

function setup(results: Array<AgentChatDeliveryResult | Error>) {
  const observer = createAgentObserver()
  observer.startTool(agent, "shell_run", {})
  const sent: string[] = []
  let calls = 0
  const delivery = createChatDelivery(
    observer,
    {
      async deliverToAgentChat(_marker, claim) {
        calls += 1
        const result = results.shift() ?? "sent"
        if (result instanceof Error) {
          claim()
          throw result
        }
        if (result === "sent") {
          const message = claim()
          if (message) sent.push(message)
        }
        return result
      },
    },
    { pollMs: 1, missingGiveUpMs: 0 }
  )
  return { observer, delivery, sent, calls: () => calls }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 2))
  assert.ok(condition())
}

function finishRunning(observer: ReturnType<typeof createAgentObserver>): void {
  const id = observer.listAgents()[0]?.current?.id
  observer.finishTool(agent, id)
}

test("waits for the running tool, then sends queued messages together", async () => {
  const s = setup([])
  s.observer.queueInstruction("agent-1", "first")
  s.observer.queueInstruction("agent-1", "second")
  s.delivery.deliver("agent-1")
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(s.calls(), 0)

  finishRunning(s.observer)
  await until(() => s.sent.length === 1)
  assert.equal(s.sent[0], "first\n\nsecond")
  assert.equal(s.observer.chatDeliveryTarget("agent-1")?.pending, false)
})

test("keeps retrying while the chat is busy or holds a draft", async () => {
  const s = setup(["busy", "draft", "sent"])
  finishRunning(s.observer)
  s.observer.queueInstruction("agent-1", "hello")
  s.delivery.deliver("agent-1")
  await until(() => s.sent.length === 1)
  assert.equal(s.calls(), 3)
})

test("without a known chat the instruction stays for the next tool result", async () => {
  const s = setup(["missing"])
  finishRunning(s.observer)
  s.observer.queueInstruction("agent-1", "hello")
  s.delivery.deliver("agent-1")
  await until(() => s.calls() === 1)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(s.observer.drainInstructions(agent), ["Human instruction: hello"])
})

test("keeps looking for a chat that appears shortly after the instruction", async () => {
  const observer = createAgentObserver()
  observer.finishTool(agent, observer.startTool(agent, "shell_run", {}))
  const results: AgentChatDeliveryResult[] = ["missing", "missing", "sent"]
  const sent: Array<string | undefined> = []
  const delivery = createChatDelivery(
    observer,
    {
      async deliverToAgentChat(_marker, claim) {
        const result = results.shift() ?? "sent"
        if (result === "sent") sent.push(claim())
        return result
      },
    },
    { pollMs: 1, missingGiveUpMs: 60_000 }
  )
  observer.queueInstruction("agent-1", "hello")
  delivery.deliver("agent-1")
  await until(() => sent.length === 1)
  assert.deepEqual(sent, ["hello"])
})

test("a failed send returns the instruction to the queue", async () => {
  const s = setup([new Error("composer gone")])
  finishRunning(s.observer)
  s.observer.queueInstruction("agent-1", "hello")
  s.delivery.deliver("agent-1")
  await until(() => s.calls() === 1)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(s.observer.chatDeliveryTarget("agent-1")?.pending, true)
})

test("only tool results can link a conversation, and the newest one wins", () => {
  const marker = (c: string) => `shellby-agent:${c.repeat(16)}`
  const node = (role: string, text: string, create_time: number) => ({
    message: { author: { role }, content: { parts: [text] }, create_time },
  })
  assert.equal(
    latestToolResultMarker({
      mapping: {
        a: node("tool", `x ${marker("a")}`, 1),
        b: node("tool", `y ${marker("b")}`, 2),
        c: node("user", marker("c"), 3),
        d: { message: null },
      },
    }),
    marker("b")
  )
  assert.equal(latestToolResultMarker({ mapping: { c: node("user", marker("c"), 3) } }), undefined)
  assert.equal(
    latestToolResultMarker({
      messages: [node("tool", marker("a"), 1).message, node("user", marker("c"), 2).message],
    }),
    marker("a")
  )
  assert.equal(latestToolResultMarker(undefined), undefined)
})
