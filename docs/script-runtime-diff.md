# 脚本 / 自动化能力差异清单（termX vs Netcatty）

> 性质：只读核查结论（2026-11-08）。证据均为当前工作树中的真实文件与行号；行号可能随并行开发漂移，复核时以文件内容为准。
>
> 核查范围：Netcatty 的 `Snippet(kind=script)` 全链路（数据模型、编辑器、运行时、触发、录制、分享）；termX 的 `src/snippets/`、`TerminalPane.tsx` 及相关 Rust 命令。
>
> 一句话结论：Netcatty 的「自动化脚本」是**真正执行 JavaScript** 的运行时（Node `worker_threads` + `vm` 沙箱 + `nct` API 驱动终端）；termX 目前只是**带 `#@` 等待指令的 shell 文本**，没有 JS 运行时。Netcatty **不存在**节点图 / 流程编排器，所谓“编排”就是 JS 原生控制流。

---

## 1. 结论摘要

1. **判断成立**：Netcatty 脚本可写代码、可真正运行、可取屏幕结果、可弹表单、可上报进度。
2. **需要修正的预期**：Netcatty 没有“脚本节点 / 步骤树 / 可视化流程编排”。数据模型里没有 steps/nodes 字段，条件、循环、并行都靠 JavaScript 语法，多主机并行靠运行参数 `sequential | parallel`。
3. **termX 现状**：手动点“运行”只是把脚本正文粘贴进终端并回车；`#@wait-*` 指令在手动运行时不会被解释（`#` 开头被 shell 当注释）。自动触发（onConnect / onOutput）才走 `scriptRunner` 的文本等待子集。
4. **差距本质**：不是 UI 差距，而是**运行时缺失**。补齐的关键是“执行容器 + nct API + 输出缓冲 + 超时 / 停止”，编辑器与面板是配套。

---

## 2. termX 现状能力边界

### 2.1 手动运行（当前行为）

- 入口：脚本卡片“运行” → `SnippetsView.sendSnippet` → `activeHandle.runSnippet` → 终端 `paste + Enter`。
- 证据：[SnippetsView.tsx](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L362-L391)
- 结论：**只发命令**。脚本正文里的 `#@wait-prompt` 等指令会原样进入 shell，只因为以 `#` 开头才“碰巧”不报错；不会产生等待、取结果、分支等行为。
- 停止 / 暂停 / 恢复：向终端发送 `Ctrl-C` / `Ctrl-Z` / `fg`，属于终端级控制，不是脚本运行时控制。
  证据：[SnippetsView.tsx](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L404-L421)

### 2.2 onConnect（自动触发）

