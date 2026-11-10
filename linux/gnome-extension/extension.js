// Shellby Desktop: the compositor-side half of Shellby MCP Computer Use on GNOME.
//
// GNOME Shell refuses window introspection and screenshots to ordinary session
// processes, and Wayland offers no global coordinates or input injection outside
// the compositor. This extension exposes exactly those primitives on the session
// bus; linux/shellby-desktop composes them into Computer Use actions.
//
// Any process on the user's session bus can call this service. That is the same
// trust domain as the user's own desktop session.
import Clutter from "gi://Clutter"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Meta from "gi://Meta"
import Shell from "gi://Shell"
import St from "gi://St"

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js"
import * as Config from "resource:///org/gnome/shell/misc/config.js"
import { getKeyboardManager } from "resource:///org/gnome/shell/misc/keyboardManager.js"
import * as Main from "resource:///org/gnome/shell/ui/main.js"

const BUS_NAME = "dev.shellby.Desktop"
const OBJECT_PATH = "/dev/shellby/Desktop"
const ERROR_NAME = "dev.shellby.Desktop.Error"
const API_VERSION = 4

const INTERFACE = `
<node>
  <interface name="dev.shellby.Desktop">
    <method name="Ping"><arg type="s" direction="out"/></method>
    <method name="ListWindows"><arg type="s" direction="out"/></method>
    <method name="ListMonitors"><arg type="s" direction="out"/></method>
    <method name="WindowAction">
      <arg type="t" name="id" direction="in"/>
      <arg type="s" name="action" direction="in"/>
      <arg type="ai" name="geometry" direction="in"/>
    </method>
    <method name="Screenshot">
      <arg type="s" name="kind" direction="in"/>
      <arg type="t" name="id" direction="in"/>
      <arg type="s" name="path" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="PointerMove">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="Hold">
      <arg type="s" name="kind" direction="in"/>
      <arg type="u" name="code" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="ReleaseHeld"/>
    <method name="GetClipboard"><arg type="s" direction="out"/></method>
    <method name="ShellState"><arg type="s" direction="out"/></method>
    <method name="PointerRelative">
      <arg type="d" name="dx" direction="in"/>
      <arg type="d" name="dy" direction="in"/>
    </method>
    <method name="PointerPosition"><arg type="ad" direction="out"/></method>
    <method name="PointerWarp">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="PointerButton">
      <arg type="u" name="button" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="Scroll">
      <arg type="s" name="direction" direction="in"/>
      <arg type="u" name="steps" direction="in"/>
    </method>
    <method name="Key">
      <arg type="u" name="keyval" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="KeyboardGroup"><arg type="u" direction="out"/></method>
    <method name="CommitText">
      <arg type="s" name="text" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="ScrollContinuous">
      <arg type="d" name="dx" direction="in"/>
      <arg type="d" name="dy" direction="in"/>
      <arg type="b" name="finish" direction="in"/>
    </method>
    <method name="SetClipboard"><arg type="s" name="text" direction="in"/></method>
    <method name="LaunchApp">
      <arg type="s" name="desktop_id" direction="in"/>
      <arg type="as" name="uris" direction="in"/>
    </method>
  </interface>
</node>`

const LISTED_WINDOW_TYPES = new Set([
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  Meta.WindowType.UTILITY,
])

const SCROLL_DIRECTIONS = {
  up: Clutter.ScrollDirection.UP,
  down: Clutter.ScrollDirection.DOWN,
  left: Clutter.ScrollDirection.LEFT,
  right: Clutter.ScrollDirection.RIGHT,
}

// Wayland popups (menus, popovers) are windows of their own; they never get listed.
const POPUP_WINDOW_TYPES = new Set([
  Meta.WindowType.MENU,
  Meta.WindowType.DROPDOWN_MENU,
  Meta.WindowType.POPUP_MENU,
  Meta.WindowType.COMBO,
])

// Held input is released on its own if the caller goes away.
const HOLD_LIMIT_MS = 30_000
const MAX_WORKSPACE_INDEX = 35

const CURSOR_SIZE = 18
const CURSOR_LINGER_MS = 1500

