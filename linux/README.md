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

Requires GNOME Shell 50 and `python3-gi python3-gi-cairo gir1.2-atspi-2.0 gir1.2-gtk-3.0`. `--uninstall` removes it.

## Behavior that differs from the macOS backend

- **Input stays out of the user's way.** Unless `foreground=true`:
  - A plain left click on an element runs its AT-SPI action, without moving the pointer or changing focus. Clicking a text field focuses its window and the field through AT-SPI.
  - Typing writes into the window's focused field, or its only field, through AT-SPI, with no focus change. Otherwise the window borrows focus and hands it back.
  - Scrolling moves the pointer and puts it back. A covered window borrows focus.
  - Key presses and drags borrow focus, then return focus and pointer.
  - Right and double clicks and coordinate clicks use the real pointer and leave focus on the target.
- **Screenshots are in logical pixels**, so screenshot coordinates equal desktop coordinates on HiDPI displays.
- **Typing follows the active keyboard layout**, including symbols that need Shift+AltGr. Characters with no key in the layout go through the GNOME input method, or the clipboard (Ctrl+V) in apps that do not use one, such as Chrome.
- **`cmd` means Ctrl.** Use `super` for the Super key.
- **Open menus are part of the window.** Captures grow to include popups, and image coordinates stay valid.
- **Every app can be seen and driven; element trees depend on the app.** Screenshots, coordinates, typing, and window actions work on any window, including X11, Flatpak, and Snap apps. GTK, Qt, and X11 toolkits expose elements by default. Chromium, Electron, Firefox, and QtWebEngine need a switch, so the installer detects them among your launchers and enables it (`--uninstall` reverts it, and rerun the installer after adding such an app); reopen them to apply it. Games and custom-drawn UIs such as Blender and Godot have no element tree: use screenshot coordinates. GTK4 reports element positions up to about 12 px off, and its hit test uses the same wrong coordinates, so this only matters for clicks that use the pointer on small widgets; prefer screenshot coordinates there.

## Trust boundary

Any process on the user's session bus can call `dev.shellby.Desktop`, which means it can read the screen and inject input. That is the same trust domain as the desktop session itself; sandboxed (Flatpak) apps cannot reach it unless granted session-bus access.

## Verification

The backend was exercised against an isolated headless GNOME Shell 50.1 (`gnome-shell --headless --virtual-monitor`) with GNOME Calculator and Text Editor. `test/linux-desktop-helper.test.ts` covers only the helper's error contract; it does not start a compositor.
