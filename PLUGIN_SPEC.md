# Rubato 插件开发规范

> 本文是 Rubato 插件系列的标准设计文档。**`dsh/` 是唯一权威实现**——任何新插件的移植必须以它为准，语义逐条对齐，不得自行发挥。本文描述其全部设计需求与工程纪律。
>
> 参考代码：`dsh/lib/index.js`（语义）、`dsh/lib/mqtt.js`（发布器）。这两份文件之外没有第二个事实来源。

---

## 1. 系统架构与角色

```
模型调用 ──> Rubato 插件（宿主进程内） ──> EMQX 代理 ──> Rubato 设备（TFT 屏）
```

- **插件**：寄生在智能体宿主进程内，观察每一次流式模型调用，产出状态消息并发布 MQTT；同时把全部消息落盘归档、维护时长预估的校准样本。
- **设备**：只订阅 `rubato/<deviceId>/state` 一个主题，按消息渲染；**Estimate 是纯元数据，永不驱动设备状态机**。
- **职责边界**：插件负责"何时发什么"；设备负责"如何显示"。健康提醒的调度与冷却在设备侧，插件不做任何健康逻辑。

## 2. MQTT 契约（不可变部分）

### 2.1 连接

| 项 | 值 |
|---|---|
| 代理 | EMQX Cloud Serverless，仅 TLS |
| 端口 / 协议 | 8883 / MQTT 3.1.1 |
| **SNI** | `tls.connect` 必须显式传 `servername: host`，否则共享前端无法路由租户（连接被掐断） |
| keepalive | 60s；PING 每 25s（well inside the window） |
| 连接模式 | **单条持久连接**，进程内复用；断线后在下一次 publish 时懒重连 |
| 发布 qos | 1，以收到 **PUBACK** 为发布成功（ACK 超时 8s；CONNECT 超时 10s） |
| 严禁 | 每个 clientId 同时只允许一个发布进程（见 2.2）；**禁止在活体插件运行时做一次性发布测试** |

### 2.2 身份与安全

- **username = deviceId**（设备贴纸上的 `RUBATO-<mac6>`），**password = 对应 token**。代理地址、topic、clientId 均不由用户配置——用户只填 username + password 两个字段，其余全部派生。
- **clientId = `<前缀>-<username>`**，精确使用、不加随机后缀。前缀按智能体登记：

| 智能体 | clientId 前缀 | 状态 |
|---|---|---|
| DeepSeek Harness | `DSH-` | 在用 |
| OpenCode | `OC-` | 在用 |
| Cursor | `CUR-` | 在用 |
| OpenClaw | `Claw-Rubato-`（作用于 mac6：`Claw-Rubato-<mac6>`） | 在用 |
| Claude Code / Codex | 待定，**新前缀必须先登记到本表** | 计划中 |

- 前缀存在的理由：与设备自身的 clientId（= deviceId）以及其他智能体的 clientId 互不相同，**并发运行的多个宿主进程互不踢线**。
- EMQX Serverless 对重复 clientId 返回 CONNACK 2（拒绝接管会话），因此同一 clientId 的两次连接是硬错误，不是"挤掉旧连接"。

### 2.3 消息集

所有消息都带 `model`、`state`、`ts`。topic 一律 `rubato/<username>/state`。

| state | 载荷 | 触发点 |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec }` | 每次模型调用启动时、**任何 chunk 之前**（含中间工具步骤的每次调用）；`estSec` 为预估秒数，保留 1 位小数 |
| `Thinking` | `{ model, state, ts }` | 流启动时（见 2.4） |
| `Generating` | `{ model, state, ts }` | 首个 `text-delta` 或 `tool-call-delta` |
| `Done` | `{ model, state, ts }` | 回合真正结束（见 2.4）；**wire 精简，tokens 只进本地归档** |
| `Error` | `{ model, state, ts, error }` | 调用失败；随后必须立刻补一条 `Done` 解卡设备 |

### 2.4 时序语义（最容易做错的部分，逐条对齐 dsh）

1. **Estimate 先于一切**：在流启动瞬间、第一个 chunk 到达前发布。它来自零 token 的本地预估（§3）。
2. **Thinking 在流启动时发布，不是在首个 reasoning chunk**：大上下文预填充会把首个 delta 拖迟数秒，设备不能落后于真实节奏。
3. **`tool-calls` 结束 = 中间步骤**：循环会执行工具并再次调用模型，该流**不发 Done**（只发该步骤自己的 Estimate/Thinking/Generating）。Done 只属于回合结束。
4. **多步工具循环 = 多轮完整消息**：每个步骤都有自己的 Estimate——这正是设备端需要健康提醒冷却的原因（§8）。
5. **Done 的 wire 契约精简**：`{ model, state, ts }`。token 用量只写入本地归档与状态工具，设备用不上（明确决策：wire 去除 tokens 字段）。
6. **Error 之后必须补 Done**：设备只在收到 done 时退出呼吸态，否则永远卡住。
7. **归档与 wire 分离**：`publish(record, wire = record)`——归档永远收完整对象，MQTT 只发精简对象。Done 是唯一当前需要分离的消息。

## 3. 时长预估器（kNN，零 token）

预估在每次调用启动时完成，不消耗任何 token，随样本积累自动变准。

### 3.1 特征（从请求免费提取）

| 特征 | 含义 | 提取方式 |
|---|---|---|
| `c` | 全部消息总字符数（上下文规模的代理量） | 字符串内容直接取；数组内容拼接 `text` 部分 |
| `l` | 最后一条 user 消息长度 | |
| `f` | 最后一条 user 消息中代码围栏对数（上限 4） | ` ``` ` 数量 / 2 |
| `v` | 任务动词命中 | 中英文正则（实现/重构/调试/修复… implement/refactor/debug/fix/build/migrate/optimize）——**此正则含中文字符，见 §9 编码纪律** |
| `fl` | 文件引用命中 | `@路径`、已知扩展名、盘符 |
| `n` | 消息条数（回合深度） | |
| `e` | reasoningEffort 请求值 | 无则 `''` |

