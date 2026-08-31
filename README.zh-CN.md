# Thinktime 插件集

一套系统，多种编码智能体：Thinktime 让 AI 的工作状态在桌面实体设备上可见。
本仓库为每个受支持的智能体提供 Thinktime 插件。设备固件在
[lovaxi/Thinktime_Device](https://github.com/lovaxi/Thinktime_Device)。

```
模型调用 ──> Thinktime 插件 ──> EMQX 服务器 ──> Thinktime 设备（TFT 屏幕）
```

| 目录 | 智能体 | 状态 |
|---|---|---|
| [dsh/](dsh/) | DeepSeek Harness | 可用 |
| openclaw/ | OpenClaw | 计划中 |
| codex/ | Codex | 计划中 |
| claude-code/ | Claude Code | 计划中 |
| cursor/ | Cursor | 计划中 |
| opencode/ | OpenCode | 计划中 |

所有插件发布同一契约——`Estimate -> Thinking -> Generating -> Done` 及最终
token 用量——以 MQTT 消息发送到 `thinktime/<deviceId>/state`
（username = deviceId `TT-xxxxxx`，password = 对应 token，走 TLS）。

## 安装

见 [dsh/README.zh-CN.md](dsh/README.zh-CN.md)。在 DSH 对话里粘贴：

```text
Install the Thinktime plugin for DSH from https://github.com/lovaxi/Thinktime_Plugins
```

## 许可证

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
