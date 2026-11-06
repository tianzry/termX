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

- 会话日志「开始记录」走原生保存对话框（`api.pickManualSessionLogPath`）。无人值守下用 `WM_CLOSE` 取消后 `logBusy` 正确复位、按钮恢复可用，未产生错误态或卡死；无法自动化完成「确定」并写入文件，按外部条件记录，不伪造结果。证据：`audit-recording-state.mjs` 前后状态、`audit-toolbar-actions2.mjs`。
- 其余主链路已走通：SSH 连接与交互、四类终端工具栏、右键菜单、SFTP 侧栏列目录、命令历史侧栏（含搜索/范围/运行/粘贴/删除）、笔记、系统监控、设置项切换。129 会话在验收全程保持连接。

## 5. 性能问题

| 场景 | 取证 | 结果 |
| --- | --- | --- |
| 页面加载（dev） | `performance.getEntriesByType('navigation')` | DOMContentLoaded/load ≈ 2.39s（Vite dev 未压缩，仅作基线） |
| 基线堆内存 | `performance.memory` | 32MB |
| 20 万行输出（`seq 1 200000`） | rAF 采样 6s + PerformanceObserver(longtask) | 821 帧，avg 7.4ms / p95 7ms / max 63ms，>50ms 仅 3 帧，long task 0 个；堆 32→49MB |
| 输出后滚动 | 滚轮 -600 + rAF 1.2s | 120 帧全部 7ms，无 >50ms 帧，long task 0；堆 47MB |
| 切换/侧栏 | 手测 + DOM 状态 | 切标签、侧栏工具切换均即时，无白屏 |

未发现需要修复的 P1/P2 性能问题；堆增长来自 scrollback 与输出缓冲，滚动后回落，未观察到持续增长。

## 6. 本轮处理

- 修复：P2-1（右侧栏仅在终端 surface 渲染）。
- 未修复：无（排除清单与外部条件项除外）。
- 回归：改后 Vault 九页、设置八 tab、终端工具栏、侧栏切换逐项复测通过；129 实机会话保持连接，侧栏切回后恢复 history 视图。
- 门禁：`npx tsc --noEmit`、`npm run test:run`、`npm run build` 见本轮 commit 说明。
