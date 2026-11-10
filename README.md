<h1 align="center">Shellby MCP</h1>

<p align="center">
  A local MCP server that gives ChatGPT Web persistent shells, direct file editing, browser-backed subagents, webpage tools, and reusable skills on Linux and macOS.
</p>

<p align="center">
  <a href="https://github.com/Serbyte-Development/shellby-mcp/actions/workflows/ci.yml"><img src="https://github.com/Serbyte-Development/shellby-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey.svg" alt="Linux and macOS">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#operations">Operations</a> ·
  <a href="#security">Security</a> ·
  <a href="wiki/">Maintainer wiki</a>
</p>

> [!CAUTION]
> Shellby MCP runs with the full permissions of your local user. An authorized ChatGPT caller can run commands, edit files, fetch webpages, and, on macOS only, control supported applications.

![Shellby MCP architecture showing ChatGPT Web connecting to the local harness and its persistent tools, Computer Use, and subagent runtime](docs/assets/shellby-mcp-architecture.svg)

## Capabilities

| Capability           | Description                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Persistent shells    | Named login shells retain cwd, environment, processes, and command history across MCP calls. |
| Native `apply_patch` | Native ChatGPT `apply_patch` binary used to edit files independently of shell state.         |
| Computer Use         | Optional desktop observation and input: Peekaboo on macOS, the [Shellby Desktop](linux/README.md) GNOME extension on GNOME, [PeekabooX](https://github.com/nordbyte/PeekabooX) on other Linux desktops. |
| Browser subagents    | Detached ChatGPT Web conversations with follow-up context and concurrent result retrieval.   |
| Web and images       | Rendered webpage extraction, bounded document pagination, and native image transport.        |
| Dynamic skills       | Reusable workflows loaded from `<workspace>/skills/*/SKILL.md`.                              |

## Requirements

- Linux or macOS on arm64 or x64
- Node.js 22.18.0 or newer
- npm
- An [ngrok](https://ngrok.com/) account and CLI, or a Cloudflare Tunnel and `cloudflared`
- A ChatGPT Plus or Higher account with Developer Mode turned on

Chrome or Chromium is needed for browser-backed subagents. Linux uses Bash by default and requires Rust/Cargo to build its native `apply_patch` binary from the pinned OpenAI Codex source. Computer Use is optional on both platforms; Linux uses PeekabooX 1.1.2+.

## Quick start

### Install with your coding agent

[`skills/install-shellby-mcp/SKILL.md`](skills/install-shellby-mcp/SKILL.md)

### Linux (GNOME/Wayland)

Install Node.js 22.18+, npm, Git, Rust/Cargo 1.95+, Bash, Chrome or Chromium, and the [ngrok CLI](https://ngrok.com/download). The Linux build was verified with Node.js 24.17, Rust/Cargo 1.98, and Chrome 149; older browser versions are not yet verified. Run `ngrok config add-authtoken <token>` using your own ngrok account. In this checkout:

```bash
npm ci
npm run setup -- --config-only
```

Edit `.shellby/config.toml`: set `workspace` to the directory containing your projects and optionally set `chatgpt.browser_executable = "/absolute/path/to/chrome-or-chromium"`. `shell.path` defaults to `/bin/bash`; an installed executable is checked during setup and start. Set `ngrok.enabled = false` only for local testing; ChatGPT Web needs the protected ngrok endpoint. For Linux desktop tools, install PeekabooX 1.1.2+ and set `tools.computer = true`. On Ubuntu x64, download the official `peekaboox_1.1.2_amd64.deb` release, verify SHA-256 `b0b4c66a71ecdc4c49810dbbdb4c0601267c885198ddbeada57cbbc5369be656`, and install with `sudo apt install ./peekaboox_1.1.2_amd64.deb`. On arm64 or other distributions, build the CLI and daemon from the tagged PeekabooX source with `packaging/install-rust.sh`. Then run:

```bash
npm run setup
npm run setup:computer
npm run setup:chatgpt
npm start
```

Setup builds `vendor/apply-patch/linux-<architecture>/apply_patch` from the pinned OpenAI Codex commit recorded in `scripts/vendor/build-apply-patch-linux.sh`; Rust/Cargo and network access to GitHub/crates.io are required once. The source commit and SHA-256 are saved beside the binary. Linux never runs the macOS binary or Peekaboo. `npm run setup:chatgpt` opens a dedicated Chrome/Chromium profile under `<state_dir>/chatgpt-chrome`; sign in to ChatGPT there once. The profile and login survive restarts. CDP binds to `127.0.0.1` and uses the configured loopback port (default 9222). On Wayland, Shellby requests Chrome's native Wayland backend. Chrome's normal sandbox remains enabled.

In ChatGPT Developer Mode, create a custom MCP app with the printed `https://.../mcp` URL and select **No Auth**. The first trusted call binds the OpenAI subject. The local dashboard, when `ui.enabled = true`, is at `http://127.0.0.1:3333/ui/` (adjust for `port`).

Use `subagent` with distinct `agent_id` values for independent conversations. Send later work using the same ID, and poll each returned `turn_id` with `subagent_result`. `chatgpt.max_delegated_agents` limits active delegated agents per parent. Turns from different agents can run concurrently; Shellby serializes work for the same agent and persists conversation URLs in its state directory. Give concurrent agents separate files or worktrees and merge their results from the parent conversation; Shellby does not lock project files across agents. ChatGPT authentication, rate limits, and UI changes can interrupt delegation. After signing in, run `npm run test:live:subagent` to test two concurrent conversations and a follow-up on one agent against your real ChatGPT session. This test sends three short prompts.

Operations: `npm start`, `npm run restart`, `npm run status`, `npm run logs`, `npm run stop`. `npm run restart -- --hard` replaces the dedicated PM2 daemon; run it from an ordinary terminal. `npm run stop` also terminates Shellby's managed browser while preserving its profile. Health: `curl -fsS http://127.0.0.1:3333/healthz`; endpoint: `npm run print-url`. If Chrome is missing, set `chatgpt.browser_executable`; if CDP port 9222 is occupied, change `chatgpt.cdp_endpoint`; if the profile is locked, close the other browser using it. An unavailable graphical session requires running setup and browser sign-in later on your desktop.

On GNOME, Computer Use runs through the Shellby Desktop extension instead of PeekabooX and exposes the full `computer_*` tool set. Run `npm run setup:computer`, log out and back in, then check `npm run setup:computer -- --status`. See [linux/README.md](linux/README.md) for behavior and trust boundary. Start Shellby from inside the desktop session so it inherits `XDG_CURRENT_DESKTOP` and the session bus.

On other Linux desktops, Computer Use runs PeekabooX through a Shellby-managed daemon on a per-installation Unix socket under `state_dir`; gRPC is disabled. The MCP exposes `computer_list`, `computer_observe`, `computer_inspect`, `computer_click`, `computer_type`, `computer_hotkey`, and `computer_scroll` when enabled. It does not advertise macOS-only Computer Use actions. Desktop calls are serialized; failed backends return errors. `npm run setup:computer` reports capture and input readiness. GNOME Wayland capture may request portal screen-sharing permission. Install `wtype` for text and `ydotool` for hotkeys/scrolling where needed; PeekabooX's doctor reports the actual backend state. The GNOME Shell window-introspection API may be denied by the session, so Shellby uses AT-SPI window enumeration on Linux. Input permissions depend on your distro's `/dev/uinput` and desktop session configuration. Without a working backend, an action reports a failure rather than success. Computer Use controls the shared desktop across agents; coordinate desktop actions in the parent conversation.

### Cloudflare Tunnel instead of ngrok

Create a dedicated remotely managed Cloudflare Tunnel and public hostname, such as `shellby.example.com`. Set its HTTP service to `http://127.0.0.1:3334` when Shellby's MCP port is 3333; the protected origin port is always the MCP port plus one. Install `cloudflared` and save the tunnel connector token outside this repository in an owner-only file (`chmod 600`). In `.shellby/config.toml`:

```toml
[ngrok]
enabled = false

[cloudflared]
enabled = true
public_url = "https://shellby.example.com"
token_file = "~/.shellby/cloudflared-token"
```

Run `npm run setup` and `npm start`. Shellby manages `cloudflared` through PM2. Run `npm run print-url` **in your local terminal** to get the full private MCP URL, then enter that exact URL as a ChatGPT Web Developer Mode custom MCP app with **No Auth**. The URL contains a generated 256-bit secret. Keep it private; do not paste it into issues, logs, or chats. The Cloudflare origin listener returns 404 for every other path and adds the trusted remote marker only after the secret path matches. Remote tool calls still require the OpenAI subject binding. The ordinary MCP port and CDP port remain loopback-only. Configure the Cloudflare public hostname solely to this protected origin port; do not route it to port 3333 or expose other ports. `npm run restart`, `npm run status`, `npm run logs`, and `npm run stop` include the managed connector. To rotate the secret, stop Shellby, remove `<state_dir>/cloudflared-url-secret`, start again, and update the ChatGPT connector URL. A new tunnel needs a Cloudflare account login and its connector token before public validation; no account token is stored in the repository.

### macOS manual install

> [!TIP]
> The manual install process should be ran from Terminal.app for the best macOS permission context.

1. Install ngrok, clone the repository, and install dependencies:

   ```bash
   brew install --cask ngrok
   git clone https://github.com/Serbyte-Development/shellby-mcp.git
   cd shellby-mcp
   npm ci
   ```

2. Authenticate ngrok:

   ```bash
   ngrok config add-authtoken <your-token>
   ```

   Get an authtoken from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken) if needed.

3. Create the active Shellby config:

   ```bash
   npm run setup -- --config-only
   ```

   Review `.shellby/config.toml` and edit any values you want to customize. The generated file shows every supported setting: defaults are active, and settings without defaults are commented examples.

4. Run guided setup:

   ```bash
   npm run setup
   ```

   Setup checks the machine, prepares the workspace, and builds Shellby MCP. It also checks Computer Use and prepares the dedicated ChatGPT Chrome profile when those tool groups are enabled.

5. Run the first managed start from Terminal.app:

   ```bash
   npm start
   ```

   This creates or reuses the repository-local PM2 runtime, starts Shellby MCP and ngrok, launches the configured ChatGPT browser when agent tools are enabled, waits for local health, and prints the public `/mcp` URL. Starting from Terminal.app gives the managed process tree the intended macOS permission context for Computer Use.

6. In ChatGPT Developer Mode, create a custom MCP app with the printed `https://.../mcp` URL and select **No Auth**.

> [!IMPORTANT]
> The first trusted remote tool call binds the installation to that ChatGPT subject. Run `npm run auth:add` to let one more ChatGPT account bind on its next tool call; every bound account gets full access to this machine. Use `npm run auth:reset` only when you intend to clear all bindings.

### Verify the installation

```bash
npm run status
curl -fsS http://127.0.0.1:3333/healthz
npm run print-url
```

The default local MCP endpoint is `http://127.0.0.1:3333/mcp`; root `port` in `.shellby/config.toml` changes the listener and health-check port.

## Optional capabilities

<details>
<summary><strong>Computer Use</strong></summary>

Shellby ships a package-local Peekaboo CLI build that matches its Computer Use adapter. Check or grant permissions with:

```bash
npm run setup:computer
```

Screen Recording enables observation. Accessibility and Event Synthesizing enable actions. Shellby always uses its bundled Peekaboo executable so the adapter and CLI stay on the tested version together.

See [Computer Use](wiki/pages/computer-use.md) for runtime details.

</details>

> [!WARNING]
> Browser-backed ChatGPT agent features (`clones` and `subagents`) automate ChatGPT Web and may conflict with [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/). Disable them with `tools.clones = false` and `tools.subagents = false` in `.shellby/config.toml`. Use these features at your own risk.

<details>
<summary><strong>Browser-backed ChatGPT subagents</strong></summary>

Run the dedicated browser setup when Chrome was unavailable during initial setup or when you want to configure it later:

```bash
npm run setup:chatgpt
```

This creates a dedicated Chrome profile under `<state_dir>/chatgpt-chrome` and attaches over CDP at `127.0.0.1:9222`. `state_dir` defaults to `~/.shellby`. Sign into ChatGPT once in that profile. Future `npm start` runs launch it automatically while clone or subagent tools are enabled.

Conversation URL and turn count are persisted for reused `agent_id` values. Use `npm run reset-agents` to forget those local mappings.

See [Browser ChatGPT Subagents](wiki/pages/subagents/browser-chatgpt-subagents.md) for lifecycle details.

</details>

<details>
<summary><strong>Control your real Chrome</strong></summary>

The `browser_*` tools drive your everyday Chrome, with its logins, through the extension in [`browser-extension/`](browser-extension/). They are off by default.

1. Set `tools.browser = true` in `.shellby/config.toml`, then run `npm run restart`.
2. In `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select the `browser-extension` folder.
3. Run `npm run browser:pair` and paste the code into the extension's popup.

The agent only sees tabs in the green **Shellby** tab group. The first time it reaches a site, Chrome asks you to allow or deny that site. The popup can pause the bridge and forget a site, and dismissing Chrome's debugging banner removes that tab from the group.

See [Chrome Bridge](wiki/pages/tools/browser.md) for the trust model.

</details>

## Operations

| Command                | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm start`            | Build and start or reload Shellby MCP, ngrok, and enabled supporting services. |
| `npm run restart`      | Rebuild, clear the audit log, and reload services using the existing PM2 daemon. |
| `npm run restart -- --hard` | Rebuild and recreate Shellby's PM2 daemon from a healthy Terminal.app session. |
| `npm run status`       | Show PM2 process state.                                                        |
| `npm run logs`         | Follow PM2 logs.                                                               |
| `npm run logs:runtime` | Follow structured request, tool, background-task, and error events.             |
| `npm run pm2 -- <args>` | Run a PM2 command against Shellby's dedicated daemon.                          |
| `npm run print-url`    | Print the active public `/mcp` URL.                                            |
| `npm run stop`         | Stop the managed Shellby MCP and ngrok processes.                              |
| `npm run auth:add`     | Let one more ChatGPT account bind on its next tool call, after confirmation.   |
| `npm run auth:reset`   | Clear every bound remote ChatGPT subject after confirmation.                   |
| `npm run reset-agents` | Forget persisted subagent conversation mappings.                               |

PM2 is installed as a repository dependency. All Shellby PM2 commands use `<state_dir>/pm2` for their daemon, sockets, logs, and process state. `state_dir` defaults to `~/.shellby`. This is separate from the default `~/.pm2` daemon used by other projects; use `npm run pm2 -- <args>` for direct access to Shellby's daemon.

Use `npm run restart` for routine code or config changes, including from `shell_run`. It keeps the PM2 daemon, reloads ngrok, then reloads MCP. The initiating shell and MCP connection may close; after services return, make a fresh tool call. Build failures leave running services and the audit log intact. The authenticated ChatGPT Chrome profile is reused.

For macOS permission or service-context problems, run `npm run restart -- --hard` from a healthy Terminal.app session. This also recreates Shellby's dedicated PM2 daemon. Hard restart refuses to run inside Shellby because stopping that daemon would kill the command responsible for starting its replacement.

If Shellby was previously running under the default shared daemon, move it once from Terminal.app before using the new commands:

```sh
PM2_HOME="$HOME/.pm2" ./node_modules/.bin/pm2 delete shellby-mcp shellby-ngrok
npm run restart
```

The first command removes only Shellby's old app entries, leaving the shared daemon and other projects running. If an older installation still has a `shellby-cursor-host` entry in that daemon, delete that entry there too. The migration briefly interrupts Shellby; it does not erase authentication or browser profiles. Future restarts need only `npm run restart`.

### Update an existing installation

```bash
git pull
npm ci
npm run setup -- --config-only
npm start
```

## Configuration

Shellby's public configuration is the gitignored `.shellby/config.toml`. `npm run setup` creates a config showing every supported setting for new installations, with defaults active and the optional `ngrok.url` shown as a commented example. Uncomment and customize that URL to use a reserved ngrok endpoint; leaving it commented lets ngrok assign the public URL. Existing files are left untouched, preserving their values, comments, and formatting. Missing settings use defaults automatically. Invalid values produce a warning and fall back individually; unknown keys warn and are ignored. Valid TOML formatting—including reordered sections, dotted keys, and inline tables—is accepted. Malformed TOML syntax still needs correction; errors show the location and never rewrite your file.

The TOML surface currently owns the runtime state directory, workspace, shell path, ChatGPT CDP/project routing, MCP tool-output format, and startup-static tool groups. `state_dir` controls machine-local Shellby state such as authentication, subagent persistence, the dedicated Chrome profile, and the PM2 daemon; it defaults to `~/.shellby`. The generated config enables every tool group and defaults tool output to `compact`. Setting a group to `false` removes those tools from `tools/list` after Shellby restarts and skips its supporting runtime service where one exists. `start_here` is always published. For example, this customization disables browser-backed agents and Computer Use:

```toml
state_dir = "~/.shellby"
workspace = "~/Desktop/agent-workspace"

[shell]
path = "/bin/zsh"
rtk = false

[chatgpt]
cdp_endpoint = "http://127.0.0.1:9222"
project_url = "https://chatgpt.com/"
max_delegated_agents = 3

[mcp]
tool_output = "compact"

[tools]
review = true
shell = true
apply_patch = true
clones = false
subagents = false
web = true
skills = true
image = true
computer = false
```

`chatgpt.max_delegated_agents` sets the maximum number of delegated agent IDs per main-agent session, shared by subagents and clones. It defaults to `3`; invalid values warn and fall back to `3`. Set a positive integer to override it. Saved agents and in-flight creations count toward the limit; existing IDs remain reusable even if the limit is lowered. The per-call batch limit remains three. Older configs can omit this field. To override it, add it under `[chatgpt]`, then restart Shellby after changing its value.

`mcp.tool_output` controls the representation used for ordinary tool results. `compact` is optimized for model context and omits public output schemas; `structured` preserves each tool's structured result and output schema for MCP clients that use them. Computer Use and `image_view` keep their native MCP content in either mode. Changing this setting requires a Shellby restart.

Runtime logging defaults to off. Set `enabled = true` under `[logging]` in `.shellby/config.toml` and restart Shellby to enable rotating operational logs. Use `npm run logs:runtime` to follow them. The separate `agent-commands.yaml` tool-usage record remains enabled.

`shell.rtk` defaults to `false`, so RTK is not required to install or run Shellby. To enable transparent RTK command rewriting, install RTK Token Killer with `brew install rtk`, set `shell.rtk = true`, and restart Shellby. Shellby resolves that executable from startup `PATH`, then uses the resolved absolute path for supported rewrites regardless of the shell command's cwd. Unsupported rewrites and RTK failures fall back to the original command. Shellby keeps the caller's original command for request identity, auditing, and command previews, and disables RTK's separate failure tee, telemetry, and persistent history for Shellby-launched commands while still loading normal RTK filtering/exclusion configuration.

Shellby does not use a repository `.env` file. User-configurable Shellby settings come only from `.shellby/config.toml`; external tools use their normal machine-level configuration. In particular, ngrok is resolved from `PATH` and authentication is configured with `ngrok config add-authtoken`. Chrome is discovered in the normal macOS application locations, and Shellby uses its bundled Peekaboo build. The loopback host and internal runtime limits remain code-owned in [`src/config.ts`](src/config.ts).

### Running two copies

Give each repository copy its own state directory, MCP port, and ChatGPT CDP port when agent tools are enabled. Copies using ngrok also need separate ngrok API ports and public URLs. Changing only `state_dir` separates saved state and PM2, but does not prevent port collisions. In the second copy's `.shellby/config.toml`, merge these values into the existing root and sections:

```toml
state_dir = "~/.shellby-second"
port = 3334

[ngrok]
api_port = 4041
url = "https://your-second-reserved-domain.ngrok.app"
pooling_enabled = false

[chatgpt]
cdp_endpoint = "http://127.0.0.1:9223"
```

Use a real, distinct ngrok URL available to your account. Keep pooling disabled for independent copies. If your config is missing, run `npm run setup -- --config-only` first, then edit it before full setup or startup. Run `npm run setup` in the new copy, sign into its dedicated Chrome profile if agent tools are enabled, then run `npm start` from Terminal.app. Run `npm run print-url` in each repository to get that copy's connector URL.

Each copy's PM2 commands, including hard restart, target its configured state directory. Authentication, subagent mappings, and Chrome profiles stay separate. ngrok credentials remain in its native user config; Shellby writes only an API-address overlay at `<state_dir>/ngrok-agent.json`. The dashboard uses the copy's MCP port (`http://127.0.0.1:3334/ui/` for this example); the Vite development proxy also reads that port. Workspace files and the macOS desktop are still shared unless you select a separate `workspace`; Computer Use still controls the same desktop.

### Local-only MCP

To run without ngrok, add or update this setting in `.shellby/config.toml`:

```toml
[ngrok]
enabled = false
```

Then use the usual `npm start` or `npm run restart`. PM2, enabled tool services, Chrome startup, and the optional dashboard still work. Setup and preflight skip ngrok installation/authentication checks. Startup removes any existing `shellby-ngrok` process from this instance's PM2 daemon before reloading MCP; a cleanup failure stops startup. Separately managed tunnels are outside this setting's scope.

`npm run print-url` prints `http://127.0.0.1:<port>/mcp` for your local MCP client. A new installation can run `npm run setup -- --config-only`, set `ngrok.enabled = false`, then run full setup without installing ngrok. The setting defaults to `true`, so existing configurations retain their behavior. Reserved URL and pooling values remain saved for later re-enabling. Local-only copies do not need a separate ngrok API port or public URL.

## Troubleshooting

If the endpoint stays offline after restarting, check `npm run status` and `npm run logs` from Terminal.app. Run `npm start` if services are stopped. `npm run print-url` reports the active ngrok endpoint; an offline reserved URL does not by itself mean your config changed. Routine restart through `shell_run` may disconnect its own call while PM2 brings MCP back.

<details>
<summary><strong>Setup or startup fails</strong></summary>

Run:

```bash
npm run preflight
npm run status
npm run logs
```

`preflight` checks the supported macOS/Node environment, local dependencies, ngrok installation, and ngrok authentication. If `/healthz` does not become available after startup, inspect PM2 status and logs first.

</details>

<details>
<summary><strong>Computer Use permissions are missing</strong></summary>

Run `npm run setup:computer` from Terminal.app and follow Peekaboo's permission guidance. Keep the managed Shellby process associated with the same intended Terminal permission context.

</details>

<details>
<summary><strong>The PM2 daemon needs to be recreated</strong></summary>

Run `npm run restart -- --hard` from a newly opened Terminal.app session. This recreates Shellby's dedicated PM2 daemon as well as Shellby MCP and ngrok. A stale macOS session inherited by PM2 can cause Chromium to abort before navigation and DNS lookups to fail even while MCP remains reachable. Ordinary restart retains the daemon's session and cannot repair that context. Daemon isolation does not make PM2 independent of Terminal's macOS session; keep Terminal.app running until PM2 is managed through a macOS LaunchAgent.

</details>

More startup and recovery details are in [Configuration and Startup](wiki/pages/operations/configuration-and-startup.md).

## Security

- The checked-in ngrok traffic policy exposes the local MCP endpoint to ChatGPT.
- Direct localhost MCP access is unauthenticated. Do not expose the local endpoint through another untrusted proxy.
- Trusted remote tool calls are limited to the ChatGPT subjects stored in `<state_dir>/auth.json`: the first caller, plus one account per `npm run auth:add`.
- The dedicated authenticated Chrome profile is part of the trust boundary for browser subagents.
- `tools.browser` lets an approved agent act with your logged-in sessions on sites you allow. Page content can try to mislead the agent, so allow only sites you are comfortable with. It is off by default.
- `agent-commands.yaml` can contain sensitive tool inputs. It is gitignored and permission-restricted and should be treated as private.

See [SECURITY.md](SECURITY.md) for reporting and scope.

## Development

```bash
npm run dev
npm run ui:dev
npm run lint
npm run typecheck
npm test
npm run build
npm run ui:build
```

Run `npm run ui:install` once after cloning to install the dashboard dependencies. Use `npm run inspect` for the MCP inspector and `npm run schemas` to print the published tool schemas. Authenticated browser tests are excluded from CI. See [Build and Test](wiki/pages/operations/build-and-test.md).

## Documentation

The [maintainer wiki](wiki/) contains implementation and operational details:

- [Project Overview](wiki/pages/project-overview.md)
- [Architecture Map](wiki/pages/architecture-map.md)
- [Configuration and Startup](wiki/pages/operations/configuration-and-startup.md)
- [Computer Use](wiki/pages/computer-use.md)
- [MCP Tool Surface](wiki/pages/mcp-tool-surface.md)
- [Build and Test](wiki/pages/operations/build-and-test.md)
- [Open Questions and Risks](wiki/pages/project/open-questions-and-risks.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Run the development validation commands above for code changes.

## License

[MIT](LICENSE). The vendored `apply_patch` binary retains its upstream OpenAI Codex license and notices under [`vendor/apply-patch/`](vendor/apply-patch/).

Shellby MCP is created and maintained by [Serbyte Development](https://www.serbyte.net/).
