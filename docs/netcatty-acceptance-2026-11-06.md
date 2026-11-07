# termX × Netcatty 严格验收报告（2026-11-06）

本报告只覆盖「已移植功能」；范围外的能力按下方排除清单不计入。取证方式：CDP 直连 dev WebView2（`--remote-debugging-port=9222`，CSS 视口 1200×800，dpr 1.25）、实机 129（`tianzry@192.168.126.129`）SSH 会话、源码对照 `G:\AiCode\termX\Netcatty`。证据文件在 `G:\AiCode\termX\evidence\`（不入 git）。

## 1. 排除清单（文档已记录不移植 / 外部条件）

- 协议与转发：Mosh、Eternal Terminal、X11 转发。
- 平台能力：AI 侧栏、MCP、插件宿主、Codex App Server、会话快照、FIDO/WebAuthn/Windows Hello/appLock、系统托盘、应用内独立设置窗口、更新包下载安装。
- 侧栏与布局：Browser/Theme/System 侧栏页签、Save layout as default、Change position；内嵌浏览器面板。
- 工具栏与终端独有项：ymodem 收发、openSessionLog、Paste Selection、保存屏幕；标题栏 ⋮ 中未移植的插件菜单。
- 文件与数据：从 SFTP 拖出到桌面、GBK 文件名（后端能力限制）、脚本页 Shell 历史（#207 记录未移植）。
- 外部条件：真实 CA / 管理员权限 / 物理串口对端 / 原生保存对话框（会话日志开始路径）——无法在无人值守环境伪造，仅验证取消路径。

## 2. 汇总

| 类别 | 数量 | 本轮修复 | 说明 |
| --- | --- | --- | --- |
| 缺失功能（排除清单外） | 0 | — | Vault 九页、设置八 tab、四类终端、SFTP、弹窗/菜单均有入口 |
| 功能偏差 | 1 | 0 | 会话日志开始依赖原生保存框（外部条件），取消路径正常复位 |
| UI 偏差 | 1 | 1 | P2：终端右侧栏泄漏到 Vault/SFTP，压缩 Vault 头部并裁切右侧操作 |
| 性能问题 | 0 | — | 20 万行输出无 long task，滚动稳定 7ms/帧 |

## 3. UI 偏差

### P2-1 终端右侧栏泄漏到 Vault / SFTP（本轮修复）

- 现象：终端右侧栏打开（history / sftp / scripts / notes）后切到 Vault 或 SFTP，右侧栏仍占据 420px。Vault 主机页在 1200px 视口下内容区仅 556px，`.vault-header` 内容宽 773px、`.vault-header-actions` 右边界超出 surface 218px，「新建主机 / 终端 / 串口 / Telnet」被裁切且无法点击。
- 根因：[App.tsx](file:///g:/AiCode/termX/termX/src/App.tsx#L752) 的 `{tool && <TerminalSidePanel/>}` 未限定终端 surface；右侧栏属于终端层，不应在 Vault/SFTP 渲染。
- 修复：条件改为 `{terminalActive && tool && <TerminalSidePanel/>}`；`tool` 状态保留，切回终端时侧栏按原视图恢复（按标签记忆不失效）。
- 改前量测：surface `clientWidth 554 / scrollWidth 773`，header actions 右边界 990 vs surface 右边界 772。
- 改后量测：surface `974 / 974`，header `974 / 974`，`documentElement.scrollWidth == clientWidth`，Vault 页无横向溢出；切回终端后 `[data-section="terminal-side-panel"]` 恢复且仍停在 history。
- 证据：`evidence/acc-vault-1-主机.png`（改前）、`evidence/acc-vault-after.png`（改后）、`evidence/audit-vault-pages.mjs` / `audit-vault-overflow.mjs` / `audit-vault-after-shot.mjs` 输出。

### 其他 UI 检查（通过）

- Vault 九页（主机/监控/钥匙串/代理/端口转发/脚本/笔记/已知主机/日志）在 1200px 与 900px 下均 `scrollWidth == clientWidth`，无横向溢出；900px 截图为 `evidence/acc-narrow-vault.png`。
- 设置八 tab（应用/外观/终端/快捷键/SFTP/AI/同步与云/系统）逐页切换，内容区无横向溢出；AI tab `disabled=true` 且文案「未移植」（属排除项）；其余置灰项均带 title 说明（如「未移植」「更新功能未移植」）。
- 终端右键菜单：复制（无选区时禁用）/粘贴/全选/打开 SFTP/水平分屏/垂直分屏/清空缓冲区/关闭终端，无空壳项。证据 `evidence/acc-context-menu.png`。
- 终端工具栏逐项触发：高亮菜单 320×209、撰写栏 780×120、搜索栏 780×35、脚本菜单 192×87、系统监控浮层 264×528（CPU 1.5% / 2 核、内存 21.4%）、侧栏工具 SFTP/脚本/历史/笔记切换正常。
- L 的命令历史侧栏复测：头部 32、范围行 28、行高 36/46、详情 62、`scrollWidth == clientWidth`。

## 4. 功能偏差

- 会话日志「开始记录」走原生保存对话框（`api.pickManualSessionLogPath`）。无人值守下用 `WM_CLOSE` 取消后 `logBusy` 正确复位、按钮恢复可用，未产生错误态或卡死；无法自动化完成「确定」并写入文件，按外部条件记录，不伪造结果。证据：`audit-recording-state.mjs` 前后状态、`audit-toolbar-actions2.mjs`。导入/导出、SFTP 上传下载同样依赖原生文件对话框，归入同一外部条件。
- 已实际触发并通过：
  - 自动补全：在终端输入 `cd /us` 后出现候选浮层，候选 `usr/目录`；`Escape` / `Ctrl+U` 正常收起与清行（`evidence/acc-autocomplete.png`，`audit-auto4.mjs`）。
  - 时间戳开关：`隐藏时间戳 → 显示时间戳 → 隐藏` 三态切换，`localStorage["termx.terminal.showTimestamps.v1"]` 同步 `1→0→1`，gutter 随之消失/恢复（`audit-func-ts-auto.mjs`）。
  - 工具栏：高亮菜单、撰写栏、搜索栏、脚本菜单、系统监控浮层、SFTP/脚本/历史/笔记侧栏切换均实际打开；右键菜单无空壳项。
  - 命令历史侧栏：主机/全局范围、搜索、运行（写入+回车）、粘贴（只写入）、删除、刷新、清空二次确认均可用。
  - SSH 129 会话在全部探针（含 20 万行输出、200k 滚动、反复切页与侧栏切换）后仍保持连接，提示符可继续输入。
- 未发现排除清单外的功能缺失或「入口置灰且无说明」：设置页可见的置灰项均可从 title/文案判断原因（如「未移植」「更新功能未移植」「身份存储尚未移植」「默认面板不可编辑」）；端口转发的批量按钮在无条目时置灰属正常状态。

## 5. 性能问题

| 场景 | 取证 | 结果 |
| --- | --- | --- |
| 页面加载（dev） | `performance.getEntriesByType('navigation')` | DOMContentLoaded/load ≈ 2.39s（Vite dev 未压缩，仅作基线） |
| 基线堆内存 | `performance.memory` | 32MB |
| 20 万行输出（`seq 1 200000`） | rAF 采样 6s + PerformanceObserver(longtask) | 821 帧，avg 7.4ms / p95 7ms / max 63ms，>50ms 仅 3 帧，long task 0 个；堆 32→49MB |
| 输出后滚动 | 滚轮 -600 + rAF 1.2s | 120 帧全部 7ms，无 >50ms 帧，long task 0；堆 47MB |
| 切换/侧栏 | 手测 + DOM 状态 | 切标签、侧栏工具切换均即时，无白屏 |

未发现需要修复的 P1/P2 性能问题；堆增长来自 scrollback 与输出缓冲，滚动后回落，未观察到持续增长。

### 覆盖边界（未实测项，均为环境限制）

- 物理串口：无对端设备，只核对入口与协议选项存在，不伪造收发结果。
- Telnet：本机临时回显服务（127.0.0.1:2324）已实测连接、握手横幅、回显与断线错误浮层；无真实业务 Telnet 服务端，未做认证/协商细节。
- 原生文件对话框「确定」路径：会话日志写入、SFTP 上传/下载、导入/导出；无人值守只能验证取消与复位。
- 本地 PTY 与 SSH 已在实际会话中交互验证；串口/Telnet 的连接弹窗与标签样式在前序轮次（#236/#244）已核对。

## 6. 本轮处理

- 修复：P2-1（右侧栏仅在终端 surface 渲染）。
- 未修复：无（排除清单与外部条件项除外）。
- 回归：改后 Vault 九页、设置八 tab、终端工具栏、侧栏切换逐项复测通过；129 实机会话保持连接，侧栏切回后恢复 history 视图。
- 门禁：`npx tsc --noEmit`、`npm run test:run`、`npm run build` 见本轮 commit 说明。

## 7. 第三轮：设置项逐条（#249）

- **方法**：CDP 9222 实机逐项操作 → 立即读 DOM → 读后端 `settings.center.v1` → 真实连接验证行为。确认设置快照字段是**顶层**（`sidePanelAutoOpen` / `sidePanelAutoOpenPane`），不是 `terminal.*` 嵌套。
- **P2-2 自动打开侧栏只支持 SFTP（已修）**：`maybeAutoOpenSidePanel()` 只处理 `sftp`，选 scripts/history/notes 连接成功不打开。新增 `AUTO_OPEN_SIDE_PANEL_PANES` 映射四视图；SFTP 仍仅 SSH（对齐 Netcatty `sftpAvailable`）；theme/system/ai/browser 未移植，忽略且保留设置项说明。
- **P3-1 开关关闭时页签下拉仍可编辑（已修）**：补 `disabled={!s.sidePanelAutoOpen}`，对齐 Netcatty `SettingsTerminalTab`。
- **P3-2 本地 Shell 组说明与事实不符（已修）**：原文案称 termX 无本地 Shell，实际有 CMD/Git Bash/Telnet 会话；改为「本地 Shell 没有侧栏文件面板，该组禁用」，zh/en 同步。
- **实测结果**：开关关 → pane select `disabled=true`；点击开关后 `disabled=false`、`aria-checked=true`；后端快照写入 `sidePanelAutoOpen=true`、`sidePanelAutoOpenPane="scripts"`；本机 Telnet 回显服务下重连成功，右侧栏自动打开且 `data-active-tool=scripts`；随后关闭开关，快照回到 `false`、下拉恢复禁用。
- **错误边界顺带取证**：2324 端口未监听时，Telnet 连接失败浮层显示「连接 Telnet 127.0.0.1:2324 失败：由于目标计算机积极拒绝，无法连接。 (os error 1006)」，可读且未误触发自动打开。

### 仍待覆盖（下一阶段）

- 设置其余 tab 的开关/下拉/数字框（即时生效、写盘、重启保持、失效说明）逐条。
- 数据类页面：钥匙串、代理、端口转发、监控、同步、脚本、笔记、日志。
- SFTP 深路径：冲突 replace/skip/rename + applyToAll、暂停/恢复/取消、并发上限、递归、符号链接、权限位、异常编码文件名、断线重连队列。
- 多标签/多窗口：工作区恢复、标签记忆、分屏状态重启后正确性。
- 性能补测：万级目录列举与滚动、并发传输 UI、30 分钟以上会话日志/内存曲线。

## 追加批次：SFTP 传输 P1 专项（2026-11-07）

范围：`#228` 进度视图字段 + 行尾动作 + 打开目标目录（UI）；`#229` 断点续传；`#230` 吞吐。三项独立 commit。

