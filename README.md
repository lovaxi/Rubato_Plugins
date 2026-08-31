# Thinktime

English | [简体中文](README.zh-CN.md)

Thinktime makes your AI's working state visible — on a physical desk device.
This repository hosts a Thinktime plugin for every supported coding agent,
one directory each. The device firmware lives at
[lovaxi/Thinktime_Device](https://github.com/lovaxi/Thinktime_Device).

```
model call ──> Thinktime plugin ──> EMQX broker ──> Thinktime device (TFT display)
```

| Directory | Agent | Status |
|---|---|---|
| [dsh/](dsh/) | DeepSeek Harness | available |
| openclaw/ | OpenClaw | planned |
| codex/ | Codex | planned |
| claude-code/ | Claude Code | planned |
| cursor/ | Cursor | planned |
| opencode/ | OpenCode | planned |

## MQTT contract

All plugins publish the same messages on `thinktime/<deviceId>/state` —
one topic per device. Auth mirrors the device firmware: username = deviceId
(`TT-xxxxxx`), password = its token. MQTT 3.1.1 over TLS (8883), one
persistent connection.

| Message | Payload | Notes |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec }` | predicted duration in seconds |
| `Thinking` | `{ model, state, ts }` | first reasoning chunk |
| `Generating` | `{ model, state, ts }` | first answer/tool chunk |
| `Done` | `{ model, state, ts, tokens: { out, cache } }` | final usage; intermediate tool-call steps do not emit Done |

The device shows the model name and a breathing orb that changes color per
phase — slow cream while thinking, faster ice-blue while generating, a green
flash when done. When the estimate predicts a long run during working hours,
the device shows a full-screen health reminder (time to drink water / rest).

## Install

### DeepSeek Harness

Paste this into a DSH chat:

```text
Install the Thinktime plugin for DSH from https://github.com/lovaxi/Thinktime_Plugins
```

That is the whole install — the plugin package is the `dsh/` directory of
that repository. The assistant does everything else and reminds you to
restart. After the restart:

1. The console prints a `SETUP REQUIRED` guide and a config template is
   created automatically.
2. Fill the two values from the device sticker — username = deviceId
   (`TT-xxxxxx`), password = its token — by editing the file, or just tell
   them to the assistant.

Save — the plugin auto-enables on the next message; no restart needed.

### OpenClaw / Codex / Claude Code / Cursor / OpenCode

Planned.

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
