# Rubato

English | [简体中文](README.zh-CN.md)

Rubato makes your AI's working state visible — on a physical desk device.
This repository hosts a Rubato plugin for every supported coding agent,
one directory each. The device firmware lives at
[Rubato_Device](https://github.com/lovaxi/Rubato_Device).
The desk device itself is available now on
[Tindie](https://www.tindie.com/products/beartificialintelligence/rubato-retro-mac-ai-desk-companion/) — the official store.

![Rubato device](assets/product.jpg)

![Rubato device in action](assets/product.gif)


```
model call ──> Rubato plugin ──> EMQX broker ──> Rubato device (TFT display)
```

| Directory | Agent | Status |
|---|---|---|
| [dsh/](dsh/) | DeepSeek Harness | available |
| [openclaw/](openclaw/) | OpenClaw | available |
| codex/ | Codex | planned |
| claude-code/ | Claude Code | planned |
| [cursor/](cursor/) | Cursor | available |
| [opencode/](opencode/) | OpenCode | available |

## MQTT contract

All plugins publish the same messages on `rubato/<deviceId>/state` —
one topic per device. Auth mirrors the device firmware: username = deviceId
(`RUBATO-xxxxxx`), password = its token. MQTT 3.1.1 over TLS (8883), one
persistent connection.

| Message | Payload | Notes |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec? }` | predicted duration in seconds — carried by the DSH plugin only (user-side plugins omit it) |
| `Thinking` | `{ model, state, ts }` | first reasoning chunk |
| `Generating` | `{ model, state, ts }` | first answer/tool chunk |
| `Done` | `{ model, state, ts }` | intermediate tool-call steps do not emit Done |

The device shows the model name and a breathing orb that changes color per
phase — slow cream while thinking, faster ice-blue while generating, a green
flash when done. When the estimate predicts a long run (estSec ≥ 30), the
device shows a full-screen health reminder mid-task — at most one every
30 minutes (time to drink water / rest).

## Install

### DeepSeek Harness

Paste this into a DSH chat:

```text
Install the Rubato plugin for DSH from https://github.com/lovaxi/Rubato_Plugins/dsh
```

That is the whole install. The assistant copies the plugin package into
place, registers it, and reminds you to restart. After the restart:

1. The console prints a `SETUP REQUIRED` guide and a config template is
   created automatically.
2. Fill the two values from the device sticker — username = deviceId
   (`RUBATO-xxxxxx`), password = its token — by editing the file, or just tell
   them to the assistant.

Save — the plugin auto-enables on the next message; no restart needed.

### OpenCode

Paste this into an opencode chat:

```text
Install the Rubato plugin for OpenCode from https://github.com/lovaxi/Rubato_Plugins/opencode
```

That is the whole install. The assistant copies the plugin package into
place (project `.opencode/plugins/` or global `~/.config/opencode/plugins/`)
and reminds you to restart. After the restart:

1. The console prints a `SETUP REQUIRED` guide and a config template is
   created automatically.
2. Fill the two values from the device sticker — username = deviceId
   (`RUBATO-xxxxxx`), password = its token — by editing the file, or just tell
   them to the assistant.

Save — the plugin auto-enables on the next message; no restart needed.

### Cursor

Cursor is a VS Code fork, so the plugin installs as a VSIX — no build tools
needed.

**Simplest install — two steps:**

1. Download the extension:
   [`cursor/rubato-cursor-1.0.0.vsix`](https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix)
2. In Cursor: Extensions panel → `⋯` menu → **Install from VSIX…** → pick the
   downloaded file → reload the window. (Drag-and-drop of the `.vsix` onto
   the Extensions panel works too.)

Prefer the terminal? One line (the `cursor` CLI ships with Cursor):

```powershell
# Windows (PowerShell)
curl.exe -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix; cursor --install-extension rubato-cursor.vsix
```

```bash
# macOS / Linux
curl -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix && cursor --install-extension rubato-cursor.vsix
```

Then configure (once):

1. The console prints a `SETUP REQUIRED` guide and a config template is
   created automatically next to the plugin (`cursor/dsh-mqtt-config.json` —
   the same file the other Rubato host plugins read on this machine). Command
   palette → **Rubato: Open Config File** opens it for you.
2. Fill the two values from the device sticker — username = deviceId
   (`RUBATO-xxxxxx`), password = its token — by editing the file, or just tell
   them to the assistant.

Save — the plugin auto-enables on the next edit burst; no restart needed.
A device link check lives in the command palette: **Rubato: Send Test Cycle
to Device**.

**How it works** — Cursor exposes no public API for its AI chat, so the
plugin watches what the AI provably does to the workspace: rapid,
non-keystroke document edits (Tab completions, Cmd/Ctrl+K, chat Apply, agent
diffs) form an *edit burst* that maps onto the contract sequence above;
small keystroke-scale edits in the focused editor read as human typing and
are ignored.

Commands (command palette): **Rubato: Show Status** · **Rubato: Send Test
Cycle to Device** · **Rubato: Open Config File**.

Settings: `rubato.modelLabel` (`cursor-agent` — payload model name and
estimator history key), `rubato.settleMs` (`6000` — quiet time in ms that
closes a burst with Done), `rubato.minBurstChars` (`12` — inserted+deleted
chars for an edit to count as AI work in the focused editor),
`rubato.maxBurstMs` (`600000` — safety cap).

<details>
<summary>Build from source (for development)</summary>

```bash
git clone https://github.com/lovaxi/Rubato_Plugins.git
cd Rubato_Plugins/cursor
npx @vscode/vsce package        # -> rubato-cursor-<version>.vsix
```

</details>

### OpenClaw

Paste this into an OpenClaw chat:

```text
Install the Rubato plugin for OpenClaw from https://github.com/lovaxi/Rubato_Plugins/openclaw
```

That is the whole install. The assistant links the plugin package, enables
it, grants the conversation-hook access it needs, and reminds you to restart.
After the restart:

1. The console prints a `SETUP REQUIRED` guide and a config template is
   created automatically.
2. Fill the two values from the device sticker — username = deviceId
   (`RUBATO-xxxxxx`), password = its token — by editing the file, or just tell
   them to the assistant.

Save — the plugin auto-enables on the next message; no restart needed.
OpenClaw's typed hooks have no first-delta event, so `Generating` is not
emitted; the device stays in its thinking breath until `Done`.

### Codex / Claude Code

Planned.

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