### 1. 进度视图字段（底部队列 / 顶栏弹窗）

| 位置 | 元素与字段顺序 | 尺寸/样式 |
| --- | --- | --- |
| 底部队列行 | 状态图标 → 方向图标 → 文件名 → 箭头 → 目标目录 → （右侧）速率 • 已传/总量 • 百分比 • 剩余 | 图标 20px；文件名 12px medium；箭头/目录 11px（目录 muted）；右侧 10px mono 右对齐；条高 6px、左缩进 28px、track secondary/80；暂停条琥珀 |
| 顶栏弹窗行 | 28px 方向图标盒 → 文件名 + `源 → 目标` → 动作区 → 进度条 + 百分比 → 状态行（`已传/总量 · 速率 · ETA`）→ 失败错误行 | 名称 12px；路径 10px muted；条 6px flex-1；百分比 10px mono `w-12` 右对齐；状态/明细 10px；错误 10px destructive |

- 速率与 ETA：3 秒滑动窗口平均 + rAF 合并刷新，数值不抖动；完成后底部队列隐藏速率（对齐 Netcatty `effectiveSpeed > 0`），顶栏保留最后一帧；ETA <1KB/s 或 >48h 隐藏。
- 实测（`evidence/ui-panel-running.png`）：底部队列运行态显示 `45.5 MB/s • 82.0 MB / 100.0 MB • 82% • 剩余 1s`；`ui-center-running.png` 顶栏同字段。

