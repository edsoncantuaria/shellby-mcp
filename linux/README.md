# Shellby Desktop (GNOME on Wayland)

Computer Use backend for Linux. It has two halves:

| Part | Role |
| --- | --- |
| [`gnome-extension/`](gnome-extension/extension.js) | GNOME Shell extension. Exposes `dev.shellby.Desktop` on the session bus: window list/geometry/actions, screenshots (windows are captured even when covered), pointer and keyboard injection, clipboard, app launch. |
| [`shellby-desktop`](shellby-desktop) | Python CLI. Implements the command dialect and JSON envelope that [`peekaboo.ts`](../src/tools/computer/peekaboo.ts) expects, composing the extension primitives with AT-SPI element trees. |

The extension exists because GNOME Shell denies `Introspect.GetWindows` and `Screenshot` to ordinary session processes, and Wayland gives clients no global coordinates or input injection.

## Install

```bash
node linux/install-extension.mjs
```

Then log out and back in (a Wayland shell only loads new extensions at login) and check:

```bash
node linux/install-extension.mjs --status
```

Requires GNOME Shell 50 and `python3-gi python3-gi-cairo gir1.2-atspi-2.0`. `--uninstall` removes it.

## Behavior that differs from the macOS backend

- **No background input.** Every click, key press, scroll, and drag focuses its target window and drives the real pointer and keyboard.
- **Screenshots are in logical pixels**, so screenshot coordinates equal desktop coordinates on HiDPI displays.
- **Non-ASCII text is pasted** (clipboard + Ctrl+V) because those characters may be missing from the active keyboard layout. This replaces the clipboard and does not work in terminals, which paste with Ctrl+Shift+V.
- **Element trees depend on the app.** GTK and Qt apps expose AT-SPI trees; Chrome and Electron only do so when their accessibility support is on. Some GTK4 widgets report bounds offset by their container margin; clicks target the element center, which stays inside the widget in the cases tested.

## Trust boundary

Any process on the user's session bus can call `dev.shellby.Desktop`, which means it can read the screen and inject input. That is the same trust domain as the desktop session itself; sandboxed (Flatpak) apps cannot reach it unless granted session-bus access.

## Verification

The backend was exercised against an isolated headless GNOME Shell 50.1 (`gnome-shell --headless --virtual-monitor`) with GNOME Calculator and Text Editor. `test/linux-desktop-helper.test.ts` covers only the helper's error contract; it does not start a compositor.
