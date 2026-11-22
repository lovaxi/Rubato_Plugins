# Rubato for Antigravity（中文）

[English](README.md) | 简体中文

[Rubato](https://github.com/lovaxi/Rubato_Device)（音乐术语，意为"被偷走的时间"）是一台镜像 AI 编码节奏的桌面设备：模型思考时 **Thinking**、写码/调用工具时 **Generating**、多步工具循环期间保持呼吸态、回合结束时 **Done**。

本插件把 Google Antigravity 的模型调用生命周期通过 MQTT（EMQX Cloud）实时同步到设备。它是 [Rubato_Plugins/PLUGIN_SPEC.md](https://github.com/lovaxi/Rubato_Plugins/blob/main/PLUGIN_SPEC.md) 定义的插件家族中的 Antigravity 移植版——仓库中的 `dsh/` 是权威实现，所有移植逐条对齐其语义。

| 宿主 | 插件 | clientId 前缀 |
|---|---|---|
| DeepSeek Harness | Rubato_Plugins/dsh | `DSH-` |
| opencode | Rubato_Plugins/opencode | `OC-` |
| Cursor | Rubato_Plugins/cursor | `CUR-` |
| OpenClaw | Rubato_Plugins/openclaw | `Claw-` |
| Claude Code | Rubato_Plugins/claude-code | `CC-RUBATO-` |
| Codex | Rubato_Plugins/codex | `Codex-` |
| **Antigravity** | **Rubato_Plugins/antigravity** | **`AGY-`** |

## 安装

前置依赖：已安装 Node.js（`node` 在 `PATH` 中）。

### 方式一：全局安装（对所有 Antigravity 会话生效）

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

### 方式二：在 Antigravity 对话里安装

```text
Install the Rubato plugin for Antigravity from https://github.com/lovaxi/Rubato_Plugins/antigravity
```

或者将本目录复制到项目 `<项目根目录>/.agents/plugins/rubato`（仅工作区生效），并在 Customizations 中确认 **Rubato** 已启用。

## Antigravity 里如何工作

Antigravity 生命周期钩子（插件根目录 `hooks.json`）以同步命令方式运行，因此插件采用两层设计：

```text
hooks/hook.mjs（每个钩子事件一个微型进程，<15 ms 退出）
   └─ 往 <runtime>/queue/ 丢一个 JSON 事件，并在需要时拉起——
lib/daemon.mjs（唯一常驻实例，锁文件互斥，空闲 10 分钟自动退出）
   └─ 跟踪会话 transcript.jsonl，独享一条持久 MQTT 连接，
      把精简消息集发布到 rubato/<username>/state
```

消息映射（spec §2.3/§2.4——wire 精简：无 `estSec`、无 `tokens`）：

| Antigravity 事件 | 设备消息 |
|---|---|
| `PreInvocation` | `Estimate` → `Thinking`（每次调用启动瞬间、任何输出之前） |
| `transcript.jsonl` `PLANNER_RESPONSE`（`content` / `tool_calls`）或 `PostToolUse` | `Generating` |
| 中间 `tool_calls` 步骤（含工具调用的 `PostInvocation`） | 不发 `Done`（保持呼吸态等待下一轮模型调用） |
| `Stop`（`NO_TOOL_CALL`、`USER_CANCELED`、`MAX_*`） | 精简 `Done` `{ model, state, ts }`（用户主动取消不报 `Error`） |
| `Stop`（`ERROR` 或非空 `error`） | `Error` + 立即补发精简 `Done`（解卡，§2.4.6） |
| 缺少 `Stop` 兜底 | 非工具步 1500 ms 去抖或 20 分钟超时兜底 → 精简 `Done` |

## 配置

**username = 设备贴纸上的 deviceId（`RUBATO-xxxxxx`）**，password = 配对 token。其余全部自动派生：

- `clientId` = `AGY-<username>`（即 `AGY-RUBATO-<mac6>`）
- `topic` = `rubato/<username>/state`
- `enabled` = username + password 填齐即自动启用（显式写 `"enabled": false` 可在不卸载的前提下静音）

配置文件 `rubato-mqtt-config.json`：

```json
{
  "username": "RUBATO-xxxxxx",
  "password": "…"
}
```

查找顺序（先命中者生效，每条消息发布前热加载，修改保存后无需重启）：

1. `$RUBATO_DATA_DIR/rubato-mqtt-config.json`（显式覆写 / 测试用）
2. `<工作区 cwd>/rubato-mqtt-config.json`（同一工作区下多个 Rubato 插件共享）
3. `<进程 cwd>/rubato-mqtt-config.json`
4. `$PLUGIN_DATA/rubato-mqtt-config.json`（Antigravity 插件持久化数据目录，插件更新不丢）
5. `<插件根目录>/rubato-mqtt-config.json`

旧名 `dsh-mqtt-config.json` / `agy-mqtt-config.json` 会在首次查找时自动原位改名迁移。

首次运行且未配置凭据时，插件会生成纯 JSON 模板（无 BOM、无注释），并在首次 `PreInvocation` 通过 `user_markdown` 向用户展示一次 `SETUP REQUIRED` 提示（`systemMessage` 为空，绝不进入模型上下文）。

## 隐私：磁盘上有什么

用户端插件**除配置外零持久本地文件**（spec §1/§5/§6）：无用量归档（`rubato-records.jsonl`）、无校准样本（`rubato-stats.json`）、不注册任何模型工具（`mcp_config.json` / `mqmon_status`）、不注入提示词规则或技能。

hook→守护进程的队列、锁与存活状态属于运行时 IPC，存放在系统临时目录（`%TEMP%\rubato-agy` / `/tmp/rubato-agy`），不是用户数据。

## 冒烟测试与状态检查

```bash
node scripts/agy-smoke-test.mjs
```

端到端、**不连真实 broker**：本地起一个假 MQTT broker 捕获真实 wire 流量，断言 CONNECT `clientId`、topic、精简消息序列、Error/Cancel/重写恢复、零落盘纪律、旧配置迁移、陈旧锁恢复、`hooks.json` 命令触发以及一次性 `SETUP REQUIRED` 提示。

终端查看脱敏配置与守护进程状态：

```bash
node scripts/status.mjs
```

## 许可证

GPL-3.0 — 见 [LICENSE](LICENSE)。
