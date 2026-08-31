# Rubato

[English](README.md) | 简体中文

Rubato 让 AI 的工作状态在桌面实体设备上可见。本仓库为每个受支持的编码
智能体各提供一个 Rubato 插件，一个插件一个目录。设备固件在
[lovaxi/Rubato_Device](https://github.com/lovaxi/Rubato_Device)。

![Rubato 设备](assets/product.jpg)

![Rubato 设备效果](assets/product.gif)

```
模型调用 ──> Rubato 插件 ──> EMQX 服务器 ──> Rubato 设备（TFT 屏幕）
```

| 目录 | 智能体 | 状态 |
|---|---|---|
| [dsh/](dsh/) | DeepSeek Harness | 可用 |
| [openclaw/](openclaw/) | OpenClaw | 可用 |
| codex/ | Codex | 计划中 |
| claude-code/ | Claude Code | 计划中 |
| [cursor/](cursor/) | Cursor | 可用 |
| [opencode/](opencode/) | OpenCode | 可用 |

## MQTT 契约

所有插件发布相同的消息到 `rubato/<deviceId>/state`——每台设备一个主题。
认证与设备固件一致：username = deviceId（`RUBATO-xxxxxx`），password = 对应
token。MQTT 3.1.1 over TLS（8883），单条持久连接。

| 消息 | 载荷 | 说明 |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec }` | 预估时长（秒） |
| `Thinking` | `{ model, state, ts }` | 首个思考片段 |
| `Generating` | `{ model, state, ts }` | 首个回答/工具片段 |
| `Done` | `{ model, state, ts }` | 中间工具调用步骤不发送 Done |

设备屏幕显示模型名和随阶段变色的呼吸光环——思考时奶油色慢呼吸，生成时
冰蓝色快呼吸，结束时绿色收尾。当预估时长较长且处于工作时间，设备会全屏
显示健康提醒（喝水 / 休息时间到了）。

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

**最简安装 —— 两步：**

1. 下载扩展：[`cursor/rubato-cursor-1.0.0.vsix`](https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix)
2. 在 Cursor 中：扩展面板 → `⋯` 菜单 → **从 VSIX 安装…** → 选择下载的文件 →
   重载窗口。（把 `.vsix` 直接拖进扩展面板也可以。）

喜欢终端？一行搞定（`cursor` 命令随 Cursor 自带）：

```powershell
# Windows (PowerShell)
curl.exe -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix; cursor --install-extension rubato-cursor.vsix
```

```bash
# macOS / Linux
curl -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.0.0.vsix && cursor --install-extension rubato-cursor.vsix
```

然后配置一次：

1. 控制台会打印 `SETUP REQUIRED` 指南，并自动在插件旁生成配置模板
   （`cursor/dsh-mqtt-config.json` —— 与本机其他 Rubato 宿主插件读的是
   同一个文件）。命令面板 → **Rubato: Open Config File** 可直接打开。
2. 把设备贴纸上的两个值填进去——username = deviceId（`RUBATO-xxxxxx`），
   password = 对应 token——可以自己编辑文件，或直接告诉助手。

保存即完成——插件在下一次编辑突发时自动启用，无需重启。命令面板里的
**Rubato: Send Test Cycle to Device** 可做设备链路检查。

**工作原理** —— Cursor 没有公开其 AI 对话的 API，插件观察 AI 对工作区确实
产生的改动：快速、非逐键的文档编辑（Tab 补全、Cmd/Ctrl+K、对话 Apply、
agent 多文件 diff）组成一次*编辑突发*，映射为上面的消息序列；焦点编辑器里
逐键级别的小改动视为人类输入，忽略。

命令（命令面板）：**Rubato: Show Status** · **Rubato: Send Test Cycle to
Device** · **Rubato: Open Config File**。

设置：`rubato.modelLabel`（`cursor-agent`，负载模型名 + 估算历史键）、
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

### Codex / Claude Code

计划中。

## 许可证

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
