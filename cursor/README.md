# Rubato for Cursor

Model-state monitor for [Cursor](https://cursor.com) (a VS Code fork). See the
repository root [README](../README.md) and [PLUGIN_SPEC](../PLUGIN_SPEC.md)
for the family-wide contract; this directory is the complete plugin package.

## How it works

Cursor exposes no public API for its AI chat, so the observable AI signal is
what the AI writes to the workspace: rapid, non-keystroke document edits —
Tab completions, Cmd/Ctrl+K inline edits, chat Apply, multi-file agent diffs.
These form an *edit burst* (lib/tracker.js) that maps onto the device
contract:

```
Estimate -> Thinking -> Generating -> Done
```

- small keystroke-scale edits in the focused editor = human typing, ignored
- larger edits, or edits outside the focused editor = AI work
- burst open → Estimate (zero-token kNN over this model's past bursts) +
  Thinking; continued edits → Generating; a quiet window (`rubato.settleMs`,
  default 6 s) closes the burst with a debounced Done that the next edit
  cancels — mid-burst continuation never flashes Done, exactly like dsh's
  `tool-calls` handling
- Error + Done has no Cursor equivalent: the host exposes no failure signal;
  every burst still closes with Done, which un-sticks the device

## Install

Simplest — no build tools:

1. Download the extension:
   [`rubato-cursor-1.0.0.vsix`](https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix)
2. Cursor → Extensions panel → `⋯` → **Install from VSIX…** → pick the file →
   reload the window (or drag the `.vsix` onto the Extensions panel).

Or one line with the `cursor` CLI (ships with Cursor):

```powershell
# Windows (PowerShell)
curl.exe -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix; cursor --install-extension rubato-cursor.vsix
```

```bash
# macOS / Linux
curl -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix && cursor --install-extension rubato-cursor.vsix
```

Build from source (development):

```bash
git clone https://github.com/lovaxi/Rubato_Plugins.git
cd Rubato_Plugins/cursor
npx @vscode/vsce package        # -> rubato-cursor-<version>.vsix
```

## Setup

One file, two values — the config is `dsh-mqtt-config.json`, looked up in the
extension host's cwd first, then next to the plugin (the same file the other
Rubato host plugins on this machine read):

```json
{
  "username": "",
  "password": ""
}
```

- `username`: the deviceId printed on the device sticker (`RUBATO-xxxxxx`)
- `password`: the token paired with that deviceId

clientId (`CUR-RUBATO-xxxxxx`), topic (`rubato/<username>/state`) and enabled
are derived. Save — the plugin hot-reloads on the next edit burst; no restart
needed.

## Commands

- **Rubato: Show Status** — config summary, publish counters, recent records
- **Rubato: Send Test Cycle to Device** — one contract-shaped cycle over the
  plugin's own persistent connection
- **Rubato: Open Config File**

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `rubato.modelLabel` | `cursor-agent` | model name in payloads + estimator history key |
| `rubato.settleMs` | `6000` | quiet time before a burst closes with Done |
| `rubato.minBurstChars` | `12` | inserted+deleted chars for an edit to count as AI work in the focused editor |
| `rubato.maxBurstMs` | `600000` | safety cap for a burst that keeps receiving edits |

## Smoke test

Maintainer check (the `tools/` directory is local-only and not published):

```bash
node tools/cursor-smoke-test.mjs   # from the repository root; exit 0 = pass
```

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
