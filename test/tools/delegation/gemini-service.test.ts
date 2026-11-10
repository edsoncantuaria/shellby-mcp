import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { Script } from "node:vm"

import { agentChatMarker, runWithAgent } from "../../../src/agent/context.js"
import { MCP_CONFIG } from "../../../src/config.js"
import {
  ChatGptDelegationError,
  type ChatGptDelegationService,
} from "../../../src/tools/delegation/contracts.js"
import { createDelegationRouter } from "../../../src/tools/delegation/delegation-router.js"
import type { GeminiTabs } from "../../../src/tools/delegation/gemini-browser.js"
import {
  GEMINI_SNAPSHOT_SCRIPT,
  GEMINI_TRANSCRIPT_SCRIPT,
  geminiAttachImageScript,
  geminiSendScript,
  isGeminiConversationUrl,
} from "../../../src/tools/delegation/gemini-page.js"
import { createGeminiDelegationService } from "../../../src/tools/delegation/gemini-service.js"

const CHAT_URL = "https://gemini.google.com/app/abc123"

interface FakeTab {
  tab_id: number
  url: string
  users: number
  models: number
  text: string
  generating: boolean
  draft: boolean
  sent: string[]
  images: number
}

/** Stands in for Chrome: answers the bridge methods with the state of fake Gemini tabs. */
function fakeBrowser(answer = "BANANA") {
  const tabs = new Map<number, FakeTab>()
  let nextId = 1
  const addTab = (url: string, overrides: Partial<FakeTab> = {}): FakeTab => {
    const tab: FakeTab = {
      tab_id: nextId++,
      url,
      users: 0,
      models: 0,
      text: "",
      generating: false,
      draft: false,
      sent: [],
      images: 0,
      ...overrides,
    }
    tabs.set(tab.tab_id, tab)
    return tab
  }
  const browser: GeminiTabs = {
    list: async () => [...tabs.values()].map(({ tab_id, url }) => ({ tabId: tab_id, url })),
    open: async (url) => addTab(url).tab_id,
    close: async (tabId) => {
      tabs.delete(tabId)
    },
    disconnect: async () => undefined,
    // biome-ignore lint/suspicious/noExplicitAny: each script owns its result shape.
    evaluate: async (tabId: number, expression: string): Promise<any> => {
      const tab = tabs.get(tabId)
      if (!tab) throw new ChatGptDelegationError("AGENT_TARGET_LOST", "gone")
      if (expression === GEMINI_SNAPSHOT_SCRIPT) {
        const { users, models, text, generating, draft, url } = tab
        return { ready: true, draft, generating, confirming: false, users, models, text, url }
      }
      if (expression.startsWith("(async (data, type, name)")) {
        if (tab.draft) return "draft"
        tab.images += 1
        return "attached"
      }
      const message = /^\(async \(message\)[\s\S]*\}\)\((".*")\)$/u.exec(expression)?.[1]
      if (message === undefined) return false
      if (tab.generating) return "busy"
      if (tab.draft) return "draft"
      tab.sent.push(JSON.parse(message))
      tab.users += 1
      tab.models = tab.users
      tab.text = answer
      tab.url = CHAT_URL
      return "sent"
    },
  }
  return { browser, tabs, addTab }
}

function setup(t: TestContext, answer?: string) {
  const directory = mkdtempSync(join(tmpdir(), "shellby-gemini-"))
  const previous = MCP_CONFIG.stateDir
  MCP_CONFIG.stateDir = directory
  const fake = fakeBrowser(answer)
  const service = createGeminiDelegationService(fake.browser, { pollMs: 1 })
  t.after(async () => {
    await service.dispose()
    MCP_CONFIG.stateDir = previous
    rmSync(directory, { recursive: true, force: true })
  })
  const asGemini = <T>(callback: () => T) =>
    runWithAgent(`gemini-test-${directory}`, callback, "gemini")
  const marker = agentChatMarker(`gemini-test-${directory}`)
  return { ...fake, service, asGemini, marker }
}

