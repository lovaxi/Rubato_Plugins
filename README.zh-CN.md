# Rubato

[English](README.md) | 简体中文

Rubato 让 AI 的工作状态在桌面实体设备上可见。本仓库为每个受支持的编码
智能体各提供一个 Rubato 插件，一个插件一个目录。设备固件在
[lovaxi/Rubato_Device](https://github.com/lovaxi/Rubato_Device)。
设备整机已在
[Tindie](https://www.tindie.com/products/beartificialintelligence/rubato-retro-mac-ai-desk-companion/) 正式发售。

![Rubato 设备](assets/product.jpg)

![Rubato 设备效果](assets/product.gif)

```
模型调用 ──> Rubato 插件 ──> EMQX 服务器 ──> Rubato 设备（TFT 屏幕）
```

| 目录 | 智能体 | 状态 |
|---|---|---|
| [dsh/](dsh/) | DeepSeek Harness | 可用 |
| [openclaw/](openclaw/) | OpenClaw | 可用 |
| [codex/](codex/) | Codex | 可用——未经实测 |
| claude-code/ | Claude Code | 计划中 |
| [cursor/](cursor/) | Cursor | 可用——未经实测 |
| [opencode/](opencode/) | OpenCode | 可用 |

## MQTT 契约

所有插件发布相同的消息到 `rubato/<deviceId>/state`——每台设备一个主题。
认证与设备固件一致：username = deviceId（`RUBATO-xxxxxx`），password = 对应
token。MQTT 3.1.1 over TLS（8883），单条持久连接。

| 消息 | 载荷 | 说明 |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec? }` | 预估时长（秒）——仅 dsh 插件携带（用户端插件不带该字段） |
| `Thinking` | `{ model, state, ts }` | 首个思考片段 |
| `Generating` | `{ model, state, ts }` | 首个回答/工具片段 |
| `Done` | `{ model, state, ts }` | 中间工具调用步骤不发送 Done |

设备屏幕显示模型名和随阶段变色的呼吸光环——思考时奶油色慢呼吸，生成时
冰蓝色快呼吸，结束时绿色收尾。当预估时长 ≥ 30 秒，设备会在任务运行中全屏
显示健康提醒（喝水 / 休息时间到了），两次全屏提醒全局间隔 ≥ 30 分钟。

## 安装

### DeepSeek Harness

在 DSH 对话里粘贴：

```text
Install the Rubato plugin for DSH from https://github.com/lovaxi/Rubato_Plugins/dsh
```

这就是全部安装步骤。助手会把插件包复制到位并注册，然后提醒你重启。重启后：

1. 控制台会打印 `SETUP REQUIRED` 指南，并自动生成配置模板。
2. 把设备贴纸上的两个值填进去——username = deviceId（`RUBATO-xxxxxx`），
   password = 对应 token——可以自己编辑文件，或直接告诉助手。

保存即完成——插件在下一条消息自动启用，无需重启。

### OpenCode

在 opencode 对话里粘贴：

```text
Install the Rubato plugin for OpenCode from https://github.com/lovaxi/Rubato_Plugins/opencode
```

这就是全部安装步骤。助手会把插件包复制到位（项目 `.opencode/plugins/` 或
全局 `~/.config/opencode/plugins/`），然后提醒你重启。重启后：

1. 控制台会打印 `SETUP REQUIRED` 指南，并自动生成配置模板。
2. 把设备贴纸上的两个值填进去——username = deviceId（`RUBATO-xxxxxx`），
   password = 对应 token——可以自己编辑文件，或直接告诉助手。

保存即完成——插件在下一条消息自动启用，无需重启。

### Cursor

Cursor 是 VS Code 的分支，插件以 VSIX 形式安装——无需任何构建工具。

> **⚠️ 未经实测**：作者没有 Cursor 付费订阅（无法自定义模型，触发不了真实
> 的 AI 编辑），编辑突发检测与整体设备映射仍停留在设计阶段（仅离线冒烟测试，
> 未在真实 Cursor 会话中运行过）。如果你实测了，欢迎到
> [Issues](https://github.com/lovaxi/Rubato_Plugins/issues) 反馈实际表现：
> 人类输入被误判为 AI、AI 编辑漏报、设备卡在某个状态等；阈值调参的 PR 尤其
> 欢迎。

**最简安装 —— 两步：**

1. 下载扩展：[`cursor/rubato-cursor-1.1.0.vsix`](https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.1.0.vsix)
2. 在 Cursor 中：扩展面板 → `⋯` 菜单 → **从 VSIX 安装…** → 选择下载的文件 →
   重载窗口。（把 `.vsix` 直接拖进扩展面板也可以。）

喜欢终端？一行搞定（`cursor` 命令随 Cursor 自带）：

```powershell
# Windows (PowerShell)
curl.exe -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.1.0.vsix; cursor --install-extension rubato-cursor.vsix
```

```bash
# macOS / Linux
curl -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.1.0.vsix && cursor --install-extension rubato-cursor.vsix
```

然后配置一次：

1. 控制台会打印 `SETUP REQUIRED` 指南，并自动在插件旁生成配置模板
   （`cursor/rubato-mqtt-config.json` —— 与本机其他 Rubato 宿主插件读的是
   同一个文件；旧名 `dsh-mqtt-config.json` 会在首次查找时自动改名迁移）。
   命令面板 → **Rubato: Open Config File** 可直接打开。
2. 把设备贴纸上的两个值填进去——username = deviceId（`Cursor-RUBATO-xxxxxx`），
   password = 对应 token——可以自己编辑文件，或直接告诉助手。

保存即完成——插件在下一次编辑突发时自动启用，无需重启。命令面板里的
**Rubato: Send Test Cycle to Device** 可做设备链路检查。

**工作原理** —— Cursor 没有公开其 AI 对话的 API，插件观察 AI 对工作区确实
产生的改动：快速、非逐键的文档编辑（Tab 补全、Cmd/Ctrl+K、对话 Apply、
agent 多文件 diff）组成一次*编辑突发*，映射为上面的消息序列；焦点编辑器里
逐键级别的小改动视为人类输入，忽略。

命令（命令面板）：**Rubato: Show Status** · **Rubato: Send Test Cycle to
Device** · **Rubato: Open Config File**。

设置：`rubato.modelLabel`（`cursor-agent`，负载模型名）、
`rubato.settleMs`（`6000`，突发以 Done 收尾的静默毫秒数）、
`rubato.minBurstChars`（`12`，焦点编辑器内单次编辑计入 AI 工作的字符阈值）、
`rubato.maxBurstMs`（`600000`，安全上限）。

<details>
<summary>从源码构建（开发者）</summary>

```bash
git clone https://github.com/lovaxi/Rubato_Plugins.git
cd Rubato_Plugins/cursor
npx @vscode/vsce package        # 生成 rubato-cursor-<version>.vsix
```

</details>

### OpenClaw

在 OpenClaw 对话里粘贴：

```text
Install the Rubato plugin for OpenClaw from https://github.com/lovaxi/Rubato_Plugins/openclaw
```

这就是全部安装步骤。助手会链接插件包、启用、授予所需的会话钩子权限，并
提醒你重启。重启后：

1. 控制台会打印 `SETUP REQUIRED` 指南，并自动生成配置模板。
2. 把设备贴纸上的两个值填进去——username = deviceId（`RUBATO-xxxxxx`），
   password = 对应 token——可以自己编辑文件，或直接告诉助手。

保存即完成——插件在下一条消息自动启用，无需重启。OpenClaw 类型化钩子没有
首个增量事件，因此不发送 `Generating`；设备保持思考呼吸态直到 `Done`。

### Codex

Codex CLI 没有宿主插件 API，Codex 插件改为两个协作进程，而不是单个进程内
钩子：

1. **Watcher（主通道）** —— 跟踪
   `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，把事件流映射为上面的消息
   集（`task_started` → Estimate + Thinking；首个 `agent_message`/工具活动 →
   Generating；`task_complete` → 精简 Done；`turn_aborted` → 只发精简 Done
   不发 Error——中止是用户停止，不是失败）。启动时磁盘上已有的日志会被
   静默快进。
2. **`notify` 钩子（兜底）** —— Codex 在 `agent-turn-complete` 时调用它。
   watcher 存活时它不动作；watcher 挂掉时它自己补发解卡 Done，并唤醒
   watcher。

安装（Windows PowerShell——克隆仓库并完成全部接线）：

```powershell
git clone https://github.com/lovaxi/Rubato_Plugins.git
cd Rubato_Plugins/codex
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装器会生成配置模板（`codex/rubato-mqtt-config.json`——与本机所有 Rubato
宿主插件读的是同一个通用文件；旧名 `dsh-mqtt-config.json` 首次查找时自动
改名迁移）、向 `~/.codex/config.toml` 追加
`notify = ["node", '<仓库路径>\codex\lib\notify.js']`（先备份；已有 notify
钩子则保持不动），并注册 + 启动隐藏的开机登录计划任务 `RubatoCodexWatcher`
运行 watcher。

然后把设备贴纸上的两个值填进去——username = deviceId（`RUBATO-xxxxxx`），
password = 对应 token——保存即完成，插件在下一条记录自动启用，无需重启。

> **⚠️ 未经真实 Codex 实测**：rollout 事件映射仅通过离线冒烟测试验证（写它
> 不需要 Codex 订阅，跑它也没得跑）。如果你实测了，欢迎到
> [Issues](https://github.com/lovaxi/Rubato_Plugins/issues) 反馈：状态漏报、
> 设备卡在呼吸态、模型名不对等。

### Claude Code

计划中。

## 许可证

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
