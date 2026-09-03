# Rubato for Claude Code（中文）

[Rubato](https://github.com/lovaxi/Rubato_Device)（音乐术语，意为"被偷走的时间"）是一台镜像 AI 编码节奏的桌面设备：模型思考时 **Thinking**、写码时 **Generating**、跑工具时轻柔的呼吸态、回合结束 **Done**。

本插件把 Claude Code 的模型调用生命周期通过 MQTT（EMQX Cloud）实时同步到设备。它是 [Rubato_Plugins/PLUGIN_SPEC.md](https://github.com/lovaxi/Rubato_Plugins) 定义的插件家族中的 Claude Code 移植版——仓库中的 `dsh/` 是权威实现，所有移植逐条对齐其语义。

| 宿主 | 插件 | clientId 前缀 |
|---|---|---|
| DeepSeek Harness | Rubato_Plugins/dsh | `DSH-` |
| opencode | Rubato_Plugins/opencode | `OC-` |
| Cursor | Rubato_Plugins/cursor | `CUR-` |
| OpenClaw | Rubato_Plugins/openclaw | `Claw-Rubato-` |
| **Claude Code** | **本仓库** | **`CC-RUBATO-`** |

## 安装

```text
/plugin marketplace add lovaxi/Rubato_Plugins
/plugin install rubato@rubato-plugins
```

（本地克隆安装：`/plugin marketplace add ./Rubato_Plugins/claude-code`，然后 `/plugin install rubato@rubato`。）

## Claude Code 里如何工作

Claude Code 没有进程内插件 API——钩子都是外部进程。因此采用两层设计：

```
hook.mjs（每个钩子事件一个微型进程，<10 ms 退出）
   └─ 往 <runtime>/queue/ 丢一个 JSON 事件，并在需要时拉起——
daemon.mjs（唯一常驻实例，锁文件，空闲 10 分钟自动退出）
   └─ 跟踪会话 transcript，独享一条持久 MQTT 连接，
      把精简消息集发布到 rubato/<username>/state
```

消息映射（spec §2.3/§2.4——wire 精简：无 `estSec`、无 `tokens`）：

| Claude Code 事件 | 设备消息 |
|---|---|
| UserPromptSubmit | `Estimate` → `Thinking`（流启动、任何 chunk 之前） |
| transcript：首个 text / tool_use 块 | `Generating` |
| transcript：`stop_reason: end_turn` / Stop 钩子 | `Done` `{model, state, ts}` |
| StopFailure（API 出错） | `Error` + 立即 `Done`（解卡，§2.4.6） |
| 被打断的回合（Esc 不触发 Stop）→ idle_prompt（约 60 s）、SessionEnd、下一条 prompt、或 20 分钟超时兜底 | 普通 `Done`（即 §2.4.8 的 finally 等价物） |

多步工具循环对设备是同一个回合：中间 assistant 步骤不会终结（其 `stop_reason` 是 `tool_use` 而非 `end_turn`）。

## 配置

**username = 设备贴纸上的 deviceId（`RUBATO-xxxxxx`）**，password = 配对 token。其余全部自动派生：

- `clientId` = `CC-RUBATO-<mac6>`（Claude Code 已登记前缀，spec §2.2——去掉设备号的 `RUBATO-` 前缀拼接）
- `topic` = `rubato/<username>/state`
- `enabled` = username + password 填齐即自动启用

两种填写方式（均为 spec §4）：

1. **插件选项**（推荐）：`/plugin` → rubato → 填 *Device ID* 和 *Device token*。Claude Code 会以 `CLAUDE_PLUGIN_OPTION_USERNAME/PASSWORD` 环境变量传给守护进程，且优先于文件——用 `/plugin config` 轮换 token，守护进程下次启动即生效。
2. **配置文件** `rubato-mqtt-config.json`：`{ "username": "RUBATO-xxxxxx", "password": "…" }`。查找顺序：宿主进程 cwd 优先（多个宿主共享一份配置），其次是插件持久数据目录（`~/.claude/plugins/data/…`，插件更新不丢），最后是插件根目录。旧名 `dsh-mqtt-config.json` / `cc-mqtt-config.json` 会自动原位改名迁移。容忍 `//` 注释行；首次运行生成的模板是纯 JSON、无注释。

首次运行且未配置时，插件会落一个模板并提示一次 **SETUP REQUIRED**（以用户警告形式展示，绝不进入 Claude 上下文）；只有凭据后来被清空才会再次提醒。其余情况控制台完全静默。

## 隐私：磁盘上有什么

用户端插件**除配置外零持久本地文件**（spec §1/§5）：无用量归档、无统计、无校准样本、不注册任何模型工具。`/rubato:status` 之外的排障依赖设备端与 EMQX 控制台。

hook→守护进程的队列、锁与存活状态是运行时 IPC，存放在系统临时目录（`%TEMP%\rubato-cc` / `/tmp/rubato-cc`），不是用户数据。

## 命令

- `/rubato:status` — 配置摘要（密钥打码）、守护进程存活、发布计数。只读，不写盘。

## 冒烟测试

```
node tools/cc-smoke-test.mjs
```

端到端、**不连真实 broker**：本地起一个假 MQTT broker 捕获真实 wire 流量，断言 CONNECT 的 `clientId`（`CC-RUBATO-43216c`）、topic（`rubato/RUBATO-43216c/state`）、精简消息序列 `Estimate,Thinking,Generating,Done`（无 `estSec`、无 `tokens`）、Error→Done、会话结束解卡、零落盘纪律、旧配置迁移、陈旧锁恢复、钩子拉起守护进程以及一次性 SETUP 提示。全部通过退出码 0。

## 开发

- 钩子：`hooks/hooks.json`（exec 形式，`node` 二进制——跨平台），入口 `hooks/hook.mjs`。
- 库：`lib/config.mjs`（查找 + 身份派生）、`lib/daemon.mjs`（transcript 监听 + MQTT 属主）、`lib/mqtt.mjs`（内置零依赖 MQTT 3.1.1 客户端：仅 TLS 8883、显式 SNI、keepalive 60 s、QoS 1 带 PUBACK、8 s ACK / 10 s CONNECT 超时）。
- spec 对齐：[Rubato_Plugins/PLUGIN_SPEC.md](https://github.com/lovaxi/Rubato_Plugins)——§2.2 clientId 登记表（Claude Code 行：`CC-RUBATO-`）、§2.3 精简消息集、§2.4 时序语义、§4 配置、§5 零落盘（用户端）、§10 冒烟测试、§11 命名。代码与 spec 冲突时以代码为准。

## 许可证

GPL-3.0 — 见 [LICENSE](LICENSE)。
