---
summary: "Peekaboo ownership, snapshot coordinates, background delivery, and permission debugging."
paths:
  - src/tools/computer/
  - src/tools/image/image-encoding.ts
  - src/index.ts
  - src/config.ts
  - vendor/peekaboo/
  - scripts/peekaboo-permissions.mjs
  - linux/
---

# Computer Use

[computer-tools.ts](../../src/tools/computer/computer-tools.ts) owns focused `computer_*` schemas and semantic validation. One serialized [PeekabooClient](../../src/tools/computer/peekaboo.ts) owns argv translation, bounded JSON, capture cleanup, and snapshot targets. Production invokes the bundled CLI directly, without a shell, using `--no-remote`. Raw Peekaboo commands through `shell_run` bypass this adapter.

## Snapshot invariants

- Observation retains resolved target metadata under its snapshot ID. Mappings are bounded and process-local; missing/evicted targets require re-observation.
- [Shared image encoding](./tools/files-and-images.md) preserves dimensions and orientation. Screen captures require display-origin translation; window actions use capture-relative coordinates. Adapter owns both interpretations.
- Explicit `PID:<pid>` selectors survive Peekaboo's normalized/omitted metadata so follow-up actions stay process-bound.
- `computer_inspect` creates a new snapshot and propagates the target. Its element IDs belong to that returned snapshot, not the earlier screenshot.
- Exact-window actions may require a fresh local Peekaboo snapshot receipt. Re-observe after ambiguous mutations; stateful actions are not automatically retried.

For targeting errors, inspect capture bounds and dimensions before adding coordinate transforms. Multi-display behavior needs real-CLI validation.

## Delivery and lifecycle

Schemas define which actions permit background delivery. Coordinate dragging requires one exact observed window; screen targets, element endpoints, and modifiers are rejected. App-only/targetless presses and hotkeys require foreground delivery; typing can target an app in the background. Pointer and smooth scrolling require foreground mode.

[cursor-host.ts](../../src/tools/computer/cursor-host.ts) owns the optional bundled companion child, relaunch after unexpected exit, and shutdown. Missing companion leaves Computer Use available. MCP composition owns it; it is not a separate PM2 app.

For TCC problems, inspect the responsible launching process and [runtime recovery](./operations/runtime-recovery.md). [peekaboo-permissions.mjs](../../scripts/peekaboo-permissions.mjs) delegates permission checks/grants to Peekaboo. Vendor rebuild/provenance: `scripts/vendor/build-peekaboo.sh`, `vendor/peekaboo/provenance.json`.

Tests: [adapter](../../test/peekaboo.test.ts), [MCP computer cases](../../test/integrations/computer.ts), [vendor smoke](../../test/peekaboo-vendor.test.ts), [image geometry](../../test/image-encoding.test.ts).

## GNOME backend

On GNOME, `MCP_CONFIG.computerBackend` selects the same Peekaboo tool surface and client, pointed at [linux/shellby-desktop](../../linux/shellby-desktop) instead of the macOS binary; other Linux desktops use PeekabooX. The helper keeps Peekaboo's command dialect and JSON envelope, so tool contracts stay in one place. Compositor primitives come from a [GNOME Shell extension](../../linux/gnome-extension/extension.js) because the Shell denies window introspection and screenshots to ordinary session processes. Wayland has no background pointer or key delivery, so the helper avoids the pointer when AT-SPI can act and otherwise borrows focus and hands it back; "background" in the tool schema means the user keeps their focus, not that no window is touched. Tools that exist only on this backend live in [gnome-tools.ts](../../src/tools/computer/gnome-tools.ts). Install, HiDPI, paste, and trust-boundary details: [linux/README.md](../../linux/README.md).
