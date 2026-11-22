# Rubato for Antigravity

English | [简体中文](README.zh-CN.md)

[Rubato](https://github.com/lovaxi/Rubato_Device) (musical term: *stolen time*) is a desk device that mirrors the rhythm of an AI coding session: **Thinking** while the model reasons, **Generating** while it writes, soft breathing across tool steps, and **Done** when the turn finishes.

This plugin streams Google Antigravity's model-invocation lifecycle to that device over MQTT (EMQX Cloud). It is the Antigravity port of the family defined in [Rubato_Plugins/PLUGIN_SPEC.md](https://github.com/lovaxi/Rubato_Plugins/blob/main/PLUGIN_SPEC.md) — `dsh/` there is the authoritative implementation; every port copies its semantics item by item.

| Harness | Plugin | clientId prefix |
|---|---|---|
| DeepSeek Harness | Rubato_Plugins/dsh | `DSH-` |
| opencode | Rubato_Plugins/opencode | `OC-` |
| Cursor | Rubato_Plugins/cursor | `CUR-` |
| OpenClaw | Rubato_Plugins/openclaw | `Claw-` |
| Claude Code | Rubato_Plugins/claude-code | `CC-RUBATO-` |
| Codex | Rubato_Plugins/codex | `Codex-` |
| **Antigravity** | **Rubato_Plugins/antigravity** | **`AGY-`** |

## Install

Requirements: Node.js (`node` on `PATH`).

### Option 1: Install globally for all Antigravity sessions

```powershell
# Windows (PowerShell)
git clone https://github.com/lovaxi/Rubato_Plugins.git
Copy-Item -Recurse -Force .\Rubato_Plugins\antigravity "$env:USERPROFILE\.gemini\config\plugins\rubato"
```

```bash
# macOS / Linux
git clone https://github.com/lovaxi/Rubato_Plugins.git
mkdir -p ~/.gemini/config/plugins && cp -r ./Rubato_Plugins/antigravity ~/.gemini/config/plugins/rubato
```

### Option 2: Paste into an Antigravity chat

```text
Install the Rubato plugin for Antigravity from https://github.com/lovaxi/Rubato_Plugins/antigravity
```

Or copy this directory into `<project-root>/.agents/plugins/rubato` for workspace-only use, then verify in Antigravity Customizations that **Rubato** appears and is enabled.

## How it works in Antigravity

Antigravity lifecycle hooks are synchronous shell commands (`hooks.json` at the plugin root). So the plugin uses a two-layer design:

```text
hooks/hook.mjs (fast synchronous entry per hook event, <15 ms)
   └─ drops one JSON event into <runtime>/queue/ and spawns, when needed,
lib/daemon.mjs (single detached instance, lock file, idle-exits after 10 min)
   └─ tails the session transcript.jsonl, owns ONE persistent MQTT connection
      and publishes the lean message set to rubato/<username>/state
```

Message mapping (spec §2.3/§2.4 — wire is lean: no `estSec`, no `tokens`):

| Antigravity event | Device message |
|---|---|
| `PreInvocation` | `Estimate` → `Thinking` (invocation start, before any chunk) |
| `transcript.jsonl` `PLANNER_RESPONSE` (`content` / `tool_calls`) or `PostToolUse` | `Generating` |
| Intermediate `tool_calls` step (`PostInvocation` after tools) | No `Done` (tool loop stays in breathing state) |
| `Stop` (`NO_TOOL_CALL`, `USER_CANCELED`, `MAX_*`) | Lean `Done` `{ model, state, ts }` (user stop is not an error) |
| `Stop` (`ERROR` or non-empty `error`) | `Error` + immediate `Done` (un-stick, §2.4.6) |
| Missing `Stop` fallback | 1500 ms post-invocation debounce (non-tool steps) or 20-min stale guard → lean `Done` |

## Setup

**Username = the deviceId printed on the device sticker (`RUBATO-xxxxxx`)**, password = the token paired with that deviceId. Everything else is identity-derived:

- `clientId` = `AGY-<username>` (`AGY-RUBATO-<mac6>`)
- `topic` = `rubato/<username>/state`
- `enabled` = on automatically once username + password are filled (set `"enabled": false` to silence without uninstalling)

Config file `rubato-mqtt-config.json`:

```json
{
  "username": "RUBATO-xxxxxx",
  "password": "…"
}
```

Lookup order (first existing file wins; hot-reloaded on every message with no restart needed):

1. `$RUBATO_DATA_DIR/rubato-mqtt-config.json` (explicit override / tests)
2. `<workspace cwd>/rubato-mqtt-config.json` (shared across Rubato harnesses in the same workspace)
3. `<process cwd>/rubato-mqtt-config.json`
4. `$PLUGIN_DATA/rubato-mqtt-config.json` (Antigravity's persistent plugin data dir, survives plugin updates)
5. `<plugin root>/rubato-mqtt-config.json`

Legacy `dsh-mqtt-config.json` / `agy-mqtt-config.json` files are renamed in place automatically on first lookup.

On first run without credentials, the plugin drops a clean `rubato-mqtt-config.json` template (pure JSON, no BOM, no comments) and shows a one-time `SETUP REQUIRED` notice inline via `user_markdown` (without entering the model's context).

## Privacy: what lives on disk

User-side plugins keep **zero persistent local files except the config** (spec §1/§5/§6): no usage archive (`rubato-records.jsonl`), no calibration stats (`rubato-stats.json`), no model tools (`mcp_config.json` / `mqmon_status`), and no prompt rules/skills.

The hook→daemon queue, lock, and liveness status are transient runtime IPC living in the OS temp dir (`%TEMP%\rubato-agy` / `/tmp/rubato-agy`), not user data.

## Smoke test & status check

```bash
node scripts/agy-smoke-test.mjs
```

End-to-end with **no real broker**: spins up a fake MQTT broker on localhost, asserts CONNECT `clientId`, topic, lean state sequences, error/cancel/rewrite recovery, zero-disk discipline, legacy migration, stale-lock recovery, `hooks.json` invocation, and one-time `SETUP REQUIRED` notice.

Inspect masked config and daemon liveness from the terminal:

```bash
node scripts/status.mjs
```

## License

GPL-3.0 — see [LICENSE](LICENSE).