test("a subagent opens a Gemini tab, sends once, and returns the response", async (t) => {
  const { service, tabs, asGemini } = setup(t)
  const result = await asGemini(async () => {
    const turnId = await service.ask({ agentId: "a", prompt: "hi", memory: true }, {})
    return service.poll(turnId, 5_000)
  })
  assert.equal(result.status, "completed")
  assert.equal(result.response, "BANANA")
  const [tab] = [...tabs.values()]
  assert.equal(tab?.sent.length, 1)
  assert.match(tab?.sent[0] ?? "", /^hi\n\n---/u)
})

test("a follow-up reuses the tab and reports completion once as an event", async (t) => {
  const { service, tabs, asGemini } = setup(t)
  await asGemini(async () => {
    await service.poll(await service.ask({ agentId: "a", prompt: "1", memory: true }, {}), 5_000)
    const second = await service.ask({ agentId: "a", prompt: "2", memory: true }, {})
    assert.equal(second, "a_turn_2")
    await service.poll(second, 5_000)
    assert.deepEqual(service.drainEvents(), [
      "agent_finished agent_id=a turn_id=a_turn_1",
      "agent_finished agent_id=a turn_id=a_turn_2",
    ])
    assert.deepEqual(service.drainEvents(), [])
  })
  assert.equal(tabs.size, 1)
  assert.equal([...tabs.values()][0]?.sent[1], "2")
})

test("a closed tab fails the running turn instead of hanging", async (t) => {
  const { service, tabs, asGemini } = setup(t, "")
  const result = await asGemini(async () => {
    const turnId = await service.ask({ agentId: "a", prompt: "hi", memory: true }, {})
    tabs.clear()
    return service.poll(turnId, 5_000)
  })
  assert.equal(result.status, "failed")
  assert.equal(result.errorCode, "AGENT_TARGET_LOST")
})

test("clone_self seeds a new chat and refuses a non-Gemini source", async (t) => {
  const { service, tabs, asGemini } = setup(t)
  await asGemini(async () => {
    await assert.rejects(
      service.cloneSelf(
        { sourceConversationUrl: "https://chatgpt.com/c/1", cloneId: "c", prompt: "go" },
        {}
      ),
      (error: unknown) => error instanceof ChatGptDelegationError
    )
  })
  assert.equal(tabs.size, 0)
})

test("dashboard delivery reaches the chat that called, never another open one", async (t) => {
  const { service, addTab, tabs, asGemini, marker } = setup(t)
  await asGemini(async () => {
    await service.poll(await service.ask({ agentId: "a", prompt: "x", memory: true }, {}), 5_000)
  })
  const delegatedTab = [...tabs.values()][0]
  const otherChat = addTab("https://gemini.google.com/app/other1")
  assert.equal(await service.deliverToAgentChat(marker, () => "nope", "gemini"), "missing")

  const chat = addTab(CHAT_URL, { generating: true })
  await asGemini(() => service.noteCallingChat())
  chat.generating = false
  assert.equal(await service.deliverToAgentChat(marker, () => "do this", "gemini"), "sent")
  assert.deepEqual(chat.sent, ["do this"])
  assert.deepEqual(otherChat.sent, [])
  assert.equal(delegatedTab?.sent.length, 1)
})

test("dashboard delivery stops when the chat that called is closed", async (t) => {
  const { service, addTab, tabs, asGemini, marker } = setup(t)
  const chat = addTab(CHAT_URL, { generating: true })
  await asGemini(() => service.noteCallingChat())
  const otherChat = addTab("https://gemini.google.com/app/other1")
  tabs.delete(chat.tab_id)
  await assert.rejects(service.deliverToAgentChat(marker, () => "x", "gemini"))
  assert.deepEqual(otherChat.sent, [])
})