### 3.2 预测

- **距离**（log 尺度，逐项绝对差）：`c` 权重 1.0、`l` 0.3、`n` 0.3、`e` 不匹配 0.4、`f` 0.2、`v` 0.1、`fl` 0.1。
- **kNN**：k = min(5, 样本数)，权重 `1/(1+d)`，加权平均。
- **先验**（零样本时回退）：`4000 + c * 0.018` ms。
- wire 精度：`Math.round(ms / 100) / 10` 秒。

### 3.3 样本存储

- 文件：`thinktime-stats.json`，与 config 同目录。
- 结构：`{ [model]: { samples: [...] } }`；样本字段 `{ c, l, f, v, fl, n, e, ms, est, o, t }`——`ms` 实际耗时、`est` 流启动时的预测值（**档案自带预测 vs 实际对照**）、`o` 输出 token 数、`t` 时间戳。
- 上限 200 条，超出删最旧。
- 旧版 S/M/L 分桶结构检测到即重置（特征不可回填）。
- 懒加载；每次回填后保存。

## 4. 配置与首启体验

- **查找顺序**：宿主进程 cwd 的 `dsh-mqtt-config.json` 优先，其次插件根目录。cwd 优先的设计让同一台机器上多个宿主共享一份配置。
- **热加载**：每条消息发布前重新读取——改完即生效，无需重启。
- **enabled 是派生值**：`username && password` 填了 = 开；文件里显式写 `"enabled": false` 是人工关闭开关。不提供任何 setup 工具，不做交互式配置。
- **模板**：纯 JSON `{"username":"","password":""}`，**模板里不写注释**（JSON 标准不含注释；加载器对 `//` 行的剥离只是容忍，不是邀请）。
- **首启流程**：无配置 → 自动落模板 + console 打印 `SETUP REQUIRED` 指南（打开路径 / username 抄设备贴纸 `RUBATO-xxxxxx` / password 抄配对 token / 保存即自动启用）。
- **console 政策：只保留配置提醒**。逐条消息、发布成败、工具注册等一切运行时信息走归档与状态工具，不上 console。

## 5. 本地归档

- `thinktime-records.jsonl`（与 config 同目录）：每条消息一行 JSON + 每次进程启动一行 `_boot`（含 config 路径、enabled、host、topic、toolRegistered——诊断工具注册失败的唯一现场）。**无论 MQTT 是否启用都落盘**。
- `thinktime-stats.json`：§3.3 校准样本。
- 两文件都在 `.gitignore` 里，永不进仓库。

## 6. 模型工具 `mqmon_status`

- 注册为模型可见工具（宿主 tools 服务），报告：configured、enabled、host、topic、qos、configPath、published/failed 计数、lastPublish、recentRecords。
- **输出必须是无损 JSON**：任何字段都不允许赋 `undefined`（条件性字段用展开省略或置 null）。无损序列化器遇到 undefined 值会直接拒绝整个输出——这是真实踩过的坑。
- 工具注册失败不得杀死插件：失败详情写进 `_boot` 行。
- 宿主若提供 tools 服务，插件必须声明 `inject: ['tools']` 等待其挂载（dsh 的根因修复：不声明则 apply 早于服务挂载，工具永远注册不上）。

## 7. 各智能体的差异面

移植新宿主时，**只有"钩子映射层"允许不同**——即"宿主的什么事件对应 §2.4 的哪个消息"。以下语义必须逐条保持，无例外：

- Estimate 在请求发出前、零 token、含中间步骤；
- Thinking 在流启动（不等首个 delta）；
- Generating 在首个输出片段；
- 中间步骤不发 Done；回合结束才 Done（宿主事件流若在回合中途产生"结束"信号，必须去抖并在下一信号到达时取消——参见 dsh 对 `tool-calls` finish 的处理）；
- Error + 补 Done；
- wire 精简 / 归档完整分离；
- clientId 前缀登记（§2.2）、config 查找顺序、首启 UX、console 政策、归档、工具、预估器全部照抄 dsh。