### 2. 行尾动作矩阵与「打开目标目录」

| 状态 | 底部面板 | 顶栏弹窗 |
| --- | --- | --- |
| 进行中 | 暂停 + 取消 | 暂停 + 取消 + 打开目标目录 |
| 已暂停 | 恢复 + 取消 | 恢复 + 取消 + 打开目标目录 |
| 失败 | 重试 + 移除 | 重试 + 移除 + 打开目标目录 |
| 已完成 / 已取消 | 打开目标目录 + 移除 | 打开目标目录 + 移除 |

- 打开目标目录：`title=打开目标目录`，folder-open 图标；下载 → 打开本地落盘目录；上传 → 跳转对应 SFTP 面板到目标目录（按 **SSH 会话 id** 匹配，同一会话多条 SFTP 通道都能认领）。
- 边界：本地目录不存在/被移动 → 红字「无法打开目标目录（目录可能已被移动或删除）」；上传时无匹配面板 → 「目标目录所属的 SFTP 会话未打开，请先打开该会话的 SFTP 面板」；两种情况均不静默失败。
- 实测：上传项点击后左栏 `home / tianzry` → `home / tianzry / ntx-bench`（`ui-reveal-upload-after.png`）；删除落盘目录后点击出现上述报错（`ui-reveal-boundary.png`）。

