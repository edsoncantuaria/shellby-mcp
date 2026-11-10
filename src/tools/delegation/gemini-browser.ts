import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import { createBackgroundPage, waitForPromise } from "./chatgpt-browser.js"
import { ChatGptDelegationError } from "./contracts.js"

const CONNECT_TIMEOUT_MS = 3_000
const NAVIGATION_TIMEOUT_MS = 60_000
const NAVIGATION_SETTLE_MS = 500
const CONTEXT_LOST = /context was destroyed|navigating/iu

export interface GeminiTab {
  tabId: number
  url: string
}

/** The tabs of the dedicated Chrome, the same logged-in profile ChatGPT agents use. */
export interface GeminiTabs {
  list(signal?: AbortSignal): Promise<GeminiTab[]>
  open(url: string, signal?: AbortSignal): Promise<number>
  close(tabId: number): Promise<void>
  evaluate<T>(tabId: number, expression: string, signal?: AbortSignal): Promise<T>
  disconnect(): Promise<void>
}

export function createGeminiTabs(): GeminiTabs {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let connecting: Promise<void> | undefined
  const ids = new WeakMap<Page, number>()
  const pages = new Map<number, Page>()
  let nextId = 1

  async function connect(): Promise<void> {
    try {
      const { chromium } = await import("playwright-core")
      browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, {
        timeout: CONNECT_TIMEOUT_MS,
      })
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: ChatGptDelegationError forwards its third argument to Error.
      throw new ChatGptDelegationError(
        "GEMINI_BROWSER_UNAVAILABLE",
        `The dedicated Chrome is not running at ${MCP_CONFIG.chatGpt.cdpEndpoint}.`,
        { cause: error }
      )
    }
    context = browser.contexts()[0]
  }

  async function connected(signal?: AbortSignal): Promise<[Browser, BrowserContext]> {
    if (!browser?.isConnected() || !context) {
      connecting ??= connect().finally(() => {
        connecting = undefined
      })
      await waitForPromise(connecting, signal)
    }
    if (!browser || !context) {
      throw new ChatGptDelegationError(
        "GEMINI_BROWSER_UNAVAILABLE",
        "The dedicated Chrome did not expose a browser context."
      )
    }
    return [browser, context]
  }

  function idFor(page: Page): number {
    let id = ids.get(page)
    if (id === undefined) {
      id = nextId++
      ids.set(page, id)
      pages.set(id, page)
    }
    return id
  }

  function pageFor(tabId: number): Page {
    const page = pages.get(tabId)
    if (page && !page.isClosed()) return page
    pages.delete(tabId)
    throw new ChatGptDelegationError("AGENT_TARGET_LOST", `Gemini tab ${tabId} is gone.`)
  }

  async function evaluate<T>(tabId: number, expression: string, signal?: AbortSignal): Promise<T> {
    const page = pageFor(tabId)
    try {
      return await waitForPromise(page.evaluate<T>(expression), signal)
    } catch (error) {
      if (error instanceof ChatGptDelegationError) throw error
      pageFor(tabId)
      if (!(error instanceof Error && CONTEXT_LOST.test(error.message))) throw error
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS))
      return waitForPromise(page.evaluate<T>(expression), signal)
    }
  }

  return {
    async list(signal) {
      const [, browserContext] = await connected(signal)
      return browserContext
        .pages()
        .filter((page) => !page.isClosed())
        .map((page) => ({ tabId: idFor(page), url: page.url() }))
    },
    async open(url, signal) {
      const [connectedBrowser, browserContext] = await connected(signal)
      const page = await createBackgroundPage(connectedBrowser, browserContext)
      try {
        await waitForPromise(
          page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
          signal
        )
      } catch (error) {
        await page.close().catch(() => undefined)
        throw error
      }
      return idFor(page)
    },
    async close(tabId) {
      await pages
        .get(tabId)
        ?.close()
        .catch(() => undefined)
      pages.delete(tabId)
    },
    evaluate,
    async disconnect() {
      await browser?.close().catch(() => undefined)
      browser = undefined
      context = undefined
    },
  }
}
