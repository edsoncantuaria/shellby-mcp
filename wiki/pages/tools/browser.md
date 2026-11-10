---
summary: "Extension-enforced tab, site, and iframe boundaries, multi-browser pairing, and `browser_*` behavior."
paths:
  - browser-extension/
  - src/tools/browser/
  - scripts/browser-pair.ts
---

# Chrome Bridge

`browser_*` tools drive the user's everyday Chrome and its logins. [browser-tools.ts](../../../src/tools/browser/browser-tools.ts) owns schemas, [browser-bridge.ts](../../../src/tools/browser/browser-bridge.ts) owns the socket, and [browser-extension/](../../../browser-extension/) owns every decision about what may be touched. Several browsers or profiles can pair at once, each identified by a stable `browserId` kept in extension storage; tab IDs only mean something within one browser, so calls name a browser once more than one is connected.

## Why an extension

Chrome ignores `--remote-debugging-port` on the default profile, so CDP attach cannot reach the logged-in browser. The extension uses `chrome.debugger` instead, which also makes Chrome show its debugging banner while Shellby is attached. The [ChatGPT CDP profile](../subagents/chatgpt-cdp-transport.md) is a separate, dedicated browser.

## Trust boundaries

Enforcement lives in the extension so neither the agent nor a compromised server can widen it. The bridge exposes fixed commands, never raw CDP, because `Target.*` and `Page.navigate` would escape the checks.

- **Tabs:** only tabs in a group titled `Shellby` are visible or controllable. Dragging a tab out, or dismissing the banner, revokes it.
- **Sites:** each http(s) origin needs a user decision from `approve.html`, stored as `site:<origin>`. Unanswered and undecided sites fail with `SITE_APPROVAL_REQUIRED` immediately rather than holding a tool call open across unknown client timeouts. The agent cannot click the prompt: `chrome-extension:` pages are outside its reach.
- **Iframes are sites too:** being embedded in an approved page grants a frame nothing. Unapproved frames are listed by origin but not read, and refs and coordinates that land in one fail with `FRAME_NOT_APPROVED`. Reads never prompt, because ad frames would flood the user; `request_frame_origin` asks for one explicitly. `about:`, `blob:`, and `data:` frames inherit from their parent.
- **Reads re-check the site afterwards**, because a tab can redirect while a capture runs. Console and network buffers reset when the origin changes.
- **Secret fields** are refused by `fill`, `type`, and printable `key` in every frame, since payment forms usually live in a cross-site iframe, and their values are omitted from `browser_read`. This is a guardrail against mistakes, not a boundary: `browser_evaluate` runs in the page.

## Channel

The bridge listens on loopback at MCP port + 2. It must stay off the MCP port, which the public tunnel forwards. The upgrade requires the extension's exact `Origin`, pinned by the `key` in its manifest; [the test](../../../test/tools/browser/browser-bridge.test.ts) keeps that key and `MCP_CONFIG.browserBridge.extensionOrigin` in step. Both ends then prove the pairing secret by HMAC, so the extension also refuses a process that grabbed the port while Shellby was down. Only the newest authenticated connection is used.

## Behavior worth knowing

- Tabs open in the background. Input and scrolling must work there, which is why scrolling is in-page: synthetic wheel events do nothing without a painting compositor.
- `browser_screenshot` is resized to `innerWidth`/`innerHeight`, which include scrollbars as the capture does, so image coordinates are input coordinates. If a hidden tab does not paint in time, the extension activates it and retries.
- Refs live in an isolated world, out of reach of page scripts, and die on navigation. A subframe ref is `ref_<frame>_<n>`. Cross-site iframes are separate debugger targets reached through flat sessions, which is why Chrome 125 is the minimum; input still goes to the top target, with the owner's box model added to reach top-level coordinates.
- `drag` intercepts HTML5 drag sources and replays them with `Input.dispatchDragEvent`, because synthetic moves cannot finish an OS-level drag. Other drags are plain mouse paths.
- `browser_resize` emulates the viewport per tab. It deliberately leaves the real window alone, since that window also holds the user's other tabs.
- `browser_upload` sends bytes through the bridge and builds the `File` in the page. `DOM.setFileInputFiles` would need the user to enable file URL access for the extension. Like `file_read`, it can read any local path.
- `browser_record` keeps frames in the extension, tied to the tab, and captures after each action rather than on a timer because background tabs do not paint reliably. Frames from unapproved sites are skipped, and the server encodes the GIF under `<state_dir>/recordings`.
- Logs start when Shellby first attaches to a tab.

## Validation

Unit tests cover the handshake, policy, and tool schemas; they cannot exercise `chrome.*`. For extension changes, load it into a throwaway profile with Playwright, `--enable-unsafe-extension-debugging`, and CDP `Extensions.loadUnpacked`. Branded Chrome ignores `--load-extension`.