function rectangle(rect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function listedWindows() {
  return global
    .get_window_actors()
    .map((actor) => actor.meta_window)
    .filter((window) => window && LISTED_WINDOW_TYPES.has(window.get_window_type()))
}

function findWindow(id) {
  const window = listedWindows().find((candidate) => candidate.get_id() === id)
  if (!window) throw new Error(`WINDOW_NOT_FOUND: No window has ID ${id}.`)
  return window
}

function popupsOf(window) {
  return global
    .get_window_actors()
    .map((actor) => actor.meta_window)
    .filter(
      (candidate) =>
        candidate &&
        POPUP_WINDOW_TYPES.has(candidate.get_window_type()) &&
        candidate.find_root_ancestor() === window
    )
}

function unionRectangle(rectangles) {
  const left = Math.min(...rectangles.map((rect) => rect.x))
  const top = Math.min(...rectangles.map((rect) => rect.y))
  const right = Math.max(...rectangles.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rectangles.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function isMaximized(window) {
  // Mutter 49 replaced get_maximized() flags with is_maximized().
  return window.is_maximized ? window.is_maximized() : window.get_maximized() !== 0
}

function maximize(window) {
  if (Meta.MaximizeFlags) window.maximize(Meta.MaximizeFlags.BOTH)
  else window.maximize()
}

function unmaximize(window) {
  if (!isMaximized(window)) return
  if (Meta.MaximizeFlags) window.unmaximize(Meta.MaximizeFlags.BOTH)
  else window.unmaximize()
}

class DesktopService {
  constructor() {
    const seat = Clutter.get_default_backend().get_default_seat()
    this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE)
    this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)
    this._tracker = Shell.WindowTracker.get_default()
    this._cursor = new St.Widget({
      style: `width: ${CURSOR_SIZE}px; height: ${CURSOR_SIZE}px; border-radius: ${CURSOR_SIZE}px; background-color: rgba(255, 60, 120, 0.85); border: 2px solid white;`,
      reactive: false,
      visible: false,
    })
    Main.uiGroup.add_child(this._cursor)
    this._cursorTimer = 0
    this._held = new Map()
    this._holdTimer = 0
  }

  destroy() {
    this.ReleaseHeld()
    if (this._cursorTimer) GLib.source_remove(this._cursorTimer)
    this._cursorTimer = 0
    this._cursor.destroy()
    this._cursor = null
    this._pointer = null
    this._keyboard = null
  }

  Ping() {
    return JSON.stringify({ api: API_VERSION, shell: Config.PACKAGE_VERSION })
  }

  ListWindows() {
    const windows = listedWindows()
    const stacking = global.display.sort_windows_by_stacking(windows)
    const activeWorkspace = global.workspace_manager.get_active_workspace()
    return JSON.stringify(
      windows.map((window) => {
        const app = this._tracker.get_window_app(window)
        return {
          id: window.get_id(),
          title: window.get_title() ?? "",
          pid: window.get_pid(),
          wm_class: window.get_wm_class() ?? "",
          app: app?.get_name() ?? "",
          app_id: app?.get_id() ?? "",
          ...rectangle(window.get_frame_rect()),
          // An open menu holds the focus on behalf of its window.
          focused: global.display.focus_window?.find_root_ancestor() === window,
          minimized: window.minimized,
          maximized: isMaximized(window),
          shadow_x: window.get_frame_rect().x - window.get_buffer_rect().x,
          shadow_y: window.get_frame_rect().y - window.get_buffer_rect().y,
          monitor: window.get_monitor(),
          workspace: window.get_workspace()?.index() ?? -1,
          on_active_workspace: window.located_on_workspace(activeWorkspace),
          stacking: stacking.indexOf(window),
        }
      })
    )
  }

  ListMonitors() {
    const display = global.display
    const primary = display.get_primary_monitor()
    const monitors = []
    for (let index = 0; index < display.get_n_monitors(); index++) {
      monitors.push({
        index,
        ...rectangle(display.get_monitor_geometry(index)),
        scale: display.get_monitor_scale(index),
        primary: index === primary,
      })
    }
    return JSON.stringify(monitors)
  }

  WindowAction(id, action, geometry) {
    const window = findWindow(id)
    const frame = window.get_frame_rect()
    switch (action) {
      case "focus":
        Main.activateWindow(window)
        break
      case "move_monitor":
        if (geometry[0] >= global.display.get_n_monitors())
          throw new Error(`SCREEN_NOT_FOUND: No screen has index ${geometry[0]}.`)
        window.move_to_monitor(geometry[0])
        break
      case "move_workspace": {
        if (geometry[0] > MAX_WORKSPACE_INDEX)
          throw new Error(`INVALID_WORKSPACE: Workspace ${geometry[0]} is out of range.`)
        const manager = global.workspace_manager
        while (manager.n_workspaces <= geometry[0])
          manager.append_new_workspace(false, global.get_current_time())
        window.change_workspace_by_index(geometry[0], false)
        break
      }
      case "close":
        window.delete(global.get_current_time())
        break
      case "minimize":
        window.minimize()
        break
      case "restore":
        if (window.minimized) window.unminimize()
        else unmaximize(window)
        break
      case "maximize":
        if (window.minimized) window.unminimize()
        maximize(window)
        break
      case "move":
        unmaximize(window)
        window.move_frame(true, geometry[0], geometry[1])
        break
      case "resize":
        unmaximize(window)
        window.move_resize_frame(true, frame.x, frame.y, geometry[0], geometry[1])
        break
      case "set_bounds":
        unmaximize(window)
        window.move_resize_frame(true, geometry[0], geometry[1], geometry[2], geometry[3])
        break
      default:
        throw new Error(`INVALID_ACTION: Unknown window action ${action}.`)
    }
  }

  // Promise-returning shell APIs need the invocation, so this method is async.
  ScreenshotAsync([kind, id, path], invocation) {
    this._screenshot(kind, id, path).then(
      (bounds) => invocation.return_value(new GLib.Variant("(s)", [JSON.stringify(bounds)])),
      (error) => invocation.return_dbus_error(ERROR_NAME, error.message)
    )
  }

  async _screenshot(kind, id, path) {
    this._hideCursor()
    const file = Gio.File.new_for_path(path)
    // Callers share the session bus, so this write must not reach arbitrary files.
    if (!file.get_path().startsWith(`${GLib.get_user_runtime_dir()}/shellby-desktop/`))
      throw new Error("INVALID_PATH: Screenshots can only be written to the runtime directory.")
    const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null)
    try {
      if (kind === "screen") {
        if (id >= global.display.get_n_monitors())
          throw new Error(`SCREEN_NOT_FOUND: No screen has index ${id}.`)
        const bounds = rectangle(global.display.get_monitor_geometry(id))
        await new Shell.Screenshot().screenshot_area(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          stream
        )
        return bounds
      }
      if (kind !== "window") throw new Error(`INVALID_TARGET: Unknown screenshot kind ${kind}.`)

      // Painting the actor captures the window even when it is covered by others.
      const window = findWindow(id)
      const popups = popupsOf(window)
      if (popups.length > 0) {
        // Popups are separate surfaces, so only a stage capture shows them with their window.
        const bounds = unionRectangle(
          [window, ...popups].map((item) => rectangle(item.get_frame_rect()))
        )
        await new Shell.Screenshot().screenshot_area(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          stream
        )
        return bounds
      }
      const actor = window.get_compositor_private()
      if (!actor) throw new Error(`WINDOW_NOT_CAPTURABLE: Window ${id} has no compositor actor.`)
      const texture = actor.paint_to_content(null).get_texture()
      const scale = actor.get_resource_scale()
      const frame = window.get_frame_rect()
      const buffer = window.get_buffer_rect()
      await Shell.Screenshot.composite_to_stream(
        texture,
        Math.round((frame.x - buffer.x) * scale),
        Math.round((frame.y - buffer.y) * scale),
        Math.round(frame.width * scale),
        Math.round(frame.height * scale),
        scale,
        null,
        0,
        0,
        1,
        stream
      )
      return rectangle(frame)
    } finally {
      stream.close(null)
    }
  }

  PointerMove(x, y) {
    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y)
    this._showCursor(x, y)
  }

  // A system dialog or the lock screen takes all input away from applications.
  Hold(kind, code, pressed) {
    if (kind !== "key" && kind !== "button") throw new Error(`INVALID_HOLD: Unknown kind ${kind}.`)
    if (kind === "key") this.Key(code, pressed)
    else this.PointerButton(code, pressed)
    if (pressed) this._held.set(`${kind}:${code}`, { kind, code })
    else this._held.delete(`${kind}:${code}`)
    if (this._holdTimer) GLib.source_remove(this._holdTimer)
    this._holdTimer = 0
    if (this._held.size > 0) {
      this._holdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_LIMIT_MS, () => {
        this._holdTimer = 0
        this.ReleaseHeld()
        return GLib.SOURCE_REMOVE
      })
    }
  }

  ReleaseHeld() {
    if (this._holdTimer) GLib.source_remove(this._holdTimer)
    this._holdTimer = 0
    for (const { kind, code } of this._held.values()) {
      if (kind === "key") this.Key(code, false)
      else this.PointerButton(code, false)
    }
    this._held.clear()
  }

  GetClipboardAsync(_parameters, invocation) {
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
      invocation.return_value(new GLib.Variant("(s)", [text ?? ""]))
    })
  }

  ShellState() {
    const dialogs = Main.layoutManager.modalDialogGroup.get_children()
    return JSON.stringify({
      dialog: dialogs.some((actor) => actor.visible),
      locked: Main.sessionMode.isLocked,
    })
  }

  PointerRelative(dx, dy) {
    this._pointer.notify_relative_motion(GLib.get_monotonic_time(), dx, dy)
  }

  PointerPosition() {
    const [x, y] = global.get_pointer()
    return [x, y]
  }

  // Puts the pointer back where the user left it, without the agent's marker.
  PointerWarp(x, y) {
    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y)
  }

  _showCursor(x, y) {
    this._cursor.set_position(Math.round(x - CURSOR_SIZE / 2), Math.round(y - CURSOR_SIZE / 2))
    Main.uiGroup.set_child_above_sibling(this._cursor, null)
    this._cursor.show()
    if (this._cursorTimer) GLib.source_remove(this._cursorTimer)
    this._cursorTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CURSOR_LINGER_MS, () => {
      this._cursorTimer = 0
      this._cursor.hide()
      return GLib.SOURCE_REMOVE
    })
  }

  _hideCursor() {
    if (this._cursorTimer) GLib.source_remove(this._cursorTimer)
    this._cursorTimer = 0
    this._cursor.hide()
  }

  PointerButton(button, pressed) {
    this._pointer.notify_button(
      GLib.get_monotonic_time(),
      button,
      pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED
    )
  }

  Scroll(direction, steps) {
    if (!(direction in SCROLL_DIRECTIONS))
      throw new Error(`INVALID_DIRECTION: Unknown scroll direction ${direction}.`)
    for (let step = 0; step < steps; step++) {
      this._pointer.notify_discrete_scroll(
        GLib.get_monotonic_time(),
        SCROLL_DIRECTIONS[direction],
        Clutter.ScrollSource.WHEEL
      )
    }
  }

  ScrollContinuous(dx, dy, finish) {
    const flags = finish
      ? Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL
      : Clutter.ScrollFinishFlags.NONE
    this._pointer.notify_scroll_continuous(
      GLib.get_monotonic_time(),
      dx,
      dy,
      Clutter.ScrollSource.FINGER,
      flags
    )
  }

  Key(keyval, pressed) {
    this._keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      keyval,
      pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED
    )
  }

  KeyboardGroup() {
    return getKeyboardManager().currentLayout?.groupIndex ?? 0
  }

  // Text delivered through the input method needs no key for any character.
  CommitText(text) {
    if (!Main.inputMethod.currentFocus) return false
    Main.inputMethod.commit(text)
    return true
  }

  SetClipboard(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text)
  }

  // Launching from the shell gives the app the same session context as the dash.
  LaunchApp(desktopId, uris) {
    const app = Shell.AppSystem.get_default().lookup_app(desktopId)
    if (!app) throw new Error(`APP_NOT_FOUND: No installed application has ID ${desktopId}.`)
    if (uris.length > 0)
      app.get_app_info().launch_uris(uris, global.create_app_launch_context(0, -1))
    else if (app.get_n_windows() > 0) app.activate()
    else app.open_new_window(-1)
  }
}

export default class ShellbyDesktopExtension extends Extension {
  enable() {
    this._service = new DesktopService()
    this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this._service)
    this._exported.export(Gio.DBus.session, OBJECT_PATH)
    this._ownerId = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null
    )
  }

  disable() {
    if (this._ownerId) Gio.bus_unown_name(this._ownerId)
    this._ownerId = 0
    this._exported?.unexport()
    this._exported = null
    this._service?.destroy()
    this._service = null
  }
}