### 3. 断点续传

- 129 / 100MB / release：写入 31.13%（32,636,928 B）时暂停，远端 `.part` 保留 → 恢复首帧即 31.1MB（未回跳）→ 完成 100%；远端最终大小 104,857,600、SHA256 与本地一致、无残留 `.part`。断言：`evidence/resume-assert.json`；截图 `resume-1-paused.png` / `resume-2-resumed.png` / `resume-3-completed.png`。
- 源变化（大小/mtime）→ `sftp_resume_source_changed` 重新开始；取消/失败清理 `.part`，暂停保留；应用重启后会话离线 → `sftp_resume_session_offline`，UI 明确标注不支持跨重启续传（未做伪续传）。

### 4. 吞吐

| 场景 | 上传 | 下载 |
| --- | --- | --- |
| termX debug（`tauri dev`，本轮前基线） | 9.41MB/s | 2.40MB/s |
| termX debug（流水线改造后） | 13.7MB/s | 7.9MB/s |
| termX release（本次，100MB） | **127.55MB/s（0.784s）** | **58.51MB/s（1.709s）** |
| Netcatty（ssh2-sftp-client 64×32KB） | 155MB/s（0.645s） | 68MB/s（1.46s） |

- 根因：此前「十几秒」的实测来自 **debug 构建**（`opt-level=0`，加解密/协议路径未优化）。同机同文件 release 达 Netcatty 的 82% / 86%，满足「几秒内传完」。
- 代码侧已完成连续流水线（16 句柄 × 64KB、完成即补、无整批栅栏）；release 窗口扫描：1 → 37/17MB/s，4 → 120/60，16（默认）→ 135/63，64 → 133/60；块 32KB/128KB 无增益。故不再调窗口/包大小。
- 证据：`evidence/bench-sftp-baseline.mjs`、`bench-ssh2-params.mjs`、`bench-sftp-sweep.mjs`。

### 5. 门禁

- `npm run test:run` 65 文件 / 795 用例 ✓；`npm run build` ✓；`cargo check --no-default-features` ✓；`cargo build --release` ✓。

### 6. 未完成 / 外部条件

- **Netcatty 实机并排截图未取得**：本机 Netcatty 进程未以 `--remote-debugging-port` 启动（无 CDP），窗口被他窗口遮挡且当前仅有本地 shell、未配置 129 主机；若重启其 UI 进行主机配置会干扰用户正在使用的实例。字段/尺寸对照已以 Netcatty 源码与 DOM 规格逐项核对（见第 1 节表格），实机并排截图留待 Netcatty 可自动化时补。
- 断点续传不支持跨应用重启（已按用户要求改为 UI 明确标注，而非静默假装续传）。

