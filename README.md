# Rubato

English | [简体中文](README.zh-CN.md)

Rubato makes your AI's working state visible — on a physical desk device.
This repository hosts a Rubato plugin for every supported coding agent,
one directory each. The device firmware lives at
[Rubato_Device](https://github.com/lovaxi/Rubato_Device).

![Rubato device](assets/product.jpg)

![Rubato device in action](https://github.com/user-attachments/assets/32402d91-5818-4a01-8f6a-1bca316787a9)


```
model call ──> Rubato plugin ──> EMQX broker ──> Rubato device (TFT display)
```

| Directory | Agent | Status |
|---|---|---|
| [dsh/](dsh/) | DeepSeek Harness | available |
| openclaw/ | OpenClaw | planned |
| codex/ | Codex | planned |
| claude-code/ | Claude Code | planned |
| cursor/ | Cursor | planned |
| [opencode/](opencode/) | OpenCode | available |

## MQTT contract

All plugins publish the same messages on `rubato/<deviceId>/state` —
one topic per device. Auth mirrors the device firmware: username = deviceId
(`RUBATO-xxxxxx`), password = its token. MQTT 3.1.1 over TLS (8883), one
persistent connection.

| Message | Payload | Notes |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec }` | predicted duration in seconds |
| `Thinking` | `{ model, state, ts }` | first reasoning chunk |
| `Generating` | `{ model, state, ts }` | first answer/tool chunk |
| `Done` | `{ model, state, ts }` | intermediate tool-call steps do not emit Done |

The device shows the model name and a breathing orb that changes color per
phase — slow cream while thinking, faster ice-blue while generating, a green
flash when done. When the estimate predicts a long run during working hours,
the device shows a full-screen health reminder (time to drink water / rest).

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

### OpenClaw / Codex / Claude Code / Cursor

Planned.

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