- 仅 SSH 会话生效；连接后先等提示符（最多 6 秒，超时继续），再执行 `scriptRunner`。
- 证据：[TerminalPane.tsx](file:///g:/AiCode/termX/termX/src/TerminalPane.tsx#L846-L872)
- 结论：**已支持线性编排**（顺序发送 + 等待），但没有条件、循环、结果分支。

### 2.3 onOutput（输出触发）

- 每 300ms 检查一次，取 `xterm` 缓冲最后 4KB，按 `trigger_pattern` 正则匹配；**同一会话同一脚本只触发一次**；运行中通过 `outputTriggerRunningRef` 抑制。
- 证据：[TerminalPane.tsx](file:///g:/AiCode/termX/termX/src/TerminalPane.tsx#L874-L902)、[snippetsModel.ts](file:///g:/AiCode/termX/termX/src/snippets/snippetsModel.ts#L161-L187)
- 结论：比 Netcatty 的流式扫描（分块 + 重叠 + 可重复触发）简化很多，且窗口只有 4KB。

### 2.4 执行器支持的指令（自动触发路径）

- 普通行：直接写入并按行发送。
- `#@wait-prompt`：等待提示符（`/#$%\s*$/` 一类简单规则）。
- `#@wait-text <text>`：等待文本出现。
- `#@wait-regex <pattern>`：等待正则出现。
- 默认等待 30 秒，超时抛错；没有“重试 / 跳过 / 中止”交互。
- 证据：[scriptRunner.ts](file:///g:/AiCode/termX/termX/src/snippets/scriptRunner.ts#L13-L60)

### 2.5 编辑器

- 普通 `<textarea>`；无行号、无语法高亮、无补全、无括号匹配、无 Tab 缩进；放大编辑弹窗同样是 textarea。
- 没有“语言”选择器；`language` 只作为数据字段。
- 证据：[SnippetsView.tsx](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L1011-L1031)、[SnippetsView.tsx](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L14)

### 2.6 变量

- 支持 `{{name}}` 与 `{{name:默认值}}`，运行前替换。
- **脚本编辑区不显示变量提示**：变量区块只在 `!isScript` 时渲染；脚本仍可手写变量但缺少提示。
- 证据：[snippetsModel.ts](file:///g:/AiCode/termX/termX/src/snippets/snippetsModel.ts#L357-L378)、[SnippetsView.tsx](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L1032-L1051)

### 2.7 录制

- 记录用户输入的命令与间隔，超过 1 秒的间隔生成 `sleep x.x`，最终产出 **shell 文本**（不是 JS）。
- 证据：[scriptRecording.ts](file:///g:/AiCode/termX/termX/src/terminal/scriptRecording.ts#L142-L152)

### 2.8 导入导出

- 接受 v1 / v2 / v3，导出固定写 v3；条目用 `label`（termX 内部字段名 `name`）。
- `language / trigger / triggerPattern / targets` 随数据保留；`targetGroups / order` 等未支持字段**导入时丢弃**。
- 证据：[snippetsTransfer.ts](file:///g:/AiCode/termX/termX/src/snippets/snippetsTransfer.ts#L1-L6)

### 2.9 数据与存储

- 字段已对齐 Netcatty 子集（snake_case）：`kind / language / trigger / trigger_pattern / targets / targets_all_hosts`。
- 存储为 JSON 文件 `snippets.json`，不是 SQLite 表；因此脚本模块升级**不涉及 DB schema 版本**。
- 证据：[client.ts](file:///g:/AiCode/termX/termX/src/backend/client.ts#L567-L595)、[models.rs](file:///g:/AiCode/termX/termX/src-tauri/src/models.rs#L768-L796)、[snippet.rs](file:///g:/AiCode/termX/termX/src-tauri/src/db/snippet.rs#L6-L31)

---

## 3. 20 项差异清单

> 类型说明：**缺失** = Netcatty 有、termX 没有；**简化** = 有同类能力但范围更小；**语义差异** = 名称相同但行为不同。

| # | 能力 | Netcatty 证据 | termX 证据 | 类型 | 难度 | 依赖 |
|---|---|---|---|---|---|---|
| 1 | 用户代码真实执行 | [worker + vm 沙箱](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptExecutionWorker.cjs#L177-L211)；[源码包装](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L70-L90) | [scriptRunner 仅文本](file:///g:/AiCode/termX/termX/src/snippets/scriptRunner.ts#L1-L19)；[language 仅标签](file:///g:/AiCode/termX/termX/src-tauri/src/models.rs#L793-L796) | 缺失 | 高 | Web Worker 沙箱 |
| 2 | 代码编辑器 | [Monaco 组件](file:///g:/AiCode/termX/Netcatty/components/scripts/ScriptCodeEditor.tsx#L1-L17)；[nct 补全](file:///g:/AiCode/termX/Netcatty/infrastructure/scripts/nctMonacoCompletion.ts#L5-L45) | [textarea](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L1011-L1031) | 缺失 | 中 | CodeMirror 6 |
| 3 | `nct.screen.*` 全套 | [API 清单](file:///g:/AiCode/termX/Netcatty/domain/scriptApiReference.ts#L24-L71)；[send/sendLine](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L1054-L1097) | [仅 3 条 #@ 指令](file:///g:/AiCode/termX/termX/src/snippets/scriptRunner.ts#L13-L60) | 简化 | 中 | 输出缓冲 + 等待器 |
| 4 | `screen.getText` | [实现](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L1120-L1136) | [仅内部读缓冲](file:///g:/AiCode/termX/termX/src/TerminalPane.tsx#L803-L813) | 缺失 | 低 | 缓冲 API |
| 5 | `nct.dialog.*`（含表单） | [API 清单](file:///g:/AiCode/termX/Netcatty/domain/scriptApiReference.ts#L24-L71)；[实现](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L1153-L1174) | [无](file:///g:/AiCode/termX/termX/src/snippets/scriptRunner.ts#L1-L19) | 缺失 | 中高 | React 弹窗宿主 |
| 6 | `nct.progress.*` | [API 清单](file:///g:/AiCode/termX/Netcatty/domain/scriptApiReference.ts#L24-L71)；[实现](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L946-L1005) | [无](file:///g:/AiCode/termX/termX/src/snippets/scriptRunner.ts#L1-L19) | 缺失 | 低 | 运行面板 |
| 7 | `nct.log` + 运行日志面板 | [日志弹窗](file:///g:/AiCode/termX/Netcatty/components/scripts/ScriptRunLogDialog.tsx#L37)；[运行列表](file:///g:/AiCode/termX/Netcatty/components/scripts/ScriptRunList.tsx#L34-L58) | [仅触发日志（100 条）](file:///g:/AiCode/termX/termX/src/snippets/scriptTriggerLog.ts#L15-L40) | 简化 | 低 | run store |
| 8 | 脚本级暂停 / 恢复 | [waitIfPaused](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L1241-L1250)；[IPC 暂停/恢复](file:///g:/AiCode/termX/Netcatty/electron/bridges/scriptBridge.cjs#L705-L720) | [Ctrl-Z / fg](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L404-L421) | 简化 | 中 | 引擎暂停点 |
| 9 | 脚本级停止（中止等待/RPC） | [handleScriptStop](file:///g:/AiCode/termX/Netcatty/electron/bridges/scriptBridge.cjs#L681-L700) | [Ctrl-C](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L404-L421) | 简化 | 中 | 中止令牌 |
| 10 | 等待超时“重试/跳过/中止” | [恢复循环](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L825-L944) | [直接抛错](file:///g:/AiCode/termX/termX/src/snippets/scriptRunner.ts#L36-L60) | 缺失 | 低 | 弹窗宿主 |
| 11 | 防同步死循环看门狗 | [心跳看门狗](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L316-L332) | [无 JS 执行](file:///g:/AiCode/termX/termX/src/snippets/scriptRunner.ts#L1-L19) | 缺失 | 中 | 心跳 + terminate |
| 12 | `sendLine` 分两包时序 | [30ms 拆分](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L1068-L1097) | [单包 write](file:///g:/AiCode/termX/termX/src/TerminalPane.tsx#L748-L750) | 缺失 | 低 | write 时序 |
| 13 | 多目标运行（并行/串行） | [run 调度](file:///g:/AiCode/termX/Netcatty/electron/bridges/scriptBridge.cjs#L602-L679) | [仅活动窗格](file:///g:/AiCode/termX/termX/src/snippets/SnippetsView.tsx#L362-L391) | 缺失 | 高 | 多会话建立 |
| 14 | `onOutput` 流式扫描 | [流式匹配 + 可重复](file:///g:/AiCode/termX/Netcatty/application/state/useOutputTriggers.ts#L616-L659) | [4KB + 仅一次](file:///g:/AiCode/termX/termX/src/TerminalPane.tsx#L874-L902) | 简化 | 中 | 输出 tap |
| 15 | 主机级连接脚本队列 | [Host 字段](file:///g:/AiCode/termX/Netcatty/domain/models/connection.ts#L229-L234)；[解析逻辑](file:///g:/AiCode/termX/Netcatty/domain/hostConnectScripts.ts#L92-L171) | [Profile 无对应字段](file:///g:/AiCode/termX/termX/src/backend/client.ts#L567-L595) | 缺失 | 中 | Host 模型扩展 |
| 16 | `targetGroups` 动态组 | [字段](file:///g:/AiCode/termX/Netcatty/domain/models/connection.ts#L387-L402) | [导入丢弃](file:///g:/AiCode/termX/termX/src/snippets/snippetsTransfer.ts#L1-L6) | 缺失 | 中 | 组解析 |
| 17 | 录制生成 JS | [stepsToJavaScript](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptCodegen.cjs#L9-L37)；[录制停止](file:///g:/AiCode/termX/Netcatty/electron/bridges/scriptBridge.cjs#L761-L783) | [生成 shell + sleep](file:///g:/AiCode/termX/termX/src/terminal/scriptRecording.ts#L142-L152) | 简化 | 中 | codegen |
| 18 | `session.startLog / stopLog` | [API 清单](file:///g:/AiCode/termX/Netcatty/domain/scriptApiReference.ts#L24-L71)；[实现](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L1028-L1048) | [DB 索引式会话日志](file:///g:/AiCode/termX/termX/src/backend/client.ts#L736-L753) | 语义差异 | 中 | 日志命令扩展 |
| 19 | 权限模式（Observer 禁写） | [assertWriteAllowed](file:///g:/AiCode/termX/Netcatty/electron/scripts/scriptRuntime.cjs#L797-L800) | [无权限模型](file:///g:/AiCode/termX/termX/src/backend/client.ts#L567-L595) | 缺失 | 中 | 设置项 |
| 20 | 运行历史 / 状态列表 | [runs 广播](file:///g:/AiCode/termX/Netcatty/electron/bridges/scriptBridge.cjs#L836-L845)；[runs store](file:///g:/AiCode/termX/Netcatty/application/state/scriptRunsStore.ts#L9-L41) | [仅触发日志](file:///g:/AiCode/termX/termX/src/snippets/scriptTriggerLog.ts#L15-L40) | 缺失 | 低 | 前端 store |

---

## 4. 按落地阶段归类

### 4.1 阶段 1（MVP）覆盖

| 差异项 | 处理 |
|---|---|
| 1 用户代码真实执行 | 实现（Web Worker + nct 子集） |
| 2 编辑器 | 实现（CodeMirror 6） |
| 3 `screen.send/sendLine/clear/getText/waitForText/waitForRegex/waitForPrompt/waitForAny` | 实现 |
| 4 `screen.getText` | 实现（基于 xterm 文本缓冲，语义与 Netcatty 屏幕快照有差异） |
| 7 `nct.log` + 脚本运行日志面板 | 实现（内存日志，不落库） |
| 9 脚本级停止 | 实现（abort + terminate） |
| 10 等待超时 | 本期仅失败上报；重试/跳过弹窗留到阶段 2 |
| 11 防死循环看门狗 | 实现（心跳 + terminate） |
| 12 `sendLine` 分两包 | 实现（30ms） |

### 4.2 本期不做（仅记录）

- 阶段 2：`nct.dialog.*`、`nct.progress.*`、脚本级暂停/恢复、等待超时“重试/跳过/中止”弹窗、录制生成 JS、`session.startLog/stopLog/disconnect`。
- 阶段 3：多目标并行/串行运行、`onConnect` / `onOutput` 改为执行 JS、`targetGroups`、主机级连接脚本队列、权限模式（Observer/确认/自动）与运行历史持久化。

---

## 5. 复核方法

```bash
# Netcatty：确认脚本运行时存在
rg -n "vm.createContext|createScriptRuntime|SCRIPT_.*TIMEOUT" Netcatty/electron/scripts

# Netcatty：确认没有节点/步骤模型（应无命中）
rg -n "steps|nodes|workflow" Netcatty/domain/snippetScript.ts Netcatty/domain/models/connection.ts

# termX：确认脚本只是文本指令
rg -n "wait-prompt|wait-text|wait-regex|runScriptBlocks" termX/src/snippets

# termX：确认手动运行走 paste + Enter
rg -n "sendSnippet|runSnippet|snippetWritePlan" termX/src/snippets/SnippetsView.tsx
```

---

## 6. 变更记录

| 日期 | 说明 |
|---|---|
| 2026-11-08 | 首次只读核查，输出 20 项差异与 termX 现状边界 |