钩子层之外的一切代码（预估器、身份派生、发布器、模板、归档）直接以 `dsh/lib` 为底本改造成本最低、出错率最低。

## 8. 健康提醒策略（设备侧职责，插件零逻辑）

- 设备收到 `Estimate` 且 `estSec >= 30` 时，在任务运行的等待期显示健康全屏（喝水/休息）。
- **冷却**：两次健康全屏之间 ≥ 30 分钟——既防提醒风暴（历史数据：48% 的调用预估 ≥30s，重负载日会触发 70 次），也防多步工具循环在同一回合内连翻屏。
- **无上下班时间概念**：有 AI 活动本质上就是没在休息。
- 插件对健康逻辑零参与：不判断、不节流、不加字段。契约不变。

## 9. 工程纪律（真实踩坑，逐条遵守）

1. **禁止用 PowerShell 管道写代码文件**（`git show | Set-Content`、`Set-Content -Encoding UTF8`）：会产生 BOM、GBK 乱码、换行坍缩三重损坏——中文动词正则被毁过一次，特征静默失效。
2. 写文件一律用 node `fs` 或字节精确手段（`git checkout <sha> -- path` + 二进制 `Copy-Item`）。
3. 对 lib 的任何落盘操作之后，三验：`node --check` 通过、源码中能匹配到中文动词正则、`import` 后 default 导出为对象。
4. config 文件禁止 BOM（插件用 `readFileSync(utf8)` + `JSON.parse`，BOM 会让 parse 抛错）。
5. 工具输出禁止 undefined 字段（§6）。
6. `.gitignore` 必须排除：`dsh-mqtt-config.json`、`thinktime-records.jsonl`、`thinktime-stats.json`、`.smoke/`、`node_modules/`。**凭据与数据永不进仓库**。

## 10. 测试（冒烟模式）

`tools/dsh-smoke-test.mjs` 是标准范式，新插件照此各写一份：

- 伪造三条流：① 极小上下文 + `tool-calls` 结束（只发 Estimate，无回填）；② 大上下文 + 正常结束（先验预估，Done + 回填真实样本）；③ 同样再来一次（从已存样本得到校准预估，必须小于先验）。
- 自包含 config（写入 `.smoke/`，故意带一行 `//` 注释验证加载容忍），`enabled: false`，**全程不需要真实代理**。
- 断言：消息序列、先验/校准预估数值、Done 精简（无 est/dur/tokens 字段）、样本存储字段完整（`n/e/est` 在，S/M/L 不在）、`mqmon_status` 已注册。

## 11. 命名与目录

| 项 | 规则 |
|---|---|
| 品牌 | Rubato（musical term: stolen time） |
| 仓库 | `Rubato_Plugins`（插件集，每智能体一个目录）；设备固件：`Rubato_Device` |
| 设备身份 | `RUBATO-<mac6>`，即 MQTT username |
| 包名 | `rubato-<harness>`（npm 小写），如 `rubato-dsh`、`rubato-opencode` |
| 导出符号 | `Rubato`（named + default 双导出，覆盖目录加载与 npm 安装两种路径） |
| console 前缀 | `[Rubato]` |
| 目录 | 仓库根每个智能体一个目录：`dsh/`、`opencode/`、…；每目录 = 完整插件包（package.json + lib/） |
| 数据文件名 | `thinktime-records.jsonl` / `thinktime-stats.json`（刻意保留旧名：校准数据连续性） |

## 12. 新插件移植清单

- [ ] 复制 `dsh/` 为底本，改包名为 `rubato-<harness>`
- [ ] 钩子映射层：按 §7 语义对齐（Estimate 先于一切 / Thinking 流启动 / 中间步骤无 Done / Error+Done / 去抖）
- [ ] clientId 前缀在本规范 §2.2 表登记，派生 `<前缀>-<username>`
- [ ] topic 派生 `rubato/<username>/state`；config 查找 cwd 优先
- [ ] 首启 UX：模板 + SETUP 指南 + console 只留配置提醒
- [ ] `mqmon_status` 注册 + 无损 JSON 自检 + `inject`（若宿主有 tools 服务概念）
- [ ] 归档与 stats 落盘路径跟随 config 所在目录
- [ ] 冒烟测试按 §10 范式落地并跑通（exit 0）
- [ ] 根 README 双语表格加行 + 安装小节（一行粘贴式提示语，指向本仓库 `<harness>/` 子目录）
- [ ] `.gitignore` 核对；确认仓库无凭据、无数据、无本机绝对路径

---

*权威实现：`dsh/lib/index.js`、`dsh/lib/mqtt.js`。本文与其不一致时，以代码为准并回改本文。*