test("two chats generating at once name no caller", async (t) => {
  const { service, addTab, asGemini, marker } = setup(t)
  addTab(CHAT_URL, { generating: true })
  addTab("https://gemini.google.com/app/other1", { generating: true })
  await asGemini(() => service.noteCallingChat())
  assert.equal(await service.deliverToAgentChat(marker, () => "x", "gemini"), "missing")
})

test("dashboard delivery leaves a draft or a running response alone", async (t) => {
  const { service, addTab, asGemini, marker } = setup(t)
  const chat = addTab(CHAT_URL, { generating: true })
  await asGemini(() => service.noteCallingChat())
  chat.generating = false
  chat.draft = true
  let claimed = false
  const claim = () => {
    claimed = true
    return "x"
  }
  assert.equal(await service.deliverToAgentChat(marker, claim, "gemini"), "draft")
  chat.draft = false
  chat.generating = true
  assert.equal(await service.deliverToAgentChat(marker, claim, "gemini"), "busy")
  assert.equal(claimed, false)
})

const IMAGE = { data: "aGk=", mimeType: "image/png" }

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(condition(), true)
}

test("a print waits for the calling chat's reply, then posts once", async (t) => {
  const { service, addTab } = setup(t)
  const other = addTab(CHAT_URL)
  const chat = addTab("https://gemini.google.com/u/1/app", { generating: true })

  assert.equal(await service.showImage("m", IMAGE), true)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(chat.images, 0)

  chat.generating = false
  await waitUntil(() => chat.sent.length === 1)
  assert.equal(chat.images, 1)
  assert.equal(other.images, 0)
})

test("a print leaves a user's draft alone until it is gone", async (t) => {
  const { service, addTab } = setup(t)
  const chat = addTab(CHAT_URL, { generating: true, draft: true })
  assert.equal(await service.showImage("m", IMAGE), true)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(chat.images, 0)
  chat.generating = false
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(chat.images, 0)
  chat.draft = false
  await waitUntil(() => chat.images === 1)
})

test("a print reports failure when no chat is open", async (t) => {
  const { service } = setup(t)
  assert.equal(await service.showImage("m", IMAGE), false)
})

test("the router sends each caller to its own provider", async () => {
  const called: string[] = []
  const fake = (name: string) =>
    ({
      ask: async () => {
        called.push(name)
        return name
      },
      deliverToAgentChat: async () => {
        called.push(`${name}-chat`)
        return "sent"
      },
      dispose: async () => undefined,
      ensureProject: async () => ({ url: name, created: false }),
    }) as unknown as ChatGptDelegationService
  const router = createDelegationRouter(fake("chatgpt"), fake("gemini"))
  const request = { agentId: "a", prompt: "p", memory: true }

  await runWithAgent("router-openai", () => router.ask(request, {}))
  await runWithAgent("router-google", () => router.ask(request, {}), "gemini")
  await router.deliverToAgentChat("m", () => "x", "gemini")
  assert.deepEqual(called, ["chatgpt", "gemini", "gemini-chat"])
  assert.throws(
    () => runWithAgent("router-google", () => router.ensureProject({ name: "p" }, {}), "gemini"),
    (error: unknown) =>
      error instanceof ChatGptDelegationError && error.code === "UNSUPPORTED_FOR_GEMINI"
  )
})

test("only saved chats count as Gemini conversations", () => {
  assert.equal(isGeminiConversationUrl(CHAT_URL), true)
  assert.equal(isGeminiConversationUrl("https://gemini.google.com/u/1/app/abc"), true)
  assert.equal(isGeminiConversationUrl("https://gemini.google.com/app"), false)
  assert.equal(isGeminiConversationUrl("https://chatgpt.com/c/abc"), false)
})

test("page scripts are valid JavaScript, including quotes and newlines in messages", () => {
  const scripts = [
    GEMINI_SNAPSHOT_SCRIPT,
    GEMINI_TRANSCRIPT_SCRIPT,
    geminiSendScript('line "one"\nline `two`'),
    geminiAttachImageScript("aGk=", "image/png", "print.png"),
  ]
  for (const script of scripts) assert.doesNotThrow(() => new Script(script))
})
