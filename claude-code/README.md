# Rubato for Claude Code

[Rubato](https://github.com/lovaxi/Rubato_Device) (musical term: *stolen time*) is a desk device that mirrors the rhythm of an AI coding session: **Thinking** while the model reasons, **Generating** while it writes, a soft **breathing** while tools run, and **Done** when the turn is over.

This plugin streams Claude Code's model-call lifecycle to that device over MQTT (EMQX Cloud). It is the Claude Code port of the family defined in [Rubato_Plugins/PLUGIN_SPEC.md](https://github.com/lovaxi/Rubato_Plugins) — `dsh/` there is the authoritative implementation; every port copies its semantics item by item.

| Harness | Plugin | clientId prefix |
|---|---|---|
| DeepSeek Harness | Rubato_Plugins/dsh | `DSH-` |
| opencode | Rubato_Plugins/opencode | `OC-` |
| Cursor | Rubato_Plugins/cursor | `CUR-` |
| OpenClaw | Rubato_Plugins/openclaw | `Claw-Rubato-` |
| **Claude Code** | **this repo** | **`CC-RUBATO-`** |

## Install

```text
/plugin marketplace add lovaxi/Rubato_Plugins
/plugin install rubato@rubato-plugins
```

(From a local clone: `/plugin marketplace add ./Rubato_Plugins/claude-code`, then `/plugin install rubato@rubato`.)

## How it works in Claude Code

Claude Code has no in-process plugin API — hooks are external processes. So the plugin uses a two-layer design:

```
hook.mjs (tiny process per event, exit <10 ms)
   └─ drops one JSON event into <runtime>/queue/ and spawns, when needed,
daemon.mjs (single detached instance, lock file, idle-exits after 10 min)
   └─ tails the session transcript, owns ONE persistent MQTT connection
      and publishes the lean message set to rubato/<username>/state
```

Message mapping (spec §2.3/§2.4 — wire is lean: no `estSec`, no `tokens`):

| Claude Code event | Device message |
|---|---|
| UserPromptSubmit | `Estimate` → `Thinking` (stream start, before any chunk) |
| transcript: first text / tool_use block | `Generating` |
| transcript: `stop_reason: end_turn` / Stop hook | `Done` `{model, state, ts}` |
| StopFailure (API error) | `Error` + immediate `Done` (un-stick, §2.4.6) |
| interrupted turn (Esc fires no Stop) → idle_prompt (~60 s), SessionEnd, next prompt, or 20-min stale guard | plain `Done` (the §2.4.8 finally-equivalent) |

Multi-step tool loops are one device turn: intermediate assistant steps never finalize (their `stop_reason` is `tool_use`, not `end_turn`).

## Setup

**Username = the deviceId printed on the device sticker (`RUBATO-xxxxxx`)**, password = the token paired with that deviceId. Everything else is identity-derived:

- `clientId` = `CC-RUBATO-<mac6>` (registered Claude Code prefix, spec §2.2 — derived from the `RUBATO-` part being stripped)
- `topic` = `rubato/<username>/state`
- `enabled` = on automatically once username + password are filled

Two ways to fill credentials (both spec §4):

1. **Plugin options** (recommended): `/plugin` → rubato → fill *Device ID* and *Device token*. Claude Code exports them to the daemon as `CLAUDE_PLUGIN_OPTION_USERNAME/PASSWORD` and they win over the file — token rotation via `/plugin config` takes effect on the next daemon start.
2. **Config file** `rubato-mqtt-config.json`: `{ "username": "RUBATO-xxxxxx", "password": "…" }`. Lookup order: host process cwd first (lets several harnesses share one file), then the plugin's persistent data dir (`~/.claude/plugins/data/…`, survives plugin updates), then the plugin root. Legacy `dsh-mqtt-config.json` / `cc-mqtt-config.json` files are renamed in place automatically. `//` comment lines are tolerated; the first-run template is plain JSON with no comments.

On first run without credentials the plugin drops a template and shows a one-time **SETUP REQUIRED** notice (as a user warning, never into Claude's context). It re-alerts only if credentials are later removed. Console output stays silent otherwise.

## Privacy: what lives on disk

User-side plugins keep **zero persistent local files except the config** (spec §1/§5): no usage archive, no stats, no calibration samples, no model tools. Troubleshooting beyond `/rubato:status` relies on the desk device and the EMQX console.

The hook→daemon queue, lock and liveness status are transient runtime IPC living in the OS temp dir (`%TEMP%\rubato-cc` / `/tmp/rubato-cc`), not user data.

## Commands

- `/rubato:status` — config summary (secrets masked), daemon liveness, publish counters. Read-only; writes nothing.

## Smoke test

```
node tools/cc-smoke-test.mjs
```

End-to-end with **no real broker**: a fake MQTT broker on localhost captures the actual wire traffic and asserts the CONNECT `clientId` (`CC-RUBATO-43216c`), the topic (`rubato/RUBATO-43216c/state`), the lean message sequence `Estimate,Thinking,Generating,Done` (no `estSec`, no `tokens`), Error→Done, session-end un-stick, zero-disk discipline, legacy config migration, stale-lock recovery, hook-spawned daemon and the one-time SETUP notice. Exits 0 when all checks pass.

## Development

- Hooks: `hooks/hooks.json` (exec-form, `node` binary — cross-platform), entry `hooks/hook.mjs`.
- Library: `lib/config.mjs` (lookup + identity derivation), `lib/daemon.mjs` (transcript watcher + MQTT owner), `lib/mqtt.mjs` (vendored zero-dependency MQTT 3.1.1 client: TLS-only 8883, explicit SNI, keepalive 60 s, QoS 1 with PUBACK, 8 s ACK / 10 s CONNECT timeouts).
- Spec conformance: [Rubato_Plugins/PLUGIN_SPEC.md](https://github.com/lovaxi/Rubato_Plugins) — §2.2 clientId registry (Claude Code row: `CC-RUBATO-`), §2.3 lean message set, §2.4 timing semantics, §4 config, §5 zero-disk (user-side), §10 smoke test, §11 naming. Code wins over spec on conflict.

## License

GPL-3.0 — see [LICENSE](LICENSE).
