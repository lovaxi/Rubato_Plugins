# Thinktime Plugin for DeepSeek Harness

English | [简体中文](README.zh-CN.md)

Thinktime makes your AI's working state visible — on a physical desk device.

This repository is the DeepSeek Harness (DSH) plugin half of that system. The
other half — the ESP8266 TFT device firmware — lives at
[lovaxi/Thinktime_Device](https://github.com/lovaxi/Thinktime_Device).

```
DSH model call ──> Thinktime plugin ──> EMQX broker ──> Thinktime device (TFT display)
```

Every streaming model call is captured and published as MQTT messages:

```
Estimate -> Thinking -> Generating -> Done
```

The device shows the model name and a breathing orb that changes color per
phase — slow cream while thinking, faster ice-blue while generating, a green
flash when done. When the estimate predicts a long run during working hours,
the device shows a full-screen health reminder (time to drink water / rest).

## MQTT contract

| Message | Payload | Notes |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec }` | predicted duration in seconds |
| `Thinking` | `{ model, state, ts }` | first reasoning chunk |
| `Generating` | `{ model, state, ts }` | first answer/tool chunk |
| `Done` | `{ model, state, ts, tokens: { out, cache } }` | final usage; intermediate tool-call steps do not emit Done |

Topic: `thinktime/<deviceId>/state` — one topic per hardware device.
Auth mirrors the device firmware: username = deviceId (`TT-xxxxxx`),
password = its token. MQTT 3.1.1 over TLS (8883), one persistent connection.

## Install — one line in the DSH window

Paste this into a DSH chat:

```text
Install the Thinktime plugin from https://github.com/lovaxi/Thinktime_Plugin_DSH
```

That is the whole install. The assistant does everything else and reminds
you to restart. After the restart:

1. The console prints a `SETUP REQUIRED` guide and a config template is
   created automatically.
2. Fill the two values from the device sticker — username = deviceId
   (`TT-xxxxxx`), password = its token — by editing the file, or just tell
   them to the assistant.

Save — the plugin auto-enables on the next message; no restart needed.

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
