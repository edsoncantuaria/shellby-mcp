---
summary: "Gemini subagents and steering in the dedicated Chrome, and what differs from ChatGPT."
paths:
  - src/tools/delegation/gemini-page.ts
  - src/tools/delegation/gemini-service.ts
  - src/tools/delegation/delegation-router.ts
  - src/tools/delegation/gemini-browser.ts
---

# Gemini Browser Subagents

[delegation-router.ts](../../../src/tools/delegation/delegation-router.ts) sends delegation to the caller's provider, so the ChatGPT path is unchanged. Gemini shares the [dedicated Chrome](./chatgpt-cdp-transport.md) with ChatGPT: the Google login persists in the same profile, and [gemini-browser.ts](../../../src/tools/delegation/gemini-browser.ts) attaches over the same CDP endpoint. The user's everyday profile is not involved, because Chrome ignores `--remote-debugging-port` there.

[gemini-page.ts](../../../src/tools/delegation/gemini-page.ts) owns every assumption about the DOM. Read with `textContent`: `innerText` is empty for content Chrome is not painting, which includes background tabs. Conversations are saved in `<state_dir>/gemini-subagents.sqlite`.

## Differences from ChatGPT

- **Completion** is polled from the page, because there is no CDP stream: the prompt must be rendered, a response must exist, the stop button must be gone, and the text must hold still.
- **Clones** are new chats seeded with the source transcript. Gemini has no branch to drive and only renders recent turns, so older context can be missing.
- **`memory: false`** has no effect, and `chatgpt_project` is refused.
- **Steering** and prints go only to the chat that last called a tool: every Gemini tool call records the one non-delegated tab generating at that moment. Nothing is sent when no such tab is known, or when two chats generate at once, so another open chat is never used as a fallback.

`computer_show` cannot return an image to Gemini: it shows neither the viewer widget nor MCP image results. It pastes the print into the calling chat and sends it once the reply ends, skipping drafts and pending tool permission prompts. Gemini needs `@Shellbymcp` in the message to use the connector at all.
