# Thinktime Plugins

One system, many coding agents: Thinktime makes your AI's working state
visible on a physical desk device. This repository hosts a Thinktime plugin
for every supported agent. The device firmware lives at
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

All plugins publish the same contract — `Estimate -> Thinking -> Generating
-> Done` plus final token usage — as MQTT messages on
`thinktime/<deviceId>/state` (username = deviceId `TT-xxxxxx`, password = its
token, over TLS).

## Install

See [dsh/README.md](dsh/README.md). In a DSH chat, paste:

```text
Install the Thinktime plugin for DSH from https://github.com/lovaxi/Thinktime_Plugins
```

## License

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
