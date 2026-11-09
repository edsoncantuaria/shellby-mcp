import type { Page } from "playwright-core"
import { assertAuthenticated, navigateChatGptPage, throwIfAborted } from "./chatgpt-browser.js"
import {
  ChatGptDelegationError,
  type ChatGptProjectRequest,
  type ChatGptProjectResult,
} from "./contracts.js"

const PROJECTS_URL = "https://chatgpt.com/projects"
const PROJECT_HREF = /^\/g\/(g-p-[^/]+)\/project\/?$/u
const UI_TIMEOUT_MS = 15_000

function projectUrl(href: string): string | undefined {
  const match = PROJECT_HREF.exec(new URL(href, "https://chatgpt.com").pathname)
  return match ? `https://chatgpt.com/g/${match[1]}/project` : undefined
}

/** Reopen a project by exact name, or create it (project-only memory) and return its URL. Drives the ChatGPT web UI on an already-open page. */
export async function ensureChatGptProject(
  page: Page,
  request: ChatGptProjectRequest,
  signal?: AbortSignal
): Promise<ChatGptProjectResult> {
  await navigateChatGptPage(page, PROJECTS_URL, signal)
  await assertAuthenticated(page)
  await page.getByPlaceholder("Search projects").waitFor({ timeout: UI_TIMEOUT_MS })
  await page.getByPlaceholder("Search projects").fill(request.name)
  await page.waitForTimeout(1_200)
  throwIfAborted(signal)

  // As linhas de projeto não são links: o clique na linha com o nome exato abre o projeto.
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText(request.name, { exact: true }) })
    .first()
  if (await row.count()) {
    await row.getByText(request.name, { exact: true }).first().click()
    await page.waitForURL(PROJECT_URL_PATTERN, { timeout: UI_TIMEOUT_MS })
    const existing = projectUrl(page.url())
    if (existing) return { url: existing, created: false }
  }

  await page.getByPlaceholder("Search projects").fill("")
  await page.getByRole("button", { name: "New", exact: true }).first().click()
  await page.getByRole("dialog").getByRole("textbox").first().fill(request.name)
  await page.getByText("Default memory").click()
  await page.getByText("Project-only memory").first().click()
  await page.getByRole("button", { name: "Create project" }).click()
  await page.waitForURL(PROJECT_URL_PATTERN, { timeout: UI_TIMEOUT_MS })
  const url = projectUrl(page.url())
  if (!url)
    throw new ChatGptDelegationError(
      "CHATGPT_UI_CHANGED",
      `ChatGPT did not open the new project (url: ${page.url()}).`
    )

  if (request.instructions) {
    await page.getByRole("button", { name: "Show project details" }).click()
    await page.getByText("Project settings").click()
    const box = page.getByRole("textbox", { name: "Instructions" })
    await box.fill(request.instructions)
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await box.waitFor({ state: "detached", timeout: UI_TIMEOUT_MS })
  }
  return { url, created: true }
}

const PROJECT_URL_PATTERN = /\/g\/g-p-[^/]+\/project/u
