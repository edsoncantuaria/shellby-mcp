---
summary: "Extension-enforced tab and site boundaries, loopback pairing, and `browser_*` limits."
paths:
  - browser-extension/
  - src/tools/browser/
  - scripts/browser-pair.ts
---

# Chrome Bridge

`browser_*` tools drive the user's everyday Chrome and its logins. [browser-tools.ts](../../../src/tools/browser/browser-tools.ts) owns schemas, [browser-bridge.ts](../../../src/tools/browser/browser-bridge.ts) owns the socket, and [browser-extension/](../../../browser-extension/) owns every decision about what may be touched.

## Why an extension

Chrome ignores `--remote-debugging-port` on the default profile, so CDP attach cannot reach the logged-in browser. The extension uses `chrome.debugger` instead, which also makes Chrome show its debugging banner while Shellby is attached. The [ChatGPT CDP profile](../subagents/chatgpt-cdp-transport.md) is a separate, dedicated browser.

## Trust boundaries

Enforcement lives in the extension so neither the agent nor a compromised server can widen it. The bridge exposes fixed commands, never raw CDP, because `Target.*` and `Page.navigate` would escape the checks.

- **Tabs:** only tabs in a group titled `Shellby` are visible or controllable. Dragging a tab out, or dismissing the banner, revokes it.
- **Sites:** each http(s) origin needs a user decision from `approve.html`, stored as `site:<origin>`. Unanswered and undecided sites fail with `SITE_APPROVAL_REQUIRED` immediately rather than holding a tool call open across unknown client timeouts. The agent cannot click the prompt: `chrome-extension:` pages are outside its reach.
- **Reads re-check the site afterwards**, because a tab can redirect while a capture runs. Console and network buffers reset when the origin changes.
- **Secret fields** are refused by `fill`, `type`, and printable `key`, and their values are omitted from `browser_read`. This is a guardrail against mistakes, not a boundary: `browser_evaluate` runs in the page.

## Channel

The bridge listens on loopback at MCP port + 2. It must stay off the MCP port, which the public tunnel forwards. The upgrade requires the extension's exact `Origin`, pinned by the `key` in its manifest; [the test](../../../test/tools/browser/browser-bridge.test.ts) keeps that key and `MCP_CONFIG.browserBridge.extensionOrigin` in step. Both ends then prove the pairing secret by HMAC, so the extension also refuses a process that grabbed the port while Shellby was down. Only the newest authenticated connection is used.

## Behavior worth knowing

- Tabs open in the background. Input and scrolling must work there, which is why scrolling is in-page: synthetic wheel events do nothing without a painting compositor.
- `browser_screenshot` is resized to CSS pixels so image coordinates are input coordinates. If a hidden tab does not paint in time, the extension activates it and retries.
- Refs live in an isolated world, out of reach of page scripts, and die on navigation. `browser_read` covers the main frame and open shadow roots, not iframes.
- Logs start when Shellby first attaches to a tab.

## Validation

Unit tests cover the handshake, policy, and tool schemas; they cannot exercise `chrome.*`. For extension changes, load it into a throwaway profile with Playwright, `--enable-unsafe-extension-debugging`, and CDP `Extensions.loadUnpacked`. Branded Chrome ignores `--load-extension`.
