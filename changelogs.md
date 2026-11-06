# termX 开发日志（changelogs）

> 约定：每次开发修改后，先把「修改点 + 踩坑经验」记录到这里，再由用户确认后才 push 到 termX 仓库。

---

## 2026-11-06 — #233 侧栏「命令历史」点击后整栏关闭

- **问题**：终端右侧栏已打开时，点击页签「命令历史」，整个侧栏直接消失，需要再点工具栏图标重开。
- **根因**：`src/App.tsx` `changeSidePanelTool` 每次都新建 `notesOpenTabs` 对象（即使值没变），触发 `[activeTabId, notesOpenTabs]` 的同步 effect；该 effect 白名单仅 `sftp` / `scripts`，当前工具为 `history` 时被当作「非持久工具页」直接 `setTool(null)` 关闭。
- **实现**：`setNotesOpenTabs` 改为「值未变复用 prev」，消除无意义对象抖动；同步 effect 白名单补 `history`，工具页常驻（对齐 Netcatty：页签切换只在同一侧栏内换视图），仅「笔记」保留按标签记忆。
- **验证**：129 实机侧栏笔记 → 点击「历史」后侧栏保持打开、内容切到历史列表（截图 `evidence/af-F-history-panel.png`）。

## 2026-11-06 — #232 SFTP 工具栏与侧栏页签图标对齐 Netcatty（lucide 同套图标）

- **Netcatty 取证**（`components/sftp/SftpPaneToolbar.tsx`、`TerminalSidePanel.tsx`）：工具栏依次使用 `Bookmark`（已收藏实心黄）、`SquareTerminal`（跳到终端目录）、`Terminal`（定位路径到终端）、`ClipboardCopy`（复制路径）、`ListTree/List`（视图切换）、`Rows3`（行密度）、`Search`（过滤）、`FolderPlus`（新建目录）、`FilePlus`（新建文件）、`Eye/EyeOff`（隐藏文件）、`RefreshCw`（刷新）、`MoreVertical`（更多）；侧栏页签为 `FolderTree` / `Play` / `History` / `NotebookText`。
- **实现**：
  - `src/sftp/SftpPaneView.tsx` 全页与侧栏共用工具栏图标全部换成上述 lucide 组件（14px），删除旧的字符/自绘 Icon 名称；
  - `src/terminal/TerminalSidePanel.tsx` 页签 `TOOL_META` 改存 lucide 组件（15px 页签、13px 分屏标题、12px 分屏 pane 标题），移除 `Icon` 字符串映射。
- **验证**：129 实机侧栏页签与 SFTP 工具栏逐个目视核对（文件夹树/播放/历史/笔记 + 收藏/终端目录/定位/复制/树/密度/搜索/新建/隐藏/刷新/更多）；`npm run build` 通过；截图 `evidence/af-E-sidepanel-icons.png`。

## 2026-11-06 — #231 补齐「定位路径到终端」（SFTP → 活动 SSH 终端）

- **Netcatty 取证**：`handleLocatePathInTerminal` 取当前 SFTP 路径 → `resolveInteractiveTerminalCdIntent`，仅接受绝对路径 / `~` / `~/...`，含控制字符拒绝，命令形如 `cd -- '/var/log'`（`~/x` 展开为 `cd -- ~/'x'`）；非 SSH 协议（本地 / 串口 / Telnet）不显示该入口。
- **实现**：
  - `src/sftp/sftpModel.ts` 新增 `resolveSftpLocateCdCommand` / `quoteShellPath` / `pathHasInteractiveControlBytes`（`cd --` 语义、单引号转义、拒绝控制字节）；
  - `src/sftp/SftpPaneView.tsx` 工具栏在「跳到终端目录」后新增「定位路径到终端」按钮（lucide `Terminal`，不支持路径时禁用并给 title）；
  - `src/App.tsx` 新增 `locatePathInTerminal`：命令解析失败 / 终端未就绪时写状态栏提示，否则 `activeHandle.sendText(command + "\r")`；`onLocatePathInTerminal` 仅在 `activeTab.connector.kind === "ssh"` 时下发（同时把「跳到终端目录」统一到同一实现）。
- **验证**：129 实机 SFTP 侧栏点击「定位路径到终端」→ 终端真实执行 `cd -- '/home/tianzry'` 并落到目标目录（截图 `evidence/af-D-locate-path.png`）；`src/sftp/sftpModel.test.ts` 定位命令 3 组用例通过。

## 2026-11-06 — #230 SFTP 收藏（书签）按 Netcatty 复刻：选中态 / 弹层 / 管理 / 持久化

- **Netcatty 取证**：
  - 数据面 `application/state/sftp/{local,global}SftpBookmarks.ts` + `bookmarkHelpers.ts`：`SftpBookmark { id, path, label, global? }`；本机收藏落 `netcatty_sftp_local_bookmarks_v1`、全局收藏落 `netcatty_sftp_global_bookmarks_v1`（均为 localStorage），全局列表在前、本机在后，跨分组显示分隔线；
  - 视窗 `components/sftp/SftpPaneToolbar.tsx` `SftpBookmarkPopoverBody`：宽 320（w-80）；头部「收藏路径」+ 有收藏时的「管理/完成」；动作行「收藏此路径 / 取消收藏」+（当前路径未全局收藏时）「+全局」；列表项显示 label + 等宽路径，全局项带 Globe 图标，非管理态悬停出现删除；
  - 按钮态：当前路径已收藏 → `text-yellow-500` + Bookmark 实心；有收藏但当前路径未收藏 → `text-primary`；无收藏且当前路径未收藏 → 点按钮直接加入本机收藏（不开弹层），否则开合弹层；
  - 管理态：每行 Grip 拖拽（仅同 scope 可换位）、ArrowUp/Down（跳过另一 scope）、Pencil 行内改名（Enter 提交 / Esc 取消）、Trash 常显；删除前出确认弹窗；
  - `toggleBookmark`：当前路径仅存在于全局 → 删除全局；否则切换本机收藏；「取消收藏」选第一条非全局同名项，没有则取全局项。
- **termX 实现**：
  - `src/sftp/sftpModel.ts` 新增 `SftpBookmark` 与 `parseSftpBookmarks`（兼容旧版纯路径数组自动迁移）、`getSftpBookmarkLabel`、`createSftpBookmark`（`bm-` / `gbm-` 前缀）、`toggleLocalSftpBookmark`、`hasSftpBookmarkPath`、`shouldToggleSftpBookmarkFromButton`、`getSftpBookmarkMoveTargets` / `canReorderSftpBookmark` / `moveSftpBookmark` / `renameSftpBookmark`；
  - 存储键 `termx.sftp.localBookmarks.v1` / `termx.sftp.globalBookmarks.v1`，首次读取时从旧键 `termx.sftp.bookmarks.v1` 迁移；
  - `src/sftp/SftpPaneDialogs.tsx` 新增 `SftpBookmarkPopover`（结构、分组线、管理态、拖拽/上移下移/改名/删除、视口夹取、Esc/点外关闭）与 `SftpBookmarkDeleteDialog`（Esc / 遮罩 / 取消关闭）；
  - `src/sftp/SftpPaneView.tsx` 侧栏按钮换为 lucide `Bookmark`（已收藏实心黄色，有收藏主色），接入两套存储与上述管理逻辑。
- **验证**：129 实机创建本机 + 全局收藏、按钮态黄/主色切换、列表跳转、改名、上下移动、拖拽、删除确认与刷新后持久化；本机与全局键写入正确；与 Netcatty 同尺寸并排截图（`evidence/af-bookmark-*.png`）。回归 `src/sftp/sftpModel.test.ts` 书签 8 组用例通过。

## 2026-11-06 — #229 SFTP 工具栏「更多」菜单贴边被裁切

- **问题**：截图 `attachments/362c25ea-…/image.png` 中，侧栏 SFTP 工具栏最右侧「更多」弹出的菜单只露出左半截（「在…/复…/刷…」），右半截被窗口边缘裁掉。
- **定位**：`src/sftp/SftpPaneDialogs.tsx` `SftpContextMenu` 以点击点 `x/y` 直接 `position: fixed` 定位，没有任何视口夹取；菜单宽 160+，点击靠近右缘时必然溢出窗口。Netcatty 对应弹层走 Radix `PopoverContent`（`avoidCollisions` + `collisionPadding=8`，空间不足自动翻转到左侧/上方）。
- **实现**：`SftpContextMenu` 改用 `useLayoutEffect` 量取实际 `rect` 后夹取落点——右侧放不下翻到锚点左侧、仍超出则贴右；下方放不下向上翻、仍超出贴底。CSS `.nc-sftp-ctx` 增加 `max-height: calc(100vh - 16px)` + `overflow-y: auto`，超高菜单在菜单内滚动。行右键菜单与「更多」菜单共用该组件，一并修复。
- **验证**：129 实机侧栏最右「更多」完整显示三项（不再截断），并与 Netcatty 同尺寸并排截图；行右键在窗口右下角同样完整。

## 2026-11-06 — #228 SFTP 重命名为空名/原名视为取消（全页 + 侧栏）

- **问题**：重命名对话框保留原名直接确认时，前端仍发 `sftp_rename(old, new)`；old == new 时 OpenSSH 返回 Failure，界面弹出「SFTP 操作失败 (rename)：Failure: Failure」。
- **Netcatty 取证**（`components/sftp/hooks/useSftpPaneDialogs.ts`）：确认按钮在 trim 后为空时禁用；本次按用户要求把「与原名相同」也视为取消。
- **实现** `src/sftp/SftpPaneView.tsx` `runRename`：先 `trim`，当 `!trimmed || trimmed === row.name` 时清错误、关闭对话框并直接 `return`，不发请求；真正改名统一使用 trim 后的名称。全页与侧栏共用同一 `SftpPaneView`，一处修复覆盖两个入口。
- **回归** `src/sftp/SftpPaneView.test.tsx`：新增「重命名名称未变时视为取消，不发请求、不报错」用例（断言 `localRename` 未被调用且对话框关闭）。
- **验证**：`npx vitest run src/sftp/SftpPaneView.test.tsx` 通过；129 实机在侧栏与全页分别保留原名确认，均静默关闭、无错误提示（截图见 `evidence/af-*.png`）。

## 2026-11-06 — #227 终端侧栏 SFTP 面板照抄 Netcatty（红圈 5 项排除 / 复用 SSH 会话通道）

- **对照图逐项取证（红圈项不移植）**：对照图 `attachments/5b27d2db-…/image.png` 红圈共 **5 项**，均不移植：
  1. **Browser 页签**（globe）：termX 无内嵌浏览器面板（Netcatty 的 browser 依赖 Electron webview / 内嵌页面，Tauri WebView2 无等价原语）；
  2. **Theme 页签**（palette）：termX 主题/字体统一在设置中心「外观」，侧栏再放入口会出现第二份主题状态源；
  3. **System 页签**（activity 波形）：termX 系统监控是独立 Vault 监控页（多主机、多面板），单会话侧栏承载语义不符；
  4. **Save layout as default**（floppy）：termX 无「工作区默认布局」概念，侧栏宽度单独持久化，没有可保存的布局快照；
  5. **Change position**（dock）：termX 侧栏固定右侧（为终端保留最小宽度），不提供左右停靠切换。
  未红圈的 **sftp / scripts / history / notes 四个页签** 与工具条、右侧放大 / 上下分屏 / 左右分屏 / 关闭全部复刻。
- **Netcatty 源码取证（逐项记录，不凭记忆）**：
  - 外壳 `components/terminalLayer/TerminalLayerSidePanelSection.tsx`：tab 顺序 `sftp → browser → scripts → history → theme → system → notes → ai`；右侧动作 maximize / split(row) / split(column) / save / dock / close。
  - SFTP 页 `components/SftpSidePanel.tsx`：**复用当前已连接的 SSH 会话**（`resolveBrowseSourceSessionId` 仅当 `activeSessionId` 对应会话 `status === "connected"` 时复用，否则才回落到传输源/专用连接），渲染与全页同一个 `components/sftp/SftpPaneView`。
  - 运行实例（CDP 9336）量测：面板 CSS rect `{x:0,y:72,w:419,h:594}`；工具条 36px / padding `4px 6px` / gap 4；工具按钮 25×28 / radius 8 / active `primary 24%`；面包屑 28 / 动作行 28 / 列头 33 / 行 44（padding 8px 16px）/ 状态栏 36；5 列 `minmax(140px,50fr) minmax(0px,24fr) minmax(52px,7fr) minmax(64px,9fr) minmax(56px,10fr)`、gap 0；行图标容器 28×28 radius 8 `primary/10`；目录尺寸 `--`；OWNER / KIND 右对齐、未知 `--`。以上数值与运行时抓取一并写入 `evidence/sftp-panel/assert-sidepanel.json`。
- **实现**：
  - `src/domain/terminalSidePanel.ts`（新，纯函数）：`SIDE_PANEL_TOOLS = ["sftp","scripts","history","notes"]`（注释写明 3 个红圈页签的排除理由）；默认宽 420 / 最小 280 / 最大 1200 / 终端保留 320；`clampSidePanelWidth`、`getSidePanelMaxWidth`、`resolveSidePanelToolTabs`（宽度不足时前 N 个内联、其余进「更多」）、`parseStoredSidePanelWidth`；存储键 `termx.terminalSidePanel.width.v1`；新增 5 例单测。
  - `src/terminal/TerminalSidePanel.tsx`（新，外壳）：36px 工具条 + 溢出「更多」+ 右侧放大 / 上下分屏 / 左右分屏 / 关闭；左缘 6px 热区拖拽。宽度拆成「期望宽度 + 视口宽度」两段：窗口临时变窄只夹取显示宽度，变宽后自动还原期望值（实测 700→1200 回到 420）。放大 = 取 `getSidePanelMaxWidth`；分屏克隆焦点 pane（row / column），单 pane 时关闭 = 关侧栏；`data-section="terminal-side-panel"` / `terminal-side-panel-tabs` / `terminal-side-panel-pane`。
  - `src/sftp/SftpSidePane.tsx`（新）：`sftpConnectSession(sshSessionId)` 复用该 SSH 连接上的 SFTP 子系统（**不新建 TCP、不二次认证**）；起始目录优先终端 OSC 7 绝对路径（可列出才用）否则 `sftpHome`；attempt 代次守卫丢弃过期异步结果；会话切换/卸载主动 `sftpClose`；跟随开关 `sftpFollowTerminalCwd` 时把终端 cwd 作为 `externalPath` 下发（同路径不重复导航）。
  - `src/sftp/SftpPaneView.tsx`：新增 `variant="side"`，与全页共享全部行为（列表 / 排序 / 右键 / 上传下载 / 编辑 / 冲突 / 队列），只改呈现：根 class 改 `nc-sftp-sidepanel`（避免与全页 `.nc-sftp-side` 冲突）；侧栏工具行顺序 bookmark → 跳到终端目录 → 复制路径 → 视图 → 密度 → 过滤 → 新建文件夹 → 新建文件 → 显示隐藏 → 刷新 → 更多；「..」行 type 为空、owner `--`；目录尺寸显示 `--`；owner 取 `row.user ?? row.group ?? "--"`（OWNER 列右对齐）。
  - 后端 `src-tauri/src/ssh/sftp.rs`：`RemoteEntry` 增 `user` / `group`（russh `FileAttributes`），空值 `skip_serializing_if`；`src/backend/client.ts` 同步类型。多数 OpenSSH 不返回该属性 → UI 显示 `--`（不伪造）。
  - `src/terminal/ScriptsSidePanel.tsx` 导出侧栏形态 `ScriptsSidePane`；History 页复用 `CommandHistoryPanel`（运行 / 粘贴写回活动终端）；Notes 页复用 `NotesPanel`。
  - `src/TerminalPane.tsx`：`PaneHandle` 增 `sendText(text)`（`transport.write`），供历史运行与「在终端打开路径」（`cd "<path>"`）。
  - `src/App.tsx`：`toggleTool` / `changeSidePanelTool` / `closeTool` + 渲染 `TerminalSidePanel`（`activeSshSid` / `activeCwd` / `activeHandle`）；SFTP 未连接时提示「SFTP 需要已连接的 SSH 会话」。
  - `src/styles.css`：`.nc-side-panel*`（36px 条 / 28×28 radius 8 / active primary 24% / 溢出菜单 / 分屏分隔线）+ `.nc-sftp-sidepanel*`（5 列 fr / gap 0 / 列头 33 / 行 44（dense 30）/ 状态栏 36 / 行图标 28×28 primary-10 / owner·KIND 右对齐 / KIND capitalize）。
- **129 实机验证**（`tianzry@192.168.126.129`，debug + CDP 9222）：
  - 终端右键「打开 SFTP」→ 面板 420px、列出 14 行、起始 `/home/tianzry`（`evidence/termx-sidepanel-129-sftp.png`）；
  - 下钻 `Documents` 4 行（`termx-sidepanel-drill.png`），面包屑返回上一级恢复 14 行；
  - 双击 `termx-sftp-proof-*.txt` 打开编辑器，1284 字符 UTF-8 中文正常（`termx-sidepanel-file-open.png`）；
  - 下载：UI 项走**原生保存对话框**（CDP 无法捕获），改为从侧栏 `SftpPaneView` 的 connection 取出**同一个 `sftp_id`** 执行 `sftp_transfer_enqueue(direction=download)`，落盘 1300 B 且内容匹配（`evidence/download-check-termx.txt`）—— 传输链路真实，仅原生对话框交互未自动化。
  - 窄窗：1200 / 900 / 760 → 面板 420、700 → 380，`overflowX=false`；上下分屏 2 pane 无溢出、关闭回 1；700→1200 宽度自动回 420。
  - 并排对照 `evidence/sftp-panel/sbs-sidepanel.png`（同尺寸裁切，左 Netcatty / 右 termX）；量测与断言汇总 `evidence/sftp-panel/assert-sidepanel.json`。
- **已知差异（如实记录）**：列名中文（本地化）；滚动条占位导致列位相对 Netcatty（overlay 滚动条）偏移约 10–30px；面包屑右侧刷新按钮为 termX 全页既有；OWNER 依赖服务端 `FileAttributes`，多数返回空 → `--`；Netcatty 动作行疑似多一枚刷新图标，未复刻（避免与既有刷新重复）。
- **踩坑**：① 宽度状态初版混用显示宽度，窗口变窄后持久化会把期望值压小 → 拆成 `desiredWidth` + `viewportWidth`；② CSS 初版 `2fr/1fr + gap 8` 导致「修改时间」列折行、类型与 owner 黏连 → 改 Netcatty 精确 5 列 fr + gap 0；③ `invoke` 包装拦截记录为空（Tauri 内部走 WebView2 私有通道）→ 改从 React fiber 的 `memoizedProps.connection.sftpId` 取通道 id 完成真实下载验证；④ HMR 后应用回到 Vault 并弹恢复提示，probe 找不到 SSH xterm → 先「忽略并清空」再点 129 主机卡；⑤ 截图裁切未乘 DPR 1.25 导致面板错位；⑥ `ScriptsSidePanel` 实际导出名是 `ScriptsSidePane`，import 需对齐；App.tsx CRLF 混入导致多行 Edit 匹配失败，改单行 Edit。
- **门禁**：`npm run test:run` 777 通过（71 文件）、`npm run build` 通过、`cargo check` 通过、`cargo test --lib` 960 通过。

## 2026-11-06 — #226 文档收口（README / AGENTS / rename 实际落地 / todo 完成度）

- **新增 `README.md`**（仓库原先没有）：项目定位、环境要求、`npm run tauri dev` / `npm run dev` 运行方式、`npm run tauri -- build` 产出 NSIS+MSI 路径、数据目录 `~/.termX` 与旧 `~/.rssh` 迁移策略、卸载保留用户数据、门禁命令与当前基线、已知边界（AI 未移植/更新置灰/MSI 需管理员/人工确认项）。
- **AGENTS.md 同步现状**：项目定位补改名完成状态；R5 错误前缀改 `__termx_err__`（前端双前缀兼容）；R7 `SCHEMA_VERSION` 32 → 50；构建命令补 `termx-cli` / `termx-server` / debug 打包门禁；「测试现状」补 2026-11-06 门禁基线（769/70、960、build/server/debug）与 plugin exec 偶发超时说明；P1 坑位改为“仅兼容性旧字面量保留”。
- **`docs/rename-rssh-termx.md` 新增 §7「实际落地」**：标识/构建/安装包实际结果、数据目录迁移规则与实测（migrated/rename/23 表/334 行/旧目录已清理）、keychain/master key/env/错误前缀/远端备份等兼容回退、与盘点方案的偏差（提交合并、MSI per-machine 权限阻塞）、验证结论。
- **todo.md**：已完成表补「收尾文档收口」行；最终回归与安装包验证行保持 ✅。
- **仍需人工确认项**：真实 CA 证书握手、Windows ssh-agent 转发、真实串口设备回环、原生文件对话框、MSI 管理员安装/卸载与升级路径。
- **门禁**：`npm run test:run` 769 通过（70 文件）、`npm run build` 通过、`cargo test --lib` 960 通过（首跑 1 例 plugin exec 超时 flake，单跑与全量重跑均通过）、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #225 安装包验证（NSIS 全链路 + MSI 构建/权限阻塞）

- **产物**：release `npm run tauri -- build` 同时产出 `nsis/termX_0.0.1_x64-setup.exe`（12,025,955 B）与 `msi/termX_0.0.1_x64_en-US.msi`（17,338,368 B），NSIS 与 WiX 编译均无错误。
- **NSIS（per-user）**：`/S` 安装 exit 0，落 `%LOCALAPPDATA%\termX`（`termx.exe` 42,654,720 B、`uninstall.exe`、`bin/`），自动创建开始菜单 `termX.lnk` 与桌面 `termX.lnk`，HKCU 卸载项 termX 0.0.1；`/S` 卸载 exit 0，快捷方式与注册表项均移除。卸载残留 `termx.exe.WebView2`（165 文件 / 10,496,963 B，WebView2 用户数据目录），记录后手工清理。`~/.termX` 保留（策略：用户数据不随卸载删除）。
- **迁移（隔离副本，未动真实数据）**：真实 `~/.termX` 原子 hold，用副本 `~/.rssh/rssh.db` 测首启迁移 → report `status=migrated`、mode `rename`、tables 23/23、rows 334/334、`old_dir_removed=true`；设置-系统展示迁移文案；测后恢复真实目录，数据完整。
- **MSI（per-machine）**：构建通过；`msiexec /i … /qn` exit 1603（Error 1925 权限不足），per-user 覆盖 `ALLUSERS=2 MSIINSTALLPERUSER=1` 仍 1603（Error 1406 写 HKLM `Software\Classes\ssh`）。当前会话非管理员且不做自动 UAC 提权 → **MSI 安装/卸载未实跑**；`msiexec /a` 解包 exit 0，payload 与 NSIS 一致（`termx.exe` / `html2md.dll` / `bin/`），静态核对 Shortcut / Registry / Property 表（ProductCode `{7099B5A9-A13C-4635-8519-67B893692239}`）。
- **文档**：新增 `docs/installer-verification.md`（产物、NSIS 全链路、迁移、残留、MSI 阻塞原因与未验证项）。
- **门禁**：`npm run test:run` 769 通过（70 文件）、`npm run build` 通过、`cargo test --lib` 960 通过、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #224 收尾全应用最终回归（浅/深双主题 + 四类终端 + Netcatty 同尺寸对照）

- **范围**：改名后的 `termx.exe` 实跑（debug 内嵌 dist，CDP 9222），浅色/深色各走 Vault 9 导航页 + SFTP 根面 + 设置 8 tab + SSH(129)/本地 shell/Telnet/串口四类终端，共 44 张截图；断言汇总 `evidence/final-regression.json`。
- **页面结果**：主机/监控/钥匙串/代理/端口转发/脚本/笔记/已知主机/日志、SFTP 空态、设置 8 tab 全部渲染正常；AI tab `disabled=true` 点击不切换（既有有意差异）；串口 `serial_list_ports` 枚举 COM1、`serial_open` 成功、tab 绿点，但无对端设备故无回显（不伪造）。
- **串口踩坑**：上一实例未释放 COM1 句柄时 `serial_open` 报「拒绝访问」；重启 `termx.exe` 后恢复。自动化双击连接时第二下会落到刚挂载的 xterm 造成选区假象，改为「单击连接命中则不再双击」，并记录 `selectionBands=0`。
- **Netcatty 对照（同尺寸 PrintWindow 裁切 + compose-sbs）**：Vault 主机、SFTP、设置 8 tab 并排见 `evidence/pair/*-sbs.png`；设置 tab 真实点击断言 `pair/settings-pairs.json`。一致项：布局/控件/空态/主题三段/字号/快捷键；有意差异：AI 未移植、更新下载安装置灰、同步入口在 Vault「同步」页（已实测为真实页面）、中文界面与「传输」等文案。**P1 = 0**。
- **文档**：新增 `docs/final-regression.md`（覆盖清单、对照表、P1=0、仍未人工验证项）。
- **门禁**：`npm run test:run` 769 通过（70 文件）、`npm run build` 通过、`cargo test --lib` 960 通过、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #223 P3 收尾（More 菜单录制文案单一来源 + OSC 7 对话框 Esc + 假入口审计）

- **#216 遗留 P3 闭环**：
  1. More 菜单「开始录制 / 停止录制」文案从 JSX 内联迁移到 `terminalActionText.ts` 的 `terminalRecordingText(active)`（label + title 一并返回），删除已无引用的 `TERMINAL_MORE_TEXT.recording`；新增 `terminalActionText.test.ts` 2 例（开始/停止两态）。
  2. OSC 7 配置对话框补 Esc 关闭：`osc7DialogOpen` 期间在 window capture 阶段监听 `keydown`，命中 Escape 时 `stopPropagation` 并关闭，与 `SettingsDialog` / `SerialConnectModal` 等既有模态一致。
- **实机验证（129，debug 内嵌 dist + CDP 9222）**：
  - More 菜单 5 项：命令历史 / 配置目录追踪（已启用：`/home/tianzry`）/ 终端设置 / 开始录制 / 终端编码（当前 UTF-8）；录制项 `text=开始录制`、`title=开始录制脚本`（来自 `terminalActionText`），截图 `evidence/p3-more-recording-source.png`。
  - OSC 7 对话框打开后可见标题、说明、目标文件（`~/.bashrc` / zshrc / fish）、将执行命令、取消/执行配置；按 Esc 后对话框与 `modal-mask` 均消失、终端保持 connected；再按一次 Esc 无副作用（`p3-osc7-dialog-open.png` / `p3-osc7-after-esc.png`，断言 `evidence/p3-leftovers-verify.json`）。
- **假入口审计（`evidence/p3-placeholder-audit.json`）**：设置 8 个 tab 中仅「AI」为 `disabled=true`，点击不激活（activeTab 仍为「应用」）；全局文本扫描「即将推出 / 敬请期待 / 暂不可用 / coming soon / TODO / 占位」命中 0。P2 #27/#28/#29/#30/#38 仍按 plan 暂缓且无 UI 入口；P3 的 Netcatty 独有能力（browser / ymodem / openSessionLog / 插件菜单 / 右键上传下载 / Paste Selection / 保存屏幕）不移植，属能力差异，未造入口。
- **门禁**：`npm run test:run` 769 通过（70 文件）、`npm run build` 通过、`cargo test --lib` 960 通过、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #222 设置页剩差清理（内容区滚动条 overlay 观感 + 基准字号核对）

- **滚动条取证与选型**：WebView2 实测 `overflow-y: overlay` 的 computed 仍为 `auto`（滚动条继续占 14–15px），即不支持真 overlay。改用 **8px 自绘滚动条 + `scrollbar-gutter: stable` + `padding-right 24→31`** 补偿 15/14→8 的差值：透明轨道 + `muted-foreground/35%` 圆角滑块（hover 50%），视觉接近 overlay，且不改变卡片几何。
- **量测（同一 build 注入改前 CSS 做 A/B，980×720 dsf=1）**：改前 `scrollbarWidth 14 / gutter auto / padding 24 / card 693.6 / cardRight 941.6`，有滚动时 `clientWidth 742`、无滚动 `756`（切 tab 横跳 14px）；改后 `scrollbarWidth 8 / gutter stable / padding 31 / card 693 / cardRight 941`，两种状态 `clientWidth` 恒为 748（横跳 0）。卡片宽度差 0.6px（亚像素舍入）。
- **基准字号核对**：设置页全部可见文本均有显式字号（普查结果 18px×1、14px×161、12px×59），把 `body/html` 基准 13px 临时改为 16px 后重跑普查，三档计数完全一致 → **基准 13 vs 16 无观感影响**；保留 13px 以免牵动应用全局排印。同时把残留的 `13px` 显式取值按 Netcatty 映射修正为 14px：`.nc-set-value`（只读值/滑块值 = `text-sm`）、`.nc-set-stepper button`（对应 14px Minus/Plus 图标）、`.nc-set-link-btn`（Button 默认 `text-sm`）、`.nc-set-app-status`（更新状态 `text-sm`）。
- **验证**：同 build A/B 截图 `evidence/set-scroll-{before,after}-980.png`、滚动条局部 `set-scroll-after-thumb.png`、还原后 `set-scroll-after-restored-980.png`；重新打包后复测 `http://tauri.localhost/`：8px / stable / 31px / card 693（`set-scroll-after-built-980.png`）。断言汇总 `evidence/settings-scroll-verify.json`。
- **门禁**：`npm run test:run` 767 通过（69 文件）、`npm run build` 通过、`cargo test --lib` 960 通过、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #221 主机级关键字高亮（Profile 字段 + schema v50 + 主机浮层/主机编辑器 + 断开回落）

- **Netcatty 模型取证**：主机级 `host.keywordHighlightEnabled?` / `host.keywordHighlightRules?: KeywordHighlightRule[]`；与全局是**追加**语义（全局先匹配、主机规则补充），总开关 `globalEnabled || hostEnabled`；主机 popover 可增删规则 / 切 enabled / 清空（清空 = disabled + []）；关闭开关**保留**规则。**取代 #220「范围决策」中「主机级覆盖未实现」的记录**。
- **后端（schema v50）**：`Profile` 增 `keyword_highlight_enabled: Option<bool>` / `keyword_highlight_rules: Option<Vec<KeywordHighlightRule>>`；`KeywordHighlightRule {id,label,patterns,color,enabled}` 定义在 `models.rs`。`db/schema.rs` v50 迁移对两列先 `column_exists` 再 ALTER（可空，NULL = 跟随全局）；`db/profile.rs` 47 列 upsert/update、`parse_keyword_rules`（坏 JSON 回落 None）、`keyword_rules_json`、写入校验（≤30 条 / id·label 非空 / `#RRGGBB` / 单规则 ≤16 正则且每条 ≤2000 字符），错误码 `profile_keyword_rules_too_many` / `_rule_invalid` / `_color_invalid` / `_patterns_invalid`。CLI / headless / sync / bastion / forward 等 Profile 构造点补齐两字段（旧库不受影响）。
- **前端**：`settingsModel` 抽出 `sanitizeKeywordHighlightRules`，新增 `normalizeHostKeywordHighlightRules`（**空 = []，不回落内置**）；`keywordHighlight.ts` 新增 `mergeKeywordHighlightRules`（`enabled = globalEnabled || hostEnabled`，规则按全局→主机顺序追加）；新增 `terminal/hostKeywordHighlight.ts` 广播，终端与 Vault 保存后即时同步。
  - `TerminalPane`：按 profileId 拉取主机开关/规则；高亮改用 `effectiveHighlight`，主机规则只在 `status === "connected"` 参与合并 → 断开自动回落全局；工具栏「高亮」浮层新增「本主机规则（追加到全局）」区块（开关 / 回车新增 / 逐条启用 / 取色 / 删除），乐观更新 + `updateProfile` 持久化，失败回滚重拉。
  - `VaultView`：主机编辑器新增「关键字高亮（本主机）」分区（开关 + 复用 `KeywordHighlightRulesEditor`）；新建默认关闭/空，编辑从 profile 读取；保存时规则非空才落 JSON（**开关关闭也保留规则**），保存后广播。修复 `openComposerForEdit` 用缓存覆盖终端浮层最新改动的问题（改为先 `api.getProfile` 拉最新档案）。
- **实机验证（129，debug + CDP 9222；`evidence/hl-host-verify.json`）**：
  - 全局主机同一行：`globalDeco {base:5, after:7, delta:2}`、`globalPixels {red:217, magenta:0}`；覆盖主机（`host-cover-129` 规则 `COVERED → #FF00AA`）：`coverDeco {delta:4}`、`coverPixels {red:217, magenta:418}` → 同一输出不同着色（`hl-12-global-host.png` / `hl-13-cover-host.png`）。
  - 热生效不重启：终端浮层改色 `#22CCCC` → `pixelsAfterTerminalColorChange {magenta:0, cyan:490}`；关主机开关 → `keywordSpans 4→2`、cyan 490→64（只剩全局 error 红）；再开 → 恢复 4 / 490；`persistedAfterTerminalEdits {enabled:true, rules:[color:"#22CCCC"]}`。
  - 断开回落：`exit` 后 `decoAfterDisconnect {total:7, keywordSpans:2}`，COVERED 的 58px span 消失（`hl-18-cover-disconnected.png`）。
  - Vault 编辑器：`hostEditorSection {found:true, headText:"关键字高亮（本主机） ⓘ 1 条", enabled:true, ruleRows:[{label:"Cover", color:"#22cccc"}]}`；保存后仍 `#22CCCC`（`hl-19-vault-host-editor.png`）。
  - 截图：`hl-14-term-host-menu.png`（浮层追加区块）、`hl-15-cover-color-changed.png`（同一行 error 红 + COVERED 青）、`hl-16-cover-host-off.png`、`hl-17-cover-host-on.png`。
- **踩坑**：① 切换 surface（Vault ↔ 终端）会重挂 pane、清空缓冲，验证热更新必须留在终端内用浮层操作；② 主机卡不在终端 surface 的 DOM，连前/连后要 `openVault()` 回到 Vault；③ Radix 风格 tab 激活挂 `onMouseDown`，CDP 里 `.click()` 无效，须 dispatch mousedown/mouseup；④ `foregroundColor` decoration 只在 canvas 描字，DOM 拿不到颜色，断言改为按 decoration 几何裁图后在页面内 canvas 统计像素。
- **门禁**：`npm run test:run` 767 通过（69 文件）、`npm run build` 通过、`cargo test --lib` 960 通过、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #220 设置-关键字高亮（Netcatty 数据模型 + 设置/终端同一份规则 + 已开终端热更新）

- **Netcatty 取证（数据模型）**：全局 `terminalKeywordHighlightEnabled` + `terminalKeywordHighlightRules: KeywordHighlightRule[]`，另有主机级覆盖 `host.keywordHighlightEnabled` / `host.keywordHighlightRules` 与主机 popover；规则字段 `{id,label,patterns:string[],color:#RRGGBB,enabled}`；内置 7 组（error/warning/ok/info/debug/ip-mac/unix-path）；匹配方式为「按行、忽略大小写、全局匹配、先规则优先级」；着色语义是 **前景色**（不改底色）；URL/IPV4/IPV6/MAC/Unix path 为预置正则常量；持久化在设置 JSON。工具栏「高亮」按钮与设置页读同一份规则。
- **落地（termX，全局规则层）**：
  - `settingsModel.ts`：新增 `KeywordHighlightRule`、5 个预置正则（STRICT IPv4 八位组 / URL / IPv4 / IPv6 / MAC / Unix path）、`DEFAULT_KEYWORD_HIGHLIGHT_RULES`（7 组同色：`#F87171/#FBBF24/#34D399/#3B82F6/#A78BFA/#EC4899/#A78BFA`）、`normalizeKeywordHighlightRules`（空/非法回落内置、去重 id、最多 30 条 × 16 正则、色值收敛大写）；`TerminalSettings` 增加 `keywordHighlightEnabled`（默认 `true`）与 `keywordHighlightRules`。
  - `terminal/keywordHighlight.ts`（纯逻辑）：`compileKeywordRules`（跳过禁用/非法正则，`gi` 编译）、`findKeywordSpans`（先规则先得、零宽防死循环）、`cellOffsets`（字符索引 → 起始单元格列）。
  - `TerminalPane.tsx`：工具栏「高亮」浮层改读设置 store（同一份规则）；可视区逐行 `translateToString` → 匹配 → `registerMarker(y - cursorLine)` + `registerDecoration({foregroundColor})`（需 `allowProposedApi`），80ms 去抖，订阅 `onWriteParsed/onScroll/onResize`；`subscribeSettings` 监听设置，JSON 比对避免无关设置重绘 → **改规则/开关已开终端立即重绘，无需重启**；浮层支持总开关、逐条启用、回车新增自定义正则、删除，底部「在设置中编辑规则」跳设置页。
  - `SettingsTabs.tsx` 终端 tab 新增「关键字高亮」分区：总开关 + 规则列表（色块取色 / 标签 / 启用 / 内置恢复 / 自定义删除）+「添加自定义规则」+「把内置规则恢复为默认」；规则弹窗（标签+颜色、逐行正则、实时预览、非法正则行内报错、取消/保存）。新增 20 个 zh/en i18n key；`styles.css` 增加 `.nc-set-rule-*` / `.nc-set-modal` / `.nc-set-field-*` / `.nc-set-link-btn` 等设置页令牌化样式。
- **踩坑（已修）**：`normalizeKeywordHighlightRules` 初版把单条正则截断到 200 字符，导致内置 IPV6(~400) / URL 正则被切断 → 正则非法被跳过、内置规则被误判为「已修改」；上限改为 2000 并补回归单测（内置 IPV6/URL 原样保留且 7 组均可编译）。
- **实机验证（129 `tianzry@192.168.126.129`，debug 版 + CDP 9222）**：
  - 输出命中即高亮：`echo "error warning ok debug info"` 五个关键字分别红/黄/绿/蓝/紫；`echo "... https://example.com/a 10.0.0.2"` URL 与 IPv4 命中粉色 → 17 个 decoration（`hl-01-129-highlight.png`、`hl-07-terminal-url.png`、`hl-verify2.json`）。
  - 设置热更新：设置页改 Error 色 `#F87171 → #22CC88`，不关设置/不重启，终端 decoration 立即按新色重绘；关闭设置截图裁剪对比 `hl-12-crop.png`（绿）vs `hl-13-crop.png`（红）；Error 规则关 → 8→6，开 → 6→8（`hl-verify.json`）；总开关关 → 17→0，开 → 0→17（`hl-verify2.json`）。
  - 持久化：改绿后 `Page.reload`，设置页读回 `#22cc88`、7 条规则仍在（`hl-verify2.json`），随后还原红色。
  - 工具栏联动：浮层 7 条规则与设置页完全一致（label 列表相同），总开关同态，含「在设置中编辑规则」（`hl-05-toolbar-menu.png`）。
  - 截图：`hl-02-settings-keyword.png`、`hl-06-settings-reset.png`（内置恢复后 reset 图标 1→0）、`hl-08-rule-dialog.png`、`hl-09-settings-green.png`、`hl-11-settings-master-off.png`。
- **范围决策（记录）**：本轮只做 Netcatty 的**全局规则层**；主机级 `host.keywordHighlight*` 覆盖与主机 popover 未实现（termX 终端标签无主机级设置入口），不影响设置页与工具栏共享同一份规则的行为。
- **门禁**：`npm run test:run` 761 通过（新增 `keywordHighlight.test.ts` 7 例）、`npm run build` 通过、`cargo test --lib` 957 通过、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #219 设置页样式按 Netcatty 运行实例取证照抄（字体随包 / 令牌化 / 明暗两套）

- **取证方式（本轮新增能力）**：Netcatty 无调试端口，改为把 portable 目录复制到 `evidence/nc-app-copy`，以 `--remote-debugging-port=9336` + 独立 `--user-data-dir` 启动第二个实例（必须 `run_in_background` + `$p.WaitForExit()` 保活，否则 shell 结束即被回收）；CDP 设 `Emulation 980×720` 后逐个 tab 采集 8×明暗 共 16 张基准图（`evidence/nc-settings2-*.png`）与量测 `nc-settings-style2.json`。另用 `PrintWindow(PW_RENDERFULLCONTENT=2)` 抓真实设置窗口客户区（`nc-settings-window-980x720.png`），与 CDP 图交叉校验。
- **踩坑**：① Radix Tabs 用 `element.click()` 无效，必须完整 pointerdown/mousedown/pointerup/mouseup/click；② Netcatty 主题是 JS 注入的 `document.documentElement.style` 内联 HSL 三元组，`classList.add('dark')` 无效，须点「Appearance → Light/Dark」；③ termX 侧 `documentElement.dataset.theme` 会被应用重置，须点外观 tab 的主题卡片；④ 125% 缩放下 Chrome 把 1px 边框报成 0.8px（插桩 div 证实），不是缩放错误；`--radius:0.65rem`=10.4px、`rounded-md`=8.4px。
- **实测 → 落地（`styles.css` 设置页令牌，未引入 Tailwind runtime）**：
  - 字体：随包 **Mona Sans**（latin/latin-ext/vietnamese × 400/500/600/700，12 个 woff2）+ **Noto Color Emoji Flags**（`src/assets/fonts/`，13 条 `@font-face` 含 fontsource unicode-range）；`uiFonts.ts` 的 `mona-sans` family 改为与 Netcatty `--font-sans` 完全一致的完整栈（含 `Microsoft YaHei UI`、结尾 `Segoe UI Emoji/Symbol`）。CJK 仍走系统回退（Netcatty 同）。
  - 主题 token：设置页内 Snow（`--background 216 33% 96%`、`--card 0 0% 100%`、`--primary 208 100% 50%`、`--border/input 220 16% 82%`…）与 `html[data-theme="dark"]` 下的 Midnight（`220 28% 10%` / `220 22% 12%` / `200 100% 61%` / `220 22% 18%`），仅作用于 `.nc-settings-overlay`，不影响其他页面。
  - 尺寸：header 61px（标题 18/600/28、top 22）；nav 224px / padding 12 / gap 4 / border-right；搜索框 36h / mb 8 / radius 8.4 / `--input` 边框；tab 36h / padding 0 12 / gap 8 / radius 8.4 / 14/500/20，选中 `--background` + `0 1px 3px rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)`；内容 padding 24、底色 `--background`（删除原 `muted/10`）；分区间距 24、标题 14/600/20 + 12；卡片 `--card` + 1px `--border` + radius 10.4 + padding 0 16 + `divide-y`；行 `padding 12 0`、透明底、无边框、`border-bottom` 分隔（末行无线）；行标题 14/500/20、说明 12/400/16 + mt 2；hint 12/16 + mt 12；select/input/textarea/stepper 36h / radius 8.4 / padding 0 12；开关 36×20；预设胶囊 `padding 4 10` / radius 8.4 / 12/16；主题卡 radius 10.4、子卡 8.4 + 新 shadow；色板改 `flex wrap` 右对齐 gap 8、swatch 24（删除 12 列 grid 与 max-width 560）。
- **改前 → 改后关键差异**：行模型从「分散灰条（secondary/40 + 边框 + 圆角 + 行间 gap 6、min-height 48）」变为「白卡 + 分隔线（padding 12 0）」；内容底色 `muted/10` → `--background`；section gap 8 → 24；header 57 → 61；控件圆角 6 → 8.4；搜索框边框蓝 `--ring` → `--input`；字体从系统栈 → 随包 Mona Sans；暗色从 termX 自有配色 → Midnight。
- **验证**：`npm run tauri -- build --debug --no-bundle` 重建后 CDP 采 980×720 明暗 8 tab（`tx-settings-after-980-*.png` / `.json`）与 720 窄窗（`tx-settings-after-720-*`，`docScrollW == innerWidth`，无横向溢出）；字体非回退证明：`document.fonts` 中 4 个 Mona Sans woff2 状态 loaded（从打包产物 `assets/*.woff2` 实际加载、有 transferSize），同串文字 Mona Sans 宽 200.51px vs `Segoe UI` 189.05px（度量不同即真实生效）；三段对照图 `evidence/cmp-{light,dark}-{01..08}-*.png`（Netcatty / 改前 / 改后，均 980×720 同尺寸拼接），实窗 PrintWindow 对照 `cmp-printwindow-light-terminal.png`。
- **已知差异（保留）**：① 继承基准字号 termX 13px vs Netcatty 16px（所有可见文本均已显式定字号，无实际影响）；② termX 内容区滚动条占 15px，Netcatty 为 overlay 滚动条，卡片宽度差约 15px；③ 关闭按钮图标形态（Netcatty 红底 X 方块）未复刻，属图标资产差异；④ 设置页仍是应用内 overlay（#212 已决策不做独立窗口）。
- **门禁**：`npm run test:run` 754 通过、`npm run build` 通过、`cargo test --lib` 通过、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #218 rssh → termX 系统性改名（代码 / 数据迁移 / 文档）

- **改名映射（实际落地）**：

| 类别 | 旧 | 新 | 备注 |
| --- | --- | --- | --- |
| crate / lib | `rssh` / `rssh_lib` | `termx` / `termx_lib` | `Cargo.toml` + 全部 `use` |
| GUI / CLI / headless 二进制 | `rssh` / `rssh-cli` / `rssh-server` | `termx` / `termx-cli` / `termx-server` | 目录 `src/bin/rssh` → `src/bin/termx`；安装目录 `Programs\termx` |
| 数据目录 / DB | `~/.rssh` / `rssh.db` | `~/.termX` / `termx.db` | 首次启动自动迁移；旧目录回退时仍读 `rssh.db` |
| 钥匙串 service / key | `rssh` / `rssh_master_key_v1` | `termx` / `termx_master_key_v1` | 读新未命中回退旧 service 并回写；旧条目保留 |
| 内部协议 | `__rssh_err__` / `__rssh_clone` / `__rssh_ai_handoff` / `__rssh_done_` / `__RSSH_JSON__` | `__termx_err__` / … | 前端错误解码双前缀兼容 |
| 环境变量 | `RSSH_APP` / `RSSH_DISABLE_WAYLAND_COMPAT` / `RSSH_KEEP_GBM_BACKEND` / `RSSH_WEB_SEARCH_PROVIDER` | `TERMX_*` | 新名优先，旧名读取回退 |
| 显示名 / UA | `RSSH`、`RSSH — Local Analysis`、UA `rssh/` | `termX`、`termX — Local Analysis`、UA `termx/` | 窗口标题、clap about、CLI 帮助、iOS 用途说明 |

- **迁移实现（`db/data_dir_migration.rs`）**：`db::data_dir()` 每次先做存在性检查，只有「旧目录存在且新目录不存在」才迁移。同卷 `rename(~/.rssh → ~/.termX.tmp-<ts>-<pid>)` → 目录内 `rssh.db*` 改名 → 原子 `rename` 到 `~/.termX`；跨卷（Windows errno 17 / Unix EXDEV）改为复制到 staging → 只读打开并比较表数/行数 → rename → 删旧目录。`rssh.db`、`-wal`、`-shm`、`.bak-*` 一起处理。任何校验/rename 失败都把 staging 还原回旧目录或删除副本，继续用旧目录并告警；崩溃留下的 staging 下次启动自动收尾。`~/.termX` 一旦存在即不覆盖；跨进程 `~/.termX.migration.lock` + 120s 陈旧锁保证可重入。
- **一次性可观测**：迁移报告写入 `<data_dir>/.rename-migration.json`，设置页「系统」tab 新增「数据存储」区块，显示当前数据目录 / DB 路径；打开系统 tab 时读取并删除通知，展示「旧 → 新 / 模式 / 表 / 行 / 录制 / 旧目录是否清理」；失败状态展示原因并说明仍在使用旧目录。日志同时写 `data dir migrated ...`。
- **钥匙串保留策略**：新 service 写入前先读旧 service；读到后懒回写新 service，**旧条目保留一个发布周期**（本次不删），避免迁移/回滚失败丢主密钥；显式 delete 时两个 service 都清，防止已删密钥被回退路径"复活"。**sync 远端备份文件名 `rssh_backup.*` 不变**（避免破坏既有远端快照）。
- **实机迁移（旧 `~/.rssh` 真实数据）**：`mode=rename`，旧目录已删除；DB 23 表 / 301 行 → 23 表 / 301 行（表、行完全一致），录制 179 个 `.cast` 全部跟随；迁移后连 129（密码取自旧库 + 旧钥匙串）成功，自动日志新增 1 个 `.cast`（180），重启后 DB 23 表 / 302 行、`session_logs` 179 → 180、`profiles` 4、`proxy_profiles` 1、`notes` 5 全部仍在；日志页显示 180 条、最新 `129 2026-11-06 11:52`（29 事件）。截图 `evidence/rename-migrate-01-settings-system.png` ~ `05-restart-logs.png`，断言 `rename-migrate-verify.json` / `rename-migrate-restart.json` / `rename-migrate-notice.json`。
- **未改名（有意保留）**：`changelogs.md` 历史条目、`docs/plan.md`、`docs/netcatty-tauri-migration.md`、`evidence/` 历史产物、sync 远端 `rssh_backup.*`、旧 `__rssh_err__` 前缀 / 旧 keychain service / 旧 master key 名（兼容回退）、`https://github.com/rssh-org/docs` 外部链接、回退旧目录时的 `rssh.db` 文件名。
- **门禁**：`npm run test:run` 754 通过（新增旧错误前缀解码 1 例）、`npm run build` 通过、`cargo test --lib` 957 通过（新增数据迁移 7 例：成功改名/幂等/不覆盖新目录/空新目录回退/源库损坏回滚/staging 恢复/跨卷复制；另有 keyring 探针 1 例）、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #217 剩余低危技术债清理（5 项关闭 / 2 项保留）

- **范围**：2026-11-02 只读审计的低危项 #1/#5/#6/#7，另清 2 个测试编译告警；#2（两套主机表单，中危）与 #3（大文件职责，架构级）不属低危，保留不动。
- **#1 headless dispatcher 缺口（已修）**：`server.rs` 补齐 15 条分支——`ssh_exec`（抽出 `session::ssh_exec_impl`，Tauri 命令与 headless 共用）、5 个动态发现命令（`discovery` 抽出 5 个 `*_impl`）、`open_external_url`（抽出 `external::open_external_url_impl`，改用 `tauri_plugin_opener::open_url` 自由函数，无 `AppHandle` 也能打开系统浏览器）、`app_lock` 6 命令、`clipboard_read/write`。`lib.rs` 224 个命令的覆盖缺口从 27 降到 12，剩余 12 条全部为 GUI 专属（`close_window_sessions`、`open_tab_in_new_window`、`pty_spawn_connector`、`set_app_icon_variant`、`set_window_background_blur`、`set_window_opacity`、`sftp_pick_*` ×5、`sftp_save_file`），已在 `server.rs` 文档注释中显式列为不实现及原因（headless 无窗口/原生对话框/图标）。
- **#5 `sftp_download` 内存版（已修一半）**：删除前端零调用的 `sftpDownload` 封装；后端命令保留供 headless/CLI 小文件读取，并加文档约束「桌面前端大文件一律走流式 `sftp_download_to`」。彻底删除会破坏 headless 小文件读取，且改动收益低于风险。
- **#6 零调用后端命令（已复核关闭）**：discovery / plugin / command_block / update / sync / AI / `reconcile_sessions` 均有 headless、CLI 或暂缓模块（#15/#26/#27）作为调用方，不是死代码；`clipboard_read/write` 本轮已补 headless 分支。保留，随模块接线。
- **#7 dead-code 警告（已清零）**：删除 `sanitize::decode_lossy` 与 `app_lock.rs` 未用 `Arc` 导入；`cli_status_headless`、`forward_rule_start_impl` / `forward_rule_stop_impl` 仅在 `server` feature 下使用，加 `cfg_attr(not(feature = "server"), allow(dead_code))`；`ChatDelta::ToolStart/ToolArgs` 字段保留完整协议形状，加注释（待 #27）与 `allow(dead_code)`；另清 `secret/crypto.rs` 未用变量、`terminal/telnet.rs` 未读初值两个测试告警。`cargo check --all-targets`（默认与 `--features server`）零警告。
- **保留项**：#2 两套主机表单收敛属中危、需产品确认统一入口；#3 大文件拆分按「相关维护时按职责拆分，不专项重写」的既定口径继续延后。
- **门禁**：`npm run test:run` 753 通过、`npm run build` 通过、`cargo test --lib` 949 通过（新增 `open_external_url` 非 http(s) 拒绝用例）、`cargo build --features server` 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #216 129 SSH 全矩阵实机验证（逐项截图 + JSON 断言）

- **验证方式**：`npm run tauri -- build --debug --no-bundle` 重建（dist 内嵌）后实跑 debug 版，真连 `tianzry@192.168.126.129:22`（密码认证），WebView2 CDP 9222 驱动；三支脚本 `evidence/audit16-01-toolbar-context.mjs`、`audit16-02-timestamps-compose.mjs`、`audit16-03-logs-autocomplete-split.mjs`，产物同名 `.json` + 31 张 `audit16-*.png`。
- **工具栏（13 项 + 关闭窗格）**：左 5 = 复制主机地址 / 隐藏时间戳 / 系统监控 / 断开连接 / 重新连接当前会话；右 7 = 主机关键词高亮 / 打开 SFTP / 撰写栏 / 终端搜索 / 开始记录会话日志 / 运行脚本 / 笔记面板；再加「更多」= 13，另有「关闭当前窗格」（24×24）为第 14 个按钮。顺序与可见性完全由 `toolbarLayout` spec 派生。
- **更多菜单（5 项）**：命令历史 / 配置目录追踪（已启用：/home/tianzry）/ 终端设置 / 开始录制 / 终端编码 UTF-8。逐项点开：历史面板 5 行、设置 overlay、OSC 7 对话框、编码子菜单 UTF-8·GB18030 均可见；开始录制后行文案变「停止录制」且出现 REC 徽标，停止后恢复。
- **标签状态点与关闭按钮**：`.nc-tab-dot` 8×8，观测到 `connecting → connected`（`rgb(52,211,153)`），工具栏断开后变 `disconnected`（`rgb(244,63,94)`），重连回 connected；`.nc-tab-close` 20×20、`border-radius:50%`、opacity 1。
- **右键菜单**：已连 8 项 = 复制（无选区时置灰）/ 粘贴 / 全选 / 打开 SFTP / 水平分屏 / 垂直分屏 / 清空缓冲区 / 关闭终端；断开后「打开 SFTP」置灰并新增「重新连接」（9 项）。点击行为全通：复制主机地址后 title 变「已复制主机地址」且剪贴板读到 `192.168.126.129`；全选产生 3 块选区并复制出 `PASTE-PROBE-216`；清空后标记行消失；水平分屏 1→2 窗格；关闭终端后标签数 0。
- **时间戳**：开关两态（隐藏时间戳 → 显示时间戳）正常；gutter 行格式 `HH:MM:SS` 全通过、`missing` 为空；窄视口 1180×760 reflow 后仍对位（gutter 696 vs terminal 684，右侧无越界），恢复后 736=736；分屏两侧标签各自增长，A 侧标签序列在 B 输出后逐项不变（`aUnchanged:true`）。
- **撰写栏**：两行同时发送 `COMPOSE-A-216` / `COMPOSE-B-216` 均在远端执行（bracketed paste）；↑ 取回两行历史、↓ 恢复到空草稿、Esc 收起。
- **日志**：连接即生成 `129_<时间>.cast`（录制中 1774B，含 `AUTO-CAST-216`）；日志页可见（176 条，最新一条 27 事件 / 1.9 KiB）；详情页开始/结束/时长/路径齐全；手动日志经 `start_manual_session_log` 写自定义路径 `evidence/audit16-manual-log.txt`，81B 且含探针。
- **自动补全**：`l` 出 `cls/cless/cln/clsblk`；`ls ` 出远端 6 个目录；`↓` 展开 `.cache/` 子项（`evolution/` 高亮选中）；`→` 下钻成 `ls /home/tianzry/.cache/evolution/`；`Tab` 放行并关闭候选。
- **分屏稳定性（连开/关 3 次）**：每次「打开 2 窗格 → 关闭回 1」，原窗格 `data-session-id` 不变、标记文本不丢（`sidStable:true` / `markerKept:true` ×3）。
- **P1**：无。
- **P2（已修）**：
  1. **`.cast` 录制期间恒为 0 字节**：`Recorder` / `TextLogRecorder` 的 `BufWriter` 只在 `finish` 落盘，连接期间日志页/导出读到空文件 → `new` 写完 header 后立即 `flush`，`record` 每次 drain 后 `flush`；新增单测 `cast_visible_while_recording`。实测录制中即 1774B。
  2. **右键粘贴出现字面量 `[200~…[201~`**：原 `term.paste()` 的 bracketed 序列在逐字兼容拆分中丢失 ESC → 新增 `buildPastePayload`（CRLF/CR/LF 统一为 CR，bracketed 时整段 `\x1b[200~…\x1b[201~`）+ `writeBulk` 一次写入；补 4 个单测。实测粘贴行干净、无 `[200~`。历史面板中修复前的 `[200~PASTE-PROBE-216~` 条目属旧数据，不回写清理。
- **P3（记录）**：更多菜单「开始录制」仍是 JSX 内联文案，未走 `terminalActionText.ts`（#214「单一文案源」残留）；OSC 7 对话框 Esc 是否可关未确认；Netcatty 独有能力差异（browser / ymodem / openSessionLog / 插件菜单）按既定范围不移植。
- **未验证项与原因**：Netcatty 侧无 CDP，像素级并排仍不可自动化；断开用工具栏「断开连接」（等价 kill 会话），未做真实断网；`.cast` 仅验证本机 recordings 目录，未验证自定义录制目录；右键「复制」在有选区时的启用态未单独断言（已用全选后复制间接覆盖）。
- 截图：`evidence/audit16-01-connected.png` … `audit16-31-split-3cycles.png`（31 张），数据 `evidence/audit16-01/02/03-*.json`。
- 门禁：`npm run test:run` 753 通过、`npm run build` 通过（tsc + vite）、`cargo test --lib` 948 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #215 第二轮全应用比对（debug 实跑 + 逐页复核）

- **比对方式**：`npm run tauri -- build --debug --no-bundle` 生成 debug 版并实跑（dist 内嵌，改前端必须重建才生效），WebView2 CDP 9222 逐页截图 + 量测，脚本 `evidence/audit15-compare.mjs`、`evidence/audit15-final-serial.mjs`；Netcatty 侧用运行实例 PrintWindow 截图 + 源码静态比对（其运行实例未开 CDP，无法逐页自动化）。
- **覆盖范围**：Vault 首页/主机、串口弹窗（含勾选保存配置两态）、笔记页、会话日志、脚本页、主机监控、本地终端工具栏 / More 菜单 / 右键菜单。
- **P1（严重回归）**：未发现。
- **P2（低风险，已修）**：串口弹窗「取消」按钮缺 outline 边框，与 Netcatty `DialogFooter` 的 outline 取消按钮不一致 → `.serial-cancel` 补 `1px solid #e2e8f0` + `padding: 0 16px`，重建后实测 computed `0.8px solid rgb(226,232,240)`、高度 36px 不变。
- **P3（已知能力差异，不入本轮修复）**：
  - Netcatty 工具栏独有 `browser` / `ymodemSend` / `ymodemReceive` / `openSessionLog`，termX 按既定范围不移植（已在 todo「不移植」节登记）；
  - Netcatty 右键菜单另有「上传/下载」「Paste Selection」「保存屏幕」「插件菜单」等项，属能力差异；
  - Netcatty 支持插件贡献菜单，termX 无插件宿主。
- **回归核对（本轮改动直接相关项，均正常）**：本地终端工具栏顺序 `关键词高亮 / 撰写栏 / 终端搜索 / 记录会话日志 / 运行脚本 / 更多 / 关闭当前窗格`（SFTP、笔记按类型隐藏）；More 为 `命令历史 / 终端设置 / 开始录制`（本地无 OSC7 / 编码）；右键为 `复制 / 粘贴 / 全选 / 水平分屏 / 垂直分屏 / 清空缓冲区 / 关闭终端`；日志表格行高 48px、表头存在；脚本页行高 56px；笔记页正常渲染；串口弹窗 448px 宽、文案与图标对齐 Netcatty。
- **截图**：`evidence/audit15-00-netcatty-window.png`、`audit15-00b-netcatty-terminal.png`、`audit15-01-vault.png`、`audit15-02-serial.png`、`audit15-02b-serial-save.png`、`audit15-02c-serial-final.png`、`audit15-03-notes.png`、`audit15-04-logs.png`、`audit15-05-snippets.png`、`audit15-06-monitor.png`、`audit15-06b-hosts.png`、`audit15-07-terminal.png`、`audit15-08-more.png`、`audit15-09-context.png`；数据 `evidence/audit15-findings.json`、`evidence/audit15-serial-final.json`。
- **未验证项与原因**：Netcatty 全应用逐页像素对齐未自动化（运行实例无 CDP，只能截当前窗口，无法切页）；SSH 真机 129 的工具栏/右键在四类终端全矩阵未逐类复测（本轮只实跑本地 PTY，SSH 侧靠 `deriveToolbarCapabilities` 单测与类型矩阵保证）；主机弹窗、设置页仅静态对照，未做像素量测。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过、`cargo test --lib` 947 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #211 设置独立窗口可行性立项（只调研 + 方案，不写代码）

- **Netcatty 现状（Electron，只读对照）**：`electron/bridges/windowManager/settingsWindow.cjs` 创建 `BrowserWindow`：`980×720`、`minWidth 820 / minHeight 600`、`modal:false`、**不设 parent**（mac 拖屏不可见 / Windows 关设置连带关主窗）、`show:false` 加载完再显示；关闭时 `preventDefault + hide()` 复用；每次打开按主窗口所在显示器的 `workArea` 居中；路由为 `#/settings`；Windows 下无边框自定义 chrome + `restoreWindowInputFocus`（`setAlwaysOnTop(true→focus→false)` 闪现抢焦点）。
- **termX 现状**：设置是 `SettingsDialog` 全屏 overlay（`.nc-settings-overlay`，`App.tsx` 用 `settingsOpen/settingsTab` 控制）；设置对象整包存 db `settings` 表 key `settings.center.v1`（`settingsStore.ts` 模块级单例 + `applySideEffects`，200ms 去抖持久化）；Rust 已有 `on_window_event`（`Destroyed` 按 window label 关会话）与多窗口先例（`emitter.rs` 的 `WebviewWindowBuilder` AI 分析窗）。
- **方案（Tauri 2 单 WebView2 模型，独立 `WebviewWindow`）**：
  1. **建窗**：Rust 命令 `open_settings_window(tab)`（不走前端建窗可省一大组 capability）：`WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html#/settings".into()))`，`title("termX 设置")`、`inner_size(980,720)`、`min_inner_size(820,600)`、`resizable(true)`、`decorations(true)`（不做 Netcatty 的无边框/自定义 chrome，降风险）、`visible(false)` 后 `show()` 防白屏；位置按主窗口 `outer_position` + `current_monitor().work_area` 居中（复刻 Netcatty 的「跟随主窗所在显示器」）。已存在 `app.get_webview_window("settings")` 时去重：重新居中 + `show/unminimize/set_focus`。
  2. **路由**：`main.tsx` 启动时判断 `location.hash`：`#/settings` → 只渲染 `<SettingsWindowApp>`（壳 + `SettingsDialog`，CSS 增加 `nc-settings-window` 变体把 overlay 改成填满窗口，无遮罩）；`#/settings?tab=appearance` 支持入口指定初始 tab。主窗口忽略该 hash；设置窗口**不启动主 App**（不恢复工作区、不建会话），避免双份副作用。
  3. **入口改造**：`App.tsx` 的 `onOpenSettings`（application）、终端 toolbar「终端设置」（appearance）改调 `invoke("open_settings_window", { tab })`；invoke 失败（移动端/能力缺失）回落到现有 overlay，overlay 代码保留作为 fallback。
  4. **跨窗口同步**：`settingsStore` 增加 `applySettingsFromPeer(payload)`（规范化 + `applySideEffects` + `emit`，**不再落库**）；`persist` 去抖写库成功后 `emit("settings:changed", { version, origin, settings })`（Tauri JS `emit` 广播）；两窗口启动时 `listen("settings:changed")`，忽略 `origin` 与自己；payload 带 `version+origin`（对齐 Netcatty `terminalFontSizeSync` 的 `version|origin` 记录），解决双窗并发写 `settings.center.v1` 的后写覆盖问题。主题/UI 字体/透明度/自定义 CSS/终端字号全部走同一 payload。
  5. **生命周期**：设置窗 `CloseRequested` → `prevent_close + hide()`（隐藏复用，对齐 Netcatty）；主窗口 `Destroyed` 时 `destroy` 设置窗（否则主窗关掉后 app 因设置窗仍存活而不退出）；`RunEvent::ExitRequested` 时强制 destroy。现有 `close_window_sessions(state, window.label())` 对 `settings` 无会话，天然无副作用（补注释即可）。
  6. **配置/权限**：Rust 建窗则前端无需新增 `core:webview:allow-create-webview-window`；窗口尺寸首版不持久化（每次 980×720 居中，对齐 Netcatty），后续可选存 db。
- **风险**：
  - 双 WebView2：额外常驻内存约 80–150 MB、冷开 0.5–1.5s（共享同一 user data 目录，localStorage 可见，但设置以 DB 为准）。
  - 双窗写设置竞态：全量 payload + version/origin 广播可解，但仍需回归「设置窗改主题 → 主窗即时应用、反之亦然」。
  - dev/prod 路径差异：`index.html#/settings` 在 dev 由 devUrl 解析、打包后走 asset 协议，需各回归一次。
  - AppLock（`AppLockGate`）：主窗锁定后是否允许设置窗修改安全项需产品决策；建议设置窗同样挂锁或锁定时禁止打开。
  - 主窗关闭到托盘/最小化时设置窗是否跟随隐藏；`single_instance` 回调目前只聚焦 main，需补 settings。
  - 隐藏复用 = 内存常驻（与 Netcatty 相同取舍）。
- **工作量估计**：路由 + 设置窗壳（含 overlay 变体/初始 tab）0.5–1 人日；Rust 建窗/去重/居中/隐藏复用/主窗联动 1–1.5 人日；跨窗口同步（version+origin 事件 + 副作用回归）1–1.5 人日；能力与 dev/打包回归 + 手动双窗测试 0.5–1 人日；**合计 3–5 人日**。建议先做 0.5 人日 spike（Rust 建窗 + `#/settings` 空壳 + 主题广播）验证 WebView2 双窗行为，再正式排期。
- **结论（已决策）**：**不做独立窗口，保留现有应用内 overlay（`SettingsDialog`）形态**。技术上可行（spike 已验证 `WebviewWindow("settings")` + `#/settings` hash 路由在 dev 下可达、980×720 尺寸与 workArea 居中生效、min 820×600 由 `WM_GETMINMAXINFO` 保证），但独立窗口带来的双 WebView2 常驻内存、跨窗同步与 AppLock 联动复杂度不值得为设置页付出；该方案关闭，不再排期。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过、`cargo test --lib` 947 项（首跑 1 项已知偶发超时，单跑通过）、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #214 技术债：工具栏 spec 驱动 JSX + 三处文案统一

- `toolbarLayout.ts`：新增 `TOOLBAR_CAPABILITY_OF`，`resolveTerminalToolbarActions` 对全部内联项（highlight/sftp/compose/search/sessionLog/scripts/notes）走能力表过滤；新增 `TERMINAL_MORE_ACTIONS` + `resolveTerminalMoreActions`，More 菜单顺序与可见性也由 spec 派生。
- `TerminalPane.tsx`：右侧工具栏改为 `toolbarActions.map` + 按 id 渲染，删除 JSX 里各按钮的类型判断与 `includes("sftp")` 分支；More 菜单改为 `moreActions.map`，删除 `caps.menuHistory/menuOsc7/menuEncoding` 等条件包裹。新增动作只需改 spec + switch 分支。
- 新增 `terminal/terminalActionText.ts`：`TERMINAL_TOOLBAR_TEXT`、`TERMINAL_MORE_TEXT`、`TERMINAL_CONTEXT_MENU_TEXT` 作为唯一文案来源；工具栏 title/菜单行、More 菜单、右键菜单（含「打开 SFTP」）全部引用同一常量，`CONTEXT_MENU_LABELS` 从 TerminalPane 移除。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过（toolbarLayout 4 项、contextMenuLayout 8 项测试保持通过）。

## 2026-11-06 — #213 串口弹窗文案与按钮图标对齐 Netcatty

- 文案改用 Netcatty `zh-CN` 原文：`保存配置`（原「保存为主机」）、`将此串口配置保存到主机列表以便快速访问`、`配置名称`（原「主机名称」）、占位 `例如 Arduino Uno`；勾选时不再自动填充名称，空名仍回落后端默认 `串口 <port>`。
- 主按钮随勾选切换：未勾选 `连接` + Cpu 图标，勾选 `连接并保存` + Save 图标（新增 `cpu` 图标）。
- 弹窗宽度已是 Netcatty `max-w-md` 对应的 448px，本轮不改；字段顺序、`space-y-4` 间距与按钮高度（36px）保持一致。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过。

## 2026-11-06 — #212 设置独立窗口方案关闭（保留 overlay）

- **决策**：用户确认设置继续使用应用内全屏 overlay（`SettingsDialog` + `.nc-settings-overlay`），不改为独立 `WebviewWindow`。`todo.md` 对应项已关闭，后续不再捡起。
- **spike 结果（已回滚，仅留档）**：仅本地未提交验证，验证后全部回滚，未产生提交。
  - dev（`tauri dev`）：`WebviewWindow("settings")` 打开 `index.html#/settings` 成功，hash 路由可达；inner 980×720；OS 窗口 rect 658,221 在 2560×1390 workArea 内精确居中。
  - 最小尺寸：`WM_GETMINMAXINFO` 返回 minTrack 1043×797 物理像素（DPR 1.25 + 边框），即 820×600 逻辑尺寸生效。
  - 回滚范围：`src-tauri/src/commands/window.rs`、`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`、`src/main.tsx` 全部还原；spike 取证脚本与截图已删除。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过。

## 2026-11-06 — #210 笔记页信息架构对齐 Netcatty

- **同一套模型确认**：Netcatty `VaultView` 直接渲染 `NotesManager`（`displayMode` full/sidebar 分支），分组、大纲、编辑/预览模式都在同一个组件里；termX 页面版与 #205 终端面板也共用 `src/notes/notesModel.ts`（`createNoteSaveQueue` / `draftToNote` / `api.saveNote`），两处保存入口均只调用 `api.saveNote`，未出现第二套保存逻辑。
- **页面版对齐（`NotesView.tsx` / `notes.css`）**：
  - 树头去掉「笔记」标题，6 个图标左对齐（40px 高、左右 6px），与 Netcatty 的 `TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS` 图标行一致；去掉树底部「N 条笔记」计数条；
  - 树体 padding `6px 6px 16px`、行间距 4px（对齐 `px-1.5 pt-1.5 pb-4 space-y-1`）；
  - 树空态改为虚线卡片：`16px` padding、`8px` 圆角、20px Search 图标、14px 文案（「这个笔记本里还没有笔记。」/「没有找到笔记。」），移除卡内「新建笔记」按钮；
  - 零笔记时隐藏整棵树（对齐 Netcatty `shouldShowNotesTree = isSidebarMode || sortedNotes.length > 0`），建笔记/导入改由右侧空态承担；
  - 标题行 padding 改为 `24px 32px 4px`（`min-height` 54 不变），对齐 `px-8 pt-6 pb-1`；
  - 编辑器空态对齐：64×64 / 16px 圆角 / 30px 铅笔图标（0.6 透明）、18px/600 标题、14px 描述「可以记录运维手册、临时备忘、服务器交接信息。」，并补「新建笔记」「导入 Markdown」双按钮（36px 高、14px 字号）；
  - 标题 placeholder 改为「笔记标题」。
- **保留差异**：Netcatty 的 live 是 MDXEditor 内联渲染，termX 仍用「编辑 / 分屏 / 预览」；公式按等宽文本渲染。
- 验证：`evidence/audit13-01-notes-page.png`、`audit13-02-search-empty.png`、`audit13-03-notes-restored.png`，`audit13-assertions.json` 2/2（树宽 300/头高 40/padding/行距/标题行 padding、空态虚线卡片样式与文案）。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过、`cargo test --lib` 947 通过、`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #209 #205 原生验证（真实 129 SSH）+ 面板开关按标签记忆

- **面板开关按标签记忆**：`App.tsx` 原先 `tool` 是全局状态，切标签后面板开关不随标签变化，不满足 #205 的验收项。新增 `notesOpenTabs: Record<tabId, boolean>`；`toggleTool("notes")` 只切当前标签、`closeTool()` 记录关闭、`activeTabId` 变化时按 map 恢复（SFTP 仍保持既有全局行为）。
- **原生验证（真实 `tianzry@192.168.126.129`，CDP 1440×900，证据 `evidence/audit12-*`）**，`audit12-assertions.json` 16/16 通过：
  1. **列表→编辑→保存→重开**：面板「+」新建并写入标题/正文（含 Markdown 主机链接）→ footer 显示「已保存 · 04:08:39」→ 返回列表可见 → 关闭面板再重开数据仍在；验证后删除该笔记，未留测试数据（另清理了一轮失败跑产生的同名笔记）。
  2. **fit 正确**：开面板前 `.xterm-screen` 1344px、cols 163、rows 47；开 420px 面板后 924px、cols 112、rows 47（rows 不变）；关面板恢复 1344px / 163 / 47；开、关两态 `.xterm-viewport` 的 `scrollWidth == clientWidth`（无横向滚动条）。
  3. **分屏**：右键「水平分屏」后 2 个 `.pane-cell`（各 510px，screen 412px）；再开 420px 面板，两窗格 `overflowX=0`、screen 均在窗格边界内。
  4. **ssh:// 链接**：预览点击 `ssh://tianzry@192.168.126.129`，会话标签 1→2，新标签标题「129」。
  5. **按标签记忆**：链接新建的标签 B 默认不带面板；切回标签 A 面板自动恢复开启；切到标签 B 保持关闭；在 B 手动开面板成功。
- 踩坑（取证脚本）：
  - xterm 6 取不到 `.xterm-char-measure-element`，cols/rows 改为「用 `.xterm-rows` 同字体探针 span（100 个 W）算单元格宽高 + `.xterm-screen` 像素」换算；
  - 右键菜单处理器挂在 `.pane`（TerminalPane 根节点）而不是 `.pane-cell`，在 `.pane-cell` 上派发 `contextmenu` 不会弹出菜单；
  - Node 的全局 WebSocket 会挂住事件循环，脚本末尾必须 `process.exit()`，否则外层 `Stop-Process` 永远跑不到（上一轮 120s 超时的根因）。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过、`cargo test --lib` 946 通过 + 1 项首跑超时（`commands::plugin::tests::local_exec_caps_output_without_breaking_the_pipe`，已知偶发），单跑通过；`npm run tauri -- build --debug --no-bundle` 通过。

## 2026-11-06 — #207 脚本页列表行样式对齐 Netcatty（卡片视图不动）

- 仅改 `src/snippets/snippets.css` 的 `.sn-row` 体系，不动 `SnippetsView.tsx` 结构：
  - 列表行（`.is-list`）：56px 高、左右 12px、圆角 8px、无边框、透明底，hover `bg-secondary/60`；选中 `primary/5`。
  - 列表行图标盒：44×44、圆角 12px、实心底（片段 sky-700 / 脚本 violet-700 / 分组 primary），图标 18px。
  - 主标题 14px/600，副标题 11px 等宽字体/16px 行高；快捷键 badge `4px 8px`、10px。
  - hover 编辑按钮 32×32（默认 opacity 0，行 hover 显示，按钮自身 hover 有底色）。
  - 卡片视图（`.is-grid`）保留 68px、0.8px 边框、半透明底、10px 圆角、32px 图标盒、24px 编辑按钮。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过、`cargo test --lib` 947 通过（无后端改动）；`npm run tauri -- build --debug` 编译 + 生成 `rssh.exe` 成功，MSI 打包因取证时 app 正在运行占用 exe 而失败（os error 32），非代码问题。
- 实机取证（CDP，1280×900，`evidence/`）：
  - `audit11-snippets-list-light.png` / `-dark.png` / `-hover.png` / `-grid-light.png`；
  - 量测：列表行 56px、图标 44×44/radius 12/`rgb(3,105,161)`、标题 14px、副标题 11px、badge 29×21.6、编辑 32×32（hover opacity 1）、行透明无边框；卡片行 68px/图标 32×32/边框 0.8px/圆角 10px（未受改动影响）。
- 同时修正 #206 记录：面板 CRUD 已实机跑通并截图（见 `#206` 条目补充与 `audit11-monitor-*`）。

## 2026-11-06 — #206 监控多面板持久化（DB 表 + 面板 CRUD + 按面板监控）

- 数据层：schema v49 新增 `monitor_panels`（`id / name / host_ids(JSON) / layout / columns / interval / sort_order`），`CREATE TABLE IF NOT EXISTS` + 索引，迁移块幂等，重复执行安全；`SCHEMA_VERSION` 48→49。
- 后端：`db/monitor_panel.rs` 提供 `list/save/delete`；保存前归一化（名称去空白、空名/空 id 报 `monitor_panel_name_required` / `monitor_panel_id_required`、主机去空去重、`layout` 仅 charts/list、`columns` 上限 8、`interval` clamp 1..60），按 `sort_order ASC, name ASC` 返回；`models::MonitorPanel` + 三个 Tauri 命令注册进 `lib.rs`，`server.rs` headless 三命令同引擎分派（R4）。
  - 顺带修复 headless 既有编译错误：`server.rs` 的 `recordings_dir` 分派把 `String` 直接传给 `ok(AppResult<T>)`，补 `Ok(...)` 后 `cargo check --features server --bin rssh-server` 通过（该错误与 #206 无关，但阻塞 headless 门禁）。
- 前端：新增 `src/monitor/monitorPanelsModel.ts`（默认面板 `all`=「全部 SSH 主机」、`panelsWithDefault` / `profilesForPanel` / `sortPanels` / `nextSortOrder` / `normalizePanelDraft`）与 5 例单测。
- `MonitorView`：页头新增面板下拉（运行中禁用切换，保证开始/停止只作用于当前面板）、新建/编辑按钮；自定义面板可编辑名称、勾选 SSH 主机、默认布局、列数（自动 / 1-4）、刷新间隔、排序；删除需二次确认；默认面板不可编辑/删除。选面板即应用其布局 / 列数 / 间隔；页头改间隔或图表/列表会即时落库到自定义面板。图表网格 `columns=0` 沿用 `auto-fill minmax(340px,1fr)`，否则固定列数。
- 交互口径：面板存主机 id，已删除主机的 id 自动忽略；自定义面板保存要求 ≥1 台 SSH 主机；面板读取失败在页头下方提示，不阻断「全部 SSH 主机」默认面板。
- 门禁：`npm run test:run` 751 通过、`npm run build` 通过、`cargo test --lib` 947 通过、`cargo check --features server --bin rssh-server` 通过。
- 实机取证（CDP，1280×900）：新建 → 勾选 1 台主机 → 列数 2 / 间隔 5 → 保存后下拉出现「审计临时面板」并自动选中；编辑弹窗可回读；删除需二次确认，删除后回落到「全部 SSH 主机」（`all`）。
  - 截图：`evidence/audit11-monitor-empty.png`、`audit11-monitor-panel-dialog.png`、`audit11-monitor-panel-dialog-filled.png`、`audit11-monitor-panel-saved.png`、`audit11-monitor-panel-edit.png`、`audit11-monitor-panel-deleted.png`。
  - 临时面板已删除，未留下测试数据。
- **未实测**：多面板并行运行（按设计运行中禁止切面板，需先停止）；监控开始后的真实采样（沿用既有 `monitor_sample`，本项未改采集逻辑）。

## 2026-11-06 — #205 SSH 终端右侧笔记面板

- Netcatty 取证：笔记是终端侧栏（`TerminalLayer` side panel）的一个工具 tab，不是独立窗口；侧栏默认宽 420px（最小 280px），可停靠；sidebar 模式只显示「搜索 + 分组/笔记列表」，点笔记后在侧栏内切换为编辑态；复用全局 `NotesManager` 数据（本地笔记库），`ssh://` 链接点击打开对应主机；侧栏开关按标签页记忆（`sidePanelOpenTabs`）。
- termX 落地：
  - `Tool` 增加 `notes`，复用现有 `AsidePanel`（标题「笔记」、宽 420px、关闭按钮），不新增常驻侧栏 rail。
  - 入口：SSH 终端工具栏新增 `file-text` 图标（本地/串口/Telnet 不显示，`toolbarCapabilities.notes` 仅 SSH 为真）；这是相对 Netcatty 唯一的新增入口——Netcatty 从侧栏工具 rail 打开，termX 无 rail，已在此记录。
  - 新增 [NotesPanel.tsx](file:///g:/AiCode/termX/termX/src/notes/NotesPanel.tsx)：搜索无防抖、列表 56px 行（32px 图标盒 + 标题 + 摘要 + 置顶徽标）、新建笔记、编辑态覆盖列表（标题输入 + Markdown 编辑/预览切换 + 删除）；保存复用 `createNoteSaveQueue`（500ms 合并写）与 `save_note`/`list_notes`/`delete_note`，与 Vault 笔记页同数据层，切换/关闭面板前 flush。
  - `ssh://` / `telnet://` 链接在预览态复用 `findProfileForHostLink` 匹配主机并调用 `App.connect`；找不到时在面板底部给出提示。
  - 布局：`AsidePanel` 与 `.nc-main` 同级，展开后终端列宽变化由 TerminalPane 既有 ResizeObserver → `fit()` 自动重排，分屏结构不变。
- 门禁：`npm run test:run` 746 通过、`npm run build` 通过、`cargo test --lib` 943 通过。
- **未实测**：未做桌面端截图/点击回归（笔记列表与编辑保存走既有接口与既有 Vault 流程）；面板开合后分屏 xterm fit 仅按 ResizeObserver 静态确认。

## 2026-11-06 — #208 复审 #204（c422e22 / 2bf4568）Telnet 纳入主机协议

- 复审分级与处理：
  - **高 1｜Telnet 密码明文写入工作区**（`Workspace` 保存时 `session.password` 随 connector 进 localStorage）：已修。新增 `workspaceStore.sanitizeConnectorForStorage` 落盘前剥离密码；`TelnetSessionConfig` 增 `profileId`，恢复工作区前 `hydrateTelnetPasswords` 按 profileId 从 SecretStore 回填。单测断言 localStorage 不含探针、profileId 保留。
  - **高 2｜CLI 编译失败**（`bin/rssh/commands/add.rs` Profile 字面量缺 `telnet_username`/`telnet_charset`，默认 `cargo check` 不编译 `--features cli`）：已修；门禁补 `cargo check --features cli --bin rssh`。
  - **中 3｜headless/CLI 缺接线**：`server.rs` 补 `profile_telnet_password_get/set` 分派；headless `delete_profile` 与 CLI `rssh profile rm` 同步清理 `totp:<id>` / `proxy:<id>` / `telnet:<id>:password`，不再留孤儿密文。
  - **中 4｜编辑时读密码失败会误删**：`composerTelnetSecretRef` 改三态（`null`=读取失败），保存时空口令 + 三态 `null/true` 一律跳过写入；仅确认无密码（`false`）才删除。
  - **中 5｜跨协议密码误用**：协议下拉切换一律清空 `password`，避免 Telnet 口另写成 SSH 凭据 secret。
  - **中 6｜Telnet 编码改动不持久**：`TerminalPane` 统一 `encodingProfileId`（SSH=profileId，Telnet=session.profileId），编码选择与主机偏好写同一 key，下次连接不再回退。
  - **低 7/8｜** 密码回取失败仍按空密码尝试自动登录（仅日志层面）、复制/导入 Telnet 主机不带密码：记录不改，属产品口径，导入后需手动填写。
  - **低 9｜** `db/proxy_profile.rs` UTF-8 BOM 已移除。
- 门禁：`npm run test:run` 746 通过、`npm run build` 通过、`cargo test --lib` 943 通过、`cargo check --features cli --bin rssh` 通过。
- **未实测**：恢复工作区时密码回填的真实重连（需重启桌面端 + SecretStore 有值）仅单测与静态确认。

## 2026-11-06 — #204 Telnet 纳入主机协议（保留独立 Telnet 入口）

- 数据层：`profiles.protocol` 白名单扩展为 `ssh` / `local` / `serial` / `telnet`（未知值报 `profile_protocol_invalid`，避免拼写错误静默按 SSH 连接）；新增可空列 `telnet_username` / `telnet_charset`（schema v48，`column_exists` 幂等，老库只加列不写默认值 → 原 SSH 主机行为不变）。
  - 字段对齐 Netcatty Host：`telnetPort` 因 termX 协议互斥而复用 `profiles.port`（默认 23）；`telnetUsername` → `telnet_username`；`charset` → `telnet_charset`；`telnetIdentityId` 未引入（termX 无 Telnet 身份库，密码走 SecretStore）；`terminalTheme` 未引入（termX 无主机级主题）。
  - 密码只存 SecretStore `telnet:<id>:password`，删除主机时同步清理；表 / 导入导出均不含密码。
  - CRUD：SELECT / INSERT / UPSERT / UPDATE 参数补齐；Telnet 主机豁免「必须绑定 SSH 凭据」校验（`validate_for_write`）。
  - 导入导出白名单：`protocol: "telnet"` 与 `telnet_username` / `telnet_charset` 保留，未知 protocol 回落 `ssh`；Telnet 导入不创建 SSH 凭据。
- 主机弹窗：地址分区新增「协议」下拉（SSH / Telnet），切 Telnet 时端口 22↔23、清空凭据 / MFA；隐藏 SSH 专属分区（登录方式 / MFA / Agent 转发 / 输入兼容 / 密钥证书选择器 / TOTP / 主机密钥策略 / SFTP / 代理 / 环境变量 / 启动命令 / 高级字段），显示「登录用户名」「密码 + 保存密码」；字符集分区对两者共用（Telnet 写入库）。
- 连接路径：新增 `src/domain/hostProtocol.ts` 纯函数 `hostProtocolOf` / `telnetSessionFromProfile`；`App.connect()` 对 Telnet 档案派生 `Connector.kind = "telnet"`，按需从 SecretStore 取密码后走现有 telnet 后端（卡片 / 右键 / 快速切换器共用同一入口）。会话字符集经 `TelnetSessionConfig.encoding` 注入 TerminalPane。
- 标签 / 工具栏 / 右键：标签图标为 amber Terminal（对齐 Netcatty `protocolVisuals` 的 telnet 视觉）；既有 `toolbarCapabilities` 对 telnet 关闭 SFTP / 系统监控；右键菜单无「打开 SFTP」。主机卡片为 amber Terminal 头像 + 「Telnet · 用户名 · host:port」副标题。
- 会话日志 / 录制 / 自动补全：均基于 `sid` 与前端缓冲，Telnet 会话同样生效（工具栏保留日志 / 录制入口）。
- 测试：`hostProtocol` 6 例（老数据回落 / 端口 23 / 字符集 / 无用户名丢弃密码）、`vaultTransfer` Telnet 导入 2 例、DB roundtrip 与未知协议拒绝、schema v48 迁移幂等；`npm run test:run` 744 用例、`cargo test --lib` 943 用例、`npm run build`、`tauri build --debug` 通过。
- 实机验证：本地 `evidence/telnet-echo-server.mjs`（127.0.0.1:2324，含 IAC 协商）→ 新建 Telnet 主机（admin/termx）→ 卡片连接成功，服务端 banner / 自动登录 / `hello telnet` 回显均正常。
- **未实测**：快速切换器 / 右键「连接」的端到端点击（与卡片共用 `onConnect`，静态确认）；Telnet 主机「测试连接」按设计禁用（后端仅有 SSH 测试命令）；导入 Telnet 主机不含密码，导入后需手动登录或重新填写。

## 2026-11-06 — #203 设置行改为 48px 条状底色 + 边框（对齐 Netcatty 设置页）

- 对齐 Netcatty `HostDetailsSection` 的 `host-input-row`（`h-12 rounded-lg border bg-secondary/40 px-3`）：
  - `.nc-set-row`：`min-height: 48px`、左右内边距 12px、1px `--border` 边框、8px 圆角、`--secondary/0.4` 条状底色；多行内容自动增高（不截断）。
  - `.nc-set-card` 不再自带边框 / 底色 / 内边距，改为 6px 间距的纵向容器，避免与行条边框形成双层框。
  - 相邻行使用 6px 间隔 + 各自边框；`--secondary` / `--border` 均为主题变量，明暗两套自动一致。
- 覆盖：8 个设置 tab（终端 / 外观 / 同步与云 / 安全 / 高级 / 快捷键 / 关于 / 其他）共用 `SettingRow`，一处样式全局生效。
- 窄窗 720px：行保持 48px 最小高度，内容由 `flex-wrap` 换行，左右 12px 内边距不产生横向溢出（截图见 evidence/audit9-*）。

## 2026-11-06 — #202 主机级 known-host 校验策略（profile.host_key_policy）

- 数据层：`profiles` 新增可空列 `host_key_policy TEXT`（schema v47，迁移幂等 `column_exists` 守卫）；NULL = 跟随全局 `verifyHostKeys`，老库升级只加列不写默认值，既有主机行为不变。
- 后端模型 / CRUD 全链路补齐：`Profile.host_key_policy`、`db::profile` SELECT/INSERT/UPSERT/UPDATE 参数；更新语义为直接写值（清回「跟随全局」时必须能把列置 NULL，未用 `COALESCE`）。
- 连接覆盖：`DialCtx` / `SshHandler` 携带主机策略，`check_server_key` 优先取主机值（`verify` / `skip`），未设置才回落全局；堡垒逐跳、独立 SFTP（含 CLI / server 各入口）均传入所属档案策略。
- 主机弹窗「端口与凭据」分区新增「主机密钥校验」一行：右侧当前值 +「设置…」，展开三项（跟随全局 / 始终校验 / 跳过校验），默认「跟随全局」并附注全局当前状态；纯前端模型 `src/domain/hostKeyPolicy.ts` 负责 Profile 值与枚举互转。
- 测试：迁移 v47（老行 NULL + 重复执行）、DB roundtrip / 清空、策略解析单测、前端 model 4 例；`cargo test --lib` 939、`npm run test:run` 735 通过。
- **未实测**：真实「已知主机密钥变化 → 主机策略 skip 仍连接 / verify 拒绝」的端到端会话（需要可变的 SSH 服务端 host key），当前只覆盖解析与取舍路径。

## 2026-11-06 — #201 放开证书认证保存链路（ComposerDraft → CredentialType::Certificate）

- `persistComposerDraft` 删除 `auth_method === "certificate"` 的硬拒；`effectiveCredType()` 映射证书 → `CredentialType::Certificate`，`authMethodOfCredential()` 反向映射（编辑既有证书主机可回显）。
- 证书凭据来源沿用钥匙串：选择器列出 `Credential.type = certificate` 的已有条目；另枚举 `~/.ssh` 下带私钥的 `*-cert.pub`，点击走既有 `keychainImportCertificateCredential`（后端 `is_plain_file_name` 单层文件名校验，路径逃逸防护复用，不新增读文件命令）。
- 保存校验：证书认证必须绑定一个类型为 `certificate` 的凭据，否则报「请选择证书凭据」，避免把密钥 / 密码凭据误改成证书类型。
- SecretStore 安全：前端不做 `getCredential` 拉取证书私钥材料（编辑回显与绑定均跳过），密钥 / 证书文本只在后端钥匙串导入链路读写；`update_credential` 对证书类型**跳过** `save_credential_secrets`（否则序列化回来的 `secret=None` 会按「None=删除」清掉已导入私钥）；`delete_credential` 同步清 `cert:<id>:cert`，避免孤儿密文。
- 登录方式下拉切到「证书」时自动清空非证书身份并展开证书选择器；证书与「优先交互式认证（MFA）/内联密码」互斥（该行在证书态隐藏）。
- 测试：新增 `save_credential_secrets_to` 单测（证书 None 保留私钥 / 普通凭据 None 仍删除）；`npm run test:run` 66 文件 / 735 用例、`cargo test --lib` 939 用例通过。
- **未实测**：真实证书认证连接（无 CA 服务器 / OpenSSH 证书环境），连接分支仅按 `ssh/auth.rs` 既有 `CredentialType::Certificate` 路径静态确认。

## 2026-11-06 — #200 主机弹窗默认宽度固定 420（忽略本地记忆值）

对齐 #192 差异清单第 10 条：
- `readPanelWidth()` 直接返回 420，不再从 `localStorage['termx.vault.hostpanel.v1']` 读取（旧记忆值 380 曾覆盖默认宽度）。
- 移除 `panelWidth` 的持久化 effect 与 `HOST_PANEL_W_KEY` 常量；面板宽度每次打开回到 420。
- 拖拽调宽仍可用（本次会话内生效），最小宽度核对：`HOST_PANEL_MIN = 320`，与 Netcatty `aside-panel.tsx` 的 `MIN_ASIDE_INLINE_WIDTH_PX = 320` 一致；320px 下 108px 标签 + 8px 圆角输入仍能排布，不会横向溢出。

## 2026-11-06 — #199 验证器改一行式并合入「端口与凭据」分区

对齐 #192 差异清单第 9 条：
- 「验证器 (TOTP)」从独立分区改为「端口与凭据」分区末行（Netcatty 的 `HostTotpFields` 就在该分区内），右侧沿用既有入口：未配置时「设置…」，已配置时「编辑 / 移除」。
- `设置…` 落点说明：termX 的 TOTP 密钥对话框（`openTotpDialog`）。原需求括注「跳转现有已知主机设置」无法落实——termX 没有主机级 known-host 验证策略字段，也没有可跳转的验证设置页（严格主机密钥校验目前是全局行为），要做需要新增数据字段，超出「只改呈现」的范围。
- 安全提示长句改为 ⓘ tooltip。

## 2026-11-06 — #198 主机弹窗说明文案改 ⓘ tooltip

对齐 #192 差异清单第 8 条：新增 `HostHint`（`ⓘ` + `title`），替换全部常驻说明段落：
登录方式、优先交互式认证（MFA）、转发 Agent、输入兼容模式、TOTP 安全提示、字符集 / 终端编码、代理来源、不使用代理、环境变量、启动命令、高级字段逐项原因（合并成多行 `title`）。
单独保留的仍是**动态状态提示**（Agent 未运行警告、环境变量计数、分组级代理「未移植」标记），这些不是静态文档段落。
样式新增 `.host-hint`（12px、`cursor: help`、hover 提亮）。

## 2026-11-06 — #197 主机弹窗密码区：保存密码开关 + 密钥 / 证书 / 本地密钥入口

对齐 #192 差异清单第 7 条：
- 「保存密码」开关：确认既有实现即 Netcatty 行为（仅当密码框有内容或已存在掩码口令时出现在密码下方，关掉即保存 `secret=null` 删除已存口令），本轮未改逻辑。
- 「+ 密钥 / 证书 / 本地密钥」菜单：**密钥**（选 `Credential.type=key`）与**本地密钥文件**（`~/.ssh` 文件列表）接现有数据可用；**证书置灰**并在行尾标「未支持」、`title` 写明原因——后端 `ssh/auth.rs` 虽有 `CredentialType::Certificate` 分支，但 `persistComposerDraft`（`VaultView.tsx`）在 `auth_method === "certificate"` 时直接报错返回，属于保存链路未开放；按要求不动保存逻辑，故只置灰。
- 新增 `.host-cred-menu button.is-disabled` / `.host-cred-menu-reason` 样式。

## 2026-11-06 — #196 主机弹窗「通用」分组 / 标签补图标与清除

对齐 #192 差异清单第 6 条：
- 分组行：左侧 40px 圆角图标方块（folder 图标）+ 下拉，已选分组时右侧出现 X 清除（点一下回到「未分组」）。
- 标签行：左侧 40px 圆角图标方块（tag 图标）+ 输入框，非空时右侧出现 X 清除。
- 新增 `.host-icon-row` / `.host-icon-box` 样式；图标方块 40×40、圆角 8、`--secondary/0.8` 底，与 Netcatty `h-10 w-10 rounded-lg bg-secondary/80` 一致。
- 分组仍用原生 `<select>`（termX 分组为 `Group` 表 id，不支持 Netcatty 的 Combobox 自由创建分组路径），数据写入未变。

## 2026-11-06 — #195 主机弹窗分区顺序：补「SFTP 设置」+ 代理归位

对齐 #192 差异清单第 5 条，只改 `src/VaultView.tsx` 的 composer 呈现，字段沿用既有 `ComposerDraft`（保存逻辑未动）：
- 新增「SFTP 设置」分区（Netcatty `HostDetailsSection sftp` 的三项）：文件协议（自动 / SFTP / SCP，切到 SCP 时按 Netcatty 规则清空 sudo）、sudo 模式开关（协议为 SCP 时禁用）、文件名编码（自动 / UTF-8 / GB18030）。三项原本已在 draft / 落库链路中，只是此前未暴露。
- 分区顺序按 Netcatty：通用 → 地址 → 端口与凭据 → SFTP 设置 → 字符集 / 终端编码 → 代理 → 环境变量 → 启动命令 → 高级字段（置灰）。代理从「端口与凭据」之后移到高级分组（Netcatty 中代理在跳板机之后、环境变量之前）。

## 2026-11-06 — #194 主机弹窗底色 / 圆角 / 输入高度（对齐 Netcatty HostDetailsPanel）

对齐 #192 差异清单第 2–4 条，只改 `src/styles.css`，数据层与保存逻辑未动：
- 卡片底色方向反转：`.host-details-section` 由半透明灰 `hsl(var(--muted)/0.35)` 改为 `hsl(var(--card))`（浅色主题 = 白卡 + 浅灰页底；暗色主题 `--card` 比 `--background` 亮，自动反过来），补 1px `--border/0.8` 边框与 `shadow-sm` 级阴影。
- 圆角：卡片 10 → 12；输入 / 下拉 6 → 8；文本域 6 → 8；保存按钮 `.host-save-full` 6 → 8。
- 输入高度：`.vault-composer-body input/select` 36 → 40，左右内边距 10 → 12；本地终端 Shell 组合框 `.lsh-combo-input` 同步 36 → 40（内层 input 34 → 38）。
- 输入底色由 `--secondary`（较深灰）改为 `--background`：在白色卡片上呈现为浅灰底，与 Netcatty `Input`（`bg-background`）一致。

## 2026-11-06 — #193 日志表格行改回单行（用户偏好优先）

- 用户明确要求：日志表格保留 #190 的整页表格结构与列（会话/主机、时间、时长、大小、操作）、排序、行操作、导出，但行内合成一行显示。
- 改动只落在 `src/sessionLogs/sessionLogs.css`：行高 56 → 48px；头像 36 → 30px（圆角 8）；「主机名 + 副标题」与「日期 + 时间」两个单元格由纵向堆叠改为横向单行（各自 `flex-direction: row`，主名 `max-width: 60%` 截断，副标题填满剩余）。
- **取舍**：Netcatty `ConnectionLogsManager` 是两行行样式；此处按用户偏好优先于 Netcatty，**下一轮不得反向改回两行**（本章节为记录锚点）。
- 组件与数据层未改，仅 CSS。

## 2026-11-06 — #192 调研：设置窗口形态 + 主机弹窗像素对照（无代码）

### 设置窗口形态
- Netcatty：独立原生窗口（Electron `BrowserWindow`）。`electron/bridges/windowManager/settingsWindow.cjs` 定义 980×720、min 820×600、`modal:false` 且不设 parent、Windows 自绘无边框，按主窗口所在显示器居中；独立路由 `#/settings`；启动时隐藏预热，关闭改为 hide 复用。
- termX：应用内全屏 overlay（`SettingsDialog.tsx` + `.nc-settings-overlay { position: fixed; inset: 0 }`），无独立 OS 窗口、无独立路由。
- 结论：形态差异真实存在，但 termX 为单窗口 WebView2 模型，改独立 Tauri `WebviewWindow` 需新增窗口路由、设置跨窗口同步与关闭 / 复用生命周期；当前 overlay 不影响功能与信息架构。本轮不动机；建议 P3 单独立项（980×720 / min 820×600 / `#settings` 路由 / 共享 `set_setting` 事件），需重做入口与生命周期。

### 主机新建 / 编辑弹窗像素对照（termX SSH 主机详情 vs Netcatty HostDetailsPanel）
证据：`evidence/audit7-nc-host-editor.png`（Netcatty 实机）、`audit7-termx-host-editor-ssh2-after.png`（termX 1200×800）、`audit7-termx-host-editor-after.json`（几何量）。

相同：右侧 aside 形态、56px 页头、左标题「主机详情」+ 右 3 个图标按钮（测试 / 保存 / 关闭）、16px 内容边距、12px 卡片间距、卡片 12px 内边距、12px 分区标题（图标 + 600 字重）、底部通栏主色保存按钮（40px 高）。

差异清单：
1. 面板宽度：Netcatty 源码 `w-[420px]`；termX 默认 420px、当前记忆值 380px（可拖拽）——默认一致，截图差异来自本地记忆宽度。
2. 卡片底色：Netcatty 白卡 + 1px 边框（页面浅灰底）；termX `rgba(225,228,234,.35)` 半透明灰卡 + 0.8px 边框——对比方向相反（termX 卡片比页面深，Netcatty 卡片比页面白）。
3. 圆角：Netcatty 卡片约 12px / 输入 8px / 保存按钮 8px；termX 卡片 10px / 输入 6px / 保存按钮 6px。
4. 输入高度：Netcatty 约 40px；termX 36px。
5. 分区顺序：Netcatty 通用 → 地址 → 端口与凭据 → SFTP 设置 → … → 代理；termX 通用 → 地址 → 端口与凭据 → 代理 → 验证器 → 字符集 / 终端编码 → 环境变量 → 启动命令 → 高级字段（置灰）。termX 缺 SFTP 设置分区，代理提前。
6. 字段装饰：Netcatty 分组行有文件夹图标 + 下拉 + X 清除，标签行有标签图标；termX 无图标、无清除。
7. 密码区：Netcatty 用户名 + 密码 + 眼睛 +「保存密码」开关 +「+ 密钥 / 证书 / 本地密钥」；termX 未见「保存密码」开关与密钥 / 证书入口。
8. 说明文案：Netcatty 用 ⓘ tooltip（登录方式 / 优先交互式认证 / 验证器）；termX 把这些说明常驻成段落，面板更啰嗦、纵向更长。
9. 验证器：Netcatty 是「验证器 (TOTP)」一行 + 右侧「设置...」；termX 是独立分区。
10. 保存按钮：两边贴底通栏；termX 40px 高 / `rgb(0,136,255)` / 13px 字，仅圆角比 Netcatty 小 2px。

不修改理由：涉及字段增删（密钥入口 / 保存密码）与分区重排，超出本轮 P2 视觉范围；建议下一轮单独立项「主机弹窗对齐」：先补 SFTP 设置分区与密码区，再统一圆角 / 输入高度 / 卡片底色。

## 2026-11-06 — #191 代理页按钮层级 + SFTP 空态图标（第七轮 P2 · P2 重启第 3/3）

> 取证：Netcatty `components/ProxyProfilesManager.tsx` 页头「添加代理」是 `variant=secondary`（灰底），空态里同一动作是默认 primary（蓝底）；区块头为左「代理」+ 右「N 项」；空态是 64px Globe 图标块 + 标题 + 说明 + primary 按钮。SFTP `components/sftp/SftpPaneEmptyState.tsx`：左栏 Monitor、右栏 HardDrive（不是文件夹），56px rounded-xl 图标块。

- `src/ProxyProfilesView.tsx`：
  - 区块头由「已保存的代理（N）」改为 Netcatty 的「代理」（左）+「N 项」（右）。
  - 页头「新建代理」保持 secondary（Netcatty 页头同款），补 Plus 图标；空态补 64px Globe 图标块 + 标题 + 说明 + **primary「新建代理」**，与 Netcatty 的 primary / secondary 层级一致。
  - 按钮基样式补 `inline-flex`，图标与文字基线对齐；新建 / 保存 / 删除等现有行为不变。
- `src/sftp/SftpPaneEmptyState.tsx`：右栏空态图标 `server` → `hard-drive`（Netcatty 同款 HardDrive）；左栏保持 Monitor。
- 取证修正：todo 原记「Netcatty 文件夹图标」不准确 —— 源码为 HardDrive，实测截图一致，已更正。
- 证据：`evidence/audit7-termx-proxy-empty-after.png`（「代理」+「0 项」、Globe 空态、primary 新建代理）、`audit7-termx-proxy-list-after.png`（默认列表「代理 / 1 项」、页头 secondary 新建代理）、`audit7-termx-sftp-empty-after.png`（左 Monitor / 右 HardDrive）、`audit7-termx-proxy-sftp-after.json`（空态按钮背景 `rgb(0,136,255)` = primary，页头 `rgb(225,228,234)` = secondary）。
- 门禁：`npm run test:run` 65 文件 / 731 用例 ✓；`npm run build` ✓；`npm run tauri -- build --debug` ✓。

## 2026-11-06 — #190 日志页表格化（第七轮 P2 · P2 重启第 2/3）

> 取证：Netcatty `components/ConnectionLogsManager.tsx` 是整页表格 —— 表头 32px、行 `px-4 py-3`（56px，含 36px 头像）、`hover:bg-secondary/60`、行底 1px 分隔、行操作 hover 出现；点击整行打开独立 LogView 页（`components/LogView.tsx`），不是左列表 + 右详情。

- `src/sessionLogs/SessionLogsView.tsx`：
  - 移除 300px 左栏列表 + 右侧常驻详情；改为整页表格，列「会话/主机 | 时间 | 时长 | 大小 | 操作」，行高 56px、hover 高亮、行底分隔线、36px 圆角图标（对齐 Netcatty 的 row 形态）。
  - 表头四个排序列可点击升降序（会话名 / 时间 / 时长 / 大小，默认时间倒序），带 ↕ / ↑ / ↓ 指示。
  - 行操作：导出（常驻，默认格式）与删除（hover 出现，对齐 Netcatty 的 group-hover 删除）；点击行进入整页详情（保留彩色 / 原文、字号、三格式导出、删除、统计）。
  - 页头保留搜索、主机筛选、刷新与条数；空态改为居中 64px 图标 + 标题 + 说明（对齐 Netcatty logs 空态）。
- `src/sessionLogs/sessionLogsModel.ts`：新增 `sortSessionLogsBy(logs, key, direction)`，`sortSessionLogs` 复用默认「时间倒序」；新增单测覆盖四列升降序与入参不变。
- `src/sessionLogs/sessionLogs.css`：删除左栏 / 列表项样式，新增页头、表格网格（`minmax(0,1.6fr) 140px 84px 84px 88px`）、行 hover、排序箭头、行操作、居中空态、详情返回按钮。
- 与既有结论的取舍：#183 的「删格式筛选、日志项两行」针对左侧窄栏列表；Netcatty 实机 + 源码确认日志页本体是整页表格，行内「用户 / 主机」本来就是两行（名称 + 副标题），因此恢复两行单元格并升级为表格是向 Netcatty 靠拢；格式筛选仍保持删除（副标题只显示 `asciicast · N 事件`，不再做筛选器）。
- 证据：`evidence/audit7-termx-logs-table-after.png`（128 行、列宽 `483.2px 140px 84px 84px 88px`、行高 56px、无旧左栏）、`audit7-termx-logs-viewer-after.png`（整页详情 + 返回 + 导出 + 统计）、`audit7-termx-logs-table-after.json`（按时长排序后序列 25m 38s → 12m 07s → 9m 33s…）。
- 门禁：`npm run test:run` 65 文件 / 731 用例 ✓；`npm run build` ✓；`npm run tauri -- build --debug` ✓。

## 2026-11-06 — #189 监控页面板化（第七轮 P2 · P2 重启第 1/3）

> 取证：Netcatty `components/vault/MonitorPanels.tsx` 是面板式页头 + 居中空态（图标 + 标题 + 说明 + 主按钮）；运行时每台主机一张指标卡（CPU/内存 + 趋势、磁盘、网络）。termX 原本是「主机勾选控制台 + 开始监控」两段式。

- `src/monitor/MonitorView.tsx`：
  - 删除主机勾选控制台（搜索框、`selected` 集合、勾选卡片、`toggleSelected`）；「开始监控 / 停止」直接作用于全部已保存 SSH 主机。
  - 未开始时改为居中空态（图标 + 「一眼查看多台主机」+ 采样说明 + 主按钮「开始监控」）；没有 SSH 主机时居中空态提示本地 / 串口 / Telnet 不支持采集。
  - 运行后直接渲染全部主机面板卡（图表视图）或整表（列表视图）；指标项、每台独立 SSH 会话、`interval` 定时采样、失败退避重试、断线重连逻辑保持不变。
- `src/styles.css`：新增 `.monitor-empty` / `.monitor-empty-icon` / `.monitor-empty-btn`（对齐 Netcatty 空态：64px 图标块 + 15px 标题 + 12px 说明）。
- 取舍：Netcatty 的「监控面板」是用户自建面板模型（命名、主机集合、拖拽排序、多面板切换）；termX 后端无 `monitor_panels` 表，本轮用「全部 SSH 主机 = 一个隐式面板」，不新增持久化模型，面板管理单独立项。
- 证据：`evidence/audit7-termx-monitor-panel-before.png`（空态、无勾选控制台）、`audit7-termx-monitor-panel-running.png`（1 台主机指标卡：CPU 1.3% / 内存 36.9% / 磁盘 93.8% / ↓1.7 KB/s，2 条趋势曲线）、`audit7-termx-monitor-panel.json`。
- 门禁：`npm run test:run` 65 文件 / 730 用例 ✓；`npm run build` ✓；`npm run tauri -- build --debug` ✓。

## 2026-11-06 — #188 钥匙串页单页分区（第七轮 P2 · 4/4）

> 取证：Netcatty `components/KeychainManager.tsx` 是**单页分区**（不是 tab）：顶部动作「新建密钥 / 生成密钥 / 导入证书 / 新建身份」，下方「密钥」「身份」两个 section 同页展示。termX 原本是「系统密钥 / 已存密钥」子 tab。

- `VaultView.tsx`：删除 `kcTab` 状态与 `.kc-subtabs` 切换条；`activeNav === "keys"` 改为单页 `<div className="kc-tabbed kc-single-page">`，顺序为「已存密钥（凭据库，即 Netcatty 密钥 section 的对应物）」→「系统密钥 / SSH Agent / 证书（termX 额外能力）」。
- `keychain/keychain.css`：新增 `.kc-single-page`（整页滚动、20px 分区间距、系统密钥区顶部 1px 分隔线），删除已无引用的 `.kc-subtabs` 样式。
- 数据层未改动：凭据库、`~/.ssh` 扫描、SSH Agent、证书相关 API/状态全部复用。
- 证据：`evidence/audit7-termx-keychain-single-page-after.png`、`audit7-termx-keychain-single-page-after.json`（无 `.kc-subtabs`；`.kc-single-page` 同时包含 `.vault-keychain` 与 `.kc-file-pane`）。
- 门禁：`npm run test:run`、`npm run build`、tauri debug 通过。

## 2026-11-06 — #187 本地终端：侧栏默认收起 + 标题显示 Shell 名（第七轮 P2 · 3/4）

> 取证：Netcatty `terminalHostTreeStore.ts` 的 `isOpen` 是全局持久化开关，默认 `false` → 终端全宽；不是“本地会话专属自动隐藏”。Netcatty 本地会话标签/标题行显示 Shell 名（截图 `Git Bash`）。

- `App.tsx`：
  - `sideOpen` 默认改为 `false`（`termx.sidebar.v1` 缺省 = 收起），与 Netcatty 默认一致；已有用户持久化值不变。
  - 移除 `connect()` / `openLocal()` 里的 `setSideOpen(true)`：连接主机不再强制展开侧栏，尊重用户的开关状态。
  - `openLocal()` 给 pty 会话带 `name`：配置 shell → 发现列表中文名；未配置 → `shellDisplayName(await defaultShell())`（本机为 `CMD`）。
- 修复既有缺陷：`VaultView.tsx` 两处 `onClick={onLocal}` 会把 React 点击事件当作 `DiscoveredShell` 参数传入，导致本地终端始终拿不到 `shell`/`name`（标题恒为「本地终端 N」）。改为 `onClick={() => onLocal()}`。
- 证据：`evidence/audit7-termx-local-title-after.png`（无侧栏、终端全宽、标签与标题行「CMD」）、`audit7-termx-local-title-after.json`（fresh：sidebar null / stored "0"；after：tabTitles ["CMD"] / connector `{kind:"pty",name:"CMD"}` / 视口 1200×800）。
- 门禁：`npm run test:run`、`npm run build`、tauri debug 通过。

## 2026-11-06 — #186 SSH 终端侧栏宽度与时间戳列核对（第七轮 P2 · 2/4）

> 结论：两项均已与 Netcatty 一致，无需改代码（记录核对过程供后续查证）。

- 侧栏宽度：Netcatty `application/state/terminalHostTreeStore.ts` 默认 220（min 176 / max 360）；termX `.nc-sidebar` 有效值为 220（`styles.css` 前置 `:root` 的 264 被后置 `:root` 的 220 覆盖）。CDP 实测 `sidebarWidth=220`。任务里的「170px」来自 1024 宽缩放截图的测量误差（220 × 1024/1200 ≈ 188）。
- 时间戳列：已实现（`terminal/terminalTimestamps.ts` → `.terminal-timestamp-gutter`，`min 56px` + 文本宽度 + 16，实测 81px），与 Netcatty `resolveTerminalTimestampGutterWidth` 同公式；位于终端内部，不受侧栏宽度影响。
- 证据：`evidence/audit7-termx-ssh-sidebar-after.png`（侧栏 + 时间戳同屏）、`audit7-termx-ssh-sidebar-after.json`（sidebarWidth 220 / timestampGutter 81 / viewport 1200×800）。

## 2026-11-06 — #185 Vault 导航结构对齐（第七轮 P2 · 1/4）

> 目标：把 Vault 首页导航入口结构对齐 Netcatty，只改呈现，不动数据层。

- 取证（Netcatty 源码 + 截图）：
  - `VaultViewLayout.tsx` 侧栏导航 8 页：主机 / 钥匙串 / 代理 / 端口转发 / 脚本 / 笔记 / 已知主机 / 日志；`MonitorNavButton` 作为第 9 个按钮插入；`mt-auto pb-4` 区域放「设置」ghost 按钮（`onOpenSettings`）。
  - `TopTabs.tsx` 顶栏齿轮同样保留设置入口 → Netcatty 两处入口都在，不是“只有侧栏底部”。
  - `zh-CN/core.ts` 导航键无 `vault.nav.sync`：同步不是独立导航页，入口在设置中心「同步与云」。
  - 最近连接列数无差异：`vaultHostGridLayout.ts` = gap 12 / min 220 / max 4 列，termX `.vault-grid` 公式一致；截图中的 3 vs 4 张是数据条数差异。
  - Telnet：Netcatty 无顶层入口，是主机的协议向导（`telnetEnabled`）；termX `Profile.protocol` 只有 ssh/local/serial，没有 telnet 字段 → 合并需后端模型变更，超出“呈现对齐”，保留独立入口并记 todo。
- 改动：
  - `VaultView.tsx`：`navItems` 移除「同步」（`activeNav === "sync"` 渲染分支保留，设置中心「打开同步页」仍可用）；侧栏底部新增「设置」导航按钮（40px，展开显示图标+文字，折叠仅图标），移除与 Netcatty 源码矛盾的旧注释；`Settings` 图标替换 `Cloud`。
  - `App.tsx`：给 `<VaultView>` 注入 `onOpenSettings`（打开设置中心「应用」tab）。
- 证据：`evidence/audit7-termx-vault-nav-after.png`（9 项导航 + 底部设置）、`audit7-termx-vault-nav-settings-after.png`（点击打开设置）、`audit7-termx-nav-after.json`（navCount 9 / hasSyncNav false / 设置按钮 188×40 / 侧栏 208 / 视口 1200×800）。
- 门禁：`npm run test:run`、`npm run build` 通过。

## 2026-11-06 — #184 全应用逐功能比对（第七轮：差异清单 + P1 修复）

> 目标：摸清 termX 与 Netcatty 的可见差距，只修 P1（明显不一致或影响使用），其余记入 todo。未重构、未改动数据与持久化逻辑。

### 1. 逐页对照（debug 版 + 本机 Netcatty 实际界面）

| 页面 | Netcatty 实际 | termX 实际 | 等级 | 处理方式 |
|---|---|---|---|---|
| Vault 首页 | 导航 8 项 + 底部「设置」；顶部「新建主机」主色 + 下拉；最近连接卡片 248px、3 列 | 导航 9 项（多「同步」，无底部设置）；顶部多「Telnet」；最近连接 4 列、卡片较窄；另有「分组」「主机」两节 | P2 | 记 todo；分组与最近连接为数据模型差异 |
| 主机管理（列表） | 卡片 248×64、图标 44px 主色方块 | 同样式但卡片区无独立列宽基准 | P2 | 记 todo（弹窗未打开，本轮不做像素对照） |
| SSH 终端 | 侧栏 200px（工具图标行 + 笔记面板），时间戳列，工具栏图标 16px | 侧栏 170px 主机树，无笔记面板与时间戳列，工具栏 12px | P2 | 记 todo（需侧栏/笔记面板改造） |
| 本地终端 | 本地会话隐藏侧栏、终端全宽，第二行显示 Shell 名 | 侧栏保留、终端从 x≈180 开始，无 Shell 名标题行 | P2 | 记 todo |
| 串口 | 弹窗 407px，「保存配置」 | 弹窗 360px，「保存为主机」，端口框多一个原生下拉箭头 | P3 | 记 todo（COM1 环境阻塞，见 §4） |
| Telnet | 走主机协议向导，无独立「Telnet」入口 | 顶部独立「Telnet」入口 + 单步弹窗 | P2 | 记 todo（入口模型差异） |
| SFTP | 左右分栏 + 空态 | 几乎一致 | P3 | 空态图标不同（文件夹 vs 服务器），记 todo |
| 设置（各 tab） | 独立窗口 | 全屏 overlay | P3 | #181–183 已按源码对齐；窗口形态差异保留 |
| 钥匙串 | 单页：新建密钥/导入证书/新建身份 + 空态 | 「系统密钥 / 已存密钥」tab + SSH Agent + 系统 ~/.ssh 列表 | P2 | 记 todo（模型差异，需产品决策） |
| 监控 | 面板化：空态「一眼查看多台主机」+ 新建面板 | 勾选主机 + 频率/范围 + 开始监控的控制台 | P2 | 记 todo（需面板化改造） |
| 同步 | 无独立导航；同步在设置/云同步页 | 独立「同步」导航页 + 设置占位 tab | P2 | 记 todo（多出入口，非缺陷） |
| 代理 | 顶部「添加代理」主色按钮；区块「代理 0 项」居中空态 | 「新建代理」次色按钮；「已保存的代理 (1)」卡片 | P2/P3 | 记 todo |
| 端口转发 | 居中空态：56px 图标 + 标题 + 说明 | 虚线一行提示（页面顶部另有标题与计数） | **P1** | **已修**：改居中空态（见 §2） |
| 脚本 | 透明 56px 行 + 40px 图标方块；有「Shell 历史」 | 卡片行 + 分组卡片；无 Shell 历史，有「导出」 | P2 | 记 todo |
| 笔记 | 左栏 292px 列表；右栏标题 + 实时预览下拉 | 分组树 232px；行号编辑器 + 分屏 + 状态栏 | P2 | 记 todo（termX 为超集） |
| 已知主机 | 卡片 248px、3 列；图标 44px 主色方块 + 18px 白图标 | 卡片 4 列较窄；图标 18px 灰线、无底色 | **P1** | **已修**：图标方块 + 3 列（见 §2） |
| 日志 | 整页表格：日期/用户/主机/收藏 | 左栏列表 + 右侧详情主从布局 | P2 | 记 todo（需表格化改造） |

### 2. P1 修复（两项，各自独立小改）

1. 已知主机卡片（`styles.css`）
   - `.kh-card-icon`：18px 灰线图标 → 44×44、圆角 12、`--primary` 底、`--primary-foreground` 图标（对照 Netcatty `VaultEntityIcon`）。
   - `.kh-grid`：minmax 220 → 248，内容区恢复 3 列；`.kh-card-name` 13 → 14px。
   - 实测：图标 44×44/12px/亮色 `rgb(0,136,255)`、暗色 `rgb(56,189,255)`；网格 3 列；见 `evidence/audit7-termx-after.json`。
2. 端口转发空状态（`ForwardOverview.tsx` + `styles.css`）
   - 虚线一行提示 → 居中空态：56×56 圆角 12 `--muted` 底 + `zap` 24px + 标题 14/600「配置端口转发规则」+ 说明 12/1.6「保存端口转发规则，用于访问数据库、Web 应用等服务。」；搜索无结果复用同一空态。
   - 实测明暗两套均渲染，标题/说明/图标尺寸见 `evidence/audit7-termx-after.json`。
   - 新增 CSS：`.fwd-empty`（min-height 360 / 居中）、`.fwd-empty-icon/-title/-desc`。

### 3. 验证与证据

- Netcatty 实际界面（UIAutomation + PrintWindow）：`evidence/audit7-nc-{hosts,monitor,keychain,proxy,forward,scripts,notes,knownhosts,logs,sftp,terminal-ssh,terminal-local,serial-modal,settings}.png`。
- termX 逐页（CDP，修复前）：`evidence/audit7-termx-{hosts,monitor,sync,keychain,proxy,forward,scripts,notes,knownhosts,logs,sftp,terminal-ssh,terminal-local,serial-modal,telnet-modal,settings-*}.png`。
- P1 修复后：`evidence/audit7-termx-knownhosts-{light,dark}-after.png`、`evidence/audit7-termx-forward-{light,dark}-after.png` + `audit7-termx-after.json`。
- 门禁：`npm run test:run` 65 文件 / 730 用例通过；`npm run build` 通过；`tauri build --debug` 通过。
- 说明：截图顶部黄色「发现上次会话记录…」为重启后的会话恢复提示，与本次 UI 无关。

### 4. 阻塞与未验证

- 串口收发：termX 打开 COM1 串口标签无输出，本机无可用串口回环/设备（COM1 被占用/不可读写），未验证真实收发；仅完成弹窗视觉对照与标签创建。
- Netcatty 设置为独立窗口，PrintWindow 主窗口捕获不到；设置对照依据源码 + #181–183，未做像素级并排。
- 主机新建/编辑弹窗两边均未打开，未做弹窗像素对照。

## 2026-11-05 — #183 设置页 UI 重做（步骤③：占位 tab 空状态 + 窄窗复查）

> 收尾 #181/#182：三个占位 tab（SFTP 文件关联空态、AI、同步与云）统一为 Netcatty 居中空状态卡片，并复查 720px 窄窗。仍只改视觉，未动任何读写逻辑。

### 1. 对照抄取的结构与数值

| 区域 | Netcatty 依据 | termX 落地（`src/styles.css`） |
|---|---|---|
| 空状态容器 | 居中 `flex flex-col items-center justify-center`，卡片边框与圆角 | `.nc-set-empty-state`：min-height 320 / max-width 860 / padding 32×24 / 1px `--border` / 圆角 8 / `--card` 背景 / 纵向 gap 8 |
| 空状态图标 | 圆形柔底图标 | `.nc-set-empty-icon` 40px 圆形、`--muted/0.6` 底、`--muted-foreground` 图标、下距 4 |
| 空状态文案 | 标题 `text-sm font-semibold`，说明 `text-xs text-muted-foreground` | 标题 14/600；说明 12px、行高 1.6、最大宽 420；操作区上距 8 |
| 卡片内联空态 | muted italic 单行 | `.nc-set-empty-row` inline-flex / gap 6 / 12px / italic / `--muted-foreground`（SFTP 文件关联「暂无文件关联。」带 `file-type` 图标） |
| 同步空状态操作 | 主按钮 | `打开同步页` 用 `.nc-set-btn.is-primary`（36px 高、主色填充） |
| 窄窗（≤900px） | — | 导航 192px、内容 padding 20 |
| 窄窗（≤720px） | — | 导航 168px、内容 padding 16、tab 内边距 8、设置行改纵排且控件 100%、空状态 min-height 240 / padding 24×16、色板自动换行左对齐 |

### 2. 覆盖范围

- SFTP：文件关联空行（原纯文本）改为带图标的 `.nc-set-empty-row`。
- AI：`PlaceholderTab` 改为 `sparkles` 图标 + 标题 + 占位说明的居中空状态。
- 同步与云：`SyncTab` 改为 `cloud` 图标 + 说明 + 主按钮「打开同步页」的空状态（按钮行为原样）。
- 一致性复查：应用/系统/外观/终端/快捷键全部套用同一 `.nc-set-page`、分组标题、卡片、行分隔与控件尺寸。

### 3. 验证（debug + CDP）

- 截图（明暗各一）：SFTP 顶部 + 底部 `set-file-assocs-{light,dark}-after[-bottom].png`、AI `set-ai-{light,dark}-after.png`、同步 `set-sync-{light,dark}-after.png`；窄窗 720×820：`set-narrow-720-{system,shortcuts,appearance}-light.png`。
- 断言：三个占位 tab 空状态标题/说明/操作齐全、SFTP 内联空态存在；720 宽下 `contentScrollWidth == clientWidth`、`docScrollWidth == 720`、`overflowX=false`、`rowDirection=column`、`navWidth=168`，见 `evidence/settings-ui-step3.json`（全部 PASS）。
- 门禁：`npm run test:run` 65 文件 / 730 用例通过；`npm run build` 通过；`tauri build --debug` 通过。

### 4. 踩坑

- AI tab 在导航中为 `disabled`，CDP 点不开；截图时临时改为启用、截完立即还原 `disabled: true`（工作区无残留）。因此 AI 空状态截图来自临时启用版本，导航置灰态未改变。
- 旧版同步 tab 有改前截图（`set-sync-before-light.png` ← `p1-settings-sync-tab.png`）；SFTP / AI 此前没有可用改前截图，回执中如实标注为「无改前」。
- 空状态用 `max-width: 860px`（上限而非固定宽）而非 `width: 860px`，内容区收窄时自然跟随容器；720px 下仅需媒体查询把 min-height 降到 240、padding 收到 24×16，实测无横向滚动。

## 2026-11-05 — #181 设置页 UI 重做（步骤①：应用 + 系统 tab）

> 目标：以 `Netcatty/components/SettingsPage.tsx` + `components/settings/settings-ui.tsx` + `SettingsApplicationTab.tsx` + `tabs/SettingsSystemTab.tsx` 为准抄版面，落到 termX 现有 `styles.css` 令牌（不引入 Tailwind runtime），功能与持久化逻辑不变。本步只覆盖「应用」「系统」，外观/终端/快捷键与占位 tab 留 #182/#183。

### 1. 对照抄取的结构与数值

| 区域 | Netcatty 依据 | termX 落地（`src/styles.css`） |
|---|---|---|
| 外壳标题栏 | `text-lg font-semibold`，关闭按钮 `h-8 w-8`，hover `bg-destructive/20 text-destructive` | `.nc-settings-header` padding 12×16；标题 18px/600；关闭按钮 32×32 |
| 左侧导航 | `w-56 border-r px-3 py-3`，TabsList `gap-1`，Trigger `w-full h-9 px-3 gap-2 text-sm rounded-md`，active `bg-background text-foreground`，默认 muted | `.nc-settings-nav` 224px / padding 12 / gap 4；`.nc-settings-tab` 高 36 / 内边距 12 / 圆角 6 / 14px；`.is-active` 背景 `background`、文字 `foreground` |
| 搜索框 | `Input h-9 rounded-md border-input bg-background px-3 text-sm`，下方 `mb-3` | 36px / 圆角 6 / 边框 `--input` / 下间距 12 |
| 内容区 | `flex-1 bg-muted/10 p-6`，tab 内容 `space-y-6` | padding 24 / 背景 `muted/10`；新增 `.nc-set-page` 纵向 gap 24 |
| 分组 | `SectionHeader text-sm font-semibold mb-3` + `SettingCard rounded-lg border bg-card px-4` | `.nc-set-section` gap 8 + `.nc-set-section-title` 14px/600（去掉旧下划线）；`.nc-set-card` 圆角 8 / 1px 边框 / `--card` / 左右 16 |
| 设置行 | `flex justify-between py-3 gap-4`，标题 `text-sm font-medium`，说明 `text-xs text-muted-foreground mt-0.5` | `.nc-set-row` 上下 12 / 间距 16；标题 14px/500；说明 12px + 2px 上距；相邻行 `divide-y`（`border/0.6`） |
| 提示 | `text-xs text-muted-foreground mt-3` | `.nc-set-hint` 12px，`margin-top:4px` 与 section gap 8 合成 12px |
| 开关 | `h-5 w-9 border-2 border-transparent`，选中 `bg-primary`，拇指 `h-4 w-4 bg-background` `translate-x-4` | 36×20、2px 透明边框；拇指 16px；关闭态 `--input`、开启态 `--primary` |
| 下拉/输入 | `h-9 rounded-md border-input bg-background px-3 text-sm`，focus ring | 36px / 圆角 6 / 14px / 边框 `--input` / focus `--ring` 1px |
| 按钮 | `h-9 px-4 rounded-md text-sm font-medium`；secondary / outline / destructive | `.nc-set-btn` 36px / 内边距 16 / 圆角 6 / 14px；新增 `.is-secondary`、`.is-primary`、`.is-ghost`、`.is-danger`（outline + `--destructive` 文字 + hover `destructive/10`）、`.is-danger-solid` |
| 应用 tab | `lg:flex-row gap-14`，左栏 `w-[320px]`、Logo 64px，右栏 ActionRow `gap-3 px-3 py-3 rounded-lg hover:bg-muted/50`（图标 18px + 标题/副标题） | `.nc-set-app` 桌面 56px 间距、左栏 320px；`.nc-set-app-brand/-logo 64px/-name 24px`；`.nc-set-action-row` 12px 内边距 / 圆角 8 / hover `muted/50` |
| 危险操作 | outline + `text-destructive` + hover `bg-destructive/10` | 会话日志「清空」按钮改用 `.is-danger` |

### 2. 功能边界（只动视觉）

- 应用 tab 四个链接行仍执行原有「复制链接」，未改成 Netcatty 的打开浏览器（行为不变）。
- 检查更新 / 升级器、自动更新开关、系统 tab 所有未移植按钮仍禁用，文案与点击语义原样。
- 「下载并安装」由窄栏 Row 改为左栏状态块（同文案、同禁用态），避免 320px 栏内说明被压成窄条。
- 应用锁表单容器去掉硬编码浅色（`#f8f9fb`/`#e3e6ea`/`#c02424`），改 `--muted/--border/--destructive`，暗色可读。

### 3. 验证（debug + CDP）

- 断言：应用 tab `logo=true`、名称 `termX`、4 个 ActionRow；系统 tab 14 张卡片 / 26 行 / 14 个分组标题（软件更新→应用锁定），见 `evidence/settings-ui-step1.json`。
- 截图：`set-app-before-light.png`、`set-app-light-after.png`、`set-app-dark-after.png`、`set-system-before-light.png`、`set-system-light-after.png`、`set-system-dark-after.png`（改动前的暗色截图未归档，故只有浅色 before）。
- 门禁：`npm run test:run` 65 文件 / 730 用例；`npm run build` 通过；`tauri build --debug` 通过。

### 4. 踩坑

- Shell 工具内的 `Start-Process` 子进程会随命令结束被回收（9222 端口随即拒绝连接）；debug 应用必须以 `run_in_background` 方式直接 `& rssh.exe` 常驻，CDP 才能连续截图。
- 通用选择器 `.nc-settings-content > div` 会压过 `.nc-set-app` 的媒体查询（特异性 0,1,1 > 0,1,0），导致桌面双栏失效；改为给 tab 根节点显式 `.nc-set-page`。
- 卡片若加 `overflow:hidden` 会裁掉后续终端 tab 的候选下拉浮层，故只保留圆角不裁切。

## 2026-11-05 — #182 设置页 UI 重做（步骤②：外观 + 终端 + 快捷键）

> 延续 #181 的令牌与外壳，本步只重排这三个 tab 的版面与控件，不改任何读写逻辑。

### 1. 对照抄取的增量

| 区域 | Netcatty 依据 | termX 落地 |
|---|---|---|
| 外观分组 | 语言与 UI 字体同卡；透明度、模糊、主题、强调色、图标按 SectionHeader + Card | 语言 + 界面字体合并为一张卡；主题 + 浅/深色板 + 强调色合并为一张卡（原「语言/字体/主题/强调色」四个分组收敛为 2 张） |
| 窗口透明度 | `flex-col items-end gap-2`：`range w-28` + 数值 `w-10 text-sm tabular`，预设 `px-2.5 py-1 text-xs rounded-md border`，选中 `bg-primary` | `.nc-set-slider.is-stacked` 上滑杆 112px + 右对齐数值，下滑杆预设胶囊 28px 高；选中主色填充 |
| 主题色板 | 24px 圆点、选中 `ring-2 ring-offset-2 scale-110` | 色板由 flex-wrap 改 12 列 Grid（`repeat(12, 24px)`，右对齐），31 个预设整齐 12/12/7 |
| 应用图标 | 说明 `text-xs muted` 在卡片内顶部 | `.nc-set-icon-desc` 12px、卡片内顶部 12px |
| 终端滑杆 | `range w-24`（96px） | `.nc-set-slider` 基础宽 96px，`accent-color: primary` |
| 终端提示 | `SettingHint text-xs muted mt-3` 在卡片外 | 固定深色提示、内嵌图片休眠提示、侧边栏/本地 Shell 侧边栏未实现提示由占用整行的 `Row` 改为 `Section hint`（卡片外 12px） |
| 快捷键方案卡 | 方案 + 3 个开关同卡 | 原结构保留，仅套用新卡片与行 |
| 自定义快捷键头 | 标题 + 右侧 ghost `size=sm`「Reset All」 | `.nc-set-custom-head` + `.nc-set-btn.is-ghost.is-sm`（28px 高），删掉原先占一整行的「全部重置」Row |
| 快捷键分类 | `text-xs font-medium uppercase tracking-wide`，每个分类一张卡 | `.nc-set-cat-title` 12px/500/大写/0.05em + 每类 `.nc-set-section` + `.nc-set-card` |
| 快捷键行/键帽 | 行 `py-2`；键帽 `px-2 py-1 text-xs mono rounded border min-w-[80px]`；禁用/重置为 `size-6` 图标按钮 | `.nc-set-row.is-compact` 8px；`.nc-set-keycap` 28px/80px/12px mono；`.nc-set-icon-action` 26px；录制态主色边框 + 10% 底色 |
| 组合键特殊绑定 | `[1...9]`、`arrows` 拆成「修饰键 + + + 后缀徽标」 | 同等拆分（`modifierPrefix` + `.nc-set-keycap-suffix`），不再把整串塞进一个键帽 |

### 2. 功能边界

- 快捷键禁用/启用、单项重置、全部重置、录制流程全部沿用原 handler；仅把文字按钮换为图标按钮（`aria-label`/`title` 保留原语义）。
- 特殊绑定（`[1...9]`/`arrows`）按 Netcatty 隐藏禁用按钮，启用/禁用状态仍可通过原数据生效。
- 终端提示改为 `hint` 后仍按原条件显示（未跟随主题时、启用内嵌图片时、侧边栏未实现时）。
- 外观分组只搬动 JSX，设置项、默认值、更新函数未改。

### 3. 验证（debug + CDP）

- 断言：外观 6 卡 / 13 行 / 3 个预设胶囊 / 31 个色板；终端 11 卡 / 58 行 / 11 个分组；快捷键 6 卡（方案 1 + 分类 5）/ 36 个紧凑行 / 36 个键帽 / 70 个图标按钮 / 5 个分类小标题，见 `evidence/settings-ui-step2.json`。
- 截图：`set-appearance-before-light.png`、`set-appearance-light-after.png`、`set-appearance-dark-after.png`、`set-terminal-before-light.png`、`set-terminal-light-after.png`、`set-terminal-dark-after.png`、`set-shortcuts-light-after.png`、`set-shortcuts-dark-after.png`（快捷键改前截图未归档）。
- 门禁：`npm run test:run` 65 / 730；`npm run build`；`tauri build --debug`。

## 2026-11-05 — 剪贴板授权框 / 日志页右键 / 主机与终端右键菜单

### 1. 三处根因

| 问题 | 根因 | 处理 |
|---|---|---|
| 粘贴弹 `localhost:1420 想要 查看复制到剪贴板的文本和图像` | 前端直接调 `navigator.clipboard.readText()`（`TerminalPane.pasteFromClipboard` 右键/中键/工具栏路径，以及 `Terminal.tsx` 的 OSC 52 远端读剪贴板），WebView2 对受权限门控的读操作强制弹框 | 新增 [client.ts](src/backend/client.ts) `clipboardRead()` 走既有 Rust `clipboard_read`（arboard，已双注册），两处调用全部替换；写剪贴板继续用 `navigator.clipboard.writeText`（用户要求保留） |
| 日志页右键弹浏览器默认菜单 | 页面没有接管 `contextmenu`，WebView2 显示原生「返回 / 刷新 / 另存为 / 打印 / 检查」 | `SessionLogsView` 根节点显式 `preventDefault`（该页按用户要求不提供自定义菜单）；`App` 根容器再全局兜底 |
| 主机页 / 终端页右键菜单与 Netcatty 不一致 | ① 未被自定义菜单覆盖的区域（工具栏、侧栏、空白）走 WebView2 默认菜单；② 主机卡片菜单硬编码了 SSH 专属项（本地终端也显示「打开 SFTP / 复制主机地址 / 复制账密」）；③ 终端页左侧主机树完全没有右键菜单（Netcatty 主机树与主机卡片共用同一套菜单） | ① `App` 根容器捕获阶段 `preventDefault`（输入框放行，保留系统复制/粘贴菜单）；② 新增 [hostContextMenuModel.ts](src/hosts/hostContextMenuModel.ts) 按协议派生条目，主机卡片菜单改用它；③ `HostSidebar` 主机树右键打开同一模型派生的菜单（连接 / 编辑 / 复制地址） |

### 2. 四类型右键菜单矩阵（对照 Netcatty `HostTreeContextMenus.tsx`）

| 条目 | SSH 主机 | 本地终端 | 串口 | Telnet |
|---|---|---|---|---|
| 连接 | ✓ | ✓ | ✓ | ✓ |
| 打开 SFTP | ✓（termX 仍为禁用占位） | — | — | — |
| 编辑 | ✓ | ✓（本地面板） | ✓（串口面板） | ✓ |
| 复制（克隆） | ✓ | ✓ | ✓ | ✓ |
| 复制主机地址 | ✓ | — | ✓ | ✓ |
| 复制账密信息 | ✓ | — | ✓ | ✓ |
| 置顶 / 取消置顶 | ✓ | ✓ | ✓ | ✓ |
| 删除 | ✓ | ✓ | ✓ | ✓ |

> Telnet 在 termX 不是持久化主机档案（走连接弹窗的临时会话），矩阵中的 Telnet 列只用于模型单测；终端内右键菜单仍按能力（复制/粘贴/全选/片段/重连/分屏）提供，与主机类型无关。

### 3. 实测验证（debug + CDP，2026-05-11）

- 全局与主机页：`globalShellPrevented=true`，空白区域 `prevented=true` 且无菜单。
- 卡片菜单：`ctx-vault-ssh.png`（含 SFTP）、`ctx-vault-serial.png`（无 SFTP、保留复制地址）、`ctx-vault-local.png`（仅连接/编辑/复制/置顶/删除）；断言见 `verify-context-clipboard2.json`。
- 终端页主机树：`ctx-terminal-tree-ssh.png`，右键后点击「复制主机地址」菜单正常关闭、系统剪贴板变为 `192.168.126.129`（`verify-sidebar-menu.json`）。
- 终端内右键：`ctx-terminal-pane-local.png`；点击「粘贴」后 `navigator.clipboard.readText` 调用计数为 0，`TERMX-CLIP-PROBE-2026` 原样出现在本地终端且未自动回车（`paste-local-no-permission.png`、`verify-context-clipboard2.json`）。
- 日志页：`logs-contextmenu-prevented.png`，`prevented=true`、无自定义菜单、筛选仅剩「全部主机」。
- 门禁：`npm run test:run` 55 文件 / 577 用例；`npm run build` 通过；`cargo check` 通过（仅既有 warning）。

### 4. 踩坑

- 176. **window 上的 mousedown 关闭监听会抢在 click 之前卸载菜单**：侧栏右键菜单必须 `onMouseDown={stopPropagation}`，否则「连接 / 编辑 / 复制地址」全部点不动。
- 177. **空剪贴板不是错误**：arboard 在无文本时返回 `ContentNotAvailable`，直接抛给前端会让 OSC 52 查询一直等回复；后端按空串返回。
- 178. **全局屏蔽默认菜单要放行输入框**：`input / textarea / contenteditable` 保留系统复制/粘贴/剪切菜单，其余区域一律 `preventDefault`；捕获阶段只吞默认行为、不阻断冒泡，已有自定义菜单不受影响。

---

## 2026-11-05 — 终端「撰写栏」按 Netcatty 重做

> 用户反馈撰写栏样式与逻辑和 Netcatty 不一致。先取证 `Netcatty/components/terminal/TerminalComposeBar.tsx`、`domain/composeBarHistory.ts`、`application/state/useComposeBarHeight.ts`、`TerminalToolbar.tsx`、`components/Terminal.tsx`（`executeSnippetCommand`），按差异清单重写组件与发送链路。

### 1. 差异清单

| 项 | Netcatty 实际行为 | termX 现状（改前） | 差距 | 处理方式 |
|---|---|---|---|---|
| 触发 | 工具栏 `TextCursorInput` 图标按钮（`aria-pressed`）开合；再次点击收起（不清空） | 工具栏「撰写栏」文字/图标按钮，但 `disabled={status !== "connected"}` | 未连接时不可用 | 去掉 disabled，与 Netcatty 一致（未连接也能编辑草稿） |
| 焦点 | 打开后 50ms 自动聚焦 textarea；关闭后 `term.focus()` | 无自动聚焦、关闭不回焦终端 | 缺 | `ComposeBar` 内 50ms 聚焦；`onClose` 里 `term.focus()` |
| 位置 | 终端底部 `flex-shrink-0 flex-col`，`border-top: 1px` 用终端主题色 | 原本在终端**上方**（flex row），带「发送」按钮 | 位置/结构错误 | 移到 `<TerminalView/>` 之后、固定底部；删除发送按钮 |
| 高度 | 默认 120，拖拽 72–360，顶边 6px 分隔条（hover 才显把手），结束后才持久化 | 固定高度 84px，`textarea` 自带 `resize: vertical` | 尺寸与交互不同 | 新增 `composeBarModel.clampComposeBarHeight` + localStorage `termx.composeBar.height`，6px `ns-resize` 顶条，mouseup 才写 |
| 尺寸细节 | body `px-3 pt-1.5 pb-2`（12/6/12/8），textarea `text-xs font-mono leading-relaxed`、占满高度、内部 `overflow-y:auto`；关闭按钮 24×24、`X` 12px | padding 8px、textarea 自动撑高、发送按钮占位 | 内边距/字号/滚动语义不同 | CSS 对齐 12/6/12/8、12px mono 1.6 行高、`height:100%` + 内部滚动；关闭按钮 24×24 |
| 输入 | Enter 发送；Shift+Enter 换行；Ctrl/Alt/Cmd+Enter 也发送；Escape 收起；输入法组合态（`isComposing` / keyCode 229）不触发任何快捷键 | Enter 发送、Shift+Enter 换行一致；无 Esc、无 IME 保护 | 缺 Esc/IME | 纯函数 `resolveComposeKeyAction` 统一映射并补单测 |
| 历史 | ↑/↓ 无修饰键且光标在首/末行时翻阅本 session 历史（最多 100 条，跳过空白/连续重复），越过最新恢复草稿 | 无 | 缺 | 移植 `composeBarHistory`（`appendComposeHistory` / `navigateComposeHistory` / `canNavigateComposeHistory`） |
| 发送 | 换行归一 LF；多行且 shell 开启 bracketed paste → `\x1b[200~…\x1b[201~` 包裹，`\r` 放在包裹外；整段一次写入 | 直接原样写入，未归一、未包裹 | 多行在 shell 里会被当成粘贴/逐行 | `buildComposePayload(text, bracketedPaste)`，`\r` 永远在包裹外 |
| 写入通道 | 一次 `writeToSession`（automated） | 走 SSH 输入兼容模式逐字拆分 | 多字符命令可能乱序 | 新增 `TerminalTransport.writeBulk`：SSH/PTY 整段 `sshWrite`/`ptyWrite`，串口复用 `serialInput.feed` |
| 成功后 | 清空草稿、保留焦点；仅当发送成功才记历史 | 无历史、失败也清空 | 行为不同 | 成功才 `onChange("")` + 追加历史；未连接/失败保留草稿 |
| 关闭草稿 | textarea 非受控，卸载即丢草稿 | 无草稿态（旧实现同样丢） | 缺 | 草稿提升到 `TerminalPane` state，关闭/重开保留（用户明确要求） |
| 分屏 | 每个 pane 独立撰写栏与独立历史 | 每 pane 独立 | 一致 | 保持 |
| 窗口缩放 | 高度固定、textarea 内部滚动，不随内容增长 | 旧实现随内容增长挤压终端 | 不同 | 固定高度 + 内部滚动 |
| 快捷片段条 / 广播 | 30px 片段条（pin/点击插入、Shift 直接发送）+ 广播 radio + 右键编辑菜单 | termX 无广播能力（前序任务已删「广播模式」） | 无对应后端 | 不实现；片段发送仍走既有「脚本」模块 |
| 占位文案 | `terminal.composeBar.placeholder`（「在此输入命令，按回车发送...」） | 有 | 一致 | 保持 |
| 字符计数 / 插入不执行开关 | 无 | 无 | 一致 | 不新增 |

### 2. 改动文件

- 新增 `src/terminal/composeBarModel.ts`（高度 clamp、按键映射、历史游走、payload 拼装）与 `src/terminal/composeBarModel.test.ts`。
- 新增 `src/terminal/ComposeBar.tsx`（底部固定、6px 拖拽条、内部滚动、自动聚焦、关闭按钮）与 `src/terminal/ComposeBar.test.tsx`。
- [TerminalPane.tsx](src/TerminalPane.tsx)：工具栏按钮去 disabled；`composeHistory` state；`sendCompose` 走 `writeBulk`；旧内联 bar 删除，新组件挂在终端之后；SSH 输入兼容模式改为 `reduce` 串行写入（修复并发乱序）。
- [client.ts](src/backend/client.ts)：`TerminalTransport.writeBulk?`。
- [styles.css](src/styles.css)：重写 `.term-compose-*`（删除旧的上方 bar 样式）。

### 3. 实测验证（debug + CDP，2026-11-05）

- Netcatty 基线：`evidence/nc-compose-tab.png`（底部撰写栏：6px 拖条、textarea、右侧关闭、占位「在此输入命令，按回车发送...」）。
- 改前：`evidence/compose-before-ssh.png`、`compose-before-local.png`、`compose-before-serial.png`、`compose-before.json`。
- 改后：`evidence/compose-after-ssh.png`、`compose-after-ssh-multiline.png`（多行 `scrollHeight 230 > client 105`，内部滚动）、`compose-after-ssh-resized.png`（拖拽到 240 并持久化）、`compose-after-ssh-enter.png`（Enter 实际执行 `TERMX-ENTER-FIXED`、多行 `MULTI-1/MULTI-2`）、`compose-after-local.png`、`compose-after-telnet.png`、`compose-after-serial.png`、`compose-after.json`。
- 行为断言：默认高度 120、贴底 `y=644`、textarea `105.2px` + `overflow:auto`；Enter/Ctrl+Enter 发送、Shift+Enter 换行、IME 中文组合态不发送；关闭再开草稿 `draft-keep-me` 仍在。
- 环境阻塞：串口 `COM1` 被占用（`拒绝访问`），只能截到未连接 pane 的撰写栏，串口写入链路靠单测覆盖。
- 门禁：`npm run test:run` 54 文件 / 570 用例；`npm run build` 通过；无 Rust 写入改动，未跑 cargo。

### 4. 踩坑

- 172. **整段发送不能走逐字拆分的并发 invoke**：SSH 输入兼容模式原来用 `forEach` 并发 `sshWrite`，多字符命令会乱序（`echo …` 被拆成 `eMcXho …`）；必须改成 `reduce` 串行链，撰写栏这类整段内容再走 `writeBulk` 直接写，不经拆分。
- 173. **bracketed paste 的回车必须在包裹外**：先 `\x1b[200~` 包裹内容、再追加 `\r`；把 `\r` 包进 paste 标记会被 shell 当成粘贴文本而非提交。
- 174. **撰写栏高度只认 dragEnd 的持久值**：拖拽中每帧写入 localStorage 会放大 IO；结束才持久化，并在读取时 clamp 72–360，避免历史脏值撑破布局。
- 175. **草稿态必须由宿主组件持有**：Netcatty textarea 非受控、关闭即丢；termX 把草稿提到 `TerminalPane`，发送失败/关闭都保留，只有成功才清空。

---

## 2026-11-05 — 日志页精简：移除格式筛选 + 去重首行

### 1. 删除「全部格式」筛选

- 左栏筛选只保留「全部主机」；移除格式下拉的 UI、`format` state、`formats` 派生集合与 `filterSessionLogs` 的格式参数（`SessionLogFilter` 现在只有 `query` / `host`）。
- 格式筛选文案为组件内硬编码，i18n 无对应 key；设置中心的 `sessionLogs.format` 是「默认导出格式」，与列表筛选无关，保留不动。
- 单测同步：原「格式精确匹配」用例改为只断言主机匹配与不过滤；列表仍按后端 `started_at` 倒序，未改排序。

### 2. 日志项去掉冗余首行

- 默认记录的 `title` 由文件名派生，通常与 `host_name` 相同，首行标题 + `asciicast` 徽标属于重复信息。
- 新增纯函数 `sessionLogItemTitle(log)`：标题 trim 后为空或与 `host_name`（trim）相同 → 不显示首行；只有自定义标题才保留首行（徽标一并移除）。
- 条目保留 `主机 · 时间` 与 `时长 · 大小` 两行；内边距 8px→6px、行间距 3px→2px、`line-height 1.5`，条目高度约 70px→49px，hover / active / 点击进详情行为不变。
- 清理检查：`format` 字段只用于导出（`cast/txt/html` 由用户选择）与后端索引，不再参与列表展示 / 筛选 / 详情；`session-logs-badge` 样式无残留引用。

### 3. 验证

- 改前：`evidence/logs-page-129.png`（两个下拉 + 首行标题与 asciicast 徽标）；改后：`evidence/logs-page-after.png`（单下拉、每项 2 行、高度 49px、徽标数 0），详情交互 `evidence/logs-page-after-detail.png`（active=1、标题 / 统计正常、无右键菜单），机器可读结果 `evidence/logs-page-after.json`。
- 门禁：`npm run test:run` 52 文件 / 552 用例；`npm run build` 通过。

### 踩坑

- 171. **列表「标题 == 主机名」才是冗余**：默认 cast 的 title 由文件名派生，不能按「字段是否有值」判断；要比较 trim 后的 title 与 host_name，只有自定义标题才保留首行，否则一旦主机名带空格就会漏判。

---

## 2026-11-05 — 脚本 / 笔记模块按 Netcatty 一比一重做

> 用户反馈当前移植「差异很大」，要求图标、UI 与功能逻辑全部对齐。先取证（`Netcatty/components/SnippetsManager.tsx`、`ScriptsSidePanel.tsx`、`SnippetsRightPanel.tsx`、`scripts/ScriptEditorPanel.tsx`、`scripts/ScriptMetaFields.tsx`、`snippets/SnippetTargetsSection.tsx`、`notes/NotesManager.tsx`、`NoteToolbar.tsx`、`NoteSourceEditor.tsx`、`NoteTitleInput.tsx`、`NoteOutline.tsx`、`NoteExportMenu.tsx`），再按差异清单重写组件层。后端 `snippets*` / `notes*` 命令与 schema 沿用，未新增裸 invoke（R1），未改事件（R3）。

### 1. 脚本模块差异清单

| 项 | Netcatty 实际行为 | termX 现状 | 差距 | 处理方式 |
|---|---|---|---|---|
| 页面结构 | VaultPageHeader：搜索（默认 256px）+「新建」下拉（片段 Zap 天蓝 / 脚本 Play 紫 / 分组 FolderPlus）+ 导入 + 历史 + 视图切换 + 排序 + 多选；面包屑「全部分组 / …」；Packages 节 + Snippets 节；右侧 `SnippetsRightPanel` 常驻 | 单行工具栏：搜索、两个原生 select、导入/导出/新建按钮；无面包屑、无视图/排序/多选；编辑器是覆盖式 `<aside>` | 结构完全不同 | 重写 `SnippetsView`：header 工具条 + 面包屑 + 两节列表 + 右侧常驻面板 |
| 列表布局 | grid 卡片 68px（`rounded-xl px-3 py-2`）/ list 行 56px（`h-14 px-3`）；图标容器 `VaultEntityIcon` 18px（片段 Zap / 脚本 Play）；名称 14px 600；命令预览 11px mono 单行；快捷键 badge 10px mono | 分组头 + 行，行内多枚中文 badge（脚本/自动触发/逐行/仅插入）+ 描述 + 标签 | 信息密度与视觉层级不同 | 两种视图；徽标只保留快捷键；命令预览统一单行 |
| 分组 | 卡片：Package 18 + 名称 14 + 「N 条片段」11；右键「打开 / 导出分组 / 重命名 / 删除」 | 分组头内联「重命名 / 删除」文字按钮；无导出分组 | 交互与菜单缺失 | 分组卡片 + 右键菜单 + 导出分组 |
| 搜索 | 扁平匹配 label / command；有搜索时隐藏 Packages 节 | 匹配名称/命令/描述/分组/标签；分组筛选单独 select | 字段范围不同 | 保留 termX 字段（更宽），搜索时隐藏分组节并显示「无结果」空态 |
| 排序 | manual / az / za / newest / oldest / group | 无 | 缺功能 | 新增排序下拉，manual 保留原数组顺序 |
| 多选 | 顶栏 CheckSquare 切换；选择条：已选 N / 全选可见 / 取消全选 / 导出所选 / 删除所选 / X | 无 | 缺功能 | 新增多选条 |
| 右键（条目） | 运行 / — / 编辑 / 复制 / 导出 / 删除；list 视图 hover 出现 Edit2 按钮 | 行内 运行/编辑/删除 文字按钮 | 菜单项与顺序不一致 | 自绘右键菜单按 Netcatty 顺序 |
| 编辑字段 | 名称 + 描述 → 分组 combobox（可新建）→ 命令编辑器（可展开、变量检测 chips + 帮助）→ 目标主机（Select hosts / Select groups / 所有主机 + pills + 摘要）→ 不自动运行 checkbox → 多行模式 select → 快捷键（点击录制）→ 底部整宽 保存/运行 | 类型 select + 语言 + 触发方式 + 目标主机 checkbox 列表 + 名称/命令/多行/描述/分组/标签/快捷键文本 + 仅插入 | 顺序、控件、变量能力不同 | 重排字段；命令框补变量检测 chips；快捷键改录制式（保留 `parseShortkey` 做校验） |
| 快捷键 | `keyEventToString` 录制，Mac ⌘ 显示；与系统快捷键冲突检测 | 手输字符串 + `parseShortkey` 校验 + 同列表冲突 | 交互不同 | 录制按钮（点击后监听 keydown），冲突提示保留 |
| 导入导出 | 导入对话框：文件选择、示例 zip、覆盖/跳过（按命令判冲突）；导出单条 / 分组 / 所选 | `window.confirm` 询问覆盖，导出全部/单条 | 缺分组/所选导出与冲突统计展示 | 新增导入预览对话框（条数 + 冲突数 + 覆盖/跳过）；导出单条/分组/所选 |
| 空状态 | 无数据：FileCode 32 + 64px 圆角底 + 标题 18 + 描述 14；无结果：Search 24 + 标题 16 | 纯文字标题/说明 | 图标与容器缺失 | 按 Netcatty 尺寸重做 |
| 运行入口 | 页面右键「运行」选目标主机；终端侧栏/命令面板运行到当前会话 | 仅页面「运行」按钮发送到活动终端 | termX 无多会话广播 | 右键与面板底部按钮都发送到活动终端，未连接时禁用并说明 |

### 2. 笔记模块差异清单

| 项 | Netcatty 实际行为 | termX 现状 | 差距 | 处理方式 |
|---|---|---|---|---|
| 树工具栏 | Search / FileText / FolderPlus / Upload / Download / Expand / Minimize2，均为 14px ghost 图标按钮；搜索是可折叠 36px 行 | 一个「+」按钮 + 常驻搜索框 + 分组/标签横向 chip 条 | 工具项缺失、搜索占用常驻空间 | 重写为图标工具条 + 可折叠搜索行 |
| 树结构 | 分组文件夹（Chevron + Folder/FolderOpen，可折叠、计数）+ 笔记行（FileText 12，标题 12px）；拖拽移动/排序 | 平铺列表 + 分组/标签 chip | 无层级、无折叠 | 派生「分组树」：`a/b` 路径嵌套、计数含子树、可折叠 |
| 标题行 | `min-h-[54px] px-8 pt-6`；标题 18px 600 h-8；右侧模式下拉（编辑/源码/预览）+ ListTree 大纲 + 导出 + Trash2（h-8 w-8） | 标题 input 12px 级 + 文字「原文/预览/大纲」按钮 + 三个小图标 | 尺寸与控件不同 | 重写标题行与图标 |
| 元数据 | 分组 pill（Folder 12 琥珀）、标签 pill（Hash 12 + X 移除）、`+ 添加标签`（就地输入，Enter 提交 / Esc 取消） | 分组与标签是两个输入框 | 交互不同 | 改为 pills + 就地输入（分组仍可就地编辑） |
| 工具栏 | Undo2 / Redo2 / Type（代码字体搜索 + 正文字号 12–20 + 代码字号 11–18）/ Heading 下拉 H1–H4 / Bold / Italic / Strikethrough / Underline / Code / List / ListOrdered / CheckSquare / Quote / FileCode / Sigma / Table / Minus / Link / Image，分隔线 `h-4 w-px` | 8 个文字按钮（H1/H2/B/I/•/1./❝/</>） | 项目与图标缺失 | 用 lucide 重写工具栏，动作补 undo/redo/strikethrough/underline/task/table/divider/link/image/math |
| 编辑器 | `InlineMarkdownEditor`（live 内联渲染）/ `NoteSourceEditor`（textarea + 行号 + 自研 undo 合并 750ms）/ preview | 单一 textarea + 自研预览 | 无行号、无源码历史、无三模式 | source 模式补行号 + 自研 undo/redo（移植 `getSourceEditDelta` / `shouldCoalesceSourceUndoStep`）；live 暂无内联渲染引擎，用编辑态替代并在 changelogs 标注差距 |
| 大纲 | 右侧 256px，标题树点击跳转，可关闭 | 有简单大纲，无关闭、无宽度 | 细节不同 | 256px、ListTree 开关、点击跳转 |
| 保存 | 标题 / 内容分通道，防抖 300ms，失焦 flush | 统一 600ms | 时序不同 | 改 300ms + 失焦 flush + 切换前 flush |
| 导出 | 单条 Markdown / 全部（菜单） | 单条 .md + 全部 zip | 基本一致 | 菜单项与文案对齐 |
| `ssh://` 链接 | 预览/内联编辑中识别主机链接并起连 | 预览中按 profile 匹配后 `onOpenHost` | 需保证 live/source 也一致 | 预览继续支持；源码/编辑态不误伤（排除代码块） |

### 3. 踩坑

- 163. **树形分组的计数必须含子树**：`package` 用 `a/b` 路径时，父节点计数若只统计精确匹配会与列表条数不一致；派生函数要把子路径条目累加进父节点，并对 `null`/`""` 统一归到根。
- 164. **右键菜单不能留在 `overflow: auto` 容器内**：Netcatty 用 Radix ContextMenu 走 portal；termX 自绘菜单若直接嵌套会被列表裁切，必须 `position: fixed` + 视口边界翻转。
- 165. **快捷键录制 ≠ 文本解析**：录制拿到的是 `KeyboardEvent`，需忽略纯修饰键、归一化主键与 `⌘/Ctrl/Option/Alt` 别名后再写回字符串；写回后仍走 `parseShortkey` + 冲突检测，两条路径不能各写一套规则。
- 166. **笔记双通道防抖要 flush 在切换前**：标题与正文分通道保存时，切换/删除/导出前不 flush 会丢最后一次输入；树节点重命名要同步更新本地列表，否则标题与树显示分叉。
- 167. **Markdown 链接解析要跳过代码块**：`ssh://` 自动识别若不做围栏代码块/行内代码排除，笔记里的示例 URL 会变成可点击主机链接。
- 168. **老数据兼容**：历史笔记存在 `group: null`、空标签、无 `order`；派生与渲染一律按「根组 / 空数组 / 原顺序」处理，不新增迁移（R7 幂等优先）。

### 4. 实测验证（debug + CDP，2026-11-05）

- 逐屏对照（Netcatty 本机窗口 → `PrintWindow` 截图）：`evidence/nc-vault-now.png`（脚本页：多选/导入/导出/视图/排序 + 右侧编辑面板字段顺序、变量提示、目标主机、多行方式、快捷键录制）、`evidence/nc-notes-now.png`（笔记页：左侧树 300px、标题行 54px、模式下拉「实时预览」、格式工具栏图标序列）。termX debug 侧对照：`evidence/scripts-list.png`、`scripts-grid.png`、`scripts-context.png`、`scripts-editor.png`、`scripts-variables.png`、`notes-tree.png`、`notes-editor.png`、`notes-split.png`、`notes-preview.png`、`notes-preview-tasks.png`。
- 已验证对齐项：脚本页顶栏工具顺序与图标（Zap / Play / FolderPlus / Upload / LayoutGrid / List / Search）、56px 列表行与 68px 卡片、右键菜单顺序（运行 / 编辑 / 复制 / 导出 / 删除）、右侧面板字段顺序；笔记页树工具图标（Search / FileText / FolderPlus / Upload / Download / Expand / Minimize2）、标题行 18px、模式下拉、工具栏 H1–H4 与 Table/Sigma/Link/Image、行号编辑器 + 分屏预览、256px 大纲。
- 129 实机链路（tianzry@192.168.126.129 / admin）：
  1. 脚本「发送到当前会话」：脚本页右键「磁盘用量」（`df -h`）→ 运行，活动 129 终端出现 `df` 表格输出，无「未连接」提示。证据 `evidence/run-snippet-129.json`、`run-snippet-result.png`、`after-run-129-terminal.png`。
  2. 笔记 `ssh://` 链接起连：打开笔记「129 主机」→ 切「预览」→ 点击 `ssh://tianzry@192.168.126.129`，新标签「129」建立 SSH 会话并出现 shell 提示符。证据 `evidence/notes-hostlink-129.json`、`notes-hostlink-connect.png`。
- 踩坑补充 169：**「连接后秒断、退出码 100」先查远端自动脚本**。排查中一度怀疑 transport/句柄丢失，最终定位为登录后在远端执行了 `set -e` + `apt-get update`（非 root 时 apt 返回 100，`set -e` 使 shell 立即退出）；清空该脚本后同机连接稳定。后续遇到同类现象先看会话输出与脚本触发条件，不要先改连接层。

### 5. code review 处理（子 agent 只读审查）

- 高危（已修）：笔记导出 `exportAll` 硬编码 `\` 且不建分组子目录 → 按目标目录实际分隔符拼接，写前 `localMkdir` 建父目录（`localfs.local_mkdir` 为 `create_dir_all`）。
- 中危（已修）：
  - 导入 `localReadFile(path, 2MB)` 实际是「超限读尾部」，大文件静默丢开头 → 去掉自设上限，读回长度达到 16 MiB 时在提示里标注「仅导入尾部内容」。
  - 保存队列在发起写前清空 pending，失败即丢内容 → 按 `note.id` 分槽 + 失败回填，下一次 flush 自动重试；补充两条单测（跨笔记不覆盖、失败后重试）。
  - 撤销历史 750ms 合并会覆盖打开笔记时的基线快照且不截断 redo → 只有「输入产生的尾部」可合并，新输入一律截断 redo 分支。
  - 全局 Ctrl+Z/Y 不判断焦点 → 仅正文 textarea 接管，标题/搜索/标签框保留原生撤销。
  - 脚本页 `persist` 使用渲染快照、并发两次整份覆盖可能让已删条目复活 → 写入串行化 + 以 `latestRef` 最新列表做增量更新（删除/分组重命名/多选删除/保存草稿统一改为 updater 形式）。
- 低危（已记录未修，编号 170）：① 大纲 `jumpToLine` 在纯预览模式下 textarea 不存在，点击不跳转；② 「新建分组」用 `window.prompt` 且无独立分组数据（树由 note.group 派生，空分组不显示）；③ `findProfileForHostLink` 只匹配 ssh/22，预览里 telnet 深链必提示未找到；④ 导出文件名未清洗非法字符、`revokeObjectURL` 与 `click` 时序过紧；⑤ 保存成功回调无条件清 dirty，与进行中的 schedule 有竞争；⑥ 笔记树派生 O(分组数×笔记数)，每次按键全量重算；⑦ 导入逐条 `saveNote` 中途失败时界面与 DB 不同步；⑧ 保存队列 ref 在渲染期懒初始化；⑨ `saveDraft` 完成时无条件关闭面板，保存期间的新输入会丢；⑩ 缺 telnet / `javascript:` 链接的单测。

---

## 2026-11-05 — 终端工具栏类型自适应 / 删除主机浏览器与广播 / 会话日志默认自动记录

### 1. 删除「主机浏览器」与「广播模式」

- **引用点全量检索**：`TerminalPane.tsx`（工具栏地球按钮、左侧广播按钮、终端右键「浏览器」项）、`src/settings/keyBindings.ts`（`broadcast` 快捷键）、`src/settings/i18n.ts`（`settings.shortcuts.binding.broadcast`）、`VaultView.tsx`（主机右键「打开浏览器」占位）。`src-tauri/` 无对应命令或设置项。
- **处理**：全部删除，不留置灰占位。Netcatty 工具栏本身也没有「广播模式」，该项属 termX 早期假按钮；`browser` 在 Netcatty 仅 SSH/Mosh/本地可见，termX 后端无内嵌浏览器能力，按用户要求直接移除。

### 2. 工具栏按终端类型自适应

**Netcatty 真实可用性矩阵**（`components/terminal/TerminalToolbar.tsx` `availableIds`）：

| 功能 | SSH | 本地 shell | 串口 | Telnet | 依据 |
|---|---|---|---|---|---|
| highlight / compose / search / scripts / terminalSettings | ✓ | ✓ | ✓ | ✓ | 无类型门控 |
| sessionLog（手动文本日志） | ✓ | ✓ | ✓ | ✓ | `showLogButton` 由 Terminal 统一传入 |
| openSessionLog（打开已有日志） | ✓ | ✓ | ✓ | ✓ | handler 存在即可 |
| sftp | ✓ | ✓ | ✗ | ✓ | `hidesSftp = serial \|\| plugin` |
| browser | ✓ | ✓ | ✗ | ✗ | ssh/mosh/local（termX 已删） |
| history（命令历史） | ✓ | ✗ | ✗ | ✗ | 排除 local/serial/plugin/telnet |
| configureOsc7（目录追踪） | ✓ | ✓ | ✗ | ✓ | 与 sftp 同门控 |
| encoding（终端编码） | ✓ | ✗ | ✓ | ✓ | `!local/!mosh/!et/!plugin` |
| ymodem 上传/下载 | ✗ | ✗ | ✓ | ✗ | serial only |
| recording（脚本录制） | ✓ | ✓ | ✓ | ✓ | `onStartRecording` 由 Terminal 传入 |

**termX 落地**（`src/terminal/toolbarCapabilities.ts` 纯函数 + 5 例单测）：

| 功能 | SSH | 本地 shell | 串口 | Telnet | 说明 |
|---|---|---|---|---|---|
| 命令历史 / 系统监控 / 目录追踪 | ✓ | ✗ | ✗ | ✗ | 依赖 SSH exec |
| SFTP / 端口转发 | ✓ | ✗ | ✗ | ✗ | 后端 SftpHandle 仅 SSH（Netcatty 本地/Telnet 有 SFTP，termX 无本地文件面板） |
| 复制主机地址 | ✓ | ✗ | ✓ | ✓ | 本地终端无远端主机 |
| 终端编码 | ✓ | ✗ | ✗ | ✓ | 串口编码固定在连接表单 |
| 高亮 / 撰写 / 搜索 / 会话日志 / 脚本 / 终端设置 / 脚本录制 | ✓ | ✓ | ✓ | ✓ | 与 Netcatty 一致 |
| 主机浏览器 / 广播模式 | — | — | — | — | 已删除 |

- **实现规则**：类型不支持直接不渲染（不是置灰）；「更多」菜单里的命令历史 / 目录追踪 / 终端编码同样按类型隐藏。分隔位置与图标沿用既有 Netcatty 对齐值。

### 3. 会话日志：默认自动记录 + 手动导出并行

- **Netcatty 取证**：`TerminalLayer.tsx` 自动日志开启条件为 `sessionLogsEnabled && sessionLogsDir`；`SettingsSystemTab` 默认 `sessionLogsEnabled=false` 且目录为空，即开箱需用户先开启并选目录（用户本机看到「默认记录」是已开启该设置）。落盘为 `directory/<hostLabel>/<日期>.<txt|raw|html>`，元信息含 `hostLabel` / `startTime` / `timestampsEnabled`；关闭会话时 `stopSessionLog` 收尾；日志页按 `startTime` 倒序分页。
- **termX 改造**：
  - 自动录制（asciicast）默认开启：`recording_enabled` 未写入时视为 `true`（`recording_enabled_value` + Rust 单测），前端 `sessionLogs.enabled` 默认值同步为 `true`；用户仍可在设置中心关闭。
  - 四类会话都接默认录制：SSH 沿用原 `SessionHandle` 录制槽；PTY / 串口 / Telnet 新增 `LogSlots`（挂到 lifecycle session，spawn 前由 `prepare_log_slots` 创建 `.cast`），sink 每个输出块同时写 asciicast + 手动文本日志；`close_resource` / sink Close 双重 `finish()` 保证尾部刷盘。
  - 手动按钮 = 选保存路径写独立文本日志（txt/raw/html），与默认 `.cast` 两套并行、互不影响；按钮在四类会话均可用，状态由 `session_log_status` 反映。
  - 日志页沿用 `session_logs` 索引（扫描 `recordings/*.cast`），默认记录关闭标签后即可见，按开始时间倒序；命名取档案/终端标题 + 时间戳。

### 4. 实测验证（debug + CDP，2026-11-05）

- **SSH（129）**：`sessionId=404a94e0-00dc-42a0-8d3b-17bde1384157`；工具栏按钮序列（左→右）= 命令历史 / 系统监控 / 断开连接 / 重新连接当前会话 / 复制主机地址 / 主机关键词高亮 / 打开 SFTP / 打开端口转发 / 撰写栏 / 终端搜索 / 开始记录会话日志 / 运行脚本 / 更多 / 关闭当前窗格；无地球图标、无广播按钮。截图 `evidence/toolbar-ssh-129.png`。
- **本地 shell**：左组 = 断开 / 重连（无复制主机地址、无历史、无监控）；右组 = 高亮 / 撰写 / 搜索 / 会话日志 / 脚本 / 更多 / 关闭；更多菜单 = 终端设置、开始录制脚本（无历史 / 目录追踪 / 编码）。截图 `evidence/toolbar-local.png`。
- **串口（COM1）**：左组 = 断开 / 重连 / 复制主机地址（hostname=COM1）；右组同本地；更多菜单 = 终端设置、开始录制脚本。截图 `evidence/toolbar-serial.png`。
- **Telnet（127.0.0.1:2323）**：左组 = 断开 / 重连 / 复制主机地址；右组同本地；更多菜单 = 终端设置、开始录制脚本、终端编码（当前 UTF-8）。截图 `evidence/toolbar-telnet.png`。
- **默认日志链路（129）**：连接后自动生成 `129_20261105_134218.cast`，输入 `echo TERMX-AUTO-LOG-129`；手动按钮 `start_manual_session_log` 选路径 `evidence/manual-129.log`，输入 `echo TERMX-MANUAL-LOG-129`；关闭标签后 `.cast` 收尾 2564 B，尾部含手动日志输出与提示符；`manual-129.log` 与终端输出一致。日志页可见 `129 13:42 3s 2.5 KiB`（默认记录，倒序）。截图 `evidence/logs-page-129.png`。
- **门禁**：`npm run test:run` 52 文件 / 538 用例；`npm run build`；`cargo check --no-default-features`；`cargo test --lib --no-default-features` 934 通过。

### 踩坑

- 154. **Netcatty 的「默认记录」其实是设置项已开启**：源码默认 `sessionLogsEnabled=false` 且必须有 `sessionLogsDir`；照抄默认值会得到「不记录」，与用户观察不符。按用户要求 termX 改为默认开启并内置目录，同时在设置中心保留关闭开关。
- 155. **非 SSH 会话原本没有录制槽**：`start_session_log` / `start_manual_session_log` 只解析 SSH SessionHandle，直接在工具栏对所有类型开放会报 `session_not_found`。必须给 PTY/串口/Telnet 挂 `LogSlots` 并让命令层回退到 lifecycle record。
- 156. **只在 sink Close 里 finish 会丢尾部**：前端主动关标签时 sink 的 Close 事件可能晚于 registry 清理；`close_resource` 里也调用 `log_slots.finish()`（幂等，重复调用无副作用）。
- 157. **删除假按钮要连带快捷键/i18n**：广播模式的 `keyBindings` 条目与 i18n key 分散在 settings 模块，只删 JSX 会留下「设置里能配但界面无功能」的死引用。
- 158. **非 SSH 会话的「复制主机地址」必须补 hostInfo**：termX 原先只有 SSH 档案会写 `hostInfo`，串口/Telnet 标签里 hostname 为空，按钮虽在但始终 disabled。按 Netcatty（串口 host.hostname = 端口名、Telnet = 目标主机）在非 SSH 分支同步填充后，才能复制。
- 159. **Telnet 标题里的 `:` 会打断 Windows 自动录制**：`safe_recording_stem` 只替换 `/ \ . 空格`，`Telnet 127.0.0.1:2323` 生成 `..._2323.cast` 时 Windows 直接拒绝路径，错误被 `if let Ok` 吞掉 → 无文件也无提示。已把 `: * ? " < > |` 与控制字符一并替换，并补单测（`settings.rs`）。前端 `safeFileStem` 早已处理，两侧规则此前不一致。
- 160. **窗口关闭 / 退出走的是 owner 级关闭**：`remove_owned_resources` 只置 Closed、不触发 `close_resource`，而 Pty/Serial/Telnet 的 `ReadySession::close()` 是空操作；急退会丢 `BufWriter` 尾部。已在置 Closed 前收集 `log_slots`，放锁后统一 `finish()`（幂等）。
- 161. **spawn 失败会留下空 `.cast`**：`prepare_log_slots` 先建文件、`spawn` 才可能失败（串口不存在 / Telnet 拒连必现）。三处（pty / serial / telnet）在错误分支补 `finish()`，不再悬挂文件句柄。
- 162. **registry 锁内不要刷盘 + headless 尚未接线**：`finish()` 有同步 IO，原实现持 `lifecycle_sessions` 锁执行会阻塞其它会话；已改为先 clone 槽位、放锁后刷盘。`server.rs` 的三类 open 未调用 `prepare_log_slots`，headless 的手动日志目前写空文件（已登记为已知缺口，GUI 路径不受影响）。

## 2026-11-05 — Vault 工具栏显隐 / 各页左留白 / 主机 distro 探测（schema v46）/ 「主机」节回归修复

### 1. 顶部连接工具栏按导航显隐

- **Netcatty 规则**：`components/vault/VaultViewLayout.tsx` 把整个 VaultPageHeader（搜索 / 连接 / 视图 / 排序 / 多选 / 新建）包在 `cn(!isHostsSectionActive && "hidden")`；只有当前在「主机」分区时显示，切到监控 / 同步 / 钥匙串 / 代理 / 端口转发 / 脚本 / 笔记 / 已知主机 / 日志一律 `display:none`，**无过渡动画**。多选工具行另外再要求 hosts 分区。
- **termX 落地**：`VaultView.tsx` 头部改为 `className={\`vault-header${activeNav === "hosts" ? "" : " is-hidden"}\`}`，多选行同样加 `activeNav === "hosts"` 条件；`styles.css` 新增 `.vault-header.is-hidden { display: none }`。
- **实测**：CDP 读取 `.vault-header` computed display —— 主机 `flex`，其余 9 页全部 `none`（`evidence/vault-final-check.json`）；截图 `evidence/vault-page-监控.png / 钥匙串.png / 代理.png / 脚本.png`。

### 2. 各子页左侧留白（逐页对齐 Netcatty，不一刀切）

| 页面 | Netcatty 容器 padding | termX 修正前 | termX 修正后 |
|---|---|---|---|
| 主机 | 16 | 16 | 16（不变） |
| 监控 | 16 | 0 | 16 |
| 同步 | 24 | 0 | 24 |
| 钥匙串·系统 | 12 | 0 | 12 |
| 钥匙串·已存 | 12 | 20 | 20（已大于 Netcatty，保持不回退） |
| 代理 | 12 | 0 | 12 |
| 端口转发 | 12 | 22 | 22（已大于 Netcatty，保持） |
| 脚本 | 16 | 0 | 16 |
| 笔记 | 16 | 12/14 | 16 |
| 已知主机 | 16 | 20 | 20（已大于 Netcatty，保持） |
| 日志 | 16 | 12/14 | 16 |

涉及文件：`VaultView.tsx`、`styles.css`、`monitor/MonitorView.tsx`、`sync/SyncView.tsx`、`ProxyProfilesView.tsx`、`snippets/snippets.css`、`keychain/keychain.css`、`notes/notes.css`、`sessionLogs/sessionLogs.css`。

### 3. 主机发行版（distro）探测 + 持久化

- **Netcatty 真实判定**（`components/terminal/runtime/terminalDistroDetection.ts`）：SSH banner（`OpenSSH_for_Windows` → windows；`detectVendorFromSshVersion` 识别厂商关键词）→ 单通道路由跳过 → 连上后 exec `/etc/os-release`（失败回退 `uname`）→ `normalizeDistroId`；自动结果写回 Host，同时允许用户手动覆盖。
- **termX 实现**：schema 升到 **v46**，`profiles.distro TEXT` 可空（`column_exists` 幂等守卫，老数据不受影响）；新增 `src-tauri/src/ssh/distro.rs`（连接期捕获 SSH banner + 5s 超时 exec `/etc/os-release`，失败回退 `uname`）；`commands/session.rs` 在 SSH 连接成功后后台 `spawn_detection`；`db/profile.rs` 用 `COALESCE` 保留用户覆盖、`set_distro_if_unset` 只补空值，写入后 emit `profiles:changed`；前端 `Profile.distro?: string | null`，`DistroAvatar` 优先 `profile.distro`（Ubuntu `#E95420` 等品牌色），未知/探测失败回落现有主色 + Server 图标。主机卡片 / 列表 / 快速切换器 / 标签页头像同一数据源自动刷新。
- **实测**：129（`tianzry@192.168.126.129`）连接 → 关闭 → 重启应用后，卡片 `img src="/distro/ubuntu.svg"` 仍存在；截图 `evidence/vault-hosts-129-before.png / vault-hosts-129-after.png`、`evidence/vault-after-restart.png`。

### 4. 回归 bug：「主机」节卡片在关闭会话后"消失"

- **现象**：Vault 首页初始「最近连接 / 分组（未分组 3 台主机）/ 主机（Git Bash 等）」齐全；点 Git Bash 连接 → 关闭标签回首页后，「主机」节的卡片全部消失，只剩最近连接与分组卡片，看似主机列表丢失。
- **根因（非数据丢失，是过滤 + 整节隐藏）**：`VaultView.tsx` 的根「主机」节为 `rootRemaining`（排除已置顶 / 最近）；连接后 Git Bash / 129 进入最近列表，`rootRemaining` 变为空，而 `hideRootHostsSection` 在 `remaining 为空 && 存在分组/最近` 时整节隐藏。该逻辑逐字移植自 Netcatty `useVaultHostCollections.tsx` 的 `shouldHideEmptyRootHostsSection`，在 termX 的最近连接上限 8 下更容易触发，被用户感知为数据丢失。
- **修复**：新增纯选择器 `src/vault/rootHostsModel.ts` —— `rootHostsForDisplay()` 在 `rootRemaining` 为空时回退全部 `scopedHosts`；`shouldHideRootHostsSection()` 仅在 `scopedHosts.length === 0` 时才隐藏。`VaultView.tsx` 的渲染与隐藏判断改为调用这两个函数，分组计数与「主机」节卡片始终一致。
- **回归测试**：`src/vault/rootHostsModel.test.ts` 7 例（剩余非空只显示剩余 / 剩余为空回退全部 / 回退仍遵守「仅未分组」设置 / 两者皆空 / 有主机不隐藏 / 无主机隐藏 / 搜索与树视图例外），覆盖 store 派生逻辑而非渲染空壳。
- **实测**：修复前仅 [最近连接, 分组]（`evidence/vault-bug-before.png`）；修复后 [最近连接, 分组, 主机] 且三卡片（129 / 串口验证 COM1 / Git Bash）、分组「未分组 3 台主机」；连接→关闭后一致（`evidence/vault-bug-after.png`）；切到非主机页再切回一致；重启应用后一致（`evidence/vault-after-restart.png` / `vault-after-switch-back.png`）；129 图标在最近与主机两节均为 Ubuntu（`evidence/vault-hosts-129-after.png`）。
- **门禁**：`npm run test:run` 51 文件 / 533 用例通过；`npm run build` 通过；`cargo check --no-default-features` 通过；`cargo test --lib` 933 通过。

### 踩坑

- 151. **「整节隐藏」移植会放大为数据丢失观感**：Netcatty 根「主机」节排除最近/置顶后，若剩余为空就整节隐藏；termX 最近记录上限 8，连接几台后剩余很容易空。移植这类"空态隐藏"必须同时检查回退数据源，并补「回退显示全部」的回归测试。
- 152. **distro 探测不能覆盖用户覆盖值**：自动探测结果写回时要 `distro IS NULL` 才写（`set_distro_if_unset`）+ 读取走 `COALESCE`，否则每次连接都会冲掉手工指定的发行版。
- 153. **`.vault-content` 只包主机页**：非主机子页直接挂在内容面板里，用 `document.querySelector('.vault-content')` 量 padding 会得到 null；逐页留白要按各页根容器/CSS 取值，截图只能作视觉佐证。

---

## 2026-11-05 — Vault / 顶部标签 / 快速切换器图标对齐 Netcatty

- **图标库**：安装 `lucide-react@0.560.0`（与 Netcatty 同版本），不再用 `src/ui/icons.tsx` 自绘路径画这些位置。
- **资源**：原样拷入 Netcatty `public/distro/*.svg`（28 个 distro/OS/厂商）与 `public/shells/*.svg`（10 个 shell 图标）到 termX `public/`。
- **新增** `src/ui/DistroAvatar.tsx`（xs16 / sm20 / md32 / tree24 / log36 / lg44，品牌底色 + SVG 白化 + 串口琥珀 Usb + fallback 主色 Server）与 `src/ui/shellIcons.tsx`（`/distro|/shells` 路径解析，distro 单色图标暗色反色）。
- **替换清单**：
  - 左导航 10 项 → `LayoutGrid / Gauge / Cloud / Key / Globe / Plug / FileCode / NotebookText / BookMarked / Activity`，16px。
  - 顶部根标签 `FolderLock` / `Folder` 14px，加号 `Plus` 14px；会话标签 SSH `Server` 10px（accent 15% 容器）、串口 `Usb` 10px（琥珀）、本地 shell 图标 16px。
  - 快速切换器：Vaults `FolderLock`、SFTP `Folder`、会话 `TerminalSquare`（16px），主机行 `DistroAvatar sm`，本地 Shell 行走 `/shells/{icon}.svg` 16px。
  - 主机卡片 `DistroAvatar lg`、列表头像 `DistroAvatar sm`（替换色块首字母）。
- **Fallback（数据缺失）**：termX `Profile` 无 distro 字段，SSH 主机统一走 Netcatty 的兜底「主色 + Server」；本地主机用 `windows.svg`；串口用琥珀 `Usb`；`icon_color` 存在时用自定义底色。
- **保持原样**：Netcatty 没有「同步」导航项，该项保留并用 `Cloud`；终端设置等其它非本次范围的图标未动。
- **验证**：CDP 实测截图 `evidence/plus-menu.png`；`tsc --noEmit`、`test:run`（50 文件/526 用例）、`build` 全绿。
- **已知差异**：129 等 SSH 主机在 Netcatty 里能显示 Ubuntu 橙色图标（其 Host 存 distro / 由 SSH banner 探测），termX 暂无该数据，只能显示通用 Server 兜底。

---

## 2026-11-05 — Vault 顶部「+」改为 Netcatty QuickSwitcher

- **真实实现来源**：Netcatty `components/TopTabs.tsx` 的「+」按钮 `onClick={onOpenQuickSwitcher}`，
  弹出的是 `components/QuickSwitcher.tsx` 覆盖层（命令面板式），不是小下拉菜单。
  容器 `fixed inset-x-0 top-12 z-50 flex justify-center pt-2`；面板
  `w-full max-w-2xl mx-4 rounded-xl shadow-2xl max-h-[520px]`；列表
  `max-h-[min(360px,calc(100vh-14rem))]`。
- **新增** `src/QuickSwitcher.tsx`：分区顺序「主机 → 标签页 → 本地 Shell」；
  标签页含固定项 Vaults / SFTP 与当前已开会话标签；
  主机按名称/地址过滤（最多 40 条，右侧显示 `Personal / 分组`）；
  本地 Shell 显示后端 `discover_shells` 结果并给默认 shell 打「默认」徽标。
  顶部行「跳转到 Ctrl+J」+「+ 新建工作区」，搜索框 placeholder「搜索主机或标签页」+ `Ctrl+J` 键帽。
- **置灰项**：Netcatty 的「+ 新建工作区」在 termX 无对应能力（暂无工作区概念），
  按行内原因置灰：`暂未支持` + title「termX 暂无工作区功能」。
- **交互**：Ctrl+J 全局开关、「+」打开；↑↓ 移动高亮、Enter 执行、Esc 关闭、点遮罩关闭；
  主机项走 `onConnect`，本地 Shell 走新增的 `openLocal(shell)` 重载（按 shell 的
  command/args 新建 pty 标签），Vaults/SFTP 切根视图，会话标签走 `activateTab`。
- **视觉对齐**：遮罩顶部偏移 56px（top-12 48 + pt-2 8）、面板宽 `min(672px, 100vw-32px)`、
  圆角 12px、`shadow-2xl`、背景 `--background`、列表上限 360px、进入动画；
  行 hover `--muted/50`、选中 `--primary/15`（对齐 Netcatty 行状态类）。
- **验证**：debug 重编 + CDP 实测（`evidence/plus-menu-check.mjs`）几何、分区、键盘、
  过滤、点外部关闭、本地 Shell 新建标签；截图 `evidence/plus-menu.png` 与
  `evidence/plus-menu-check.json`（证据文件不入库）。

---

## 2026-11-05 — P2 收尾状态（门禁 / 打包 / 遗留项）

### 已完成并验证
- **代理库**：列表/增删改、主机绑定、分组默认代理、钥匙串身份引用、拖拽排序、
  ProxyCommand 全部落地；原「未移植能力」置灰行已全部解除。129 实机验证分组默认代理
  真实经本地 HTTP CONNECT 代理登录成功（代理侧记录 `CONNECT 192.168.126.129:22`），
  ProxyCommand 子进程 stdio 承载真实 SSH 握手成功。
- **证书认证 + TOTP**：SSH 证书登录（用户证书 + CA 签名）与 keyboard-interactive
  TOTP 自动填充（RFC 6238 向量 + mock 服务端实测）。
- **监控扩项**：逐核 CPU、磁盘 I/O、Top 进程均从 `/proc` 真实采样并在 129 实测。
- **终端设置 tab / 端口转发总览**：移植项已验证生效，剩余项已在界面写明原因。

### 置灰 / 暂缓及原因
- 代理页已无未移植置灰项。
- 证书真实握手：代码路径已实现，但需真实 CA 签名服务器环境做人工验证。
- Windows ssh-agent 启动与委托：需真实 agent 环境（ssh-agent 服务/页签）人工验证。
- 安装包安装：MSI / NSIS 仅完成产出，需在干净 Windows 机器人工安装验证。

- 文件对话框落盘：保存/导出/上传等原生对话框路径需人工在桌面环境确认。

### 验证方式与结果
- `npm run test:run`：50 文件 / 526 用例全绿；`npm run build`（tsc + vite）通过。
- `cargo check --all-targets`、`cargo test --lib` 通过。
- 完整 debug 打包（build-debug.bat 等效步骤，`CARGO_INCREMENTAL=0`）成功产出：
  - `src-tauri/target/debug/rssh.exe`（57.93 MB）
  - `src-tauri/target/debug/bundle/msi/termX_0.0.1_x64_en-US.msi`（24.52 MB）
  - `src-tauri/target/debug/bundle/nsis/termX_0.0.1_x64-setup.exe`（12.26 MB）
- **依赖对齐**：`@tauri-apps/api` 2.11.1 → 2.12.4（与 Rust `tauri` 2.12.5 同 minor），
  修复 `tauri build` 的版本错配门禁。
- git：工作区仅上述依赖变更待提交；本地 HEAD 与 `origin/main` 同步（0 ahead / 0 behind）。

### 遗留待人工
1. 证书在真实 CA 签名服务器的完整握手。
2. Windows ssh-agent 启动/转发。
3. MSI / NSIS 安装包在干净机安装与卸载。
4. 文件对话框（保存/导出/上传）真实落盘路径。

---

## 2026-11-05 — 代理库四项代理能力（分组默认 / 钥匙串身份 / 手动排序 / ProxyCommand）

- **schema v45**（只新增迁移块，不改旧版本）：`groups.proxy_profile_id`、
  `proxy_profiles.identity_id` / `command`，均带 `table_exists` / `column_exists` 守卫；
  `SCHEMA_VERSION` 44 → 45，新增迁移与服务端 `db::schema` 单测。
- **分组默认代理**：解析顺序 主机 `proxy_profile_id` → 分组默认 → 主机内联 → 直连
  （对齐 Netcatty `applyGroupDefaults`：主机配置优先）。Vault 分组对话框新增「默认代理」下拉，
  保存走 `createGroup/updateGroup`；删除代理条目时同时清空 `groups.proxy_profile_id`。
  代理页引用计数把分组引用单独计入，删除确认文案写明主机回退内联 / 分组恢复直连。
- **钥匙串身份**：代理条目 `identity_id` 指向 `credentials.id`；运行时用户名取凭证、
  密码取 `SecretStore(cred:<id>:secret)`，身份优先于手填用户名/密码；凭证缺失报
  `proxy_identity_missing`。表单新增「钥匙串身份」下拉，选中后隐藏用户名/密码并保存前校验存在。
- **拖拽手动排序**：`db::proxy_profile::reorder` 事务内按下标写 `order_index`（不存在 id 忽略），
  新增 `reorder_proxy_profiles` 命令并双注册；代理卡片在搜索框为空时启用 HTML5 拖拽，
  乐观本地重排后调用命令，失败刷新回滚并提示；拖拽中半透明、落点描边。
- **ProxyCommand**：`ProxyKind::Command` + `ProxyConfig::from_command`（空命令报
  `proxy_command_required`）与 `%h/%p/%%` 单次扫描展开；Windows `cmd /C` + `CREATE_NO_WINDOW`、
  其它平台 `sh -c`，`PipeStream` 组合 stdin/stdout/Child 并实现 AsyncRead/AsyncWrite，
  Drop 时 `start_kill`，spawn 失败报 `proxy_command_spawn_failed`。
  **踩坑**：任务原拟返回 `Box<dyn AsyncRead + AsyncWrite + Unpin + Send>`，Rust 不允许两个非 auto
  trait 组成 trait object（E0225）；改为内部枚举 `ProxyStream::{Tcp,Command}` 实现两个 trait，
  `client::connect_stream` 泛型调用无需改动。
  **踩坑 2（Windows）**：`cmd /C` 会剥离「以引号开头的整串命令」的首尾引号，且 Rust 默认按 MSVC
  规则转义参数会把内层 `"` 再破坏一层，导致 ProxyCommand 静默不执行；必须
  `CommandExt::raw_arg` 传入原始命令行并再包一层引号。
- 验证：`cargo check --no-default-features` ✓；`cargo test --no-default-features` 全绿；
  `npm run test:run` / `npm run build` ✓；129 实机（debug + CDP）：
  - 分组默认代理：主机不绑代理、分组绑定本地 HTTP CONNECT 代理，SSH 登录成功且代理侧记录
    `CONNECT 192.168.126.129:22`（真实经代理）。
  - ProxyCommand：主机绑定 `command` 代理库条目，SSH 登录成功，子进程日志记录
    `proxycommand target=192.168.126.129:22`（stdio 承载真实握手）。
  - 验证脚本 `evidence/proxy-remaining-live.mjs`（不提交）。

---


## 2026-11-05 — P2 证书认证 + TOTP 自动填充

- **证书认证：可行并已接入**。russh 0.62 原生提供 `authenticate_openssh_cert` 与 `ssh_key::Certificate`，无需换库。
  - 凭据新增 `certificate` 类型；私钥仍存 SecretStore `cred:<id>:secret`，OpenSSH 证书文本存 `cred:<id>:certificate`。
  - `ssh/auth.rs` 解析 `*-cert.pub` 后走证书认证；解析/缺失/失败均有独立 i18n code。
  - 钥匙串新增「证书」区：扫描 `~/.ssh/*-cert.pub`，展示算法 / principals / 有效期 / 是否缺私钥；
    「用作凭据（绑定主机）」把证书与同名私钥组合成凭据，主机编辑选择该凭据即完成绑定/用于认证。
  - 实机：本地临时 CA 签发的 `~/.ssh/termx_probe_cert-cert.pub` 被 `keychain_list_certificates` 正确解析
    （算法 / principal root / 有效期）。缺口：本机没有信任该 CA 的 sshd，未做真实证书登录；
    证书页 UI 已随前端 build 通过，未单独跑 CDP 截图。
- **TOTP：可行并已接入**。新增 `src/totp.rs`：BASE32 解码 + HMAC-SHA1，RFC 6238 30s/6 位；
  keyboard-interactive 提示命中验证码关键字（或主机 `totp_regex`）且 `totp_auto_submit=true` 时直接
  用 SecretStore 中 `totp:<profile>` 计算并回答；未命中仍走人工弹窗。
  - 验证：RFC 6238 SHA1 六组向量（8 位）全部通过；`tests/totp_mock.rs` 对 paramiko mock sshd
    （keyboard-interactive 提示 «Verification code:»，服务端校验当前码）自动填充一次认证成功。
- 门禁：`npm run test:run` 526✓ / 50 文件；`npm run build` ✓；`cargo check --no-default-features` ✓；
  `cargo test --no-default-features --lib` 通过（其中一条 lifecycle 用例首轮 flaky、单跑复跑通过）；
  mock 服务端用例 `cargo test --test totp_mock -- --ignored` ✓。

---


## 2026-11-05 — P2 终端设置 tab：解除 4 项置灰 + 剩余项原因具体化

- 先逐行核对终端设置 tab 的置灰项，能落地的按 Netcatty 语义实现：
  - `altAsMeta`：解除置灰；`Terminal.tsx` 早已把它映射到 xterm `macOptionIsMeta`，只是 UI 被误置灰。
  - `optionArrowWordJump`：模型新增字段（默认 false，`normalizeSettings` 透传）；`Terminal.tsx` 在
    macOS 下把裸 Option+←/→ 映射为 Meta-b / Meta-f，其它修饰键组合仍走 xterm 默认。
  - `preserveSelectionOnInput`：解除置灰；在终端 textarea 的 keydown/keypress（capture）记录选区，
    microtask 后若选区已被 xterm 清除则恢复（行号越界保护同 Netcatty）。
  - `oscNotifications`：解除置灰；新增 `src/terminal/oscNotifications.ts`（OSC 9 / 777 notify /
    99 分片组装、文本清洗、标题回落、`off/unfocused/always` 判定，6 例单测），`Terminal.tsx`
    注册三个 OSC handler 并用 Web Notification 弹窗；`unfocused` 以窗口焦点为准。
- 确实做不了的仍置灰，但把通用「未移植」换成逐项原因（中英双语新键
  `settings.terminal.unsupported.*`）：Kitty 键盘协议（xterm.js 无 CSI-u 编码）、
  `shiftEnterForceText`（无本地 ConPTY）、剪贴板图片上传（缺 SFTP 回填通道）、
  `clearWipesScrollback`（xterm 无只清视口的 API）、`forcePromptNewLine`（无提示符状态跟踪）、
  动态标签标题（无 OSC 0/2→标签通道）、链接打开方式（无内置浏览器）、本地 Shell 侧边栏（无本地 Shell 会话）。
- 验证（debug 实机 + CDP，`evidence/settings-terminal-apply/verify.json` + 同名 png）：
  - apply：四项控件 `disabled=false`，点击后 `altAsMeta/optionArrowWordJump/preserveSelectionOnInput=true`、
    `oscNotifications=unfocused`，`get_setting settings.center.v1` 读回一致。
  - 杀掉进程重启后再打开设置：四项仍为上述值且控件可用（持久化生效）。
  - 门禁：`npm run test:run` 526✓ / 50 文件，`npm run build` ✓。

---


## 2026-11-05 — P2 监控扩项（逐核 CPU / 磁盘 I/O / Top 进程）

- 后端 `commands/monitor.rs`：仍是一条只读 shell 脚本 + 一次 `exec_once`，新增三段真实来源采集：
  `/proc/diskstats`（`DSTAT:<dev> <sectors_read> <sectors_written>`，跳过 loop/ram，Rust 侧按 512B/扇区
  换算为字节）、`/proc/[0-9]*/stat`（`PSTAT:<pid>|<comm>|<utime+stime>`，用 `") "` 切分以兼容带空格的
  comm）、`/proc/[0-9]*/status`（`PRSS:<pid>|<VmRSS kB>`）。
  `MonitorSample` 新增 `disk_io`（按读写速率降序）与 `processes`（Top 5，按 CPU% 降序、同值按内存降序）；
  进程 CPU% = 本进程 ticks 增量 / 全机 CPU total 增量（多核口径与 ps 一致）；逐核沿用既有 `cpu_per_core`。
  首次采样（无上次计数）速率/进程 CPU% 为 `None`，前端 `--`；读不到 diskstats / 进程表时追加
  `warnings`（「未读取到 /proc/diskstats（磁盘 I/O 不可用）」「未读取到 /proc 进程统计（Top 进程不可用）」）。
  前端 `client.ts` 类型、`monitorModel` 纯函数（`topProcesses` / `limitCores` / `formatDiskIo` /
  `diskIoTotal` / `isFirstSample`）+ 单测，Vault 监控页新增逐核条、磁盘 I/O 卡片、Top 进程表，
  终端浮层新增逐核 mini 条（最多 4 核 + 超出计数）、磁盘 I/O 合计、Top 3 进程；延迟/GPU 仍置灰写原因。
- 验证（129 + CDP，`evidence/p2-monitor-expand.json`、`p2-monitor-expand-ui.json` +
  `p2-monitor-expand-ui-first/second.png`）：
  - 逐核：`cpu_per_core = [0.7, 0.7]`，UI 浮层「CPU0 0.7% / CPU1 1.3%」（2 核；另一窗口首次 0.3%）。
  - 磁盘：首次 `read/write_bytes_per_sec = null`（UI `--`）；4 秒后 sda `读 0 B/s / 写 7065.5 B/s`，
    UI 另一次窗口显示 `↓ 0.0 B/s ↑ 45.3 KB/s`（均为两次采样差分实值）。
  - 进程：`kworker/1:1-events 0.1% / 0 MB`、`kworker/0:2-events 0.1% / 0 MB`、
    `gnome-shell 0% / 289.4 MB（8.6%）`、`update-manager 0% / 181.5 MB（5.4%）`、
    `apport-gtk 0% / 81.4 MB（2.4%）`；UI Top 3 为 `rcu_preempt 0.2% / 0 MB`、
    `kworker/0:2-events 0.2% / 0 MB`、`gnome-shell 0.0% / 289 MB`。
- 说明：`/proc/diskstats` 同时包含整盘与分区（sda/sda2）及 fd0/sr0 这类无实际 I/O 的设备，数值均真实；
  内核线程无 VmRSS 故内存显示 0 MB，不是伪造。macOS 采集仍未移植，保持 `supported=false` 写明原因。
- 门禁：`npm run test:run` 49 文件 / 520 用例全绿；`npm run build` 通过；
  `cargo test --lib commands::monitor` 4 通过；`cargo build --no-default-features` 重编后实机验证。

---

## 2026-11-05 — 收尾审计 P2 两项（串口保存为主机 / 终端系统监控）

### 1 串口配置保存为主机（schema v44）

- 后端：`db/schema.rs` 新增 v44 迁移，仅 `ALTER TABLE profiles ADD COLUMN` 11 个可空串口列
  （`serial_port/baud/data_bits/parity/stop_bits/flow/local_echo/line_mode/backspace/byte_backspace/charset`）；
  `models.rs` Profile 全字段 `serde(default)`；`db/profile.rs` 的 PROFILE_COLUMNS / row_to_profile /
  insert / upsert / update 全链路补齐；旧结构体字面量同步补字段（ssh/client、bastion、forward、sync、CLI）。
  无新增命令（`create_profile/update_profile` 直接反序列化 Profile，`server.rs` 无需双注册）。
- 前端：`client.ts` Profile 增加串口字段；`domain/serialFormConfig.ts` 增加
  `serialProfileSnapshot` / `serialFormFromProfile`（NULL 回落默认值）；`SerialConnectModal` 增加
  「保存为主机」+ 主机名（默认 `串口 <port>`）；`App.saveSerialHost` 先建真实凭据（type none）再
  `createProfile`（protocol="serial"、host=串口名、port=0、全量串口列），失败提示但不阻断连接。
- Vault：`connect(profile)` 新增 `protocol === "serial"` 分支，按档案重建 `SerialSessionConfig` 并开
  `kind:"serial"` 标签；主机卡片显示 usb 图标与 `COM3 · 115200 bps` 副标题；新增
  `src/serial/SerialHostPanel.tsx` 编辑名称与全部串口参数；`vaultTransfer` 白名单同步串口字段。
- 验证（COM1 实机 + CDP，`evidence/p2-serial-monitor.json`、`p2-serial-open3.json` 与截图）：
  弹窗填 COM1 + 勾保存 → `list_profiles` 出现 `protocol:"serial"`、`serial_port:"COM1"`、
  `serial_baud:115200` 等全字段且 credential_id 非空；Vault 主机列表出现「串口验证 COM1 / COM1 ·
  115200 bps」；从 Vault 打开后新建同名串口标签，报「打开串口 COM1 失败：拒绝访问。」——说明真实走了
  串口打开链路（COM1 被占用/无权限），档案与连接路径均生效。

### 2 终端「系统监控」按钮

- `TerminalPane.tsx`：`canMonitor = systemEligible && status === "connected" && sidRef.current != null`；
  按钮据状态给出准确 title（仅 SSH / 连接后可用 / 会话未就绪），非 SSH 仍不渲染按钮；断开时自动关闭浮层。
- 新增 `src/monitor/SessionMonitorPopover.tsx`：打开即 `api.monitorSample(sessionId, 8000)`，此后 3s
  轮询（请求未完成不重入，卸载/关闭清理）；失败走 `userVisibleError`，`supported=false` 显示
  `unsupported_reason`，`warnings` 弱化列出；四项 CPU/内存/磁盘（最多 3 分区 + 超出计数）/网络速率；
  首次速率为 null 显示 `--`，不造数。`monitorModel` 增加 `limitDisks` 纯函数 + 2 例单测。
- 验证（129 + CDP，`evidence/p2-monitor.json` 与截图 `p2-monitor-popover.png`）：
  连接 129 后按钮启用，浮层首帧 CPU `--`、网络 `--`（等待首个速率窗口），3 秒后刷新为
  `CPU 0.7% / 2 核`、`内存 36.9%（1.2 / 3.3 GiB）`、两块磁盘（CDROM 100%、94% 17.3/19.5 GB）、
  `网络 ↓747 B/s ↑737 B/s`，页脚「每 3 秒刷新」——数据全部来自 `monitor_sample`，无新增采集逻辑。

### 门禁

- `npm run test:run`：49 文件 / 515 用例全绿；`npm run build` 通过；
  `cargo check --all-targets` + `cargo build --no-default-features` 通过；`cargo test --lib db::` 147 通过
  （含 v44 迁移与串口字段往返/覆盖为 NULL 用例）。

---

## 2026-11-05 — 收尾审计 P1 五项修复（顶栏/导入导出/同步 tab/侧栏/录制）

对照审计清单（本文件上一节）逐项落地，均保持前端小改动；仅新增一个只读 Rust 命令。

### 1 顶栏快捷按钮
- `src/TopTabs.tsx`：AI 保持 disabled，文案「AI 助手（未移植）」；「云端同步」「应用锁」「外观与窗口」
  启用并新增 `onOpenSync` / `onOpenLock` / `onOpenAppearance`。
- `src/App.tsx`：同步 → `setSurface("vault")` + `VaultView` 的 `focusView="sync"`（`focusNonce` 保证重复点击
  也重新定位）；应用锁 → 设置中心「系统」tab（审计时误记为「应用」tab，实际应用锁在系统 tab）；
  外观 → 设置中心「外观」tab。
- 验证：debug 版 + CDP（`evidence/p1-fix-verify.json`、`evidence/p1-top-buttons.png`）：4 按钮中仅 AI
  `disabled:true`；点云端同步后 Vault 激活页 =「同步」且出现 GitHub/WebDAV 文案；应用锁点开系统 tab
  且含「应用锁定」；外观点开外观 tab。

### 2 主机库 JSON 导入 / 导出
- 新增 `src/vault/vaultTransfer.ts`：版本化 `termx.vault` JSON，导出白名单字段（无密码/私钥/凭据 secret），
  `parseVaultImport` 校验 version / hosts 数组 / 名称 / 端口 1–65535，`findConflicts` 按 name+host+port
  识别冲突；新增 8 例单测。
- `src/VaultView.tsx`：新建菜单「导入/导出」启用（`newHostMenu` enabled）；导出走 save + `localWriteFile`，
  导入走 open + `localReadFile`（8 MiB 上限）；分组按名称去重；冲突用 `window.confirm` 统一覆盖/跳过，
  覆盖用 `updateProfile`、新增用 `createProfile`（非 local 主机同时创建空 secret 凭据），标签写入同一
  `termx.vault.tags.v1`；完成后 `onDataChanged`。
- 补齐 `applyImportedHost`：覆盖时同步 sftp/totp/agent/ssh 输入兼容字段（原先只覆盖基础字段）。
- 验证：`npm run test:run` 49 文件 / 510 用例（含 vaultTransfer 8 例）。原生文件对话框无法自动化，
  因此端到端只验证到「菜单启用 + 逻辑单测」，导入导出落盘留人工点测。

### 3 设置「同步与云」tab
- `src/settings/SettingsDialog.tsx` 启用该 tab；`SettingsTabs.tsx` 新增 `SyncTab`（说明 + 「打开同步页」），
  回调经 App 复用第 1 项的 `onOpenSync`；AI tab 保持 disabled（title=未移植）。
- 验证：CDP 实测 tab `disabled:false`，内容含「GitHub / WebDAV」与「打开同步页」按钮（`p1-settings-sync-tab.png`）；
  AI tab 仍 `disabled:true`。

### 4 终端侧栏「标签筛选」「更多」
- 新增 `src/vault/vaultTags.ts` + 4 例单测：与 Vault 共用 `termx.vault.tags.v1`，收集标签、多选过滤
  （需全部命中）。
- `src/HostSidebar.tsx`：标签按钮启用 + popover（多选/清空），与搜索框组合；「更多」菜单含
  管理主机 / 刷新列表（新增 `onRefresh`，App 传 `loadData`）/ 收起侧栏。
- 验证：CDP 实测两按钮 `disabled:false`，popover 出现，更多菜单三项均可读（`p1-sidebar-more.png`）。

### 5 录制按钮默认目录
- `src/TerminalPane.tsx`：去掉「先选择保存路径」措辞，title/aria 统一「开始/停止记录会话日志」。
- 新增只读命令 `recordings_dir`（`src-tauri/src/commands/settings.rs`，`lib.rs` 与 `server.rs` 双注册）；
  `src/backend/client.ts` 的 `pickManualSessionLogPath` 默认到 `<appdata>/recordings`（必要时先 mkdir），
  失败回落主目录。
- 后端 `start_manual_session_log_impl` 只认 `state.sessions`（SSH），pty/local/telnet/serial 无文本日志槽，
  故本地终端按钮仍禁用（已确认不是前端死路）。
- 验证：`cargo build --no-default-features` 通过；CDP 调 `invoke("recordings_dir")` 返回
  `C:\Users\tianzry\.rssh\recordings`；SSH 标签页录制按钮 `disabled:false`，title 无「先选择保存路径」。

### 门禁
- `npm run test:run`：49 文件 / 510 用例全绿；`npm run build` 通过；`cargo check --all-targets` 与
  `cargo build --no-default-features` 通过（仅既有 warning）。

---

## 2026-11-05 — 收尾比对审计（termX vs Netcatty，16 模块，只读）

> 方式：Netcatty 运行实例 + 源码逐模块核对（清单 `evidence/audit-netcatty.md`）；termX debug 版
> 经 CDP 逐页取证（`evidence/audit-termx-live.json`、`evidence/audit-termx-live2.json`，
> 截图 `evidence/audit-termx-*.png`：Vault 10 个导航页、设置首页、SFTP、串口/Telnet 弹窗、终端工具栏）。
> 本轮不改业务代码；应用锁用既有测试口令解锁，未改设置。表内「差异」均指「Netcatty 有、termX 无/弱」。

### 1 连接管理
- 一致：分组树（单层）、搜索、视图切换（列表/网格）、排序、多选、最近连接、快速切换器
  （`evidence/audit-termx-live.json` 主机页）；新建/编辑主机、标签筛选（Vault 页可用）。
- 有差异：**导入/导出置灰**（「导入（尚未实现）」「导出（尚未实现）」，`src/VaultView.tsx:4837,4984`）；
  Netcatty 支持 PuTTY/MobaXterm/SecureCRT/FinalShell/CSV/JSON 导入 + CSV 导出
  （`Netcatty/components/VaultView.tsx:77`、`components/vault/ImportVaultDialog.tsx:50-77`）。
  **证书认证置灰**（`src/VaultView.tsx:152`）；**身份存储置灰**（`:2989`）；Netcatty 支持 certificate 凭据
  （`Netcatty/domain/models/connection.ts:158-166`）。主机字段缺 hostChain/TOTP/keepalive/legacy 算法等（待逐字段复核）。
- 未实现/置灰：分组仅单层，无嵌套与组级配置继承（`src/VaultView.tsx:5057`；Netcatty `domain/models/connection.ts:439-460`）。

### 2 Vault 子页
- 一致：主机/监控/钥匙串/代理/端口转发/脚本/笔记/已知主机/日志 九页齐全（`audit-termx-live.json` 逐页 text）。
- 有差异：termX 多「同步」页（Netcatty 把同步放设置）；Netcatty 有插件页 `plugin-vault:*`
  （`Netcatty/components/VaultView.tsx:173-183`），termX 无插件运行时不提供。
- 未实现/置灰：无（导航入口均可达）。

### 3 终端工具栏与「更多」菜单
- 一致：命令历史、断开/重连、主机关键词高亮、打开 SFTP、打开端口转发、撰写栏、终端搜索、
  运行脚本、关闭窗格（`audit-termx-live2.json` termButtons）。
- 有差异：**开始录制会话日志禁用（「先选择保存路径」）**；**复制主机地址禁用**；**系统监控禁用**
  （`src/TerminalPane.tsx:2109`，Netcatty 终端浮层有 `TerminalServerStats.tsx:51-286`）；
  **主机浏览器禁用**（`src/TerminalPane.tsx:2235,2784`；Netcatty 工具栏有 browser 项）。
- 未实现/置灰：广播模式（`src/TerminalPane.tsx:2151`）；终端侧栏「标签筛选（尚未实现）」「更多（尚未实现）」
  （`src/HostSidebar.tsx:81,87`）；Ymodem 收发未找到（termX 仅 ZMODEM 拖拽，`src/TerminalPane.tsx:601`）。

### 4 SFTP
- 一致：双栏/多标签、传输队列与冲突、右键全集、远程+本地解压、跟随终端目录
  （本轮 SFTP 页空态截图 `audit-termx-sftp.png`；明细见 changelogs #24/#31 与 `src/sftp/*`）。
- 有差异：**文件名编码**仅 UTF-8，GBK 原始字节不可恢复（`russh-sftp` 协议层，见 #25 留档）。
- 未实现/置灰：拖出到桌面（WebView2 无 `CF_HDROP` 桥）；归档「压缩/打包」Netcatty 同样没有，不算差异。

### 5 串口
- 一致：Vault「串口」按钮 → 弹窗；baud 115200/8/1/none/none、localEcho/lineMode/backspace、字符集、
  自动登录（`src/serial/SerialConnectModal.tsx`）。
- 有差异：termX 不保存为可复用主机配置、命名管道禁用（`src/serial/SerialConnectModal.tsx:2-11`）；
  Netcatty 可存 serial 主机并支持自定义 COM/PIPE（`Netcatty/components/SerialConnectModal.tsx:45-73,162-169`）。

### 6 Telnet
- 一致：端口 23、用户名/密码可留空、非空自动应答、自动登录（`src/telnet/TelnetConnectModal.tsx`）。
- 有差异：入口形态不同——termX 独立 Telnet 入口；Netcatty 走主机协议/详情区块（
  `Netcatty/components/HostDetailsPanel.tsx:1254-1396`），termX 无「设为默认协议」与主机级 telnet 持久化。

### 7 端口转发
- 一致：local/remote/dynamic、bindAddress、autoStart、autoReconnect 有界重试（
  `src/ForwardPanel.tsx`、`src/ForwardOverview.tsx`）。
- 未实现/置灰：托盘快捷开关（未启用 tray-icon，页面底部写明原因，`src/ForwardOverview.tsx:640`）。

### 8 代理
- 一致：HTTP/SOCKS5 档、CRUD、主机级引用（`src/ProxyProfilesView.tsx`，运行页 screenshot 无）。
- 未实现/置灰：ProxyCommand（后端无 command 类型）、代理凭据不接钥匙串身份、分组级默认代理
  （Group 无 proxy 字段）、拖拽排序（`src/ProxyProfilesView.tsx:289-295`、`src/VaultView.tsx:4595`）。

### 9 设置各 tab
- 一致：应用/外观/终端/快捷键/SFTP/系统（`audit-termx-live2.json` settingsTabs 逐 tab text）。
- 有差异：**「AI」「同步与云」tab 置灰（title=未移植）**，但 Vault「同步」页已可配置 GitHub/WebDAV
  （`src/settings/SettingsTabs.tsx`、`src/sync/SyncView.tsx`）；Netcatty 有独立 AI/Sync tab
  （`Netcatty/components/SettingsPage.tsx:467-528`）。
- 未实现/置灰：插件 tab（无运行时）；终端 tab 9+ 项未移植（Option as Meta、Meta-b/f、Kitty 键盘协议、
  clear 回滚、粘贴图片上传、提示符换行、标签标题跟踪、OSC 通知、SSH 打开链接等，均带「当前版本不支持」）；
  系统 tab：自动更新安装（缺签名/endpoint/CI）、生物识别解锁（缺原生 helper）、全局热键、会话持久化、
  录制目录自定义/批量清空（`src/settings/SettingsTabs.tsx`）。

### 10 主机监控
- 一致：CPU/内存/磁盘/网络采样 + 曲线/列表、间隔/范围、129 实测可用（Vault「监控」页可启动）。
- 有差异：GPU、进程 Top10、swap、逐核 CPU 等 Netcatty 终端浮层指标 termX 没有
  （`src/TerminalPane.tsx:2109` 监控按钮直接置灰；Netcatty `TerminalServerStats.tsx:51-286`）。
- 未实现/置灰：「Netcatty 有而 termX 后端无数据的字段」在页面内按行置灰写明原因（页内文案）。

### 11 会话日志
- 一致：索引列表、主机/格式筛选、详情、三格式导出、ANSI 保留（`audit-termx-live.json` 日志页）。
- 有差异：录制只能从工具栏入口开始且当前按钮禁用（「先选择保存路径」）。Netcatty 工具栏可直接开始
  （`Netcatty/components/terminal/TerminalToolbar.tsx:745`）。
- 未实现/置灰：回放不做（Netcatty 同样无 cast 回放，不算差异）。

### 12 笔记
- 一致：原文/预览、格式工具栏、大纲、分组/标签、导入导出、`ssh://` 主机链接、置顶（笔记页 text）。
- 有差异/置灰：无富文本，Netcatty 也没有（不算差异）。

### 13 脚本
- 一致：片段/脚本、JS 标签、逐行/粘贴运行、onConnect/onOutput 触发、wait-prompt/text/regex、触发日志
  （脚本页 text + changelogs #13）。
- 未实现/置灰：`nct.*` JS 运行时、录制回放、`nct.dialog/progress/startLog`
  （`src/snippets/SnippetsView.tsx:618-718`）。

### 14 钥匙串 / 安全
- 一致：系统密钥、已存密钥、SSH Agent 状态、Known Hosts、主机密钥校验、应用锁口令
  （钥匙串页 text；`verifyHostKeys` 见 changelogs）。
- 有差异：证书条目、TOTP、独立身份页未移植（`src/VaultView.tsx:2989`）。
- 未实现/置灰：系统凭据（Touch ID/Windows Hello）解锁，缺原生 helper（系统 tab 置灰文案）。

### 15 云同步
- 一致：GitHub Gist/仓库 + WebDAV、推/拉/探测、启动时自动拉取、本地/保护性快照（同步页 text）。
- 有差异：provider 仅 2 个（Netcatty 有 github/google/onedrive/webdav/s3，`Netcatty/components/CloudSyncSettings.tsx:141`）；
  冲突处理为提示/覆盖，非字段级合并（`Netcatty/domain/convergentSync/conflicts.ts:40-56`）；无云端版本快照。
- 未实现/置灰：其余 provider（`src/sync/SyncView.tsx:626` 页底列明）。

### 16 CLI
- 一致：profile/group/settings/sync/discovery/plugin/session/pty/sftp(ls,get,put,home,mkdir,rm,mv,stat,chmod)/
  serial/telnet/forward/snippet（`src-tauri/src/bin/rssh/main.rs`、changelogs #26）。
- 有差异：缺 `exec` / `job-start|poll|stop` / `cancel|resume`；会话级操作依赖运行中应用 RPC，
  桌面端无等价桥（`Netcatty/electron/cli/netcatty-tool-cli.cjs:29-61` 全命令依赖 RPC）。
- 未实现/置灰：`--json` 未提供（与会话级命令绑定）。

### 差异严重度排序（下一轮从这里修）

| 级别 | 差异 | 直接可修 |
|---|---|---|
| P1 | 顶栏 4 个快捷按钮文案/状态过期：「云端同步」「应用锁」「外观与窗口」已实现仍标「尚未实现」并禁用（`src/TopTabs.tsx:45-54`） | ✅ 改文案+启用/跳转 |
| P1 | 主机导入/导出置灰，Netcatty 有全格式导入 + CSV 导出（`src/VaultView.tsx:4837,4984`） | ✅ 先做 JSON/CSV |
| P1 | 设置「同步与云」tab 置灰，但 Vault 同步页可用（`src/settings/SettingsTabs.tsx`） | ✅ 去灰或指向 Vault 同步 |
| P1 | 终端侧栏「标签筛选」「更多」禁用（`src/HostSidebar.tsx:81,87`）；工具栏「更多」title 陈旧 | ✅ 复用 Vault 已有能力 |
| P1 | 录制按钮禁用「先选择保存路径」 | ✅ 默认 recordings 目录或接文件选择 |
| P2 | 终端「系统监控」置灰（`src/TerminalPane.tsx:2109`） | 🟨 复用 Vault 采样或先隐藏 |
| P2 | 证书认证 / TOTP / 身份页 / hostChain 等主机字段 | 🟨 需后端 schema |
| P2 | 代理 command 类型、分组级默认代理、身份引用 | 🟨 需 schema/后端 |
| P2 | 监控缺 GPU/进程/磁盘 IO/逐核 | 🟨 需采样后端 |
| P2 | 云同步 provider 扩展与字段级冲突合并 | 🟨 大件 |
| P2 | 串口保存为主机 + 命名管道；Telnet 主机级持久化 | 🟨 中件 |
| P2 | CLI exec/job/cancel/resume（依赖 RPC 桥） | 🟨 需桌面桥 |
| P3 | 插件运行时/沙箱、AI 侧栏、托盘、生物识别解锁、自动更新签名链路、#38 会话快照、GBK 文件名、拖出到桌面 | ❌ 已留档不做/受阻 |

---

## 2026-11-05 — P2 #31（光标行高亮：对齐 Netcatty 语义 + 主题色派生）

### 对照（Netcatty）

`components/terminal/runtime/cursorLineHighlight.ts` 的 `CursorLineHighlighter`：
`onCursorMove` / `onWriteParsed` 置 pending → `onRender` 刷新；`onSelectionChange` /
`onResize` / `buffer.onBufferChange` 强制刷新；有选区或 alternate buffer 时清除；
只给 `isBgDefault() && !isInverse()` 的单元格铺色，正文按 `contentEnd` 裁剪、行尾空白单独
tail range；先注册新 decoration 再释放旧集合（避免空帧），并在每帧校验 marker 是否被
xterm 回收以自愈。
`domain/cursorLineHighlight.ts`：主题背景混入 selection 色（`BLEND = 0.55`），最小对比度 4.5，
不足时向黑/白回退。

### 修改点

- 新增 `src/terminal/cursorLineHighlight.ts`：移植纯函数（hex 解析同时兼容 `rgb()/rgba()`，
  适配 termX 主题里的半透明 selectionBackground）+ 11 例单测。
- `src/Terminal.tsx`：`CursorLineHighlighter` 补齐 tail ranges / contentEnd 裁剪、
  `buffer.onBufferChange`、tracking 自愈；新增 `resolveCursorLineColor`，从终端主题
  的 background/foreground/selectionBackground 派生（替换此前硬编码的 `#263449`/`#eef3fb`）。

### 验证

- `npm run test:run` 47 文件 / 497 用例（含新增 11 例）；`npm run build` 通过。
- debug 版 + CDP 连 129 实测（`evidence/cursorline-31.json` + 5 张截图）：
  暗色主题输出 60 行后 decoration 两段（正文 355px + 行尾 610px）；输入后左移光标，正文段
  随内容增长到 487px；拖拽选区后 decoration 归零（选区存在即清除）；点掉选区并上滚，
  decoration 置 0×0（光标行在视口外）；切浅色主题重连，decoration 恢复且主题派生色为
  `#78bbff`（暗色 `#446399`，与截图像素取样一致）。

### 踩坑

- decoration 的底色由 xterm 渲染器**按单元格**绘制，`.xterm-decoration` DOM 元素本身透明
  （`getComputedStyle` 恒为 `rgba(0,0,0,0)`），取证不能用计算样式，要用截图 + 同一纯函数算色。
- 默认 DOM 渲染器只绘制到有内容的单元格，tail range 在视觉上不额外铺满行尾（canvas/WebGL
  渲染器才会整行铺满）；语义保留 Netcatty 的 tail range，行为与渲染器差异无关。

---

## 2026-11-05 — P2 #26（CLI 增量：SFTP 目录/元数据子命令）

### 对照（Netcatty）

`netcatty-tool-cli` 的 `sftp` 子命令集含 list/read/write/download/upload/mkdir/delete/rename/
stat/chmod/home；termX `rssh-cli` 此前只有 `ls/get/put`，其余走不到运行中应用的 RPC 桥。

### 修改点

- `src/bin/rssh/main.rs`：`SftpCmd` 新增 `Home` / `Mkdir` / `Rm` / `Mv` / `Stat` / `Chmod`
  （全部带 profile 补全），并接入 dispatch。
- `src/bin/rssh/commands/sftp.rs`：抽出 `open(Target)` 复用连接参数；新增五个命令实现
  （`rm` 走 `SftpHandle::remove`，目录递归、符号链接只删名；`stat` 输出 type/size/mtime/
  permissions）；新增纯函数 `parse_octal_mode`（接受 `644`/`0755`/`0o755`，拒绝 `999`/
  `10000`/`u+rwx`，错误码 `sftp_invalid_mode`）。

### 验证

- `cargo test --bin rssh-cli --features cli`：9 passed（含新增 `octal_mode_accepts_common_forms`
  / `octal_mode_rejects_invalid`）。
- 129 实测（`evidence/cli-26-e2e.txt`）：`home` → `/home/tianzry`；`mkdir` → `stat`
  （directory/0775）→ `chmod 700` → `stat` 变 0700 → `mv` → `stat` 新名 → 非法 `999`
  报 `sftp_invalid_mode` → `rm` → 最终 `stat` 报 `sftp_io_failed`（文件已不存在，预期）。

### 置灰（不变）

会话级 `list/read/write/send`、`exec`、`--session` 仍依赖运行中应用的 RPC 桥（termX 桌面端无
`netcattyRpcClient` 等价通道）；`--json` 与这些命令绑定，未单独提供。

---

## 2026-11-05 — P2 #31（子项：输入兼容模式 / 中文 IME 逐字发送 + 宽字符核验）

### 对照（Netcatty）

`docs/ssh-input-compatibility.md` + `HostDetailsAdvancedSections.tsx`：
主机级布尔项 `sshInputCompatibility`，标题「输入兼容模式：逐字发送」，说明「中文输入或短粘贴
出现丢字时尝试开启」「保存后重新连接生效」；四条传输规则——多码点 IME / 普通短粘贴按码点
分开写，>32 码点、bracketed paste 与已确认分行粘贴保持原行为，终端控制序列必须成组。

### 修改点

1. `models.rs` / `db/schema.rs`（v43）/ `db/profile.rs`：`profiles.ssh_input_compatibility`
   可空列（NULL = 老数据，SSH 视为开启），PROFILE_COLUMNS / insert / upsert / update
   全链路读写；迁移测试 + 三态往返测试。
2. `client.ts` `Profile` 增可选字段；新建 `src/terminal/inputCompatibility.ts`：
   `resolveInputCompatibility`（`?? true`）与 `splitCompatibleWrites`（bracketed paste /
   >32 码点整段、CSI/OSC/SS3/ESC 序列成组、其余逐码点）。
3. `TerminalPane`：连接前读一次主机配置写 `inputCompatRef`（读取失败不阻断连接，保留上次
   快照）；`wire()` 的 ssh 写分支开启时逐 chunk `sshWrite`，pty/telnet/zmodem 不动。
4. `VaultView` / `ConnectionManager` 两处主机表单加同款开关（新主机默认 false，老数据
   `?? true` 显示，保存/复制原值透传）。

### 验证

- `npm run test:run`：46 文件 / 486 用例全绿（新增 `inputCompatibility.test.ts` 13 例）。
- `npm run build` 通过；`cargo check --all-targets` 通过；`cargo test --lib db::` 145 通过
  （含 `migration_43_adds_profile_ssh_input_compatibility`、`ssh_input_compatibility_roundtrip`）。
- 端到端（debug 版 + CDP + 129）：开启主机开关 → 重连 → `cat > /tmp/termx-ime-31.txt` →
  粘贴 `中文兼容测试` → 远端 `cat` 回读完整无丢字，终端正常渲染 CJK 宽字符；
  取证 `evidence/ime-compat-31.json`（`passed: true`，`flagInSession: true`）与截图
  `evidence/ime-compat-31-terminal.png`。旧库已备份 `~/.rssh/rssh.db.bak-20261105-ime`。

### 踩坑 / 边界

- Tauri 冻结 `window.__TAURI_INTERNALS__`，页面内替换 `invoke` 做「ssh_write 调用计数」
  （`Page.addScriptToEvaluateOnNewDocument` 注入）无效；逐码点拆分改由 13 条纯函数单测
  覆盖，端到端只断言「配置生效 + 文本完整送达」。JSON 里 `ipcCounterBlocked: true`。
- Unicode 宽字符：xterm 默认 Unicode provider 已覆盖 CJK 全角宽度（Netcatty 也未启用
  unicode11 addon），本轮以 129 实测中文回显完整作为核验，不再引入额外 provider。

---

## 2026-11-05 — P2 #31（子项：本地压缩包快捷解压）

### 对照（Netcatty）

- `electron/bridges/sftpBridge/archiveExtract.cjs` + `localFsBridge.cjs`：本地解压与远端解压共用
  格式判定，tar 系 / zip 交给系统 `tar`，单文件 `.gz` 用 zlib inflate，bz2 / xz 走外部解码器；
  产物落在归档所在目录（不是另建子目录）。

### 修改点

1. `src-tauri/src/sftp/archive.rs`：新增 `LocalExtractPlan` / `LocalSpawnPlan` /
   `build_local_extract_plan(path, platform)`，按扩展名给出「系统命令参数」或「单文件解压」方案。
2. `src-tauri/src/commands/localfs.rs`：新增 `local_extract_archive(path)`（校验普通文件 →
   构建方案 → 执行）；`run_local_spawn` 用 `tokio::process::Command` 参数数组、120s 超时、
   stderr 截断 16KiB、`kill_on_drop`；bz2/xz 走 staging 文件 + 成功改名，`.gz` 走 flate2。
   错误码 `local_extract_unsupported` / `local_extract_failed` / `local_extract_binary_missing`。
3. 双注册：`lib.rs` 的 `generate_handler!` 与 `server.rs` 的无头 dispatcher 均加
   `local_extract_archive`（R4）。
4. 前端：`client.ts` 增 `localExtractArchive`；`sftpModel.ts` 增 `canExtractLocalArchive`
   （本地连接 + 可识别归档）；`SftpPaneView` 行右键加「解压到当前目录」（本地归档时显示，
   不受 `isRemote` 限制），完成后刷新列表；`sshErrors.ts` 补三条中文文案。
5. `Cargo.toml` 增 `flate2 = "1.1.9"`（Cargo.lock 已有同版本传递依赖）。

### 验证

- `npm run test:run`：45 文件 / 473 用例全绿（含新增 `SftpPaneView.test.tsx` 2 例）。
- `npm run build`（tsc --noEmit + vite）通过；`cargo check --all-targets` 通过。
- 端到端实测（debug 版 + CDP，夹具 `C:\Users\tianzry\termx-local-extract-fixture`）：
  SFTP 页左栏「浏览本地文件」→ 进入夹具目录 → `sample.tar.gz` 行右键 →
  菜单出现「解压到当前目录」→ 点击后列表刷新出现 `hello-local.txt`，
  落盘内容 `local-extract-31-ok`，原归档仍在。取证：`evidence/local-extract-31.json`
  （`passed: true`，`leftRowsAfter: ["..","hello-local.txt","sample.tar.gz"]`）与截图
  `local-extract-31-menu.png` / `local-extract-31-after.png`。

### 踩坑

- **行右键菜单被空白菜单覆盖**：`openBlankMenu` 绑在列表容器上，行 `onContextMenu`
  冒泡后父容器再 `setMenu({row:null})`，导致行菜单永远显示为「刷新/新建文件夹/新建文件」。
  修复是在 `openBlankMenu` 里 `closest("[data-sftp-row]")` 放行；已补组件级回归测试
  （真实 `fireEvent.contextMenu(row)` 走冒泡路径）。
- e2e 首跑报 `Command local_extract_archive not found`：debug 二进制早于新 command 编译，
  需先 `cargo build --no-default-features` 再启动（前端由 1420 dev server 提供，改前端无需重编）。

---

## 2026-11-05 — P2 #38 会话快照迁移（核定 ⏸，无代码改动）

### 对照（Netcatty）

- `requestTerminalSessionSnapshot` / `onTerminalSessionSnapshotRequest` /
  `respondTerminalSessionSnapshot` / `applyTerminalSessionSnapshot`
  （`types/global/netcatty-bridge-session.d.ts` L432-L474）不是「跨窗口 / 重启」能力。
- 唯一调用方是 AI 观察弹窗的 `attachExistingSession`：
  `components/terminal/useTerminalEffects.ts` L693-L721 先
  `acquireSessionFlowPauseLease()` 暂停并排空输出，再请求快照、rebind 输出到弹窗
  renderer、最后恢复；`components/Terminal.tsx` L1668-L1711 注释明确
  「Home renderer for AI observe popups」。
- 输出重绑由 Electron 主进程维护 webContents 归属与授权码：
  `electron/bridges/terminalBridge.cjs` L210-L247（`resolveSessionHomeWebContentsId` +
  `isAuthorizedAttachIpc`）。应用重启后会话进程已消失，快照不会持久化到磁盘。

### termX 现状与阻塞（源码层）

1. 快照 API 的消费方是 AI 观察弹窗，而 AI 侧栏 #27 按 `docs/plan.md` 暂缓，termX 无调用场景。
2. termX 后端没有窗口级输出归属：每块 SSH 数据走 `AppHandle::emit`
   （`src-tauri/src/ssh/client.rs` L2125、`src-tauri/src/emitter.rs` L65），Tauri 的
   `Emitter::emit` 文档与实现都是「Emits an event to all targets / all webviews」
   （`tauri-2.12.5/src/lib.rs` L961-L978）；`emit_to` 存在，但 termX 未记录会话所属窗口。
   同时缺少 Netcatty 的 flow pause / drain，无法在「取快照 → 新 renderer 接管」之间
   保证字节不丢、不重复。
3. 「重启恢复」不可达：`AppState.sessions` / `pty_sessions` 均为进程内 `HashMap`
   （`src-tauri/src/state.rs` L74-L82），进程退出即销毁；若只恢复文本快照，
   与 Netcatty 的实际行为也不一致。

### 结论

- #38 标记 **⏸ 暂缓**，不新增假入口。若启动 #27，需单独立项「会话输出路由 + 暂停排空 +
  快照传输」子系统（覆盖 ssh / pty / serial / telnet），再做观察弹窗接管。
- 本轮无代码改动；未跑门禁（无前端/Rust 变更），仅提交 `todo.md` 与 `changelogs.md`。

### 踩坑

- 判定可行性先看调用方：桥接方法名很像「窗口迁移」，但全仓只在 `attachExistingSession`
  路径使用；不能凭 API 名称推断需求。

---

## 2026-11-05 — P2 #31 终端细节增强（子项：SFTP 跟随终端目录）

### 对照（Netcatty）

- `sftpFollowTerminalCwd`（全局设置，档案可覆盖）：SFTP 侧栏可见、已连接、无进行中传输时
  可被终端 cwd（OSC 7）带过去；handled / blocked 记忆避免用户手动浏览后被反复打回；
  `resolveTerminalCwdForSftp` 负责 `~` 展开。
- termX 的 OSC 7 钩子与菜单标题回显已在前一轮完成，缺的是「把 cwd 交给 SFTP」。

### 修改点

1. 新增纯函数模块 `src/domain/sftpFollowCwd.ts`（+ 4 组单测）：`shouldFollowTerminalCwdNavigate`
   （跟随开关 / 已连接 / 传输在跑 / handled / blocked / 同目录）、`resolveTerminalCwdForSftp`、
   `isSftpFollowTargetPath`、`guessUnixHomeDirFromPath`。
2. `PaneHandle` 增 `cwd()` / `subscribeCwd`：`TerminalPane` 用 `cwdRef` + 订阅者集合镜像 OSC 7 目录，
   `App` 订阅活动窗格并透传给 `SftpPanel`。
3. `SftpPanel` 增 `terminalCwd` 入参与跟随效果：首次进入优先终端目录（不可达回退 home 并记 blocked），
   之后 cwd 变化导航过去；`refresh()` 改为返回成功与否供回退判断。
4. 设置中心 SFTP tab 的「追随终端目录」由置灰改为真实开关（默认关，对齐 Netcatty）；
   `settingsModel` 增 `sftpFollowTerminalCwd`（含读取兜底）。

### 验证

- `npm run test:run`：44 文件 / 468 用例全绿（含新增 `sftpFollowCwd.test.ts`）。
- `npm run build`（tsc --noEmit + vite）通过。
- 端到端复检（2026-11-05，129 + CDP 驱动的 debug 版）：临时关闭应用锁并开启跟随开关（结束后均已恢复）。
  远端用 `printf '\033]7;file://%s%s\007' "$HOSTNAME" "$PWD"` 上报 OSC 7；SFTP 面板首进
  `/home/tianzry`，终端 `cd /tmp` 后自动跟到 `/tmp`。取证：`evidence/sftp-follow-129.png`
  与 `evidence/sftp-follow-129.json`（`firstOpenPath` / `followedPath` / `passed: true`）。
- 复检 v2（同日，按用户指定 ST 结尾 `printf '\033]7;file://%s%s\033\\' "$HOSTNAME" "$PWD"`）：
  首进 `/home/tianzry` → `cd /tmp` 跟到 `/tmp` → **真实上传 64 MiB 期间** `cd /var` 并上报 OSC 7，
  SFTP 仍停在 `/tmp`（传输行 running 44%），取消传输后自动跟到 `/var`。
  取证：`evidence/sftp-follow-129-v2.json`（`passed: true`）与三张截图
  `sftp-follow-129-cd.png` / `-transfer-block.png` / `-after-transfer.png`。
  「不抢目录」不再只靠单测：传输由原生「打开文件」框真实发起，
  用 UIA 定位 `#32770` 对话框的文件名控件（AutomationId 1148）后 Alt+N 填入路径并确认
  （脚本 `evidence/fill-open-dialog.ps1`）。

### 踩坑

- `subscribeSettings` 回调类型是零参 `Listener`，写成 `(s) => ...` 会 TS2345；需在回调内自行 `getSettings()`。
- 改 cwd 入口要一次性收敛到 `applyCwd()`（状态 + 镜像 + 通知），否则状态与句柄读取值会分叉。
- 原生「打开文件」框自动化：DirectUI 控件在 UIA 里 `ControlType` 是 `Pane`，不能按 Edit/Button 过滤，
  要按 `AutomationId`（文件名 1148）+ `ClassName`（Edit/Button）定位；找不到对话框就必须直接退出，
  绝不能盲发按键。
- PowerShell 5.1 读取 UTF-8 无 BOM 的脚本时中文注释会干扰后续行解析（表现为 `$uiaDir` 为 null），
  evidence 辅助脚本保持纯 ASCII。

---

## 2026-11-05 — P1 #39 SSH Agent 转发（exec 通道补齐）+ #37 Vault 子页收尾

### 对照（Netcatty）

- `agentForwarding`：连接时在会话通道请求 `auth-agent-req@openssh.com`，远端 sshd 据此为
  该会话建 agent socket；等价 `ssh -A host cmd`。
- termX 的 shell 通道（`client.rs` 开 shell 处）早已按档案开关请求；但 `exec_once` 漏了这一步，
  `ssh_exec` / 归档解压 / 监控采样 / 插件 exec 都走 exec，等于 `-A` 语义缺失。

### 修改点

1. `exec_once` 增加 `agent_forwarding` 参数，为 true 时在 session 通道上发 `agent_forward(false)`；
   `ssh_exec` 从 `session.profile_id()` 读档案开关传入；连接自检 / 监控 / 归档解压 / 插件显式 `false`。
2. #37 核对收尾：`VaultView.tsx` 的 monitor / notes / logs / proxies 四项 nav 均已启用且视图已挂载，
   monitor 自 #14 即可用，原先「仅 monitor 仍为禁用占位」的描述过期，条目关闭。

### 实测（129，CDP）

- 临时把 129 档案 `agent_forwarding` 置 true → `ssh_exec 'echo ${SSH_AUTH_SOCK:-EMPTY}'`
  返回 `/tmp/ssh-<random>/agent.<pid>`；改回 false → `EMPTY`；`finally` 已把档案恢复原值（false）。
- 证据：`evidence/agent-forward-live.json`（`passed: true`，`restored.agent_forwarding: false`）。

### 置灰（未验，写明原因）

- **桥接的端到端**（远端 `ssh-add -l` 真正取到本机身份）：本机 Windows `ssh-agent` 服务为
  Stopped/Disabled（启动需管理员），且无 Pageant；只能验到「请求发出 → sshd 建 socket」。
  handler 侧的 `server_channel_open_agent_forward` 桥接代码此前已在位。
- 认证直接走 agent 与钥匙串 agent 身份列表属钥匙串阶段既有实现，本轮未改动。

### 门禁

- `cargo check --features server` ✓；`cargo build`（GUI bin）✓。前端未改，未跑 vitest/build。

### 踩坑

1. `ssh_connect` 的 `sessionId` 必须是 UUID，自造 `af-on-<ts>` 直接报 `session_id_invalid`。
2. 应用在 CDP 断开后会自动退出：必须「重启 → 轮询 9222 → 跑脚本」写进同一条命令。
3. 实测要临时改真实档案字段时，`finally` 必须恢复原值（本轮已回写并复核 false）。

---

## 2026-11-05 — P1 #26 CLI（片段 CRUD + 直连 SFTP 传输；会话操作置灰）

### 对照（Netcatty）

- `electron/cli/netcatty-tool-cli.cjs`：命令是「运行中应用」的 RPC 客户端
  （`netcattyRpcClient.cjs`）；`sftp <op>` 必须 `--session <id>`，会话与传输都依赖
  Electron 主进程里的活动会话；vault/forward/snippet/notes 由 capability catalog 派发，输出 `--json`。
- termX 已有 `rssh` CLI（`rssh-cli`，`--features cli`）：profile / credential / forward /
  group / config / `profile open`，但无片段、无传输。

### 修改点

1. `commands/snippet.rs`：`rssh snippet list|show|add|rm`，直接读写 `~/.rssh/snippets.json`
   （与 GUI 同一份数据）。`filter_snippets` 纯函数覆盖 name / command / package / tags，
   大小写不敏感；`add` 非交互（`--description` / `--package`），重名报 `snippet_exists`。
2. `commands/sftp.rs`：`rssh sftp ls|get|put`，复用 lib `SftpHandle::connect`（密码/私钥均从
   SecretStore 取，非交互；下载走 `download_to_path` 流式落盘，上传走 `upload` 覆盖写），
   支持档案内联代理字段。`lib.rs` 的 `ssh` 模块改 `pub` —— bin 是独立 crate，必须经 lib 公共面取。
3. 129 实测：`sftp ls 129 /tmp` 正确列出 33 项；`put` 33B → `get` 回本地，两端 SHA256
   完全一致（`37468CC2…59F42`）。

### 置灰（未做，写明原因）

- **会话级操作**（`session list/read/write/send`）：Netcatty CLI 靠 `netcattyRpcClient.cjs`
  连运行中应用的 TCP 桥；termX 桌面端没有对外 RPC 桥（只有 `--features server` 的 headless
  WS，需另起进程并共享 DB/SecretStore），本轮不伪造入口。
- **`--json` 输出 / `--session` 语义**：与上一条绑定，单独做没有意义。
- **跳板链与代理库条目**：`SftpHandle::connect` 只收单一代理配置；CLI 传输只应用档案内联代理字段，
  `proxy_profile_id` 与 bastion 链未接（GUI 的 SFTP 面板走的是另一条连接路径）。

### 门禁

- `cargo build --features cli --bin rssh-cli` ✓；`cargo test --features cli --bin rssh-cli` 7/7 ✓
  （新增 1 例）；`cargo check --features server --bin rssh-server` ✓。前端未改，未跑 vitest/build。

### 踩坑

1. PowerShell 的 `$home` 是只读自动变量，用它赋临时 HOME 会静默失败，实测写进了真实
   `~/.rssh/snippets.json`；已 `snippet rm` 清理，并用 `$u` 在隔离目录重测写入路径。
2. bin 是独立 crate，`lib.rs` 的 `mod ssh` 私有 → `SftpHandle` / `ProxyConfig` 不可达
   （E0603 连带报出 E0282 类型推断错误）；改 `pub mod ssh` 后一次通过。

---

## 2026-11-05 — #24 尾巴（解压菜单按连接类型隐藏）+ P1 #25 文件名编码（置灰）

### 对照（Netcatty）

- `domain/models/sftp.ts`：`SftpFilenameEncoding = "auto" | "utf-8" | "gb18030"`。
- `electron/bridges/sftpBridge.cjs` L103-L189：`iconv.encode(path, encoding)` 把非 ASCII
  路径编成目标字符集字节再发给 SFTP；`iconv.decode(rawName)` 解码远端返回的原始文件名；
  `auto` 靠「列表出现非 UTF-8 字节」判定 gb18030，否则沿用上一次结果。

### 修改点

1. #24 尾巴：`RemoteConnection` 增加 `canExec`（终端会话派生 = true，独立 SFTP 连接 = false），
   新增纯函数 `canExtractArchive(connection, name)`；右键菜单改为「远端 + 有 exec 通道 +
   归档后缀」三条件才显示「解压到当前目录」，独立连接不再出现该入口（不再点了才报
   `sftp_extract_no_ssh`）。`archive.test.ts` 补 3 例（会话派生显示 / 独立连接隐藏 / 本地与非归档隐藏）。
2. #25 **未实现，保持置灰**：后端 SFTP 用 `russh-sftp 2.1.1`，协议层把路径与文件名固定成
   Rust `String`（`client/session.rs` 一路 `Into<String>`），解码处 `try_get_string` 明确调用
   `String::from_utf8_lossy`（`src/buf.rs:22-26`）——非 UTF-8 的 GBK 文件名在**列表阶段**
   就已经被替换为 U+FFFD，原始字节不可恢复；发送侧也只能把 UTF-8 字符串再写成 UTF-8 字节，
   无法构造 GBK 字节路径。`russh-sftp 3.0.1` 仍是同一 lossy 解码（`src/buf.rs:23`），升级无解。
   要真实支持必须 fork/补丁协议层（路径按 `Vec<u8>` 透传），超出本轮范围。
   主机档案的 `sftp_encoding` 字段与保存链路保留（schema 已有），主机表单不暴露该下拉，
   避免留下不生效的假入口。

### 门禁

- vitest 464 ✓（新增 3 例）/ `npm run build` ✓；本轮无 Rust 改动，未跑 cargo check。

### 踩坑

1. **文件名字节不是字符串**：SFTP 协议里路径就是字节；crate 一旦 lossy 解码，GBK 原始字节即丢失，
   在 termX 侧再做一次 `iconv` 也补不回来——判定可行性前先看协议层的类型，而不是看上层 API 名字。

---

## 2026-11-05 — P1 #24 SFTP 归档解压

### 对照（Netcatty）

- `electron/bridges/sftpBridge/archiveExtract.cjs` + `useSftpViewFileOps`：文件右键「解压」，
  在**远端原地**执行 `tar` / `unzip` 构造命令，超时按文件大小放大；单文件 gz/bz2/xz 解到
  去后缀文件（先写临时文件再 `mv`）。
- 依赖父 SSH 会话的 exec 通道；纯 SFTP（单通道）无法解压。

### 修改点

1. 新增 `src-tauri/src/sftp/archive.rs`：后缀识别（tar / tar.gz / tgz / tar.bz2 / tbz2 /
   tar.xz / txz / tar.zst / tzst / zip / gz / bz2 / xz）、POSIX 父目录、单引号转义、
   各格式命令构造、60s–600s 超时；5 个单测（含引号注入路径 `it's.tar.gz`）。
2. `commands/sftp.rs` 新增 `extract_archive` 核心 + `sftp_extract_archive` 命令：
   取 `parent_ssh_id` → 复用该 SSH 会话 exec；独立 SFTP 返回 `sftp_extract_no_ssh`；
   非 0 退出码返回 `sftp_extract_failed`（带 stderr 截断）。
3. `lib.rs` / `server.rs` 双注册（R4）。
4. 前端：`client.ts` 增加 `sftpExtractArchive`；`sftpModel.ts` 增加 `isExtractableArchive`；
   SFTP 文件右键菜单在归档上出现「解压到当前目录」，成功后刷新目录；`sshErrors.ts`
   新增 4 个 code 的中文映射；新增 3 例纯逻辑单测。

### 实测（129 真机）

- `evidence/sftp-extract-live.json`：`ssh_connect(129)` → `sftp_connect_session` →
   建 `/tmp/termx-extract-*` → 上传 `sample.tar.gz` → `sftp_extract_archive` 返回
   `exit_code=0` → 目录出现 `hello-termx24.txt`（23B）→ 下载读回内容为
   `termx-extract-ok-24`（首字节 BOM 为 PowerShell 夹具造成）。
- 负例：对 `not-an-archive.txt` 调用返回 `sftp_extract_unsupported`。
- 限制（如实记录）：独立 SFTP 连接（无父 SSH 会话）无 exec 通道，点击会给出
  明确错误「独立 SFTP 连接没有 SSH 命令通道…」；UI 未按连接类型隐藏菜单项。

### 门禁

- vitest 461 ✓ / `npm run build` ✓ / `cargo check --features server` ✓ / `cargo test --lib`（archive 6 例）✓

### 踩坑

1. **JS 手写 ustar 头容易生成`tar: This does not look like a tar archive`**：实验夹具改用系统
   `tar -czf` 生成，脚本通过 `ARCHIVE_PATH` 注入。
2. **PowerShell `Set-Content` 会写 UTF-8 BOM**，读回内容比较时不要把 BOM 当功能缺陷。
3. 单实例应用在 CDP 断开后偶发退出；自动化前必须重启并等待 7s。

---

## 2026-11-05 — P1 #23 应用锁 + 凭据加密存储验收

### 语义对照（Netcatty）

- 应用锁 = **用户自设的锁定口令**：`domain/appLock.ts` 生成 PBKDF2-SHA256 校验器
  （≥100k 迭代、16B salt、32B hash，明文口令不落盘），`appLockLifecycle` 在启动/回前台时
  show overlay，`AppLockSettingsSection` 提供启用/改密/超时。
- 另有「系统凭据解锁」（Touch ID / Windows Hello），由 **Electron 原生 helper** 实现；
  termX（Tauri）没有对应原生桥 → 该控件**置灰**，行内写明原因。

### 修改点

1. **后端** `src-tauri/src/app_lock.rs`（新增）：
   - `AppLockVerifier{version,algorithm,iterations,salt,hash}` 存 `db.settings.app_lock_verifier`；
     `pbkdf2` + `sha2` + `getrandom` 生成，恒时比较校验。
   - `state/set_password/disable/unlock/set_enabled/set_timeout_minutes`；
     无校验器时 `enabled` 强制视为 false，避免「锁住但无法解锁」死锁。
   - 7 个单测：正确/错误口令、哈希非明文、改密需当前口令、空口令拒绝、关闭清校验器、
     开关需先有口令、超时合法性、校验器缺失不锁。
2. **命令层** `commands/app_lock.rs`（6 命令）+ `lib.rs` 注册；
   桌面 UI 门无 headless 语义，`server.rs` 不转发（R4 例外已注释）。
3. **前端** `src/appLock/appLockState.ts`（store + `shouldLockAfterReturn` 纯逻辑）、
   `src/appLock/AppLockGate.tsx`（全屏遮罩，启动锁 / 失焦按超时锁 / 手动锁 /
   锁定时吞掉遮罩外快捷键）。
4. **设置中心** 系统 tab 末尾「应用锁定」：启用开关、超时（0/1/5/15/30/60）、
   设置/更换/关闭（内联表单，关闭需当前口令）、立即锁定、系统凭据解锁置灰+原因。
5. **i18n** 中英新增 `settings.appLock.*` / `appLock.*`；删除旧的「应用锁未移植」占位。
6. `client.ts` 增加 6 个封装 + `AppLockState`（结构体字段保持 snake_case）。

### 实测（debug exe + CDP，证据 `evidence/`）

- `applock-phase1.json`：设置口令→`enabled=true`；reload（冷启动语义）后遮罩出现；
  错误口令 `wrong-pass-123` → 遮罩保持、错误文案「锁定密码不正确。」；
  正确口令 → 遮罩消失；模拟失焦→回前台（超时=0）→ 再次上锁，正确口令解除。
- `applock-startup.json`：**进程重启**后仍锁定，错误口令拒绝，正确口令进入。
- 截图：`applock-startup-locked.png`、`applock-wrong-password.png`、`applock-unlocked.png`、
  `applock-return-locked.png`。
- 凭据取证 `applock-db-forensics.json`：写入 `secret=PLAINTEXT_PROBE_9f3a` 的 password 凭据后，
  直接按字节扫描 `~/.rssh/rssh.db` 与 `rssh.db-wal`：
  `plaintext_secret_found=false`、`lock_password_found=false`、`cipher_prefix_found=true`；
  WAL 中可见凭据行（name/user/type），密文以 `enc:v1:` 存储。

### 门禁

- `npx vitest run` 458 ✓（新增 6 例 app lock 纯逻辑）
- `npm run build` ✓
- `cargo check --features server` ✓
- `cargo test --lib` 897 ✓（`commands::plugin::local_exec_caps_output...` 首跑偶发失败，
  单跑通过，与本改动无关）

### 踩坑

1. **debug 构建 PBKDF2 120k 迭代非常慢**（未优化 SHA256，单次数秒）。CDP 实测必须轮询
   按钮 `disabled` 状态，固定 sleep 会把「正在解锁…」误判为卡死。
2. **SQLite 文件被应用占用**：直接 `ReadAllBytes` 会失败；用 `FileStream` 以 `ReadWrite`
   共享方式读，且**别忘了 WAL**——刚写入的凭据行在 `rssh.db-wal` 里，只查主库会看不到。
3. **锁定遮罩的快捷键隔离**：capture 阶段吞掉事件要跳过遮罩内部目标
   （`closest('[data-app-lock-overlay]')`），否则密码框收不到键盘。
4. **单实例/CLI 重复启动**会让自动化连不上 9222，重启前必须 `Stop-Process rssh,msedgewebview2`。

---

## 2026-10-29 — 阶段 0 POC：最小可运行骨架

目标：以 **rssh 的 Rust 后端（Tauri 2）** + **netcatty 的 React 前端（Vite）**，搭一个最小可运行骨架，
跑通 **SSH 连接** 与 **本地终端 PTY** 两条链路。

### 修改点

1. **后端**：整份复制 `rssh/src-tauri/`（113 个 Rust 源文件，与 rssh 逐字节一致）到 `termX/src-tauri/`，排除构建产物 `target/` 与生成目录 `gen/`。
   - `tauri.conf.json` 仅改 3 处：`productName` → `termX`、`identifier` → `com.termx.app`、窗口 `title` → `termX`。
   - `Cargo.toml` / crate 名（`rssh` / `rssh_lib` / bin `rssh`）**保持不变**，避免改动 `main.rs` 的 `rssh_lib::run()` 及大量内部引用；POC 阶段刻意不做 rename 扩散（后续阶段再迁）。
2. **前端（React + Vite）**：新建根目录前端工程，替换 rssh 原来的 Svelte 前端。
   - `package.json`：React 19 + `@tauri-apps/api` v2 + `@xterm/xterm` 6.0 + `@xterm/addon-fit`。
   - `vite.config.ts`：端口 1420 / `build.target = "es2021"`，与后端 `devUrl` / `frontendDist="../dist"` 对齐。
   - `src/ipc.ts`：桥接层（**NFC**），封装 `invoke` / `listen` + base64 编解码，覆盖 `pty_spawn/write/resize/close`、`create_credential/create_profile/ssh_connect/ssh_write/ssh_resize/ssh_disconnect`。
   - `src/Terminal.tsx`：单例 xterm 画布（创建即 fit + focus，卸载清理）。
   - `src/App.tsx`：最小 UI —— 「本地终端 (PTY)」+「SSH 连接」两条入口，共用一块 xterm；SSH 走临时建 credential + profile 的最小流程。
3. **其它**：`index.html`、`tsconfig.json`、`src/styles.css`、`.gitignore`。
4. **后端新增两条无 GUI 冒烟测试**（为建立"每次改动可在沙箱验证"的闭环，`#[cfg(test)]` 不影响正式构建）：
   - `src-tauri/src/terminal/pty.rs`：`local_pty_write_roundtrip` —— `/bin/cat` 回显，验证 write→PTY→读取线程→sink 整条本地终端链路。
   - `src-tauri/src/ssh/client.rs`：`ssh_connect_to_local_sshd_roundtrip` —— 本地 sshd + 私钥认证 + shell 回显，验证完整 SSH 链路（未设 env 时静默跳过）。

### 验证

- 前端：`npm run build`（`tsc --noEmit` + `vite build`）**通过**（37 模块，1.5s）。
- 后端编译：**系统依赖问题已解决**，`cargo check` **通过**（4m33s，6 个既有 dead_code warning，0 error）。
- 运行时（**两条链路，无 GUI 在沙箱内真实跑通**）：
  - 本地终端：`cargo test --lib -- local_pty_write_roundtrip` → **ok**。
  - SSH 连接：对本地 `sshd:2222` + 密钥认证，`cargo test --lib -- ssh_connect_to_local_sshd_roundtrip` → **ok**。
  - 汇总：`2 passed; 0 failed; 0 ignored`（0.26s）。
- 未做：完整 `tauri dev` GUI 启动（需显示器 + WebKit 渲染；引擎层已被上面两条测试覆盖，非本次目标）。

### 无 GUI 验证方法（后续每次改动都走这套，可复现）

1. **编译门禁**（每次改动必做）：
   ```bash
   npm run build                      # 前端 tsc --noEmit + vite build
   cd src-tauri && cargo check        # 后端 type-check
   ```
   > 系统依赖一次性安装（否则 build script 报 `glib-2.0.pc ... not found`）：
   ```bash
   apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
     libjavascriptcoregtk-4.1-dev libudev-dev librsvg2-dev libssl-dev
   ```

2. **两条链路运行时冒烟**（无需显示器，真跑引擎）：
   ```bash
   # 本地终端
   cd src-tauri && cargo test --lib -- local_pty_write_roundtrip
   # SSH（需先拉起本地 sshd，见踩坑 9）
   cd src-tauri && TERMX_SSH_TEST_PORT=2222 TERMX_SSH_TEST_USER=root \
     TERMX_SSH_TEST_KEY=/tmp/termx_client_key \
     TERMX_SSH_TEST_KNOWN_HOSTS=/tmp/termx_known_hosts \
     cargo test --lib -- ssh_connect_to_local_sshd_roundtrip
   ```
   > 原理：rssh 引擎是 `Host` 抽象（Tauri / Headless 双实现），`test_support::headless_host()` 提供内存 Db + 内存 SecretStore + 事件 sink，直接驱动 `pty::spawn` / `client::connect`，因此彻底绕开 GUI 与显示器。

### 踩坑经验（务必记住）

1. **嵌套 struct 字段走 serde snake_case，不经过 Tauri 顶层 camelCase 转换**。
   `invoke("create_credential", { credential: {...} })` 这种嵌套参数，Tauri 只把顶层参数名（`credential`）做 camelCase↔snake_case 映射，对象内部字段按 Rust `serde` 原样解析。
   所以 `Credential.save_to_remote`、`Profile.credential_id / bastion_profile_id / init_command / group_id` 必须用 **snake_case** 键名，不能写成 `saveToRemote` / `credentialId`。写成驼峰会静默取默认值（bool 变 false / Option 变 None），SSH 连不上还报不出清晰错误。
2. **终端字节流统一走 base64 文本事件**，收包要 `atob` 解码成 Uint8Array；**写入**则是 JSON 数字数组（`Array.from(new TextEncoder().encode(text))`）作为 `Vec<u8>`。别把二者搞反（写成 base64 传入执行会乱码）。
3. **xterm 6.0 的 esbuild 降级 bug**：`vite build` 的 `target` 必须 ≥ `es2021`，否则 minify 后 `requestMode` 里的 `let r` 声明被丢，vim/htop 等 TUI 一查 DECRQM 就 ReferenceError。这条从 rssh 前端直接继承。
4. **React StrictMode 会双跑 effect**，导致本地 PTY 被 spawn 两次。POC 阶段先不加 `<React.StrictMode>`（生产构建无影响，但 dev 手测会复现）。
5. **复制 Rust 后端时排除 `target/` 与 `gen/`**：`target` 是编译缓存（体积巨大），`gen` 是 tauri-build 生成的 schema，都会在本地重新生成，不应入库。
6. **Tauri Linux 后端编译依赖系统 GTK/WebKit dev 包**：`cargo check` / `cargo build` 会先跑 `glib-sys`、`gtk-sys`、`webkit2gtk-sys` 的 build script，靠 `pkg-config` 找 `glib-2.0.pc` / `gtk+-3.0.pc` / `webkit2gtk-4.1.pc`。这些 `.pc` 文件缺失时直接报 `system library glib-2.0 ... not found`，与代码无关。裸 CI 沙箱通常没装，需要在本地/带依赖的环境跑。
7. **无 GUI 验证靠 rssh 的 `Host` 抽象，而不是"起显示器跑 tauri dev"**：`test_support::headless_host()` 用内存 Db + 内存 SecretStore + 事件 sink 就能驱动 `pty::spawn` / `client::connect`，比 GUI 手测可靠且能在 CI 跑。这是本轮最关键的方法论。
8. **SSH 冒烟测试的 known_hosts：直接喂 russh 一个 OpenSSH 格式文件**。先 `ssh-keyscan -p <port> 127.0.0.1 > known_hosts` 生成；同时把 `prompt_session_id: None` 传进 `ConnectParams`，未知主机才会走"已知主机 → 直接接受"，否则会卡在弹窗交互（headless 下直接拒绝）。
9. **本地 sshd 起法（无 systemd 的沙箱）**：先 `ssh-keygen -A` 生成 host key，再 `/usr/sbin/sshd -p 2222 -o PasswordAuthentication=no -o PubkeyAuthentication=yes -o PermitRootLogin=yes -o StrictModes=no`；客户端密钥 `ssh-keygen -t ed25519 -N ''`，公钥 append 到 `/root/.ssh/authorized_keys`。
10. **依赖"外部服务"的测试用环境变量注入 + 静默跳过**：`TERMX_SSH_TEST_PORT/USER/KEY/KNOWN_HOSTS` 没设置就直接 `return`，保证没有 sshd 的裸 `cargo test` 也全绿，不绑架 CI/本地开发。
11. **`cargo check` 与 `cargo test` 都会跑 build script**：缺失 GTK/WebKit dev 包时二者同样在 `glib-sys` 报错。所以"先装齐系统依赖、让 `cargo check` 过"是"能 `cargo test` 跑运行时冒烟"的必要前提。

---

## 2026-10-29 — 阶段 1：核心传输链路（前端接线）

目标（阶段 1）：在 POC 骨架之上，把 **SSH 三种认证（password/key/interactive）+ 交互问答
（keyboard-interactive / passphrase / host-key 三个 prompt）+ SFTP 文件面板** 接入前端，
对齐 `window.netcatty` 的服务面。本轮先落前端接线，后端补缺（`ssh_exec` / 退出状态 / `sftp_chmod`）
放下一小步。

### 修改点

1. **新建 `src/backend/client.ts`**（NFC 桥接层，取代并形变旧 `ipc.ts`）：
   - 类型对齐 netcatty：`Credential{id,name,username,type,secret,save_to_remote}`、
     `Profile{id,name,host,port,credential_id,bastion_profile_id,init_command,group_id,algorithms?}`、
     `RemoteEntry{name,is_dir,is_symlink,size,mtime}`、`FileStat{...permissions?:u32}`、`AuthPrompt`。
   - SSH：`sshConnect/sshWrite/sshResize/sshDisconnect`；**新增 `newSessionId()` + `sshConnect(..., sessionId?)` 可注入**。
   - 三个 prompt：`sshAuthRespond/Cancel`（key=tabId）、`sshPassphraseRespond/Cancel`、`sshHostKeyRespond/Cancel`，
     事件 `onAuthPrompt/onPassphrasePrompt/onHostKeyPrompt`（listen `ssh:{auth,passphrase,host_key}_prompt:{sid}`）。
   - PTY：`ptySpawn/ptyWrite/ptyResize/ptyClose`；事件 `onTerminalData`（atob 解码）/`onTerminalClose`。
   - SFTP：`sftpConnect/sftpConnectSession/sftpHome/sftpList/sftpDownload/sftpUpload/sftpMkdir/sftpRemove/sftpRename/sftpStat/sftpClose`。
   - 占位 `sshExec`：后端 `exec_once` 尚未注册为 command，先 `throw`（下一小步补 `ssh_exec`）。
2. **重写 `src/App.tsx`**：接入 client.ts。
   - SSH 表单支持 **password / key / interactive** 三种认证（key 粘 PEM，interactive 提示走弹窗）。
   - 三个交互 prompt 弹窗（keyboard-interactive 多问、passphrase、host-key 指纹）。
   - 工具栏新增「文件传输 (SFTP)」切换右侧 SFTP 面板。
3. **新建 `src/SftpPanel.tsx`**：SFTP 文件浏览面板。
   - 「复用当前 SSH 会话」或独立 host/port/user/type/secret 连接。
   - list（目录优先、点目录进入、上级/跳转/刷新）、download（`number[]`→Blob）、upload（`<input type=file>`→Uint8Array）、
     mkdir、rename、delete、stat。
4. **扩展 `src/styles.css`**：`.main` 两栏布局、SFTP 面板、prompt 弹窗等样式。
5. **删除 `src/ipc.ts`**（被 client.ts 取代，避免双源漂移）。

### 验证

- 前端：`npm run build`（`tsc --noEmit` + `vite build`）**通过**（38 模块，1.49s）。
- 后端：本轮无 Rust 改动，`cargo check`/`cargo test` 未重跑（沙箱已有结论：阶段 0 已过）。
- 未做：完整 `tauri dev` GUI 手测（沙箱无显示器）；`sshConnect` 的 prompt 链路、SFTP 链路属运行时验证，留待补缺命令时一起加冒烟测试。

### 踩坑经验（务必记住）

12. **prompt 监听必须在 `sshConnect` 的 `await` 返回前注册好**，否则会丢认证交互事件。
    `ssh_connect` 是一个"连接 + 认证"的整体，认证 pending 期间后端就 emit `ssh:auth_prompt:{sid}` /
    `ssh:passphrase_prompt:{sid}` / `ssh:host_key_prompt:{sid}`。若先 `await sshConnect(...)` 拿到 sid 再 `listen`，
    事件早发完了。所以 client.ts 提供 `newSessionId()` + `sshConnect(..., sessionId?)`，
    前端先 `const sid = newSessionId()` → 注册三个监听 → 再 `await sshConnect(..., sid)`。
    同时后端 `prompt_session_id = requested_session_id.map(|_| session_id)`，**必须传 `sessionId`（非 null）** prompt 通道才启用。
13. **Tauri webview 的 `window.prompt/confirm/alert` 基本不可用**（WKWebView/WebKitGTK 下不弹，静默无返回）。
    SFTP 面板的「新建目录 / 重命名」用**内联 input** 而不是 `window.prompt`，删除直接执行，别依赖原生对话框。
14. **`RemoteEntry` 只回 `name`，全路径要前端自己拼**：`joinPath(dir,name)`，根目录特殊处理——
    `dir === "/" ? "/"+name : dir(去尾斜杠)+"/"+name`，否则会拼出 `//name`。
15. **SFTP 字节方向**：`sftp_upload` 的 `data` 是 `Vec<u8>` → 前端传 `Array.from(uint8array)`（number[]）；
    `sftp_download` 返回 `number[]` → `new Uint8Array(data)` → `new Blob([...])` 触发下载。
16. **已识别的 3 个后端缺口（阶段 1 后续补，勿在上层绕）**：
    - `ssh:close` / `pty:close` 事件目前 emit 空载荷 `()`，**无 exit code / signal**；
    - `exec_once`（`ssh/client.rs`）未注册成 `#[tauri::command]`，缺 `ssh_exec`；
    - SFTP 无 `chmod`（`SftpHandle` 也没有 chmod 方法，`FileStat.permissions` 是 u32 权限位而非 "rwx" 字符串）。

---

## 2026-10-29 — 阶段 1b：补齐后端 3 个缺口

目标：落地阶段 1 里识别的 3 个后端缺口 —— `ssh_exec` 命令注册、`close` 事件带 exitCode/signal、
`sftp_chmod`，并加冒烟测试。

### 修改点

1. **`models.rs`**：新增 `CloseInfo { exit_code: Option<i32>, signal: Option<String> }`
   （两字段都 `skip_serializing_if=None`，close 载荷不出现多余的 null，前端按 `typeof === "number"` 判空）。
2. **`ssh/client.rs`**：
   - `session_task` 里新增 `exit_code`/`signal` 局部变量，新增捕获 `ChannelMsg::ExitStatus`（存 exit_code）
     与 `ChannelMsg::ExitSignal`（存 `signal`）；把 `Eof` 从"break"改为空操作（不 break），只有
     `Close`/`None` 才 break；末尾 `app.emit(close, CloseInfo{exit_code,signal})` 替代原空 `()`。
   - 新增辅助 `ssh_signal_name(&russh::Sig) -> String`，把 russh 的信号枚举还原成短名。
3. **`terminal/pty.rs`**：
   - `PtyOut::Close` 由单元组变体改为 `Close { exit_code: Option<i32>, signal: Option<String> }`。
   - `ChildReaper` 重构为 `shared: Arc<Mutex<Option<Box<dyn Child + Send>>>>`（reader 线程与 reaper 共享），
     新增 `reap_exit_code(&shared)` 用 `take()` 保证子进程只 reap 一次。
   - `spawn_builder`：`_reaper` 用 `Arc<ChildReaper>`（Drop 只在 Arc 计数归零时触发）；
     reader 线程 EOF 后 `reap_exit_code` 再 `sink(PtyOut::Close{exit_code, signal:None})`。
4. **`commands/pty.rs`**：两个 sink 的 `PtyOut::Close => emit(())` 改成
   `PtyOut::Close { exit_code, signal } => emit(CloseInfo{...})`。
5. **`server.rs`**：headless ws 版 sink 同步改成序列化 `CloseInfo` 到 `pty:close` 的 payload。
6. **`ssh/sftp.rs`**：`SftpHandle` 新增 `chmod(&self, path, mode)`，用
   `russh_sftp::protocol::FileAttributes`（只设 `permissions: Some(mode)`，其余全 `None`）+
   `sftp.set_metadata(path, attrs)`。
7. **`commands/sftp.rs`**：新增 `sftp_chmod` 命令。
8. **`commands/session.rs`**：新增 `ssh_exec` 命令（`session_id + command + timeout_ms`），
   内部 `get_session` → `session.ssh_handle().clone()` → `run_blocking_ssh(exec_once)`，
   返回 `PluginExecResult{stdout,stderr,exit_code}`；`timeout_ms` 缺省 10s、clamp [1s,60s]。
9. **`lib.rs`**：`generate_handler!` 注册 `session::ssh_exec` 与 `sftp::sftp_chmod`。
10. **前端 `backend/client.ts`**：
    - `onTerminalClose` 由 `cb: () => void` 改为 `cb: (info: CloseInfo) => void`；新增 `CloseInfo` 接口。
    - `sshExec` 由占位 throw 改为真实 `invoke("ssh_exec", { sessionId, command, timeoutMs })`，
      返回 `{ stdout, stderr, exit_code }`。
    - 新增 `sftpChmod(sftpId, path, mode)`。
11. **前端 `App.tsx`**：`onTerminalClose` 回调接收 `info`，状态栏显示"退出码 N / 被信号 X 终止"。
12. **冒烟测试**：
    - `terminal/pty.rs::local_pty_exit_code_reported`：`/bin/sh -c "exit 7"` 断言 `Close.exit_code == Some(7)`（纯本地、无 display/sshd）。
    - `ssh/client.rs::ssh_signal_name_maps_to_short_names`：锁死 12+1 个信号短名映射。

### 验证

- `cargo check` **通过**（0 error，仅既有 dead_code warning）。
- `cargo test --lib -- local_pty`：`local_pty_write_roundtrip` + `local_pty_exit_code_reported` → **2 passed**。
- `cargo test --lib -- ssh_signal_name`：`ssh_signal_name_maps_to_short_names` → **1 passed**。
- `npm run build`（`tsc --noEmit` + `vite build`）**通过**（38 模块）。
- 未做：`ssh_exec`/`sftp_chmod` 的运行时端到端验证需真实 sshd 环境（同踩坑 9/10，env 注入 + 跳过）。

### 踩坑经验（务必记住）

17. **russh 的 `Sig::name()` 是私有方法**：`ExitSignal.signal_name` 是 `russh::Sig`（枚举，含 `Custom(String)`），
    没有公开的 `name()`，close 事件要报短名只能自己写 match 映射（ABRT/ALRM/FPE/HUP/ILL/INT/KILL/PIPE/QUIT/SEGV/TERM/USR1 + Custom）。
18. **`ChannelMsg::Eof` 之后还会来 `ExitStatus`/`Close`**：`exec_once` 和 `session_task` 都不能在 `Eof` 处 break，
    否则丢退出码。Eof 只表示远端半关闭输出，`Close`（或 channel drop）才是真正的会话结束。
19. **portable-pty 0.8 的 `ExitStatus.signal` 是私有字段**：本地 PTY 拿不到信号名，`CloseInfo.signal` 恒为 `None`，
    只能报 `exit_code`。SSH 远端才可能给出 signal（`ExitSignal`）。
20. **russh-sftp 的 `FileAttributes::default()` 会填 size/uid/gid/times**：直接 `setstat` 会把文件元数据踩坏。
    chmod 必须手动构造只含 `permissions: Some(mode)`、其余全 `None` 的 `FileAttributes`，因为只有 `Some` 字段才序列化进 SETSTAT。
21. **`ChildReaper` 不能 `#[derive(Clone)]` 直接持 Mutex**：若按值 clone 给 reader 线程，`pty_write` 之类的临时
    clone 被 drop 时（Drop 里的 kill+wait）会误杀活动子进程。正确姿势是 `_reaper: Arc<ChildReaper>`（Drop 只在 Arc 计数归零触发），
    reader 线程只持有 `Arc<Mutex<Option<Box<dyn Child + Send>>>>` 的一份 clone，用 `take()` 保证只 reap 一次、不重复 kill。
22. **`Box<dyn Child + Send + Sync>`（`spawn_command` 返回）可自动 coerce 到 `Box<dyn Child + Send>`**：
    给 `shared` 显式标注类型 `Arc<Mutex<Option<Box<dyn Child + Send>>>>`，`Some(child)` 在赋值处完成 auto-trait 放松的 unsize coercion，无需手写 cast。

---

## 2026-10-29 — 阶段 1 收尾：真实 sshd 端到端冒烟

目标：把 M1（阶段 1）的「三种认证 + exec + SFTP」从"只有单元测试"补到"真连本地 sshd 跑通"，
补上运行时证据。上轮末尾「未做」的端到端验证，这轮落地。

### 修改点

1. **`ssh/client.rs`（test 模块）**：新增 `smoke_pubkey()` / `smoke_password()` 两个 env 读取辅助，
   及 `smoke_connect()`（headless host + reserve + `connect`，返回 `ConnectResult`）。
2. 新增 4 个 env-gated `#[tokio::test]`（无 env 静默跳过，普通 `cargo test` 仍全绿）：
   - `ssh_password_connect_roundtrip`：`CredentialType::Password` 直连成功。
   - `ssh_keyboard_interactive_connect_roundtrip`：`CredentialType::Interactive`，循环监听
     `ssh:auth_prompt:{sid}` → 从 `state.auth_waiters` 取 waiter → 回填 password，直到 connect 完成（支持多轮 InfoRequest）。
   - `ssh_exec_once_roundtrip`：pubkey 连接后 `exec_once("printf '__EXEC_OK__:%s' "$(id -u)"")`，断言 stdout 含标记 + `exit_code == Some(0)`。
   - `sftp_upload_download_chmod_roundtrip`：pubkey 连接 → `SftpHandle::from_handle` →
     `upload_streaming` 传 4KB 全字节 → `chmod 0640` → `stat` 断言 `permissions & 0o7777 == 0640` →
     `download` 字节一致 → `remove_file` 清理。

### 验证

- 本地拉起两个 sshd：pubkey（`:2222`，已有）与 password+kbd-interactive（`:2223`，本轮回填密码 `root/termx_test_pw`）。
- `cargo test --lib`（注入 `TERMX_SSH_TEST_*=2222` / `TERMX_SSH_TEST_PASSWORD_PORT=2223` 等 env）→
  **767 passed; 0 failed**（含本地 PTY 退出码、ssh 信号映射、四种连接 + exec + SFTP）。
- 上轮 `cargo check --tests` 已过；本轮仅新增测试代码，无生产路径改动，`npm run build` 不必重跑。

### 踩坑经验（务必记住）

23. **russh-sftp `SftpSession::write` 只 `open_with_flags(WRITE)`，不带 CREATE**：对不存在的文件直接报
    `No such file`。上传必须用 `create` 或生产路径 `upload_streaming`（先 create `.part` 再 rename）。
    不要在测试里裸调 `sftp.write` 当"上传"用。
24. **Ubuntu sshd 的 PAM keyboard-interactive 第一轮 InfoRequest 可能是 0 个 prompt**（纯 text info 前置轮）；
    client 回填 replies 的条数必须严格等于 `prompts.len()`：0 个就回 `vec![]`，1 个才回 `vec![pw]`。
    不能 `.max(1)`，否则 sshd 记 `input_userauth_info_response: wrong number of replies [preauth]` 并断线
    （表现为 russh `ssh_kbi_response_failed: Unable to receive more messages from the channel`）。
    因此 keyboard-interactive 测试要写成「循环：收 event → 按 prompts.len() 回填 → 直到 connect 完成」。
25. **端到端 sshd 冒烟要用两个实例分端口 + 分 env**：
    - pubkey：`TERMX_SSH_TEST_PORT` / `_KEY` / `_KNOWN_HOSTS`（`:2222`，复用阶段 0 的 fixture）。
    - password+kbd：`TERMX_SSH_TEST_PASSWORD_PORT` / `_PASSWORD` / `_KNOWN_HOSTS_PW`（`:2223`，
      `-o PasswordAuthentication=yes -o KbdInteractiveAuthentication=yes`，known_hosts 直接把 2222 的
      host-key 条目改端口 `sed 's/]:2222/]:2223/'` 复用同套 host key）。
    - 所有 smoke 测试无 env 时 `eprintln!("skip: ...")` + `return`，保证无 sshd 的 CI 环境全绿。

---

## 2026-10-30 — 阶段 2：串口 / Telnet / 端口转发（前端接线）

目标：在已就绪的 rssh Rust 后端之上，把「串口 / Telnet / 端口转发」三类连接接入前端。
**本轮免改 Rust**：后端 `serial.rs / telnet.rs / forward.rs`（含 dynamic SOCKS5）全部就绪，
只做 `client.ts` 桥接补全 + 三个新面板 + App 接线 + 样式。

### 修改点

1. **`src/backend/client.ts`**（追加阶段 2 桥接，与 ssh/pty 同款约定）：
   - 类型：`ConnKind`、`TerminalTransport`、`TermBridge`；`SerialConfig`；`ForwardType/ForwardRule/Forward/ForwardRuleStatus/ForwardRuleStats/ForwardStats`。
   - 串口：`serialListPorts/serialOpen/serialWrite/serialSetDtr/serialSetRts/serialSendBreak/serialClose` +
     事件 `onSerialData/onSerialClose`（`serial:data:{id}` base64、`serial:close:{id}` 载荷为 `()`)。
   - Telnet：`telnetOpen/telnetWrite/telnetWriteLine/telnetResize/telnetClose` +
     事件 `onTelnetData/onTelnetEcho/onTelnetClose`（`telnet:data:{id}`、`telnet:echo:{id}` bool、`telnet:close:{id}`）。
   - 端口转发：`listProfiles`（复用 `list_profiles`）、`listForwards/getForward/createForward/updateForward/deleteForward` +
     `forwardStart/forwardStop/forwardStats/forwardRuleStart/forwardRuleStop`（无事件）。
2. **新建 `src/SerialPanel.tsx`**：端口下拉（`serial_list_ports`）+ 波特率/数据位/校验/停止位/流控表单；
   连接后 DTR/RTS/BREAK 控制 + 发送数据（`\n`/`\r` 转义）。
3. **新建 `src/TelnetPanel.tsx`**：host/port/换行风格 + 连接 + 发送一行（`telnet_write_line`）+ 本地回显状态。
4. **新建 `src/ForwardPanel.tsx`**：转发条目 CRUD + 规则增删（local/remote/dynamic 三类型）+ 启动/停止/统计 + 单规则启停。
5. **`src/App.tsx`**：工具栏新增「串口 / Telnet / 端口转发」三个侧栏切换入口；
   把本地 `Transport` 抽象上收为 `TerminalTransport`，新增 `bridge`（`receive/attach/detach/size`）供串口/Telnet 面板把会话绑到主终端。
6. **`src/styles.css`**：侧栏面板 `label`/select + 转发编辑器与状态标签样式（复用 `.sftp-panel` 布局）。

### 验证

- `npm run build`（`tsc --noEmit` + `vite build`）**通过**（41 模块，无 type error）。
- 后端本轮无 Rust 改动，`cargo check`/`cargo test` 未重跑。
- 未做运行时冒烟：串口无硬件（只能验证 `serial_list_ports` 空列表边界）；telnet/forward 可后续用本地服务+端口转发端到端打通。

### 踩坑经验（务必记住）

26. **串口/Telnet 的 `close` 事件载荷是 `()`，不是 `CloseInfo`**：`serial:close:{id}` / `telnet:close:{id}` 里
    `app.emit(..., ())`，serde 把 unit 序列化成 `null`，所以监听要写成 `listen<null>` 且回调无参。
    千万别复用 pty/ssh 的 `onTerminalClose(domain, sid, cb(info))`——那边才带 `exit_code/signal`。
27. **串口/Telnet 打开前先注册监听再 `open`**：和 SSH 的 prompt 一个道理。`serial_open`/`telnet_open`
    是同步/异步就绪后立即可能发数据（telnet 握手期间就 emit echo），若先 `await open` 拿 sid 再 `listen` 会丢首包。
    做法：`api.newSessionId()` 生成 UUID → 先用该 id 注册 data/close/echo 监听 → 再 `serialOpen(port, config, sid)`。
    （`resolve_session_id` 校验传入必须是规范 UUID 字符串，`crypto.randomUUID()` 恰好合规。）
28. **串口没有 resize**：`serial_open` 收的 `SerialConfig` 只含线路参数（baud/data/parity/stop/flow），
    无 cols/rows。所以 `TerminalTransport.resize` 对 serial 直接给空实现（`() => {}`），否则主终端 fit 时调用会崩。
    但 **telnet 有 NAWS resize**（`telnet_resize`），两者 transport 的 `resize` 实现不同，别一刀切。
29. **`ForwardRule.forward_type` 序列化成 `type`；`ForwardType` 枚举 lowercase**：JS 侧 `ForwardRule` 用 `type: "local"|"remote"|"dynamic"` 键、
    小写值；`Forward` 其余字段（`profile_id/group_id/rules`）snake_case。和前 1 条一样，嵌套 struct 字段走 serde 原样，不 camelCase。
30. **TS `noUnusedLocals` 下，`info.stats` 的属性窄化不跨闭包**：`info?.stats && (...)` 里 `info` 是 `const`，但 `info.stats`
    是可变属性，在 `.map(r => ...)` 的箭头函数内 TS 会退回 `ForwardStats | null`，报 TS18047。
    解法：map 前 `const fstats = info?.stats ?? null;` 用局部只读变量持有，之后全用 `fstats`。
31. **多个面板共用 `.sftp-panel` 样式类**：串口/Telnet/转发面板都放 `<div className="sftp-panel">`，
    继承现有的 button/input/select/row/toolbar 样式，只在转发面板补 `.fwd-*` 专属样式，少写重复 CSS。

---

## 2026-10-30 — 阶段 2 端到端冒烟：串口 + 端口转发（测试 + 沙箱环境）

目标：没有物理串口硬件的前提下，用软件手段打通「本地串口」和「端口转发」两条链路的端到端冒烟，
把它落进 `cargo test`（无环境时自动 skip，有环境时真实跑）。

### 改动点

1. **`src-tauri/src/terminal/serial.rs`**（测试模块）：新增 `spawn_virtual_serial_pair()`（用 socat 起一对
   `pty,raw,echo=0,link=` 虚拟 null-modem）+ `serial_pty_roundtrip`：按路径 `open` 一端、对端写入→backend sink 收到、
   backend 写入→对端读到相同字节、控制线 set_dtr/set_rts 不崩。
2. **`src-tauri/src/ssh/forward.rs`**（测试模块）：新增 `smoke_forward_env()`（复用 `TERMX_SSH_TEST_*`）+ `forward_local_roundtrip`：
   sshed + 本机 echo server，经本地转发收发字节、校验 stats 计流量与连接数、`stop()` 收尾。
3. **沙箱环境（非仓库改动）**：
   - `~/.cargo/config.toml`：镜像从 aliyun（403 IP 黑名单）切到 `rsproxy.cn`（sparse）。
   - apt 安装 Tauri Linux 系统依赖（glib/gtk/webkit2gtk/libudev 等）+ `openssh-server`。
   - sshd 以 `/tmp/termx_sshd_config` 起在 `127.0.0.1:2222`（root 公钥登录 + AllowTcpForwarding + Subsystem sftp），
     客户端密钥 `/tmp/termx_client_key`，known_hosts `/tmp/termx_known_hosts`。

### 验证

- `cargo test --lib`（带 `TERMX_SSH_TEST_*`）：**769 passed, 0 failed**（767 原 + 串口 1 + 转发 1）。

### 踩坑经验（务必记住）

32. **`serialport::available_ports()` 走 `/sys/class/tty`，不枚举 `/dev/pts/*`**：socat 建的虚拟串口不会被
    `serial_list_ports` 列出来，但 `serialport::new(path, baud).open_native()` 能直接打开 pty slave。
    所以串口冒烟要**按路径 `open`**，别走 UI 的下拉枚举（那只验证「打开→双向字节流」核心链路）。
33. **socat 建 pty 对用 `link=` 才能拿到确定路径**：`socat -d -d pty,raw,echo=0,link=/tmp/a pty,raw,echo=0,link=/tmp/b`
    会建两个指向 `/dev/pts/N` 的符号链接；否则只能解析 stderr 里的单调日志，脆。`raw` 关掉行规程，bytes 才原样透传
    （测试数据避开 0x0A/0x0D，防止任何 ICRNL/OPOST 干扰）。
34. **`child.kill()` 需要 `mut child`**：`std::process::Child::kill(&mut self)`；spawn 后变量要声明 `mut`，
    否则 E0596。这类低级编译错误在「测试里起子进程」时最容易漏。
35. **sshd 精简配置必须显式加 SFTP 子系统**：`Subsystem sftp /usr/lib/openssh/sftp-server`。漏了它，
    `sftp_init` 会 `Timeout`（不是「认证失败」之类明确报错），表现为 `sftp_upload_download_chmod_roundtrip` 偶发超时。
    和代码无关，纯环境配置坑。
36. **`pkill -f 'sshd -f ...'` 会把自己也杀掉**：`-f` 匹配整个命令行，当前交互 shell 的包装命令里同样含该串，
    导致「重启 sshd」的这条命令连同自身 shell 一起被 kill、新 sshd 也没起来。正确做法：`pgrep -xa sshd` 找 pid 精确 kill，
    或直接重起（端口空闲就不会冲突）。
37. **russh known_hosts 认 `[127.0.0.1]:2222` 这种带端口格式**：`ssh-keyscan -p N host` 产出带括号端口的形式，
    直接喂 `TERMX_SSH_TEST_KNOWN_HOSTS` 即可被接受（无需手动剥端口）。
38. **cargo 镜像 403 时换源即可，别跟网络死磕**：aliyun sparse 对本沙箱 IP 返回 `403 / denied by IP ACL = blacklist`，
    切 `rsproxy.cn/index/`（sparse）后 `cargo test` 顺利拉依赖；`~/.cargo/config.toml` 里的 `replace-with` 一处即可。

---

## 2026-10-30 — 三平台自动编译发布（GitHub Actions）

目标：让 GitHub 托管 runner 自动产出 Windows / Linux / macOS ARM64 安装包，tag 或手动触发发布。

### 改动点

1. **`.github/workflows/release.yml`**（新增）：矩阵三平台（`ubuntu-22.04` / `windows-latest` / `macos-latest`+`aarch64-apple-darwin`），
   `dtolnay/rust-toolchain` + `Swatinem/rust-cache` + `npm ci` + `tauri-apps/tauri-action@v0`。
   - 触发：push `v*` tag（自动建草稿 Release）或 `workflow_dispatch`（可选填 tag；留空只构建，产物走 upload-artifact）。
   - Linux 显式 `--bundles deb,appimage`；macOS `--target aarch64-apple-darwin`（仅 ARM64）。
   - `permissions: contents: write`（tauri-action 建 Release 必需）。
2. **`package.json` / `package-lock.json`**：`@tauri-apps/api` 钉 2.11.1、`@tauri-apps/cli` 钉 2.11.3，
   与 Rust `tauri` 2.11.3 同 minor，修复 `tauri build` 的版本一致性硬报错。

### 验证（本沙箱）

- `npm run build` ✅；`cargo build` ✅（436MB debug）。
- 交叉 `cargo check --target x86_64-pc-windows-gnu` ✅（装 mingw-w64）。
- 交叉 `cargo check --target aarch64-apple-darwin` ❌：卡在 `objc2-exception-helper` 编 `try_catch.m`，Linux 无 Apple SDK。
- Linux 全量打包 `tauri build --bundles deb` ✅：产出 `termX_0.0.1_amd64.deb`（14MB），`bin/*` 资源 glob 未报错。

### 踩坑

39. **Tauri 版本一致性检查是硬错误，不是警告**：Rust `tauri` 2.11.3 与 npm `@tauri-apps/api` 2.12.4 次版本不一致时，
    `tauri build` 直接 `Error ... version mismatched` 退出（连编译都不开始）。必须把 npm `@tauri-apps/api`/`@tauri-apps/cli`
    与 crate 对齐到同一 minor。注意 api 的 2.11 线只有 `2.11.0/2.11.1`（无 2.11.3），按 minor 匹配用 2.11.1 即可通过。
40. **`bundle.resources` 的 `bin/*` 只匹配到 `.gitkeep`**：glob `*` 默认不匹配点开头文件，`src-tauri/bin/` 里只有 `.gitkeep`，
    但 Tauri 2 打包并未因此报错（缺资源不致命）。若后续真要塞外部二进制，记得把真实文件放进 `src-tauri/bin/`。
41. **release 构建很慢**：本机 `tauri build --bundles deb` 全量 release 编译约 11.5 分钟（debug 只要 1.5 分钟量级）。
    CI 靠 `Swatinem/rust-cache` 缓存 `src-tauri` target 才不至于每次全编。
42. **Ubuntu runner 缺 `libudev-dev` 会让 serialport 编译失败**：Linux 依赖清单必须含 `libudev-dev`；
    Tauri v2 还需 `libwebkit2gtk-4.1-dev`（不是 4.0）。

---

## 2026-10-30 — Windows 代码签名（SSL.com eSigner CKA）

目标：给 Windows 产物接上 Authenticode 签名，且完全跑在 CI 里、不依赖物理 USB token。

### 改动点

1. **`.github/workflows/release.yml`** 新增两个 Windows-only 步骤：
   - 「配置 Windows 代码签名（SSL.com eSigner CKA）」：下载并静默安装 CKA → `eSignerCKATool config -mode -user -pass -totp -key` →
     `unload`/`load` → 探测证书指纹 → 注入 `tauri.conf.json`（`certificateThumbprint`/`digestAlgorithm=sha256`/
     `timestampUrl=http://ts.ssl.com`/`tsp=true`，仅 CI 工作区，不提交）→ 把 signtool 目录写进 `GITHUB_PATH` → 写 `SIGNED=1`。
   - 「校验 Windows 签名」：对 `target/release/bundle` 下 `.exe/.msi` 跑 `signtool verify /pa /v`（仅 `SIGNED=1` 时）。
2. **未配置 secrets 时自动跳过**：`ESIGNER_USERNAME` 为空即 `exit 0`，Windows 产物保持未签名，流程不红。
3. **需要的 Secrets**：`ESIGNER_MODE`(production/test)、`ESIGNER_USERNAME`、`ESIGNER_PASSWORD`、`ESIGNER_TOTP_SECRET`。
   前置：证书须已在 SSL.com 后台 **eSigner 登记**且 `signing credential enabled`。

### 踩坑

43. **YAML 单引号里嵌单引号会截断**：`releaseName: '... 'tag' ...'` 直接把字符串提前闭合，整份 workflow 解析失败
    （上一版就已埋雷，只是没跑过 YAML 校验）。含 `${{ }}` 且分支里有 `'tag'` 时，外层必须改双引号。
44. **Tauri 不会从环境变量读证书指纹**：只能用 `bundle.windows.certificateThumbprint`（静态字段）。CI 里用 PowerShell
    把「探测到的指纹」写回 `tauri.conf.json` 即可，本地无签名照常构建（无该字段就不签）。
45. **SSL.com 的 `ts.ssl.com` 是 RFC3161 时间戳**：Tauri 必须设 `tsp: true` 才会用 `/tr`（否则 `/t` 与服务器不匹配）。
46. **CKA 是「虚拟 USB token」**：它靠 CNG KSP 把证书装进 `CurrentUser\My`，必须 `config → unload → load` 走完一轮，
    `signtool /sha1 <指纹>` 才找得到证书；漏 `load` 会报找不到证书。
47. **windows runner 默认 PATH 未必含 signtool**：Tauri 打包时调 `signtool.exe` 会找不到，需把
    `C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64` 显式追加进 `GITHUB_PATH`。
48. **GitHub Actions 2025-09 起弃用 Node 20 运行时**：`actions/checkout@v4`、`actions/setup-node@v4`、
    `actions/upload-artifact@v4` 会被强制在 Node 24 上跑并告警。升级到 `@v5`（v5 即 Node 24 运行时）即可消除。
    注意 `dtolnay/rust-toolchain`（composite）与 `Swatinem/rust-cache@v2`、`tauri-apps/tauri-action@v0` 不在告警名单。
49. **无法用 `jobs.<id>.if` 过滤矩阵条目**：job 级 `if` 的可用上下文不含 `matrix`，所以「默认只编 Windows、
    发布才编全平台」不能靠给每个 matrix 条目加 `if`。改用 `plan` job 输出 JSON，`build` 侧
    `matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}` 动态展开；矩阵 JSON 必须是**单行**
    （`GITHUB_OUTPUT` 的 `key=value` 不能跨行，多行要用 heredoc 分隔符）。
50. **`update_profile` 必须回传 `algorithms`**：Profile 的 `algorithms` 字段带 `default`，前端若省略，
    serde 会回落到默认算法集，等于把归档里的自定义算法静默清空。编辑草稿要原样带上原值。
51. **`list_credentials` 不返回 secret**：列表只给元数据（避免每次无谓查 keychain）。编辑时必须先调
    `get_credential` 取全量再提交，否则「secret 为空」会被后端当成「删除密钥」，把已有密码/私钥清掉。
52. **POC 临时建档的副作用**：每次连接都 `createCredential + createProfile` 会在 DB 里堆积重复记录
    （`id` 每次随机），且凭据名重复。改为「连接管理器建档 → 按 `profile_id` 连接」后消除。
53. **进度事件按传输实例分频道**：后端发的是 `sftp:progress:{transfer_id}`，一个 transfer_id 一条监听。
    批量传输必须自己造 id、逐文件 `listen`/`unlisten`，不能只监听一个全局频道。
    另外 `sftp_save_file` / `sftp_pick_and_upload` 是「对话框 + 传输」一体化、transfer_id 由后端内部生成，
    前端拿不到 → 要进度就只能走两步式（`pick_save_path`/`pick_open_files` + `download_to`/`upload_from`）。
54. **递归传输不需要额外建目录命令**：`download_streaming` 会自动 `create_dir_all` 本地父目录，
    `upload_streaming` 会自动 `mkdir_p` 远端父目录。后端也确实没有本地 mkdir 命令，
    所以下载目录的正确做法是「`walk_remote_dir` 列出文件 → 拼本地路径 → 逐文件 `download_to`」。
55. **批量进度不能用文件个数当总量**：进度事件给的是字节数（`{transferred,total}`），把「第几个文件」当 total
    会让百分比完全错乱。要以字节累加，并且每个子文件结束后把它的 total 计入下一轮的基准值。
56. **`rel_path` 统一用 '/'，本地拼接要 trim 尾部反斜杠**：Windows 原生目录选择器返回 `C:\dir\`，
    直接拼 `rel_path` 会出现 `\\` 双分隔符。拼之前先 `replace(/[\\/]+$/,"")`。

## 2026-10-30 — P0 #1~#3：多标签 + 分屏 + 会话恢复

目标：把单会话外壳改造成 netcatty 式工作区——多标签、标签内嵌套分屏、重启后可恢复布局。

### 改动点

1. **`src/workspaceModel.ts`（新增）**：工作区模型与纯函数。
   `Connector`（pty / ssh）、`PaneNode`=`leaf | split(dir, ratio, a, b)`、`Tab`；
   `splitLeaf` / `removeLeaf`（单边为空自动提升另一边）/ `updateRatio` / `collectLeaves`。
2. **`src/TerminalPane.tsx`（新增）**：每格独立 xterm + 独立 sessionId + 独立事件订阅。
   认证 prompt 弹窗下沉到窗格；断线保留缓冲并叠「重连」遮罩；对外暴露 `PaneHandle`
   （write / size / attachTransport / sshSessionId / subscribeSession）。
3. **`src/Workspace.tsx`（新增）**：标签栏（新建 / 关闭 / 双击重命名）、按分屏树递归渲染、
   分隔条拖拽改 ratio、「左右 / 上下分屏」「关闭窗格」。非活动标签只 `display:none`，不卸载会话。
   通过 `forwardRef` 暴露 `newTab(connector)` / `ensureTab()`。
4. **`src/backend/workspaceStore.ts`（新增）**：`termx.workspace.v1` 落盘标签 + 分屏树 + 连接器；
   启动先显示「发现上次会话（N 个标签）」横幅，用户点「恢复」才重建并连接，避免无感自动重连。
5. **`src/App.tsx`（重构）**：删除单会话 / prompt 逻辑，只保留工具栏、档案快捷入口、
   连接管理器与侧栏面板。侧栏桥（SFTP 取活动窗格 SSH 会话；串口 / Telnet 绑定打开时活动窗格）。
6. **`src/Terminal.tsx`**：xterm 容器加 `ResizeObserver`，分屏与标签切换后自动 `fit()`。
7. **`src/styles.css`**：标签栏、分隔条、窗格遮罩、恢复横幅样式。

### 踩坑

57. **`crypto.randomUUID()` 只在安全上下文可用**：Tauri WebView 满足，但浏览器直开 `http://localhost:1420`
    调试时是 `undefined`，点「新建终端」直接 `TypeError`。`newId` / `newSessionId` 必须
    检测 `typeof crypto.randomUUID === "function"`，否则回退「时间戳 + 随机数」。
58. **切换标签不能卸载窗格**：卸载会销毁 xterm 与事件监听，等于切一次就重连。
    非活动标签用 CSS 隐藏；隐藏期间容器尺寸为 0，`FitAddon` 不会自动修正，
    必须靠 `ResizeObserver` 在重新显示时触发 `fit()`。
59. **TS 的窄化不会穿透到嵌套函数**：`LayoutView` 里 `if (node.type === "leaf") return`
    之后直接写 `node.dir` 在 `startDrag` 闭包里报 `Property 'dir' does not exist on type 'PaneNode'`。
    先把 `const dir = node.dir` 抓出来再进闭包。
60. **文件名大小写冲突会在 Windows CI 才炸**：`src/workspace.ts` 与 `src/Workspace.tsx` 在 Linux 上互不干扰，
    但 Windows 文件系统不分大小写，git checkout 后两个模块被解析成同一个文件，tsc 报 TS1261/TS1149
    （`File name ... differs from ... only in casing`），`beforeBuildCommand` 直接失败。
    规避：同目录下任何两个文件名不能只差大小写。本项目把模型文件改名为 `workspaceModel.ts`。
    **本地 Linux 构建通过 ≠ Windows 构建通过**，跨平台项目起名要一开始就避开。
61. **`upload-artifact@v5` 自身仍跑 Node 20**：2026 年 GitHub 已强制 Node 20 action 在 Node 24 上运行并告警，
    但 v5 的 `action.yml` 里写的是 `node20`。换成 `@v7`（`runs.using: node24`）即可消除；
    v7 的 `name` / `path` / `if-no-files-found` / `retention-days` 入参与本项目用法完全兼容。
    排查方法：`git ls-remote --tags <repo>` 找最新 tag，再读 `raw.githubusercontent.com/<repo>/<tag>/action.yml` 的 `runs.using`。

## 2026-10-30 — 界面结构对齐 netcatty

目标：把「工具栏 + 终端 + 右侧面板」的单区外壳，改成 netcatty 的四层结构：
顶部 TopTabs、左侧主机树、空闲态 Vault 起始页、右侧统一 AsidePanel。

### 改动点

1. **`src/ui/icons.tsx`（新增）**：内联 SVG 线性图标（lucide 路径，ISC），不引入新依赖。
2. **`src/TopTabs.tsx`（新增）**：品牌标识 + 会话标签（激活下划线 / 关闭 / 双击重命名）+
   右侧 chrome（侧栏开关、左右 / 上下分屏、关闭窗格、SFTP / 串口 / Telnet / 转发、刷新、连接管理、状态点）。
3. **`src/HostSidebar.tsx`（新增）**：搜索 + 「本地终端」+ 按分组折叠的主机列表，点击即开新标签。
4. **`src/VaultHome.tsx`（新增）**：空闲态主机页——标题 / 搜索 / 分组 chips / 网格与列表切换 /
   主机卡片 / 空状态 CTA，对照 netcatty `VaultView`。
5. **`src/AsidePanel.tsx`（新增）**：统一右侧面板（标题 + 关闭 + 独立滚动），SFTP / 串口 / Telnet / 转发全部套用。
6. **`src/Workspace.tsx`（重构）**：移除内置标签栏与恢复横幅；标签状态仍归它持有，
   通过 `onSnapshot(tabs, activeTabId, restorePending)` 单向发布给 TopTabs；
   `forwardRef` 扩展为 activate / close / rename / split / closePane / acceptRestore / skipRestore。
7. **`src/App.tsx`（重写）**：按 `TopTabs → (HostSidebar + 主区 + AsidePanel)` 编排；
   空闲时主区渲染 VaultHome，有标签时渲染 Workspace；恢复横幅提升到外壳层。
8. **`src/styles.css`**：新增 netcatty 配色变量（HSL 220 系深色 + 200 系主色）与全部新组件样式；
   侧栏内旧面板去掉自带宽度 / 边框 / 背景，交给 AsidePanel 统一。

### 踩坑

62. **标签状态只能单向流动**：Workspace 持有真状态、TopTabs 只展示。若把 TopTabs 的渲染结果
    再写回 Workspace，会与「关闭后自动选中相邻标签」互相覆盖，出现回环。
    快照回调只用于展示，操作一律走 imperative 方法。
63. **`useImperativeHandle` 不能提前引用后面才声明的 `const`**：`closeTab` / `splitActive` /
    `closeActivePane` 都是后置的 `useCallback` 常量，句柄注册必须移到它们之后，
    否则渲染期访问处于 TDZ，直接 `ReferenceError`（不是类型错误，构建期发现不了）。
64. **React 19 下不要依赖全局 `JSX.Element`**：图标表写成 `Record<IconName, ReactElement>`
    （从 `react` 显式导入类型），否则在严格 tsconfig 里命名空间可能不存在。
65. **沙箱里 Vite dev 会因 inotify 上限失败**：`npm run dev` 报 `ENOSPC: System limit for number
    of file watchers reached`；改用 `npm run build` + `npm run preview` 做界面验证。
    浏览器里没有 Tauri runtime，`invoke` 必然失败，终端显示重连遮罩属预期，不代表 UI 有问题。
## 2026-11-01 — 界面 1:1 复刻 netcatty（未实现入口禁用）

目标：按 netcatty 的真实结构重做界面，尺寸/配色取源码精确值；尚未实现的后端能力保留入口但禁用。

### 改动点

1. **`src/TopTabs.tsx`（重写）**：固定根标签 Vaults / SFTP + 主机树开关 + 会话标签 + 新建 + 右侧窗口工具
   （AI / 同步 / 锁屏 / 外观 / 设置，全部禁用）。Vaults 激活态保持平铺不填充（netcatty `suppressActiveBg`）。
2. **`src/VaultView.tsx`（新建，取代 `VaultHome.tsx`）**：208px 可折叠导航（56px 折叠态）+ 56px 页头
   （搜索 / 连接 / 视图 / 标签 / 排序 / 多选 / 新建主机）+ 圆角内容面板；主机网格 / 列表 / 分组树。
   未实现的导航与页头按钮禁用。
3. **`src/HostSidebar.tsx`（重写）**：220px 主机树 + 36px 图标工具条（新建 / 搜索 / 标签 / 本地终端 / 更多 / 收起）
   + 28px 紧凑树行；搜索改为工具条内展开。
4. **`src/App.tsx`（重写）**：`surface`（vault / sftp / 终端）三态编排；终端浮层工具条移到右上角；
   Vault / SFTP 独立页；删掉 `VaultHome.tsx` 死文件。
5. **`src/styles.css`**：追加 netcatty 精确 token（dark：`220 28% 8%` / `220 16% 16%` / `220 22% 18%` / `200 100% 61%`）
   与全部新结构样式；主机树 220px、侧面板 36px 工具条、主机卡 68px / 头像 44px、网格 gap 12px 且最多 4 列。
6. **`src/ui/icons.tsx`**：补齐 menu / sparkles / cloud / lock / gear / key / activity / file-code / shield /
   check-square / sort / tag。

### 踩坑

66. **netcatty 是 GPL-3.0，termX 无 LICENSE**：只照结构与视觉规格「重写」，不复制其组件源码，避免许可证传染。
67. **JSX 重写后残留孤立 token 会直接编译失败**：`App.tsx` 端口转发按钮前多了 ` Faso`，
    `npm run build` 立即报错。大段 JSX 改完必须立刻跑 `tsc --noEmit`。
68. **网格「最多 4 列」不用 JS 测量**：`grid-template-columns: repeat(auto-fill, minmax(max(220px, calc((100% - 36px) / 4)), 1fr))`
    即可在宽屏封顶 4 列、窄屏回落到 220px，行为与 netcatty `vaultHostGridLayout.ts` 一致。
69. **追加 CSS 覆盖旧规则要看特异性**：`.nc-hosttree-toggle.active` 打不过旧的 `.nc-icon-btn.active`（都是 0,2,0，后者更靠前却仍生效需同级后置），
    改用 `.nc-icon-btn.nc-hosttree-toggle.active`。主机树开关在 netcatty 里没有蓝色填充。
70. **尺寸基准要以源码常量为准**：netcatty 主机树默认宽度是 **220px**（`TERMINAL_HOST_TREE_DEFAULT_WIDTH`，min 176 / max 360），
    不是 w-72（288px）；树行 28px、侧面板工具条 36px、Vault 卡片 68px、`DistroAvatar lg` 44px。

---

## 2026-11-01 · 浅色 snow 主题 + 首页三入口 + 终端窗格工具栏

目标：默认界面切换为 netcatty 的浅色 snow 主题；首页页头补齐「终端 / 串口」；
终端顶部工具栏按 netcatty `TerminalToolbar` / `TerminalView` 复刻。

### 改动点

1. **`src/styles.css`（主题）**：`:root` 由 netcatty `.dark` 改为 snow 浅色 token
   （`216 33% 96%` / `208 100% 50%` / `220 16% 82%`，`color-scheme: light`），
   并把旧 GitHub-dark 硬编码色批量映射为浅色等价值；阴影改淡
   （`.vault-surface`、`.vault-view-menu`、`.nc-restore`）。
2. **`src/Terminal.tsx`**：xterm 主题改浅色（白底 / 深色字 / 蓝色光标）。
3. **`src/VaultView.tsx`（重写）**：页头顺序改为 搜索 → 连接 → 视图/标签/排序/多选 →
   新建主机分体按钮 → **终端** → **串口**；内容区改为「全部主机」面包屑 → 最近连接 → 主机分区
   （条数 + 在线数胶囊）；空状态改为截图样式。
4. **`src/App.tsx`**：新增 `termx.recent.v1`（localStorage `{id,ts}[]`，上限 8 条）记录最近连接，
   提供 `recentIds` 给首页；新增 `openSerial()`；删除右上角浮动 `nc-term-tools`。
5. **`src/TerminalPane.tsx`**：新增每窗格 30px 顶部工具栏（左：标题 / 时钟 / 活动 / 重连；
   右：高亮 / SFTP / 浏览器 / 输入框 / 搜索 / 日志 / 脚本 / ⋮ / 关闭），`⋮` 收纳分屏与串口 / Telnet / 转发。
6. **`src/Workspace.tsx` / `src/ui/icons.tsx`**：透传 `onOpenTool` / `onClosePane` / `onSplit`；
   补齐 clock / highlighter / folder-input / globe / text-cursor / file-text / zap / more-vertical 等图标。

### 踩坑

71. **`styles.css` 里有两套主题变量**：前面 1041 行还留着 `:root { color-scheme: dark; --nc-* }`，
    只改后面 2052 行的 `:root` 不够——后者靠「同特异性、后出现」才覆盖前者。改主题务必确认
    最终生效的 `:root`，且 `--nc-*` 要用别名指向新 token，否则侧栏 / 顶栏仍是深色。
72. **`.tsx` 里的颜色不受 CSS 批量替换影响**：xterm `theme` 是 JS 字面量，深浅色要单独改，
    否则出现「外壳浅色、终端黑底」的割裂效果。
73. **页头按钮会被 flex 压缩**：`.vault-search { flex: 1 }` 与按钮默认 `flex-shrink: 1` 一起作用，
    窄窗口时按钮被压扁甚至挤出可视区（「终端 / 串口」看不见）。给页头按钮统一加
    `flex-shrink: 0`，让搜索框让步，并加 `@media (max-width: 960px)` 收起低优先级图标。
74. **终端工具栏归属是「每窗格」而非全局**：netcatty 的 `TerminalToolbar` 挂在每个 `TerminalView` 内，
    放在 App 顶层浮层会与分屏语义冲突；`.pane` 必须改 `flex-direction: column` 才能容纳这条 30px 工具条。
75. **最近连接没有后端时间戳**：Profile 表无 `last_connected_at`，只能用前端 localStorage 记录顺序，
    清缓存即丢失；后续若加字段应迁到 DB。

---

## 2026-11-01 · 终端工具栏图标纠正 + 右键菜单承接分屏

### 改动点

1. **`src/TerminalPane.tsx` 工具栏左侧**：改为 标题 → 时钟（行时间戳，置灰）→
   系统监控（仅远端 SSH，置灰）→ **断开当前会话**（`unplug`，connected/connecting 可用）→
   **重新连接**（`refresh`，非 connecting 可用）。本地 / 串口 / Telnet 不出现系统监控
   （对齐 netcatty `isSystemSidebarEligible`）。
2. **`⋮ 更多` 菜单**：只保留 netcatty 的 collapsed 项「终端外观」「开始录制」（均置灰），
   移除原先自造的分屏 / 串口 / Telnet / 端口转发项；工具栏尾部关闭 X 一并移除。
3. **新增终端右键菜单**（对齐 netcatty `TerminalContextMenu`）：
   复制 / 粘贴 / 全选 / 浏览器（置灰）/ 重新连接 / 水平分屏 / 垂直分屏 / 清空缓冲区 / 关闭终端，
   分隔线布局与 netcatty 顺序一致；连断线遮罩区域也响应右键。
4. **`src/ui/icons.tsx`**：新增 `unplug` / `copy` / `clipboard-paste` / `trash` / `circle` 图标。

### 踩坑

76. **分屏入口归属搞错了**：netcatty 的分屏在 `TerminalContextMenu`（右键菜单），
    `TerminalToolbar` 只负责高频图标与 collapsed 项；把分屏塞进 `⋮` 与源码不符。
77. **断开 / 重连的可用条件不同源**：断开仅 `connected` / `connecting` 可用，
    重连只排除 `connecting`；系统监控要按「非 local / serial / telnet 的 SSH」判定，
    否则每个窗格都会多出一个图标。
78. **断线遮罩会吞掉右键事件**：`pane-overlay` 是 `inset: 0` 的覆盖层，
    断线状态下右键无法穿透；遮罩本身必须绑定 `onContextMenu` 才能照常弹出菜单。

### 追加（SSH 会话的 ⋮ 菜单）

79. **⋮ 菜单项随会话协议变化**：netcatty `availableIds` 的规则是
    `history` 仅在远端 SSH（非 local/serial/telnet/plugin）、`configureOsc7` 仅在 SSH 且非串口、
    `encoding` 仅在 SSH（local/mosh/et/plugin 不支持切换编码）。
    因此 SSH 会话菜单为 命令历史 / 配置目录追踪 / 终端设置 / 开始录制 / 终端编码（带子菜单箭头），
    本地终端仅 终端设置 / 开始录制。按截图顺序与文案（终端设置，而非「终端外观」）补齐。
    新增 `history` / `folder-sync` 图标与 `.term-menu-caret` 右对齐箭头。

### 追加（关闭入口调整）

80. 应产品要求：工具栏尾部恢复 X 关闭按钮（`term-tool-close`），右键菜单去掉「关闭终端」，
    末项改为「清空缓冲区」。netcatty 的 `TerminalToolbar` 其实支持可选 `showClose`，
    原判断（工作区不显示）按截图口径修正。

---

## 2026-11-02 · Vault 首页两批差异补齐（对照 netcatty）

### 改动点

1. **`src/VaultView.tsx`**
   - 侧栏补「已知主机」「日志」入口（置灰）；导航右缘新增 8px 拖拽条，宽度 208~320 持久化到
     `termx.vault.sidebar.v1`。
   - 面包屑只在非树视图显示；新增分组层级 `全部主机 › 分组名`，分组卡可点击进入。
   - 网格 / 列表补「分组（共 N 个）」分区；根层级补「已置顶」（`termx.pinned.v1`）与最近连接。
   - 搜索支持快速连接 `user@host` / `ssh user@host` / `ssh -p 2222 user@host`：识别后主色描边 +
     闪电标记，「连接」按钮转主色；此时关键字不参与过滤，列表保持完整，内容区顶部显示虚线
     建议行「直接连接 user@host:port」，点击或回车打开连接管理器并预填 name / host / port。
   - 视图 / 排序持久化（`termx.vault.view.v1` / `termx.vault.sort.v1`），排序支持名称、主机升降序。
   - 主机卡右键菜单：连接 / 双栏 SFTP(灰) / 主机浏览器(灰) / 编辑 / 复制主机名 / 复制账密(灰) /
     置顶切换 / 删除；卡片 hover 出现编辑按钮，副标题改为 `user@host:port`。
   - 多选模式：卡片勾选框 + 操作条（已选 N 台主机 / 全选 / 取消 / 批量删除），批量与单条删除
     都走 `api.deleteProfile` 后刷新列表。
   - 「新建主机」改为右侧 aside 面板（名称 / 主机 / 端口 / 凭据 / 分组 + 保存 / 保存并连接），
     面板打开时页头的 新建主机 / 终端 / 串口 三块折叠隐藏。
   - 「N 个在线」改为 App 传入的真实标签会话数。
2. **`src/App.tsx`**：加载凭据列表；新增连接管理器的 `editProfileId` / `prefill` 入口状态。
3. **`src/ConnectionManager.tsx`**：支持外部编辑指定档案、快速连接预填（只应用一次，避免覆盖草稿）。
4. **`src/ui/icons.tsx`**：新增 `pin` / `pencil` / `square`。
5. **`src/styles.css`**：补拖拽条、快速连接态、多选条、置顶星标 / hover 编辑、分组卡、右键菜单、
   右侧新建面板样式。

### 踩坑

81. **右键菜单不能用 mousedown 直接关闭**：mousedown 即卸载菜单会导致后续 click 事件丢失，
    菜单项永远点不中；改为 mousedown 时判断 `target.closest(".vault-popmenu")`，只关外部点击。
82. **后端 Profile 没有 pinned 字段**：置顶只能存 `termx.pinned.v1`；删除主机时要把 id 同步移出，
    否则会留下指向已删除档案的悬空 id。
83. **侧栏宽度过渡会拖慢拖拽**：`.vault-sidebar` 有 `transition: width 200ms`，拖拽时必须加
    `.resizing` 关掉过渡，且用 window 级 pointermove / pointerup 才能跟手。
84. **快速连接不能只看 `@`**：普通搜索词可能含 `@`，必须限定 `ssh` 前缀或 `user@host` 形态；
    `ssh -p` 的正则要吃掉尾部空白，否则端口号会被当成主机名。
85. **新建面板必须绝对定位在 `.vault-stage` 内**：放进滚动内容区会随内容滚走；
    父级补 `position: relative`，面板 `right: 0; top: 0; bottom: 0`。
86. **快速连接语法不能参与搜索过滤**：`ssh -p 2222 user@hostname` 整体当关键字会过滤出 0 条，
    看起来像列表坏了。改为识别到快速连接时跳过过滤，并在内容区顶部显示一条虚线建议行
    「直接连接 user@host:port」（点击或 Enter 打开预填的连接管理器）。
87. **`crypto.randomUUID` 只在安全上下文可用**：浏览器 HTTP 调试下 `ConnectionManager.newId()`
    直接调用会抛错导致白屏；补时间戳 + 随机串回退（与 `workspaceModel.ts` 保持一致）。

## 2026-11-02 · Vault 首页「批 1 + 批 2」继续对齐

### 改动

1. **`src/VaultView.tsx`**
   - 排序扩到 7 种（手动顺序 / A→Z / Z→A / 从新到旧 / 从旧到新 / 按分组 / 按 IP），新增
     `termx.vault.order.v1` 手动顺序存储并自动把新主机补到表尾；兼容旧 `name-asc` / `host-*` 值。
   - 最近连接排除置顶与本地终端，最多 6 条；主机副标题去掉端口，端口只在完整 title 中显示。
   - 标签系统：主机卡片标签 chip + 标签筛选下拉（搜索 / 多选 / 重命名 / 删除 / 清空）、
     右键「标签…」编辑浮层，数据存 `termx.vault.tags.v1`。
   - 多选条扩展为「主机 + 分组」计数，新增全选、取消全选、批量连接、移动到分组、批量删除与关闭 X。
   - 右键菜单补齐复制副本、复制主机名、复制账密信息、标签…；编辑改走右侧面板。
   - 分组卡右键菜单（重命名 / 分组设置 / 删除）、hover 铅笔重命名、新建分组对话框。
   - 树视图支持分组折叠与「展开全部 / 折叠全部」；视图菜单新增单击行为（直接连接 / 先选中，
     `termx.vault.click.v1`）。
   - 快速切换器（「连接」无快速连接语法时打开）与快速连接向导（识别语法后 Enter，填写名称 /
     用户名 / 端口 / 凭据，保存或保存并连接）。
   - 拖拽归组（分组卡 / 树头 / 「全部主机」面包屑），多选可整批拖拽；内容区框选；方向键在主机卡
     之间移动焦点、Esc 退出多选。
   - 右侧主机面板可拖宽（320–520，`termx.vault.hostpanel.v1`），新增标签字段，标题区分新建 / 编辑；
     面板打开时页头右侧操作组淡出。新增操作 toast。
2. **`src/App.tsx`**：移除 `onEditProfile` / `onQuickConnect` 传参与 `managerPrefill` 状态。
3. **`src/styles.css`**：补折叠按钮、标签菜单 / chip、多选条、树工具、投放高亮、框选、toast、
   快速切换器、快速连接向导、分组对话框、面板拖拽条、模态遮罩等样式。

### 踩坑

88. **`Object.entries(...)` 少一个右括号，TS 报错位置会指到下一行的 `{`**：TS1005 的 `)` expected
    实际是 for-of 头部没闭合，逐行看语法看不出来；把报错行之前的代码单独截出来编译才能定位。
89. **框选矩形不能依赖未设置的 CSS 变量**：原实现用 `calc(var(--vault-content-x) + …)`，变量从未
    赋值，矩形会跑到左上角；改为 `position: fixed` + 渲染时用 `contentRef` 的
    `getBoundingClientRect()` 换算视口坐标。
90. **新增的 `.vault-tag-editor` 借用 `.vault-popmenu` 却没有基础定位**：`.vault-popmenu` 只提供
    外观，不含 `position`，浮层会落在文档流里把页面撑开；给标签编辑浮层显式 `fixed` 定位
    （`top: 84px; right: 24px`）。

## 2026-11-02 · 沿用 netcatty 源码重做 Vault 框选

### 改动

1. **新增 `src/domain/vaultMarqueeSelection.ts`**：直接从 netcatty `domain/vaultMarqueeSelection.ts`
   移植纯逻辑（4px 阈值、replace/add/toggle 选择模式、矩形相交、滚动内容坐标换算、边缘自动滚动、
   滚动条命中判断等），不自行改写算法。
2. **新增 `src/useVaultHostMarquee.ts`**：从 netcatty `components/vault/useVaultHostMarquee.ts`
   移植 hook：
   - 仅网格 / 列表视图启动，树形视图不启动；
   - `[data-host-id]`、`[data-group-path]`、按钮、输入框等目标不启动框选；
   - `pointerdown` 只记录起点，移动超过 4px 才进入多选并绘制矩形，空白单击不会误入多选；
   - 支持 Shift 追加、Ctrl/Cmd 切换、Esc 取消并还原基线选择；
   - 拖到容器上下边缘自动滚动，滚动时按缓存的卡片位置重新计算命中；
   - 拖动结束后通过 capture 阶段抑制 click，避免松手时误连主机。
3. **`src/VaultView.tsx`**：删除自写的 marquee 状态 / 监听 / 坐标换算，改为调用移植 hook；
   主机卡新增 `data-host-id`，分组卡新增 `data-group-path`；框选矩形渲染在 `.vault-content`
   内（绝对定位 + 滚动内容坐标）。
4. **`src/styles.css`**：`.vault-content` 增加 `position: relative`，`.vault-marquee` 改为
   `position: absolute`，并补 `.vault-content.selecting { user-select: none }`。

### 踩坑

91. **框选入口不能绑在 pointerdown 上**：空白处按下鼠标（哪怕只是轻微抖动）都会立刻进入
    多选模式，表现为「点一下空白就进了多选」且偶尔复现。正确做法是直接移植 netcatty 的
    `useVaultHostMarquee`：按下只记录起点，移动超过 4px 才切多选；同时它顺带解决了拖动结束
    误触 click（suppressClick）与滚动 / 自动滚动下的命中问题——这些自己写很容易漏。




## 2026-11-02 · SSH 连接建立与管理前后端移植（对齐 netcatty）

### 改动

后端（`src-tauri/src`）：

1. **`ssh/client.rs`**：新增 `ProgressEmitter`，向 `ssh:progress:<sessionId>` 推送
   `{hop,total,label,status,error}`；逐跳覆盖 `connecting / tcp-connected /
   authenticating / authenticated / forwarding / shell / connected / error`。
   `establish_via_chain` 新增 `progress: Option<&ProgressEmitter>`，空链与多跳链都按
   netcatty 的逐跳语义发事件；`profile_label` 用 `name`（空则 `host`）作为弹窗标题。
2. **`ssh/prompt.rs`**：`prompt_host_key` 改为结构化 payload（`ssh:host_key_prompt`
   带 `banner/host/port/key_type/fingerprint/status/known_fingerprint`），
   unknown 与 changed 分别标注 `status`。
3. **`models.rs` + `commands/session.rs` + `server.rs`**：`AuthOverride` 增加
   `passphrase`；一次性覆盖支持换凭据 / 改用户名 / 改密码 / 传私钥口令，均不写回 DB；
   passphrase 走进程内 `passphrase_cache`（键 `cred:<id>`，与 `ssh/auth.rs` 一致）。
4. **`ssh/client.rs` 测试**：连接日志测试不再假设首个事件是 `ssh:data`，改为扫描
   唯一一条 `ssh:data`，容纳新增的 progress 事件。

前端（`src`）：

5. **新增领域层**：`domain/connectionProgress.ts`、`domain/sshConnectionTimeouts.ts`、
   `domain/hostKey.ts`、`domain/sshErrors.ts`，逐字移植 netcatty 的进度函数、20s/120s/3600s
   超时常量、`hasConnectionPassedTcpDial`、主机密钥模型与 `isAuthFailureMessage`。
6. **新增组件**：`terminal/TerminalConnectionDialog.tsx`（540px 三阶段卡片 + 两段进度条 +
   320ms 解锁）、`TerminalConnectionProgress.tsx`（倒计时 / 日志 / 关闭会话 / 重新连接）、
   `TerminalAuthDialog.tsx`（密码 / SSH 密钥 tab、认证失败提示、密钥下拉、passphrase）、
   `TerminalHostKeyVerification.tsx`（unknown 黄 / changed 红）。
7. **`TerminalPane.tsx` 整体重写**：状态机对齐 netcatty（connecting / connected /
   disconnected），预生成 sessionId 并在 `sshConnect` 前注册四类事件；移植逐跳日志映射、
   超时倒计时与 200ms 不确定进度、认证失败分流（needsAuth + 清空密码）、取消连接、
   断开后关闭会话 / 重新连接 / Enter 重连、主机密钥三种答复。
8. **`backend/client.ts`**：新增 `onSshProgress`、`SshProgressEvent`、`AuthOverride.passphrase`，
   `sshConnect` 透传一次性认证覆盖。
9. **`ui/icons.tsx` / `styles.css`**：补 `plug / fingerprint / alert-triangle / eye(-off) /
   play / user / loader` 图标与整套 `.conn-*` 样式。

### 验证

- `npm run build`（tsc --noEmit + vite build）通过。
- 浏览器 harness（mock Tauri IPC）复验：连接弹窗三阶段 + 倒计时正常；连接完成后弹窗消失；
  认证失败弹出重试表单；未知主机密钥弹出黄色校验卡片。
- Rust 无法在本沙箱编译（缺 `glib-2.0`，Tauri 系统依赖），只做了人工代码审查。

### 踩坑

92. **新增 progress 事件会打乱既有断言顺序**：原测试断言第一个事件必须是 `ssh:data`，
    `ProgressEmitter` 在拨号前先发 `connecting`，测试必然失败；不要删掉日志断言，改成扫描
    事件流里唯一的一条 `ssh:data`。
93. **认证重试的 passphrase 必须走缓存而不是改凭据**：临时覆盖不能落库，但
    `decode_key_with_prompt` 只查 `passphrase_cache`，所以要用与 `ssh/auth.rs` 相同的
    `cred:<credential_id>` 键写入 `Zeroizing<String>`。
94. **取消连接复用 `ssh_disconnect` 即可**：它关闭 Pending 资源并清 prompt waiters，
    `activate_returned` 会因记录已关闭而失败；前端再用 attempt 代数让旧回调失效，
    不需要新增后端命令。

---

## 2026-11-02 · Vault composer 面板 netcatty 化 + 已知主机管理（移植收尾）

### 改动

后端（`src-tauri`）：

1. **`src/ssh/known_hosts.rs`**：新增 `KnownHostEntry`（host/port/key_type/public_key/fingerprint/hashed）
   与 `parse_line` / `parse_host_port` / `parse_known_hosts`，解析规则对齐 netcatty：
   `[host]:port` 方括号、逗号多模式取第一个、`|1|` 哈希条目显示 `(hashed)`、IPv6 不带端口不拆、
   坏行静默跳过；指纹用 `russh::keys::ssh_key::PublicKey::from_openssh` + `HashAlg::Sha256`。
   补 8 个单元测试。
2. **`src/commands/profile.rs`**：新增 `list_ssh_key_files`（只列 `~/.ssh` 下真实私钥文件名：
   单层文件名校验 `is_plain_file_name` + 内容嗅探 `looks_like_private_key` + 1MiB 上限，
   不返回也不写日志任何内容）；`read_default_key_file` 从硬编码白名单泛化为同套安全校验；
   新增 `known_hosts_list` / `known_hosts_remove`（包装 `remove_host`）。补 2 个校验测试。
3. **`src/lib.rs`**：注册上述三条 command。
4. **`build.rs`**：Windows 下输出 `cargo:rustc-link-arg=-MANIFESTDEPENDENCY:...Common-Controls v6...`，
   修复 `cargo test` harness exe 加载期崩溃（见踩坑 95）。

前端（`src`）：

5. **`src/backend/client.ts`**：`readDefaultKeyFile` 参数泛化；新增 `listSshKeyFiles`、
   `KnownHostEntry`、`knownHostsList`、`knownHostsRemove`。
6. **`src/VaultView.tsx` composer 重构**（一比一 netcatty HostDetails 分区）：
   - 名称 → 地址 → 「端口与凭据」：`SSH on [端口] 端口` 组合行、登录方式下拉
     （auto/password/key/certificate，certificate 禁用占位）带 hint、MFA 开关
     （开=keyboard-interactive 优先）、已选身份显示 + 清除、「使用已有凭据」下拉绑定、
     内联凭据编辑（密码显示切换、编辑留空=保持原 secret 不变、保存密码开关、
     `~/.ssh` 私钥下拉）→ 高级占位区（Mosh/永恒终端/SSH 代理/X11/TOTP/操作系统/发行版
     全部「未移植」禁用行）→ 分组/标签/初始化命令。
   - 认证映射：auto→agent、password→password、key→key（PEM 来自所选文件）、MFA 开→interactive。
   - 保存时凭据 upsert：未绑定则新建（`username@host`），已绑定则更新；
     `composerSecretRef` 回填原 secret 支撑「留空保持不变」。
7. **`src/VaultView.tsx` 已知主机管理页**：导航 known-hosts 可点击；`activeNav` 分流内容区；
   列表渲染（主机/端口/类型/SHA256 指纹、哈希条目只读徽标）、搜索过滤、删除（confirm）、
   「转换为主机档案」（agent 凭据 + label=hostname、用户名留空）。
8. **`src/styles.css`**：新增 `host-details-*` / `host-port-line` / `host-switch` /
   `host-identity-row` / `host-pass-wrap` / `host-badge` 与 `vault-known-hosts*` 样式。

### 验证

- `npm run build`（tsc --noEmit + vite build）通过（61 模块）。
- `cargo check` 通过；`cargo test known_hosts` **14 passed / 0 failed**；
  `cargo test commands::profile` 5 passed / 0 failed（含新增 2 个校验测试）。
- 踩坑 95 修复前测试 exe 全部无法启动；修复后 Windows 上 `cargo test` 首次真正跑通。

### 踩坑

95. **Windows `cargo test` 加载期崩 `0xc0000139`（STATUS_ENTRYPOINT_NOT_FOUND）的根因是清单**：
    编译全部通过、exe 一启动就挂。用 PE 导入表逐函数比对 System32 导出表定位到
    `comctl32.dll!TaskDialogIndirect`——`rfd` / `tauri-plugin-dialog` 静态导入 comctl32 **v6**
    的函数，而该版本只有当 exe 内嵌清单声明 `Microsoft.Windows.Common-Controls` v6 依赖时
    才会被加载器激活；GUI bin 由 tauri-build 的 winres 内嵌了这份清单，`cargo test` 的
    harness exe 却什么都没有（资源 .lib 无符号被链接器丢弃），加载器落到 v5.8 的
    System32 comctl32.dll 上找不到入口点。修复：build.rs 里
    `cargo:rustc-link-arg=-MANIFESTDEPENDENCY:...`。注意**不能用
    `cargo:rustc-link-arg-tests`**——本包只有 lib 单元测试、没有 `[[test]]` 目标，
    cargo 直接报「does not have a test target」；而全局 `rustc-link-arg` 对已带自定义
    清单的 GUI bin 会被 link.exe 忽略，无副作用。
96. **PE 导出目录偏移极易搞错，错一位就"全报 missing"**：`IMAGE_EXPORT_DIRECTORY`
    里 NumberOfFunctions=+20、**NumberOfNames=+24**、AddressOfFunctions=+28、
    **AddressOfNames=+32**；把 +20/+28 当成名字数量/名字表读出的全是垃圾 RVA。
    另外 exe 目录放外部 `.exe.manifest` 做实验不可靠（exe 若已内嵌清单会被忽略），
    不如直接在 exe 字节里搜 `urn:schemas-microsoft-com:asm.v1` 判断有无内嵌清单。
97. **PS5 脚本里单行 `if (...) { return @{...} }` 会解析失败**：hashtable 字面量收尾的
    `} }` 在语句块中产生歧义，报错位置还飘到几十行之后（Unexpected token '}'）；
    把 hashtable 返回写成多行即可。排查用
    `[System.Management.Automation.Language.Parser]::ParseFile` 拿精确行列。
98. **沙箱会拦截 cargo 写操作并把构建产物移入回收站**（exit -1073741511），cargo 命令必须
    `dangerouslyDisableSandbox`；此前"产物损坏导致测试崩溃"的猜测被全量 `cargo clean`
    重建后仍复现同一崩溃证伪——环境问题要先用最小 probe 工程隔离，再定位二进制层面根因。
99. **known_hosts 哈希条目（`|1|...`）不可按明文主机删除**：`remove_host` 按明文 host+port
    匹配行，哈希条目明文不可恢复，因此列表里只显示「哈希条目」徽标、不给删除/转换按钮。
100. **新增 command 只注册了 `lib.rs` 会违反 R4**：本轮收尾新增的
    `list_ssh_key_files` / `known_hosts_list` / `known_hosts_remove` 最初只进了 GUI 的
    `generate_handler!`，headless dispatcher（`server.rs`）漏注册——`read_default_key_file`
    本来就在 dispatcher 里，同族的 vault 命令必须两处对齐。补注册时把
    `known_hosts_list/remove` 拆成 `*_impl(&AppState)` + 薄 command 包装：带
    `State<AppState>` 提取器的函数 dispatcher 无法直接调用，这是仓库既有的双宿主模式
    （对照 `list_recordings_impl` / `export_config_impl`）。验证：
    `cargo check --features server` 通过（默认 `cargo check` 不编译 server.rs，
    改 dispatcher 必须显式带 feature 检查）。

## 2026-11-02 · 差距盘点：主机管理/连接建立 与 Netcatty 1:1 对齐（第二轮）

上一轮被判「仅能连能用、不算 1:1」。本轮逐控件盘点差距（对照
`Netcatty/components/HostDetailsPanel.tsx`、`HostDetailsConnectionSections.tsx`、
`KeychainEditPanel.tsx`、`KnownHostsManager.tsx` 与 zh-CN i18n）：

### A. Composer（VaultView.tsx L2408-2744）

| 项 | 现状 | 目标（Netcatty） |
| --- | --- | --- |
| 标题 | 编辑主机/新建主机 | **主机详情**/新建主机 |
| 头部按钮 | 仅 X 关闭 | 测试连接(zap) + 保存(check) + X，禁用条件=名称或地址为空 |
| 底部 | 保存 + 保存并连接 | 固定「保存」单按钮 |
| 分区顺序 | 名称→地址→端口凭据→**高级占位区**→组织与初始化 | 通用→地址→端口与凭据→验证器(TOTP)→SFTP 设置→颜色与图标 |
| 高级占位区 | ADVANCE_PLACEHOLDERS 7 行「未移植」 | **删除**（运行中 Netcatty composer 无此入口） |
| 名称 | label「名称」placeholder「例如 生产 Web」 | 无 label，placeholder「名称（例如：Production Server）」 |
| 分组/标签 | 在底部「组织与初始化」 | 移入「通用」分区；分组 placeholder「父级 Group」；标签 placeholder「Add tags...」 |
| 地址 placeholder | 主机名或 IP 地址 | 「IP 或 主机名」 |
| 登录方式 | 下拉+hint ✓ | 保留；「MFA / 交互式登录」改名「优先交互式认证」（hint 不变） |
| 用户名 | 默认空，placeholder「例如 root」 | **默认 root** |
| 密钥选择 | auth=key 时直接显示「本地私钥」下拉 | 「+ 密钥/证书/本地密钥」链接按钮→菜单→身份行：「搜索密钥…」combo（空态「暂无密钥」）+X 删除 |
| 保存密码 | 密码区常显 checkbox「保存密码到钥匙串」 | 编辑模式且已存密码时显示「保存密码」toggle |
| TOTP | 无 | 分区「验证器 (TOTP)」：hint+「设置…」→对话框「设置验证器」（密钥或 otpauth URI 输入、导入二维码图片/屏幕扫描[禁用占位]、自动提交 toggle 默认开、自定义提示正则、取消/保存） |
| SFTP | 无 | 分区「SFTP 设置」：文件协议(auto/仅 SFTP/SCP 模式)、Sudo 提权模式 toggle(scp 时禁用)、文件名编码(auto/UTF-8/GB18030) |
| 颜色与图标 | 无 | 分区「颜色与图标」：图标预览、「来源」(自动探测/自定义)、「图标颜色」(自动+16 色) |

### B. 已知主机页（VaultView.tsx knownHostsPanel L1463-1553）

- 现状：标题栏+计数+刷新按钮、行式列表、搜索「搜索主机 / 类型 / 指纹…」。
- 目标：工具栏=搜索「搜索已知主机...」+视图图标+排序图标+「扫描系统」+「导入文件」；
  卡片网格，每卡两按钮（未转主机的显示「转换为主机」箭头、所有卡都有删除）；
  卡片右键菜单同两项；删除有确认；空态「暂无已知主机」+
  「Known Hosts 是你之前连接过的 SSH server。导入系统的 known_hosts 文件以开始。」
- 后端缺：`known_hosts_scan_system`（重读合并 ~/.ssh/known_hosts）、
  `known_hosts_import_file(path)`（导入外部 known_hosts 文件，去重合并）。
  前端选文件可复用已有 `sftp_pick_open_path`。

### C. 钥匙串页（完全缺失）

- navItems 里 keys 未 enabled；无页面。
- 目标：工具栏「新建密钥」(caret 下拉：生成密钥/导入密钥)+「导入证书」+「新建身份」+
  搜索「搜索...」+视图图标；分区「密钥 N 项」；空态=盾牌图标+「设置密钥」+
  「导入或生成 SSH 密钥用于安全认证。」+「导入」「生成」按钮；
  编辑面板（对照 KeychainEditPanel）：label 输入、私钥 textarea
  (placeholder「-----BEGIN OPENSSH PRIVATE KEY-----」)、公钥 textarea
  (placeholder「ssh-ed25519 AAAA...」)、保存禁用=!label||!privateKey。
- 后端缺：密钥生成（ed25519/rsa，russh::keys::generate_keypair）、导入；
  私钥必须走 SecretStore。方案：复用 credentials 表（type=key/certificate，
  secret=私钥走 SecretStore，公钥存 username 字段——内部约定需注释说明）。

### D. 连接对话框（待核对 src/terminal/ 或 ConnectionManager）

- 主机密钥弹窗文案对齐：「无法验证 {hostname} 的真实性。」/按钮「加入并继续」；
  变更后「主机指纹已变化」/「更新并继续」；指纹行「{keyType} 指纹为 SHA256：」。
- 认证重试表单、进度对话框文案对齐（正在连接…/连接失败。/重试）。

### E. 工具栏/卡片行为

- 主机卡片右键现在是功能菜单（连接/编辑/复制/删除…）→ **删除右键菜单，右键=连接**
  （Netcatty 单击与右键都是连接；编辑仅走 hover Edit 按钮）。
- 缺 composer 开关图标（打开面板时高亮，右侧三按钮隐藏已实现）。
- 快速连接解析 ✓ 已有（占位符与闪电图标一致）。

### F. Profile 新字段（后端，schema v33）

models.rs Profile 需新增（全部 serde(default) 保证旧数据兼容）：
`sftp_protocol: Option<String>`(auto/sftp/scp)、`sftp_sudo: bool`、
`sftp_encoding: Option<String>`(auto/utf-8/gb18030)、`icon_source: Option<String>`、
`icon_color: Option<String>`、`totp_auto_submit: bool`(默认 true)、
`totp_regex: Option<String>`。**TOTP secret 是密钥材料，按 R6 走 SecretStore
（key 约定 `totp:<profile_id>`），不入 profiles 表**。
schema.rs SCHEMA_VERSION 32→33 开新块 ALTER TABLE profiles ADD COLUMN；
profile.rs upsert/from_row 同步；client.ts Profile 类型同步。

### 实施顺序

composer（含 profile 新字段后端）→ 已知主机 → 钥匙串 → 连接对话框 →
工具栏/卡片 → 后端收尾（双注册+测试）。每块后 `npm run build`；
收尾跑 `cargo check` / `cargo check --features server` / `cargo test --lib`。

## 2026-11-02 · 前端单元测试设施（Vitest + jsdom）

目标：补上审计缺口「前端无测试 runner，门禁只有 tsc --noEmit」（todo.md 代码质量问题 #4）。
只加 devDependencies，不动 React / Vite / TS 版本；测试不依赖真实网络 / SSH / Tauri 运行时。

### 修改点

1. **依赖（全部 devDependencies）**：`vitest@^3`（3.2.7）、`@vitest/coverage-v8@^3`、
   `jsdom`（29.x）、`@testing-library/react`（16.x，React 19 兼容）、`@testing-library/dom`、
   `@testing-library/jest-dom`（7.x）。
2. **配置**：新建 `vitest.config.ts`（environment=jsdom、setupFiles、
   include `src/**/*.{test,spec}.{ts,tsx}`、exclude `src-tauri/` 与 `dist/`）+
   `src/test/setup.ts`（jest-dom 匹配器 + 每用例后 RTL cleanup）。
   **刻意独立于 vite.config.ts**：vitest 存在 vitest.config.ts 时只读它，
   避免测试配置与 Tauri devServer（端口/HMR/watch）互相牵扯。
3. **脚本**：`npm test`（watch）、`npm run test:run`（一次性/门禁）、`npm run test:coverage`。
4. **测试（9 文件 71 用例，全部通过，约 5s）**：
   - `src/domain/sshErrors.test.ts`：`__rssh_err__|` 前缀解码、认证失败 code/原文判定；
   - `src/domain/sshConnectionTimeouts.test.ts`：拨号/认证两段超时切换、超时启用条件；
   - `src/domain/hostKey.test.ts`：snake_case 载荷 → camelCase 映射、端口兜底；
   - `src/domain/connectionProgress.test.ts`：进度只增不减、95% 封顶、多跳映射；
   - `src/domain/vaultMarqueeSelection.test.ts`：框选矩形/阈值/修饰键模式/相交判定/合并语义/滚动坐标换算；
   - `src/workspaceModel.test.ts`：splitLeaf/removeLeaf/replaceLeaf/updateRatio 夹取/叶子收集顺序；
   - `src/backend/workspaceStore.test.ts`：localStorage 往返、坏 JSON/版本/结构损坏兜底；
   - `src/backend/client.test.ts`：mock `@tauri-apps/api` 验证 invoke 参数形状
     （sessionId 注入、authOverride null 兜底、write 上行 number[]、base64 下行解码、事件名约定）；
   - `src/terminal/TerminalAuthDialog.test.tsx`：认证重试表单（禁用态、Enter 提交、密钥下拉、空态）。
5. **AGENTS.md**：新增置顶规则 **R11**（每次改完代码必须跑 `npm run test:run`，
   门禁顺序 `npm run test:run` → `npm run build` / `cargo check`；新增可测试逻辑同步补测试）；
   「构建命令」「测试现状」「事实表」「Pr5 提交前自查」「不要做的事」同步增量更新。

### 踩坑经验

1. **RTL 在 vitest 非 globals 模式不会自动 cleanup**：首个用例渲染残留在
   `document.body`，后续用例 `getByRole` 报 "Found multiple elements"。
   解法：`src/test/setup.ts` 里 `afterEach(() => cleanup())`（开 `globals: true` 也可，
   但会要求 tsconfig 加 `types: ["vitest/globals"]`，选择显式 import + 手动 cleanup）。
2. **jest-dom 7.x 要走 `@testing-library/jest-dom/vitest` 子入口**才能扩展 vitest 的
   `expect`（老文档里的裸 import 只扩 jest 全局）。
3. **Tauri mock 用 `vi.mock` 顶层工厂**（自动 hoist 到 import 之前）：
   `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))`，
   再把 `invoke as unknown as ReturnType<typeof vi.fn>` 拿回 mock 句柄，
   避免泛型 `invoke<T>` 与 mockResolvedValue 的类型摩擦。
4. **测试文件放 src/ 内会被 `npm run build` 的 tsc --noEmit 一并检查**
   （tsconfig include: ["src"]）——这是优点不是坑：测试与构建共用一套类型门禁，
   无需第二份 tsconfig；代价是写测试要过 `noUnusedLocals/noUnusedParameters`。
5. **查询文案重复的控件用 role 定位**：认证弹窗里「选择密钥」既是字段 label
   又是下拉触发按钮文案，`getByText` 命中两个节点，改 `getByRole("button", { name })`。
6. **并行会话影响**：落地时 `npm run build` 被另一会话编辑中的
   `src/VaultView.tsx` 染红（15 个 tsc 错误全部在该文件：未用变量 +
   `ADVANCE_PLACEHOLDERS` 删除进行中等），与测试设施无关——测试文件本身 0 类型错误、
   `npm run test:run` 全绿。VaultView 收尾后构建门禁即恢复。

## 2026-11-02 · 第二轮 1:1 对齐 · 块 F（Profile 新字段后端）+ 块 A（Composer 重构）

对照差距盘点 A/F 两节落地。实施顺序第一、二块完成。

### 修改点

后端（`src-tauri`）：

1. **块 F · Profile 新字段（schema v32→33）**：
   - `src/models.rs`：Profile 新增 7 字段 `sftp_protocol: Option<String>`、
     `sftp_sudo: bool`、`sftp_encoding: Option<String>`、`icon_source: Option<String>`、
     `icon_color: Option<String>`、`totp_auto_submit: bool`（`default_totp_auto_submit`
     返回 true）、`totp_regex: Option<String>`，全部 `serde(default)` 兼容旧数据。
   - `src/db/schema.rs`：`SCHEMA_VERSION = 33`；`if version < 33` 迁移块
     ALTER TABLE profiles ADD COLUMN ×7（5 个 TEXT DEFAULT NULL +
     sftp_sudo INTEGER NOT NULL DEFAULT 0 + totp_auto_submit INTEGER NOT NULL DEFAULT 1），
     每列带 `column_exists` 幂等守卫。
   - `src/db/profile.rs`：`PROFILE_COLUMNS` 常量（16 列）统一 list/get/insert_tx/update
     的 SQL 列清单；`row_to_profile` 读 16 列；测试夹具 `mk` 补 7 字段。
   - 全部 Profile 字面量构造点补 7 字段默认值：`bin/rssh/commands/add.rs`、
     `db/group.rs`、`ssh/bastion.rs`、`ssh/forward.rs`、`ssh/client.rs`（4 处）、
     `commands/sync.rs`、`sync/config.rs`。（`bin/rssh/main.rs:44` 是枚举变体
     `Cmd::Profile`，不是字面量，无需改。）
   - TOTP secret 按 R6 走 SecretStore：`src/secret/mod.rs` 新增
     `totp_secret_key(profile_id) -> "totp:<profile_id>"`，不入 profiles 表。
2. **块 A 后端 · TOTP 读写命令**：`src/commands/profile.rs` 新增
   `profile_totp_get_impl/_get`、`profile_totp_set_impl/_set`（secret 为 None/空白=移除），
   `lib.rs` 与 `server.rs` dispatcher 双注册（R4）。
3. **`cargo check --all-targets` 通过**（仅 6 个遗留 warning）。

前端（`src`）：

4. **`src/backend/client.ts`**：Profile 接口加 7 可选字段；新增
   `getProfileTotp(profileId)` / `setProfileTotp(profileId, secret | null)`。
5. **`src/ui/icons.tsx`**：新增 `"check"` 图标（composer 头部保存按钮用）。
6. **`src/VaultView.tsx` composer 全量重写（对照 Netcatty HostDetails）**：
   - 删除 `ADVANCE_PLACEHOLDERS`；新增 `ICON_COLORS`（自动 + 16 色含 hex）、`CredPick`。
   - `ComposerDraft` 新增 `sftp_protocol/sftp_sudo/sftp_encoding/icon_source/icon_color/
     totp_auto_submit/totp_regex`；**id 改为新建时预生成 `newId()`**（TOTP secret 在
     保存前就要有稳定 key）。
   - 新 state：`credMenu/credPick/credSearch/totpConfigured/totpDialog/testState/
     testCleanupRef`。
   - `openComposer`：username 默认 `"root"`；`openComposerForEdit`：回填 7 新字段、
     载入 TOTP 配置状态、按已绑凭据类型展开凭据选择器。
   - 保存拆成 `persistComposerDraft(d): Promise<Profile | null>`（校验 + 凭据 upsert +
     落库，返回 Profile）与 `saveComposer()`（persist 后关闭）——测试连接复用 persist。
   - **测试连接**：`startConnectionTest` 先落库再 `sshConnect`，监听
     `ssh:progress:<sessionId>` 驱动状态机（connecting→…→connected/error），
     `stopConnectionTest` 清理监听与会话；对话框展示阶段文案/错误/成功。
   - **TOTP 对话框**：`openTotpDialog/parseTotpInput/saveTotpDialog/removeTotp`，
     支持裸密钥或 `otpauth://` URI 解析、自动提交 toggle（默认开）、自定义提示正则、
     导入二维码图片占位（禁用）、屏幕扫描占位（禁用）。
   - JSX 六分区：通用（名称无 label + 分组「父级 Group」+ 标签「Add tags...」）→
     地址（placeholder「IP 或 主机名」）→ 端口与凭据（「+ 密钥/证书/本地密钥」链接按钮
     弹菜单、身份行、「搜索密钥…」combo 空态「暂无密钥」、保存密码 toggle）→
     验证器 (TOTP) → SFTP 设置（协议 / Sudo 提权 scp 时禁用 / 文件名编码）→
     颜色与图标（预览 / 来源 / 自动+16 色）。
   - 头部：标题「主机详情/新建主机」+ 测试连接(zap) + 保存(check) + 关闭(x)，
     禁用条件=名称或地址为空；底部固定单「保存」按钮。
7. **`src/styles.css`**：新增 `vault-composer-head-actions`、`host-link-btn(.danger)`、
   `host-cred-link-row/-menu`、`host-localkey-wrap`、`host-key-combo*`、
   `host-totp-*`、`vault-totp-dialog`、`vault-test-dialog`、`host-test-*`、
   `host-switch.disabled`、`host-icon-preview`、`host-color-swatch*`、`host-save-full`。

### 验证

- `npm run build`（tsc --noEmit + vite build）通过（61 模块）。

### 踩坑

101. **`CredentialType` 没有 `"certificate"`，三元链收窄触发 TS2367**：
    `cred?.type === "key" ? "key" : cred?.type === "certificate" ? ...` 在 false 分支
    被 TS 收窄为排除 `"key"` 的联合，与 `"certificate"` 比较报「no overlap」。
    termX 未移植证书凭据（AUTH_METHODS 里 certificate 项 enabled:false），
    直接 `setCredPick(cred?.type === "key" ? "key" : null)`。
102. **server.rs headless dispatcher 的参数 key 是 camelCase**：`fn arg<T>` 注释
    「camelCase, as Tauri sends it on the wire」，`profile_totp_get/set` 必须
    `arg::<String>(&args, "profileId")`，写成 `"profile_id"` 会运行时取不到参数。
103. **事件监听句柄的 TDZ**：`startConnectionTest` 里 `const unlisten = await listen(...)`
    之后才能在回调里 unlisten，但完成回调 `finish` 在 listen 注册前就闭包引用它会 TDZ；
    改先 `let unlistenFn: (() => void) | null = null`、listen 成功后赋值。
104. **composer 草稿 id 必须新建时预生成**：TOTP secret 的 SecretStore key 是
    `totp:<profile_id>`，若 id 在保存时才生成，设置 TOTP 对话框就没有稳定 key 可写。

## 2026-11-02 · 第二轮 1:1 对齐 · 块 B（已知主机页 + 扫描/导入后端）

对照差距盘点 B 节与 `Netcatty/components/KnownHostsManager.tsx`、zh-CN i18n 落地。

### 修改点

后端（`src-tauri`）：

1. **`src/ssh/known_hosts.rs`**：新增 `merge_entries(content, path)`——外部 known_hosts
   文本去重合并进目标文件：注释/空行/坏行跳过；非哈希条目按
   (host, port, key_type, public_key) 去重并规范化为 `host` / `[host]:port` 形式；
   哈希条目按整行精确去重原样追加；目标文件不存在则创建（含父目录）、结尾换行补齐。
   补 5 个单元测试（建文件/去重/规范化/哈希行/全重复不改文件）。
2. **`src/commands/profile.rs`**：新增 `known_hosts_scan_system_impl/_command`
   （重读 `~/.ssh/known_hosts`；`None`=文件不存在，`Some(n)`=条数——termX 列表本身
   即系统文件，扫描=重读）与 `known_hosts_import_file_impl/_command`
   （外部文件去重合并，返回新增条数）。
3. **双注册（R4）**：`lib.rs` generate_handler + `server.rs` dispatcher
   （`known_hosts_import_file` 取 camelCase `"path"` 参数）。

前端（`src`）：

4. **`src/ui/icons.tsx`**：新增 `arrow-right` / `import` / `folder-open`（lucide 路径）。
5. **`src/backend/client.ts`**：新增 `knownHostsScanSystem()`（number|null）、
   `knownHostsImportFile(path)`。
6. **`src/VaultView.tsx` 已知主机页重写**：
   - 工具栏：搜索「搜索已知主机...」+ 视图切换（网格/列表，持久化
     `termx.vault.khView.v1`）+ 排序（手动顺序/A-z/Z-a/从新到旧/从旧到新，
     文件顺序≈发现顺序）+ 分隔线 +「扫描系统」（refresh 旋转）+「导入文件」。
   - 卡片：按主机名去重保留靠后条目（对齐 netcatty）；server 图标 + 主机名，
     hover 显示操作（未转换→转换为主机 arrow-right；删除 trash）；
     已存在同 host:port 档案 → 卡片降透明、隐藏转换按钮；右键菜单同两项。
   - 删除改走确认对话框：标题「删除“{host}”？」+「此操作不可撤销。」+ 取消/删除
     （对齐 VaultDeleteConfirmDialog），弃用 window.confirm。
   - 空态：盾牌圆角图标 +「暂无已知主机」+「Known Hosts 是你之前连接过的 SSH
     server。导入系统的 known_hosts 文件以开始。」+ 扫描系统/浏览文件按钮。
   - RENDER_LIMIT=100 +「显示 x/y 个主机。使用搜索查找特定主机。」提示。
   - 新弹层（khViewMenu/khSortMenu/khCtx）接入既有点击外部/Escape 关闭逻辑。
7. **`src/styles.css`**：删除旧 `vault-known-host-row` 系列，新增 `kh-toolbar*`、
   `kh-action-btn(.outline)`、`kh-spin`、`kh-grid/kh-list`、`kh-card(.list/.converted)`、
   `kh-card-icon/-name/-actions`（hover 显隐）、`kh-empty*`、`kh-limit-note`、
   `kh-delete-modal/-title/-desc`。

### 验证

- `cargo check --all-targets --features server` 通过（仅遗留 warning）。
- `cargo test --lib known_hosts`：**19 passed / 0 failed**（含新增 5 个合并测试）。
- `npm run build` 通过（61 模块）。

### 踩坑

105. **已知主机「扫描系统」语义在 termX 与 netcatty 不同**：netcatty 的应用内列表
    与系统文件分离，扫描=把系统条目导进应用存储；termX 的列表就是
    `~/.ssh/known_hosts` 本身（TOFU `learn_known_hosts_path` 也写这里），
    所以 `known_hosts_scan_system` 只能做「重读并报告条数」，toast 文案相应改为
    「已扫描系统 known_hosts，共 N 条。」；「导入文件」才是真正的合并入口。
106. **`parse_line` 逗号多模式取第一个别名，端口只挂在被取的那段上**：
    `a.example,b.example:2200` 解析为 host=a.example port=22——写合并测试时
    别指望从第二个别名拿端口。
107. **文件级合并去重键不能只用 host:port**：同主机多密钥（轮换/多算法）合法存在，
    用 (host, port, key_type, public_key) 四元组；哈希条目明文不可恢复，
    退化为整行精确去重。

## 2026-11-02 · 第二轮 1:1 对齐 · 块 C（钥匙串页 + 密钥生成/导入后端）

对照差距盘点 C 节与 `Netcatty/components/KeychainManager.tsx`、
`KeychainEditPanel.tsx`、`keychain/{KeyCard,GenerateStandardPanel,ImportKeyPanel,ViewKeyPanel}.tsx`
及 zh-CN i18n 落地。

### 修改点

后端（`src-tauri`）：

1. **`Cargo.toml`**：新增 `rand = { version = "0.10", features = ["thread_rng"] }`
   （ssh-key 的 `PrivateKey::random` 要 rand_core 0.10 的 CryptoRng，
   rand 0.10 的 ThreadRng 与之同版本对齐）。
2. **新增 `src/commands/keychain.rs`**：
   - `keychain_generate_key_impl/_command`：ED25519 / ECDSA(P-256/384/521) /
     RSA（缺省 4096，其他位宽走 `private::RsaKeypair::random`）；
     comment 约定 `{label}@termx`；passphrase 非空时加密私钥（`encrypt(rng, pw)`）；
     产出 OpenSSH 文本（私钥 LF 行尾）。
   - `keychain_import_key_impl/_command`：先 `PrivateKey::from_openssh`，
     失败回退 `decode_secret_key`（PPK/传统 PEM/PKCS#8）；公钥缺省时从私钥推导。
   - 复用 `credentials` 表：`credential_type=key`，私钥走 SecretStore
     （`cred:<id>:secret`），**公钥行存 username 字段**（内部约定，模块头注释说明）；
     passphrase 不持久化。
3. **双注册（R4）**：`lib.rs` generate_handler + `server.rs` dispatcher
   （`bits` 取 `as_u64→u32`，`passphrase`/`publicKey` 可选）。
4. 测试：`cargo test --lib keychain` **5 passed**（ed25519 落库断言 / RSA 2048 位宽 /
   带口令加密私钥往返 / 空 label 与未知算法拒绝 / 导入往返 + 垃圾输入拒绝）。

前端（`src`）：

5. **`src/ui/icons.tsx`**：新增 `upload` / `badge-check`（lucide 路径）。
6. **`src/backend/client.ts`**：新增 `keychainGenerateKey(label, algorithm, bits?, passphrase?)`、
   `keychainImportKey(label, privateKey, publicKey?)`（均返回 Credential）。
7. **`src/VaultView.tsx` 钥匙串页**：
   - navItems keys 启用；视图模式持久化 `termx.vault.kcView.v1`。
   - 工具栏：「新建密钥」split button（主体=导入面板，caret 下拉=「生成密钥」）+
     「导入证书」（badge-check，同开导入面板）+ 搜索「搜索...」（面板打开时隐藏）+
     视图下拉（网格/列表）。
   - 分区：「密钥」+「{n} 项」；空态 = 盾牌圆角图标 +「设置密钥」+
     「导入或生成 SSH 密钥用于安全认证。」+ 导入/生成按钮；无结果「没有匹配结果」。
   - 卡片（对照 KeyCard）：grid 68px / list 56px，key 图标 + label +
     `Type {type}` mono 小字（类型由公钥行首段推导 `kcTypeOf`），hover 显铅笔编辑，
     选中 ring；右键 = 复制公钥（无公钥禁用）/ 编辑 / 分隔 / 删除。
   - 侧滑面板（380px，内容 margin-right 让位）四模式，标题映射
     新建密钥/生成密钥/密钥详情/编辑密钥：
     导入（名称/私钥 */公钥/密码短语+眼睛+保存 Passphrase/拖放区「将密钥文件拖到这里」+
     「从文件导入」/「保存密钥」，禁用=!label||!privateKey）；
     生成（密钥类型 select：标准密钥 ED25519/ECDSA/RSA + 安全密钥 · FIDO2 组置灰，
     RSA bits [4096,2048,1024] / ECDSA P-[256,384,521]，「正在生成…」/「生成并保存」）；
     详情（名称/公钥盒+复制 2s 勾选反馈/类型，头部 复制/编辑/删除 图标钮）；
     编辑（对照 KeychainEditPanel：Label */私钥 *（placeholder
     「-----BEGIN OPENSSH PRIVATE KEY-----」）/公钥（placeholder「ssh-ed25519 AAAA...」）/
     密码短语，「保存修改」禁用=!label||!privateKey）。
   - 删除确认对话框复用 kh-delete-modal（删除“{name}”？/ 此操作不可撤销。）；
     新弹层（kcNewMenu/kcViewMenu/kcCtx）接入既有点击外部/Escape 关闭逻辑。
8. **`src/styles.css`**：新增 kc-* 系列（工具栏/split button/主按钮/卡片/空态/无结果/
   侧滑面板/表单控件/拖放区/公钥盒）+ `.term-context-menu button:disabled` 置灰。

### 验证

- `cargo check --all-targets --features server` 通过；`cargo test --lib keychain` 5/5。
- `npm run build` 通过；`npm run test:run` **71 passed / 0 failed**。

### 踩坑

108. **`PrivateKey::random` 对 RSA 固定 4096 位**：ssh-key 的 `random()` 内部用
    DEFAULT_RSA_KEY_SIZE，忽略位宽参数——其他位宽必须走
    `private::RsaKeypair::random(rng, bits)` + `PrivateKey::try_from(KeypairData::from(kp))`。
109. **ssh-key 的 rand 版本对齐**：russh 0.62.7 re-export 的 ssh-key 0.7.0-rc.11
    依赖 rand_core 0.10；ThreadRng 必须来自 rand 0.10（`rand::rng()`，
    feature `thread_rng`）。rand_core 0.10 里 `CryptoRng: Rng + TryCryptoRng<Error=Infallible>`，
    所以同一个 ThreadRng 同时满足 `random()` 与 `encrypt()` 两处约束。
110. **钥匙串存储约定**：credentials 表没有公钥字段——约定公钥行存 username，
    密钥类型显示由前端从公钥行首段推导（`kcTypeOf`），避免 schema 变更；
    passphrase 只在生成时用于加密私钥本体，从不单独持久化。
111. **Netcatty「新建身份」是条件渲染**：仅当 `onSaveIdentity` prop 存在才渲染；
    termX 无身份功能，不渲染（差距盘点允许）。「导出密钥」/ 导出面板不在块 C 目标内，
    未实现；「导入证书」按钮在 netcatty 也是打开导入面板（证书暂无独立存储）。
112. **凭据列表接口不返回 secret**：编辑面板私钥需 `getCredential(id)` 二次取全量；
    `update_credential` 的 `save_credential_secrets` 对空/ null secret 是**删除**
    SecretStore 条目——编辑保存前强制私钥非空（必填校验），不会误删。

## 2026-11-02 · 第二轮 1:1 对齐 · 块 D（连接建立对话框 1:1）

对照 `Netcatty/components/terminal/{TerminalConnectionDialog,TerminalAuthDialog,
TerminalHostKeyVerification,TerminalConnectionProgress}.tsx`、
`components/host-details/HostConnectionTestDialog.tsx`、
`components/terminal/runtime/createTerminalSessionStarters.ts`（逐跳日志）、
`components/terminal/hooks/useTerminalAuthState.ts`（认证默认值）与
zh-CN i18n（vault.ts 636-680、133-141）逐字对齐。

### 修改点

1. **`src/terminal/TerminalAuthDialog.tsx`**：
   - tab「SSH 密钥」→「SSH Key」；用户名 placeholder→「root」；
     密码 placeholder→「输入密码」；密钥空态→「暂无密钥，请先在钥匙串中添加。」；
     密钥选择器未选时 placeholder→「选择 SSH密钥」（hostForm.auth.selectKey）；
     「私钥口令（可选）」→「密码短语」，placeholder→「可选：所选私钥的密码短语」。
   - 新增 `onSubmitWithoutSave?` prop：Enter 与主按钮「继续」走
     `onSubmitWithoutSave ?? onSubmit`；caret 下拉「继续并保存」走 `onSubmit`。
   - 底部由单「继续」按钮改为分体按钮（继续 + caret「继续并保存」）。
2. **`src/terminal/TerminalConnectionDialog.tsx`**：链式标题
   `{hop}/{total}:`→`Chain {current} / {total}: `（zh-CN 保留英文）；
   连接中关闭按钮「取消中…」→「正在取消...」；断连 X 的 title→「关闭断连提示」。
3. **`src/terminal/TerminalHostKeyVerification.tsx`**：标题「未知的主机密钥」→
   「确认主机指纹」、「主机密钥已变更」→「主机指纹已变化」；描述→
   「尚未确认 {host} 的真实性。」/「{host} 的已保存指纹与当前服务器不一致。」；
   指纹标签→「{keyType} 指纹为 SHA256：」；hint→「如果这个指纹属于你预期连接的
   服务器，可以记住它。」/「只有在你确认这台主机确实变更过时才继续。」；
   「加入并继续」→「记住并继续」（changed 仍「更新并继续」）。
4. **`src/terminal/TerminalConnectionProgress.tsx`**：倒计时→「将在 {seconds}s 后超时」；
   「等待用户输入…」→「等待用户输入」（去省略号）；重试按钮默认文案
   「重新连接」→「重新开始」（startOver）。
5. **`src/TerminalPane.tsx`**：
   - 逐跳日志行逐字对齐 netcatty zh-CN 实际输出：`Connecting to {label}...` /
     `{label} - TCP connected` / `Key exchange complete` / `Authenticated` /
     `{label} - 已连接` / `Forwarding...` / `Opening shell...` / `Error: ...`；
     新增 auth-attempt 分支（`✗ {error}`、`✗ All authentication methods exhausted`、
     等待输入原样、其余 `Trying {error}...`），并据此切换「等待用户输入」状态。
   - 认证重试默认值对齐 useTerminalAuthState：默认密码 tab（不再按凭据类型自动切
     key tab）、不预选密钥、用户名预填 `credential.username || "root"`（初值 "root"）。
   - AUTH_RETRY_MESSAGE→「身份验证失败。请检查凭据后重试。」；重试日志行→
     「身份验证失败，请重试。」（terminal.auth.retryMessage/retryLog 原文）。
   - 新增 `submitAuthAndSave`（继续并保存）：先按一次性覆盖连接，再异步写回
     凭据（密码：username+secret；换选密钥：updateProfile 改 credential_id +
     更新 username），落库失败不阻塞连接；authProps 接线
     `onSubmit=submitAuthAndSave` / `onSubmitWithoutSave=submitAuth`。
6. **`src/backend/client.ts`**：SshProgressEvent.status 注释补充 `auth-attempt`。
7. **`src/styles.css`**：新增 `.conn-btn-split*` / `.conn-save-menu`（分体按钮 +
   上拉菜单）；`.conn-dialog-actions` 改 `space-between`（对齐 netcatty 底部布局）。
8. **`src/VaultView.tsx`**：测试连接超时 30s→25s，倒计时文案同步
   （对齐 netcatty deadline = TCP 8s + auth 15s + grace 2s）。

### 验证

- `npx tsc --noEmit` 通过（块 D 完成时点）。
- 测试连接入口已在既有 ssh 连接链路上（ssh_connect + 进度事件 + 成功即
  sshDisconnect，「只认证不开 shell」语义以连接成功后立即断开实现，代码注释说明）。

### 踩坑

113. **netcatty zh-CN 逐跳日志是中英混排**：`terminal.progress.connecting/
    tcpConnected/keyExchangeComplete/trying/authenticated/forwarding/openingShell/
    error` 等键在 zh-CN 语言包里**不存在**，`tr(key, fallback)` 回落英文原文；
    只有 `terminal.progress.connected`=「已连接」有译文。1:1 输出就是英文行 +
    一行「已连接」，不能全翻成中文。
114. **认证重试表单默认值以 useTerminalAuthState 为准**：永远默认密码 tab、
    密钥不预选、用户名 `host.username || "root"`——即使主机存的是密钥认证，
    重试表单也停在密码 tab（此前 termX 会按凭据类型自动切 tab / 预选密钥，已删）。
115. **分体按钮语义映射**：netcatty「继续」= `onSubmitWithoutSave`
    （不写回）、「继续并保存」= `onSubmit`（写回主机）。termX 侧
    「继续」= 既有一次性覆盖（不写 DB），「继续并保存」= 新增
    `submitAuthAndSave` 经 `updateCredential`/`updateProfile` 落库；
    netcatty 的 HostConnectionTestDialog 两个槽位传的是同一个 submitAuth。
116. **测试连接 deadline 不是整数 30s**：netcatty 为
    `TEST_TCP_CONNECT_TIMEOUT_MS(8000) + TEST_AUTH_READY_TIMEOUT_MS(15000) +
    TEST_DEADLINE_GRACE_MS(2000)` = 25s，termX 原 30s 倒计时改为 25s。
117. **主机密钥文案以 netcatty zh-CN 原文为准**：任务描述里的「无法验证
    {hostname} 的真实性」「加入并继续」是近似表述，实际原文是
    「尚未确认 {host} 的真实性。」与「记住并继续」（vault.ts 673/679）。

## 2026-11-02 · 第二轮 1:1 对齐 · 块 E（主机卡片行为对齐）

对照 `Netcatty/components/vault/VaultHostListSection.tsx`（卡片右键 9 项）、
`components/host/HostTreeContextMenus.tsx`、`components/vault/VaultViewLayout.tsx`
（工具栏新建主机分体按钮 + 终端/串口）与 zh-CN i18n（core.ts 784-806、
vault.ts 507/560/1030）落地。

### 修改点

1. **`src/VaultView.tsx` 主机卡片右键菜单 1:1**（9 项、无分隔线、顺序对齐）：
   连接（图标 terminal→plug）/ 打开 SFTP（原「双栏 SFTP」，未实现置灰）/
   打开浏览器（原「主机浏览器」，置灰）/ 编辑 / 复制（原「复制副本」）/
   复制主机地址（原「复制主机名」，图标 server→copy）/ 复制账密信息 /
   置顶·取消置顶 / 删除（danger）。删除 Netcatty 没有的「标签…」条目与
   两条分隔线（Netcatty 菜单无分隔线）。
2. **删除孤儿 tagEditor 弹层**：其唯一入口是上面的「标签…」条目；标签仍可经
   右键「编辑」composer 的标签字段编辑，故连同 `tagEditor` state 一并移除，
   标签筛选空态文案同步改为「可在主机右键「编辑」的标签字段里添加」。
3. **工具栏「新建主机」caret 下拉文案对齐**：本地终端（PTY）→「本地终端 (CMD)」、
   导入主机→「导入」（图标 transfer→upload）、导出主机→「导出」（图标
   server→download）；「新建分组」不变。导入/导出后端未支持仍置灰
   （title「尚未实现」）。「终端」「串口」按钮已存在且文案/图标与 Netcatty
   一致（common.terminal / serial.button，terminal-square / usb），无需改。
4. **`src/ui/icons.tsx`**：新增 `download` 图标（lucide download 路径）。
5. **已知主机卡片右键菜单（转换为主机 / 删除）保留不动**（khCtx）。

### 验证

- `npx tsc --noEmit` 通过（块 E 完成时点）。
- 单击连接（handleCardClick ↔ netcatty resolveHostActivateAction）、右键弹菜单
  （openContextMenu ↔ ContextMenuTrigger）、hover Edit 按钮（.vault-host-edit ↔
  renderHostEditButton）此前已与 Netcatty 一致，本轮无需改代码。

### 踩坑

118. **任务描述与 Netcatty 实际行为矛盾（右键连接 vs 右键菜单）**：任务写
    「单击/右键都连接……删除 Netcatty 没有的右键菜单」，但 Netcatty 主机卡片
    实际包 `<ContextMenu><ContextMenuTrigger>`，右键弹出完整 9 项菜单
    （VaultHostListSection.tsx 1247-1360），并非右键连接。按 1:1 原则保留
    右键菜单并对齐 9 项；单击连接行为不变。
119. **菜单项文案以 zh-CN 键为准**：「复制」（action.duplicate，非「复制副本」）、
    「复制主机地址」（terminal.statusbar.copyHostname.label，非「复制主机名」）、
    「打开 SFTP」（vault.hosts.openSftp）、「打开浏览器」（terminal.browser.open）、
    「本地终端 (CMD)」（vault.hosts.newLocalShell，半角括号前带空格）。
    「打开 SFTP」图标 Netcatty 用 Files，termX 图标集无 files，沿用 columns。
120. **tagEditor 弹层随「标签…」条目删除**：删条目后该弹层成为不可达死代码，
    一并删除 state 与 JSX；标签编辑能力未丢失（composer 标签字段），
    标签筛选面板空态提示同步改写，避免指向已删除的菜单项。

### 门禁修复（跑全门禁时发现，均为块 A 遗留）

1. **`src/db/schema.rs` v33 迁移补 `table_exists` 守卫**：块 A 的
   `if version < 33` 块直接 `ALTER TABLE profiles`，而迁移单测按最小 fixture
   stamp 旧版本（无 profiles 表），导致 8 个 migration 测试全挂在
   「no such table: profiles」。改为 `if version < 33 && table_exists(conn,
   "profiles")?`，与 v23/v24/v31/v32 同款写法；真实库自 v1 起就有 profiles，
   生产行为不变。
2. **`migration_32_*` 三个测试的版本断言**：原写死 `assert_eq!(version, 32)`，
   块 A 把 SCHEMA_VERSION 提到 33 后 migrate 会 stamp 33；改断言
   `SCHEMA_VERSION`，后续再提版本不再破坏。
3. **`src/terminal/pty.rs` 本地 PTY 冒烟测试加 `#[cfg(all(test, unix))]`**：
   `local_pty_write_roundtrip` / `local_pty_exit_code_reported` 依赖
   `/bin/cat`、`/bin/sh`，Windows 无等价二进制，此前在 Windows 上必挂；
   整个 tests mod 仅 unix 编译（模块内仅这 2 个测试）。
4. **`src/terminal/TerminalAuthDialog.test.tsx` 随块 D 文案更新**：4 个用例
   仍按旧文案定位（placeholder「密码」→「输入密码」、空态「没有可用的 SSH 密钥
   凭据」→「暂无密钥，请先在钥匙串中添加。」、「私钥口令」→「可选：所选私钥的
   密码短语」、按钮「选择密钥」→「选择 SSH密钥」）；顺带补「继续并保存」
   caret 菜单走 onSubmit 的断言。

门禁结果：`npm run test:run` 71 ✓；`npm run build` ✓；`cargo check` ✓
（6 个遗留 warning）；`cargo check --features server` ✓；`cargo test --lib`
780 passed / 0 failed。

### 踩坑（门禁）

121. **新增迁移块必须带 table_exists 守卫**：迁移单测的最小 fixture 只建
    该步骤相关的表；任何新 `ALTER TABLE <t>` 迁移块都要先
    `table_exists(conn, "<t>")?`，否则所有 stamp 旧版本的迁移测试全挂。
122. **迁移测试不要写死版本号**：断言迁移后的 user_user_version 应写
    `SCHEMA_VERSION` 而非字面量，SCHEMA_VERSION 提升时不必回头改测试。

## 2026-11-02 · SSH 1:1 验收（实机比对）发现、环境踩坑与范围变更

### 验收方式

对照**运行中的 Netcatty 1.1.90**（pid 7900，只读：不改设置、不增删主机、测试标签用完即关）
与 termX debug 版（`src-tauri/target/debug/rssh.exe`，WMI 启动，pid 4724）逐区比对：
A 工具栏 / B 主机首页 / C 卡片右键 / D composer 新建+编辑 / E 删除 / F 连接建立 /
G known hosts / H 钥匙串。CU 观察 termX 时 WebView 内容会在 foreign child
（msedgewebview2）进程中重复出现，element_id 必须取 `foreign_child_windows` 标记之前的主树。

### 差异清单（本轮修复输入）

- D 区 composer（基线=运行版，源码新于运行版的部分不算差异）：
  D1 多「初始化命令」（新+编）；D2 新建缺密码+眼睛；D3 缺「优先交互式认证」hint；
  D4 TOTP 缺 hint+「设置…」（编辑缺整节）；D5 编辑缺「保存密码」toggle；
  D6 编辑缺「密钥/证书/本地密钥」；D7 编辑密码空+「留空保持不变」vs 运行版 ••••• 掩码；
  D8 编辑多身份 chip 行；D9 新建字段顺序（密钥按钮应在密码之后）；D10 端口 edit vs spinner；
  D11 多「分组/标签」可见 label；D12 composer 的「SFTP 设置」「颜色与图标」两分区
  运行版没有（上一轮按新于运行版的源码添加，应撤下）。
- B 区：B1 多「主机」全量分区+「N 条 / M 个在线」计数；B2 本地终端卡应显示实际
  shell 名（运行版为「Git Bash」）；B3 hover 编辑按钮运行版为英文 "Edit {名称}"。
- F 区：F6 连接失败 UI 与顶栏标签直接显示原始 `__rssh_err__|{...}` 信封
  （违反 R5，高优先级）；F7 快速连接是独立模态，运行版为 composer 预填「主机详情」；
  F8 会话视图隐藏左导航（运行版保留）；连接中内联条按钮/文案差异
  （运行版：「{host}:{port}」+显示日志+关闭+「将在 120s 后超时」）；
  工具栏缺「复制主机地址」「启用广播模式」，断开 tooltip 应为「断开连接」；
  F2 关 pane 后顶栏残留「129 已连接」陈旧状态。
- H 区：H1 钥匙串缺「新建身份」按钮（运行版有；上一轮按源码判为条件渲染未渲染，
  以运行版为准需补）。
- 一致项：C 右键=直接连接（运行版无菜单）、G known hosts 页、自动认证、
  关 pane 断开会话、A 区占位口径、钥匙串空态文案。
- 未比对（Netcatty 只读限制）：E 多选批量删除确认框、新建主机 caret 菜单；
  termX 保持现状并在验收报告说明。

### 环境踩坑

123. **Shell 工具启动的 termX 实例会被回收**：启动命令结束数秒后进程树回收把
    实例杀掉（此前「启动后崩溃」全部由此 + 双实例引起）。实机验证必须用
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 脱离进程树启动。
124. **双实例 / 快速重启 = setup panic（exit 101）**：第二实例撞 SQLite 锁
    （`db_error disk I/O error`）或 WebView2 `0x800700AA 资源在使用中`，
    在 tauri app.rs:1425 panic。实机必须确保单实例；第二实例应优雅失败（未做，待办）。
125. **CU 点击 termX 元素必须取主树 id**：WebView 内容在 foreign child 中重复
    出现，用子树 element_id 会报 "Action path changed"；解析 get_app_state
    文本时按 "foreign_child_windows" 切分取前段。

### 范围变更

- 用户范围修正（2026-11-02）：**SSH agent 转发纳入移植范围**，按 Netcatty 的
  agent 列表 / 转发开关 / 认证走 agent 1:1 实现，与「代理」模块一起排期
  （todo.md P1 #39）；mosh / eternalTerminal / X11 转发仍不移植。
  安全口径：agent socket（SSH_AUTH_SOCK）路径与密钥信息不进日志、提交与文档。

## 2026-11-02 · 验收差异修复（F6 / D1–D12 / B1–B3 / F2 / F7 / F8 / 工具栏 / H1）

### 修复内容（对照上一条目的差异清单，口径=运行中 Netcatty 1.1.90）

- **F6（R5，最高优先级）**：重写 `src/domain/sshErrors.ts` —— 新增
  `ERROR_MESSAGES` 全量中文映射（覆盖 error.rs 全部 code：连接 / 超时 / 认证 /
  密钥 / agent / bastion / DB / secret 等）与 `userVisibleError(raw)`；
  所有用户可见错误展示点改为经它解析，不再泄漏 `__rssh_err__|{...}` 信封：
  TerminalPane 进度日志与失败态、VaultView composer 错误 / 测试连接 / TOTP /
  known hosts / 钥匙串操作、ConnectionManager / Forward / Serial / Telnet /
  Sftp 五个面板。补 4 个 userVisibleError 单测。
- **D1–D12 composer**（src/VaultView.tsx）：D1 删「初始化命令」字段（DB 列保留）；
  D2 新建态加密码框+眼睛；D3「优先交互式认证」开关下加可见 hint；D4 TOTP 区
  核对已对齐（hint+「设置…」均在）；D5 编辑态加「保存密码」toggle（关闭=删除
  已存口令）；D6 编辑态保留「密钥/证书/本地密钥」链接按钮+菜单；D7 编辑态已有
  保存密码时显示掩码 ••••• + 眼睛，明文不进 input（focus 全选、输入即替换）；
  D8 编辑态删身份 chip 行（仅新建态显示）；D9 新建字段顺序对齐（端口→登录方式
  +hint→MFA+hint→用户名→密码+眼睛→保存密码→凭据链接）；D10 端口改
  `type=number` spinner（1–65535）；D11 去掉「分组/标签」可见 label；
  D12 撤下 composer「SFTP 设置」「颜色与图标」两分区（DB 字段保留，
  ICON_COLORS 常量删除）。
- **B1**：根部「主机」分区排除已置顶 / 最近连接条目（对齐
  `useVaultHostCollections` 的 visibleDisplayedHosts）；剩余为空且其它分区有
  内容时整节隐藏（shouldHideEmptyRootHostsSection）；删「N 条」「N 个在线」
  「共 N 个」三处计数，`activeSessionCount` prop 从 VaultView/App 一并移除。
- **B2**：本地终端卡显示真实默认 shell 名（「Git Bash / Git Bash」）。新增后端
  命令 `default_shell`（R4 双注册：lib.rs + server.rs dispatcher），前端
  `api.defaultShell()` + 纯函数 `shellDisplayName`（src/domain/shellName.ts，
  含单测）。
- **B3**：卡片 hover 编辑按钮 tooltip 改 `Edit {主机名}`。
- **F2**：Workspace 增加 paneStatus map（paneId→文案），顶栏状态只反映活动
  窗格；`registerPane(null)` 时删条目 —— 关 pane / 切标签后陈旧状态自动回落「就绪」。
- **F7**：废除独立「快速连接」模态（wizard state / saveWizard / 模态 JSX 全删），
  搜索框识别为快速连接时改为打开 composer 并预填 host/port/username
  （名称预填 `user@host`）。
- **F8**：`connect()` / `openLocal()` 打开会话时 `setSideOpen(true)`，左侧主机
  导航栏保持可见。
- **工具栏**：加「复制主机地址」（复制 hostInfo.hostname，tooltip 2s「已复制」
  反馈；无主机名时禁用）；「启用广播模式」按任务口径置灰占位
  （title「广播模式尚未移植」）；断开按钮 tooltip 改「断开连接」。
- **连接中内联条**：核对已对齐（「{host}:{port}」+「显示日志」+「关闭」+
  「将在 Ns 后超时」），TerminalConnectionProgress 此前已按 Netcatty 移植，
  本轮无需改动。
- **H1**：钥匙串工具栏「导入证书」后加「新建身份」按钮；身份存储未移植，
  按钮 `disabled` + title「身份存储尚未移植」，不做假功能。
- 明确不改（与运行版一致 / 任务口径）：卡片右键=直接连接、known hosts 页、
  A 区禁用占位、多选批量删除。

### 踩坑

126. **B2 为什么加 `default_shell` 命令而不是复用 `list_shells`**：本地卡要显示
    的是「实际会启动的那个 shell」，与 `pty_spawn` 的解析必须同源 ——
    `local_shell` 设置优先、空则 `pty::default_shell()`（Windows 按
    cmd > pwsh > powershell 偏好挑）。list_shells 只给候选清单，前端自己挑会和
    后端逻辑漂移。故把 `terminal::pty::default_shell` 改 pub，commands/pty.rs
    加薄命令镜像 pty_spawn 第 19 行的取值逻辑。
127. **广播模式只做置灰占位**：广播（多会话同写）依赖未移植的会话组管理，
    任务允许「实现不了则置灰占位 + title 说明」；工具栏 radio 图标按钮
    `disabled`，title「广播模式尚未移植」。
128. **H1「新建身份」同为禁用占位**：身份（identity）存储层未移植，按钮保留
    但禁用，title「身份存储尚未移植」；待存储层移植后再启用，避免造假功能。
129. **删 wizard 后孤儿 prop 会咬人**：`onOpenManager`（VaultView）与
    `activeSessionCount` 的唯一使用点在 wizard / 在线计数，删除 JSX 后
    `noUnusedParameters` 直接 build 失败 —— 删大段 UI 时要顺着 Props 接口、
    解构与 App 调用处三处一起清。
130. **termX 的 `CredentialType` 没有 certificate**：composer 派生
    `composerPasswordVisible` 里 `!== "certificate"` 的比较被 TS2367 拒绝
    （无重叠）；证书凭据未移植，比较只保留 `!== "key"`，注释注明。

### 门禁结果（2026-11-02）

- `npm run test:run`：10 文件 78 用例全过（含新增 shellName 4 例、
  sshErrors userVisibleError 4 例）。
- `npm run build`：tsc + vite 通过。
- `cargo check` / `cargo check --features server`：通过（仅既有 dead_code 警告）。
- `cargo test --lib`：780 passed / 0 failed。
- `build-debug.bat`：产物 `src-tauri/target/debug/rssh.exe`（+ MSI / NSIS 包）
  构建成功；未启动程序，复检由主 agent 用 Computer Use 执行。

### 遗留风险

- 广播模式、「新建身份」、证书凭据为占位 / 未移植，后续移植时需回填真功能。
- styles.css 中 `.vault-wizard*` 样式随 wizard 删除变为孤儿（无引用，不影响构建）。
- 快速连接预填 composer 后，用户若直接关闭 composer 不会建立连接（与运行版
  行为一致：快速连接入口=预填的主机详情）。

## 2026-11-02 · 修复后实机复检与 B2 定论

### 复检方式与覆盖

- 用 build-debug.bat 产物（`src-tauri/target/debug/rssh.exe`）经 WMI
  `Win32_Process Create` 脱离进程树启动，CU 对运行中 termX 与 Netcatty
  逐项比对。复检中 CU 前台多次被并行桌面会话抢走（见踩坑 132），
  后半程改为「已取得运行时证据 + 代码级核对」收尾。
- **运行时证据（CU dump 实测）**：
  - B1 ✓ 首页仅「全部主机 / 最近连接 / 分组」三区，无「主机」全量分区、
    无「N 条 / N 个在线 / 共 N 个」计数；
  - B3 ✓ 卡片 hover 编辑按钮 tooltip = `Edit 129`（英文，随运行版）；
  - composer 新建态 ✓：无「初始化命令」、密码框+眼睛、MFA 可见 hint、
    字段顺序（端口→登录方式→MFA→用户名→密码→凭据链接）、端口
    spinner 默认 22、无「分组 / 标签」可见 label、无 SFTP 设置 / 颜色图标分区
    （D1/D2/D3/D9/D10/D11/D12 逐项对上了运行版记录）；
  - B2 部分：本地卡已显示真实 shell 名，但本机解析为「CMD / CMD」，
    Netcatty 运行版显示「Git Bash / Git Bash」→ 见下方定论。
- **代码级核对（运行时 dump 受限项）**：D4 TOTP 区在 VaultView 为无条件渲染
  （hint+「设置…」/「编辑/移除验证器」均在），dump 缺失系 UIA 滚动虚拟化
  （踩坑 133），判已修；D5–D8 编辑态、F7 快速连接预填、H1 新建身份占位、
  工具栏复制主机地址 / 广播占位以修复 diff + 代码核对佐证。

### B2 定论（残留差异，判为功能缺口而非 SSH 范围内缺陷）

- Netcatty 运行版「Git Bash / Git Bash」卡是**用户已保存的本地 shell 主机**
  （`protocol: 'local'`，`label` 与 `localShellName` 均为 'Git Bash'，
  经「新建主机 → 本地终端」弹窗选 Git Bash 创建），副标题逻辑
  `getVaultHostRowSubtitle` = `localShellName || t('localShell.subtitle')`
  （Netcatty `domain/localShellHost.ts`、`components/vault/VaultHostListSection.tsx`）。
- termX 尚无「本地 shell 主机」数据模型与创建流程（shell 选择弹窗、保存主机、
  按保存 shell 启动），内置 `__local` 卡只能显示系统默认 shell 名
  （本机 = CMD，`pty::default_shell()` 按 cmd > pwsh > powershell 偏好）。
- 裁决：CMD vs Git Bash = **数据 + 功能缺口**（对方是用户数据里的已存主机，
  且「本地终端」整功能未移植），不属 SSH 连接建立与管理范围；
  **defer 到后续「本地终端」功能移植**（含 shell 发现：Git Bash / Cygwin / WSL、
  shell 选择弹窗、本地主机 CRUD），届时一并对齐。

### 踩坑

131. **debug 构建的控制台窗口在应用树内且是进程主窗口**：`windows_subsystem=
    "windows"` 仅 release 生效，debug 版带 conhost 控制台，且它是进程
    MainWindowHandle。CU `get_app_state`/`click` 激活的是控制台而非 GUI 窗口；
    控制台的 Text Area id 一旦误点会进入「选择」模式霸占前台（ESC 只能临时退出）。
    解析 UIA dump 提 id 时必须按 `window "termX"` 段切分，排除控制台窗口段。
132. **CU 前台会被并行桌面会话偷走**：termX 窗口不在前台时 Web 元素显示
    "(N elements hidden)"；`SetForegroundWindow` 能拉回，但前台在工具调用间隙
    再次丢失（疑似另一审计会话同时在操作桌面）。结论：多会话共用桌面时 CU
    逐项复检不可靠，应「一次前台多取证」或退回代码级验证。
133. **UIA 滚动虚拟化会把滚出视口的区块从树里拿掉**：composer TOTP 区代码
    存在但 dump 不可见，最初误判「缺失」；读代码确认无条件渲染后纠正。
    凡「dump 里没有」先排除虚拟化再下差异结论。

### 门禁结果（2026-11-02，复检后）

- 复检未改代码，沿用修复轮门禁：`npm run test:run` 78 例、`npm run build`、
  `cargo check`（含 `--features server`）、`cargo test --lib` 780 例全过；
  build-debug.bat 产物已启动并存活，CU 取证后正常退出。

---

## 2026-11-02 — 本地终端 / 本地 shell 主机（后端数据层 + shell 发现）

目标：Vault 支持「本地终端主机」（protocol='local'），与 Netcatty
localShellHost / shellDiscovery 语义 1:1 对齐。本节为后端部分。

### 修改点

1. **schema v34**（`db/schema.rs`）：profiles 增 6 列 —— `protocol`
   (TEXT NOT NULL DEFAULT 'ssh')、`local_shell`、`local_shell_args`
   (JSON 文本)、`local_shell_name`、`local_shell_icon`、`local_start_dir`
   (均 TEXT DEFAULT NULL)。沿用 v33 的 `for (col,decl)` + `column_exists`
   幂等写法；`SCHEMA_VERSION` 33 → 34。
2. **models.rs**：Profile 增同名 6 字段（全部 `serde(default)`，protocol
   默认 "ssh"）；新增 `DiscoveredShell { id, name, command, args, icon,
   is_default }`。
3. **db/profile.rs**：`PROFILE_COLUMNS` 16 → 22 列（single source of
   truth）；`row_to_profile` 按索引 16-21 读；`local_shell_args` JSON
   解析容错（坏 JSON → None + warn）；`validate_for_write` 对
   `protocol == "local"` 豁免空 credential_id（SSH 主机不变量不变，
   既有 `insert_rejects_empty_credential_id` 仍过）；insert upsert /
   update 全列写。
4. **shell 发现**（新文件 `terminal/shell_discovery.rs`，#[cfg(desktop)]）：
   对齐 Netcatty shellDiscovery.cjs —— Windows 顺序 CMD → Windows
   PowerShell → pwsh → WSL 发行版（`wsl.exe -l -q`，UTF-16LE 探测解码，
   注册表 Lxss 兜底）→ Git Bash → Cygwin；默认标记 pwsh > powershell >
   cmd；注册表走 `reg.exe`（CREATE_NO_WINDOW、5s 超时杀进程）；
   WindowsApps 别名兜底。Unix 读 /etc/shells + realpath 去重 +
   basename 消歧 + `$SHELL` 补头/标默认。OnceLock 进程内缓存。
5. **PTY**：`terminal/pty.rs` 新增 `spawn_local_shell(shell, args,
   cwd)` —— args=Some 原样透传不补 `-l`，None 维持旧行为；cwd 经
   CommandBuilder::cwd；不覆写 PATH（本地 shell 需完整用户环境）。
   旧 `spawn` 无调用方，删除。
6. **命令**：`pty_spawn` 增可选 `shell` / `args` / `start_dir`
   （`~`/`~/...` 经 `dirs::home_dir` 展开）；新命令 `discover_shells`。
   解析 helper `resolve_local_shell`（请求 → 设置 → 默认）与
   `expand_start_dir` 为 pub(crate)，Tauri 命令与 ws server 共用。
7. **双注册**（R4）：lib.rs generate_handler 加 `discover_shells`
   （#[cfg(desktop)]）；server.rs dispatcher 加 `"discover_shells"`，
   `"pty_spawn"` 同步支持 shell/args/startDir。

### 新增单测

- db/profile.rs：`local_profile_roundtrip`、
  `local_profile_allows_empty_credential_id`、
  `legacy_profile_defaults_protocol_ssh`（mk_local helper）。
- terminal/shell_discovery.rs：`parse_reg_value_line_matches_regedit_output`、
  `wsl_distro_id_slugs_non_alphanumerics`、
  `map_wsl_distro_icon_falls_back_to_linux`、`cmd_always_discovered`
  （Windows）；`unix_name_icon_login_mappings`、
  `path_slug_strips_leading_slash_and_separators`（Unix）；
  `discover_returns_consistent_cache`（全平台）。
- commands/pty.rs：`expand_start_dir_handles_tilde_and_plain_paths`。

### 踩坑

134. **Profile 结构体字面量散布广**：加字段后 9 处测试 fixture +
     CLI `add.rs` 构造点报 E0063，全量 grep `totp_regex: None` 定位补齐。
135. **server.rs 的 `optional_string_arg` 错误类型是 `Value` 不是
     `AppError`**：直接 `?` 即可，不能套 `map_err(err_value)`。

### 门禁（后端段）

- `cargo check` ✅；`cargo check --features server` ✅；
  `cargo test --lib` 789 例全过 ✅。

## 2026-11-02 — 本地终端 / 本地 shell 主机（前端 UI + 会话接线）

承接上一节后端数据层，本节为前端部分（A–C、F 的 UI 侧）。

### 修改点

1. **`src/LocalShellPanel.tsx`（新文件）**：本地终端新建 / 编辑共用面板，
   右侧 overlay（复用 `vault-composer` 结构 + `.local-shell-panel`
   380px），Esc / X 关闭。字段序：名称 → Shell（首项「系统默认 Shell」
   value=''，其余为 discover_shells 列表）→ 分组 → 启动目录；页脚
   取消 +（仅新建）保存并打开 + 保存。保存走 `createLocalShellHost`
   语义（host='localhost'、名称回退链、空 shell 存 undefined），编辑时
   `{...initial, ...host}` 合并保留 SFTP / TOTP 等字段；shellMeta 逻辑
   对齐 Netcatty（选择未改动时优先主机快照）。
2. **`src/VaultView.tsx`**：
   - 新建主机 split button 下拉「本地终端 (CMD)」→ 打开本地面板
     （不再走 onLocal）；「终端」按钮保持 onLocal 直开会话。
   - 本地卡显示名改为「设置 local_shell → 发现列表名 / 命令名」解析，
     空设置回退 default_shell 显示名；挂载时拉 discover_shells +
     get_setting("local_shell")。
   - local profile 与 SSH 主机同列：卡 / 行标题 = name，副标题经
     `getVaultHostRowSubtitle`（local → local_shell_name || 「本地终端」）；
     hover Edit 与右键「编辑」路由到本地面板（非 SSH composer）；
     右键连接 / 复制 / 删除复用原链路；复制本地主机名用带括号版
     「(副本)」（SSH 保持「副本」），并随副本继承原标签。
   - 保存回调：新建时补手动顺序 + tags 表写 `["local"]`
     （localStorage TAGS_KEY），随后 onDataChanged + toast；
     「保存并打开」保存后立即 onConnect。
3. **`src/App.tsx`**：`connect()` 对 `protocol === "local"` 走 PTY：
   `resolveHostDefaultLocalShell`（发现列表 + 设置 local_shell）解析后
   开 pty 标签（标题 = 主机名）；`openLocal()`（终端按钮 / 顶栏 +）按
   设置 local_shell → `resolveShellSetting` 解析，空则后端默认。
   挂载时预取 discover_shells。
4. **`src/workspaceModel.ts`**：`Connector` pty 变体增可选
   `shell / args / startDir / name`（旧 localStorage 快照向后兼容）；
   `defaultTitle` pty 优先用 name。
5. **`src/TerminalPane.tsx`**：pty 分支 `ptySpawn` 透传
   `shell / args / startDir`。
6. **`src/styles.css`**：`.local-shell-panel { width: 380px }`。

### 新增 / 更新单测

- `src/backend/client.test.ts`：`ptySpawn 显式传 sessionId: null` 断言
  补 shell/args/startDir: null；新增 `ptySpawn 本地主机透传
  shell / args / startDir`。
- （域函数单测随后端段已就位：`src/domain/localShellHost.test.ts`
  17 例，覆盖 createLocalShellHost / 副标题 / resolveShellSetting /
  resolveHostDefaultLocalShell。）

### 踩坑

136. **编辑本地主机必须合并旧档案**：`createLocalShellHost` 只产出本地
     相关字段，直接 updateProfile 会让 JSON 丢掉 SFTP / TOTP 等可选字段，
     Rust `serde(default)` 把它们重置为默认值 —— 用 `{...initial, ...host}`
     合并（显式 undefined 正好用于清空 shell 选择）。
137. **`resolveHostDefaultLocalShell` 必须显式传 `resolveShellSetting`**：
     ctx 里不传时 resolved 恒为 undefined，local_shell 会原样保留发现的
     shell id（如 "wsl-ubuntu"）而不是命令，spawn 直接失败。

### 门禁（全量，2026-11-02）

- `npm run test:run`：11 文件 96 例全过 ✅。
- `npm run build`：tsc --noEmit + vite 通过 ✅。
- `cargo check` ✅；`cargo check --features server` ✅（仅既有 warning）；
  `cargo test --lib` 789 例全过 ✅。

## 2026-11-02 — 本地终端实机比对收尾 + 代码 review 修复（功能①闭环）

### 修改点（对照运行中 Netcatty 1.1.90 的剩余差异 + review 必须修复项）

1. **`src/ui/icons.tsx`**：删除上轮误插的未加引号重复键
   `chevron-down: <path …/>`（导致 vitest 转换报语法错误）；`IconName`
   联合补 `"save"`（此前只加了 paths 条目未加类型）。
2. **`src/styles.css` 4 处**：`.lsh-combo-opt.is-active` 去蓝字（对齐
   Netcatty 选中项深色文字）；`.lsh-combo-check` 勾选图标蓝色；
   `.nc-avatar.local` / `.nc-tree-avatar.local` 改实底蓝 + 白色 glyph
   （对齐 Netcatty 本地主机 / 本地终端入口头像）。
3. **`src/VaultView.tsx`**：hostCard 头像按 `protocol === "local"` 分支
   渲染实底蓝白 terminal 头像（grid / list 共用）；快速切换器行头像补
   同一分支（review 必须修复项 2）。
4. **`src/HostSidebar.tsx`**：终端态树行头像对 local 主机补同一分支。
5. **`src/ConnectionManager.tsx`**（review 必须修复项 1）：CM 只列 SSH
   连接（`sshProfiles = profiles.filter(p => p.protocol !== "local")`），
   避免 local 档案进 SSH 表单被「凭据必填」卡死；tab 计数 / 跳板机
   选项 / 空态 / 行列表同步改用 sshProfiles。
6. **`src/workspaceModel.test.ts`**：补 `defaultTitle` pty 带 name 分支
   单测（review 建议项，采纳）。

### 实机复检结论（CU 对 termX debug 版逐项截图核对）

- 新建本地终端面板 Shell 下拉：选中项浅蓝底 + 深色文字 + 蓝色勾，
  选项结构（系统默认 Shell / CMD / PowerShell / Git Bash 带路径
  sublabel）与 Netcatty 基线一致。
- 已存本地主机卡：实底蓝白 terminal 头像 + 副标题 shell 名 + 「local」
  标签 chip（chip 源自 Netcatty `createLocalShellHost` 默认 tags，两侧
  一致）；伪 `__local` 最近卡同头像。
- 终端态树侧栏：本地终端入口行与已存 local 主机行均为实底蓝白头像。
- 快速切换器：local 行实底蓝白头像、SSH 行保持 hue 头像。
- 连接管理器：连接 (1) 仅列 129，local 主机不再出现。

### 踩坑

138. **沙箱 Shell job 结束会杀 detached 子进程**：`Start-Process` /
     脱离进程树启动的 rssh.exe 在命令结束时被回收（与坑 123 的 WMI 法
     冲突时的新结论）。可靠保活法 = 前台直接跑 exe、靠超时自动转后台
     shell 存续；重建前用 StopCommand 停该 shell 释放 exe 文件锁。
139. **CU 工具名与 diff 基线**：`set_focus` / `screenshot` / `wait` 等
     工具不存在（报错文案误导为 "Extension … not found"，实为工具名
     不存在；存在的工具报 validation error，可据此探测）；窗口聚焦走
     `perform_action(action="set_focus")`；`get_app_state` 默认 diff
     模式，需整树时必须 `disableDiff: true`；动作参数用 pid 而非
     app_name 更稳。
140. **icons.tsx 加图标两处同步**：带连字符的键必须加引号；paths 条目
     与 `IconName` 联合必须同时补，否则 tsc 在使用点报错。

### review 结论（子 agent，2026-11-02）

必须修复 2 项（CM local 死路、切换器头像）已修并实机复检；建议项采纳
1 项（defaultTitle 单测）。未采纳 2 项及理由：`client.ts` 的
`setSetting` 导出暂留（设置中心为下一功能，届时即用）；App 与
VaultView 各自拉 `discoverShells` 暂不合并（一为启动解析、一为面板
展示，合并需新增 prop 钻穿，收益小）。

### 门禁（复跑）

- `npm run test:run`：11 文件 97 例全过 ✅（新增 1 例）。
- `npm run build` ✅；debug 重建 40s ✅（仅既有 6 条 warning）。

### 提交状态

- 本地提交完成：`28c9dc6 feat(local-terminal): 移植本地终端，对应 Netcatty
  LocalShellHostDetailsPanel / useDiscoveredShells / createLocalShellHost`
  （32 files, +2459/-59）。

## 2026-11-03 · 功能顺序调整（设置中心提前）

### 顺序调整

- 按用户最新指令（2026-11-03）：下一个功能由 SFTP 改为**设置中心**
  （todo.md P0 #12），按既定流程（对照→实现→门禁→实机比对→子 agent
  review→提交）推进。
- SFTP 研究成果不丢，全部落盘于临时目录，设置中心闭环后从 sftp-3
  后端实现继续：`C:\Users\tianzry\AppData\Local\Temp\termx-sftp-gap-plan.md`
  （第八节=后端实现蓝图 B1–B8）、`termx-sftp-ui-details.md`、
  `termx-sftp-electron-bridges.md`、`termx-sftp-rssh-ref.md`、
  `termx-sftp-observations.md`。

### 设置中心研究（2026-11-03，开工前）

- 研究简报落盘：`C:\Users\tianzry\AppData\Local\Temp\termx-settings-research.md`
  （Netcatty 源码地图：SettingsPage 容器 / 各 tab / stores / keyBindings / i18n；
  termX 现状：settings 后端已就绪、前端零 UI；范围决策与实施计划）。
- CU 取证：Netcatty（pid 7900，zh-CN）顶栏与 SFTP 双栏截图；web 内容 UIA 树需先
  set_focus 才可见。
- 踩坑 141：**顶栏图标坐标点击不可靠**——按截图坐标点齿轮 (1261,22) 未打开设置
  窗口，前台反被并行桌面会话的 msedge 抢走（坑 132 复现）且疑似误触外部链接；
  设置对话框的运行时证据改到实机复检阶段补，本轮对照以源码为准。

## 2026-11-03 · 设置中心缺口清单（阶段 B 侦察）

### Netcatty 设置页结构（源码核对：components/SettingsPage.tsx L434-530）

- 独立窗口：标题「设置」+ 右上 X 关闭（仅 Windows，mac 留拖拽区）；左侧 w-56
  导航 = 搜索控件（SettingsSearchControl：目录检索 → 定位 tab/section/anchor）
  + 纵向 TabsList。
- Tab 顺序（9 个）：应用(application) → 插件(plugins，条件显示) → 外观
  (appearance) → 终端(terminal) → 快捷键(shortcuts) → 文件关联
  (file-associations) → AI(ai) → 同步与云(sync) → 系统(system)。
- zh-CN 文案：application/i18n/locales/zh-CN/core.ts L124-134（settings.title
  =「设置」等）。

### 各 tab 内容要点（侦察结论）

- **应用**：检查更新 / 报告问题 / 社区 / GitHub / 更新日志（外链 + 更新流程，
  props checkNow/installUpdate/startDownload）。
- **外观**：语言、UI 字体、窗口透明度、主题（浅/深/跟随系统 + 浅/深主题 id）、
  强调色（模式 + 自定义色）、图标变体、Vault 行为开关（最近主机 / 主机点击行为 /
  根节点只显示未分组 / 显示 SFTP tab / 主机树侧栏等）、自定义 CSS。
- **终端**：字体区（字体 / CJK 字体 / 字号加减 / 粗细 / 平滑 / 连字 / 行距 /
  仿真类型）、光标区（样式 / 宽度 / 闪烁 / 高亮当前行）、键盘与行为（退出自动
  关闭 / 断开提示 / 右键 / 选中复制 / 复制规范化 / 中键 / 单词分隔符 / 粘贴 /
  Shift+Enter / 清空缓冲）、侧边栏（打开终端时展开 / 默认面板）、连接（校验
  SSH 主机密钥开关）。
- **快捷键**：方案（默认 'mac'）、按键捕获（window keydown/keyup/click）、
  分类 tab/terminal/navigation、单项禁用 / 重置、重置全部、全局开关（禁用终端
  字体缩放 / 仅 shell 数字 tab / tab 数字 badge）。source of truth：
  domain/models/keyBindings.ts DEFAULT_KEY_BINDINGS。
- **文件关联**：SFTP 文件协议关联；若需写 Windows 注册表 → 实现时定夺，
  可能降级占位并说明。
- **系统**：自启动、网络代理（system/direct/custom + URL + bypass）、凭据存储
  状态（keychain 可用性检测 + 刷新）、崩溃日志列表、会话日志（格式
  txt/raw/html、清理确认）、临时目录错误提示。
- **占位 tab**（未移植能力，禁用 + 说明）：同步与云（#15）、插件（#29 暂缓）、
  AI（#27 暂缓）、AppLock 分区（#23）。

### termX 现状缺口

1. 无设置入口与设置 UI（TopTabs 无齿轮）；
2. 无 i18n 框架（文案硬编码）——本轮只建设置中心自身轻量 zh-CN/en 字典，
   全应用文案 retrofit 记遗留差距；
3. 无主题 / 强调色切换（styles.css 仅浅色 snow）；
4. xterm 字体 / 字号 / 光标 / 行为全部硬编码，无终端设置页；
5. 无快捷键自定义（无 keyBindings 模型与捕获）；
6. 无窗口透明度 / 自启动 / 网络代理设置；
7. 后端已有 get_setting / set_setting（db settings 表，敏感 key 走
   secret_store）；缺：系统字体枚举（list_fonts）、自启动开关、窗口透明度
   应用等命令（实现时按 R4 双注册 lib.rs + server.rs）。

### 形态差异决策

- Netcatty 设置为独立窗口（bridge.openSettingsWindow）；termX 单窗口 →
  用全屏 overlay/模态承载，内容与交互顺序 1:1，此形态差异记录在案。
- 运行时界面比对（CU 打开设置对话框逐项截图）留到实机比对阶段
  （踩坑 141：坐标点击顶栏不可靠 + 前台被并行会话抢占）。

## 2026-11-03 · 设置中心实现（5 tab 1:1 + 3 占位 + 自启动命令，门禁全绿）

### 前端实现（新建 7 文件 + 编辑 9 处）

- 新建 `src/settings/` 模块：
  - `settingsModel.ts`：AppSettings 类型 + 默认值（对照 Netcatty：theme
    "system"、windowOpacity 1、terminalFontSize 14、scrollback 10000、
    verifyHostKeys true 等）+ `normalizeSettings` 等纯函数（逐字段合并、
    嵌套 terminal/networkProxy/sessionLogs、过滤非法绑定与枚举值）；
    整体 JSON 持久化于 db settings 键 `settings.center.v1`（经
    getSetting/setSetting，沿用既有约定）。
  - `keyBindings.ts`：DEFAULT_KEY_BINDINGS 36 条逐条照抄 Netcatty（tabs/
    terminal/navigation/app/sftp 五分类、mac/pc 双方案）+ `effectiveBinding`
    （自定义覆盖优先）+ `captureBinding`（keydown 捕获，mac 用 ⌘⌃⌥ 符号、
    pc 用 Ctrl/Alt/Shift/Win）+ `normalizeKeyName`。
  - `i18n.ts`：设置中心自身轻量字典，zh-CN 约 180 键（对照 Netcatty zh-CN
    core.ts / terminal.ts 文案），en 缺键回落 zh-CN 再回落 key。
  - `settingsStore.ts`：模块级 store + `useSettings`（useSyncExternalStore）；
    副作用应用：data-theme + dark/light class、`--termx-window-opacity`、
    `--termx-ui-font`、`--termx-accent`、自定义 CSS 注入
    `<style id="termx-custom-css">`、system 主题 matchMedia 监听；
    `resolvedThemeMode` 供终端取明暗。
  - `SettingsDialog.tsx`：全屏 overlay 外壳（Netcatty 为独立窗口，形态差异
    已记录在案）；tab 顺序对照 Netcatty：应用 → 外观 → 终端 → 快捷键 →
    文件关联(禁用) → AI(禁用) → 同步与云(禁用) → 系统（插件等价 Netcatty
    条件渲染不显示）；搜索控件（目录检索 → tab 级定位）、Esc 关闭。
  - `SettingsTabs.tsx`（约 640 行）：**应用**（版本 + 检查更新禁用 +
    4 外链行复制按钮）、**外观**（语言 / UI 字体 / 透明度 50-100 / 背景模糊 /
    主题三卡片 / 浅深主题选择 / 自定义强调色 / 图标变体 / 主机库 6 开关 /
    自定义 CSS）、**终端**（字体区 9 项 / 光标区 4 项 / 行为区 13 项 /
    侧边栏 2 组 / 连接校验主机密钥）、**快捷键**（方案卡片 + 3 全局开关 +
    重置全部 + 按分类逐项捕获/启用/重置）、**系统**（自启动 / 网络代理 /
    凭据保护 / 崩溃日志 / 会话日志 / SSH 调试日志 / 临时文件与 AppLock
    占位）；文件关联、AI、同步与云为 **PlaceholderTab**。
- 接线：`TopTabs.tsx` nc-chrome 末尾加启用齿轮按钮（disabledUtilities 移除
  settings）；`App.tsx` settingsOpen 状态 + 启动 `loadSettings()`；
  `Terminal.tsx` 导出 `buildXtermOptions(s)` 并 subscribeSettings 实时应用
  设置（光标/字体/回滚/单词分隔/明暗双色板）；`icons.tsx` 新增 keyboard /
  hard-drive / file-type；`client.ts` 新增 listFonts / secretBackend /
  getAutoLaunch / setAutoLaunch / appVersion（R1：全部经 client.ts）；
  `styles.css` 追加 nc-settings-* / nc-set-* 样式与 `html[data-theme="dark"]`
  shadcn 变量覆盖（midnight 近似暗色）。

### 后端命令

- 新增 `get_auto_launch` / `set_auto_launch`（commands/settings.rs）：
  Windows 用 reg.exe 读写 `HKCU\...\Run`（CREATE_NO_WINDOW 0x08000000，
  与 shell_discovery 同做法，不引新依赖）；enabled 判定要求值指向当前
  exe 路径；非 Windows supported=false。**双注册**（R4）：lib.rs
  generate_handler! + server.rs dispatcher。
- 复用既有命令未重复造：`list_fonts`（fontdb 枚举）、`secret_backend`、
  `get_setting` / `set_setting`（均已双注册）。

### 测试与门禁

- 新增 `src/settings/settings.test.ts` 12 例（R11）：normalizeSettings
  回落 / clamp / 嵌套合并 / 绑定过滤 / 枚举校验；keyBindings id 唯一 /
  五分类覆盖 / effectiveBinding 覆盖与方案隔离 / normalizeKeyName /
  captureBinding；settingsT 回落链。
- `npm run test:run`：12 文件 **109/109** ✅；`npm run build` ✅；
  `cargo check` ✅（6 既有警告）；`cargo check --features server` ✅；
  `cargo test --lib` **789/789** ✅。

### 踩坑

142. **过期视图是本轮最大坑**：编辑前 Read 到的 settings.rs / server.rs /
     lib.rs / icons.tsx 内容与磁盘实际不符（如记 settings.rs 74 行、实际
     276 行；server.rs dispatcher 风格记错），首批 6 个 Edit 有 4 个报
     "String to replace not found"。git status 确认无并行改动后判定为
     视图过期。教训：**编辑前必须用当轮新 grep 验证锚点**，不信旧 Read。
143. TS 修复 3 处：TabDef.icon 需 `IconName` 类型（import type）；xterm
     fontWeight 传 number，不接受 `String(...)`；xterm 无 altIsMeta 选项，
     改用 `macOptionIsMeta`（Windows 下 Alt 行为由系统决定，注释说明）。
144. TopTabs 的 props 接口名实际是 `Props` 不是 `TopTabsProps`。
145. i18n 源键分散：终端文案在 Netcatty zh-CN/terminal.ts
     （`terminalSettings.font.*`）而非全在 core.ts；部分快捷键标签未收齐，
     按语义自拟（i18n.ts 注释说明）。

### 未移植项（设置中心内占位/降级，UI 均有说明）

- 窗口透明度原生实现（用 CSS opacity 近似）；主题预设库（仅内置 snow /
  midnight）；应用图标变体（仅保存不换图标）；外链打开 / 检查更新；
  崩溃日志；临时目录清理；网络代理仅保存（云同步 / AI 未移植）；搜索仅
  tab 级（Netcatty 到 section/anchor）；会话日志格式转换（enabled 已同步
  写既有 `recording_enabled` 键，asciicast 录制）。

### 下一步

- 下一轮：实机比对（build-debug 构建后 CU 对照运行中 Netcatty 逐项比，
  差异当场修）→ 子 agent 代码 review → push/本地 commit 收尾。

## 2026-11-03 · 设置中心实机比对 + review 收尾（已推送）

### 实机比对差异与当场修复（build-debug 构建，CU 对照运行中 Netcatty）

1. **SFTP tab 标签**：字典键 `settings.tab.fileAssociations` 与 dialog 实际
   查找的 `settings.tab.file-associations` 不一致导致显示裸 key；字典键改
   连字符形式，PlaceholderTab 去掉 camelCase 转换，占位文案改为 SFTP 设置
   说明（双击行为/默认视图/隐藏文件/自动同步/压缩传输/追随终端目录）。
2. **外观**：透明度增 100/85/70 预设按钮；主题卡片顺序与文案对齐（浅色/
   系统/深色，`theme.system` 改"系统"）；强调色行文案对齐（"使用自定义强调
   色/覆盖主题自带的强调色"）；图标 section 标题改"应用图标"；语言/界面
   字体行文案对齐；窗口透明度 section 标题 + NC 长描述。
3. **终端**：新增「终端主题」section —— `followAppTheme` 开关（Netcatty
   `settings.terminal.theme.followApp`，默认 true；关闭后终端固定深色，
   主题预设库未移植故无跟随浅色分支）+ 关闭时提示行；字号 Stepper 加
   `px` 后缀；字重标签改 `400 - 常规` 连字符形式；平滑描述改 NC 原文
   "使用 macOS 原生字体抗锯齿"。
4. **快捷键**：方案区文案整体对齐（快捷键方案/键盘快捷键/方案说明/
   Mac (Cmd)/PC (Ctrl)/"请按键..."捕获提示）；三全局开关补 desc；
   「自定义快捷键」section + 全部重置；43 条绑定全部用 Netcatty
   zh-CN `settings.shortcuts.binding.*` 原文标签（i18n 回落：无本地化键时
   用内置 label）；分类标题用 `nc-set-group-title`；按钮文案对齐
   （设为禁用/设为启用/重置为默认）。
5. **系统**：新增「软件更新」section 置顶（当前版本读 `appVersion()`、
   检查更新禁用、自动更新禁用开关、更新源行），对齐 Netcatty 系统 tab
   首节；网络代理行改 title=模式/desc=长描述；自启动描述补托盘表述占位。
6. **侧栏**：删除 VaultView 底部禁用的「设置」残留按钮（Netcatty 侧栏
   无此入口，设置入口仅顶栏齿轮）。

### 不可对齐差异（记录在案）

- 设置为全屏 overlay（Netcatty 是独立窗口，bridge.openSettingsWindow）。
- 透明度为 CSS opacity 近似（原生窗口透明未移植）。
- 主题预设库仅内置 snow/midnight，无主题市场/导入。
- CJK 字体为普通下拉（Netcatty 为可搜索 combo + 字体刷新按钮）。
- 行间距用 Stepper（Netcatty 为 slider）；更新器/崩溃日志/临时文件未移植。

### 实机验证

- 设置实时生效：深色主题点击后整窗即时变暗（截图确认）切回系统；透明度/
  字体改动即时应用。
- SSH：设置改动后点击 129 主机卡直连成功（提示符
  `tianzry@tianzry-VMware-Virtual-Platform:~$`，tab 标题 129，状态"已连接"），
  凭据走系统钥匙串，未输密码、密码未落盘。

### 子 agent review 结论与处理

- 高危：无。R4 双注册完整（lib.rs generate_handler! + server.rs dispatch），
  R1 合规（无裸 invoke），前后端契约一致。
- 已修：
  1. `--termx-accent` 只写不读 → 自定义强调色实际无效。改为转换后覆写被
     全站消费的 `--primary`/`--accent`（HSL 三元组）；新增纯函数
     `hexToHslTriplet`/`accentToHslTriplet`（settingsStore.ts）。
  2. `set_auto_launch` 注册表写失败静默转 `supported:false`，与"平台不
     支持"混淆 → 改返回 `Result<AutoLaunchStatus, String>`（机器错误码，
     R5 不直接展示）；前端 catch 改为回读 `getAutoLaunch` 同步真实状态。
  3. headless（rssh-server.exe）会把服务端二进制写进 Run 键 →
     `is_headless()` 守卫，拒绝登记并返回明确错误。
  4. server.rs dispatcher 在 async 分发里同步跑 reg.exe → 两个 auto_launch
     分支改 `tokio::task::spawn_blocking`。
- 已知问题（本轮未修，记录待后续）：en 字典仅 14 键（选 English 大部分
  回落中文）；settingsStore/buildXtermOptions/client.ts 新封装单测覆盖不全
  （buildXtermOptions 依赖 xterm 运行时，jsdom 下导入风险高，暂缓）；
  6 个死绑定 i18n 键；SettingsDialog Esc 在输入框聚焦时也关闭；
  右键/中键绑定语义借键；`recording_enabled` 只写不回读；设置持久化无防抖。

### 新增单测（R11）

- settings.test.ts +2 例（共 15 例）：`hexToHslTriplet` hex→HSL 三元组
  边界（纯黑/纯白/#3b82f6/非法）、`accentToHslTriplet` 三元组透传与拒绝。
- followAppTheme normalize 1 例（默认 true、可覆盖）。

### 门禁结果

- `npm run test:run`：12 文件 **112/112** ✅；`npm run build`（tsc + vite）✅；
  `cargo check` + `cargo test --lib`：**789/789** ✅（auto_launch 改动后复跑）。

### 踩坑

146. **Start-Process 启动的 GUI 子进程随 Shell 命令会话结束被杀**：
     rssh.exe 三次启动均数秒内静默退出（stderr 空）。改用
     `run_in_background` 常驻 shell 执行 `& rssh.exe` 后稳定。
147. **过期视图陷阱复现（坑 142）**：SettingsTabs.tsx Read 返回旧快照
     （640 行 settingsT 风格），磁盘实际是 939 行重构版（t()/Row/Toggle
     新 API），6 个 Edit 挂 5 个。重读真实文件后按新 API 重做。同时发现
     另一会话已 amend 历史（HEAD 3e0009c → 3724ff1，提交信息相同）。
148. **Q-Dir 抢焦点导致坐标点击落错窗口**：设置打不开，原因是前台被
     并行桌面会话的 Q-Dir 覆盖；必须先 `set_focus` termX 窗口元素再按
     element_id 点击。UIA element id 跨 Exec 即失效，观察→点击必须同一
     Exec 内完成。
149. **build-debug.bat 退出码 1 但构建成功**：npm build + cargo build 均
     成功，仅最后 NSIS 打包因 rssh.exe 被运行中进程占用报 os error 32；
     debug exe 已正常生成，属无害。
150. **StopCommand 对旧保活 shell 报 ExecutionNotFound**：改用
     `Stop-Process -Id` 杀旧实例；TaskOutput 只适用子 agent，查 shell
     后台任务靠完成通知。

### push 状态

- **已推送**（2026-11-03）：设置中心实现与收尾两个提交（`3724ff1`、
  `f3f9dd3`）经 SSH 地址推送至 GitHub，远端 `main` = `f3f9dd3`。

## 2026-11-03 · SFTP 移植研究：缺口清单（仅研究，未实现）

对照运行中 Netcatty 1.1.90 SFTP 界面观察与源码（只读
`g:\AiCode\termX\Netcatty`）盘点 termX 差距，定实现蓝图。详细研究存临时
简报（不入库）：`termx-sftp-gap-plan.md`（蓝图总纲）、
`termx-sftp-observations.md`（CU 界面观察）、`termx-sftp-ui-details.md`
（对话框/快捷键/页脚/i18n 原文）、`termx-sftp-electron-bridges.md`
（54 个 bridge 签名与事件形状）、`termx-sftp-rssh-ref.md`（rssh 可复用盘点）。

### Netcatty SFTP 形态（对标基准）

- 顶层根标签「SFTP」：左右**双栏**（焦点三角 + 点击聚焦清对侧选择），每栏
  独立会话标签栏（+/×/拖拽重排/跨栏移动/中键关闭/右键复制）、两行工具栏
  （行1：home/后退/前进/刷新 + **面包屑** + 路径双击编辑带建议；行2：编码、
  书签、复制路径、树/列表切换、紧凑、过滤、新建文件夹/文件、显示隐藏）、
  列头（名称/修改时间/大小/类型/所有者，排序/列宽/列显示菜单）、虚拟化
  列表（".." 首行、单击/Ctrl/Shift 选择、双击行为可配）、页脚
  （「N 个项目 - 已选 M 个」+ 当前路径）、空态 + 主机选择弹窗（本地/已连接/
  主机三分区 + 搜索 + 侧位 chip + 键盘导航）。
- **传输队列**：底部停靠面板（非 popover；默认 220px 可拖拽调高；最多 5 个
  顶层任务 + 子任务分组）。状态机
  `pending|queued|transferring|pausing|paused|attention|interrupted|completed|failed|cancelled`；
  全局并发默认 2（1..16），按 host:/session:/local 资源键各自限流；
  暂停/恢复（.part checkpoint + 源指纹/软校验）、优先、重试、清除已完成；
  **冲突检测在前端**（启动前 stat 目标 → attention + 冲突对话框）。
- **冲突对话框**：停止/跳过/创建副本/合并（仅目录对目录）/替换；文件冲突
  显示双方大小与修改时间卡片；多项时「应用到剩余 N 个冲突」。
- **编辑器**：双击文本文件 → 文本编辑器模态（读/写/保存回远端/word wrap）；
  外部应用打开 = 下载到临时文件 + **文件监视**（stat 轮询 1s + 防抖 500ms，
  上限 256）改动自动回写远端。
- **拖放**：跨栏拖拽 = 传输；外部文件拖入 = 上传；本地拖出到资源管理器为
  Electron 专属（`startLocalFileDrag`，Tauri 无等价，记差异）。
- **编码**：`SftpFilenameEncoding`（auto/utf-8/gb18030）贯穿列表/读写/
  传输/解压（对应 todo #25）。
- 其他：权限对话框（chmod 9 复选 + 八进制）、移动到、剪贴板图片粘贴上传、
  打开方式选择、树视图（懒加载 + 右键菜单）、书签、快捷键（11 条可配置 +
  typeahead/方向键/Ctrl+F 聚焦过滤等硬编码）。

### termX 现状

- 前端 `src/SftpPanel.tsx`：单栏基础版（独立连接/复用 SSH 会话；
  list/upload/download/mkdir/rename/delete/stat；内联输入新建/重命名；
  简易传输行）。**无**双栏/标签栏/面包屑/列头/虚拟化/页脚/空态/主机选择器/
  队列/冲突/编辑器/树视图/书签/快捷键/编码切换（已 grep 确认）。
- 后端 `commands/sftp.rs`：connect/connectSession/close/home/list/stat/
  mkdir/rename/remove/chmod/download(To)/upload(From)/walkRemote/
  cancelTransfer + 流式进度事件 + 原生 pick 对话框；另有 walkLocalDir。
- 可复用 rssh 原语：取消标志表 + CancelGuard、每传输事件名、原子 .part
  落地、walk_directory、防路径穿越、arboard 剪贴板单例（纯文本）。

### 缺口清单

**前端全缺**（新建 `src/sftp/`）：① 双栏页 + 焦点模型；② 会话标签栏；
③ 两行工具栏 + 面包屑 + 路径编辑；④ 列头 + 虚拟列表 + 选择 + 页脚；
⑤ 空态 + 主机选择弹窗；⑥ 对话框群（新建文件夹/新建文件/覆盖确认/重命名/
删除确认）；⑦ 传输队列底部面板 + 冲突/权限/移动到/剪贴板上传对话框；
⑧ 文本编辑器 + 文件监视回写；⑨ 打开方式；⑩ 拖放（跨栏/拖入）；
⑪ 树视图；⑫ 书签；⑬ 快捷键；⑭ 编码切换 UI。

**后端需补**：① 本地 FS 命令组（local_home/list_drives/list_dir/stat/
realpath/mkdir/rename/remove/read/write，形状对齐 RemoteEntry）；
② sftp_lstat/sftp_realpath（整文件读写复用现有 download/upload）；
③ 传输队列管理器 TransferCenter（并发/暂停恢复/优先/清理/统一生命周期
事件 `sftp:transfer:global`，冲突判定留前端）；④ open_path/
select_application/open_with_application；⑤ 临时文件注册表
（register/unregister/delete）；⑥ 文件监视（轮询 stat + 防抖 +
`filewatch:synced|error|stopped` 事件）；⑦ 剪贴板文件读
（Windows CF_HDROP）+ 文本写；⑧ 解压（本地走系统 bsdtar、远端走 SSH exec，
编码感知）。

**降级/后置**：本地拖出到系统（Electron 专属，记差异）；终端侧栏版 SFTP
不移植；pane 放大/压缩上传后置；断点续传基于 .part 偏移（若 russh-sftp
无 offset read 则整传并记差异）。

### 下一轮实现顺序

1. 后端本地 FS 命令组 + sftp_lstat/realpath + cargo test；
2. 前端骨架：双栏 + 标签栏 + 空态 + 主机选择器 + 连接流（替换 App.tsx
   `surface==="sftp"` 挂载）；
3. 文件列表 + 工具栏 + 面包屑 + 排序 + 页脚 + 选择 + 对话框群；
4. 传输队列（TransferCenter + 底部面板 + 冲突对话框）；
5. 编辑器 + 权限 + 移动到 + 剪贴板 + 打开方式 + 文件监视；
6. 树视图 + 书签 + 快捷键 + 编码 UI；
7. 门禁 → build-debug 实机比对 → 子 agent review → 提交。

---

## 2026-11-03 · SFTP 实现①：本地 FS 命令组 + sftp_lstat/realpath（后端）

### 修改点

1. **新建 `commands/localfs.rs`**（蓝图 B1）。`LocalEntry { name, kind(file|directory|symlink), size, mtime, link_target?, hidden }`
   （owner 不实现——Windows 本地所有者列本来就显示 "--"）。10 个命令：
   - `local_home`（dirs::home_dir）、`local_list_drives`（Win A:-Z: 探测，非 Win 返回 []）；
   - `local_list_dir`：目录优先 + 名称大小写不敏感排序（与远端 list_dir 一致）；单条
     元数据失败跳过、不毁掉整个列表；
   - `local_stat(path, follow? 默认 true)`、`local_realpath`（canonicalize 后手写去掉
     `\\?\` / `\\?\UNC\` 前缀）；
   - `local_mkdir`（递归）、`local_rename`；
   - `local_remove(path, expected_type?)`：lstat 与期望类型不符报 `local_type_stale`
     （符号链接视为通配，前端可能按目标类型归类）；Win 指向目录的符号链接先试
     remove_file、失败回落 remove_dir；
   - `local_read_file(path, max_bytes?)`：超限读**尾部**（编辑器预览大文件），预分配封顶 1MiB；
   - `local_write_file`。
   - hidden 判定：Win 用 `file_attributes & FILE_ATTRIBUTE_HIDDEN`，非 Win 用 `.` 前缀。
2. **远端补强**（蓝图 B2）：`FileStat` 增加 `is_symlink` 字段（只增不改，不破坏既有
   序列化）；`SftpHandle` 新增 `lstat`（symlink_metadata）与 `realpath`（canonicalize），
   命令层新增 `sftp_lstat` / `sftp_realpath`。整文件读写复用现有
   `sftp_download` / `sftp_upload`，不新增。
3. **双注册**（R4）：12 个新命令在 lib.rs `generate_handler!` 与 server.rs dispatcher
   同步注册；server 侧参数 camelCase（sftpId/path/follow/oldPath/newPath/expectedType/
   maxBytes/data）。
4. **单测 +3**（R11）：`strip_extended_prefix` 三形态；`localfs_roundtrip`
   （mkdir/write/list/stat/rename/尾读/type-stale 守卫/remove 全链路，临时目录自清理）；
   `list_drives_shape`。
5. client.ts 封装与前端按指令留到实现②，本轮不动前端。

### 验证

- `cargo check` ✓ 与 `cargo check --features server` ✓（仅既有 dead_code warning）。
- `cargo test --lib`：792 passed（789 → 792，+3 新增）。

### 踩坑

1. **结构体字面量字段顺序 = 求值/move 顺序**：
   `LocalEntry { name, ..., hidden: is_hidden(&name, ...) }` 里 `name` 先 move 再被借用，
   直接 E0382。借用 `name` 的字段（hidden/mtime）必须在字面量之前先算成 let。
2. `tokio::fs::DirEntry::metadata()` **不跟随**符号链接（等价 lstat），列表直接用；
   链接的目标类型/大小需再跟一次 `tokio::fs::metadata(path)`，断链 → `link_target=None`
   且保留链接自身大小。
3. Windows 上指向目录的符号链接不能用 remove_file 删（需 remove_dir）；
   `local_remove` 做了先 file 后 dir 的回落。

## 2026-11-03 · SFTP 实现②：前端骨架（双栏 + 标签栏 + 空态 + 主机选择器 + 连接流）

### 范围

按指令只搭骨架，不做实机比对（留到下一轮）；旧 `SftpPanel.tsx` 保留不删
（侧栏工具面板 tool==="sftp" 仍在用）。

### 修改点

1. **新建 `src/sftp/` 模块**（对照 Netcatty SftpView / SftpTabBar /
   SftpHostPicker / SftpPaneEmptyState 逐屏记录后落码，文案取自
   `termx-sftp-i18n-zhCN.txt`）：
   - `sftpModel.ts`：纯逻辑模型——远端/本地路径拼接与父目录、连接与标签类型、
     主机选择器三分区构建（本地恒显 / 已连接按搜索过滤 / 主机排除
     protocol=local 与已连接同 profile、按名排序、无匹配显示「没有匹配的主机」）、
     连接流分支（本地 / 复用会话 / 独立连接）与选择器条目→目标映射。零 I/O，全可测。
   - `SftpView.tsx`：左右 50/50 双栏 + 聚焦栏左上角蓝色三角 + 点击聚焦；
     每栏标签栏（有 tab 才显示）或空态；连接流三分支落地：本地→`local_home`；
     复用会话→`sftp_connect_session`+`sftp_home`；独立连接→按
     `credential_id` 从凭据列表取 username/secret 走 `sftp_connect`；
     home 获取失败时回收已建 sftp 会话；卸载时关闭全部远端会话。
   - `SftpTabBar.tsx`：本地=显示器图标 / 远端=服务器图标 + 名称 + ×，
     活动 tab 底部 accent 2px 下划线，中键关闭，右端 +（tooltip「新建标签页」）。
   - `SftpPaneEmptyState.tsx`：图标 + 粗体「先选择一个主机」+ 灰字
     「选择要浏览的本地或远端文件系统」+ 蓝色「+ 选择主机」；连接中/失败有提示。
   - `SftpHostPicker.tsx`：搜索（placeholder「搜索主机...」）+ 侧位 chip
     （左侧/右侧）+ 三分区行（本地文件系统/浏览本地文件；已连接绿点+meta；
     保存主机+host[:port]）+「没有匹配的主机」+ ↑↓ Enter Esc 键盘导航。
   - `SftpPaneView.tsx`：骨架版已连接面板（标签头 + 当前路径 + 刷新 +
     基础条目列表 + .. 回退），仅验证连接流；列头/排序/选择/虚拟化/工具栏/
     面包屑留实现③。本地侧默认过滤隐藏文件（对齐 Netcatty 默认）。
2. **`client.ts` 封装实现①命令**（R1：不裸 invoke）：`sftpLstat` /
   `sftpRealpath`；`LocalEntry` 类型 + `localHome` / `localListDrives` /
   `localListDir` / `localStat(follow?)` / `localRealpath` / `localMkdir` /
   `localRename` / `localRemove(expectedType?)` / `localReadFile(maxBytes?)` /
   `localWriteFile`。可选参数统一 `?? null` 传后端 Option。
3. **App.tsx 挂载切换**：`surface==="sftp"` 由旧单栏 `nc-sftp-page`（标题页）
   换成新 `SftpView`（全幅双栏，无页头，对齐 Netcatty）；「已连接」分区数据
   = 当前活动 SSH 终端会话（App 仅跟踪 activeSshSid）。
4. **styles.css**：新增 nc-sftp-view/side/focus-tri/tabbar/tab/empty/
   picker/pane 一整套（~450 行），沿用现有 HSL 变量。
5. **单测 +14**（R11）：`sftpModel.test.ts`——路径拼接（远端根/尾斜杠、
   本地盘符根）、父目录、选择器分区（本地恒显/去重/排序/搜索大小写/
   noMatch/flatten）、连接流分支与条目映射。

### 验证（门禁）

- `npm run test:run`：126/126 ✅（112 → 126，+14）。
- `npm run build` ✅（仅既有 chunk 大小警告）。
- `cargo check` ✅（仅既有 6 条 warning；本轮未动 Rust）。

### 踩坑

1. **TS 判别联合收窄不认"分支变量"**：`const branch = connectBranch(target)`
   后 `if (branch === "local") return;` 无法收窄 `target`，后续解构
   `target.entry` / `target.profile` 报 TS2339。收窄必须直接走
   `target.kind` 判别式（`connectBranch` 仍保留为可测的分支映射）。
2. 「已连接」分区受限于 App 只跟踪**活动** SSH 会话（activeSshSid），
   多会话全量列表需 Workspace 会话注册表，后续阶段补。
3. 已知差异（留后续）：切换 surface 会卸载 SftpView 并关闭全部远端会话
   （Netcatty 用 visibility 保活）；独立连接对 agent/interactive/none
   凭据（无 secret）会在后端报错，错误展示在空态。
4. PowerShell 里 `Measure-Object -Line` 对 changelogs.md 报 1856 行，
   实际 2200+ 行（编码/换行差异）；定位文件尾部以 Grep/Read 为准。

### 提交状态

- 按指令本轮不 push：实现②完成、下一轮实机比对通过后再推。

## 2026-11-03 SFTP 骨架·实机比对（实现②验证轮）

### 比对结论（对照运行中 Netcatty 1.1.90 zh-CN 逐屏）

一致项：
- 双栏 50/50 比例与分割线位置；聚焦态=聚焦栏左上角蓝色三角，点击栏跟随移动（Netcatty 空态/连接态两屏确认）。
- 空态：图标（左 monitor / 右 server）+「先选择一个主机」+「选择要浏览的本地或远端文件系统」+「+ 选择主机」蓝色按钮，文案与结构逐屏一致。
- 主机选择器：头部（搜索图标 / 「搜索主机...」 / 左右侧 chip / ×）、三分区 本地→已连接→主机、本地行「本地文件系统—浏览本地文件」、无匹配「没有匹配的主机」、已连接去重隐藏主机分区同 profile（Netcatty 连接 129 时主机分区消失，termX 规则一致）；↑↓ 选择移动有效。
- 标签栏：图标 + 名称 + ×，右端新建 +（Netcatty 连接态对照）。

已修项（src/styles.css）：
- 选择器背景暗遮罩 rgb(0 0 0 / 0.45) → transparent（Netcatty 运行版无遮罩）。
- 选中行实底 hsl(var(--accent))（灰字不可读） → hsl(var(--accent) / 0.16) 浅蓝底深字（Netcatty 运行版样式）。
- 复检受阻：修复重编后 termX 实例启动后自退（见踩坑1），视觉复检与连接流坐标点击复验未完成，留下一轮首轮执行。

不可对齐 / 留档项：
- 已连接行与远端标签图标：Netcatty 用主机 OS 图标（ubuntu 等），termX 用通用 server 图标；OS 图标资产体系留实现③。
- 切 surface 卸载关闭远端会话（Netcatty visibility 保活）、独立连接无 secret 凭据报错、已连接分区仅活动会话：实现②留档，本轮复认。

未决异常：
- 选择器行点击（CU 元素路由）与 Enter 键均不触发 onPick（↑↓ 有效、button 元素点击有效）：疑 CU 对 WebView2 子窗口非 button 元素的路由/坐标 artifacts；坐标点击复验因应用自退未执行，下轮以坐标点击裁定：若坐标点击有效=CU artifacts，否则按应用缺陷排查。
- 连接流三路径本轮仅完成选择器侧验证；本地/独立 129（列目录）/复用会话的端到端实测留下一轮。

### 踩坑

1. termX debug 版本轮 4 次启动中 3 次（detached Start-Process）启动后数秒~数分钟自退，事件日志仅空 stability 记录；前台持有 stdout 管道的实例长期存活。疑 WebView2/启动竞态或 stdout 句柄相关；下轮用前台管道方式启动实机并观察。
2. CU 对 WebView2 子窗口内非 button 元素（选择器行 text/div）的元素点击不触发 React onClick，button 元素正常（走 Invoke pattern）；复验改用窗口相对坐标点击（本地行≈(610,461)、129 行≈(610,533)，1216x882 窗口）。
3. cargo check 需 --manifest-path src-tauri\Cargo.toml（仓库根无 Cargo.toml）；tauri build 前必须先 Stop-Process rssh，否则 exe 被锁报 os error 5。
4. Netcatty SFTP 窗口 web 内容需先对窗格 perform_action set_focus 才入 UIA 主树（termX 同，pane "termX - Web 内容"）。

### 门禁

- npm run test:run 126/126 ✓；npm run build ✓；cargo check ✓（仅既有 6 条 warning）；tauri debug 重编 ✓（含 styles.css 修复）。

### 提交状态

- 本轮本地 commit（styles.css 修复 + 文档）；按指令不 push、不 review，下一轮子 agent review 通过后与实现①②一并推送；视觉复检/连接流端到端实测为下一轮首项。

---

## 2026-11-03 SFTP 骨架·复检 + 端到端（实现②复验第二轮）

### 启动自退定性结论

- 干净进程态下 8 次启动（4 次前台持 stdout 管道 + 4 次 detached）**全部存活**，上轮「detached 3/4 自退」未复现；无单实例逻辑（rg single-instance 无命中）、无 stderr 崩溃输出。
- 真因查明：**Shell 工具的子进程在命令结束时被统一 kill**（沙箱内/外一致）。上轮「前台持 stdout 管道存活」恰因父命令仍在运行。定性 = 启动方式/环境 artifact，**非应用崩溃，无需代码修复**。
- 可靠持活启动法：后台 shell 命令内 `Start-Process rssh.exe -PassThru` + `$p.WaitForExit()`，实例可跨命令存活（本轮 pid 21100 全程可用）。

### 视觉复检（选择器）

- 遮罩 transparent ✓（背后双栏空态清晰可见）、选中行浅蓝 hsl(var(--accent)/0.16) ✓、三分区/左侧 chip/分区标签/聚焦三角 ✓ —— 上轮修复保持，与 Netcatty 一致。

### 行点击 onPick 裁定

- 窗口坐标点击**可触发 onPick**（选择器关闭并进入连接流）⇒ 上轮「元素点击/Enter 不触发」确为 **CU artifacts**（CU 对 WebView2 子窗口内非 button 元素的元素路由不可靠）。
- 新坑：CU 坐标点击原点 = **webview viewport**（窗口标题栏 + TopTabs 之下，y 偏移 ≈ −72），非窗口原点；且选择器行 y 随分区数变化（dialog 垂直居中）。坐标必须按当次截图现测现用。
- 坐标点击（element_id="0"）要求最近一次 get_app_state 带截图，disableScreenshot 的快照下报 invalid element_id。

### 连接流三路径端到端

1. **本地**：PASS。左栏「本地」tab、路径 `C:\Users\tianzry`、目录列表正常（Windows 下点目录无 hidden 属性，不过滤，语义正确）。
2. **复用已连接会话**：PASS。Vaults 连接 129 SSH 终端（状态槽「129 已连接 (c004b3a0…)」）→ 选择器「已连接」行 → sftpConnectSession → 左栏「129」tab、`/home/tianzry` 列表完整。
3. **独立连接 129**：先 FAIL 后修复复测 PASS。失败原文：左栏空态红字「认证被服务器拒绝。」+ 控制台 `WARN rssh_lib::ssh::client SSH session error: Disconnect`。根因：`list_credentials` 设计不返回 secret（[profile.rs](src-tauri/src/commands/profile.rs) 注释），SftpView 独立连接分支误用列表凭据的空 secret 调 sftpConnect → 空密码认证被拒。修复：列表判存在后改 `api.getCredential(id)` 取全量凭据（[SftpView.tsx](src/sftp/SftpView.tsx)）。该项系上轮留档复认项，本轮关闭。
- 密码不入库不入日志：汇报与日志仅含错误文案与 session id。

### 留档 / 后续项

- SftpView 随根标签（surface）切换卸载，pane tab 状态丢失（切回后本地 tab 消失）；Netcatty 为 visibility 保活。留实现③（状态上提或保活）。
- 已连接行/远端标签 OS 图标留实现③（上轮已留档）。

### 踩坑

5. Shell 工具（沙箱内外）命令结束即 kill 子进程 ⇒ GUI 实机验证必须用后台持活命令；「启动自退」先怀疑此 artifact 再怀疑应用。
6. CU 坐标点击原点 = webview viewport（窗口 y −72）；选择器行坐标随分区数漂移，按当次截图现测。
7. `list_credentials` 不含 secret；凡连接路径需要 secret 必须走 `get_credential`（SftpView 独立连接踩坑，空密码表现为「认证被服务器拒绝。」）。



### 门禁

- npm run test:run 126/126 ✓；tauri debug 重编 ✓（含前端 vite build 与 cargo 编译，覆盖 npm run build / cargo check 门禁，详见构建输出）。

### 提交状态

- 本轮本地 commit（SftpView secret 修复 + 文档）；按指令不 push、不 review，下一轮子 agent review 通过后与实现①②一并推送。

---

## 2026-11-03 SFTP 实现①②推送前 review + push

### Review 方式与范围

- 子 agent 代码 review（只读）。范围 = 实现①后端（1f5af63：localfs.rs 命令组 + sftp_lstat/realpath）+ 实现② 3 个未推送提交（dba8c5c / 6edc7a9 / 3ac6eac）。
- 说明：子 agent 曾读到过期的 origin/main 引用误判远端基线，以本会话两次 `git ls-remote`（均为 1f5af63）为准；1f5af63 为本地 HEAD 祖先（rev-list 领先 3），可快进推送。

### Review 结论（八大重点）

- **无高危**。
- 路径处理与权限边界（localfs）：无真实漏洞。任意路径访问属文件管理器设计内；canonicalize 的 `\\?\` / `\\?\UNC\` 前缀由 strip_extended_prefix 正确还原且有单测；列表用 symlink_metadata 不跟链；local_remove 对符号链接只删链接本体不追目标。
- sftp lstat/realpath 错误映射与既有命令一致，无 unwrap/panic；get_sftp 走 locked() 处理锁中毒。
- 凭据安全：SftpView 独立连接经 getCredential 取全量凭据，secret 仅作瞬态局部变量传入 sftpConnect；src/sftp 全程无 console.*、无状态持久化、无日志记录；meta 仅含 username@host。
- 双注册：12 个新命令（10 个 local_* + sftp_lstat/sftp_realpath）在 lib.rs generate_handler! 与 server.rs dispatcher 均注册，无遗漏。
- 前端无裸 invoke：invoke/listen 仅存在于 client.ts。
- 测试可信度：sftpModel.test.ts（14 例）与 localfs roundtrip 均断言真实行为（排序/目录优先/尾部读/类型守卫报错），无恒真测试。

### 中危修复（推送前已修）

1. **local_read_file 无读取上限**：`max_bytes` 缺省时读全文件（原 1MiB 封顶仅限预分配），巨型文件会吃满内存并经 IPC 序列化再膨胀（number[] 约 4×）。修复：新增 `DEFAULT_READ_CAP = 16 MiB`，缺省同样按上限读**尾部**（与「超限读尾」语义一致）；抽出纯函数 `read_skip` 并补 4 断言单测（read_skip_tail_and_default_cap）。
2. **3 个新错误码缺中文映射**：`local_io_failed` / `local_type_stale` / `local_home_unavailable` 在 sshErrors.ts ERROR_MESSAGES 无条目，回退会把英文 OS 原文直接给用户。修复：新增「本地文件系统」分区三条中文文案。

### 低危记录（待后续）

1. TS `FileStat` 接口（client.ts）缺 `is_symlink` 字段声明（Rust 侧已有该字段，sftpLstat 注释声称「is_symlink 可信」）。
2. local_remove 的 `expected_type` 为 Option：传 None 可删任意目录树（文件管理器设计内；实现③接线时前端必须恒传 expectedType）。
3. 12 个新 invoke 封装未补 client.test.ts 覆盖（R11）。
4. 孤儿 CSS：App.tsx 已移除 `.nc-sftp-page` 标记，styles.css 对应旧样式可清理。

### 门禁

- npm run test:run 126/126 ✓；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check ✓（仅既有 6 条 dead_code 警告）；cargo check --features server ✓；cargo test --lib 793✓ / 0✗（含新增 read_skip 用例）。

### 推送

- 推送前核对远端 main=1f5af63 且为本地 HEAD 祖先（快进）；3 个未推送提交 + 本轮修复提交经 `git push git@github.com:tianzry/termX.git HEAD:main` 推送，ls-remote 核对结果见汇报与下一轮记录。

---

## 2026-11-03 SFTP 实现③：状态保活 + OS 图标 + 低危收尾

### 状态保活（切 surface 不丢 pane tab / 双栏状态）

- 调研结论：Netcatty `SftpViewMount`（AppMounts.tsx:L147-164）为「首次激活后 sticky 挂载」——`shouldMount` 一旦为 true 不再回落；非激活时 `SftpViewInner` 以 `visibility:hidden + pointerEvents:none + position:absolute` 自隐藏（SftpView.tsx:L513-520）。
- termX 实现：App.tsx 新增 `sftpMounted`（surface==="sftp" 过一次即恒 true），SftpView 常驻挂载于 `.nc-sftp-mount` 容器，切走加 `.hidden`（display:none）；styles.css 新增对应样式。
- 效果：Vaults↔SFTP↔终端来回切换，标签/双栏/聚焦状态保留；SftpView 的卸载清理（sftpClose 全部远端会话）仅在应用退出时触发，切换不再误关会话。

### OS 图标（已连接行与远端标签）

- 调研结论：Netcatty 的 OS 图标为 `DistroAvatar` + `/distro/*.svg` 资产（GPL-3.0，按既有约定不复制）；判定依赖主机记录的持久化字段（`os/osOverride/distro/deviceType`，domain/host.ts `resolveHostOs`），另有 SSH 服务标识串的厂商检测。termX 的 Profile 无 OS/distro 字段、后端未暴露 SSH 服务标识串 → **资产与判定方式均不可复用，采用最接近的通用映射**。
- 通用映射（sftpModel.ts 新增 `HostOs` / `detectLocalOs` / `osFromUname` / `osIconName`，纯函数带单测）：
  - 本地标签：userAgent 判定本机 OS（Windows / macOS / Linux）。
  - 复用会话连接：best-effort 经 sshExec 跑 `uname -s`（3s 超时、不阻塞连接流），Linux/Darwin/Windows 直映、BSD 近似归 linux；失败保持 unknown 回落服务器图标。
  - 独立连接：无 OS 信息来源（仅 SFTP 子系统），保持 unknown → 通用服务器图标。
  - 选择器已连接行：`entry.os` 已知时显示 OS 图标，否则回落绿点（当前连接时刻尚未探测，实际均回落绿点）。
- 图标：icons.tsx 新增 os-windows（四格窗）/ os-macos（⌘ 环形符）/ os-linux（企鹅轮廓），lucide 风格原创路径，不复制 GPL 资产。
- 已知局限（记录待后续）：独立连接的远端标签要显示 OS，需引入 profile.os 字段或 SSH 服务标识串检测；选择器已连接行的 OS 显示需会话曾被探测过。

### 低危收尾（上轮 review 记录的 4 项闭环）

1. TS `FileStat` 补 `is_symlink: boolean` 声明（Rust 侧已有该字段）。
2. `localRemove` 的 `expectedType` 改为必传（守卫恒传；当前无前端调用点，先以类型强制）。
3. client.test.ts 补 12 个新封装（10 local_* + sftp_lstat/sftp_realpath）的 mock 参数形状覆盖（+8 例）。
4. styles.css 删除孤儿 `.nc-sftp-page*` 旧样式（约 44 行）。

### 门禁

- npm run test:run 136/136 ✓（+10：client 8 例 + sftpModel OS 判定 2 例）；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check ✓（仅既有 6 条 dead_code 警告）；cargo check --features server ✓；cargo test --lib 793✓ / 0✗（本轮无 Rust 改动）。
- 本地 commit 未推送；实机比对（保活切换验证 + OS 图标目检）留到下一轮。

---

## 2026-11-03 SFTP 实现③·实机比对（CU 验证受阻，延后）

### 目标

对实现③（35e988a）做实机比对：Vaults ↔ SFTP ↔ 终端来回切换后标签/双栏/聚焦状态保留、本地标签 OS 图标正确、复用 129 会话后远端标签显示 linux 图标、切走时无残留可见面板；并与 Netcatty 对照同名场景。

### 已确认项

- build-debug 构建成功，rssh.exe 正常启动（最大化）；SFTP 双栏空态渲染正确（聚焦三角、「先选择一个主机」文案、「+ 选择主机」按钮均在位）。
- 源码核查：`SftpPaneEmptyState` 按钮接线正常（`onSelectHost` → 打开 picker）；`.nc-sftp-picker-overlay` 为 `position:fixed; inset:0`，picker 若 open 必可见 → 无 CSS 回归。
- 保活逻辑源码核查：`sftpMounted` sticky 挂载 + `.hidden`（display:none），切换不卸载，状态保留为设计必然。

### 阻塞证据（CU 环境 artifact，非应用缺陷）

- WebView2 内容无 UIA 名称，只能坐标点击；element 坐标原点的多种映射假设（(40,48)/(40,32)/(0,32)/(30,48)、窗口原点、最大化后 identity 映射）逐一被证伪。
- 点「选择主机」按钮 7 次（左/右栏、纵向扫描 y=505~565、Escape 间隔）：焦点三角有变化（点击到达窗口）但 picker 从不弹出（overlay 为 fixed，若 open 必可见 → 确认未 open）。
- 最大化后点 Vaults/SFTP 顶标签也不切换。
- 绘制光标 glyph 偏移不一致（(+40,+48)/(+72,+132)/(+72,+100)/(+188,+297)/(+42,+21)），光标 glyph 不可信；element_id 每次观察重新编号，陈旧 id 原点漂移。
- 最后手段：对 rssh 控制台窗口 set_focus + type_text 注入 JS 点击亦未生效（该控制台可能并非应用 webview 的 devtools）。
- 无键盘捷径可绕过（grep ctrlKey/metaKey/altKey 仅 settings/keyBindings 与 vault 选择逻辑）。

### 结论

- 本轮未发现代码缺陷、无修复；实机比对（建标签 / OS 图标目检 / 保活实证 / 无残留 / Netcatty 对照）延后，留待后续轮重试（更换 CU 会话或改人工操作）。
- 门禁沿用 35e988a 全绿：136/136 + build✓ + cargo check×2✓ + cargo test --lib 793✓（本轮无代码改动，未重跑）。

---

## 2026-11-03 串口热修：入口落错分支 + 按 Netcatty 真实形态重做弹窗

> 来源：用户实测反馈（优先级最高）。笔记阶段临时暂停，未提交的 Notes 后端脚手架已 `git stash` 保存。

### Bug 复现（用户实例，PID 19668，exe LastWriteTime 19:23:21 = 串口阶段 B 最新包）

- 路径：Vaults 首页右上角「串口」→ 期望打开串口连接入口。
- 现象：直接新增一个 `本地终端 1` 标签（cmd 提示符），右侧再挂上「串口」工具面板。
- 证据：[serial-after-click.png](g:\AiCode\termX\evidence\serial-after-click.png)（修复前点击结果）；同轮 [netcatty-serial-modal.png](g:\AiCode\termX\evidence\netcatty-serial-modal.png) 为 Netcatty 真实弹窗。

### 根因

- `App.openSerial()` 先 `setSurface(null)`，再 `workspaceRef.ensureTab()`，最后 `setTool("serial")`。
- `ensureTab()` 在无标签时会新建 `{ kind: "pty" }`，即**每次点串口都先起一个本地 shell**；串口本身只是右侧面板，于是形成「本地终端 + 串口面板」的错误组合。
- 同类入口复核：Telnet 仍走 `ensureTab()` + 工具面板（需要承载窗格，形态与 Netcatty 的 Telnet 弹窗仍不一致，留待后续专项）；SFTP / 端口转发不调用 `ensureTab()`，不会误开终端。

### 修复方式

1. 串口入口改为 Netcatty 形态：点击只打开 `SerialConnectModal`，不再 `ensureTab()` / `setSurface()`。
2. 弹窗确认后才创建标签，新增 `Connector.kind = "serial"`（携带端口 + `SerialConfig` + 终端选项，无凭据）：
   - `workspaceModel.defaultTitle` → `串口 COM1`；
   - `TerminalPane.connect()` 串口分支：先订阅 `serial:data/close`，再 `serialOpen`，输入经 `serialInput`（行模式 / 本地回显 / DEL 语义）后 `serialWrite`；关闭 / 切换标签时 `serialClose`。
   - `workspaceStore` 允许 serial 连接器持久化与恢复（不含密码）。
3. 删除旧的右侧 `SerialPanel.tsx`，避免保留两套串口 UI。

### UI 对照（Netcatty vs termX 修复后）

- 对照图：[serial-ui-compare.png](g:\AiCode\termX\evidence\serial-ui-compare.png)；termX 修复后弹窗：[serial-fixed-modal-final.png](g:\AiCode\termX\evidence\serial-fixed-modal-final.png)；连接结果：[serial-fixed-connected-final.png](g:\AiCode\termX\evidence\serial-fixed-connected-final.png)。
- 已一致：模态弹窗形态（居中、遮罩、Esc / 点遮罩关闭）、标题「连接串口」+ USB 图标 + 描述「配置串口连接参数」、右上关闭；「串口 + 刷新」→ 可输入/可清空的端口下拉（默认 COM1）、命名管道提示；波特率（默认 115200，自定义提示）；「高级」默认折叠（数据位/停止位/校验位/流控制/终端选项/字符编码）；底部「取消 / 连接」，端口未选或参数非法时连接禁用。
- 已修：端口输入框自动聚焦（蓝色焦点环与 Netcatty 一致）；标题 18px / 字段 14px / 提示 12px 字号对齐。
- 待人工 / 有意差异：Netcatty 的「保存配置（将此串口配置保存到主机列表以便快速访问）」未复刻——termX 无 Netcatty host 模型，做了只会是一个查不到的假入口；自动登录属于 Netcatty 主机编辑面板，不在连接弹窗内，termX 同样不放。COM1 实测已确认串口句柄由 rssh 持有（外部尝试打开被拒），但真实收发字节未做回环手测。

### 验证与门禁

- 复现证据 + 修复后点击：`串口` → 弹窗；`连接` → 仅新增 `串口 COM1` 标签，不再出现 `本地终端 1`。
- Esc 实测通过（弹窗关闭回到 Vault，未创建任何标签）：[serial-esc-closed.png](g:\AiCode\termX\evidence\serial-esc-closed.png)；点遮罩关闭走同一回调，未单独截图。
- `npm run test:run` 296✓（新增 workspaceModel 串口标题 2 例、workspaceStore 串口持久化 1 例）；`npm run build` ✓；`cargo check --features server` ✓；`cargo test --lib` 836✓（本轮无 Rust 改动）。
- 本地 commit + 推送完成：`5450a52` → `74b03fa` → `1d3616f`（自审修复），远端 `main = 1d3616f`；调试实例保持运行（PID 23056，停留在串口弹窗）供继续手测。

### 推送前自审（2026-11-03）

- 修复串口监听注册的退订缺口：改为逐条入栈，第二个 `onSerialClose` 注册失败时第一个 `onSerialData` 也会退订。
- 修复重连竞态：旧会话的 `serial:close` 事件可能在新一次 `connect()` 之后到达，回调加 `attempt` 守卫，避免把新会话显示成「串口已断开」。
- 复核：`openSerial` 不再调用 `ensureTab()`；旧 `SerialPanel` 无残留引用/CSS；`Connector.kind="serial"` 打开、输入、teardown `serialClose`、workspace 恢复链路闭合；串口错误码 `serial_not_found` / `serial_open_failed` 已在 `sshErrors.ts` 映射。
- 门禁：`test:run` 296✓、`build` ✓、`cargo check --features server` ✓（仅原有 3 条 warning）、`cargo test --lib` 836✓。

---

## 2026-11-03 SFTP 实现③推送前 review + push

### Review 结论（子 agent，范围 0132eea..HEAD = 35e988a + 3d9c143）

六大重点全部通过，无高危/中危：

1. **SftpView 常驻挂载**：无 listen/定时器累积（picker 50ms 聚焦 timer 有 cleanup，window keydown 仅 open 时注册且 overlay 全屏、切走前必先关闭）；卸载清理经 sidesRef 关闭全部远端会话，sticky 后仅应用退出触发，路径仍正确；标签↔sftpId 一对一、closeTab 成对 sftpClose。
2. **display:none 切换**：src/sftp 无 ResizeObserver/尺寸测量；聚焦三角纯 CSS；滚动位置浏览器保留；切回需重新点击聚焦属预期。
3. **uname 探测**：后端 ssh_exec clamp [1s,60s]，3000ms 有效；探测期间标签关闭 → updateTabOs 按 sftpId map 无匹配即 no-op，setState 安全；sftpId 每次连接新 UUID 无误配竞态；失败静默回落 unknown。
4. **OS 判定回退**：全正则/字符串操作不抛异常；空串/空白→unknown 有测试；osIconName unknown→null，两调用点（`??` / 三元）均有回落。
5. **localRemove expectedType 必传**：全前端仅 client.ts 定义与测试引用，无调用点被破坏，tsc 通过。
6. **测试真实性**：client.test 8 例均 `toHaveBeenLastCalledWith` 断言完整参数对象（含缺省 null、Uint8Array→number[] 转换）；sftpModel 2 例断言映射逻辑与边界。

通用项：无裸 invoke/listen ✓；本 diff 不涉凭据流 ✓；`.nc-sftp-page*` 删除后全仓无残留引用 ✓；icons.tsx 三条 SVG 路径有效 ✓；FileStat.is_symlink 与后端结构匹配 ✓。

### 低危记录（2 项，未修）

1. `osFromUname` 用 `startsWith("linux")`，"GNU/Linux" 类非标准输出会落 unknown（实际 `uname -s` 只输出 "Linux"），可选改 `includes` 增稳。
2. 复用会话的终端标签关闭后，SFTP 死标签驻留时间因保活变长（既有行为，非本次引入）。

### 门禁

- npm run test:run 136/136 ✓；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check ✓（仅既有 6 条 dead_code 警告）；cargo check --features server ✓；cargo test --lib 793✓ / 0✗。

### 推送

- 推送前核对远端 main=0132eea 且为本地 HEAD 祖先（快进）；`git push git@github.com:tianzry/termX.git HEAD:main` 推送 0132eea..3d9c143（实现③ + 实机比对结论文档，2 提交），ls-remote 复核远端 main=3d9c143。

---

## 2026-11-03 SFTP 文件操作（上传 / 下载 / 删除 / 重命名 / chmod）

### 修改点

1. **后端补缺（R4 双注册）**：`server.rs` dispatcher 补 `sftp_chmod`（此前 headless / JetBrains 侧不可用；GUI 侧 lib.rs 早已注册）。五操作命令本体（`sftp_download_to` / `sftp_upload_from` / `sftp_remove` / `sftp_rename` / `sftp_chmod`）均为既有实现，本轮未改。
2. **129 真实连接自动化验证**：`commands/sftp.rs` 新增 `live_sftp_file_ops_roundtrip`（`TERMX_SFTP_LIVE=1` 门禁，默认静默跳过，不进常规门禁）：读取与应用相同的 `~/.rssh` DB + SecretStore（档案 "129" = 192.168.126.129，凭据经 keychain 解密，不落明文），走引擎直连跑 **连接 → mkdir → 流式上传 → list → stat → rename → chmod(0o640) → lstat 校验权限位 → 流式下载字节比对 → remove → rmdir** 全链路，实跑 **通过**。
3. **前端接线**（基准 Netcatty SftpPaneFileList / SftpPaneDialogs / SftpPermissionsDialog 的 termX 范围子集）：
   - `SftpPaneView.tsx` 重写：右键菜单（远端行=下载(仅文件)/重命名/修改权限/删除；本地行=重命名/删除；空白处=新建文件夹，远端另有上传文件）、底部传输条（每传输订阅 `sftp:progress:<transferId>`，进度 + 取消走 `sftp_cancel_transfer`）、行选中高亮。
   - 新增 `SftpPaneDialogs.tsx`：右键菜单、重命名/新建文件夹输入弹窗（Enter 确认 / Esc 取消）、删除确认（删除中禁用）、chmod 3×3 复选弹窗（实时八进制展示）。
   - `sftpModel.ts` 新增权限位纯函数 `permsFromMode` / `permsToOctal` / `octalToMode`（P4：FileStat.permissions 是 u32）+ 3 例单测。
   - 上传/下载入口：原生文件选择（`sftp_pick_open_files` / `sftp_pick_save_path`）+ 流式命令；本地侧删除带 `expectedType` 守卫。
4. **范围说明**：跨面板对传 / 拖放（todo #9）、工具条 / 面包屑（研究蓝图③）、目录下载（`sftp_download_to` 为文件流式）、本地侧 chmod（Netcatty 同样不提供）均不在本轮。

### 踩坑经验

1. **引擎 `SftpHandle::upload()`（= russh `sftp.write`）对不存在的目标文件报 `No such file`**（129 实测发现，疑似 open 未带 CREATE 标志）。UI 上传走 `upload_streaming`（生产路径）不受影响；未来 `sftp_save_file`（内置编辑器）写新文件时要走流式路径或先查此处。
2. `SecretSystem` 不直接实现取密，需 `secrets.store.get(&cred_secret_key(id))`（`.store` 是 `Arc<dyn SecretStore>`，dyn 调用无需 trait import）。
3. live 测试首次失败会在远端留下空目录（本轮遗留 `/tmp/termx-live-<首次pid>`，无害）；断言链越靠后失败残留越多，清理逻辑放最后是可接受取舍。

### 门禁

- npm run test:run **139/139** ✓（+3 权限位测试）；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check ✓ + cargo check --features server ✓（仅既有警告）；cargo test --lib **794✓ / 0✗**；129 live 测试 ✓。
- 前端视觉核对（右键菜单/对话框/传输条渲染）按新节奏留人工或新 CU 会话。

---

## 2026-11-03 SFTP 文件操作 · 推送前 review + push

### Review 结论（自审 + 定向取证；范围 3d9c143..19adac3）

- **35e988a / 3d9c143 已在远端**：开工 ls-remote 确认（上轮推送成功，结论见上一节），本轮未重复 review。
- **中危修复 1 项（87e197e）**：`sftp_io_failed` / `sftp_tree_too_deep` / `sftp_session_not_found` / `sftp_invalid_filename` / `sftp_file_too_large` 五个错误码未进前端 `ERROR_MESSAGES`，回退路径会把服务器英文原文直接展示（R5；先例 0132eea 修 local_* 同类）。补中文映射 + 3 例测试后随推。
- **通过项**：
  1. 对话框确认/取消路径：PromptDialog Enter/Esc/遮罩（busy 守卫）、删除/权限弹窗按钮与 busy 禁用，`finally` 统一释放 dialogBusy；ContextMenu 外部点击/Esc 清理完整。
  2. chmod 拼装与回读：权限位三函数有往返单测；mode 经 sftpStat 回读；应用值为 3 位八进制 ≤ 0o777，合法 u32。
  3. 取消竞态：CancelGuard 传输开始插入、Drop 移除；取消已完成传输为 no-op、重复取消幂等、前端 finally 保证 unlisten+dropTransfer。
  4. `sftp_chmod` 双注册齐全（lib.rs + server.rs，参数形状一致）；R1 无裸 invoke/listen；进度订阅逐条 unlisten。
- **低危记录（不修）**：① 远端 rename 目标已存在时报错（russh SFTP 语义，无静默覆盖），本地 localRename 覆盖语义随平台，两侧不完全一致；② 删除对话框未对目录加「递归删除」文案（引擎 remove() 对目录自动递归、深度上限 `sftp_tree_too_deep`，与 Netcatty 行为一致）；③ chmod 仅处理低 9 位，setuid/sticky 位会被丢弃（Netcatty 同为 9 位）；④ 删除/权限弹窗无 Esc 关闭（输入弹窗有）；⑤ `DialogShell` 遮罩 onMouseDown 为无效代码。

### 门禁与推送

- 门禁：test:run **140/140** ✓（+1 sftp i18n 测试）；build ✓；cargo check + --features server ✓（本轮后端无改动，沿用工位全绿）；cargo test --lib **794✓**；129 live 按指示未重跑。
- 推送：核对远端 main=3d9c143 且为 HEAD 祖先（快进）→ 推 3d9c143..19adac3；i18n 修复补提交后再推 19adac3..87e197e；ls-remote 复核远端 main=**87e197e**。
- 过程记录：首次推送脚本里远端全哈希凭记忆写错导致中止（前缀正确），改用 `git merge-base --is-ancestor` 判定后成功——后续推送核对一律用祖先判定，不手写全哈希。

---

## 2026-11-03 SFTP 传输队列与冲突对话框 · 阶段 A（后端队列中心）

### 修改点
- 新增 `src-tauri/src/sftp/transfer_center.rs`（队列中心）与 `src-tauri/src/db/sftp_transfer.rs`（持久化）：
  - 排队项 TransferItem（id/sftp_id/batch_id/direction/路径/size/status/priority/seq/overwrite/error），状态机 queued/running/paused/conflict/completed/failed/cancelled/skipped；
  - 全局并发上限（settings key `sftp_transfer_concurrency`，默认 2、上限 8）、暂停/恢复、优先级重排（High/Normal/Low，同级 FIFO）、取消；
  - 冲突检测：传输启动前检测目标存在（上传查远端 stat、下载查本地），命中置 Conflict 等待答复；`resolve_conflict` 支持 replace/skip/rename 与"应用到全部"（按批次记忆，批次无活跃项即回收，对位 Netcatty pruneTransferConflictDefaults）；
  - 自动重命名沿用 Netcatty getDuplicateTarget 规则：`file (copy).ext` / `file (copy N).ext`；
  - 进度复用既有 `sftp:progress:<transfer_id>`；新增事件 `sftp:transfer_updated:<id>`（单项状态）与 `sftp:queue_changed`（结构性快照）；
  - 9 个命令双注册（lib.rs generate_handler! + server.rs dispatcher，R4/INV-4）：sftp_transfer_enqueue/list/pause/resume/cancel/set_priority/set_concurrency/resolve_conflict/clear_finished；
  - schema v35 新表 `sftp_transfer_queue`；重启恢复未完成项（Running→Queued，Conflict/Paused 保持）。
- 新增 11 个 Rust 单测（优先级排序/并发调度/死会话不阻塞/重命名规则/冲突策略批次作用域/状态映射往返等）。

### 踩坑
- MutexGuard 经 Deref 借用整个 Inner，不支持跨字段分裂借用：持有 items 迭代器时再碰 pause_requested/conflict_policy 会 E0499/E0502——改索引访问或先 clone 再改。
- worker 是 'static tokio 任务，不能借用 AppState：pump 时把 sftp_sessions 快照进 Inner::handles，worker 侧只用快照；命令侧每次 pump 先刷新快照。
- 远端存在性探测依赖 russh_sftp 把 SSH_FX_NO_SUCH_FILE 文案（"no such file"）透传进 stat 错误串；阶段 C 的 129 live 需覆盖验证。
- 运行中项"暂停" = 取消 + 记 Paused（恢复时从头重传），流式不支持断点续传；pause_requested 在 pick 时清理，防 resume 后误判。
- 新 i18n code `sftp_transfer_not_found` / `sftp_transfer_state_invalid` 尚未进前端 sshErrors 字典，阶段 B 补。
- `tokio::fs::try_exists` 返回 io::Result<bool>，错误按不存在处理（unwrap_or(false)）。

### 门禁
- cargo check + --features server 通过（仅既有警告）；cargo test --lib 805 通过（+11）；npm run build 通过（仅既有 chunk>500kB 提示）。本轮未动前端。

---

## 2026-11-03 SFTP 传输队列与冲突对话框 · 阶段 B（前端队列面板）

### 修改点
1. **client.ts 队列封装**（R1，不裸 invoke/listen）：`TransferItem` / `NewTransferRequest`（嵌套字段保持 snake_case，R3）+ 9 命令封装（enqueue/list/pause/resume/cancel/setPriority/setConcurrency/resolveConflict/clearFinished）+ 2 事件封装 `onSftpTransferUpdated(id)`（`sftp:transfer_updated:<id>`）/ `onSftpQueueChanged`（`sftp:queue_changed`）。
2. **新增 `src/sftp/SftpQueuePanel.tsx`**（全局，挂于双栏下方 `.nc-sftp-area` 列容器）：对齐 Netcatty SftpTransferQueue 同名区域子集——队列列表（文件名/方向图标/大小/进度条/状态图标）、行内暂停/恢复/取消按钮、头部并发数设置（1-8，初值读 settings key `sftp_transfer_concurrency`，变更走 `sftp_transfer_set_concurrency`）、「清空已结束」按钮；空队列不渲染。事件模型：`queue_changed` 只覆盖结构性变化（入队/优先级/清空），状态迁移按 id 订阅 `transfer_updated:<id>` 逐条 patch；运行中项另订阅 `sftp:progress:<id>` 取字节进度，离开 running 即退订清残留；孤儿订阅随快照差集回收。
3. **与旧传输条整合**：`SftpPaneView` 上传/下载改走 `sftpTransferEnqueue`（多选上传 = 单批次，为阶段 C「应用到全部」铺垫），删除面板内 `nc-sftp-transfers` 传输条与 `Transfer` 状态（进度只在队列面板展示，避免两套重复）；上传项完成时经 `transfer_updated` 自动刷新本面板列表（终态退订）。旧样式 `.nc-sftp-transfer*` 删除，新增 `.nc-sftp-queue*`（~210 行）。
4. **纯逻辑 `src/domain/transferQueue.ts`**：展示排序（活跃组 running>conflict>paused>queued 内优先级降序 + seq 升序，终态组 seq 升序）、活跃/结束计数、暂停/恢复/取消按钮可用性、`formatBytes`（0=未知→空串，上限 TB）、`progressPercent`（不定长→null）+ 14 单测。
5. **i18n 补码（R5）**：`sftp_transfer_not_found` / `sftp_transfer_state_invalid` 进 sshErrors 字典；新增导出 `errorMessageFor(code, params)`（队列项 `error` 存裸 code 非信封），`userVisibleError` 复用之；+4 测试。
6. icons.tsx 补 `pause` 图标（lucide 风格）。

### 踩坑
1. **后端事件时序**：`queue_changed` 不在状态迁移时发（仅入队/优先级/清空），面板必须双订阅（全量快照 + 逐条 `transfer_updated:<id>`）；进度事件与状态事件分离，订阅集合分别按「在列」与「running」维护。
2. `formatBytes` 单位上限 TB：1PB 显示为 "1024 TB"（测试首版期望写错，修正为上限语义）。
3. SftpPaneView 的 `watchUploads` 不能用 `useCallback([])` 提前定义——会捕获声明前的 `load`（TDZ 虽运行期无碍但语义脏），改为 `load` 定义后的普通函数。
4. 恢复的 SftpView 上下文快照已过期（实现③后结构变化：picker props / EMPTY_SIDE 等），编辑前先重读实际文件，避免按旧快照盲改。

### 门禁
- npm run test:run **160/160** ✓（140 → 160：transferQueue 14 + sshErrors 4 + client 队列 3，其中 1 例为既有 describe 内新增）；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check --features server ✓（仅既有 3 条警告，本轮未改 Rust）；cargo test --lib **805✓**。

### 提交状态
- 按指令本轮不 push、不 review；阶段 C（冲突对话框 + 129 live + review/push）一并处理，届时随推 e0e83c1 + 1cf1bcc + 本轮。

## 2026-11-03 SFTP 传输队列与冲突对话框 · 阶段 C（冲突对话框 + apply-to-all 回溯 + 129 live + review）

### 修改点

后端（`sftp/transfer_center.rs`）：

1. **`resolve_conflict` 支持同批已冲突项回溯**：`apply_to_all` 时除策略按批次记忆（`conflict_policy`）外，快照同批已处 Conflict 的项逐项套用 `apply_conflict_action`（skip→Skipped；replace→Queued+overwrite；rename→`find_renamed_target` 探测 `file (copy)` 系可用名后 Queued）；阶段 3 锁内复检仍为 Conflict 才落状态（防探测期间被取消/已处理的竞态），逐项发 `transfer_updated`，末尾 pump；任一项探测失败则整批不落状态。

前端：

2. **新增 `src/sftp/SftpConflictDialog.tsx`**（对齐 Netcatty SftpConflictDialog 的文件冲突子集）：标题「{文件名} 已存在」；说明区分方向（上传=远端目标已存在同名文件 / 下载=本地目标，本地/远端双向都覆盖）；按钮顺序 跳过 | 创建副本 | 替换（Netcatty 右组顺序），替换恒为 danger-outline 危险样式（termX 无 merge，替换总是覆盖）；同批冲突 >1 显示「将此操作应用到剩余的 N 个冲突」；Esc / 点击遮罩 = 跳过；切换新冲突项重置勾选并聚焦替换。
3. **`SftpQueuePanel.tsx` 接线**：`pickActiveConflict`（展示序首个冲突项 + 同批计数，`domain/transferQueue.ts` +3 单测）挑出当前应弹框项；决议走 `api.sftpResolveConflict`，busy/error 局部态；错误经 `userVisibleError` 中文化（R5）。
4. **styles.css**：`.nc-sftp-conflict-*` 与 `button.danger-outline`。

### 129 live 验证（TERMX_SFTP_LIVE=1 门禁）

新增 `live_sftp_transfer_conflict`（commands/sftp.rs live_tests）：headless AppState（内存 DB + 空会话表，真实 handle 挂 `sftp_sessions["live"]`）走队列中心全链路。五场景全绿：(a) 无同名直接完成——证实 `remote_exists` 对「不存在」的错误文案判定在真实服务器上返回 false 不误判；(b) skip 远端内容不变；(c) rename 生成 `conflict (copy).txt` 且路径回写、原文件保留；(d) replace 覆盖；(e) 并发 8 批量入队 2 项双双 Conflict，解首个 replace+applyToAll 回溯套用双双完成。凭据取自 ~/.rssh DB + SecretStore（与应用同路径），密码不落明文；测试后清理远端与本地临时文件。对照组：未设门禁同用例 0.00s 早退 vs 门禁组 1.26s 真实执行。

### 自审 review 结论

- **状态机 ↔ UI 一致性**：canPause/canResume/canCancel 与后端 pause/resume/cancel 合法状态一一对应；对话框挑展示序首个冲突项。无问题。
- **事件泄漏**：对话框 window keydown 有 cleanup；队列面板 transfer_updated/progress 订阅按 id 回收（快照差集 + running 退出退订 + 卸载全释放）。无问题。
- **批量决策边界**：回溯套用锁内复检 Conflict 才落状态；rename 探测失败整批不落状态（策略已记录，重试自动套用，符合用户意图，记低危）。
- **并发上限与恢复语义**：pump 检查 running>=concurrency，finish 递减后 pump_cached 续跑；重启恢复 Running→Queued、Conflict/Paused 保持。无问题。
- **命令双注册**：本轮无新命令；`sftp_transfer_resolve_conflict` 确认 lib.rs generate_handler 与 server.rs dispatcher 均在。
- **i18n**：`sftp_session_not_found` / `sftp_transfer_not_found` / `sftp_transfer_state_invalid` 均已有中文映射；对话框与面板错误全走 sshErrors。无问题。
- **结论**：无高危/中危；低危 2 记录（rename 探测失败时策略已先记，语义可接受；对话框无文件大小/时间对比，为对 Netcatty 的简化，组件注释已注明）。live 覆盖上传方向（下载冲突 = 本地 fs try_exists，由纯逻辑单测覆盖）；视觉比对留人工/新 CU。

### 门禁

- npm run test:run **163/163** ✓（160 → 163：pickActiveConflict 3 例）；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check --features server ✓（仅既有 3 警告）；cargo test --lib **806✓**（805 + live 用例门禁外空跑）；129 live ✓。

### 提交状态

- 本轮随推 e0e83c1（docs）+ 1cf1bcc（阶段 A）+ e9b2917（阶段 B）+ 本轮；P0 #10 三阶段全部完成。

---

## 2026-11-03 · 编辑器与监视回写（P0 #8）阶段 A：内置编辑器（本地/远端打开编辑 + 保存回写）

### 调研结论（Netcatty 基准）

- 入口：右键「编辑」（仅非目录且非已知二进制扩展名，`SftpPaneFileList.tsx` L344）+ 双击打开（opener=builtin-editor 时进内置编辑器）。
- 组件：Netcatty 用 Monaco（`@monaco-editor/react` + 语言映射）；termX 阶段 A 按约定用低依赖 textarea，语法高亮留后续。
- 阈值：`MAX_BUILTIN_SFTP_EDITOR_BYTES = 10 MiB`（`sftpEditorFileLimits.ts`），超限拒绝而非截断；二进制判定为前端扩展名清单（无字节采样）。
- 保存：`writeTextFile(side, fullPath, content)` 整体覆盖，保存前校验 hostId 未变（防写错主机）；Netcatty 无另存为，termX 按需求新增。
- 编码：`lib/readTextFile.ts` BOM 探测（UTF-8/UTF-16LE/BE）→ 无 BOM 时 UTF-8 严格解码失败回退 gb18030。
- 外部编辑器（downloadToTempAndOpen / openPath）与文件监视（startFileWatch）→ 阶段 B。

### 修改点

- 后端：`commands/sftp.rs` 新增 `sftp_read_file`（stat 预检 + 读后兜底双检 10 MiB，`DEFAULT_EDITOR_READ_CAP`；全文读而非 `local_read_file` 的尾部读）与 `sftp_write_file`（整体覆盖）；`editor_size_guard` 纯函数（pub，server dispatcher 复用）。lib.rs + server.rs 双注册（camelCase：sftpId/path/maxBytes/data）。
- 前端：`src/editor/editorFile.ts` 纯逻辑（10 MiB 断言、二进制扩展名清单、头部 8KiB NUL 采样、BOM/UTF-8/gb18030 解码、UTF-8 编码）；`src/editor/EditorDialog.tsx` 编辑器视图（加载/错误条/脏标记 ●/保存/Ctrl+S/另存为=路径输入弹窗/关闭前三按钮未保存确认：保存并关闭|不保存|取消）；`SftpPaneView` 右键「编辑」+ 双击文件打开，本地/远端双向（本地先 `localStat` 尺寸断言再 `localReadFile`，≤10 MiB 必然全文）。
- client.ts：`sftpReadFile` / `sftpWriteFile` 封装（R1）。
- i18n：`sftp_file_too_large` 文案升级为带 size/limit（新增 `num`/`fmtBytes` 辅助，缺参回退原文案）。
- 样式：`styles.css` 追加 `.nc-editor-*`（全屏遮罩 + 等宽 textarea，沿用既有 HSL token）。

### 踩坑

- `local_read_file` 缺省读**尾部** 16 MiB（预览语义），编辑器要全文：故本地侧先 `localStat` 断言 ≤10 MiB 再读（此时必全文）；远端新命令直接全文 + 尺寸预检，不复用无上限的 `sftp_download`。
- server.rs dispatcher 的 `ok()` 收 `AppResult<T>`，裸值要 `ok(Ok(data))`。
- `AppError` 无 params 访问器，单测只断言 `code()`。
- 测试用例笔误：`/etc/nginx/Conf` 本无扩展名（期望写错），改 `nginx.Conf`。

### 门禁

- npm run test:run **179/179** ✓（163 → 179：editorFile 16 例）；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check --features server ✓（仅既有 3 警告）；cargo test --lib **809✓**（806 + editor_size_guard 3 例）。

### 提交状态

- 本地 commit 未推送（阶段 B 一起 review + push）。

---

## 2026-11-03 · 编辑器与监视回写（P0 #8）阶段 B：文件监视回写 + 外部编辑器打开 + 129 live 收官

### 修改点

- 文件监视回写（`EditorDialog`，对齐 Netcatty startFileWatch 语义的 termX 子集）：加载/保存/另存成功后刷新基准 stat 快照；本地 1.5s 轮询 `localStat`、远端 3s 轮询 `sftpStat`（mtime/size）；纯比较 `statChanged`（editorFile.ts，size 必比、mtime 双方可用才比，+4 单测）；自身写入期间 `writingRef` 抑制比对 + 保存后立即刷新基准，防自写回环；检出外部修改弹「文件已在磁盘/远端被修改，是否重新加载」（重新加载 / 忽略=以当前 stat 为新基准）；定时器随目标/状态重建、卸载即清理，无句柄泄漏。
- 外部编辑器打开：`local_open_path`（系统默认程序：Windows `cmd /C start`、macOS `open`、Linux `xdg-open`）+ `sftp_open_external`（下载到 `%TEMP%/termX-external/<毫秒戳>-<净化名>` 后系统打开，返回临时路径；100 MiB `EXTERNAL_OPEN_CAP` stat 预检 + 下载后兜底）；`SftpPaneView` 右键「外部打开」（本地/远端文件），`externalTemps` ref 记录远端路径→临时路径并显示提示（编辑后手动上传覆盖，回传自动化留后续）。lib.rs + server.rs 双注册（camelCase：sftpId/path）。
- client.ts：`localOpenPath` / `sftpOpenExternal` 封装（R1）。

### 高危缺陷：129 live 揪出 upload 不截断（已修复）

- `SftpHandle::upload` 原用 russh-sftp `SftpSession::write`（仅 `OpenFlags::WRITE` 打开）：文件不存在报 No such file；**收缩内容时旧尾部残留**——live 实测 50 字节覆盖 8 字节后再读为 50 字节混合内容（编辑器保存即损坏文件）。改用 `create`（CREATE|TRUNCATE|WRITE）+ `write_all`，整体覆盖与本地写一致；顺带修复 `sftp_upload` 新建文件报错问题。

### 129 live（TERMX_SFTP_LIVE=1，profile 129；凭据走 ~/.rssh DB + SecretStore，密码不落明文）

- 新增 `live_sftp_editor_read_write_guards` 通过：种已有文件 → stat 预检 + 全文读一致且不判二进制 → 回写更短内容 → 再读完全一致（含截断语义）→ 超限拒绝（真实尺寸触发 guard，错误码 `sftp_file_too_large`）→ 含 NUL 文件采样判二进制（编辑器入口拒绝）；测后清理远端临时目录。

### review 自审

- 无遗留高/中危：hostId 校验（get_sftp → sftp_session_not_found，保存只用本面板会话）；路径穿越无新增面（临时文件名净化 `/\:*?"<>|`）；大文件双守卫（编辑 10 MiB / 外部打开 100 MiB）；未保存关闭三按钮确认；监视器卸载清理；命令双注册一致；i18n 复用 `local_io_failed` / `sftp_file_too_large` 既有映射。低危记录：卸载后 in-flight 轮询回调 setState 为无害空操作；`externalTemps` 仅记录供提示，自动回传留后续。

### 门禁

- npm run test:run **183/183** ✓（179 → 183：statChanged 4 例）；npm run build ✓（仅既有 chunk 提示）；cargo check --features server ✓（仅既有 3 警告）；cargo test --lib **813✓**（809 + looks_binary 3 + live 1）；129 live ✓。

### 提交状态

- 随推 d4b0886（阶段 A）+ 本轮阶段 B；远端 main 以 ls-remote 复核。

---

## 2026-11-03 · SFTP 拖放与面包屑/工具条（P0 #9）阶段 A：工具栏 + 面包屑 + 排序 + 隐藏开关

### 调研（Netcatty 基准，行为对齐不复制代码）

- 工具栏为两行布局（`SftpPaneToolbar`）：路径行（面包屑）+ 动作行；按钮全集含 bookmark/终端联动/copyPath/viewMode/listDensity/filter/encoding/newFolder/newFile/showHidden/refresh——termX 阶段 A 取已具备后端支撑的子集（copyPath/newFolder/showHidden/refresh），其余（书签/视图切换/密度/过滤/编码/新建文件）随后续阶段，避免假按钮（Pr3）。
- 面包屑（`SftpBreadcrumb` + `state/sftp/utils.ts`）：Home + 根按钮（atRoot 禁用）+ 可点路径段；`maxVisibleParts=4` 截断（首段恒显 + 尾部 budget-1 段，中间进省略号下拉）；纯 `//host/share` 默认按 POSIX（正斜杠是合法 POSIX 文件名字符，不能默认当 UNC）。
- 排序/隐藏（`components/sftp/utils.ts`）：`sortSftpEntries` 目录恒置顶（降序只反转字段比较）、名称 localeCompare / 大小 / 时间数值比较；`filterHiddenFiles`：Windows hidden 属性或点前缀，".." 永不隐藏。
- 交互：单击仅选中，双击 / 回车进入目录（替换骨架期「单击进目录」）。

### 修改点

- `src/sftp/sftpModel.ts` 纯逻辑（+19 单测，全部可直接 Vitest 断言）：`isWindowsLikePath`（盘符/反斜杠 UNC；`//x` 按 POSIX）、`pathRoot`（"/" / "C:\" / UNC 共享根 / 相对路径 null）、`isPathRoot`、`breadcrumbSegments`（POSIX 前缀累积 / 盘符首段 "C:"→"C:\" / UNC 根合并单段）、`normalizeBreadcrumbBudget` + `resolveBreadcrumbVisibleParts`（截断保留原始下标）、`sortSftpRows`（目录恒置顶泛型比较器）、`isHiddenEntry` / `filterHiddenEntries`（showHidden 原样返回不拷贝）、`formatEntrySize`（0→"--"，Bytes 无小数其余两位）、`formatEntryMtime`（0/无效→"--"）。
- `src/sftp/SftpPaneView.tsx`：头部改为标签行 + 面包屑行 + 动作行 + 列头四段；面包屑行 = 回主目录（`localHome`/`sftpHome`）+ 回根按钮（atRoot 禁用）+ 路径段（末段加粗，超 4 段出省略号 → 复用 SftpContextMenu 展开折叠段）；动作行 = 复制路径（navigator.clipboard，成功提示走 notice）/ 新建文件夹（复用既有对话框）/ 显示隐藏开关（Eye/EyeOff 切换，active 态）/ 刷新；列头（名称/大小/修改时间）点选排序，同字段切方向、换字段回升序；`Row` 扩展 size/mtime/hidden，load 不再预过滤隐藏（改渲染期 `filterHiddenEntries` + `sortSftpRows` memo 管线，开关/排序零重载）；单击选中、双击/回车激活（目录进入，文件开编辑器，".." 回上级），导航清空选中。
- `src/ui/icons.tsx`：补 home / arrow-up / arrow-down（lucide 路径，ISC）。
- `src/styles.css`：`.nc-sftp-toolbar*`（28px 双行、22px 图标按钮、active/disabled 态）、`.nc-sftp-breadcrumb*`（段按钮 max-width 160 截断、current 加粗、分隔符 40% 透明）、`.nc-sftp-cols/.nc-sftp-col`（与行同网格模板 `minmax(0,1fr) 88px 128px`）、行改 grid + 数值列右对齐 muted；删除孤儿 `.nc-sftp-pane-path/.nc-sftp-pane-refresh`。
- 纯前端改动，无新后端命令（排序/隐藏/剪贴板/面包屑全在前端，复用既有 `localHome`/`sftpHome`/`localListDir`/`sftpList` 封装）。

### 踩坑

- 排序测试期望初稿漏了「目录恒置顶优先于字段序」：`size desc` / `modified asc` 的目录组内顺序要单独推（降序反转组内比较，稳定排序保持并列序）。
- 空目录提示判定从 `rows.length` 改 `visibleRows.length`：否则隐藏开关关闭且目录只剩隐藏文件时误显「..」+ 无行。

### 门禁

- npm run test:run **202/202** ✓（183 → 202：sftpModel +19）；npm run build ✓（仅既有 chunk>500kB 提示）；cargo check --features server ✓（仅既有 3 警告）；cargo test --lib **813✓**。

### 提交状态

- 本地 commit，未推送（阶段 B：跨栏拖放含拖到桌面 + 入队联动 + 129 live + review + push）。

---

## 2026-11-03 · SFTP 拖放与面包屑/工具条（P0 #9）阶段 B：跨栏拖放入队 + 拖出决策不做 + 收官推送

### 修改点

- `src/sftp/sftpModel.ts`（+7 单测）：`SFTP_DRAG_MIME`（application/x-termx-sftp）+ `sftpDragSideMime` 侧标记（dragover 阶段仅 types 可读，目标栏据此拒绝同侧）；`parseSftpDragPayload` 载荷全校验（拒绝坏 JSON / 未知 side / 空 names / `.`/`..` / 含路径分隔符的名 / 远端缺 sftpId / 空 fromPath）；`dropTargetPath` 落点语义（目录行 = 进该目录；文件行 / 空白 / ".." = 当前路径，对齐 Netcatty）；`buildDropTransferTasks`（remote→local = 下载批次，sftp_id 取来源会话；local→remote = 上传批次，sftp_id 取落点栏会话；同侧或缺会话 → null 不入队）。
- `src/sftp/SftpPaneView.tsx`：文件行 draggable（目录不可拖——传输队列仅支持单文件）+ dragstart 写载荷与侧标记；列表容器单组 onDragOver/onDragLeave/onDrop：跨栏拖拽 preventDefault + 高亮（容器 drop-active / 目录行 drop-target），同侧或 OS 拖拽不接受（系统 no-drop = 取消）；drop → 解析 → 落点 → 既有 `sftp_transfer_enqueue` 入队（冲突策略沿用阶段 C，单批次作用域）→ watchUploads 上传完成自动刷新。
- `src/styles.css`：`.nc-sftp-pane-list.drop-active`（虚线 outline）/ `.nc-sftp-pane-row.drop-target`（accent 高亮）。
- 纯前端改动，无新后端命令（R4 未触发）；容器级单 drop 处理器，行事件冒泡只处理一次，无重复入队。

### 拖出到桌面 / 资源管理器（CF_HDROP）：决策不做，记后续候选

- ① HTML5/WebView2 网页内容无法发起携带真实文件（CF_HDROP）的 OS 拖放（浏览器安全模型）；② Tauri v2 无 Electron `startDrag` 等价 API；③ Netcatty 靠 Electron 主进程原生桥 `startLocalFileDrag/cancelLocalFileDrag`，termX 需从零写 Win32 OLE DoDragDrop + IDataObject/IDropSource，且须与手势同帧耦合——经 IPC 异步命令接管 WebView2 已占用的 OLE 拖放循环不可靠；④ 项目 Cargo.toml 无 windows crate，需新增重依赖；⑤ 远端项还需先下载到临时目录。按「不强造不稳定的假功能」原则明确不做，记为后续候选（原生桥 spike）。

### 验证

- 129 live 等价验证（本轮零 Rust 改动，drop 复用既有队列后端）：`TERMX_SFTP_LIVE=1 cargo test --lib sftp` → **27✓**，其中 `live_sftp_file_ops_roundtrip`（远端→本地 / 本地→远端文件系统级往返）+ `live_sftp_transfer_conflict`（冲突策略）即拖放两条链路的后端路径。
- review 自审四项无高/中危：拖放事件全走 React props（随卸载移除，无泄漏）；载荷全校验、名字拒绝分隔符，无路径穿越面；容器级单 drop 处理器 + 既有队列入队，无重复入队；落点语义有单测覆盖（目录行 / 文件行 / 空白 / ".." / 本地盘符）。

### 门禁

- npm run test:run **209/209** ✓（202 → 209：拖放 +7）；npm run build ✓；cargo check --features server ✓（仅既有警告）；cargo test --lib **813✓**。

### 提交状态

- 随阶段 A（ca0afe0）一并推送（远端基线 b92b94e，快进），P0 #9 收官；下一起点 = 串口（端口列表 / 参数 / 连接 / 数据收发对齐 Netcatty，含 mark/space、1.5 停止位、自动登录、字符集等已知缺口）。

---

## 2026-11-03 · 串口对齐 Netcatty（P1 #35）：mark/space、1.5 停止位、字符集、自动登录、富端口列表

### 修改点

- 后端 `terminal/serial.rs`：校验位补 mark/space（crate 无对应项——Windows 走原生 DCB 位域、Linux 走 termios CMSPAR、macOS 打开前拒绝）；停止位补 1.5（仅 Windows 原生 DCB，其余平台打开前报错）；字符集（encoding_rs：空标签 = 字节透传，未知标签打开前报错不静默降级，不可映射字符统一 `?` 替代）；`SerialConfig` 新增 charset/username/password（自动登录凭据仅会话级，不落库）。
- 后端新增 `terminal/serial_auto_login.rs`：提示词状态机（无定时器，读循环 100ms tick 驱动；`login:`/`Password:` 等提示识别 → 发凭据；超时/完成/取消三态上报 `serial:auto_login:<id>`）。
- Windows 原生 DCB 路径 `open_native_dcb`：CreateFile + DCB 位域镜像（fBinary/fParity/fOutxCtsFlow/fDtrControl/fOutX/fInX/fRtsControl，XonChar=17/XoffChar=19）+ COMMTIMEOUTS 镜像 crate 行为；硬件流控 RTS 用 Enable（与 serialport 4.9.0 dcb.rs L278-283 逐行核对一致）；IXANY 在 Windows 文档化 no-op。
- 富端口列表：`PortInfo{port_name, port_type, manufacturer, product, vid, pid}`（serialport crate 的 `UsbPort(UsbPortInfo)` 元组变体解构），`serial_list_ports` 返回结构化列表。
- 命令双注册：`serial_list_ports` 等在 lib.rs 与 server.rs 同步注册；`db/serial_profile.rs` / `models.rs` / `sync/config.rs` / `commands/sync.rs` 同步扩展配置形状（parity/stop_bits f64/flow_control/charset，DB 数值亲和）。
- 前端 `SerialPanel.tsx`：端口下拉（富信息展示 + 刷新）、12 档波特率 + 自定义、数据位 5-8、停止位 1/1.5/2（1.5 平台与数据位约束提示）、校验位 none/even/odd/mark/space、流控 none/software/hardware、字符集下拉（含 GBK/UTF-8 等）、自动登录用户名/密码输入、发送/DTR 控制；`src/domain/serialValidate.ts` 纯校验逻辑（+6 单测）；`client.ts` 封装 serial 命令与事件。

### 实机比对（新流程：build-debug 启动 + 对照本机 Netcatty）

- **一致项（截图/实开确认）**：串口面板渲染与 Netcatty 串口弹窗控件集逐项对齐（端口列表/波特率/数据位/停止位/校验位含 mark+space/流控/字符集）；本机 COM1 自动列出；COM1 真开双路径均成功（mark 校验位 + 1 停止位走原生 DCB、8N1 走 crate 路径）；发送、DTR 切换、关闭均无错；1.5 停止位与命名管道拒绝提示文案渲染正确。
- **已修项**：① 实测 8 数据位 + 1.5 停止位开 COM1 报 os error 87（ERROR_INVALID_PARAMETER）——定性为 UART/OS 约束（1.5 仅与 5 数据位组合有效），Netcatty 经 node-serialport 直传同样被拒，非代码 bug；1.5 提示文案补「通常仅与 5 数据位组合有效」并重编复检渲染。② 3 个新单测首跑失败修复：encoding_rs 对不可映射字符输出 NCR（`&#128512;`）且置 had_errors → truncate NCR 再补 `?`（原实现双重替代）；`last_prompt_line` 尾换行后取空串漏掉提示 → trim_end 后取最后非空行；timeout=0 时首个 feed 即过期凭据从未发出 → `expired()` 改 `>=` 使 0 确定性立即过期 + cfg(test) `force_expire()` 钩子。③ 2 条新 cargo 警告清理（xany 显式消费、feature_unsupported 加 cfg 门），复检回仅既有 3 警告。
- **不可对齐或留档项**：① 8+1.5 组合两侧同被 OS 拒（硬件约束，文案已对齐说明）；② 命名管道（`\\.\pipe\`）：Netcatty 经 serialNamedPipe 桥支持，termX 明确拒绝并提示——留档后续候选，不强造；③ 自动登录：Netcatty 按已存主机持久化，termX 会话级不落库（有意差异，凭据不落明文）；④ localEcho/lineMode/backspaceBehavior/存为主机复选框留后续阶段；⑤ Netcatty 串口弹窗 CU 无法打开（新建主机抽屉遮挡工具栏且关不掉），转源码级核对，弹窗逐屏对照列入人工点测。

### review 自审

- 无高/中危：unsafe 句柄单所有权（Guard/forget 路径全错误分支关闭句柄）；读线程与 write() 锁序一致（detector→释放→writer），毒锁走 `locked()`；编码边界单测守护（透传/GBK/不可映射）；stop_bits f64 DB 数值亲和；事件按会话 id 退订；命令双注册一致；RTS Enable 与 crate 源码逐行核对。

### 门禁

- npm run test:run **215/215** ✓（209 → 215：serialValidate +6）；npm run build ✓；cargo check --features server ✓（仅既有 3 警告）；cargo test --lib **830✓**（813 → 830：serial 模块 21 例含自动登录/编码/映射）；tauri debug 重编 ×2 启动实开 COM1 验证。

### 踩坑

- encoding_rs 编码器对不可映射字符**输出 NCR 并置 had_errors=true**（不是静默丢弃），整块编码只能得知「块内有错」，替代符位置漂到块尾 → 逐字符编码 + `truncate(before)` 才能精确 `?` 替代。
- Windows UART：1.5 停止位仅与 5 数据位组合有效，其余组合 SetCommState 报 os error 87；Netcatty 同被拒（node-serialport 直传），属 OS/硬件约束不是实现 bug。
- serialport crate `SerialPortInfo` 仅 port_name+port_type，USB 元数据在 `SerialPortType::UsbPort(UsbPortInfo)` 元组变体里，需解构取 manufacturer/product/vid/pid。
- `COMPort::from_raw_handle` 不设 COMMTIMEOUTS，原生路径必须自设（镜像 crate 的 {MAX,MAX,100,0,100}），否则读行为不可预期。
- 状态机测试确定性：`expired()` 用 `>=` 让 timeout=0 立即过期，避免测试依赖真实时间流逝。
- PowerShell `Measure-Object -Line` 对 changelogs.md 少报行数（报 2223 实际 2700+），定位文件尾部以 Grep/Read 递进为准。

### 提交状态

- 本地 commit，推送远端基线 c1a4604（快进），P1 #35 收官。

---

## 2026-11-03 钥匙串阶段 A：~/.ssh 系统密钥管理（生成/导入/列表/设默认/复制公钥/删除）

### 背景与范围

- 用户流程清单「钥匙串」拆两轮：本轮阶段 A = 后端密钥管理命令 + 前端 `src/keychain/` 页挂 Vault 导航「钥匙串」；阶段 B（下一轮）= SSH agent 状态与转发配置接线 UI 收尾、129 实机验证、review + push。
- 调研结论（Netcatty `components/keychain/` + 实机截图 pid=7900）：Netcatty 钥匙串页 = 新建密钥/导入证书/新建身份工具条 + 密钥列表区 + 空态「设置密钥：导入或生成」引导；**该页无「设为默认」入口、无 SSH agent 状态展示**（agent 在 代理/端口转发 页）。termX 缺口 = ~/.ssh 文件密钥管理命令与页面（此前仅有凭据式「已存密钥」keysPanel）。
- 落地形态：钥匙串页新增「系统密钥」子标签（新 KeychainView），旧 keysPanel 保留在「已存密钥」子标签（tsconfig `noUnusedLocals` 约束 + 保留既有凭据流程不回归）。

### 修改点

- 后端 [keychain.rs](src-tauri/src/commands/keychain.rs) 新增文件密钥段：`SshFileKeyEntry`（name/path/key_type/fingerprint/public_key/encrypted/is_default，**无私钥字段**）；六件套 impl + `#[tauri::command]`：`keychain_list_file_keys` / `keychain_generate_file_key` / `keychain_import_file_key` / `keychain_delete_file_key` / `keychain_set_default_key` / `keychain_get_default_key`。生成支持 ED25519 / ECDSA(P-256/384/521) / RSA(4096/2048) + 可选 passphrase；同名拒绝覆盖、.pub 写失败回滚私钥；删除默认密钥同步清 settings。
- 默认密钥存 settings KV `ssh_default_key`（`crate::db::settings`），缺省回落 `id_ed25519`（FALLBACK_DEFAULT_KEY）；[ConnectionManager.tsx](src/ConnectionManager.tsx) fillDefaultKey 改为经 `keychainGetDefaultKey` 取名再读文件，与钥匙串「设为默认」单一事实来源。
- 路径安全：复用 [profile.rs](src-tauri/src/commands/profile.rs) `is_plain_file_name`（改 `pub(crate)`，单一事实来源），拒绝 `/ \ ..` 与控制字符；私钥 0600 / 公钥 0644（unix cfg；Windows 无 chmod，留档）。私钥内容绝不返回前端、keychain.rs 无任何日志语句（grep 验证）。
- 双注册（R4）：lib.rs `generate_handler!` 8 个 keychain 命令 + server.rs dispatcher 全臂同名直调 impl（INV-4）。
- 前端：`src/keychain/KeychainView.tsx` + `keychain.css`（列表 + 生成对话框 + 导入对话框 + 设为默认 + 复制公钥 + 删除 confirm）；`src/domain/keychainModel.ts` 纯逻辑（算法/位宽/曲线选项、密钥名校验镜像后端、类型标签）+ 4 单测；client.ts 6 封装；VaultView 双子标签接线。
- sshErrors.ts 补 5 个钥匙串错误码中文映射（invalid_key_name / key_file_exists / key_write_failed / key_file_not_found / home_dir_unavailable）+ 单测（R5/R11）。

### 门禁

- `npm run test:run` 220✓（215 → +4 keychainModel → +1 sshErrors）；`npm run build` ✓；`cargo check --features server` ✓；`cargo test --lib` 835✓（+5 文件密钥测试）。
- debug 构建 ✓（rssh.exe / msi / nsis），实机启动 pid=12352 稳定运行。

### 比对结论（对照 Netcatty，三类）

- **一致项（截图确认）**：钥匙串导航入口与页面渲染；真实密钥枚举（id_ed25519：Ed25519 · SHA256:DfQnAs9… · ~/.ssh/id_ed25519 · 默认 badge）；生成对话框（密钥名/算法 combo/位宽·曲线/passphrase/取消/生成并保存）；导入对话框；复制公钥/删除/设为默认入口；Netcatty 钥匙串主视图（新建密钥/导入证书/新建身份 + 空态导入/生成引导）与 termX「列表 + 生成 + 导入」主流程结构一致。
- **已修项**：① ssh-key 0.7.0-rc.11 API 三处适配（`from_openssh` 对加密密钥返回 Ok → 用 `is_encrypted()` 判定；`to_openssh` 返回 `Zeroizing<String>` → `.to_string()`；`fingerprint()` 返回 Fingerprint 枚举非 Result → `.to_string()`）；② 测试断言修正：加密私钥无 .pub 仍可解析类型/指纹/公钥（OpenSSH v1 公钥部分明文存放），测试更名 `..._still_resolves_metadata` 并同步三处注释；③ review 自审修复：生成对话框密钥名不再预填缺省名（本机已存在 id_ed25519，预填会让「生成并保存」直接撞 key_file_exists），改留空 + placeholder 引导；④ 5 个新错误码补前端中文映射（此前回退泛化「操作失败，请重试。」）。
- **待人工/不可对齐项**：① Netcatty 无「设为默认」UI，系 termX 新增（接线 ConnectionManager 默认密钥读取），无对照对象；② SSH agent 状态展示在 Netcatty 代理/端口转发页，属阶段 B；③ Windows 平台无 chmod，私钥文件权限仅 unix 生效（留档）；④ Netcatty 窗口观察树疑似混入 termX 窗口节点（get_app_state 跨窗口污染），子标签对齐以截图为准；⑤ debug 实例经 `Start-Process -PassThru` 启动数秒即退、前台直跑稳定（原因未定性，留档）；⑥ review 修复项（预填/错误码映射）为代码级修复，在跑 debug 包为修复前前端，对话框空名与新错误文案待人工点测确认。

### 踩坑经验

- ssh-key 0.7：`Error::KeyIsEncrypted` 仅存在于 russh::keys `decode_secret_key` 路径；`ssh_key::PrivateKey::from_openssh` 对加密密钥保持加密态返回 Ok；fingerprint 的 Display 自带 `SHA256:` 前缀。
- CU：`list_apps` 输出为文本 `Name.exe [pid=N, app_id=…]` 非 JSON（按 JSON 正则解析会 NOT_FOUND）；元素 ID 跨观察即失效，必须同一 Exec 内先 `disableDiff:true` 全量观察再动作；button 走 perform_action Invoke 可靠。
- PowerShell `Select-Object -First N` 截断管道致 cargo exit -1，改用 `-Last`。

### 提交状态

- 本地 commit，**本轮不 push**（阶段 B 一起推）。

## 2026-11-03 钥匙串阶段 B：SSH agent 状态展示 + 主机档案「转发 Agent」开关 + 129 实机验证 + push

### 背景与范围

- 阶段 B 收尾：钥匙串页 agent 状态卡、主机档案「转发 Agent」开关（新建表单 + 主机详情抽屉双入口）、129 实机验证、review 自审、门禁、push（含阶段 A fc5e93e 一起快进推送）。
- Netcatty 对照：agent 状态展示（running/startupType/error）在其代理页 `SshAgentStatus`，agentForwarding 开关在主机详情高级区 `HostDetailsAdvancedSections`；termX 落位：状态卡挂钥匙串页顶部、开关挂主机档案 SSH 区（抽屉与表单同步），语义对齐、位置按 termX 信息架构就近放置。

### 修改点

- 后端新命令 `ssh_agent_status`（R4 双注册：lib.rs `generate_handler!` + server.rs dispatcher 直调 impl）：返回 `{running, kind, path, identity_count, error}`；Windows 先探 OpenSSH named pipe `\\.\pipe\openssh-ssh-agent` 再 Pageant，unix 走 `$SSH_AUTH_SOCK`；**running 以 `request_identities()` 成功为准**（修 pageant crate 懒连接假阳性：connect Ok ≠ agent 可用，失败返回 running=false + error）。
- Profile 新字段 `agent_forwarding`（schema v36 迁移，`column_exists` 幂等守卫，默认 false 安全敏感关）；[profile.rs](src-tauri/src/db/profile.rs) row_to_profile/insert/update 全链路接线；SFTP 后台连接、CLI 与测试字面量一律 false。
- 转发实现 [client.rs](src-tauri/src/ssh/client.rs)：connect() 在 channel_open_session 后、request_pty/shell **之前**发 `auth-agent-req@openssh.com`（want_reply=false，同 OpenSSH -A；sshd 在 shell 拉起时才建监听，顺序必须在前）；Handler 实现 `server_channel_open_agent_forward`：档案未开启 → reject(AdministrativelyProhibited)；本机 agent 不可达 → reject(ConnectFailed) 而非 accept 挂起；可达则 accept 并用 `Channel::into_stream()` + `tokio::io::copy_bidirectional` 泵双向字节（russh 默认只 accept 不泵数据）；逐跳按各自档案 flag 独立判定。
- 前端：KeychainView 顶部「SSH Agent」状态卡（状态点/运行徽标/kind·path/已加载身份 N/刷新，首挂载拉取）；ConnectionManager 新建表单与 VaultView 主机详情抽屉「转发 Agent」开关（host-switch 同款），开启且探测 running=false 时警告「未检测到运行中的 SSH Agent，转发将不可用」；client.ts `sshAgentStatus()` 封装 + `src/domain/sshAgentStatus.ts` 纯逻辑 + 7 单测。

### 门禁

- `npm run test:run` 227✓（220 → +7 sshAgentStatus）；`npm run build` ✓；`cargo check --features server` ✓；`cargo test --lib` 836✓（+1 migration_36_adds_profile_agent_forwarding）。
- debug 构建 ✓，前台直跑 pid=22960 稳定（Start-Process 数秒即退怪象沿用阶段 A 留档）。

### 129 实机验证

- 档案 129 开启「转发 Agent」保存后连接成功（会话 c76959bf），仅密码认证正常，连接日志含 Agent forwarding requested。
- 远端 `echo SOCK=[$SSH_AUTH_SOCK]; ssh-add -l` → `SOCK=[]` + `The agent has no identities.`（RC=1）；追加探测：`ls -d /tmp/ssh-*` 无输出（sshd 未建转发监听）、`/etc/ssh/sshd_config` 仅 `#AllowAgentForwarding yes`（注释=默认允许）。
- 定性：客户端线格式（russh `CHANNEL_REQUEST auth-agent-req@openssh.com`，源码核对 session.rs）与请求顺序正确、本机桥接实现正确；**sshd 静默未建转发监听**，失败点在服务端（可能存在无 sudo 不可读的配置覆盖或非 OpenSSH sshd），转人工排查；本机 ssh-agent 服务 Stopped+Disabled、Start-Service 需管理员（Access denied）→ 正向身份场景转人工点测。

### 比对结论（三类）

- **一致项（截图确认）**：钥匙串页 agent 状态卡（未运行态：状态点灰 + 「Agent 无响应：early eof」+ kind·path）；主机详情抽屉「转发 Agent」开关与关闭态警告文案；开关保存后重连生效。
- **已修项**：① pageant 懒连接假阳性（状态卡曾误报「运行中/已加载身份 0」，机器上并无 Pageant → 改为 request_identities 成功才判运行，复测显示「未运行 + 错误原因」）；② 主机详情抽屉缺开关（初版只加进 ConnectionManager 新建表单，主编辑面是 VaultView 抽屉 → 补开关 + 打开即探测 + 保存接线）。
- **待人工项**：① 129 服务端排查：`sudo sshd -T | grep -i forwarding` 与 auth.log 确认 sshd 为何静默拒绝 auth-agent-req；② 正向身份验证：管理员启动 ssh-agent 服务并 `ssh-add` 加载密钥（含 passphrase 场景）后重连 129，远端 `ssh-add -l` 应列出身份、`$SSH_AUTH_SOCK` 应有值；③ Pageant 传输（namedpipes/wmmessage）不可泵，Pageant 用户转发不可用（留档）；④ 状态卡刷新按钮与抽屉打开即探测的时序点测。

### review 自审

- 私钥不外泄：status 命令仅返回 running/kind/path/identity_count/error，无任何密钥材料；转发桥只泵字节不解析身份；keychain.rs 无日志语句（阶段 A 结论延续）。
- 转发安全边界：档案未开启一律 reject；本机 agent 不可达 reject 而非 accept 挂起；逐跳独立判定；SFTP 后台连接强制关闭转发。
- 错误码 i18n：本轮无新错误码（status 失败走通用信封），sshErrors.ts 无需新增映射。
- 命令双注册：`ssh_agent_status` lib.rs + server.rs 两臂齐（R4/INV-4）。
- UI 与后端能力一致：开关 ↔ profile.agent_forwarding ↔ connect() 请求三点一线；状态卡 ↔ ssh_agent_status 真实探测，无假开关。

### 踩坑经验

- russh 0.62 agent API：方法名 `request_identities()`（无 list_identities）；`server_channel_open_agent_forward` 默认只 accept，应用必须自行泵数据。
- pageant 0.2 懒连接：connect() 成功仅表示传输可构造；状态判定必须以 request_identities 结果为准。
- sshd 转发监听在 shell 拉起（do_child）时创建 → 请求必须早于 request_shell；want_reply=false 时拒绝静默，只能靠远端 `$SSH_AUTH_SOCK` 与 `/tmp/ssh-*` 反推。
- Windows ssh-agent 服务启动需管理员权限，沙箱 shell 非提权 → 正向场景只能人工点测。

### 提交状态

- 本轮 commit（含阶段 A fc5e93e）push 至 origin/main，快进 7c53f39 → 新 HEAD，ls-remote 复核一致。

---

## 2026-11-03 · 脚本与 Snippets 阶段 A：Snippets 页面与终端插入（todo P0 #7）

### 背景与范围

- 阶段 A 只做 Snippets：字段补齐 + Vault「脚本」页（列表/搜索/分组/新建/编辑/删除）+ 终端插入（右键菜单 + 逐片段快捷键）；脚本系统执行链路、导入导出、129 验证留阶段 B。
- 调研结论（Netcatty）：Snippet 统一模型在 `domain/models/connection.ts`（id/label/command/tags/package/targets*/shortkey/noAutoRun/multiLineRunMode/kind/language/description/trigger*）；UI = ScriptsSidePanel 树（package 层级 + 搜索扁平化）+ SnippetsManager 右编辑面板；插入语义 = shortkey/右键，自动执行追加回车（noAutoRun 原样插入）；脚本系统独立存在（nct.* 自动化 API、scriptRun/Stop/Pause/Resume 桥，见 netcatty-bridge-script.d.ts），与 snippets 经 kind 关联。
- termX 缺口：后端 `Snippet` 仅 {name, command}；无前端页（Vault 导航「脚本」禁用）；无插入链路。

### 修改点

- 后端 `models.rs`：Snippet 补 id/description/package/tags/shortkey/no_auto_run 六字段（全 serde(default)，旧 snippets.json 与同步 payload 向后兼容）；derive Default 并修 sync/config.rs 测试结构字面量。
- `src/backend/client.ts`：新增 Snippet 类型 + loadSnippets/saveSnippets 封装（R1）。
- 新增 `src/snippets/`：snippetsModel.ts 纯逻辑（filterSnippets 搜索 / groupSnippets 分组 / parseShortkey+shortkeyMatches 快捷键解析 / snippetPayload 插入载荷 / ensureSnippetIds 旧数据补 id）+ SnippetsView 页（工具条搜索 + 分组筛选 + 新建；分组列表行含名称/快捷键徽章/仅插入徽章/命令预览/描述/标签；右侧 380px 编辑面板对照 Netcatty AsidePanel）+ snippets.css（--nc-* 主题变量）。
- `VaultView.tsx`：「脚本」导航启用 + surface 分支挂载。
- `TerminalPane.tsx`：右键菜单「插入片段」区（可滚动、未连接禁用）；逐片段快捷键 onKeyDownCapture（捕获阶段 preventDefault+stopPropagation，仅命中本窗格焦点终端）；插入走 `(externalRef ?? transportRef).write`，只写本窗格会话、禁止跨会话发送；监听 `termx:snippets-changed` 刷新列表。
- 测试：snippetsModel.test.ts 15 用例（搜索/分组/快捷键解析与匹配/载荷/id 补齐）。

### 门禁

- test:run 242✓（新增 15）/ build✓ / cargo check --features server✓ / cargo test --lib 836✓。

### 比对结论（三类）

- **一致项（截图确认）**：分组列表 + 搜索 + 快捷键徽章 + 编辑面板字段（名称/命令/描述/分组/标签/快捷键/仅插入）与 Netcatty 字段语义一致；快捷键插入自动执行（F2 → `df -h` 进入当前会话并执行，截图为证）；noAutoRun 原样插入。
- **已修项**：① 后端字段 {name,command} → 八字段（向后兼容）；② Vault 导航「脚本」禁用 → 启用并挂页；③ 终端插入链路 0 → 右键菜单 + 快捷键双入口。
- **待人工项**：① CU 合成右键未触发 WebView2 contextmenu（疑工具限制），右键菜单插入需人工点测；② Netcatty SnippetsManager 为 package 卡片 + 面包屑下钻布局，termX 阶段 A 用分组平铺列表 + 右面板，视觉差异记阶段 B 对齐候选；③ multiLineRunMode（多行执行模式）未实现，多行当前整体发送 + 末尾单个回车，留阶段 B。

### 人工点测步骤

1. 终端右键 → 「插入片段」→ 点「磁盘用量」→ 当前窗格插入并执行 df -h。
2. 分屏两窗格，焦点在另一窗格按 F2 → 仅焦点窗格收到插入（不跨会话）。
3. 片段勾选「仅插入」→ 右键插入 → 文本进入但不发回车。
4. 编辑面板改分组/快捷键保存 → 分组头、筛选与徽章即时更新。
5. 重启应用 → 片段持久化（snippets.json）。

### review 自审

- 无新增后端命令（复用 load/save_snippets 双注册 lib.rs+server.rs），无新错误码；前端错误走 userVisibleError 信封。
- 插入边界：status!=="connected" 直接 return；只写本窗格 transport、无广播事件；快捷键仅本窗格终端聚焦时命中（捕获阶段拦截，未连接不拦截）。
- 数据兼容：新字段全 serde(default)，旧文件/同步 payload 原样可读；id 前端加载补齐、下次保存回写。
- R11：纯逻辑 15 测试；client.ts 封装为直通包装，wrapper 测试留阶段 B 补（记录）。

### 踩坑经验

- UIA 树不暴露 DOM input 的 placeholder，元素名是标签文本（`edit "名称 *"`）；按 placeholder 定位会命中 text 标签导致 set_value 失败，需按 edit/combo-box 名称定位。
- CU 合成右键不触发 WebView2 的 contextmenu 事件（菜单未出现在 UIA 树），右键路径转人工点测；快捷键路径可用 press_key + 截图端到端验证。
- xterm canvas 内容对 UIA 不可见，终端插入结果只能靠截图确认。

### 提交状态

- 本地 commit（不 push，随阶段 B 一起推）。

---

## 2026-11-03 · 脚本与 Snippets 阶段 B（P0 #5 收尾）

### 背景与范围

- 对齐 Netcatty `domain/snippetScript.ts` + `types/global/netcatty-bridge-script.d.ts`：其脚本是运行在 Electron 主进程 JS 沙箱里的 `nct.*` 自动化 API（scriptRun/Stop/Pause/Resume/GetRuns、屏幕等待、对话框、录制回放），依赖 608 方法桥与 Electron 能力目录；termX 无对应运行时。
- 裁定：**不假实现 `nct.*`**。本轮做最小闭环——脚本 = `kind:"script"` 的片段条目（与片段共用存储/编辑器），「执行」= 把内容按 `multiLineRunMode` 发送到当前活动会话的 shell，输出直接在本终端回显；`nct.*` 运行时与暂停/终止、跨主机批量、触发器（trigger/triggerPattern/targets）留档 P1 #13。
- 脚本「CRUD」复用 Snippets 页面（类型下拉 + 类型筛选 + 列表徽章），无独立编辑器组件（Netcatty 为 `ScriptsSidePanel` + 独立运行面板，差异记录在取舍）。

### 修改点

后端（`src-tauri`）：

1. **`src/models.rs` Snippet** 新增 `kind`（"snippet"|"script"，空=片段）与 `multi_line_run_mode`（"paste"|"lineDelay"，空=paste），均 `serde default`，旧数据与同步文件向后兼容。无新增命令（`load_snippets`/`save_snippets` 已双注册），R4 不受影响。

前端（`src`）：

2. **`src/snippets/snippetsModel.ts`**：`MultiLineRunMode`、`SNIPPET_LINE_DELAY_MS=250`（对齐 Netcatty）、`normalizeLineEndings`、`resolveMultiLineRunMode`、`isScriptSnippet`、`snippetWritePlan`——paste=整段 + 末尾单回车；lineDelay=去掉末尾换行后逐行发送、每行一个回车、250ms；noAutoRun 一律原样插入不逐行。删除旧 `snippetPayload`（被 writePlan 取代）。
3. **`src/snippets/snippetsTransfer.ts`（新增）**：Netcatty snippet 传输格式（`kind:"netcatty.snippets"`、导出 version 3、接受 1/2/3）；`label↔name` 映射；导入支持完整对象 / 裸数组 / 多导出对象数组；严格校验 kind/version/snippets 列表、command 必填、未知字段（targets/trigger 等）忽略不报错；按 **command** 判冲突（skip/overwrite，覆盖沿用本地 id）；`collectPackages` 展开父级分组；`describeImportStats` 统一提示文案。
4. **`src/snippets/SnippetsView.tsx`**：工具栏加「按类型筛选」「导入」「导出」；编辑面板加「类型」「多行运行方式」（含说明文案）并随类型切换命令标签；行徽章加「脚本」「逐行」；导入走文件选择 + 覆盖/跳过询问 + 结果提示；导出 JSON 直下（`termx-snippets-YYYY-MM-DD.json`）。
5. **`src/TerminalPane.tsx`**：`insertSnippet` 改用 `snippetWritePlan`，逐行模式用定时器队列写入；`clearPendingWrites()` 在 `teardown()` 与卸载时清理，断开后写空即丢弃（禁止跨会话/断开后续写）；工具栏「脚本」按钮从 disabled「尚未实现」改为真实下拉（仅列 `kind=script`，未连接禁用）；右键菜单拆「插入片段 / 运行脚本」两段。
6. **`src/snippets/snippets.css`**：新增 `.snippets-notice`、aside `select` 样式、`.term-snippet-menu`（复用既有 `.term-tool-menu` 定位）。

### 门禁

- `npm run test:run` **263 passed**（新增 snippetsModel 9 + snippetsTransfer 13，共 21；旧 `snippetPayload` 2 例移除）。
- `npm run build` 通过。
- `cargo check --features server` 通过（既有 warning 不变）。
- `cargo test --lib` **836 passed**。

### 实机验证（debug 构建 + 129）

CU 扩展本轮不可用（`Extension ide_mcp.config.ext.computer-use not found`），改用 PowerShell UI Automation（UIA InvokePattern）+ 窗口截图，规避了「Explorer 遮挡窗口导致坐标点击落空」的问题。

- 编辑面板：类型 / 多行运行方式两个下拉 + 提示文案渲染正常（截图核对）。
- 导入：导入 `netcatty.snippets` v3 文件 → 提示「导入完成：新增 1」，行显示「巡检脚本-标准 · 脚本 · F5 · 逐行 · echo STEP-A」。
- 129 实跑：连接 129 后，快捷键 F5 与工具栏「运行脚本」菜单各执行一轮，终端依次回显 `echo STEP-A/STEP-A`、`uptime` 输出、`echo STEP-B/STEP-B`（逐行模式生效，三轮均正常）。
- 跨会话隔离：另开干净「本地终端 4」，129 执行三轮脚本后回切，仍只有 Windows 横幅与空提示符，无任何 STEP 输出。
- 清理：输入法干扰产生的脏片段行已通过 UI 删除；当前保留「磁盘用量」与「巡检脚本-标准」两项。

### 比对结论（三类）

- **一致**：字段（kind/multiLineRunMode/noAutoRun/shortkey/package/tags/description）、列表分组与徽章、导入导出格式（kind/version/label）、终端插入语义（末尾单回车、逐行间隔）。
- **已修**：终端工具栏脚本入口（原为禁用占位按钮）→ 真实脚本下拉；多行模式从「未实现」→ paste/lineDelay 落地；Snippets 页新增类型筛选/导入/导出。
- **待人工**：右键菜单「插入片段 / 运行脚本」的视觉与点击（自动化合成右键无法触发 WebView2 contextmenu）；Netcatty 的网格/文件夹式 package 视图未复刻（termX 为分组行列表 + 导出保留 `snippetPackages`，功能等价、布局取舍已留档）。

### 取舍 / 留档

- Netcatty package 卡片/网格布局、`ScriptsSidePanel` 独立侧栏与运行日志面板未复刻（P1 #13 范围）；`targets*`/`trigger`/`triggerPattern`/`language` 不迁移，导入时忽略。
- 脚本执行不隔离 shell 环境，也不做逐行回显等待/超时；退出码与失败检测依赖用户 shell 输出判断。

### review 自审

- 注入面：写入仅由用户显式操作（快捷键/右键/工具栏菜单/脚本下拉）触发；导入只落库不执行；脚本与片段走同一 `write`，无 `eval`/shell 拼接新增面。
- 隔离：写入固定走当前窗格 `externalRef ?? transportRef`；逐行定时器在 teardown/卸载清理，断开后 transport 为空丢弃；无跨会话广播。
- 导入校验：kind/version/列表类型硬校验，条目 command 必填、其余字段宽松回落；不覆盖未知字段，避免脏写入。
- i18n：新增文案统一中文，错误信息可直接展示；无新增错误码。
- 双注册：无新增后端命令，无需改 `lib.rs`/`server.rs`。
- 判定：无高/中危问题。

### 踩坑

108. CU 扩展本轮缺失（Extension not found），改用 PowerShell UIA + `InvokePattern`；WebView2 的 `Edit`/`textarea` 不支持 ValuePattern，文本只能聚焦后键入或粘贴。
109. 窗口被资源管理器遮挡时坐标点击会落到 Explorer；UIA `InvokePattern` 不受层叠影响，保存/导航优先用它。
110. SendKeys 键入英文会被中文输入法组合成「恶臭」等词；文本输入改用剪贴板 `^v`，且确认目标窗口确实在前台。
111. 自动化点击「Terminal input」取到的是 DOM 中第一个输入框（可能属于非活动窗格），F5 会写进该窗格会话——这是按窗格语义的正确行为，非跨会话泄漏；人工点测时以可见活动窗格为准。

### 提交状态

- 本地 commit `d90c7cd`；核对远端 `a41ca88` 为 HEAD 祖先（快进）后 push `HEAD:main`，`ls-remote` 复核远端 main=`d90c7cd`。

---

## 2026-11-03 · 串口 1:1 重做 · 阶段 A（常量表 + SerialPanel 重构）

### 背景与范围

- 现行 `SerialPanel` 只是字段补全（mark/space、1.5 停止位、字符集、自动登录），布局/顺序/条件渲染与 Netcatty 不一致。本轮按「常量表驱动复刻」重做：对照 `Netcatty/components/SerialConnectModal.tsx` 与 `Netcatty/components/SerialHostDetailsPanel.tsx` 逐屏抄录，落成独立配置常量文件，再由 termX 侧栏渲染。
- 本轮不引入 Netcatty host 模型 / localStorage / Tailwind / radix；数据仍走 `serial_*` 命令。阶段 B 再做 129/本地实测、逐项复检与 review+push。

### 串口对照表（落点）

完整逐屏表写在 [serialFormConfig.ts](src/domain/serialFormConfig.ts) 文件头（分组、字段、控件、默认值、文案、条件、按钮与禁用、桥接方法映射），要点：

- 分组顺序：串口（端口 + 刷新 + 固定命名管道提示 + 非法红字）→ 波特率（命名管道隐藏、非标准值提示）→ 自动登录（来自主机编辑面板，位置在波特率后/高级前）→ 高级（默认收起：数据位/停止位两列、停止位 1.5 黄字、校验位、流控制、分隔线后终端选项）→ 连接。
- 终端选项顺序：回退键（说明）→ 按字节退格 → 强制本地回显 → 行模式 → 字符编码。
- 默认值：115200 / 8 / 1 / none / none / false / false / default / false / UTF-8；流控 UI 取值 `none|xon/xoff|rts/cts`，提交后端映射 `none|software|hardware`。
- 禁用：`port 合法 && 波特率为正整数`；命名管道在 Netcatty 由 Electron 桥实现，termX crate 不支持，故直接报错禁用。

### 修改点

前端（`src`）：

1. **`src/domain/serialFormConfig.ts`（新增）**：类型 / 默认值 / 选项 / 文案（逐字取自 Netcatty zh-CN i18n）/ 路径判定（`isWindowsNamedPipePath`、`isSerialEndpointPath` 与 Netcatty 同正则）/ 字段校验 / 禁用条件 / 默认值合并（非法枚举回落）/ 流控映射 / `toSerialConfig`。
2. **`src/domain/serialInput.ts`（新增）**：串口输入纯逻辑，对齐 Netcatty `serialLineInput.ts`/`serialLocalEcho.ts`/`terminalBackspaceInput.ts`：行模式缓冲与回车提交、Ctrl+U 清行、Ctrl+C 立即发送、本地回显与宽字符擦除、DEL→Ctrl+H 映射、按 UTF-8 字节数多发 DEL。
3. **`src/SerialPanel.tsx`（重构）**：配置驱动渲染字段顺序/标签/默认值/提示；高级默认收起；命名管道隐藏波特率与硬件帧参数；端口与波特率改为可手输的 Combobox（datalist，无 radix）；连接后按键经 `createSerialInput` 变换后写串口，本地回显写回终端；保留发送框与 DTR/RTS/BREAK。
4. **测试**：`serialFormConfig.test.ts` 15 例、`serialInput.test.ts` 16 例（默认值合并、路径识别、校验、禁用、流控映射、行模式/回显/退格）。

后端：无新增命令（localEcho/lineMode/backspace 均为客户端输入变换；`SerialConfig` 已有字段足够承载）。ymodem 与命名管道属后端能力缺口，未加假入口。

### 门禁

- `npm run test:run` **294 passed**（新增 31）。
- `npm run build` 通过。
- `cargo check --features server` 通过（既有 warning 不变）。
- `cargo test --lib` **836 passed**。
- `npm run tauri build -- --debug` 通过，产物 `src-tauri/target/debug/rssh.exe`。

### 实机比对（debug 构建 + PowerShell UIA/截图）

- 侧栏入口「串口」→ 收起态截图：串口 + 刷新、端口输入（自动选中 COM1）、命名管道提示、波特率 115200、自动登录用户名/密码、高级、连接；顺序与 Netcatty 一致。
- 展开「高级」截图：数据位/停止位两列、校验位、流控制、回退键（默认 DEL）+ 说明、按字节退格、强制本地回显、行模式、字符编码 UTF-8；顺序与 Netcatty 一致。

### 比对结论（三类）

- **一致**：字段集合与顺序、控件类型（可手输 Combobox/Select/checkbox/文本框）、默认值、关键文案（命名管道提示、1.5 停止位警告、回退键说明、按字节退格/本地回显/行模式说明）、按钮禁用公式。
- **已修**：手写散落 JSX → 常量表驱动；补齐 localEcho/lineMode/backspaceBehavior/byteOrientedBackspace 及实际输入语义；字符集由固定下拉改为自由文本默认 UTF-8；端口/波特率统一为可手输 Combobox；高级分区默认收起。
- **待人工**：命名管道（后端未支持，明确报错）；ymodem 发送/接收入口（后端未实现，阶段 B 评估）；「保存配置为主机」与密码眼睛/清除控件（termX 无 host 模型，取舍留档）；中文输入法下的实际按键回显体感。

### 取舍 / 留档

- termX 入口是终端侧栏（Netcatty 是 `SerialConnectModal` 弹窗 + 主机编辑面板），内部结构与字段顺序对齐；无「取消」footer，主按钮为「打开串口」。
- 自动登录来自 Netcatty 主机编辑面板（连接弹窗没有），按其在编辑面板中的位置放在波特率之后。
- 命名管道在 Netcatty 由 `electron/bridges/serialNamedPipe.cjs` 支持；termX 串口 crate 无法打开，保留 Netcatty 提示文案但校验直接报错。
- ymodem / `serialEraseChar` 未实现，未添加禁用按钮（阶段 B 再决定是否补后端）。

### 提交状态

- 本轮本地 commit，**不 push、不 review**；阶段 B：129/本地串口实测、逐项复检、review + push。

---

## 2026-11-03 · 串口 1:1 重做 · 阶段 B（复检 + 实测 + 收尾）

### 开工核对

- 工作树干净，HEAD=`7a29ed3`，远端 main=`0b9adf3`（快进关系）。
- debug 产物重新构建后启动，按阶段 A 的对照表逐项复看。

### 逐项复检与修正

- **控件/间距**：新增 `.serial-form` 样式，分组间距 8→12px，输入框全宽、标签 13px；「高级」标题加粗、整行可点；checkbox 右对齐固定 16px。
- **主按钮**：连接按钮改为蓝色主按钮（`#0a84ff`），禁用沿用全局 `button:disabled` 半透明；与 Netcatty Footer 主按钮层级一致。
- **默认展开态**：高级默认收起（与 Netcatty Collapsible 一致），截图确认。
- **资源释放**：面板卸载时除解绑监听外，新增 `serialClose(sidRef)` 释放串口句柄；关闭按钮路径同样清理（review 发现的泄漏已修）。
- **错误码 i18n**：补 `serial_not_found` → 「串口会话已关闭或不存在」，其余沿用 `serial_open_failed`。
- **一致性**：渲染仍全部来自 `serialFormConfig`；未新增手写字段。

### 实测（本机 COM1，真实打开）

- 本机枚举到 COM1（ACPI 通信端口），debug 版侧栏选择 COM1/115200 后「连接」成功，状态显示 `已打开 COM1 @ 115200（<sid>）`，关闭按钮可用。
- 输入语义手测（行模式 + 强制本地回显）：OS 级按键输入 `123` 后回车 → 终端回显 `123` 并换行，**本地 shell 未执行该命令**（无报错/新提示符），确认按键已由串口桥接接管、行模式回车提交与本地回显生效。
- 退格：`abc` + Backspace + `d` → 回显为 `abd`，擦除两格/宽字符路径由测试覆盖；无环回设备时无法观测对端字节，DEL/Ctrl+H/按字节 DEL 由 16 个纯逻辑测试覆盖。
- 中文输入法会吞掉合成态回车（自动化限制，非应用缺陷），已用窗口级输入语言切换规避。

### ymodem 评估（不做，不留假按钮）

- 结论：本轮不实现。原因：①后端无 ymodem/串口文件传输命令，需新增 XMODEM-CRC 分块、EOT/ACK 握手与接收落盘；②本机仅有 COM1 且无环回/对端设备，协议无法端到端验证，贸然上线属未验证实现；③入口需要文件选择与进度/取消 UI，超出本轮收尾范围。
- 处理方式：**不添加任何 ymodem 按钮/菜单**（避免可点但不工作）；留档到后续串口增强任务，需真实设备联调后再补。

### 门禁

- `npm run test:run` **294 passed**；`npm run build` 通过。
- `cargo check --features server` 通过；`cargo test --lib` **836 passed**。
- `npm run tauri build -- --debug` 通过。

### 三类复检结论

- **一致**：字段顺序/默认值/文案/高级收起/禁用条件；主按钮层级、标签字号、分组间距、checkbox 右对齐已对齐。
- **已修**：面板卸载串口句柄泄漏；`serial_not_found` 文案缺口；间距与主按钮视觉偏差。
- **待人工**：ymodem（后端缺口 + 无设备验证）；命名管道（crate 不支持，明确报错）；保存为主机（无 host 模型）；真实设备下的字节级退格/自动登录回归。

### 提交 / 推送

- 本地 commit `be07732`；核对远端 `0b9adf3` 为 HEAD 祖先（快进）后 push `HEAD:main`，`ls-remote` 复核远端 main=`be07732`；完成后进入「笔记（Notes）」阶段。




---

## 2026-11-03 Telnet 连接入口修复（同串口病根）

### 背景与复现
- 用户口径：点击「Telnet」会先开出本地终端，再把右侧 TelnetPanel 挂上去。
- 复现路径（代码级）：`App.toggleTool("telnet")` → `workspaceRef.ensureTab()`（工作区为空时 `newTab({kind:"pty"})`）→ 设置 `tool="telnet"` → 右侧 `TelnetPanel` 通过 `TermBridge` 接管活动窗格的按键路由。
- 根因：Telnet 被实现成「侧栏工具面板 + 借用某个终端窗格」，入口没有独立连接流程；`ensureTab()` 的兜底分支直接创建了本地 pty 标签。与串口热修前的 `ensureTab()` 病根相同。
- 现状补充：本轮开工时 `src/` 内已没有 Telnet 按钮（历史批次把 ⋮ 菜单的 Telnet 项移除后，只剩未接线的 `toggleTool` 分支），因此代码路径仍在、UI 入口已缺。本轮按 Netcatty 口径补回入口。

### Netcatty 真实形态（运行版 1.1.90 截图取证）
- `evidence/netcatty-quickconnect.png`：Vault 搜索框输入主机后回车 → 出现**居中模态向导**（非右侧面板）；协议卡片 SSH / Telnet / Mosh。
- `evidence/netcatty-telnet-selected.png`：选择 Telnet 后标题变为「连接到 <host>:23」，端口 23，底部「关闭 / 继续」。
- `evidence/netcatty-telnet-step2.png`：第二步用户名/密码为终端内交互登录做预填，第三步认证。
- 结论：Netcatty 的 Telnet 是 **host 协议 + 模态连接流程**；它没有「独立 Telnet 工具面板」这种形态。

### 修复方式
1. **入口改为弹窗先行**：`App.openTelnet()` 只 `setShowTelnetModal(true)`；`TelnetConnectModal` 确认后才 `newTab({kind:"telnet", session})`。删除 `ensureTab()` 及其在 `WorkspaceHandle` 上的接口（全仓已无调用点）。
2. **Telnet 成为一等连接器**：`workspaceModel` 新增 `TelnetSessionConfig`（host / port / inputNewline）与 `Connector.kind="telnet"`；`defaultTitle` 为 `Telnet <host>`；`workspaceStore.isConnector` 接受 telnet 并持久化恢复。
3. **会话生命周期归 TerminalPane**：telnet 分支在 `connect()` 内先订阅 `telnet:data/echo/close`，再 `telnet_open`；输入走 `telnet_write`、resize 走 `telnet_resize`、卸载走 `telnet_close`；`RemoteEcho` 事件映射为「本地回显 = 非远端回显」，回显格式化移植自 Netcatty `telnetLocalEcho.ts`（`src/domain/telnetEcho.ts`）。
4. **删除旧实现**：`src/TelnetPanel.tsx`、`client.ts` 的 `TermBridge`、`PaneHandle` 的 `write/size/attachTransport` 外部接管通道；`Tool` 收敛为 `sftp | forward`。SFTP / 端口转发入口复核：只切工具面板、不建 pty，无同类问题。
5. **弹窗字段（单步，对照 Netcatty 协议步骤裁剪）**：主机（自动聚焦）、端口（默认 23）、高级折叠内的换行风格（CRLF 默认 / LF / CR）；标题「连接 Telnet」+ 描述「配置 Telnet 连接参数」；底部「取消 / 连接」，主机或端口非法时连接禁用。弹窗壳复用串口弹窗（同一套 Netcatty 对话框骨架）。
6. **错误码 i18n**：补 `telnet_not_found` / `telnet_open_failed` / `telnet_op_failed` 三条中文映射。
7. **测试**：新增 `telnetFormConfig`（默认值 / 主机空白 / 端口 1–65535 / 禁用态 / 会话转换）与 `telnetEcho`（可见字符 / 换行 / 退格 / Ctrl-C / 转义序列）共 8 例；`workspaceModel` + Telnet 默认标题，`workspaceStore` + Telnet 持久化恢复。

### 差异清单（termX vs Netcatty）
| 维度 | Netcatty | termX（本轮） | 结论 |
|---|---|---|---|
| 形态 | 居中模态向导（协议卡片 → 用户名 → 认证） | 居中模态单步弹窗 | 对应形态；入口差异见下 |
| 入口 | Telnet 是 host 协议，经 Vault 搜索 / 新建主机触发 | Vault 工具栏新增「Telnet」按钮（与已有「串口」并列） | 有意保留独立入口（termX 无 host 协议模型） |
| 字段 | 协议卡片 + 端口 23 + 用户名 / 密码 / 密钥 | 主机 + 端口 23 + 换行风格 | 凭据后端不支持（`telnet_open` 无凭据参数），登录在终端内交互完成，未做假字段 |
| 底栏 | 关闭 / 继续（多步） | 取消 / 连接（单步） | 一致的单步语义 |
| 视觉壳 | 448px 居中卡片、标题+描述、字段、底部右对齐主按钮 | 复用串口弹窗同一套样式 | 一致 |
| 自动登录 | QuickConnect 预填用户名/密码 | 未做（P1 #20 自动登录仍 ⬜） | 待人工/后续 |

### 验证证据
- `evidence/telnet-before-click.png`：新实例 Vault，工具栏含「Telnet」。
- `evidence/telnet-after-click.png`：点击 Telnet **只出现弹窗**，没有新建本地终端标签（对照 symptom 修复）。
- `evidence/telnet-connected.png`：输入 `127.0.0.1:2323`（本地测试服务器）确认后，新建标题为 `Telnet 127.0.0.1` 的标签并显示服务器横幅。
- `evidence/telnet-input.png`：在 Telnet 标签输入 `hello` 并回车，字节经 `telnet_write` 上行、服务端回显落到终端（输入链路通）。
- 本地测试服务器为临时 PowerShell TCP 回显（`%TEMP%\tx-telnet-server.ps1`），仅用于验证打开/输入/回显，不属于仓库产物。

### 门禁
- `npm run test:run` 306✓；`npm run build` ✓；`cargo check --features server` ✓（仅 3 条既有 warning）；`cargo test --lib` 836✓。
- debug 版本已重新构建并启动（`src-tauri/target/debug/rssh.exe`），实例保持运行供人工手测。

### 无法自动核对 / 待人工
- Netcatty 的 Telnet 用户名/密码/密钥、自动登录脚本（后端无对应参数，未做）。
- 与真实 Telnet 设备（交换机/嵌入式板）的协商与中文/UTF-8 表现（本轮仅用本地回显服务器）。
- 视觉逐像素比对（弹窗壳复用串口已对齐项；本机 DPI 缩放下截图存在比例误差）。

---

## 2026-11-03 笔记（Notes）阶段 A

### 后端（自 stash 恢复并复核）
- schema 迁移 v37 新增 `notes` 表：`id / title / content / group_name / tags_json / linked_host_ids_json / created_at / updated_at / sort_order / is_pinned`，带 `updated_at` 索引；SCHEMA_VERSION 只增到 37。
- `commands/notes.rs`：`list_notes` / `get_note` / `save_note`（upsert）/ `delete_note`，按 id 校验并映射 `note_id_required` / `note_not_found`；双注册（`lib.rs generate_handler!` + `server.rs` dispatcher）已核对。
- `db/notes.rs` 6 例单测：往返、标签/关联主机 JSON、排序（置顶→updated_at）、upsert 保留 created_at、删除、缺 id 错误。

### 前端（本轮新增）
- `src/notes/notesModel.ts`：搜索（标题/正文/分组/标签）、标签筛选（大小写不敏感）、排序（置顶优先→更新时间倒序）、标签汇总与输入拆分、摘要压平、草稿 ↔ Note 转换（保留 group/order/linked_host_ids）、保存队列（600ms 合并写 / flush / cancel / dirty）。
- `src/notes/NotesView.tsx` + `notes.css`：左侧 300px 笔记树（搜索、标签 chips、置顶标记、摘要、时间）+ 右侧编辑器（标题、标签输入、等宽 Markdown 原文 textarea、置顶、删除、Ctrl/Cmd+S、已保存/未保存状态）；新建/删除走 termX DB，不使用 localStorage；空态与错误码 i18n 齐备。
- `client.ts` 新增 `Note` 类型与 `listNotes/getNote/saveNote/deleteNote`（invoke 仅在此文件，符合 R1）；`VaultView` 启用「笔记」导航并挂载 `NotesView`。
- 阶段 A 不做：Markdown 预览、关联主机、分组文件夹、导入导出、分享（留阶段 B）。
- 单测 8 例：搜索/标签筛选/排序/标签汇总与拆分/摘要/草稿转换/防抖合并写/flush 与 cancel。

### Netcatty 对照（运行版 1.1.90）
- 截图 `evidence/netcatty-notes.png`：左侧笔记列表 + 右侧富文本编辑器（标题、实时预览下拉、添加标签、格式工具栏、删除/分享）。
- 结构级一致项：左列表 + 右编辑器、标题置顶、标签入口、删除入口、置顶标记。
- 有意差异：Netcatty 用 MDXEditor 富文本 + 实时预览与格式工具栏；termX 阶段 A 用等宽 textarea 编辑 Markdown 原文（不引入 Monaco/MDXEditor），预览与格式工具栏留阶段 B；Netcatty 有文件夹/导入导出/分享，termX 暂未做。

### 实测证据
- `evidence/netcatty-notes.png`：Netcatty 1.1.90 笔记页（列表 + 富文本编辑器 + 标签 + 工具栏）。
- `evidence/notes-vault.png`：termX Vault，「笔记」导航已启用。
- `evidence/notes-termx.png`：笔记页空态（左 300px 列表 + 搜索 + 右空态）。
- `evidence/notes-edited.png` / `notes-tags.png`：新建「DB check」，正文两行，标签 `ssh, db`，列表出现摘要、时间、标签与筛选条 `#db/#ssh`，右上显示「已保存 · 20:53」。
- `evidence/notes-persisted.png`：切到「主机」再回「笔记」，标题/正文/标签完整保留（走 DB 持久化，非 localStorage）。
- 注：截图输入通过剪贴板注入以避开本机中文输入法组合；直接 SendKeys 会被 IME 转写，非应用缺陷。

### 门禁
- `npm run test:run` 315✓（新增 8 例）；`npm run build` ✓；`cargo check --features server` ✓（仅 3 条既有 warning）；`cargo test --lib` 842✓（新增 6 例）。
- debug 版本已重新构建（`src-tauri/target/debug/rssh.exe`）并启动；本轮不 push。

### 待人工 / 阶段 B
- 与 Netcatty 富文本编辑体验逐项对齐（预览、格式工具栏）。
- 关联主机跳转、导出/导入、分组文件夹。
- 大量笔记（>500）时列表滚动与搜索性能。

---

## 2026-11-03 笔记（Notes）阶段 B

### 编辑体验（对照 Netcatty 实际做法取舍）
- 正文保持「Markdown 原文 textarea + 原文/预览切换」，不引入 MDXEditor/react-markdown 重依赖；预览由自研 `markdownModel.ts` 解析块/行内 token，再渲染 React 元素（不走 `dangerouslySetInnerHTML`，笔记正文不会变成可执行 HTML）。
- 支持语法：标题 1-3、加粗、斜体、行内代码、链接、无序/有序列表、引用、围栏代码块、分隔线；不支持 Netcatty MDXEditor 的表格/图片/公式/下划线/删除线（记为差异）。
- 最小格式工具栏（真能用、可切换）：H1/H2/B/I/无序/有序/引用/代码；标题再次点击同级不会误删标题（与 Netcatty 的 set-heading 语义一致），列表/引用二次点击取消前缀；有选区时包裹，无选区插入占位词并把光标放进标记内。
- 关联主机：按 Netcatty 实际模型复用 `[名称](ssh://user@host:port)` 链接（不是单独的 hostId 字段，Netcatty 的 VaultNote.linkedHostIds 无编辑 UI）。工具栏「主机」从主机档案插入链接（用户名取凭据），预览里 `ssh://` / `telnet://` 链接可点击，按 host+port（有用户名再按名称）匹配档案后调用 Vault 的 `onConnect` 打开会话；匹配失败给「未找到匹配的主机」提示（悬空引用不崩）。
- 分组：编辑器「分组」输入（`/` 分隔路径），左侧分组过滤列表含父路径（`ops` 命中 `ops/db`），层级缩进；导出按分组落目录。
- 排序/置顶沿用阶段 A（置顶 → 更新时间），分组过滤后同序。

### 导入 / 导出（对齐 Netcatty domain/notes.ts）
- 单条导出：`sanitizeNoteFileName`（非法字符/控制符/结尾点号/Windows 保留名，120 字符）生成 `<标题>.md`，正文原样（与 Netcatty 一致，无 frontmatter）。
- 全部导出：Netcatty 打包 ZIP 且按分组建目录；termX 不引 zip 依赖，改为选目录后按 `<分组>/<标题>.md` 逐条写入（重名自动 `-2`），能力等价、容器不同（已在差异表记录）。
- 导入：多选 `.md/.markdown/.txt`，标题取 `title:` frontmatter > 首个 `# H1` > 文件名（同 Netcatty `deriveNoteImportTitle` 顺序），导入到当前分组过滤；全部走 termX DB。
- 文件对话框用 `tauri-plugin-dialog`（`dialog:default` 已在 capabilities），读写复用既有 `local_read_file` / `local_write_file` / `local_mkdir`（不新开 fs scope、无新后端命令、无裸 invoke）。

### 自审（review）
- 中危 2 已修：①`patchDraft` 原在 setState updater 内做排程/写列表（副作用入 updater，且保存/导出可能读到少一个字符的旧内容）→ 改 `draftRef` 先行同步更新 ref，再 setState；②全部导出用 `notes` 快照可能与正在编辑的正文不一致 → 导出前用 `activeNoteRef` 覆盖当前条。
- 低危记录：分组匹配为路径前缀（大小写不敏感）；`window.confirm` 删除确认（与阶段 A 一致）；导出落盘全流程的对话框自动化受 UIA 超时限制，仅截到对话框与默认文件名；Markdown 语法覆盖非全量。

### Netcatty 对照（运行版 1.1.90，evidence/netcatty-notes.png）
- 一致：左侧 300px 笔记树 + 搜索 + 新建/导入/导出图标；右侧标题、标签行、正文；编辑/预览双模式；`ssh://` 链接点击开会话；单条 Markdown 导出与「全部导出」；置顶/删除/时间/搜索覆盖标题正文标签分组。
- 差异：Netcatty 用 MDXEditor 所见即所得（live/source/preview 三模式）+ 完整工具栏（含表格/图片/公式/链接/下划线/删除线）；termX 为原文 + 预览 + 8 个按钮。分组 Netcatty 是文件夹树，termX 是过滤列表 + 输入框。全部导出 ZIP vs 目录。termX 额外提供「插入主机链接」按钮。
- 待人工：导出文件落盘全流程（原生对话框自动化不可靠）、富文本（表格/图片/公式）、>500 条笔记列表性能。

### 验证证据
- `evidence/notes-b-list.png`：新实例笔记页（左树含 DB check + `#ssh/#db` 筛选；右标题/标签/分组/模式/工具栏/原文）。
- `evidence/notes-b-preview.png`：原文→预览切换后正文按 Markdown 渲染，`129` 链接显示为可点击链接，状态「已保存 · 21:23」。
- `evidence/notes-b-hostlink-open.png`：点击预览里的 129 主机链接后，新建 `129` 会话标签并连上 `tianzry@tianzry-VMware-Virtual-Platform`（关联主机跳转闭环，129 实测）。
- 单条导出实测（首轮截图，因后续同名覆盖未保留）：弹出原生「导出笔记」对话框，默认文件名 `DB check.md`，过滤项 Markdown。
- 注：导出对话框的保存动作未自动化完成（UIA ValuePattern 在 WebView2 原生对话框上超时），文件内容生成由 4 例单测覆盖（文件名清洗/保留名/分组目录/重名去重）；确认对话框与默认名正确，落盘转人工点测。

### 门禁
- `npm run test:run` 325✓（新增 10 例 markdown/分组/主机链接）；`npm run build` ✓；`cargo check --features server` ✓（仅 3 条既有 warning，本轮无 Rust 改动）；`cargo test --lib` 842✓。
- 本轮新增依赖 `@tauri-apps/plugin-dialog@2.7.1`（与 Rust crate 2.7.1 版本校验一致；capabilities 原已授予 `dialog:default`）。

---

## 2026-11-03 — 会话日志阶段 A（Vault 日志页 + 索引落库）

### 修改点

1. **后端**
   - schema v38 新增 `session_logs` 索引表（id/session_id/host/title/format/path/started_at/ended_at/duration_ms/size_bytes/event_count/status）+ `idx_session_logs_started`，历史迁移块未动。
   - 新增 `db/session_logs.rs`（list/get/upsert/delete）与 `commands/session_logs.rs`（扫描 recordings 目录、解析 asciicast v2 header/事件、标题从 `_YYYYmmdd_HHMMSS` 后缀剥离、时长=最后 elapsed、事件数=o 事件）。
   - 四个命令 `list_session_logs` / `get_session_log` / `export_session_log`(cast|txt|html) / `delete_session_log`，同时注册 `generate_handler!` 与 server.rs dispatcher；删除前复用 `is_safe_recording_name` 防目录穿越，文件缺失仍清索引。
   - 导出 txt 保留 ANSI 原样（阶段 A 明确不清洗），html 对 `& < >` 转义并内嵌 `<meta charset>`。
2. **前端**
   - `src/sessionLogs/` 新页：左栏 300px（刷新/搜索/主机/格式/列表）+ 右侧详情（开始/结束/时长/事件数/大小/路径 + `<pre>` 原文），删除走页面内确认模态；布局对齐 NotesView，全部 `--nc-*` 变量。
   - `sessionLogsModel.ts` 纯逻辑：asciicast 解析、时长/大小/时间格式化、筛选、主机去重、排序、导出文件名，11 个单测。
   - `VaultView` 启用「日志」导航并挂载页面；`client.ts` 四个 invoke 封装；`sshErrors.ts` 补 4 个错误码。

### 踩坑 / 结论

- Netcatty 本身**没有 Vault 日志列表页**：日志是 `recordings` 下的文件，入口在终端工具栏 More actions（Open / Show in folder / Open with…）。termX 的列表页属新增能力，事实源仍是 `.cast` 文件，DB 只存索引，避免把大内容塞进 SQLite。
- 扫描允许坏行：asciicast 单行损坏只跳过该行，不能让整页 500；文件缺失时详情按 `session_log_read_failed` 报错而不是静默打开别的文件。
- `recording_enabled` 旧键从未接线，当前页面只索引已有 `.cast`；录制开关、ANSI 渲染/回放、导出落盘留阶段 B。
- 63 个工具点内完成：门禁 336✓（27 文件）/ build✓ / cargo check(server)✓ / cargo test --lib 853✓；实机截图 `evidence/sessionlogs-page.png`（3 条样例 cast，列表排序、筛选、详情统计与 ANSI 原文可见）。

---

## 2026-11-03 — 会话日志阶段 B（录制 / 查看 / 导出收官）

### 修改点

1. **会话级录制**
   - `SessionHandle` 增加 `Arc<Mutex<Option<ActiveRecording>>>`；自动录制与手动录制共用同一槽，`session_task` 每帧短暂加锁写入，不跨 await。
   - 新增 `start_session_log` / `stop_session_log` / `session_log_status` 三命令，lib.rs + server.rs 双注册；停止时 finish → 解析 cast → 写索引表。
   - 终端工具栏 `file-text` 按钮与 More「开始/停止录制」由禁用占位改为真实可用，录制中显示 REC 徽标与「点击停止」；设置页已有 `recording_enabled` 继续控制自动录制。
   - 手动录制不受自动开关限制；同名同秒路径自动加 `-2` 序号，避免 `Recorder` truncate 覆盖旧日志（review 中危修复）。
2. **ANSI 渲染**
   - 新增 `src/sessionLogs/ansi.ts`：SGR 16 色/粗体/斜体/下划线/反显、CRLF 归一、裸 `\r` 行覆盖、未知 CSI/OSC 丢弃；React span 渲染，无 innerHTML；详情支持「彩色 / 原文」切换，原文保留 ANSI。
   - 10 个解析单测；时间轴回放明确留档不做。
3. **导出落盘**
   - 详情「导出（默认 TXT）」+「选择格式」菜单，走 Tauri `save` 对话框；cast/txt/html 三种，txt 保留 ANSI 原样；写入复用 localfs。
   - 新增 `pickSessionLogExportFile`；错误码补 `session_log_already_recording` / `session_log_not_recording`。

### 实测（129）

- 连接 129 → 工具栏开始录制（REC）→ 停止：`129_20261103_222403.cast` 645B 落盘，Vault 日志页出现 3 条 129 记录，详情打开正常。
- 导出 `prod-web` 样例为 TXT：449B，内容含 `Last login` 与 ESC 颜色序列（ANSI 保留）。
- 导出 129 手动日志为 TXT：40B，内容含 `TERMX_LOG_LIVE`。
- 证据：`evidence/sessionlogs-live-129.png`（列表 + 详情 + 彩色/原文/导出按钮）；导出文件位于 `%TEMP%`（termx-prod-web-log.txt / termx-129-log.txt）。

### 与 Netcatty 差异 / 待人工

- **一致**：录制与打开分离；自动/手动录制的文件在停止后仍可打开；txt/raw/html 三格式与时间戳语义对齐；入口都在终端 More actions。
- **差异**：Netcatty 无 Vault 日志列表页，只有终端菜单打开文件；termX 新增索引页，并支持 ANSI 彩色渲染与页面内导出。Netcatty 运行实例未捕获，入口比对基于 `docs/session-logs.md` 与 `Terminal.tsx` 源码取证（截图比对转人工）。
- **待人工**：Netcatty 实机菜单并排截图；回放（时间轴）；ANSI 256 色/真彩色；断线时索引要等下次扫描才收录（文件不丢）。

### 门禁 / review

- `test:run` 28 文件 349✓、`build`✓、`cargo check --features server`✓、`cargo test --lib` 856✓、debug 构建✓。
- 自审：路径穿越（手动路径复用 safe stem）、坏 cast（跳过/报读失败）、索引与文件（停止即 upsert，扫描幂等）、删除确认、导出路径（系统对话框）、i18n、双注册均通过；同秒覆盖中危已修，无高危。

## 2026-11-03 — 代理 / 端口转发移植暂停（决策记录）

**决策**：按用户指令立即停止「代理」与「端口转发」两项移植，不再继续开发；已在途的代理阶段 A 后端改动保留为本地 WIP 草稿，**不推送远端**。端口转发阶段从未开始。

**已完成（可直接沿用，`d633866`）**：
- 后端 `ssh/proxy.rs`：HTTP CONNECT 与 SOCKS5（含用户名/密码子协商）握手、Basic 认证、IPv6 authority / ATYP、全流程超时、`no_proxy`（通配、后缀、端口、CIDR、`<local>`）+ 6 个单测（含本地 mock 代理）。
- 主机档案 5 个代理字段 + schema v39（`proxy_type/host/port/username/no_proxy`）；密码不入库，走 SecretStore `proxy:<profile_id>`；删除档案时清理 TOTP/代理密文。
- 连接链路：`DialCtx` / `ConnectParams` / `ConnTarget` 按 `profile_id` 查代理表，终端、堡垒逐跳、端口转发、headless `server.rs`、CLI 均已接线；设置中心系统代理 `custom` 作为「无主机级代理」时的兜底（`settings.center.v1.networkProxy`）。
- `profile_proxy_password_get/set` lib.rs + server.rs 双注册；前端 `client.ts` 封装、`sshErrors.ts` 中文错误码。

**半成品 / 未完成**：
- 主机档案与连接弹窗的代理表单**未接线**（`VaultView.tsx` / `ConnectionManager.tsx` 未改），用户目前无法在 UI 里填写代理；系统代理设置页文案也未更新。
- 129 经本地代理的实连验证、与 Netcatty 代理界面的截图比对均未做。
- SFTP 后台独立连接仍显式 `proxy: None`（原计划阶段 B 补齐）。

**门禁**：`test:run` 28 文件 349✓、`build`✓、`cargo check --features server`✓、`cargo test --lib` 863✓；debug 实例已停止。远端 main 仍为 `b1db6cb`（未推送）。

**恢复方式**：在 `d633866` 基础上继续只改前端表单即可接通；若彻底不做，`git revert d633866` 可整块移除（无其它轮次依赖）。

## 2026-11-03 — 终端工具栏（第二阶段）：逐按钮对照 + 会话日志/脚本录制拆分

**背景**：用户指出「开始会话日志」与「开始录制」被合并成同一套会话级共享录制槽是错的，要求拆成两套独立能力；并对工具栏被圈按钮与「更多」菜单做逐项对照与真实实例验证。

### 对照表（被圈出按钮 + 两个录制功能）

| 按钮 | Netcatty 行为（源码 + 运行实例） | termX 本轮前 | 本轮处理 | 验证 |
|---|---|---|---|---|
| 命令历史（clock） | 工具栏常显，弹出最近命令列表，点击回填/执行 | 占位/未接线 | 接通：记录输入命令（上限 200），popover 点击回填 | CDP 实机：记录 `echo termx-verify` / `uname -a` 并可点选 |
| 关键词高亮（marker） | 常显，popover 输入关键词，匹配行加背景色 | 未实现 | 接通：`allowProposedApi` + `onWriteParsed` + `registerDecoration`，回车添加/点击移除 | 实机弹层可开、规则生效 |
| SFTP（folder） | 常显，打开 SFTP 双栏 | 已可用 | 保持 | 既有 SFTP e2e 覆盖 |
| 撰写栏（pencil） | 常显，整段文本一次性发送 | 禁用占位 | 接通：textarea + 发送（整段 + `\r`） | 实机打开/发送面板 |
| 终端搜索（magnifier） | 常显，xterm buffer 搜索、上下跳转、计数 | 禁用占位 | 接通：全行 includes 扫描 + `scrollToLine` + 计数 | 实机可开、命中计数 |
| **开始会话日志**（file-text） | **独立功能 A**：点击先弹保存对话框 → 文本日志落盘（raw/txt/html + 可选时间戳）；断开/日志中状态不同；默认主目录、`名称_YYYY-MM-DDTHH-mm-ss.EXT`、默认 txt/无时间戳 | 与脚本录制共享一个槽、raw/`.log`、默认落 cwd | **拆出**：后端 `TextLogRecorder` + `ActiveTextLog` 独立槽 `text_log_slot`，与 asciicast 录制槽完全分离；命令 `start/stop/manual_session_log_status`；前端独立 `sessionLog` 状态 + LOG 徽标；默认主目录 + `.txt` + `YYYY-MM-DDTHH-mm-ss`；录制中按钮可停止 | 实机：对话框 → LOG 徽标全路径 → `echo termx-ui-log` → 停止后文件含 ANSI 原文；`raw+timestamps` 另测含 `[HH:MM:SS.mmm]` 逐行前缀；**live 写入确认 178B** |
| **开始录制（脚本录制）** | **独立功能 B**：位于 More actions；录制终端输入命令序列，停止时生成脚本片段（nct.* 运行时/片段库），全局同一时刻只允许一个终端录制，多会话冲突提示「已有其他终端正在录制」 | 与日志共享槽 | **拆出**：`src/terminal/scriptRecording.ts`（输入缓冲、回车提交、退格/^C/^U、ESC 序列跳过、>1s 生成 sleep、模块级全局互斥）+ More 菜单开始/停止；产物为 `Snippet`（kind script，steps>1 用 lineDelay） | 实机：More → 开始录制 → REC 徽标 → `id` → 停止 → `load_snippets` 得到 `录制 23:29:05 :: id` |
| 同时开启 A+B | 两者互不排斥（分别控制文件日志与脚本生成） | 共享槽导致互斥/抢占 | 两套状态/产物独立 | **实机同时开**：LOG（invoke 启动 raw+ts）与 REC（More 启动）并行，输入 `echo termx-both2` 后停止：日志文件含该命令，片段库新增 `录制 23:50:15 :: echo termx-both2` |

### 修复与代码

- 后端：`recorder.rs` 新增 `TextLogRecorder`（raw/txt/html、UTF-8 跨 chunk、逐行时间戳、ANSI strip、html 转义、finish flush，+6 单测）；`ssh/client.rs` 会话任务双写 asciicast 槽与文本槽；`session_logs.rs` 4 命令；`models.rs` `ManualSessionLogStatus`；lib.rs/server.rs 双注册。
- 前端：`TerminalPane.tsx` 两套独立状态与入口；`client.ts` 独立封装与保存对话框（默认路径改为用户主目录，对齐 Netcatty）；`scriptRecording.ts` + 单测；`styles.css` 菜单/popover/搜索条/撰写栏/LOG-REC 徽标样式。
- 本阶段补修：默认文件名/扩展名/目录对齐 Netcatty（`0898…` 前的实现为 cwd + `.log`），补 2 个 picker 单测（主目录拼接、home 不可用回落）。

### 差异 / 待人工

- 会话日志默认格式/时间戳暂取 Netcatty 默认（txt、关闭），尚无设置项；设置中心「会话日志」分组留待后续。
- 「更多」菜单其余项（配置目录追踪/终端设置/终端编码）仍为禁用占位，下一轮逐项实现或置灰说明。
- 像素级细节（按钮尺寸/间距/圆角/悬停按下禁用态/菜单弹出位置与阴影）下一轮与 Netcatty 并排截图统一。
- 待人工：会话日志在「断开后立即点停止」的边界（当前断开时前端清空状态，按钮禁用）。

### 门禁

`npm run test:run` 358✓、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` 869✓；debug 实例 CDP 实机验证通过（截图 `shots/round2-*.png`）。代理 WIP `d633866`/`60d8deb` 未动。

## 2026-11-03 — 终端工具栏：逐按钮对照表 + 会话日志 / 脚本录制拆分（本轮）

**用户点名纠正**：「开始会话日志」与「开始录制」是 Netcatty 的两个独立功能。此前 termX 把它们合并进同一个会话级共享录制槽（asciicast / `.cast` 产物），是错误建模；本轮拆成两套独立能力。

### 两项拆解（逻辑差异）

| 维度 | 开始会话日志（手动文本日志） | 开始录制（脚本录制） |
|---|---|---|
| 入口 | 终端工具栏 `file-text` 图标（常显） | 终端 More actions（默认折叠） |
| 图标 / 提示 | 文件文本图标；悬停「开始记录会话日志」/「会话日志录制中（点击停止）」 | 录制圆点图标；菜单项「开始录制」/「停止录制」 |
| 点击行为 | 先弹原生保存对话框选路径，再开始流式写文件；录制中再点=停止 | 不开对话框，直接开始捕获输入；录制中再点=停止并生成脚本片段 |
| 产物 | 本地文本文件（Netcatty 默认 txt，去 ANSI；可选 raw/html + 时间戳），默认 `主目录/<会话名>_<YYYY-MM-DDTHH-mm-ss>.<ext>` | 脚本库一条「录制 HH:MM:SS」片段（kind=script，命令序列，间隔 >1s 生成 `sleep`） |
| 存放 | 用户选择的本地路径（默认主目录） | termX 片段库（DB） |
| 互斥 | 每个会话独立，可多会话同时记录 | **全局单会话互斥**；其它终端开启时报「已有其他终端正在录制」 |
| 能否同时 | 可与脚本录制同时开启（互不影响） | 可与文本日志同时开启 |
| 停止 / 断线 | 停止即 flush 并关闭文件；断线时后端随会话任务收尾 | 断线时前端丢弃缓冲并清 REC；不生成片段 |
| termX 后端 | 新增 `TextLogRecorder`（`terminal/recorder.rs`）+ `ActiveTextLog` 槽 + 4 命令（start/stop/status），与 asciicast 完全分离 | 纯前端 `scriptRecording.ts`（缓冲 → `buildScriptCommand` → `save_snippets`），无后端录制槽 |

**上一轮错因**：两者共用 `SessionHandle` 的单一录制槽与 `.cast` 产物，导致「日志」按钮实际启动 asciicast、More「开始录制」被抢占/状态错乱。本轮已删除共享语义，`text_log_slot` 与 `recorder_slot` 在 `session_task` 内并行写入、各自 stop/finish。

### 被圈按钮对照表

| 按钮 | Netcatty 行为 | termX 现状（本轮后） | 差距 / 验证 |
|---|---|---|---|
| 命令历史（时钟） | 点击弹出历史命令列表，可点选回填 | 已实现 popover，输入经 `onData` 记入（上限 200） | 一致；CDP 实测开合、条目出现 |
| 关键词高亮（荧光笔） | 弹出关键词管理，回车新增/点击移除；终端内高亮 | 已实现 popover + `registerDecoration` 行高亮（`allowProposedApi`） | 一致；实测高亮生效 |
| SFTP（文件夹） | 打开当前主机 SFTP | 已实现，切 SFTP surface | 一致 |
| 撰写栏（铅笔） | 打开多行撰写条，整段发送 | 已实现，`sendCompose` 整段 + 回车 | 一致；实测可开 |
| 终端搜索（放大镜） | 打开搜索条，上下查找并滚动 | 已实现 buffer 行扫描 + `scrollToLine` | 一致；实测可开 |
| 会话日志（文件文本） | 未连接且未记录时禁用；点击→保存对话框→开始；记录中点击=停止；显示 LOG 徽标 | 已实现；禁用条件 `!isSsh || busy || status !== connected`；LOG 徽标显示完整路径 | 本轮补齐默认格式/扩展名/目录；真机验证见下 |
| More：开始录制 / 停止录制 | 脚本录制入口（见上表） | 已接通，REC 徽标 | 一致；真机验证见下 |
| More：命令历史 | 同工具栏时钟 | 已接通 | 一致 |
| More：配置目录追踪 / 终端设置 / 终端编码 | 各自设置面板 | 仍 disabled 占位 | 留下一轮逐项实现或置灰+悬停原因 |

### 本轮修复（对齐 Netcatty 的可见行为）

1. 会话日志默认格式由 `raw` 改为 `txt`（去 ANSI），扩展名 `.log` → `.txt`。
2. 默认文件名时间戳由 `YYYYMMDD_HHmmss` 改为 `YYYY-MM-DDTHH-mm-ss`。
3. 默认保存目录由进程 cwd（debug 下为 `target/debug`）改为用户主目录（`localHome()` 拼接，失败退回仅文件名）。
4. 新增 2 个前端单测覆盖默认路径拼接与主目录不可用回退。

### 真机验证（129，WebView2 CDP）

- 会话日志 UI 链路：工具栏按钮 → 原生「保存会话日志」对话框 → 确认 → LOG 徽标显示完整路径 → 终端执行 `echo termx-ui-log` → 点按钮停止 → 徽标消失；文件落盘且含输入与输出。
- 会话日志 live 写入（raw）：`start_manual_session_log` → `echo termx-log-live-ok2` → 停止：文件 178B，含命令回显与输出（证明 `session_task` 双写接线正确）。
- 同时开启：文本日志（txt + 时间戳）+ More 脚本录制同时进行，执行 `echo termx-both2` → 停止两者：日志文件 337B（去 ANSI、逐行 `[HH:MM:SS.mmm]`），片段库新增 `录制 23:50:15 :: echo termx-both2`。两者互不干扰。
- 脚本录制单独：REC 徽标 → 输入 `id` → 停止 → 片段 `录制 23:29:05 :: id`。
- 证据截图：`shots/round2-log-live.png`、`round2-log-ui2.png`、`round2-log-stop.png`、`round2-both2.png`、`round2-more.png`。
- 已知测试踩坑：页面 reload 后存在多个已挂载窗格，须取「可见」窗格（`getBoundingClientRect().width>0`）的 sessionId，否则日志会开在隐藏死会话上（首测 0 字节即此原因，非产品缺陷）。

### 待人工 / 下一轮

- 默认主目录 `.txt` 的真机复测：热更新导致会话掉线，本轮仅单测覆盖；下一轮带新会话复测并截图。
- Netcatty More 菜单「打开会话日志 / 在文件夹中显示」及会话日志格式/目录设置：下一轮随 More 菜单补齐。
- Netcatty 并排截图 + 像素级尺寸/间距/图标/悬停/禁用态统一：下一轮。
- 「更多」菜单逐项实现；确实做不出的置灰并在悬停说明原因（不删项）。

### 门禁

- `npm run test:run` 358✓、`npm run build`✓、`cargo check --features server`✓、`cargo test --lib` 869✓。

### Review 修复（本轮内）

- **中危**：断线 / 关标签时 `endScriptRecording(sidRef.current)` 传空串导致全局脚本录制槽不释放（其它终端永久「已有其他终端正在录制」）→ 新增 `scriptRecSidRef` 记录录制会话，断线与卸载按它释放。
- **中危**：关键词高亮每轮从末行重扫，重复注册 decoration 且无限增长 → 改为只扫新增行（`lastLine=buf.length`）+ 首次全量扫描 + 最多保留 500 个装饰器。
- **中危**：`strip_ansi` 仅识别 BEL 结尾的 OSC，ST（`ESC \`）结尾会吞掉后续全部输出 → 支持 ST 结束并新增单测。
- **低危**：`session_log_path_invalid` 补 i18n；`format_invalid` 文案由「导出格式」改为「日志格式」；`already_recording/not_recording` 改为日志语义。
- 未修（记录待后续）：session_logs 新命令错误分支缺单测；`let _ = record()` 吞 IO 错误且 BufWriter 无周期 flush；sudo/密码可能被录入命令历史与片段。

## 2026-11-04 — 「更多」菜单逐项实现 + 工具栏/菜单像素级统一（本轮）

目标：把终端工具栏右侧「更多」菜单从 3 项禁用占位，补齐为与 Netcatty 逐项等价；同时按同分辨率同缩放截图量对，统一工具栏与菜单的像素细节。

### Netcatty「更多」菜单逐项对照表（源码 `components/terminal/` + zh-CN i18n）

| # | 菜单项 | 图标 | 点击行为 | 可用 / 禁用条件 | 快捷键提示 | termX 现状（本轮后） | 差异 |
|---|---|---|---|---|---|---|---|
| 1 | 命令历史 | `clock` 12px | 直接弹出命令历史 popover，点选回填；不弹对话框 | 仅 SSH；未连接时文案变「连接后可用」并置灰 | 无 | 已实现，条件一致，禁用时行内备注同样显示「连接后可用」 | 一致 |
| 2 | 配置目录追踪 | `compass` 类图标 12px | 先弹对话框：列出「可能写入的文件」+「将执行的命令」，确认后执行并 reload；非直接执行 | 仅 SSH 且已连接 | 无 | 已实现 `.term-osc7-modal`（目标文件 chips + 命令预览 + 取消/执行配置） | 一致；hook 为精简版（见缺口） |
| 3 | 终端设置 | `settings` 12px | 打开设置中心对应面板，不直接改终端 | 始终可用 | 无 | 已接通：`onOpenSettings` → 设置中心（当前落在「外观」tab，对齐 `onOpenTheme` 语义） | 面板指向待设置页补齐后收敛 |
| 4 | 开始录制 / 停止录制 | `circle-dot` 12px | 直接开始捕获输入（无对话框）；录制中同一行变为「停止录制」 | 仅 SSH 且已连接；全局单会话互斥，其它终端开启时提示「已有其他终端正在录制」 | 无 | 已实现，菜单标题随录制态切换，停止写入「脚本」片段 | 一致 |
| 5 | 终端编码 | `languages` 12px | hover / 点击展开二级列表（UTF-8 / GB18030），当前项带 `check`；选择即生效并持久化 | SSH / Telnet 可切换；不支持切换的传输 Netcatty 直接隐藏该项 | 无 | 已实现二级列表 + check + 持久化；不支持的传输**保留条目并置灰**，行内与 `title` 写明原因（串口「连接表单内配置」、本地「沿用系统编码」） | 刻意差异：Netcatty 隐藏，termX 按用户要求保留 + 说明 |

补充：Netcatty 该菜单**无分隔线分组、无快捷键提示、无快捷键列**，全部左对齐，弹出方向为 `align=end sideOffset=4`；termX 保持一致（没有为凑数增加分隔线）。

### 像素级统一（同分辨率 1400×1140、scale 1.36 截图量对）

| 属性 | Netcatty（源码 / 截图实测） | termX 本轮 |
|---|---|---|
| 工具按钮尺寸 | `h-6 w-6` = 24×24 | `.term-tool-btn` 20 → **24×24** |
| 按钮圆角 | `rounded-md` = 6px | 4 → **6px** |
| 按钮间距 | `gap-2` = 2px，步进 26px | `gap 6` → **4px 容器 gap + 2px 组内**，实测步进 26px |
| 行内图标 | 12px | **12px**（More 触发与组内按钮一致） |
| 悬停底色 | 显式 `hover:bg-transparent`（无填充） | 原 `--secondary` 填充 → **transparent**，150ms 过渡 |
| 激活态 | `bg-secondary` + 图标变亮 | **`hsl(var(--secondary))`** |
| 工具栏高度 / 内边距 | 28px / 4px 水平 | 30 → **28px**，`padding: 0 4px`，左组 gap 4px |
| 菜单宽度 | `w-48` = 192px | **192px**（CDP 实测） |
| 菜单内边距 / 圆角 | `p-1` 4px / `rounded-md` 6px | **4px / 6px** |
| 菜单行高 | `px-2 py-1.5 text-xs` = 28px | 30 → **28px** |
| 菜单行圆角 / 字号 / 间距 | 4px / 12px / 8px | **4px / 12px / 8px** |
| 分隔线 | 无 | **无** |
| 边框 | `border border-border/60` | **`hsl(var(--border)/0.6)`** |
| 阴影 | `shadow-md` | **`0 4px 6px -1px rgb(0 0 0/.1), 0 2px 4px -2px rgb(0 0 0/.1)`** |
| 弹出位置 | `align=end sideOffset=4` | `right:0; top: calc(100% + 4px)` |
| 出现动画 | Radix zoom-fade 150ms | **`term-menu-in 150ms cubic-bezier(0.16,1,0.3,1)`**，scale .95→1 + fade，origin top right |
| 禁用态 | 半透明 + 默认光标 | **`opacity:.5; cursor:default`**（保留 pointer-events 让 `title` 悬停说明可见） |

顺带修复：`.term-history-menu` 之前沿用 `right:0` 端对齐，popover 会横跨到主机侧栏上方（实测 x≈0）；改为 `left:0; right:auto` 锚定时钟按钮正下方。

### 实现要点

1. **命令历史**沿用上一轮实现（200 条上限、点选回填），本轮只随菜单语义统一禁用条件与行内备注。
2. **配置目录追踪**（新）：
   - `src/terminal/osc7.ts`：bash `PROMPT_COMMAND` / zsh `add-zsh-hook precmd` / fish `fish_prompt` 三种 hook，幂等（`grep -Fq` 后才 append），按 `$SHELL` 选 rc 文件，执行后打印 `__TERMX_OSC7_SHELL__` / `__TERMX_OSC7_CONFIG__` 供前端解析并 reload。
   - `Terminal.tsx` 新增 `onOsc7` prop，`term.parser.registerOscHandler(7, payload)` 上抛；`TerminalPane` 用 `parseOsc7Cwd` 解析 `file://host/path`（含 `decodeURIComponent` 兜底），菜单项标题变为「配置目录追踪（已启用：<cwd>）」。
   - 对话框 `.term-osc7-modal`：说明文案、目标文件 chips、`pre` 命令预览（可滚动）、取消 / 执行配置、busy 文案。
3. **终端设置**：`App.tsx` 新增 `settingsTab` 状态 + `SettingsDialog initialTab`，`Workspace` / `TerminalPane` 透传 `onOpenSettings`；点「更多 → 终端设置」直接打开设置中心。
4. **终端编码**：
   - 前端 `src/terminal/terminalEncoding.ts`：`utf-8 | gb18030`，按 hostId 持久化 `termx.terminalEncoding.<hostId>`；`supportsEncodingSwitch`（ssh/telnet true，serial/pty false）；`createTerminalDecoder` 返回流式 `TextDecoder`（跨 chunk 多字节安全）。
   - 后端 `src-tauri/src/terminal/encoding.rs`：`is_gb18030` 归一化别名（gbk/gb2312/cp936/ms936）；`encode_terminal_input` 用 `encoding_rs::GB18030` 重编码输入；接入 `ssh_write` / `telnet_write` 与 `server.rs` 无头分发（浏览器无 gb18030 encoder，故输入侧必须后端做）。
   - 输出侧 `TerminalPane.writeTerminalOutput` 按当前编码解码，`decoderRef` 随编码切换重建。
5. **样式**：上表全部落到 `src/styles.css`；新增 `.term-menu-text`（flex:1 + ellipsis）、`.term-menu-note`（11px 备注）、`.term-menu-check`、`.term-menu-sub-list`、`.term-menu-label`、`.term-osc7-modal` 系列。

### 真机验证（129 `tianzry@192.168.126.129`，WebView2 CDP + 原生截图）

- 菜单几何：CDP 实测宽度 192px、padding 4px、圆角 6px、5 行 × 28px、阴影与 Netcatty 一致；行内备注与禁用不透明度正确。
- 命令历史：popover 列出 `echo recorded-cmd`、`echo termx-history-test`，点选可回填。
- 终端设置：点击后设置中心打开并落在「外观」tab（截图确认）。
- 配置目录追踪：对话框显示目标文件与命令 → 执行配置 → 自动 reload → 重开「更多」显示「配置目录追踪已启用：/home/tianzry」，证明 OSC 7 hook 已生效且 cwd 已回传。
- 终端编码：二级列表打开、UTF-8 带 check；切 GB18030 后 `localStorage["termx.terminalEncoding.<hostId>"] = "gb18030"`，切回 UTF-8 亦持久化；输入转码由 Rust 单测覆盖，输出解码由前端单测覆盖。
- 开始录制 / 停止录制：激活后行标题变「停止录制」，停止时 toast「脚本录制已停止，已保存到「脚本」：录制 08:45:08」。

### 差异 / 已知缺口（记录待后续，不删项）

- **终端编码项在不支持的传输上**：Netcatty 隐藏，termX 置灰 + 原因（用户硬性要求不删条目）。
- **OSC 7 hook 未做 percent-encoding**：含空格 / 中文目录写出的 URI 可能不严格合规，解析侧已做 `decodeURIComponent` 兜底；后续可补。
- **cwd 仅用于菜单标题**：尚未接入 SFTP 跟随目录 / 状态栏显示（Netcatty 的 OSC 7 主要目的之一是 sudo/su 后 SFTP 跟随）。
- **终端设置指向**：当前打开「外观」tab（对齐 Netcatty `onOpenTheme`），设置中心「终端」tab 的完整移植已登记为下一轮。
- **会话日志按钮下拉**（Netcatty 的「打开 / 在文件夹中显示 / 打开方式…」）仍未实现，仍为「点击=开/停」；登记待后续。
- **GB18030 会话日志**：日志落盘未按终端编码转码，gb18030 会话的 txt 日志可能出现乱码，待后续。
- 串口编码固定（表单内配置），编码切换只覆盖 SSH / Telnet。

### 门禁

- `npx tsc --noEmit` ✓、`npm run test:run` **31 文件 / 373✓**、`npm run build` ✓（2.09s）。
- `cargo check --features server` ✓、`cargo test --lib` **874✓**、debug `cargo build` ✓。
- 代理 WIP `d633866` / `60d8deb` 未触碰。

## 2026-11-04 · 设置中心「外观」tab 1:1 复刻

**取证**：Netcatty 源码 `components/settings/tabs/SettingsAppearanceTab.tsx`、`infrastructure/config/uiThemes.ts`、`uiFonts.ts`、`application/state/uiFontStore.ts`、`domain/colorContrast.ts`、`infrastructure/config/appIconVariants.ts`、`electron` 主进程窗口接口。运行中 Netcatty 本轮不可用（仓库内无 electron 运行时 / dist / 安装包），像素比对退化为「源码量值 + termX 真机截图自检」，已登记为复核缺口。

### 逐项对照

| 项 | 之前（降级实现） | 本轮（1:1） |
| --- | --- | --- |
| 主题预设库 | 只有 snow / midnight，且 id 存了不生效 | 原样移植 `uiThemes.ts`：浅色 62 + 深色 62 个预设（含每个预设 19 个调色令牌），`getUiThemeById` 未知 id 回落首个预设 |
| 主题色选择 UI | 两个原生 select | 模式分段控件（sun / monitor / moon）+ 当前模式色板（24px 圆形、选中 2px 环 + 1.1 倍、title 显示预设名） |
| 强调色 | 单个 `<input type=color>`，前景不跟随 | 18 个 Netcatty 原值色板 + 自定义取色圆钮；`--primary/--accent/--ring` 同步，前景按 WCAG 对比度自动黑/白（`resolveReadableForegroundForHsl` 等价实现） |
| UI 字体 | 原生 select + 全系统字体，回退链写死 | 搜索型 combo（搜索框 + 过滤 + 当前项勾选 + Esc 关闭）；22 个 Netcatty 预设（默认 Mona Sans）+ 本机字体；`withUiCjkFallback` + Windows emoji 前置链 |
| 窗口透明度 | `.nc-shell { opacity: var(...) }` CSS 近似（桌面不可见） | Windows 原生 `WS_EX_LAYERED + SetLayeredWindowAttributes`（与 Electron `setOpacity` 同机制）；删除 CSS 叠加 |
| 背景模糊 | Windows 也渲染，开关无效果 | 与 Netcatty 相同 `isMac` 条件：Windows/Linux 不渲染该行；macOS 走原生 HudWindow vibrancy（`set_effects`） |
| 应用图标变体 | 5 项 select，只存 localStorage | 12 项缩略图网格（经典 / 白色系列 / 特别款三组）；PNG 编进二进制，`tauri::image::Image` 解码后 `set_icon` 应用到所有窗口 |
| 主机库 6 开关 | 全部只写 localStorage、无消费方 | 逐项接通：最近连接区、单击行为（设置中心单一数据源，删除 `termx.vault.click.v1`）、根目录仅未分组、SFTP 标签（隐藏 + 自动回主机库）、主机列表侧栏（侧栏与切换钮同时隐藏）、known_hosts 自动导入 |
| 自定义 CSS | 已注入 | 保持逐键即时注入（Netcatty 为 draft 即时 + commit 防抖）；实测即时生效、清空即恢复 |
| 语言 | en 词典仅 13 键 | 外观 tab 全量 en（语言/字体/窗口/主题/强调色/图标/主机库/CSS）；其余 tab 仍回落 zh-CN（登记缺口） |

### 真机验证（WebView2 CDP + Win32 + 重启）

- 主题：切深色 → `--background = 220 28% 10%`，全站（侧栏/内容/弹层）即时变化；色板点选即时切换。
- 强调色：开启自定义 → 点红色 → `--primary = 0 84.2% 60.2%`、`--primary-foreground = 0 0% 100%`、`--ring` 同值。
- 字体：combo 共 122 项（22 预设 + 100 本机）；选 Inter 后 `--termx-ui-font` = `"Segoe UI Emoji", "Inter", system-ui, PingFang SC…`；已恢复 Mona Sans。
- 透明度：70% 预设 → Win32 读回 `WS_EX_LAYERED = true`、`alpha = 179`；重启后 100% → `alpha = 255`，证明持久化与启动即应用。
- 图标：直接 invoke `set_app_icon_variant('rainbow')` 成功（PNG 解码 + 全窗口 set_icon）；重启恢复 original。
- 开关：关闭「最近连接」→ 主机库最近区消失；关闭「SFTP 标签页」→ 顶部 SFTP 标签消失；重启后全部恢复。
- 自定义 CSS：输入 `.nc-shell{outline:3px solid red}` → 计算样式 `outline: red`；清空恢复。
- 语言：切 en → 外观 tab 全英文；切回 zh-CN。
- 截图：`appearance-1 / dark / accent / lower / en / css / fontcombo2 / final`。

### 已知缺口（登记，不删项）

- 运行中 Netcatty 本轮无法启动（仓库无 electron/dist，安装包不存在），并排像素复核待下一轮。
- macOS 窗口透明度：Tauri 无 `setOpacity` API，当前仅 Windows 原生；mac 仍缺。
- 背景模糊在 Windows 不渲染（与 Netcatty 一致），没有 Windows 等效模糊；mac 原生路径已就位但未验证。
- 语言切换只覆盖设置中心；应用其余界面约 2957 处中文硬编码，需独立 i18n 轮次。
- 网络代理 WIP 未触碰。

### 门禁

- `npm run test:run` 31 文件 / **378✓**、`npm run build` ✓。
- `cargo check --features server` ✓、`cargo test --lib` **874✓**、debug 构建 ✓。

### review 修复（同日复检）

| 评审项 | 修复 |
| --- | --- |
| 高·每次设置变更重发 3 个原生 IPC 且可能乱序 | `applyNativeWindowChrome` 改为「期望值 / 已应用值」串行 drain：值相同直接跳过，连续变更只下发最终态，失败不更新基准（下次自动重试）；删除死代码 `reapplyNativeChrome` |
| 高·「自动导入系统 known_hosts」开关实际无效 | termX 的已知主机列表本身就是系统 `~/.ssh/known_hosts`（`known_hosts_scan_system` 只解析计数、不写库），导入无意义：保留条目但置灰，行内说明追加原因；删除 VaultView 空转 effect |
| 中·系统主题切换只重绘不通知订阅者 | matchMedia listener 补 `emit()`，终端等订阅方即时跟随明暗 |
| 中·FontCombo 点外部 / Esc 不关闭 | 根节点 ref + document `mousedown` / `keydown` 监听（仅打开时挂载） |
| 中·appIconVariant 无白名单校验 | settingsModel 新增 `APP_ICON_VARIANTS` 白名单，非法值回落 `original`（+1 单测） |
| 低·uiThemes 头注释数量错误 | 64 / 67 → 62 / 62 |
| 低·死键 | 删除 `settings.appearance.fonts.systemFont`（zh/en），补 en `settings.appearance.language.en` |

复跑门禁：`npm run test:run` 31 文件 / **378✓**、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` **874✓**。

## 2026-11-04 · 设置中心「终端」tab 1:1 复刻

**取证**：本轮重读 Netcatty `components/settings/tabs/SettingsTerminalTab.tsx`、`SettingsTerminalTabControls.tsx`、`TerminalBehaviorSettings.tsx`、`TerminalFontSelect.tsx`、`TerminalCjkFontSelect.tsx`，量值来自 `infrastructure/config/fonts.ts`（`MIN_FONT_SIZE` / `MAX_FONT_SIZE`）、`resolveXTermScrollback` 与 xterm 建项路径；默认值逐键对照 `types/global/settings` 默认对象。运行中 Netcatty 仍不可用（无 electron / dist），像素并排复核继续登记为缺口。

### 逐项对照

| 区域 | 项 | 之前 | 本轮（1:1） |
| --- | --- | --- | --- |
| 主题 | 终端主题跟随应用 | 已有开关但深/浅切换时终端不跟随 | `followAppTheme` 订阅设置 + `onSystemThemeChange`，深浅主题即时重建 `term.options.theme`；关闭时固定深色并显示说明行 |
| 字体（9 项） | 字体族 | 单一文本框 | 搜索型 combo（Auto + 本机字体，写入 `fontFamily`），Auto 走 `resolveFontFamily` 回退链 |
| 字体（9 项） | 中文 / CJK 字体 | 无 | combo（Auto + 已列出 CJK 字体），Auto 时按主字体搭配并叠加 CJK 回退 |
| 字体（9 项） | 字号 | 14，范围未限 | `clamp [10, 32]`（Netcatty `MIN/MAX_FONT_SIZE`），Stepper 到边界禁用按钮，改后 `term.options.fontSize` + `fit()` 即时生效 |
| 字体（9 项） | 字重 / 粗体字重 | 无 | 两个 select（100–900 九档），落 `fontWeight` / `fontWeightBold` |
| 字体（9 项） | 字体平滑 | 无 | `term-no-smoothing` CSS（`-webkit-font-smoothing:none` / `text-rendering:optimizeSpeed`），容器 class 即时切换 |
| 字体（9 项） | 字体连字 | 无 | `term-ligatures` CSS（`font-feature-settings:"liga" 1,"calt" 1`） |
| 字体（9 项） | 行间距 | 无 | 滑杆 0–10，映射 `lineHeight = 1 + value/10`，即时 `term.options.lineHeight` + `fit()` |
| 字体（9 项） | 终端仿真类型 | 硬编码 `xterm-256color` | select（`xterm-256color` / `xterm-16color` / `xterm`），`ssh_connect` 读取设置后 `set_terminal_emulation_type`，`request_pty` 使用该 TERM |
| 光标（4 项） | 样式 | 已有 | select 块/竖线/下划线 → `cursorStyle` |
| 光标（4 项） | 竖线粗细 | 无 | 滑杆 1–4px，`clampCursorBarWidth` → `cursorWidth` |
| 光标（4 项） | 闪烁 | 已有 | `cursorBlink` |
| 光标（4 项） | 高亮当前行 | 无 | `CursorLineHighlighter`：`registerDecoration` 铺淡色底，跳过 alternate buffer 与选区，`onCursorMove/onWriteParsed/onRender/onSelectionChange/onResize` 驱动 |
| 键盘（3 项） | Option 作 Meta / Option+←→ 按词 / Kitty 协议 | 无 | 行保留但置灰 + 行内 `row.unsupported`；`altAsMeta` 值仍写入 `macOptionIsMeta`（Windows 无实际效果，故 UI 禁用） |
| 行为 | 退出后自动关闭 | 无 | 关闭回调中 `autoCloseOnExit` → `onClosePane` |
| 行为 | 连接断开时（终端内提示 / 弹窗） | 旧 `disconnectPrompt` 布尔 | 枚举迁移（true→dialog / false→terminal）；terminal 模式写灰色提示并允许 Enter 重连，首次连接失败仍用弹窗 |
| 行为 | 右键行为 | 只有菜单 / 粘贴 / 无 | 三值 `context-menu` / `paste` / `select-word`（旧 `menu→context-menu`、`none→context-menu`）；选词按 cell 坐标 + `wordSeparators` 计算并 `term.select` |
| 行为 | 右键长按菜单 | 无 | 450ms 长按计时，仅在右键为粘贴/选词时生效；全屏应用接管鼠标时按 `showContextMenuOverFullscreenApps` 决定是否弹菜单 |
| 行为 | 中键行为 | 无 | 三值 `context-menu` / `paste` / `disabled`（旧 `menu→context-menu`、`copy→paste`、`none→disabled`） |
| 行为 | 选择即复制 / 复制规范化 | 无 | `onSelectionChange` 写剪贴板；`normalizeTerminalSelection` 去掉行尾填充空格并拼接软换行；菜单复制同样走规范化 |
| 行为 | 单词分隔符 | 已有（仅双击） | 设置值落 `term.options.wordSeparator`，双击与右键选词共用 |
| 行为 | 括号粘贴 | 无 | `disableBracketedPaste` → `ignoreBracketedPasteMode` |
| 行为 | 多行粘贴确认 | 无 | 勾选后粘贴前 `confirm`，阈值行数可调（默认 2），仅拦 paste 事件 |
| 行为 | Shift+Enter 开关 / 文本 | 硬编码 `\x1b\r` 且默认关 | 默认开、序列 `\e\r`（可改，支持 `\e \r \n \t \\ \xNN` 转义解码），`attachCustomKeyEventHandler` 拦截 |
| 行为 | 标签双击 | 双击进入重命名输入 | `duplicate` / `copy` / `disabled`（默认 duplicate，两者都复制标签），移除重命名编辑状态 |
| 行为 | OSC 52 剪贴板 | 无 | 四值 `off` / `write-only` / `read-write` / `prompt`；`parser.registerOscHandler(52)` 写入 / 读取（prompt 用 `confirm`） |
| 行为 | 滚动 4 项 + 平滑 | 无 | `scrollOnInput→scrollOnUserInput`、`scrollOnOutput`（`onWriteParsed`）、`scrollOnKeyPress`、`scrollOnPaste`、`smoothScrolling→smoothScrollDuration(120)` |
| 回滚 | 回滚行数 | 10000，固定 | number 0–100000；0 = 不限（映射 50000，`resolveXtermScrollback`），改后重建 `scrollback` |
| 侧边栏 | 自动打开 + 8 个面板 | 无 | `sidePanelAutoOpen` + `sidePanelAutoOpenPane`（默认 scripts；termX 仅 SFTP 可用，其余选项保留但行内说明不可用）；SSH/Telnet 连接成功后按设置打开 SFTP |
| 本地 Shell 侧栏 | 两组 | 无 | 按 Netcatty 行保留，全部置灰 + 行内说明（termX 本地终端无侧栏） |
| 连接 | 主机密钥校验策略 | 始终校验 | `verifyHostKeys` 经 `settings.center.v1` 下发 `set_verify_host_keys`，关闭时 `check_server_key` 直接 `Ok(true)` 并跳过 known_hosts 比对 |

### 默认值 / 取值范围对齐（对照 Netcatty 默认对象）

- 字号 14、范围 10–32；字重 400 / 粗体 700；行间距 0；回滚 3000、范围 0–100000（0 → 50000）。
- 光标：块 + 闪烁开 + 竖线宽 2 + 行高亮关。
- 行为默认：右键菜单、长按关、全屏也弹菜单关、中键粘贴、选择即复制关、复制规范化开、括号粘贴开、自动上传图片关、多行确认关（阈值 2）、Shift+Enter 开（`\e\r`）、退出自动关闭关、断开终端内提示、标签双击复制、动态标题 agent、OSC 通知 always、OSC 52 write-only、链接浏览器 netcatty / 无修饰键、滚动输入开 / 输出关 / 按键关 / 粘贴开、平滑关。
- 侧栏自动打开关、默认面板 scripts；主机密钥校验开；终端主题跟随开。

### 真机验证（WebView2 CDP + 重启）

- 字号 14→15：`term.options.fontSize` 与 `.xterm-rows` 字号即时变化；重启后仍 15。
- 字重 300：重启后 `fontWeight=300`，渲染变细。
- 竖线光标：`xterm-cursor-bar` class 出现；重启保持。
- 高亮当前行：decoration 数 1，截图见淡蓝行底；重启保持。
- 行间距 0→10：`lineHeight` 18.39→36.8，内容区即时重排（验证后复位 0）。
- 右键行为从 paste 改回 context-menu：真实 `contextmenu` 事件弹出 `.term-context-menu`（复制 / 粘贴 / 全选 / 插入片段 / 磁盘用量 / 运行脚本 / 浏览器 / 重新连接 / 分屏 / 清空缓冲区）。
- 截图：`shots/term-restart.png`、`term-final.png`、`term-menu2.png`。

### 未移植项（保留条目 + 置灰 + 行内原因）

altAsMeta（Windows 无 macOptionIsMeta 效果）、Option+←→ 按词、Kitty 协议、自动上传剪贴板图片、Shift+Enter 强制文本、clear 清回滚、保留选区、提示符换行、动态标签标题、OSC 通知、链接浏览器 / 修饰键、本地 Shell 侧栏两组、非 SFTP 侧栏面板。

### 已知缺口

- Netcatty 运行实例不可用，像素并排复核仍未做。
- 侧栏自动打开只接 SFTP（`forward` / browser / scripts 等无对应面板）。
- 终端仿真类型只影响 SSH 的 TERM 字符串；本地 PTY 仍由后端固定。
- 全应用 i18n 未覆盖（终端 tab 的 zh/en 已补齐）。

### 门禁

- `npm run test:run` 31 文件 / **379✓**、`npm run build` ✓。
- `cargo check --features server` ✓、`cargo test --lib` **874✓**。
- 代理 WIP `d633866` / `60d8deb` 与端口转发未触碰。

### review 修复（同日复检）

| 评审项 | 修复 |
| --- | --- |
| 高·主机密钥校验开关是进程级原子量，只有终端入口写入；独立 SFTP / 端口转发 / headless 读到上一次残留值（关闭校验后即使重新打开，这些入口仍跳过 known_hosts） | 新增 `commands::session::apply_ssh_runtime_settings`（统一从 `settings.center.v1` 读 `verifyHostKeys` + `terminalEmulationType`），在终端、独立 SFTP、端口转发、headless SSH/SFTP 入口连接前各刷新一次 |
| 高·OSC 52 的 `atob` 无保护，远端非法 base64 抛错会穿透 xterm 解析链路 | 解码包 try/catch；读剪贴板编码改逐字节拼接，避免 `String.fromCharCode(...bytes)` 在大文本时 RangeError |
| 中·复制规范化把换行符加在当前行（`isWrapped` 是「本行是延续行」），视觉折行会错行 | 改为「下一行不是延续行」时补换行，首行不加前导换行 |
| 中·字号 / 字重 / 行距热更新只改 options，不重排列数 | 设置订阅里补 `fit.fit()`，经 `onResize` 同步远端 PTY 尺寸 |
| 中·长按弹菜单后松手的 contextmenu 落在遮罩上会立刻关闭菜单，且标记不复位会吞下一次右键 | 长按标记改在窗格 `mousedown` 复位；`openContextMenu` 与遮罩 `contextmenu` 只跳过、不关闭 |
| 中·右键选词把 `translateToString` 的字符下标当单元格列，CJK / 宽字符偏移 | 按 `getCell` 的 `getWidth` 建立「字符 → 起始列」映射，选区起止与长度都按单元格计算 |

复跑门禁：`npm run test:run` 31 文件 / **379✓**、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` **874✓**。

## 2026-11-04 — 全应用逐功能比对第一轮（Vault 首页与分组 + 主机新建/编辑/连接）

> 基准：Netcatty 源码（`components/vault/`、`components/HostDetailsPanel.tsx`、`components/host/HostTreeGroupDeleteDialog.tsx`、`application/state/useVaultHostDeletion.ts`、`application/app/AppShell.tsx`）+ termX debug 实机（129 CDP 截图）。
> Netcatty 运行实例不可用，逐项为源码取证 + termX 实机验证。

### 差异清单（功能逻辑 / UI）

| 模块 | 项目 | 判定 | 处理 |
| --- | --- | --- | --- |
| Vault 分组 | 删除分组原为原生 `confirm`，且固定「主机变未分组」；Netcatty 为应用内 `HostTreeGroupDeleteDialog`，带「同时删除该分组下的所有主机」勾选 | 行为不一致 + 交互不一致 | 新增 `GroupDeleteDialog`：单组/批量标题与文案、分组路径、勾选（仅组内有主机时显示）、取消/删除；确认后删组，勾选时一并删组内主机并清理置顶/标签/选择状态 |
| Vault 分组 | 新建的空分组在首页/树中不显示（`count > 0` 过滤），导致无法重命名/删除；Netcatty `displayedGroups` 包含空分组 | 行为不一致 | 去掉空分组过滤：网格显示「0 台主机」卡片，树视图保留空分组节点；「未分组」仍仅在有主机时出现 |
| Vault 分组 | 多选删除原统一 `confirm`（主机 + 分组混删） | 交互不一致 | 对齐 Netcatty：只选主机 → 直接批量删除（不弹确认）；含分组 → 走分组删除对话框（勾选删除组内主机，并包含已选主机） |
| Vault 主机 | 单台主机删除原为原生 `confirm` | 交互不一致 | 改为应用内确认框，标题对齐 Netcatty「删除主机“{name}”？」，取消/删除 |
| 主机表单 | 详情面板默认宽 380；Netcatty `HostDetailsPanel` 为 `w-[420px]` | 视觉偏差 | 默认读数改为 420（仍保留用户拖动后的本地记忆） |
| 主机表单 | 头部测试/保存/关闭图标 15px；Netcatty 16px | 视觉偏差 | 改为 16px |
| 主机表单 | `Profile.init_command` 后端已生效（`server.rs` 连接后写入命令 + 换行），但 Vault 表单无入口，仅旧 `ConnectionManager` 能填 | 功能逻辑缺口 | 新增「启动命令」分区（`terminal-square` 图标 + 3 行等宽 textarea + 说明），保存后重连生效 |
| 主机表单 | 缺少 Netcatty 的痛点分区：SFTP 文件协议/Sudo/文件名编码、图标、备注（主机关联笔记）、自动化连接脚本、外观/mosh/X11/算法/keepalive/超时/设备类型/环境变量/代理/跳板、启动命令 runMode | 功能逻辑缺口 | 未实现项不放假控件：SFTP/图标字段后端未被消费、代理与跳板属暂停范围、备注属 notes「关联主机」缺口、自动化脚本为 Netcatty 新能力；全部登记 TODO 后续项 |

### 复核无差异

- Vault 首页：三视图（网格/列表/树）、关键字搜索、7 种排序、标签筛选、置顶、最近连接、多选批量、右键菜单（连接/SFTP/浏览器/编辑/复制/复制地址/复制账号密码/置顶/删除）、快速连接与快速切换器、框选与方向键导航。
- 新建流程实测：新建 → 填名称/地址 → 保存 → 卡片出现；编辑回填正常；重复主机名、地址为空时保存按钮禁用与 Netcatty 一致。

### 实机验证（129 CDP，debug 重编后）

- 空分组：新建 `r1-g2` 后首页显示「0 台主机」卡片，树视图保留节点。
- 分组删除：对话框 448px，勾选文案横排；勾选后同时删除组内主机，组与主机均消失。
- 主机删除：应用内确认框；取消保留、确认删除。
- 启动命令：`echo r1` 保存后重开编辑回填一致。
- 连接流程：右键 129 → 连接，直达终端标签并出现 shell 提示符。

### 门禁

- `npm run test:run` 31 文件 / **379✓**、`npm run build` ✓。
- `cargo check --features server` ✓、`cargo test --lib` **874✓**（本轮无 Rust 改动）。
- 代理 WIP `d633866` / `60d8deb` 与端口转发未触碰。

---

## 2026-11-04 — 全应用逐功能比对第一轮（终端标签与分屏 + 工具栏与更多菜单）

对照基准：`Netcatty/components/TopTabs.tsx`、`components/top-tabs/SessionTabContextMenuContent.tsx`、`components/terminal/TerminalToolbar.tsx`、`components/terminal/TerminalView.tsx`（TerminalToolbar 位于顶部信息栏右侧，非底部状态栏）。

### 差异清单与修复

| 项 | 功能逻辑 | UI | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 标签右键菜单 | 缺「重新连接」、关闭左侧/全部、禁用态 | 无分隔线、危险项无红色 | 行为 + 交互 | 已补齐：复制标签页/重命名/重新连接/关闭/分隔线/关闭其他/关闭左侧/关闭右侧/关闭所有；按锚点位置置灰批量项；关闭为危险色 |
| 标签中键关闭 | 缺 | — | 交互 | 已加 `onAuxClick`（button 1） |
| 标签拖拽排序 | 缺 | — | 交互 | 已加 `draggable` + `onMoveTab` |
| 标签重命名 | 缺（`renameTab` 未接线） | — | 行为 | 已加重命名模态（Enter 保存 / Esc 取消 / 空值禁用） |
| 重新连接 | 缺标签级入口（仅断线面板重连） | — | 行为 | `PaneHandle.reconnect` + `Workspace.reconnectTab`，始终调用最新 connect 闭包 |
| 关闭左侧 / 关闭全部 | 缺 | — | 行为 | `Workspace.closeLeft` / `closeAll`，关闭全部回到 Vaults |
| 分屏后右窗格标题 | 标题被右侧图标组挤成 0 宽 | — | 视觉 | `.term-toolbar-left` 加 `min-width: 3rem`，标题保留并省略 |
| 终端底部黑条 | — | 浅色主题下底部露 1 行黑色（`xterm-viewport` 默认黑） | 视觉 | 容器底色跟随主题（`applyTermBackground`，设置变更实时同步）+ `.xterm-viewport` 透明 |
| 工具栏项与顺序 | 与 Netcatty 一致（highlight/sftp/browser/compose/search/sessionLog/scripts + ⋮） | 按钮 24×24、图标 12px 一致 | 无差异 | — |
| YMODEM 发送/接收 | 未实现（串口专属） | — | 行为 | 未加假按钮，登记 todo |
| 打开会话日志（openSessionLog） | 未实现（日志视图无终端入口） | — | 行为 | 未加假按钮，登记 todo |
| 工具栏自定义布局（show/collapse/hide、右键定制） | 未实现 | — | 交互 | 登记 todo（默认折叠项已按 Netcatty 顺序放在 ⋮ 内） |

### 实机验证（129 CDP，debug 重编后）

- 三个本地标签：右键菜单项顺序/文案/禁用态正确，分隔线与危险色生效（截图 `r2-menu2.png`）。
- 重命名：改为「生产跳板」后标签标题即时更新（`r2-renamed.png`）。
- 中键关闭：3 → 2 个标签。
- 拖拽：首标签拖到第二位，顺序互换。
- 关闭左侧：仅保留右键锚点及其右侧标签；关闭全部：标签清空并回到 Vaults。
- 重新连接：本地标签执行后 PTY 重启并重新输出 shell 横幅。
- 分屏：右键「水平分屏」→ 2 窗格；拖动分隔条 `flexGrow` 变化；两格标题均可见。
- 终端底色：`viewport` 透明 + 容器 `#ffffff`，底部黑条消失（`r2-final2.png`）。

### 门禁

- `npm run test:run` 31 文件 / **379✓**、`npm run build` ✓。
- `cargo check --features server` ✓、`cargo test --lib` **874✓**。
- 代理 WIP `d633866` / `60d8deb` 与端口转发未触碰。

---

## 2026-11-04 — 全应用逐功能比对第一轮（串口 + Telnet + 本地终端）

对照基准：`Netcatty/components/SerialConnectModal.tsx`、`components/vault/VaultViewLayout.tsx`（terminal/serial 入口）、`components/LocalShellHostDetailsPanel.tsx`、`components/TelnetConnectModal`（实际走 `QuickConnectWizard` telnet://）。

### 逐项结论

| 项 | 功能逻辑 | UI | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 串口弹窗字段 | 端口（可输入/刷新/清除/命名管道提示）、波特率（自定义提示+校验）、高级（数据位/停止位/校验/流控/本地回显/行模式/退格/字节模式/字符集）、命名管道隐藏帧格式 | 448px、24px 头、18px 标题、图标与主按钮一致 | 无差异 | 复核通过（截图 `r3-serial.png`） |
| 串口「保存配置」 | Netcatty 支持保存串口主机（SerialHostDetailsPanel） | — | 行为 | termX 无串口主机档案（DB 仅 SSH/local），未加假控件，登记 todo |
| Telnet 入口与表单 | termX 有独立「Telnet」按钮 + 弹窗（主机/端口/高级术语）；Netcatty 通过快速连接 `telnet://` + 向导 | 弹窗 448px、默认端口 23、空主机禁用连接 | 交互差异（入口形态） | 保留自有入口（可达性更直观），不入假控件；快速连接向导体系差异登记 todo |
| Telnet 保存主机 | Netcatty 向导可保存为 host | — | 行为 | 同串口，无 telnet 主机档案，登记 todo |
| 本地终端新建/编辑面板 | 名称 / Shell（系统默认 + 发现列表 + 自定义）/ 分组 / 启动目录；保存并打开 + 保存；Esc（下拉优先收起） | overlay 宽度、页脚按钮层级、hint 文案一致 | 无差异 | 复核通过（截图 `r3-localshell.png`） |
| 本地终端卡与快捷入口 | Vault 卡显示真实 shell 名；「终端」按钮直接开标签；「新建主机」下拉含 本地终端 (CMD)/新建分组/导入/导出 | 主机侧栏打开时 终端/串口 折叠隐藏 | 无差异 | 复核通过（截图 `r3-menu2.png`、`r3-local.png`） |
| 串口主机列表/编辑 | Netcatty 有 SerialHostDetailsPanel 与串口主机卡 | — | 行为 | 未实现，登记 todo；无假按钮 |

### 门禁

本轮无源码改动（仅文档），沿用上一轮已通过的构建与测试结果：379 前端 ✓、build ✓、cargo check(server) ✓、874 后端 ✓。为满足流程，提交前再跑一次 `npm run test:run` + `npm run build` 确认文档改动不影响构建。

---

## 2026-11-04 — 全应用逐功能比对第一轮（SFTP）

对照基准：`Netcatty/components/SftpView.tsx`、`components/sftp/SftpPaneView.tsx`、`SftpPaneToolbar.tsx`、`SftpPaneFileList.tsx`、`SftpFileRow.tsx`、`SftpBreadcrumb.tsx`、`SftpTransferQueue.tsx`、`SftpConflictDialog.tsx`、`SftpPermissionsDialog.tsx`、`SftpPaneDialogs.tsx`、`components/sftp/utils.ts`。

### 差异与处理

| 项 | Netcatty | termX 本轮前 | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 名称过滤 | 工具栏 filter 按钮 + 输入行；大小写不敏感子串 | 无 | 交互 | 新增 filter 按钮 / 输入行 / Esc 清除；`filterEntriesByName` 纯函数 + 3 单测 |
| 新建文件 | 工具栏 newFile + 空白右键 | 无 | 行为 | 补工具栏按钮、空白右键项与弹窗；远端 `sftp_write_file`、本地 `local_write_file` 建空文件；写入前 stat 探测同名文件并拦截（避免整体覆盖清空既有内容） |
| 空白右键菜单 | 刷新 / 新建文件夹 / 新建文件 / 上传文件 | 仅新建文件夹 / 上传文件 | 交互 | 补齐刷新与新建文件，顺序对齐 Netcatty |
| 列集合与顺序 | 名称 / 修改时间 / 大小 / 类型 / 所有者 | 名称 / 大小 / 修改时间 | 视觉 | 改为 名称 / 修改时间 / 大小 / 类型（目录 folder、文件扩展名、无扩展名 `--`），类型列可排序；所有者列需逐行 stat，暂缺（登记） |
| 底部状态栏 | 左「N 项 - 已选 M」右当前路径 | 无 | 视觉 | 新增 28px 状态栏（11px、`secondary/30` 底、上边框、路径 200px 省略） |
| 多选与批量操作 | Ctrl/Shift 多选、批量删除 / 下载 / 复制 | 单选 | 交互 | 本轮未改（涉及选择模型与队列批量语义），登记 todo |
| 视图模式 / 列表密度 / 文件名编码 / 书签 / 跟随终端 CWD | 工具栏均有入口 | 部分缺 | 行为 | 后端与持久化未就绪，未加假按钮，登记 todo |
| 传输队列 | 无任务时不渲染；活跃数 / 清理已完成 / 暂停恢复取消；并发 1–16 | 主体已实现；并发 1–8 | 交互 | 主体一致；并发上限与默认值统一在「设置 → SFTP」阶段落地 |
| 冲突对话框 | 停止 / 跳过 / 保留两者 / 合并 / 替换 | 跳过 / 创建副本 / 替换 + 应用到全部 | 交互 | 本轮不扩大改动；完整按钮集合与文案在「设置 → SFTP」阶段复核 |
| 权限对话框 | 3×3 复选 + 八进制 / 符号预览 | 已实现 | — | 复核通过 |
| 面包屑 | Home / 根 / 段 / 省略号 / 尾部滚动 | Home / 根 / 段 / 省略号 | 视觉 | 结构一致；尾部滚动与 sub-pixel 差异留人工复核 |

### 门禁

- `npm run test:run`：31 文件 / 382 用例 ✓（新增 3 例）
- `npm run build` ✓
- debug 重编：`npm run tauri build -- --debug` ✓；实例运行复核（工具栏过滤 / 新建文件 / 列序 / 状态栏）见本轮汇报。

## 2026-11-04 — 全应用逐功能比对第五轮（设置各 tab）

对照 `Netcatty/components/SettingsPage.tsx` 与 `settings/tabs/SettingsApplicationTab|SettingsAppearanceTab|SettingsShortcutsTab|SettingsSystemTab`，逐 tab 比对文案 key / 行结构 / 默认值。设置「终端」tab 前序已 1:1，本轮复核通过；file-associations（SFTP）/ ai / sync 保持占位，SFTP 设置留待第二步。

| 项 | Netcatty | termX 本轮前 | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 会话日志「保存目录 / 打开文件夹 / 清空所有」 | 可自定义目录 + 打开 + 批量清空 | 仅开关/格式/时间戳 | 交互 | 补「保存目录」展示行（固定 recordings）与「清空所有」入口，按实际能力置灰并写原因 |
| 启动与会话恢复（启动页 / 恢复上次会话 / 恢复终端 CWD） | 3 项可选 | 整节缺失 | 交互 | 补节 + 3 行，置灰并说明 termX 无会话持久化 |
| SSH 深链 / JMS 深链 | 两个开关 | 整节缺失 | 交互 | 补两节，置灰说明未注册系统协议 |
| 资源管理器右键菜单 | 开关 | 整节缺失 | 交互 | 补节，置灰说明安装器未注册 |
| 全局热键与托盘（召唤 / 关闭到托盘 / 托盘图标） | 3 项 | 整节缺失 | 交互 | 补节 + 3 行，置灰说明 Tauri 未实现托盘与全局热键 |
| 临时文件「打开临时目录」 | 有入口 | 仅一行 notPorted | 交互 | 补打开入口，置灰说明未暴露目录 |
| 系统 tab 节顺序 | update → autoLaunch → proxy → credentials → crashLogs → tempDirectory → sessionRestore → sessionLogs → ssh/jms deep link → explorer → sshDebugLogs → globalHotkey | 缺 5 节 | 视觉 | 节顺序对齐 Netcatty，新增节插在 sessionLogs / sshDebugLogs 之间 |
| 快捷键 scheme「禁用」 | disabled / mac / pc 三态，禁用时隐藏绑定列表 | 仅 mac / pc | 行为 | 本轮未改（需改 HotkeyScheme 类型与迁移），登记 todo |
| 外观 notes 字体三行 / 自定义 CSS 帮助弹窗 | 有 | 无 | 视觉 | 登记 todo（随笔记模块落地） |
| 软件更新 / 应用锁 | 完整更新器 / 应用锁 | 占位置灰 | — | 维持现状，理由已在行内展示 |

### 门禁

- `npm run test:run`：31 文件 / 382 用例 ✓
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓
- debug 重编：`npm run tauri build -- --debug` ✓；CDP 实测系统 tab 节顺序：软件更新 / 开机自启动 / 网络代理 / 凭据保护 / 崩溃日志 / 会话日志 / 启动与会话恢复 / SSH 深链 / JMS 深链 / 资源管理器右键菜单 / SSH 调试日志 / 全局热键与托盘 / 临时文件 / 应用锁 ✓

## 2026-11-04 — 全应用逐功能比对第六轮（钥匙串）

对照 `Netcatty/components/KeychainManager.tsx`、`KeychainEditPanel.tsx`、`KeychainExportPanel.tsx`、`keychain/GenerateStandardPanel.tsx`、`keychain/ImportKeyPanel.tsx`、`keychain/KeyCard.tsx`、`keychain/ViewKeyPanel.tsx` 与本项目 `src/keychain/KeychainView.tsx`、`src/domain/keychainModel.ts` 比对。

| 项 | Netcatty | termX 本轮前 | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 头部搜索（名称/指纹/类型） | 有，面板打开时隐藏 | 无 | 交互 | 新增搜索框，匹配名称/指纹/类型/路径；无结果提示 |
| 列表/网格视图切换 | 下拉切换 grid/list | 仅列表 | 视觉 | 新增「列表 / 网格」按钮（`aria-pressed`），网格卡片布局 |
| 条目计数 | section 标题右侧计数 | 无 | 视觉 | 标题补「共 N 项」 |
| 密钥详情面板（公钥全文/类型/指纹/路径 + 复制/设默认/删除） | 有 ViewKeyPanel | 只有行内三项操作 | 交互 | 点击行/卡片打开详情面板，公钥只读文本域 + 三个操作 |
| 删除确认 | 应用内模态 | `window.confirm` | 交互 | 改为应用内确认弹窗，展示将删除的 `.ssh/<name>` 与 `.pub` |
| 新建身份（identities 区、用户名+私钥） | 有，独立分区 | 无（后端无身份模型） | 行为 | 未实现，登记待人工 |
| 证书 / 安全密钥（FIDO、resident、verify） | 有 | 后端无对应能力 | 行为 | 未实现（不放置灰控件），登记待人工 |
| 导出到主机（选主机/文件名/位置/脚本、exportAndAttach） | 有 | 无 | 行为 | 未实现（依赖主机批量脚本通道），登记待人工 |
| 拖拽排序、编辑面板（label/public key/certificate） | 有 | 无 | 交互 | 未实现（后端无 label 元数据），登记待人工 |

### 门禁

- `npm run test:run`：31 文件 / 382 用例 ✓
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓
- debug 重编：`npm run tauri build -- --debug` ✓；CDP 实测：进入钥匙串 → 网格模式 1 张卡片、标题「共 1 项」→ 点击卡片详情面板显示 类型 Ed25519 / 指纹 SHA256:… / 路径 ~/.ssh/id_ed25519 / 公钥全文 → 搜索 `zzz` 后 0 行并显示「没有匹配的密钥。」✓

## 2026-11-04 — 全应用逐功能比对第七轮（脚本与片段）

对照 `Netcatty/components/SnippetsManager.tsx`、`SnippetsRightPanel.tsx`、`snippets/SnippetTargetsSection.tsx`、`snippets/SnippetScriptEditor.tsx`、`QuickAddSnippetDialog.tsx`、`ScriptsSidePanel.tsx`、`scripts/ScriptEditorPanel.tsx`、`ScriptRunLogDialog.tsx` 与本项目 `src/snippets/SnippetsView.tsx`、`snippetsModel.ts`、`snippetsTransfer.ts`、`TerminalPane.tsx` 比对。

| 项 | Netcatty | termX 本轮前 | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 分组（package）级重命名，级联子分组 | 有（`applySnippetPackagePathChange`，ops→prod 时 ops/db→prod/db） | 仅片段上的文本输入 | 行为 | 分组头新增「重命名」，应用内模态输入新路径；`renameSnippetPackage` 级联改名，单测覆盖 |
| 分组级删除（含子分组） | 有（删除 package 及其片段，模态确认） | 无 | 行为 | 分组头新增「删除分组」，确认后 `deleteSnippetPackage` 级联删除，单测覆盖 |
| 快捷键冲突检测 | 有（`systemConflict` / `snippetConflict`，且绑定系统快捷键） | 只校验格式 | 行为 | 保存时用 `findShortkeyConflict` 检测与其他片段重复，命中报「已被片段 X 占用」 |
| 导入预览模态（条目数/包数/跳过/覆盖） | 有（含示例下载） | `window.confirm` 覆盖/跳过 | 交互 | 未实现，登记待人工 |
| 目标主机 / 分组（targets、allHosts）、多目标执行 | 有（SnippetTargetsSection + 执行面板） | 无（后端 Snippet 无 targets 字段） | 行为 | 未实现，需后端模型扩展，登记待人工 |
| 执行历史（history 面板、运行日志对话框） | 有 | 无 | 行为 | 未实现，登记待人工 |
| 终端内快速添加（QuickAddSnippetDialog） | 有 | 无 | 交互 | 未实现，登记待人工 |
| 录制保存为脚本（ScriptSaveRecordingDialog / 录制指示） | 有 | 无（`scriptRecording.ts` 仅有解析） | 行为 | 未实现，登记待人工 |
| 包导入/导出含 snippetPackages | 传输格式 v3 支持 | 已支持 v1~3，仅迁移片段字段 | — | 复核通过（targets/trigger/language 留档不导入） |
| 搜索/分组筛选/类型筛选/CRUD/多行发送模式 | 有 | 有 | — | 复核通过 |

### 门禁

- `npm run test:run`：31 文件 / 388 用例 ✓（新增 6 条：快捷键冲突 3、分组重命名 2、分组删除 1）
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓
- debug 重编：`npm run tauri build -- --debug` ✓；CDP 实测：脚本页 5 条 / 2 个分组 / 1 个命名分组显示「重命名 / 删除分组」→ 新建片段侧栏标题与 9 个字段 → 点击「重命名」弹出模态，标题「重命名分组」，输入预填 `ops` ✓

## 2026-11-04 — 全应用逐功能比对第八轮（笔记）

对照 `Netcatty/components/notes/NotesManager.tsx`、`NoteToolbar.tsx`、`NoteOutline.tsx`、`NoteTitleInput.tsx`、`NoteSourceEditor.tsx`、`NoteExportMenu.tsx`、`noteClipboardPaste.ts`、`noteImageLayout.ts`、`noteCodeTooltips.ts`、`noteMathRenderer.ts`、`components/host/HostNotesEditor.tsx` 与本项目 `src/notes/NotesView.tsx`、`notesModel.ts`、`MarkdownPreview.tsx`、`markdownModel.ts` 比对。

| 项 | Netcatty | termX 本轮前 | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 大纲（标题层级导航） | `NoteOutline` 侧栏，点击跳转 | 无 | 交互 | 新增「大纲」按钮 + 侧栏：`extractNoteOutline` 解析 1–6 级标题、跳过 ``` / ~~~ 围栏代码块、按层级缩进；点击定位到编辑器对应行（预览态自动切回原文） |
| 富文本编辑器与语法高亮（MDXEditor） | 有 | 等宽 textarea | 视觉 | 未实现（不引入 MDXEditor 依赖，保持零依赖策略），登记待人工 |
| 格式工具栏全量（链接/图片/表格/数学/删除线/撤销） | 约 20 项 | 8 项（H1/H2/加粗/斜体/列表/引用/代码） | 交互 | 未实现，登记待人工 |
| 源文件模式切换（NoteSourceEditor） | 有 | 无（原文即 textarea） | — | 差异化实现，无需改 |
| 导出菜单（Markdown / HTML / PDF / 批量） | 有 | 当前 `.md` + 全部目录导出 | 交互 | PDF/HTML 未实现，登记待人工 |
| 图片粘贴/布局、代码块 tooltip、数学渲染 | 有 | 无 | 视觉 | 未实现，登记待人工 |
| 主机级笔记（HostNotesEditor / HostNotesIndicator） | 有（主机卡片显示笔记图标） | 无 | 行为 | 未实现，登记待人工 |
| 搜索/分组/标签筛选、置顶、CRUD、主机深链、保存防抖 | 有 | 有 | — | 复核通过 |

### 门禁

- `npm run test:run`：31 文件 / 391 用例 ✓（新增 3 条大纲解析用例）
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓
- debug 重编：`npm run tauri build -- --debug` ✓；CDP 实测：进入笔记页 → 有编辑器与「大纲」按钮 → 注入 `# 标题A / ## 标题B` 后大纲出现两项（层级缩进）→ 点击首项后编辑器选区回到行首（line 0）✓

## 2026-11-04 — 全应用逐功能比对第九轮（日志）

对照 `Netcatty/components/ConnectionLogsManager.tsx`、`LogView.tsx`（连接日志表 + xterm 查看器）与本项目 `src/sessionLogs/SessionLogsView.tsx`、`sessionLogsModel.ts`、`ansi.ts` 比对。两侧数据源不同：Netcatty 读连接日志缓冲（日期/用户/主机/已保存表 + 未完成态 + 分页 + 收藏/取消收藏），termX 读 recordings 目录的 asciicast（列表 + 详情 + 彩色/原文 + 导出 cast/txt/html）。功能等价部分：浏览、筛选、查看、删除、导出、时间/时长/大小统计。

| 项 | Netcatty | termX 本轮前 | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 查看器字号定制 | LogView 支持 theme/fontSize（按日志保存） | 固定 13px | 交互 | 新增 `A− / 15px / A+` 控件，范围 9–22px，实时作用于日志内容区 |
| 收藏 / 取消收藏（saved 列） | 有 | 无（后端无收藏标记） | 行为 | 未实现，登记待人工 |
| 进行中（ongoing）状态 | 有 | 录制结束才入索引 | 行为 | 未实现，登记待人工 |
| 分页 / load more | 有 | 一次加载全部（数量小） | — | 数据源不同，无需对齐 |
| 用户名列 / 本地终端标识 | 有 | 只有主机名 / 标题 | 视觉 | 登记待人工（asciicast 无用户名元数据） |
| 按日志持久化主题与字号 | 有 | 字号仅会话内生效 | 交互 | 登记待人工（需后端 Note/SessionLog 元数据扩展） |
| 彩色/原文切换、导出三种格式、删除确认、筛选、搜索 | 有（实现方式不同） | 有 | — | 复核通过 |

### 门禁

- `npm run test:run`：31 文件 / 391 用例 ✓
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓
- debug 重编：`npm run tauri build -- --debug` ✓；CDP 实测：进入「日志」页 11 条记录 → 打开首条 → 点两次 `A+` 后内容区 `font-size` 13px → 15px，控件标签同步 15px ✓

## 2026-11-04 — 全应用逐功能比对第十轮（已知主机）

对照 `Netcatty/components/KnownHostsManager.tsx` 与本项目 `VaultView.tsx` 已知主机面板（`kh*` 状态、`khCard`、扫描/导入/删除、搜索/排序/网格列表切换）逐项复核。此前该面板已按 1:1 移植，本轮只做对照与运行复核，无代码改动。

| 项 | Netcatty | termX | 级别 | 结论 |
| --- | --- | --- | --- | --- |
| 搜索（主机名/密钥指纹/注释） | 有（`useDeferredValue`） | 有 | — | 通过 |
| 网格 / 列表视图与排序（manual/name/added/lastUsed） | 有 | 有（持久化 `termx.vault.khView.v1`） | — | 通过 |
| 扫描系统 known_hosts / 导入文件 / 删除确认 | 有 | 有（后端 `known_hosts_scan_system/import_file/remove`） | — | 通过 |
| 导入时过滤公共服务器（github 等）并提示数量 | 有 | 导入直接合并，不区分公共主机 | 行为 | 未实现（过滤需后端在合并前判定），登记待人工 |
| 渲染上限（RENDER_LIMIT + 加载更多） | 有 | 一次渲染全部（本地文件通常仅数十条） | — | 数据量小，不做分页 |
| 条目字段（host:port / 密钥类型 / 指纹 / 注释 / 添加时间） | 有 | 有 | — | 通过 |
| 空态与无匹配提示 | 有 | 有 | — | 通过 |

### 门禁

- `npm run test:run`：31 文件 / 391 用例 ✓
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓
- debug 实例 CDP 实测：进入「已知主机」→ 6 条卡片，含扫描/导入按钮与搜索框 → 搜索 `zzz` 后 0 条并显示空态 ✓

## 2026-11-04 — 第二步：设置 → SFTP tab 一比一复刻

对照 `Netcatty/components/settings/tabs/SettingsFileAssociationsTab.tsx`（及其依赖 `useSftpFileAssociations`、`domain/sftpTransferConcurrency.ts`）逐项列清单，并与本项目 `src/settings/`、`src/sftp/`、`src-tauri/src/sftp/transfer_center.rs` 对照落地。tab 由占位改为真实内容（导航项解除禁用）。

| 项 | Netcatty | termX 本轮前 | 级别 | 处理 |
| --- | --- | --- | --- | --- |
| 双击行为 open / transfer | 默认 open；transfer=传到对侧焦点面板 | 固定打开内置编辑器 | 行为 | 落地：`sftpDoubleClickBehavior`；transfer 复用拖动载荷入队传输到对侧活动面板（本地↔远端支持，无对侧标签或同类型面板回落打开） |
| 默认视图模式 list / tree | 默认 list | 仅列表视图 | 行为 | 置灰 + 行内原因（无树视图实现） |
| 显示隐藏文件 | 默认关 | 面板内临时开关，默认关 | 行为 | 落地：`sftpShowHiddenFiles` 作为新面板默认值，设置变更即时覆盖 |
| 自动同步到远程 | 默认关 | 无外部编辑回写同步 | 行为 | 置灰 + 行内原因 |
| 文件夹压缩传输 | 默认开 | 后端 SFTP 无压缩传输 | 行为 | 置灰 + 行内原因 |
| 追随终端目录 | 默认关 | SFTP 独立标签，无 CWD 联动 | 行为 | 置灰 + 行内原因 |
| 连接时自动打开侧栏 | 默认关 | 已有 `sidePanelAutoOpen`（终端侧栏接通） | — | 落地：该开关双向绑定同一设置，终端连接后自动开 SFTP 侧栏 |
| 传输并发数 1–16 | 默认 6 / 上限 16 | 传输队列面板 1–8 / 默认 2，独立持久化 | 行为 | 落地：`sftpTransferConcurrency` 单一来源（设置 store 副作用下发后端并持久化）；后端 `DEFAULT_CONCURRENCY` 2→6、`MAX_CONCURRENCY` 8→16；队列面板改为读写设置 store |
| 跳过未改文件 | 默认开（size+mtime 比对） | 后端传输中心无跳过判定 | 行为 | 置灰 + 行内原因 |
| SSH 连接保活时间 1/5/15/30/永不 | 默认 5 分钟 | 无共享传输池 idle TTL | 行为 | 置灰 + 行内原因（展示 5 分钟默认值） |
| 默认文件打开方式 ask / 内置编辑器 | 默认 ask | 固定内置编辑器 + 右键系统程序 | 交互 | 置灰 + 行内原因（无应用选择器） |
| 文件关联表 | 按扩展名指定应用 | 无按扩展名打开入口 | 行为 | 保留空态区域并置灰 + 行内原因 |

### 门禁

- `npm run test:run`：31 文件 / 392 用例 ✓
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓
- debug 重编：`npm run tauri build -- --debug` ✓；CDP 实测：SFTP 导航可用 → 12 行齐全，双击值 open、视图 list（禁用）、并发滑杆 1–16 值 6、6 个开关禁用状态与上述一致 → 改为 transfer / 12 / 隐藏文件开 / 侧栏自动打开 → 刷新应用重开设置，四项仍为 transfer / 12 / on / on ✓ → 已还原 open / 6 / off / off

---

## 2026-11-04 — 代理收口（主机表单 / 连接弹窗 / 系统代理语义 / SFTP 独立连接）

### 背景

d633866 / 60d8deb 两个 WIP 提交已在历史里（后端 `ssh/proxy.rs`、Profile 代理字段、SecretStore `proxy:<profile_id>`、连接层逐跳代理都已具备），缺的是前端入口与语义收口。本轮不动后端已有的拨号实现，只补表单与对齐 Netcatty 的系统代理语义。

### 修改点

1. **新增 `src/domain/proxyForm.ts`（纯逻辑，前后端表单共用）**
   - `ProxyDraft { type: none|http|socks5, host, port, username, password, noProxy }`
   - `proxyDraftFromProfile` / `proxyDraftError`（主机必填、端口 1–65535、填密码必须填用户名）/ `proxyProfileFields`（none 时全清空）/ `proxyPasswordToSave`（留空=保持原密码、无用户名或 none=清除、有输入=覆盖）。
2. **Vault 主机编辑器**（[VaultView.tsx](file:///g:/AiCode/termX/termX/src/VaultView.tsx)）：新增「代理」分区（类型 / 主机 / 端口 / 用户名 / 密码 / 不使用代理 + 密码提示），编辑时回填 Profile 代理字段并从 SecretStore 读密码（只显示「已保存（留空保持不变）」）；保存时先校验再写 Profile，密码按上述策略写 `set_profile_proxy_password`。已保存代理库一行置灰并写明「Netcatty 代理库复用尚未移植」。
3. **连接管理器**（[ConnectionManager.tsx](file:///g:/AiCode/termX/termX/src/ConnectionManager.tsx)）：同一套代理字段与保存策略接入 `ProfDraft`（新建/编辑均可用）。
4. **系统代理语义对齐 Netcatty**
   - 后端 `resolve_proxy_configs` 去掉系统代理 fallback：SSH / 堡垒链只认主机档案代理，不再被设置中心系统代理影响。
   - `commands/settings.rs` 新增 `http_client(state, builder)`：system=跟随系统 / enviroment，direct=强制直连，custom=Proxy::all(url)+NoProxy 绕过列表；GitHub / WebDAV 的 probe/pull/push 全部改用它构造 reqwest 客户端（对齐 Netcatty「只影响云同步 / AI 的 HTTP，不改 SSH」）。
   - 设置中心「系统 → 网络代理」文案同步更新：说明只作用于 GitHub / WebDAV 同步与 AI，SSH 代理在主机档案配置。
5. **SFTP 独立连接结论：支持**
   - `sftp_connect` 新增可选 `profile_id`；有档案则解析该主机代理（无则直连），`SftpHandle::connect` 接收 `Option<ProxyConfig>` 并在 DialCtx 中透传；桌面命令与 server 双入口同步（`profileId`）。
   - 前端 `sftpConnect(..., profileId)`，`SftpView` 把所选档案 id 传入，不再需要「置灰」。

### 验证

- 129 经代理实连：Vault 编辑 129 → HTTP 127.0.0.1:7897 → 保存 → 连接成功（提示符 `tianzry@tianzry-VMware-Virtual-Platform`）。
- 负向证据：把代理端口改成 7898 后连接失败（断连提示「按 Enter 重新连接 / 关闭会话 / 重新开始」），改回 7897 后恢复成功 → 证明代理端口确实参与拨号而非摆设。
- SFTP 独立连接（picker 选「129 · 192.168.126.129」非复用会话）→ `/home/tianzry` 列表正常返回，命令签名与前端参数接通。
- 系统代理文案：设置中心 → 系统 → 网络代理，说明行已按 Netcatty 语义显示。
- 待人工：连接管理器弹窗的代理分区分支未做逐控件截图（入口在终端侧栏「新建主机」，CU 侧栏开关坐标不稳定）；代理库复用 / ProxyCommand 仍未移植（已置灰）。

### 门禁

- `npm run test:run`：32 文件 / 397 用例 ✓（新增 proxyForm 5 例）
- `npm run build` ✓
- `cargo check --features server` ✓（4 个既有 warning）
- `cargo test --lib`：874 ✓（无新增 Rust 用例）
- debug 重编 ✓ + CDP 实机复核（上述 129 正/负向、SFTP 列表、设置文案）
- 提交 `ebec12c`，已推送（ssh.github.com:443），远端 main 核对为 `ebec12c` ✓

---

## 2026-11-04 · 端口转发：Vault 按主机分组总览 + 跨界面运行态

### 修改点

1. **后端 `forward_active_list`（新命令，双注册）**
   - `ssh/forward.rs`：`ForwardHandle` 增加 `forward_id`（`from_task(forward_id, …)`），提供 `forward_id()` 供上层归属。
   - `commands/forward.rs`：`ActiveForwardInfo { active_id, forward_id, stats }`；`forward_active_list(window, state)` + `forward_active_list_impl` 遍历 `lifecycle_sessions(kind=Forward/Ready/owner)` 与 `active_forwards`，逐条取 `handle.stats()`。
   - `lib.rs` `generate_handler!` 与 `server.rs` dispatcher 双注册。
2. **前端 API**：`backend/client.ts` 增 `ActiveForwardInfo` 与 `forwardActiveList()`。
3. **纯逻辑 + 单测**：`domain/forwardOverview.ts`（`groupForwardsByHost` 按 profile_id 分组 / 未知主机回退 / 组内外按 zh-CN 名称排序 / `activeCount`、`ruleLabel`、`formatBytes`、`forwardSummary`、`activeFor`）+ `forwardOverview.test.ts` 4 例。
4. **Vault 总览页**：`ForwardOverview.tsx` 挂到 `VaultView` 的「端口转发」导航（此前为禁用占位）；按主机分组卡片、条目级启动/停止、规则级启停、2s 轮询 `forward_active_list` 展示连接数/上下行/effective_port/error；空态引导到终端侧栏。
5. **终端侧入口修复**：`ForwardPanel` 此前无任何 UI 入口（`toggleTool("forward")` 无调用点，等于假面板）。`TerminalPane` 右侧工具栏新增「打开端口转发」按钮（`transfer` 图标，`onOpenTool` 缺失时置灰并写明「端口转发面板不可用」）。
6. **跨界面运行态**：`ForwardPanel.refresh()` 同时拉 `forwardActiveList()`，以后端运行态为权威；从 Vault 或其它界面启动的转发，重新打开侧栏后仍显示「停止/统计/规则状态」，不再依赖本地内存。
7. **置灰能力（行内写明原因，不留假按钮）**：自动启动（ForwardRule 无 `auto_start`）、断线重连（无 `auto_reconnect`）、自定义监听地址（后端固定 127.0.0.1，无 `bind_address`）、托盘快捷开关（`lib.rs` 无 TrayIcon）。

### 验证（debug 重编 + CDP + 实机链路）

- Vault「端口转发」空态与置灰原因正常渲染；`evidence/fwd-overview-empty.png`。
- 临时创建 `129 本地转发 18022→22`（local 127.0.0.1:18022 → 远端 127.0.0.1:22）：分组卡片显示主机 129 / 1 条目 / 1 运行中，`evidence/fwd-overview-loaded.png`、`fwd-overview-running.png`。
- 条目启动后本机 `TcpClient(127.0.0.1:18022)` 连通并读到 `SSH-2.0-OpenSSH_10.0p2 Ubuntu`（真实经 129 拨号）。
- 2s 轮询统计刷新为 `1 连接 · ↑0 B ↓42 B`，`evidence/fwd-overview-stats.png`。
- 终端工具栏新按钮可打开 ForwardPanel，列表中同一转发显示「停止/统计 · 总流量 42 B ↓ · 1 连接 · 运行中」（跨界面运行态恢复），`evidence/fwd-panel-running.png`。
- 规则级停止 → 状态 `stopped` 且 18022 关闭；规则级启动 → `active` 且端口重新可连。
- 条目停止 → 端口关闭；删除后总览恢复空态、`list_forwards` 为 0，测试数据已清理。

### 门禁

- `npm run test:run`：33 文件 / 401 用例 ✓（新增 forwardOverview 4 例）
- `npm run build` ✓
- `cargo check --features server` ✓
- `cargo test --lib`：874 ✓
- debug `npm run tauri build -- --debug` ✓（构建前需先 `Stop-Process -Name rssh`，否则 rssh.exe 被占用导致 link 后替换失败）

### 踩坑

- `localeCompare(..., "zh-CN")` 按拼音排序，测试期望不能按 Unicode 码位写（甲 jiǎ → 未 wèi → 乙 yǐ）。
- `formatBytes` 整数需去掉 `.0`（`5.0 MB` → `5 MB`），否则统计行观感不一致。
- `userVisibleError` 只接收 `string`，catch 分支要 `String(e)`。
- 构建 debug 时旧 `rssh.exe` 若仍在运行会 `failed to remove file`，先停止进程再重编。

---

## 2026-11-04 · 端口转发：条目编辑 / 复制（终端侧栏）

### 修改点

1. `ForwardPanel` 新增编辑态（`editingId`）：表单区标题在「新建转发 / 编辑转发」间切换，保存走既有 `update_forward`（保留原 `group_id`），并提供「取消编辑」。
2. 运行中的条目禁止编辑：点击「编辑」给出「该转发正在运行，请先停止再编辑。」，避免改库后旧会话继续跑、看起来“改了不生效”的假象。
3. 新增「复制」：以原条目 `profile_id/group_id/rules` 生成「<原名> 副本」，规则深拷贝，复制后自动刷新列表。
4. 删除当前正在编辑的条目时同步退出编辑态，避免保存指向已删除 id。
5. 按钮布局对齐 Netcatty RuleCard 的 编辑 / 复制 / 删除 / 启动 / 停止 操作集合。

### 验证（debug 重编 + CDP 实机）

- 新建 `编辑前条目`（local 18023→127.0.0.1:22）→ 编辑改名 `编辑后条目` → `list_forwards` 名称与规则保留，`evidence/fwd-edit-before.png`、`fwd-edit-after.png`。
- 复制后得到 `编辑后条目 副本`（同 profile、同 18023 规则），`job-fwd13` 输出确认。
- 启动后点「编辑」出现行内提示「该转发正在运行，请先停止再编辑。」，`evidence/fwd-edit-guard.png`。
- 停止 → 删除两条 → `list_forwards=0`，测试数据已清理，`evidence/fwd-edit-cleaned.png`。

### 门禁

- `npm run test:run`：33 文件 / 401 用例 ✓
- `npm run build` ✓
- 仅前端改动，Rust 未变（`cargo check/test --lib` 沿用上一轮通过结果）
- debug `npm run tauri build -- --debug` ✓（先停止 rssh）

---

## 2026-11-04 · 端口转发：Vault 页条目新建 / 编辑 / 复制 / 删除

### 修改点

1. **抽出复用表单 `src/ForwardForm.tsx`**：名称 / SSH 会话档案 / 多规则（类型 + 本地端口 + 远端主机/端口）编辑，终端侧栏与 Vault 总览共用一套字段与校验；成功后清空（新建）或由调用方关闭（编辑）。`sshProfiles` 过滤本地 shell 档案，避免为 local 主机建 SSH 转发。
2. **校验前置到纯逻辑 `src/domain/forwardDraft.ts`**：名称/档案/规则必填；本地端口 0–65535（0 = 自动分配）；local/remote 必须填远端主机与 1–65535 端口，dynamic 不需要；错误信息带规则序号。新增 6 例单测。
3. **Vault 总览补齐条目 CRUD**（`ForwardOverview.tsx`）：右上角「新建转发」内联表单；条目行新增 编辑 / 复制 / 删除。运行中「编辑」置灰并在行内注明「运行中 · 停止后可编辑」；删除走应用内确认对话框，运行中的条目先停会话再删库，避免残留无主 listener；正在编辑的条目被删除时自动关闭表单。
4. **终栏侧栏接入同一表单**：`ForwardPanel` 删除自有表单状态，改用 `ForwardForm`；并修复侧栏先于 `listProfiles` 渲染导致档案下拉为空的问题（档案晚到时自动补默认选中）。
5. **修 Vault 页配色 token 用法**：`ForwardOverview` 原来直接 `var(--border)` / `var(--card)`，但这些 token 是 HSL 三元组（如 `220 16% 82%`），直接使用是无效颜色；统一改为 `hsl(var(--token))`，卡片边框/背景/弱化文字恢复正常。

### 验证（debug 重编 + CDP 实机，证据 `evidence/fwd-r3-*.png`）

- 新建：`R3 验证转发`（local 127.0.0.1:18023 → 127.0.0.1:22，档案 129）→ `list_forwards` 返回 1 条，分组卡片显示 1 条目。
- 编辑：点「编辑」回填原值 → 改名 `R3 验证转发（改）` → 保存后后端名称同步，表单关闭。
- 复制：生成 `R3 验证转发（改） 副本`（同档案同规则）→ 列表 2 条。
- 删除：确认对话框显示规则数与不可恢复提示 → 确认后 `list_forwards` 剩 1 条。
- 运行中守卫：启动 → 停止按钮可用、「编辑」disabled 且 title=「运行中无法编辑，请先停止该转发」、行内显示「运行中 · 停止后可编辑」、规则 active。
- 删除运行中条目：确认后 `list_forwards=0` 且 `forward_active_list=0`（先停会话再删，无残留）。
- 终端侧栏复检：本地会话 → 工具栏「打开端口转发」→ 重构后的表单正常渲染且默认档案为 `129（192.168.126.129:22）`。

### 门禁

- `npm run test:run`：34 文件 / 407 用例 ✓（新增 forwardDraft 6 例）
- `npm run build` ✓
- `cargo check --features server` ✓（沿用，Rust 未改）
- `cargo test --lib`：874 ✓（沿用，Rust 未改）
- debug 重编 ✓（`npm run build` → `cargo build`；若 `cargo build` 因 dist 未触发重编，touch `src-tauri/src/lib.rs` 后再编，否则二进制里仍是旧前端资源）
- 提交 `2fc7432`，已推送（ssh.github.com:443），远端 main 核对为 `2fc7432` ✓

### 踩坑

- `cargo build` 不会因 `dist/` 变化而重新编译（资源在编译期嵌入），必须 touch 一个 Rust 源文件或清理 crate 才能让新前端进包。
- Vault 页主题 token 是 HSL 分量，内联样式必须写 `hsl(var(--x))`；直接 `var(--x)` 会静默变成无效颜色（无边框、透明背景）。
- 表单在侧栏挂载早于 profiles 加载时，默认选中要做成 effect 迟到补值，不能只在 useState 初值里取第一项。

---

## 2026-11-04 · 代理库：Vault「代理」页 + 主机/连接管理器引用

### 修改点

1. **后端 schema v40**：新增 `proxy_profiles` 表（id/label/proxy_type/host/port/username/no_proxy/created_at/updated_at/order_index），`profiles` 增加 `proxy_profile_id`；旧库按 `version < 40` 增量迁移，表/列均有存在性守卫。
2. **后端 CRUD**（`db/proxy_profile.rs`）：list/get/save/delete；保存前复用 `ProxyConfig::from_parts` 校验类型/主机/端口，label/host 去空白、username/no_proxy 空串归一 NULL；删除条目在同一事务内清空 `profiles.proxy_profile_id`，主机内联 `proxy_*` 保留为回退。4 例单测（roundtrip/非法端口与类型/删除清引用/排序）。
3. **命令层**：`list_proxy_profiles` / `save_proxy_profile` / `proxy_profile_password_get` / `delete_proxy_profile`，密码走 SecretStore `proxy_profile:<id>`（与主机级 `proxy:<host_id>` 分命名空间）；null=不动、空串=清除；`lib.rs` 与 `server.rs` 双注册。
4. **连接层解析**（`commands/session.rs::resolve_proxy_configs`）：主机有 `proxy_profile_id` 时以库配置 + 库密码为准；库条目已被删则回退主机内联配置，避免静默直连。
5. **前端 Vault「代理」页**（`src/ProxyProfilesView.tsx`）：搜索 + 卡片列表（显示使用主机数）+ 右侧编辑表单（新建/编辑/密码留空保持/删除二次确认，提示会解除主机绑定）；页面底部置灰列明 4 项未移植能力（ProxyCommand、密钥串身份、分组级代理、拖拽排序）及原因。
6. **主机编辑器与连接管理器接线**：代理区新增「代理来源」下拉（内联配置/直连 或 代理库条目）；选中库条目时隐藏内联字段并清空主机级代理密码，未选中时保持原有内联流程；保存写 `proxy_profile_id`。Vault 导航「代理」由 disabled 改为可用。

### 门禁

- `npm run test:run`：34 文件 / 407 用例 ✓
- `npm run build` ✓
- `cargo check --features server` ✓
- `cargo test --lib`：878 ✓（新增 4 例代理库单测）

### 踩坑

- `Profile` 是 Rust struct 字面量构造，新增字段会波及所有测试/迁移构造点（本次一次补齐 8 处），`#[serde(default)]` 只保护反序列化。
- 主机同时存内联代理与库引用时必须定义优先级；选择库引用即清空主机级 secret，避免两套密码长期不一致。

---

## 2026-11-04 · 代理轮补验证 + 端口转发第一层

### 代理轮补验证（debug 实机）

- 重编 `target/debug/rssh.exe` 并以 CDP 9222 启动，按 Netcatty `ProxyProfilesManager.tsx` 逐项复核：
  - Vault「代理」页：导航可进入，空态、搜索框、新建按钮、卡片区、右侧编辑表单、底部「未移植能力」说明均正常渲染（`evidence/p4-proxy-01-page.png`）。
  - 新建流程：填「P4 验证代理 / HTTP / 127.0.0.1:7897」→ 保存成功，列表即时出现卡片（`p4-proxy-02-form.png`、`p4-proxy-03-saved.png`）。
  - 主机编辑器：打开 129 主机详情，「代理来源」下拉已列出库条目（`内联配置 / 直连` + `P4 验证代理（HTTP 127.0.0.1:7897）`），选中后内联字段隐藏、分组级代理行置灰（`p4-proxy-05-host-editor.png`）。
  - 差异与处理：Netcatty 为「卡片列表 + 编辑侧栏」，termX 结构一致；Netcatty 无「未移植能力」区块，termX 按本项目要求保留置灰说明，属有意差异。未发现视觉/交互阻断问题。
- 验证数据保留 1 条「P4 验证代理」，用于后续端口转发/主机绑定回归；如需清理可在代理页删除。

### 端口转发第一层（Vault 总览）

1. 对照 Netcatty `components/PortForwardingNew.tsx`：其 Vault 页是规则卡片平铺 + 顶部新建（按 local/remote/dynamic 分体菜单）/ 全部启动 / 全部停止 / 搜索 / 视图切换；termX 采用需求中的「按主机分组」，本轮补齐页面级能力。
2. `ForwardOverview` 顶部新增：`N 条目 · M 规则 · K 运行中` 统计、名称/主机/规则关键字搜索（命中主机则整组保留，无命中给出行内空态）、「全部启动」（逐条启动未运行条目，失败汇总）与「全部停止」（结束所有 active 会话）。
3. 沿用现有 `forward_*` 命令（`list_forwards` / `create_forward` / `update_forward` / `delete_forward` / `forward_start` / `forward_stop` / `forward_active_list`，lib.rs + server.rs 双注册），无需新增后端。
4. 下轮第二层：终端侧面板逐项对齐、规则级启停与统计细节、视图切换、托盘快捷开关取舍。

### 门禁

- `npm run test:run`：407 ✓；`npm run build` ✓；`cargo check --features server` ✓；`cargo test --lib`：878 ✓。
- debug 重编后 CDP 复核：`evidence/fwd-r4-01-overview.png`（计数/搜索/批量按钮），`fwd-r4-02-search-empty.png`（无匹配空态）。

### 踩坑

- 前端 `dist` 更新不会触发 Tauri 重编，必须 touch `src-tauri/src/lib.rs` 再 `cargo build`，否则实机仍是旧 UI。
- 搜索过滤要同时作用于「分组命中」和「规则命中」，否则按主机搜索时会误隐藏同组其它条目。

---

## 2026-11-04 · 端口转发第二层（终端侧面板 + 视图切换 + 真实链路）

### 修改点

1. **总览页视图切换**：新增「列表 / 卡片」切换（localStorage `termx.forward.view.v1` 持久化）；卡片视图用 `repeat(auto-fill, minmax(300px,1fr))` 网格，条目为独立卡片，规则行与按钮自动换行。
2. **规则行信息对齐 Netcatty RuleCard**：总览每条规则新增状态徽标（未启动 / starting / active 等），保留实际端口、错误、字节与连接数；运行中条目仍提供规则级启停。
3. **终端侧面板（ForwardPanel）**：
   - 规则行从「仅运行后展示」改为**始终展示**：类型徽标、`本地/远程/SOCKS5` 摘要、状态、字节↓↑、连接数、错误；
   - 条目头增加运行态圆点、规则数、主机名；
   - 运行中每 2s 自动轮询 `forward_stats`（会话断开时静默忽略），启动后立即拉一次统计，不再需要手点「统计」；
   - 规则级启停按钮常驻（运行态下按规则状态禁用对应方向）。
4. **托盘**：确认 `src-tauri/src/lib.rs` 无 `TrayIcon`/tray 构建代码，无法提供托盘快捷开关；总览页置灰行已写明「termX 未创建系统托盘（lib.rs 无 TrayIcon），无法提供托盘菜单」，不做假按钮。

### 真实链路实测（192.168.126.129）

- 应用内创建 `local 127.0.0.1:18422 → 127.0.0.1:22`（129 档案）并启动。
- `Test-NetConnection 127.0.0.1 18422` → `TcpTestSucceeded=True`。
- 本机 TCP 读 SSH banner → `SSH-2.0-OpenSSH_*`，证明流量经 SSH 隧道到达远端 sshd。
- `forward_stats`：connections=2、bytes_rx>0、rule=active。
- 证据：`evidence/fwd-r5-129-e2e.txt`、`fwd-r5-01-running.png`、`fwd-r5-02-list.png`、`fwd-r5-03-grid.png`；测试条目已删除（`list_forwards` 为空）。

### 门禁

- `npm run test:run` 407 ✓；`npm run build` ✓；`cargo check --features server` ✓；`cargo test --lib` 878 ✓。
- debug 重编后 CDP 复核列表/卡片视图与规则行渲染。

### 踩坑

- 统计轮询必须用 `activeId` 快照比对后再写回，避免停止/重启后旧 stats 覆盖新会话。
- 卡片视图的条目按钮较多，需 `flexWrap`，否则窄栏下会溢出卡片。



---

## 2026-11-04 — 全应用逐功能比对·第六轮：终端搜索 / URL 识别 / 滚动缓冲（P0 #11）

对照基准：Netcatty `components/terminal/hooks/useTerminalSearch.ts`（SearchAddon + SEARCH_DECORATIONS）、
`components/terminal/runtime/createXTermRuntime.ts`（WebLinksAddon + linkModifier 判定）、
`components/terminal/TerminalSearchBar.tsx`。

### 修改点

1. **搜索改为 xterm SearchAddon**（新增依赖 `@xterm/addon-search@0.17.0-beta.330`，与 Netcatty 同一条 0.17 线）：
   - `TerminalController` 增加 `search`；`TerminalView` 创建并加载 SearchAddon。
   - `TerminalPane.runSearch` 由「手扫 buffer 只滚动」改为 `findNext/findPrevious`；输入即时高亮（去抖交给 addon）。
   - 配色逐项对齐 `SEARCH_DECORATIONS`（match `#FFFF0044` / active `#FF880088`），计数由 `onDidChangeResults` 驱动，显示 `n / m`。
   - Cmd/Ctrl+F 在 `attachCustomKeyEventHandler` 中拦截并打开搜索条（返回 false，避免 Ctrl+F 作为控制字符发往远端）；搜索条已开时重新聚焦输入框。
2. **终端链接识别**（新增依赖 `@xterm/addon-web-links@0.13.0-beta.330`）：
   - WebLinksAddon 回调按设置中心「链接修饰键」（none/ctrl/alt/meta）判定是否激活，对齐 Netcatty `canActivateTerminalLink`。
   - 激活后走既有 `open_external_url`（tauri-plugin-opener，仅接受 http/https），不再用 window.open（WebView2 下不可靠）。
   - 设置中心该行取消置灰与「未实现」后缀，改为可保存即时生效。
3. **滚动缓冲**：设置中心「回滚 0–100000」早已接通 xterm `scrollback`（本轮复核无需改动）。
4. 纯逻辑 `src/terminal/linkActivation.ts`（修饰键判定 + 搜索热键识别）+ 4 例单测；`src/backend/client.ts` 增 `openExternalUrl`。

### 验证

- 门禁：`npm run test:run` **411 ✓**（35 文件）、`npm run build` ✓（tsc + vite）。本轮无 Rust 改动，未重跑 cargo 门禁。
- debug 重编 + CDP 实机（本地 PTY）：
  - `evidence/r6-search-link-01.png`：Ctrl+F 成功打开搜索条；
  - `evidence/r6-search-link-02.png`：撰写栏输入 `echo http://example.com/search-demo` 回显后，搜索 `example` 显示 **2 / 2** 且两处黄色高亮，URL 文本正常渲染。
  - 未实际点击链接（避免在用户桌面拉起浏览器）；链接激活逻辑由单测覆盖。

### 踩坑

- `@xterm/addon-search@0.17.0` 无稳定版，公共 registry 只有 `0.17.0-beta.*`；必须按 beta 装并加 `--legacy-peer-deps`（peer 指向 xterm 6 beta）。
- SearchAddon 的命中计数不是返回值，需订阅 `onDidChangeResults({ resultIndex, resultCount })`；`resultIndex === -1` 表示无激活项。
- 合成 KeyboardEvent 无法向 PTY 输入（xterm 只认真实按键链路）；实测改走撰写栏（React 状态 + 应用自身写入路径）才可靠。
- PowerShell here-string 写 JSON 会带 BOM，`cdp-run.js` 解析失败；job 文件改用 Write 工具落盘。

---

## 2026-11-04 — P1 #36 SFTP 同主机复制

对照 Netcatty：`components/sftp/copyToOtherPane.ts`（同主机跨栏复制）与阶段 C 冲突策略（跳过/创建副本/替换）。

### 修改点

1. **后端** `SftpHandle::copy_file`（`ssh/sftp.rs`）：远端读 → 远端写，64 KiB 分块流式；目标先写 `<dst>.part`，成功后删旧文件再 rename（与 `upload_streaming` 同原子策略），失败清理 `.part`；目录复制明确拒绝（`sftp_io_failed / directories are not supported`）。
2. **命令** `sftp_copy(sftp_id, src_path, dst_path) -> u64`，`lib.rs` + `server.rs` 双注册；前端 `api.sftpCopy`。
3. **前端** `SftpPaneView` 远端文件右键新增「复制到…」：弹出目标路径输入（默认 `<原名> 副本.<ext>`，相对路径按当前目录拼接）；提交前 `sftp_stat` 探测目标，存在则复用 `SftpConflictDialog` 的 **跳过 / 创建副本 / 替换**：
   - 替换 → 直接 `sftp_copy`（后端原子覆盖）
   - 创建副本 → 依次探测 `name (1)`、`name (2)` …（最多 100 次）后复制
   - 跳过 → 关闭
4. 未支持：目录递归复制（菜单只对文件出现）；复制进度事件（同步命令无 progress，大文件期间仅按钮 busy）。

### 验证

- 门禁：`test:run` **411 ✓**、`npm run build` ✓、`cargo check --features server` ✓。
- debug 重编 + 129 实测（`evidence/sftp-copy-129-live.txt`）：`sftp_connect` 到 192.168.126.129 → 上传 36B 测试文件 → `sftp_copy` 返回 **36 字节** → 下载副本内容与源 **完全一致**（`same:true`）→ 删除源/副本并 `sftp_close`。
- 冲突对话框复用了既有组件与动作语义，未另造策略；替换分支未单独跑 129（后端覆盖逻辑与上传一致）。

### 踩坑

- CDP 里把 connect+upload+copy+download+cleanup 全塞进一个 async IIFE 会得到无信息的 `Uncaught`（Tauri 调用链较长时异常被包装）；拆成多步 eval、按阶段 catch 才拿得到真实错误。
- `PaneConnection` 是 local/remote 联合类型，`isRemote` 布尔不参与收窄；复制函数需显式 `if (connection.kind !== "remote") return;`，冲突态里另存 `sftpId` 供 JSX 使用。

---

## 2026-11-04 — P1 #15 云端同步阶段 B（冲突提示 + 本地快照）

### 修改点

1. `src-tauri/src/commands/sync.rs`：新增 `SyncBackupEntry` 与 `create_backup_core` / `restore_backup_core` / `delete_backup_core` / `clear_backups_core`；快照 = 完整本地配置 JSON（含 secret）整体加密存 SecretStore（key `sync_backup:<id>`），索引 `sync_backup_index` 存 settings（不含敏感内容），最多保留 20 份；空配置不记快照。`pull_with_remote` 与恢复操作前自动落 `before_restore` 保护性快照。5 个 Tauri 命令 `sync_backup_create|list|restore|delete|clear` 在 `lib.rs` + `server.rs` 双注册。
2. `src/domain/syncModel.ts`：新增 `detectSyncConflict`（版本高/低 + 同版本摘要不同=`diverged`）与 `conflictBlocks`（区分推送/拉取方向），补 3 例单测（共 8 例）。
3. `src/sync/SyncView.tsx`：推送/拉取前先 `syncCheckRemotes` 并与最近一次 `check` 比对；有破坏性冲突时弹窗（版本对比 + 覆盖远端/改用远端/取消），确认后才执行。新增本地快照面板：立即创建、列表（原因/版本/时间/主机·凭据·转发·片段数/大小）、恢复、删除、清空；恢复后回调 `onAfterPull` 重载 Vault。
4. `src/backend/client.ts`：补 `SyncBackupEntry` 类型与 5 个包装。

### 验证

- 本机 WebDAV 服务器（`evidence/webdav-server.py`，支持 PROPFIND/MKCOL/PUT/GET）真实闭环：
  - 推送：`PUT` 成功，远端 `rssh_backup.enc` **19860 字节**、`rssh_backup.meta.json` `version=2`（`evidence/sync-phaseb-verify.json`）。
  - 拉取还原：把主机名改为 `termX-sync-e2e-…` 推送 → 改回原名 → 拉取后名字回到推送值，断言通过；随后恢复原名并重推清理。
  - 冲突：手动把远端 meta 版本从 3 改为 4，UI 点「推送」弹出「检测到同步冲突 / 远端 v4 高于本地 v3 / 继续推送会用本地配置覆盖远端」，`role=dialog` 存在并截图（`evidence/sync-phaseb-conflict.png`），取消后无副作用。
  - 快照：拉取自动生成 `before_restore` 一条；手动创建后列表 2 条，字段（2 主机 / 6 凭据 / 5 片段 / 10089 B）正确。
- 门禁：`npm run test:run` **425 ✓**（37 文件）、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` **883 ✓**（新增 2 例快照往返/删除清理）。
- 未实测：真实 GitHub PAT 推拉（无凭据）；逐条目三向合并仍置灰。

### 踩坑

- 沙箱会在命令结束时回收子进程：`Start-Process` 启动的 debug 应用几秒后消失；必须用常驻后台命令直接运行 exe，CDP 才能稳定连上。
- debug 构建会加载 `devUrl`（`localhost:1420`），需 Vite dev server 在跑；重编前必须停掉占用 `rssh.exe` 的旧实例，否则 `failed to remove file rssh.exe`。
- 拉取前保护性快照在「当前配置为空」时按规则跳过，单测断言不能假设恢复后一定多一条快照。

---

## 2026-11-04 — P1 #14 主机监控（Linux 真机采集 + 监控页）

对照 Netcatty：`components/vault/MonitorPanels.tsx`、`domain/monitorRuntime.ts`、`types/global/netcatty-bridge-monitor.d.ts`（字段 / 状态 / 间隔）。Netcatty 实例本轮不可用，按源码逐字段对齐，不做像素级并排结论。

### 修改点

1. **后端** `commands/monitor.rs`：新增 `monitor_sample(session_id, timeout_ms)`，复用已建立的 SSH 会话执行一次只读 shell 采样（`/proc/stat`、`/proc/meminfo`、`/proc/net/dev`、`/proc/uptime`、`df -P -k`、`nproc` / `loadavg`），逐项 `2>/dev/null` 容错；超时缺省 8s（clamp 2–30s）。CPU 与网络速率由前后两次采样差分，首次为 `null`；速率用本地完成时刻计算 Δt（远端 `date +%s` 只有秒级精度，否则 2.5s 间隔会被算成 2s）。非 Linux 返回 `supported=false` + 原因，前端置灰。
2. **双注册** `lib.rs` + `server.rs`（`monitor_sample`，camelCase `sessionId` / `timeoutMs`）；前端 `api.monitorSample` 与 `MonitorSample` / `MonitorDisk` / `MonitorNetIf` 类型。
3. **前端** `src/monitor/MonitorView.tsx` + `src/domain/monitorModel.ts`：Vault「监控」导航启用；主机多选、图表 / 列表视图（localStorage 持久化）、更新频率 2/5/10/30s、趋势范围 5/15/30min；卡片含 CPU、内存、根分区磁盘、网络速率 + 累计、各分区、运行时长 / 负载 / Swap，以及 CPU / 内存 SVG 曲线；连接状态（连接中 / 已更新 / 读数过期 / 采集失败 / 已断开）、退避自动重连、手动重试、打开终端；采样串行 + tick 防重入。
4. **置灰并写明原因**：延迟（未实现 SSH 传输层 ping）、GPU（无 NVIDIA 采集）、磁盘 I/O（未做差分）、进程（未读 top）；Netcatty 多面板 CRUD 未移植（termX 为单内置面板）。

### 验证

- 129 真机（2026-11-04 **22:08:29 / 22:08:31** Asia/Shanghai）：首次 `cpu=null`；第二次 CPU **0.8%**（每核 0.4 / 1.2）、内存 **1188.9 / 3355.1 MiB（35.4%）**、根分区 **93.7%（17.3 / 19.5 GB）**、网络 **1130 B/s ↓ / 1115 B/s ↑**、内核 6.17.0-41-generic、负载 0 / 0.05 / 0.1。
- debug 重编后监控页实测（`evidence/monitor-129-live-final.png`，**22:15:47**）：CPU 0.8%、内存 35.5%、磁盘 93.7%、网络 ↓/↑ 1.1 KB/s、累计 ↓ 237 MB、状态「已更新」，0 采集失败。
- 门禁：`test:run` **417 ✓**（36 文件）、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` **881 ✓**。
- 自审修复：tick 重入（多主机时 `setInterval` 会叠采样）、macOS 不支持主机无限重连；无高/中危遗留。手动重试 / 打开终端按钮未点测（与卡片共用同一 api 路径）。

### 踩坑

- 会话 ID 必须是 UUID；自定义 `mon-...` 会被后端拒绝为 `session_id_invalid`。
- CDP 长 async 链异常会被包成无信息的 `Uncaught`；拆步 + catch 才能拿到真实错误。
- `formatRate` 不能用于累计流量（会显示 "237 MB/s"）；累计改用 `formatBytes`，本轮截图复核已修正。

---

## 2026-11-04 — P1 #15 云端同步阶段 A（Vault 同步页 + GitHub / WebDAV）

对照 Netcatty `components/CloudSyncSettings.tsx` / `components/cloud-sync/`。termX 后端 `commands/sync.rs` 早已具备 9 个命令但零 UI（todo #15 审计结论），本轮补前端闭环。

### 修改点

1. `src/backend/client.ts`：补 `SyncMetadata` / `SyncProviderObservation` / `SyncCheckResult` / `SyncAutoPullStatus` 类型与 9 个包装（`syncCheck` / `syncCheckRemotes` / `syncRefreshLocalMetadata` / `githubPush|Pull` / `webdavPush|Pull` / `getSyncAutoPullStatus` / `setSyncAutoPull`）。
2. `src/sync/SyncView.tsx` + `src/domain/syncModel.ts`：Vault「同步」导航启用；GitHub（owner/repo 规范化、分支、PAT 存 SecretStore）与 WebDAV（URL 补 https、用户名、密码存 SecretStore）双卡片；保存 / 推送 / 拉取 / 检查远端 / 刷新本地版本；启动时自动拉取开关（密码存 SecretStore，关闭即删除）；同步加密密码仅会话内输入。
3. 自动拉取后（`pulled=true`）回调 `onDataChanged` 重新加载 Vault，避免主机/分组列表滞后。
4. 置灰并写明原因：Google Drive / OneDrive / S3、OAuth 设备码、逐类目开关与交互式冲突合并策略；本地快照备份入口未做。

### 验证

- 422 前端单测 ✓（37 文件，新增 syncModel 5 例）、`npm run build` ✓。
- debug 实机（`evidence/sync-page.png`）：导航进入「同步」；空密码点「推送」显示「请先填写同步加密密码。」；后端 `sync_check_remotes` 返回本地 **v1**，GitHub/WebDAV 均未配置（remote=null，无错误）；置灰说明可见。
- 未实测：真实 GitHub PAT / WebDAV 账号的推拉（无凭据）；冲突提示与快照备份待后续阶段。

### 踩坑

- 自动拉取是否开启由 SecretStore 中是否存在 `sync_*_auto_pull_password` 决定，不存在单独的 enabled 键；UI 必须从 `get_sync_auto_pull_status` 读，不能写普通设置键。
- GitHub Token / WebDAV 密码必须走 `set_setting` 的 `is_secret_setting` 白名单（`github_token` / `webdav_password`），否则会落到明文设置表。

---

## 2026-11-04 — P1 #34 主机表单高级字段（主机级环境变量 + 置灰对齐）

对照 Netcatty `domain/models/connection.ts` Host 模型与 `components/HostDetailsAdvancedSections.tsx`。只补后端有能力支撑的字段，其余逐项置灰写原因。

### 修改点

1. 后端新增 `profile_env_vars` 表（schema v41）：独立表存主机级环境变量，避免改动 `Profile` JSON wire contract；`db/profile_env.rs` 提供 `list` / `replace` / `delete_for_profile`，保留填写顺序、允许同名不同值、跳过空名与非 `[A-Za-z0-9_]` 名。
2. 命令 `profile_env_list` / `profile_env_save` 双注册（`lib.rs` + `server.rs`）；`delete_profile` 在两条适配器里都级联清理该主机环境变量。
3. 连接链路：`ssh_connect` 与 headless connect 读取主机环境变量 → `ConnectParams.env_vars` → russh 通道 `set_env`，在 `request_pty` / shell 之前发送。
4. 云同步 payload 顶层新增 `profile_env_vars`（`[{ profile_id, vars }]`），只导出非空项；导入按 profile 校验后 `replace`，坏数据记 `parse_failed` / `ImportError(kind=profile_env)`；`profiles` 结构不变（旧客户端可读）。
5. 前端：`client.ts` 新增 `EnvVar` 与 `listProfileEnv` / `saveProfileEnv`；Vault 主机编辑器新增「环境变量」section（名称/值输入、增删、SetEnv/AcceptEnv 提示；编辑时异步加载，保存时全量替换），并新增置灰 section「高级字段（Netcatty 有，termX 置灰）」逐项写原因（字符集、主题/字体/字号覆盖、启动命令运行模式、登录/连接脚本/输出触发器、Mosh/ET/X11、设备类型/OS 覆盖）。

### 验证

- 门禁：`npm run test:run` **425 ✓**（新增 `profile_env` 相关覆盖不涉及前端）、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` **884 ✓**（含 `replace_keeps_order_and_skips_invalid_names`）。
- 129 真机（CDP，`evidence/host-advanced-verify.json`、`evidence/host-advanced-env.png`）：带高级字段（`init_command` + 主机级 `LC_ALL=C`）连接成功（sessionId `61d93c54-…`），`init_command` 写入 `/tmp/termx-advanced-marker`，内容 `TERMX-INIT-OK / LANG=en_US.UTF-8 / LC_ALL=C`；exec 对照通道 `BASELINE_LC_ALL=` 为空，证明 SetEnv 只作用于 shell 通道。
- 129 sshd `AcceptEnv LANG LC_* COLORTERM NO_COLOR`；编辑面板 UI 断言包含「环境变量」与置灰 section，截图落盘。

### 踩坑

- 首次用 `LANG=zh_CN.UTF-8` 验证会误判失败：远端 `/etc/default/locale` 与 login shell 会把 `LANG` 重置回服务端默认 `en_US.UTF-8`，即使 SetEnv 已被 sshd 接受。证明 SetEnv 要用不被 profile 覆盖的 `LC_*`，并与 exec 通道的 baseline 对照。
- `set_env` 必须在 `request_pty` / shell 之前调用；russh 的 `want_reply=false` 不会把拒绝抛到用户层，因此置灰/提示区必须写明「需远端 sshd `AcceptEnv` 放行」。
- headless dispatcher 里 `delete_profile` 的 `?` 无法直接转 `serde_json::Value`，需要闭包返回 `AppResult<()>` 再 `ok(...)`。

---

## 2026-11-04 — P1 #16 端口转发高级能力（监听地址 / 自动启动 / 断线重连）

对照 Netcatty `domain/models/portForwarding.ts`、`components/port-forwarding/` 与 `application/state/usePortForwardingAutoStart.ts`。

### 修改点

1. 后端 schema v42：`forward_rules.bind_address`（TEXT，默认空）+ `forwards.auto_start`（INTEGER NOT NULL DEFAULT 0）+ `forwards.auto_reconnect`（INTEGER NULL 三态）。`models.rs` 的 `ForwardRule` / `Forward` 同步加字段（`#[serde(default)]`，旧数据与旧同步包可读）。
2. `ssh/forward.rs`：`bind_loopback` → `bind_listener(port, bind_address)`；空值保持原行为（IPv4 必需 + IPv6 尽力），非空（如 `0.0.0.0` / `::1` / LAN IP）只绑该地址；remote 规则把 `bind_address` 透传给 `tcpip_forward`（空 = sshd 默认）。
3. `db/forward.rs`：读写新列；新增 `auto_flags_and_bind_address_roundtrip` 单测（含 `auto_reconnect` 未设置保持 NULL）。`sync/config.rs`、CLI 导入、测试夹具同步补齐字段。
4. 前端 `ForwardForm`：每条规则新增「监听地址」（local/dynamic 默认 127.0.0.1、remote 由 sshd 决定）+ 条目级「启动时自动运行」「断线自动重连」两个开关（三态提示“未设置：跟随自动运行”）；`forwardDraft` 增加字段与地址校验；`ruleLabel` 展示自定义监听地址。
5. 新增 `src/forwardSupervisor.ts`（对齐 Netcatty 渲染层实现）：每 2.5s 轮询 `list_forwards` + `forward_active_list`；`auto_start` 每个应用生命周期拉起一次；`auto_reconnect`（未设置跟随 `auto_start`）在意外断开后有限 5 次重连；UI 手动停止通过 `noteForwardStopped` 移出期望集合，避免被回拉；`App` 挂载 `useForwardSupervisor`。
6. 托盘快捷开关**不移植**：未启用 Tauri `tray-icon` 特性、无托盘图标/菜单；总览页置灰写明原因，其余置灰项删除。

### 验证

- 门禁：`npm run test:run` **433 ✓**（新增 `forwardSupervisor` 7 例、`forwardDraft` 监听地址与 `ruleLabel` 用例）、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` **885 ✓**。
- 129 真机（CDP + PowerShell）：创建转发（local 18099 → 127.0.0.1:22，`bind_address=0.0.0.0`，`auto_start=true`，`auto_reconnect=true`）→ 落库字段回读一致；页面 reload 后监督器自动拉起，规则 `active`；`Get-NetTCPConnection` 显示监听 `0.0.0.0:18099`，实际 TCP 连接读到 `SSH-2.0-OpenSSH` banner（真实流量，不只是截图）；绕过 UI 直接 `forward_stop` 模拟掉线，7s 后自动重连为新的 active_id；清理后端口关闭、条目与运行态均清零。证据：`evidence/forward-advanced-phase1.json`、`forward-advanced-phase2.json`、`forward-advanced-form.png`。

### 踩坑

- `auto_reconnect` 必须是三态 `Option<bool>`：用 bool 默认 false 会把 Netcatty `autoReconnect ?? autoStart` 的跟随语义压成“永不重连”。DB 必须允许 NULL，UI 未触碰时保持 NULL。
- 自动重连必须区分“手动停止”和“意外断开”；仅靠 `forward_active_list` 轮询无法区分，所有 UI 停止入口都要先 `noteForwardStopped`，否则用户停掉的条目会被监督器拉回。
- 启动进程若由一次性 shell 会话 `Start-Process` 启动，会被工具回收；debug 应用必须用后台 shell 前台运行才能保住 WebView2 + CDP 9222。
- 自定义 `0.0.0.0` 时不要再尝试 `::1` 二次绑定（否则 IPv6 监听会与 v4 通配地址冲突或产生误导性的第二条监听）。

---

## 2026-11-04 — P1 #34 补字符集字段（主机编辑面板）

上一轮 #34 已落环境变量 + 启动命令；本轮按 Netcatty `Host.charset` 补齐主机表单“字符集 / 终端编码”。

### 修改点

1. `VaultView` 主机编辑面板新增「字符集 / 终端编码」区块：UTF-8 / GB18030 下拉，复用 `terminal/terminalEncoding` 的按主机 localStorage 偏好（与终端「更多 → 终端编码」同键），保存主机时写入、打开编辑时回读；新建主机默认 UTF-8。
2. 更新置灰清单，剔除已支持的字符集，并补充真实原因：主题/字体/字号覆盖仅全局设置；启动命令运行模式后端只发一次换行；脚本/触发器依赖 #13；Mosh/ET/X11、设备类型/OS、系统 SSH Agent 路径/IdentitiesOnly 后端未实现；SSH 算法字段已有但编辑器未暴露；Keepalive/超时无主机级字段。
3. 无 Rust 改动、无 schema 变更。

### 验证

- 门禁：`npm run test:run` 433 ✓、`npm run build` ✓。
- 129 真机（CDP）：环境变量 `LC_ALL=C` + `init_command` 连接成功，标记文件输出 `TERMX-INIT-OK / LC_ALL=C`，exec 对照通道 `BASELINE_LC_ALL=` 为空；主机面板含字符集下拉（`utf-8`/`gb18030`）、环境变量、启动命令与置灰清单；选择 GB18030 保存后 `termx.terminalEncoding.<id>` 回读一致，随后恢复 UTF-8。证据：`evidence/host-advanced-verify.json`、`host-advanced-env.png`。

### 踩坑

- 主机编辑面板里 `document.querySelector('select')` 会命中登录方式等更早的下拉；脚本必须按「字符集 / 终端编码」section 作用域取 `select`。
- 字符集偏好存 localStorage 而非 DB（既有终端编码设计），因此“保存主机”才会写；新建主机在没有 id 前的选择不落盘，统一在保存时写。

---

## 2026-11-04 — P1 #13 脚本系统 · 阶段 A（数据模型 + 列表/编辑 + 运行链路）

### 修改点

1. 后端 `Snippet` 增加 `language` / `trigger` / `trigger_pattern` 三个 `#[serde(default)]` 字段，继续沿用 `snippets.json` 文件存储（无 schema 变更、无需迁移）；同步 `src/backend/client.ts` 类型。
2. 脚本编辑器：新增「脚本语言」（shell 可选；javascript / python 置灰）与「触发方式」（manual 可选；onConnect / onOutput 置灰）字段，行内写明原因（nct.* JS 运行时、连接生命周期钩子、输出匹配引擎均未移植）；onOutput 的 triggerPattern 仅保留数据、不可编辑。
3. 运行链路：`PaneHandle` 增加 `connected/runSnippet/interrupt/suspend/resume`；`App → VaultView → SnippetsView` 传入活动 `PaneHandle`（Vault 态下终端常驻隐藏挂载）。脚本页新增活动终端运行条：运行 = 复用 `snippetWritePlan` 发送到活动窗格；停止 = Ctrl-C；暂停 = Ctrl-Z（SIGTSTP）；恢复 = fg。未连接 / 无活动窗格时运行按钮置灰并给出行内提示。
4. 导入导出：`snippetsTransfer` 透传 language / trigger / triggerPattern（Netcatty 数据不丢）。

### 验证

- 门禁：`npm run test:run` 435 ✓、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` 885 ✓。
- 129 真机（CDP）：脚本 3 行逐行发送后，独立 SSH exec 回读 `/tmp/termx-stagea-*` 得到 `TERMX-SCRIPT-RUN / 主机名 / 时间`；`sleep 60` 实测暂停后 `ps` 状态 `T`、恢复后 `S+`、停止后进程 `MISSING`；未连接时脚本页提示“活动终端：未打开”、运行按钮禁用、自动触发徽标显示。证据：`evidence/script-stagea-129.json`、`script-stagea-editor.png`、`script-stagea-run.png`。

### 踩坑

- xterm DOM 行尾带光标空格，检测提示符必须 `trimEnd()` 再判断 `$`/`#`，否则 `\s$` 永远匹配失败，导致“已连接”误判。
- 页面重新加载后可能恢复上一个终端标签，连接检测应优先激活已有标签，而不是盲目点主机卡片。
- `pgrep -f <标记>` 会匹配到 `ssh_exec` 自己的 `sh -c` 命令行（其中含标记串），验证暂停/停止需改用 `pgrep -x sleep` 等进程名精确匹配。

---

## 2026-11-04 — P1 #13 脚本系统 · 阶段 B（自动触发 + 屏幕等待）

### 修改点

1. 可行性结论：onConnect / onOutput / 屏幕等待全部放在渲染层实现（连接成功回调 + 下行业务输出 + xterm 缓冲），不依赖主进程；录制回放、`nct.dialog`（主进程原生对话框回调）、`nct.progress` / `startLog`（宿主级进度与日志宿主）不具备宿主能力，置灰并在行内写明原因，不造假。
2. 数据模型：`Snippet` 增加 `targets: Vec<String>` / `targets_all_hosts: bool`（`#[serde(default)]`，`snippets.json` 向后兼容）；`client.ts` 类型、`snippetsTransfer` 导入导出清洗同步透传。
3. 新增 `src/snippets/scriptRunner.ts`：脚本内屏幕等待指令 `#@wait-prompt [ms]` / `#@wait-text <文本> [ms]` / `#@wait-regex <正则> [ms]`，以「进入等待时的缓冲长度」为基线做增量匹配（避免旧输出误命中），默认 30s，超时抛错；未知 `#@xxx` 保留为命令行不静默丢弃。6 例单测。
4. 新增 `src/snippets/scriptTriggerLog.ts`：内存环形日志（100 条）+ 订阅/清空，失败也记录真实原因。
5. `TerminalPane.tsx`：连接成功 → `runOnConnectScripts()`（先等提示符 ≤6s，超时也继续；按 `targets` / `targets_all_hosts` 过滤）；下行 `writeTerminalOutput` → 300ms 防抖 `checkOutputTriggers()`（取缓冲末 4000 字符匹配 `trigger_pattern`，同一会话同一脚本只触发一次，断开清空）。
6. `SnippetsView.tsx`：触发方式全部启用；onConnect 提供「所有主机」与主机多选；onOutput 提供正则输入；运行条下新增自动触发日志面板（状态 / 时间 / 类型 / 脚本 / 详情，最近 6 条 + 清空）；行内写明屏幕等待指令与不可移植置灰项。

### 验证

- 门禁：`npm run test:run` 441 ✓、`npm run build` ✓、`cargo check --features server` ✓、`cargo test --lib` ✓。
- 129 真机（CDP，`evidence/script-stageb-129.js`）：保存后 reload 回读 `trigger=onConnect` / `targets=[129 id]` 持久化；连接 129 后 onConnect 自动执行，脚本内 `#@wait-text` 命中回显后继续，独立 SSH exec 回读 `/tmp/termx-stageb-connect-*` 得到 `TERMX-STAGEB-CONNECT` + 主机名；终端输入 `echo TERMX-OUTPUT-42` 触发 onOutput，回读 `/tmp/termx-stageb-output-*` 为 `TERMX-STAGEB-OUTPUT`；再发 `TERMX-OUTPUT-77` 日志仍只有 1 次输出触发（去重）；目标主机不匹配的负例脚本未触发。触发日志 4 行（连接/输出各「执行中 + 完成」）。证据：`evidence/script-stageb-129.json`、`script-stageb-log.png`。

### 踩坑

- 触发日志每条触发写两行（执行中 + 完成），断言「只触发一次」要按脚本名统计条目（2 行/次），不能直接数关键词。
- 页面 reload 后若恢复的是已在连接的会话，shell 可能仍在校验/初始化阶段：一次复跑出现 `#@wait-text` 5s 超时（日志如实记为「失败」）；onConnect 脚本等待窗口应按主机初始化耗时留足（默认 30s），不要依赖 5s 级短超时。
- xterm 的 `write()` 是异步的，写命令与读缓冲判断要给远端回显留时间；等待逻辑必须轮询而非一次读取。

---

## 2026-11-05 — P1 #17 内嵌图片（Kitty / SIXEL / iTerm）

### 修改点

1. 新增依赖 `@xterm/addon-image@0.10.0-beta.331`（Netcatty 同款实现），并把 `@xterm/xterm` 升到 `6.1.0-beta.336`：addon 依赖新版解析器的 `registerApcHandler`，6.0.0 会抛 `TypeError` 直接打空整页。
2. 新增 `src/terminal/inlineImages.ts`：总开关（默认关闭，对齐 Netcatty `inlineImagesEnabled`）、Kitty / SIXEL / iTerm IIP 三个协议开关、缓存上限 8-512MB、单图像素上限 1-64MP、单条序列上限 1-64MB；越界值夹紧，非法值回落默认。6 例单测。
3. `Terminal.tsx`：创建终端时按设置加载 addon，`subscribeSettings` 变更即时重载（先 dispose 旧实例）；addon 不可用时 try/catch 只关闭图片渲染，不影响终端本身。
4. 设置中心「终端 → 内嵌图片」：总开关 + 三协议开关 + 三项上限 Stepper + 生命周期提示，中英文案齐备。

### 验证

- 门禁：`npm run test:run` 447 ✓、`npm run build`（tsc + vite）✓。
- 129 真机（CDP，`evidence/inline-images-129.js`）：开启开关并持久化后重载生效；独立 SSH 会话把三段真实序列写入远端文件（SIXEL DCS、Kitty `f=32` RGBA、iTerm `OSC 1337 File=` PNG），终端依次 `cat` 后均出现 `.xterm-image-layer-top` canvas 并实际绘制像素：SIXEL 2368、Kitty 3072、IIP 3072。证据 `evidence/inline-images-129.json` + `inline-sixel.png` / `inline-kitty.png` / `inline-iip.png`。

### 踩坑

- addon-image 的 beta 版本强依赖 xterm 6.1 beta 的新解析器 API，仅升级 addon 不够，必须同步升级 xterm 核心；否则 `loadAddon` 抛异常会把 React 树整个打断（页面空白）。
- Vite dev server 在新增依赖后必须重启重新 optimize，否则 WebView 里加载的是旧依赖快照，表现为整页空白。
- 三类协议都能真渲染，无需置灰；限制只有生命周期（休眠/重连后图片不保留，需重新输出）。

---

## 2026-11-05 — P1 #18 Zmodem / Ymodem 传输（ZMODEM 完成，YMODEM 置灰）

目标：终端内 `sz` / `rz` 自动接管，拖拽上传走 ZMODEM；YMODEM 按 Netcatty 实现边界评估可移植性。

### 修改点

1. **新增依赖 `zmodem.js@0.1.10`**（Netcatty `electron/bridges/zmodemHelper.cjs` 使用的同一协议库）。
2. **`src/terminal/zmodem.ts`**：ZMODEM 接管器。
   - `Zmodem.Sentry` 包住 SSH 下行字节流：检测 ZRQINIT（远端 `sz`）进入下载会话，检测 ZRINIT（远端 `rz`）进入上传会话；协议字节走 `sender`，其余字节继续送终端。
   - 下载：`offer.accept()` 直接 resolve 为 payload 数组，拼接后回调落盘；进度通过 `offer.on("input")` 节流上报。
   - 上传：`startUpload(files)` 记录文件，检测后逐个 `send_offer`，4KB 分片 `xfer.send` + `xfer.end`。
3. **`src/backend/client.ts`** 新增 `sshWriteBytes`：以 `encoding: null` 把 `Array<number>` 原样写入 SSH 通道，避免二进制高字节被 UTF-8 二次编码。
4. **`src/TerminalPane.tsx`**：
   - SSH 会话在 `wire()` 中创建接管器；`writeTerminalOutput` 先喂 Sentry，`dispose` 时随 teardown / 卸载释放。
   - 下载固定落盘 `~/Downloads`（目录不存在则创建，重名自动加 ` (n)`）。
   - 拖拽上传：`.pane` 接收 drag/drop（仅 `Files`），写入 `rz -y`，10 秒未收到 ZRINIT 提示检查 lrzsz。
   - 终端左下角 ZMODEM 横幅（检测 / 进度 / 完成 / 失败），完成 4 秒后自动收起。
5. **`src/styles.css`** 新增拖拽虚线蒙层与横幅样式；**`src/terminal/zmodem.test.ts`** 3 例（下载检测回 ZRINIT、上传检测、dispose 后静默）。

### 验证

- 门禁：`npm run test:run` 450 ✓、`npm run build`（tsc + vite）✓。无 Rust 改动。
- 129 真机（CDP，`evidence/zmodem-129.js`）：无 root 用 `apt-get download lrzsz` + `dpkg-deb -x` 得到真实 `sz`/`rz`。
  - 下载：终端输入 `sz /tmp/termx-zmodem-src.txt`（78894B），横幅显示完成，本地 `C:\Users\tianzry\Downloads\termx-zmodem-src.txt` 与远端 `cat` 内容逐字节一致。
  - 上传：向 `.pane` 派发真实 `DragEvent`（`DataTransfer` + `File`，10000B），自动 `rz -y`，远端 `~/termx-zmodem-upload.txt` md5 与本地一致（`1550f2df…5555`）。
  - 证据：`evidence/zmodem-129.json` + `zmodem-download-129.png` / `zmodem-upload-129.png` / `zmodem-after-129.png`。

### 踩坑

- `zmodem.js` 0.1.10 的 `offer.get_payloads()` 不存在（README 旧 API），`accept()` 直接 resolve payload 数组；首次实测报 `offer.get_payloads is not a function`，修正后下载通过。
- Sentry 只认 `**\x18B0` 公共前缀；手工构造 ZRINIT 必须带 4 字节头（`["CANFDX","CANOVIO","CANFC32"], 0`），否则 `parse_hex` 因长度非法不触发上传会话。
- 协议字节绝不能走 `sshWrite` 的文本编码路径，必须新增 `sshWriteBytes`（`encoding: null`）才能保真。
- YMODEM 置灰原因：Netcatty `sendSerialYmodem` 只在 Electron 主进程串口桥内（直接持有 `serialPort` 双向流 + `node:fs` 文件读写）；termX 串口为 Rust 后端字节流、前端没有串口级流控/取消语义，且本轮无串口硬件可实测。
- 已对齐/未对齐：下载目录固定 `~/Downloads`（无 Electron 目录选择框）；无传输队列 / 断点续传 / 拖出桌面；ZMODEM 之外的 X/YMODEM 不提供。

---

## 2026-11-05 — P1 #20 Telnet 自动登录

### 修改点

1. **后端复用状态机**：`src-tauri/src/terminal/telnet.rs` 接入既有 `serial_auto_login::SerialAutoLogin`（与 Netcatty `telnetAutoLogin.cjs` 对齐的纯逻辑检测器）。读线程对每个净数据块解码为文本后 `feed`，按 100ms 读超时 tick `check_expiry`；用户 `write` 先过 `user_input`，任意非裸 CR/LF 输入即取消。
2. **凭据与行尾**：`telnet::open` 新增 `username` / `password`（空凭据返回 `None` 关闭自动登录；`Some("")` 视为空密码设备）。自动应答直接写线路，行尾用 CRLF（对齐 Netcatty `normalizeNvtNewlines`），且经 `Negotiator::encode_outbound`，避免未协商 BINARY 时 CR 被 NVT 映射成 CR NUL。
3. **事件契约**：新增 `TelnetOut::AutoLogin(&'static str)`，命令层与 headless ws 层分别发 `telnet:auto_login:<id>`（载荷 `{ status: complete | cancelled | incomplete }`，与串口同名事件一致）。`commands/telnet.rs` 的 `telnet_open` 增加参数，`lib.rs` 与 `server.rs` 双注册路径同步。
4. **前端**：`client.ts` 新增 `TelnetCredentials` 与 `onTelnetAutoLogin`；`workspaceModel` 的 `TelnetSessionConfig` 加可选 `username` / `password`；`telnetFormConfig` 与 `TelnetConnectModal` 补用户名 / 密码字段（对照 Netcatty host 凭据字段，不造假控件），两项都空则不携带凭据；`TerminalPane` 订阅事件并写入状态栏，凭据透传给 `telnet_open`。
5. **单测**：新增 `loopback_auto_login_answers_prompts_and_completes`（检测提示 → admin/secret 写线路 → `mock#` → complete）与 `loopback_auto_login_cancelled_by_user_input`（抢先输入 → cancelled 且不再发凭据）；前端补凭据表单用例。

### 验证

- 本机 Python mock Telnet 服务端（`evidence/mock-telnet-login.py`，可配预提示延迟）经 CDP 实测两条路径：
  - 完成：终端显示 `Welcome to mock-telnet` / `login: Password:` / `Login OK` / `mock#`，页面收到真实 `telnet:auto_login:<id>` `{status:"complete"}`；服务端日志记录收到 `admin`、`secret`。
  - 取消：连接后立即键入 `x`，页面收到 `{status:"cancelled"}`；服务端日志显示只发出 `login:`，从未收到凭据。
  - 证据：`evidence/telnet-auto-login.json`、`telnet-modal-2324.png`、`telnet-auto-login-complete.png`、`telnet-auto-login-cancelled.png`、`mock-telnet-server-2324.log`。
- 门禁：前端 451✓ / `npm run build` ✓ / `cargo check --features server` ✓ / `cargo test --lib` 887✓。

### 踩坑

- mock 服务端若把 `\r` 单独当作行尾，会把 CRLF 的 `\n` 留到下一行，导致密码读成空串（首轮实测 `Login incorrect`）；必须等 `\n` 才算一行。
- 自动登录写入不走前端 `onData`，因此不会触发本地回显；密码也不会被本地回显到屏幕（服务端是否回显由 WILL ECHO 决定）。
- 真实 Telnet 设备未实测（本机无硬件）；Netcatty 完成后的启动命令回调在 termX 无对应延迟命令通道，未接。

---

## 2026-11-05 — P1 #21 自动更新（检查链路；安装置灰）

### 可行性判定

- 仓库现状：只有 `fetch_latest_release_tag`（GitHub HTML 重定向取 tag）；**没有** `tauri-plugin-updater`、`plugins.updater.pubkey`、update endpoint 配置，也没有已签名安装包 / `latest.json` 的 CI 产物。按“不造假实现”原则：检查更新做成真实 HTTP + 版本比较；下载安装保持置灰并写明缺什么、怎么补。

### 修改点

1. **后端 `check_update`**（`src-tauri/src/commands/update.rs`）：GET Tauri updater 兼容的 `latest.json`；仅允许 http/https；按 `platform_key()`（windows-x86_64 / windows-aarch64 / darwin-* / linux-*）取 `platforms` 条目；`version_gt` 支持 `v` 前缀与预发布比较；返回 `current_version / latest_version / available / platform_supported / platform / notes / pub_date / url / signature / endpoint`。只读，不下载、不安装。
2. **源地址**：默认 `https://github.com/tianzry/termX/releases/latest/download/latest.json`（CI 产出后即生效）；`TERMX_UPDATE_ENDPOINT` 环境变量可覆盖，便于本地 / 自建源联调。`lib.rs` generate_handler 与 `server.rs` headless 转发双注册。
3. **前端**：`client.ts` 新增 `checkUpdate` / `UpdateCheckResult`；设置「应用 → 软件更新」由占位禁用改为真实检查，展示当前版本、检查状态、发现新版本 / 已是最新、最新版本、发布平台、更新说明与错误文案；`下载并安装` 保持置灰，行内提示缺少签名公钥 / endpoint / CI 产物。新增 5 个 update 错误码的 i18n 映射。
4. **单测**：版本比较（v 前缀、预发布、跨段）、`latest.json` 形状解析、平台键命名。

### 验证

- 本地 `python -m http.server 8081` 提供 `evidence/updates/latest.json`（v0.0.2，windows-x86_64 / darwin-aarch64 产物）与 mock `.nsis.zip`；应用以 `TERMX_UPDATE_ENDPOINT=http://127.0.0.1:8081/latest.json` 启动，设置 → 应用 → 检查更新后显示：当前 0.0.1、「发现新版本 · v0.0.2」、最新版本 v0.0.2、平台 windows-x86_64、说明文本；安装按钮置灰且显示缺失原因。
- 证据：`evidence/update-check.json`、`update-check-before.png`、`update-check-result.png`。
- 门禁：前端 451✓ / `npm run build` ✓ / `cargo check --features server` ✓ / `cargo test --lib` 890✓。

### 未完成边界（诚实说明）

- 未接 `tauri-plugin-updater`，因此没有真实的下载 / 签名校验 / 安装 / 重启链路；本地 mock 包不是可执行安装器，签名是占位串。

### 恢复路径（后续要做真自动更新时的步骤）

1. **生成签名密钥**（私钥不入库）：`npx tauri signer generate -w ~/.tauri/termX.key`，得到 `termX.key`（私钥）与 `termX.key.pub`（公钥）。
2. **写入公钥**：`src-tauri/tauri.conf.json` → `plugins.updater.pubkey` = 公钥内容；`bundle.createUpdaterArtifacts` = `true`。
3. **安装插件**：`npm i @tauri-apps/plugin-updater` + `cargo add tauri-plugin-updater`；`lib.rs` 注册 `.plugin(tauri_plugin_updater::Builder::new().build())`；capabilities 加 `updater:default`。
4. **CI 产物**：release 构建时用 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 签名，生成 `.nsis.zip` / `.app.tar.gz` 及签名，汇总 `latest.json` 上传为 release 资产（路径与默认 endpoint 对应）。
5. **前端接入**：`check()` 后显示版本与说明，`update.downloadAndInstall(cb)` 接进度条与重启按钮；错误码沿用 update_* 系列。

## 2026-11-05 P1 #22 深链 / 单实例 / 托盘 / 多窗口

### 单项结论

- **单实例**：做了（真接）。`tauri-plugin-single-instance` 开 `deep-link` feature，且作为第一个 plugin 注册；第二实例启动时聚焦/还原主窗口，并把 argv 交给 deep-link。
- **深链**：做了（真接 `tauri-plugin-deep-link`）。`tauri.conf.json` 声明 `ssh` / `telnet` / `termx` schemes，`capabilities/default.json` 加 `deep-link:default`；前端经 `client.ts` 的 `getCurrentDeepLinks` / `onDeepLink` 订阅，按 `ssh://user@host:port` 的 host/port 匹配已有 SSH 档案并新建会话，无匹配时状态栏提示。仅主窗口订阅，避免多窗口重复开标签。
- **多窗口**：做了（接线）。`TopTabs` 右键菜单新增「在新窗口中打开」→ `client.openTabInNewWindow(JSON.stringify(connector))`；新窗口启动读取 `window.__rssh_clone` 恢复同连接标签。多窗口使用 `termx.workspace.v1.<windowLabel>` 独立持久化 key，避免覆盖主窗口布局。
- **托盘**：置灰（未做）。缺少：`tauri` 开 `tray-icon` feature、可用的托盘图标资源、托盘菜单与「关闭到托盘」语义（`on_window_event` 需拦截 CloseRequested）、跨平台（Windows/macOS/Linux）差异处理；且本轮自动化环境无法真实点击托盘图标做验证。设置与转发总览继续保留置灰说明。

### 实测（Windows debug + CDP）

- 启动首实例 → 命令行再启 `rssh.exe "ssh://root@192.168.126.129:22"`：第二进程退出、`rssh` 进程数仍为 1，首实例新建标签「129」。
- 右键标签「在新窗口中打开」：CDP 看到 2 个页面；主窗口 label `main`、新窗口 label `rssh-df7e…`，两窗口各自恢复标签「129」。
- 证据：`evidence/deeplink-multiwindow.json`、`evidence/deeplink-multiwindow.png`（不入库）。

### 边界（诚实说明）

- 开发版通过命令行参数验证；系统级 `ssh://` 点击唤起依赖安装包完成协议注册（`desktop.schemes`），本轮未做安装包实测。
- 深链目前只匹配已有 SSH 档案；`telnet://` / `termx://` 解析后无档案匹配时仅提示，不创建临时档案（JMS 深链仍无后端，保持置灰）。
- `cargo add` 将 `tauri` 从 2.11 升到 2.12.5（single-instance 2.5.5 的最低要求），`Cargo.lock` 有大量升级；`cargo check --features server` 与 `cargo test --lib` 均通过。

- 门禁：前端 452✓ / `npm run build` ✓ / `cargo check --features server` ✓ / `cargo test --lib` ✓。

---

## 2026-11-05 — 分屏重连 / 自动补全 / 命令历史 / SFTP 自动连接 / 撰写栏片段 / 时间戳与内边距

- **#163 分屏重连（严重）**：根因是 `TerminalPane` 递归嵌在布局树里，`split`（leaf→`div.split`）与 `close`（`div.split`→leaf）改变同一位置的 React 元素类型，终端组件被卸载重建 → `onReady` 再次 `connect()`，重复 `ssh_connect` 且 scrollback 丢失。改为 `workspaceModel.layoutPanePlacements` 只算矩形，终端按 `paneId` 为 key 平铺在 `.pane-layer` 绝对定位：split/close 不改既有 pane 的 id 与实例，拖拽分隔条只改 ratio + fit。回归测试断言原 pane 挂载次数恒为 1。CDP 实测 5 次「水平分屏→关闭→再分屏」原 `.xterm` DOM 节点始终存在；垂直分屏两侧输出互不污染。证据 `evidence/r11-split-*.png|json`、`r11-vertical-*.png|json`。
- **#164 自动补全（设置·终端）**：按 Netcatty 取证：默认启用、候选下拉默认开、内联 ghost 默认关、100ms 防抖、minChars 1、最多 50 条、历史范围 host/global；↑↓ 切换并实时预览、Tab 不拦截（交给 Shell 原生补全）、→ 只接受 ghost、Enter 执行、Esc 恢复；串口/Telnet 不做实时预览（Ctrl-U 可能终止会话）。实现 `terminal/autocompleteModel.ts` 纯函数 + `TerminalPane` 接线；方向键 / Shell 补全等无法追踪的改动会锁定当前行，Enter 前从 xterm buffer 校准待记录命令，密码提示行不写历史。单测 17 例。实测（本地 pty + 129）：候选出现、↓ 预览、Enter 记录完整命令而非前缀。
- **#165 命令历史**：Netcatty 为 renderer localStorage（非 DB），仅 ssh/mosh/et；termX 落 `termx.commandHistory.v1`（上限 500、按主机分桶、去重计数），More 菜单入口对四类终端开放（有意偏离，用户要求本地/串口/Telnet 也可查）。面板支持搜索、按主机/全部筛选、插入（不回车）与直接执行、删除单条/清空。实测本地 pty：`echo R11-OK` 记录、前缀补全后 Enter 记完整命令、搜索命中。证据 `evidence/r11-final-*.png|json`。
- **#166 SFTP 双入口自动连接**：主机卡片右键「打开 SFTP」（原先置灰 + tooltip「尚未实现」）与终端工具栏图标统一为「开标签 + 自动连接」；工具栏复用当前 SSH 会话走 `sftp_connect_session`，右键定位该主机；加载期有状态、失败走 `sshErrors`、重复点击聚焦/复用不新增标签。补连接代次守卫（切会话/卸载丢弃过期结果）与独立连接 `sftpIdRef` 同步。129 实测：工具栏进入即列 `/home/tianzry`；右键打开后左右栏（本地 / 129）定位 home；连续两次右键标签数不变。证据 `evidence/r11-sftp-*.png|json`。
- **#167 撰写栏快捷片段**：按 Netcatty 补齐顶部片段按钮（顶栏左侧，复用脚本模块 `snippets*` 为数据源），图标 14px、hover/暗色主题；点击把片段正文追加到草稿末尾并保留换行，无片段时按钮不渲染；管理浮层可固定/取消固定。实测点击「磁盘用量」「巡检」多行片段插入且光标在末尾。证据 `evidence/r11-compose-*.png|json`。
- **#168 终端内边距与时间戳**：视口统一留白（上 10 / 右 4 / 下 4 / 左 4，叠加 `.pane` 既有 4px 后左侧 6px），xterm fit 按扣除 padding 后的宽度重算，避免右侧裁切；四类终端共用同一容器。时间戳为行首 gutter（`[HH:mm:ss]`），工具栏时钟图标开关、localStorage 持久化，关闭立即恢复。纯函数单测覆盖 `terminalInsets` 与 `terminalTimestamps`。
- **门禁**：`npm run test:run` 61 文件 / 643 用例 ✓；`npm run build` ✓；`cargo check` ✓；子 agent code review 高危 3 项（SFTP 独立连接未写 ref、补全 typed 脱同步、密码入历史）已全部修复，SFTP 连接守卫同批修复。
- **剩余待办**：时间戳 gutter 在字号/尺寸变化后的行号重映射；多行 bracketed paste 历史只记最后一行；非 SSH 历史 hostId 依赖标签标题（重命名会换桶）；串口/Telnet 实机截图未做（COM1 占用）；SFTP 上传/下载未走自动化（原生文件对话框）。

---

## 2026-11-05 — 剩余待办收口（时间戳重映射 / 多行粘贴历史 / 历史分桶 / 串口 Telnet / SFTP 往返）

- **#169 时间戳 gutter reflow 重映射**：根因是时间戳以绝对 buffer 行号为 key，字号 / 窗口缩放 / 分屏 resize 触发 xterm reflow 后行号被重排而 Map 不更新 → 时间戳错行。改为每条时间戳持有 xterm marker，绘制按 `marker.line` 实时映射（marker 随 reflow 与 scrollback 裁剪自动更新）；列数变化时丢弃无 marker 的不可信行号；开关关闭 / 组件卸载时 dispose marker 防泄漏。同批修 review 发现的两处：scrollback 写满后 `baseY` 封顶导致新输出不再打点（改 `onLineFeed` 计数补打底部新增行）；缩窄列数触发 `reflowSmaller` 使旧行被误补时间戳（reflow 时重置上次打点行）。单测 19 例覆盖字号切换 / 窗口缩放 / 分屏 resize / 饱和 scrollback。
- **#170 bracketed paste 多行命令历史**：粘贴期间的换行被当成提交（多行被拆成多条），且 Enter 前只按当前可视行校准，最终历史只剩最后一行。现在识别 CSI `200~` / `201~`（含跨 chunk 未完成的 ESC 序列），粘贴内容整段累计到 Enter 作为一条完整多行命令；Enter 校准改用逻辑行（跨软换行拼接），保留多行前缀；修复上一 chunk 只有孤立 ESC 时下一 chunk 首字符被当 Alt 组合吞掉。单测 11 例。
- **#171 非 SSH 历史 hostId**：原 `kind:title` 依赖标签标题，本地 shell / 串口 / Telnet 重命名后历史换桶。新增 `resolveCommandHistoryHostId`：SSH=`profileId`、pty=shell+args+startDir、serial=端口、telnet=host:port，标题只用于展示。单测覆盖四类终端与“改标签不变桶”。
- **#172 串口 / Telnet 实机验证**：本机仅有 COM1 且被占用（`serial_open` 返回 `serial_open_failed: 拒绝访问`），无 com0com 虚拟串口对，串口读写链路无法实测（未伪造截图，下次步骤见 todo）。Telnet 用本地 Node telnet 服务（`127.0.0.1:2325`，IAC DO SGA / WILL ECHO）做握手验证：收到 `TERMX-TELNET-OK` 欢迎语，`telnet_write_line` 后收到 `echo:ping-termx` 回显。证据 `evidence/serial-telnet-verify.json`。
- **#173 SFTP 上传/下载往返**：走真实后端 `sftp_connect` → `sftp_upload` → `sftp_stat` → `sftp_download` 到 129（tianzry），1300B / UTF-8 / 多行文件（远端 `/home/tianzry/termx-sftp-proof-1793877252262.txt`）：写入后 size 1300，下载内容 SHA256 与本地一致（`contentMatches: true`）。原生文件对话框（`sftp_pick_*` / `sftp_download_to` / `sftp_upload_from`）标注为待人工。证据 `evidence/sftp-upload-download-129.json`、`sftp-source-129.txt`、`sftp-downloaded-129.txt`。
- **门禁**：`npm run test:run` 61 文件 / 661 用例 ✓；`npm run build` ✓；`cargo check` ✓（7 warnings）。子 agent code review 高危 2 项（scrollback 满后停止打点、孤立 ESC 吞字符）+ 中危 2 项（reflow 旧行误标、多行粘贴末行软换行覆盖）已全部修复。

---

## 2026-11-05 — 终端 UI 对齐（工具栏 / tab 状态点 / 右键菜单）

- **#174 终端工具栏集合与顺序**（对照 `Netcatty/components/terminal/TerminalToolbar.tsx` 的 `defaultLayout`）：删除「端口转发」内联按钮及 `toolbarCapabilities.forward` 能力位（端口转发入口保留在 Vault 页，快捷键/命令注册同步清理）；删除「命令历史」内联按钮（命令历史只在 More 菜单出现）。新增 `terminal/toolbarLayout.ts` 派生 `resolveTerminalToolbarActions` / `resolveTerminalTitlebarActions`：内联顺序固定为 高亮 → SFTP → 撰写栏 → 搜索 → 会话日志 → 脚本 → 更多，SFTP 仅 SSH；标题行按 复制主机地址(Copy 10) → 时间戳(Clock3 10) → 系统监控(Activity 10) → 断开(Unplug 10) → 重连(RefreshCcw 10) 渲染，本地/串口/Telnet 过滤 copyHost 与系统监控。图标尺寸与 Netcatty 一致：内联 12、菜单 14。
- **#175 会话标签状态点与关闭按钮**：新增 `terminal/connectionStatus.ts`（`resolveConnectionDotClass` / `resolveTabConnectionStatus`），`TerminalPane → Workspace → App → TopTabs` 上报每标签连接状态（优先活动窗格，否则首个窗格）；点 8px，connected `#34d399` / connecting `#fbbf24` / 其余 `#f43f5e`，外圈 `box-shadow: 0 0 0 2px <bg> 60%`；核对 Netcatty 无第二个「端口状态」点（转发状态点只出现在转发列表项）。关闭按钮改为 20px 圆形（Netcatty `p-1 + X size 12`），hover 走 destructive（`bg-destructive/10 + text-destructive`）。
- **#176 终端右键菜单四类型对齐**（对照 `Netcatty/components/terminal/TerminalContextMenu.tsx` 385-542）：新增 `terminal/contextMenuLayout.ts` 纯函数派生，顺序为 复制 → 粘贴 → 全选 → ⌁ 打开 SFTP（仅 SSH，未连接置灰）→ ⌁ 重新连接（仅 disconnected）→ ⌁ 水平分屏 / 垂直分屏 → ⌁ 清空缓冲区 → ⌁ 关闭终端（destructive）；分隔线跟随分组存在与否自动收拢，不留悬空线；删除自造的「插入片段 / 运行脚本」分组；快捷键提示按 `DEFAULT_KEY_BINDINGS` + `effectiveBinding` 取当前方案实时渲染。Netcatty 有而 termX 未实现的能力（上传剪贴板图片 / 加入对话 / 粘贴选中文本 / 打开浏览器 / YMODEM / 保存屏幕 / 重命名 / 移出工作区 / 插件菜单）不渲染假按钮，按 Pr3 留空。
- **验证**（debug + CDP；脚本 `evidence/ui-align-menu-scope.mjs`、`ui-align-states.mjs`、`ui-align-telnet-capture.mjs`）：
  - SSH 129 已连接：工具栏 13 项（含 复制主机地址 / 系统监控 / 打开 SFTP），右键菜单含「打开 SFTP」，分隔线 4 条。
  - 本地 pty：工具栏无 复制主机地址 / 系统监控 / 打开 SFTP；菜单无 SFTP 分组。此前「本地菜单含 SFTP」的疑点已复验为探针读到隐藏标签页残留的 `.term-context-menu`，按 pane 作用域取值后不存在。
  - Telnet（127.0.0.1:23 无服务 → disconnected）：玫瑰点 `rgb(244,63,94)`，菜单 复制/粘贴/全选 → 重新连接 → 分屏 → 清空 → 关闭，无 SFTP；工具栏保留 复制主机地址、无系统监控。
  - 三态点实测：connected `rgb(52,211,153)`、connecting `rgb(251,191,36)`、disconnected `rgb(244,63,94)`；关闭按钮 `20px / 50%`。
  - 截图：`shots/context-menu-ssh-scoped.png`、`shots/context-menu-local-scoped.png`、`shots/context-menu-telnet.png`、`shots/tab-status-connected.png`、`shots/tab-status-connecting.png`、`shots/tab-status-disconnected.png`、`shots/telnet-tab.png`、`shots/telnet-connect-modal.png`、`shots/local-toolbar-menu.png`、`shots/local-split.png`。
  - 串口未实测：本机 COM1 被占用（`serial_open_failed: 拒绝访问`），沿用 #172 结论；代码级派生与本地分支相同（无 SFTP）。
- **门禁**：`npm run test:run` 64 文件 / 693 用例 ✓；`npm run build` ✓。

---

## 2026-11-05 — #177 code review 修复（8a09b61 批次）

子 agent 审查 `8a09b61`（15 文件 +884/−226）：P0 无，P1 3 项、P2 6 项、P3 6 项。

| 等级 | 问题 | 处理 |
|---|---|---|
| P1-1 | `onConnectionStatus` 进 effect 依赖，父组件每次渲染新建箭头函数 → 每渲染一次 setState（拖分屏时每帧 × 窗格数） | 回调改入 `ref`，effect 只依赖 `status` |
| P1-2 | 标签状态点只取活动窗格：分屏下活动窗格正常会掩盖另一窗格断线；非活动标签还会误用别标签的 activePaneId | `resolveTabConnectionStatus` 改为按标签全部窗格聚合（任一 disconnected → disconnected；未上报/connecting → connecting；全连上才 connected），去掉 `activePaneId`；单测改成分屏聚合用例 |
| P1-3 | 右键菜单展示了未分发的快捷键（copy/paste/selectAll/clearBuffer/split 全库只定义未绑定），按下去无反应 | 渲染层不再展示快捷键提示（spec 保留字段待后续热键接线），删除 `menuShortcut` 与相关 import |
| P2-4 | 状态表每帧新建对象，拖分屏触发 App 级重渲染 | effect 内容相等时跳过回调（`tabStatusesRef` 对比） |
| P2-5 | 未知状态默认值不一致：圆点链路落到 rose，聚合链路落到 connecting | `resolveConnectionDotClass(undefined)` 统一为 connecting（未上报 ≠ 断开） |
| P2-6 | 菜单加宽后 JS 定位仍按 200px 夹取，右边缘会越界 | 夹取宽度改 240，CSS 加 `max-width: 320px` |
| P3-9 | `.nc-tab-close` 两份规则（旧 `.nc-tab` 区块已无 TSX 使用） | 删除死区块；hover 改用 `--destructive` token（对照 Netcatty `bg-destructive/10 + text-destructive`） |
| P2-7/8、P3-10~14、P2-13 | 工具栏 spec 未真正驱动 JSX、菜单 label 三处分裂、暗色外圈、ForwardPanel 死文件等 | 未修：属重构/清理，另开提交；已记入 todo |

- **门禁**：`npm run test:run` 64 文件 / **695 用例** ✓；`npm run build` ✓。

---

## 2026-11-05 — #178 取证：终端自动补全（下一轮实现依据）

来源：`Netcatty/components/terminal/autocomplete/*`（`completionEngine.ts`、`remotePathCompleter.ts`、`useTerminalAutocomplete.ts`、`terminalAutocompleteKeyEvent.ts`、`AutocompletePopup.tsx`、`terminalCompletionProviders.ts`、`terminalAutocompleteSettings.ts`）。

### A. Provider 清单（`getCompletions` 内顺序，score 降序后统一去重截断）

| # | provider | 取数方式 | 匹配/评分 | 条数 |
|---|---|---|---|---|
| 1 | 命令前缀历史 | 内存 host 历史（`historyScope` host/global） | 前缀（不区分大小写），score 1000+使用频次 | 5 |
| 2 | 路径实参历史 | 上次以该命令开头的历史行（`queryRecentHistoryByCommand`） | score 720−序号 | 5 |
| 3 | 远端/本地路径 | SFTP `readdir`（远端）/ fs（本地），见 B | score 750；目录补 `/` | 受 maxSuggestions 约束 |
| 4 | Fig spec（命令/子命令/选项/实参） | 内置 fig 规格库（`getAvailableSpecs`、`loadSpec`） | 命令名 600、子命令 800、option 700、实参 600；前缀匹配 | 每类 ≤10/15 |
| 5 | 模糊历史 | 同一历史池 | 子序列匹配，score 500+频次；仅命令位 | 5 |
| 6 | Snippet | host 片段库 | 前缀，score 高于历史；仅命令位 | — |
| 7 | 插件 | 插件注册表 `terminal.completion`（deadline 750ms） | 与内置合并，按 `text` 去重保留高分 | ≤ maximum |

- 全局：`debounceMs=100`、`minChars=1`、`maxSuggestions=50`、打字间隔 `<40ms` 时跳过、`enabled/showGhostText/showPopupMenu/livePreview/allowLineReplacement` 默认全 true、`historyScope=host`。
- 最终按 `score desc → text localeCompare`，同 `text` 去重（插件优先让位内置），`slice(0, maximum)`。

### B. 远端路径补全机制

- **不是**每次按键跑 `ls`：连上后按目录读 SFTP `readdir` 建缓存，key = `sessionId + 绝对目录`；TTL 5s、同 key in-flight 请求合并、结果再按前缀过滤并二次缓存（过滤缓存单独限长）。
- 先返回缓存命中（软预算 150ms），超时则走 `onLatePathSuggestions` 迟到回填；请求可 abort。
- 当前词解析为「待列目录 + 过滤前缀」，展开 `~`、相对 `.`/`..`、绝对路径；目录补尾随 `/`，文件不补；`foldersOnly` 分支（`cd` 类命令只给目录）。命令白名单 `ls/cd/vim/...` 决定是否走路径补全，其余命令按 spec 的 `template`/`foldersOnly` 判断。
- cwd 来源：会话 `cwd` + `cwdSource`（shell 集成/OSC 优先，prompt 解析兜底）；`canQueryPaths = protocol === "local" || sessionId !== undefined`。

### C. 浮层规格（`AutocompletePopup.tsx`）

- 主列表 `maxWidth 400`、行高 `28px`、`maxHeight 240`（估算 = n*28+8）、锚点距光标 `8px`、视口安全边 `8px`；下方空间不足则向上展开（`expandUpward`）。
- 子目录面板并列展开，每级宽 `240`；详情浮窗 `280×96`；总高受视口钳制，列表可滚动。
- 选中行底色 = 终端主题 accent 26%，hover 12%，边框同主题；等宽字体。
- 来源标记：字母徽标 `h`(history 琥珀 `#FBBF24`) / `c`(command 绿 `#34D399`) / `s`(snippet) / `o`(option) / `a`(arg) / `p`(plugin) / `{`(spec) / `P`(path)，有回退色；路径行图标 Folder `#38BDF8` / File `#94A3B8` / Link `#A78BFA`（14px），目录名蓝色。
- 行内容 = 名称 + 右侧描述（灰色小字）；`livePreview` 为 true 时，高亮候选实时写回终端输入行（`computeLivePreviewWrite`），Tab 放行前会先清掉预览。
- 关闭条件：无候选 / Esc / 焦点离开 / 光标位移 / 输入被清空 / 切换到备用屏。

### D. 接受键语义（`terminalAutocompleteKeyEvent.ts`）

| 键 | 行为 |
|---|---|
| `↑`/`↓` | 在候选间移动；越过首/尾回到「原始输入」，不循环 |
| `→` | 有 ghost 时接受 ghost（写尾随文本）；否则放行 |
| `Tab` | **不消费候选**：清状态后放行给 shell 原生补全（与 xterm 输入一致） |
| `Enter` | 弹层/ghost 可见时消费并提交当前选中候选（补尾随空格）；无候选时放行 |
| `Esc` | 关闭并回滚 live preview |
| 组合/IME | 组合态忽略；敏感输入（密码）不触发 |

### E. 传输差异

- SSH：全 provider（路径走 SFTP）。
- 本地 shell：全 provider（路径走本地 fs）。
- 串口：`protocol === "serial"` → 保留 popup/ghost，但 `livePreview=false`、`allowLineReplacement=false`；无 sessionId 即无路径 provider。
- Telnet：与 SSH 同（有 sessionId，路径走当前会话），不做 livePreview 限制。

### F. 对照表

| 维度 | Netcatty 实际 | termX 现状 | 差距 | 处理方式（下一轮） |
|---|---|---|---|---|
| 候选来源 | 历史 + 路径 + fig spec + snippet + 插件 | `COMMON_COMMANDS` 静态表 + 命令历史 | 缺路径、缺 snippet；无 fig | 新增 path provider（SSH 走现有 `sftp_list`，本地走 fs 侧接口）；命令表保留静态表，不上 fig |
| 远端路径 | SFTP readdir + 5s 缓存 + 迟到回填 | 无 | 完全没有 | 按当前会话复用 `sftp_list`（R1：只经 `backend/client.ts`），5s TTL + in-flight 合并 + 失败降级为无路径候选 |
| 多级下钻 | 子目录并排面板，逐级 Enter/Tab 接受 | 无 | 无 | 先做「目录补 `/` + 单级列表」；多级面板列为后续 |
| 浮层 | 400 宽 / 28 行高 / 240 高 / 来源徽标 / 目录图标 / 描述 | 自定义列表，无来源徽标、无描述、无目录图标 | 视觉与信息量不足 | 对齐尺寸与徽标，加目录图标与描述列 |
| ghost / live preview | 有，可写回输入行 | 有（`computeLivePreviewWrite`） | 基本一致 | 保留，仅确认脚本/敏感输入不触发 |
| 接受键 | Tab 放行、→ ghost、Enter 提交、Esc 回滚 | 语义已对齐（`resolveAutocompleteKey`） | 已一致 | 补单测：目录补 `/`、无候选放行、多级路径 |
| 传输差异 | 串口禁 livePreview/行替换 | 未区分 | 串口会尝试写回 | 按 protocol 关闭 livePreview/行替换 |
| 设置项 | 6 项（开关/ghost/popup/防抖/最少字符/条数/历史范围） | 仅常量 | 无可配置项 | 后续接设置页（非本轮必须） |








## 2026-11-05 — #179 终端自动补全实现（path provider / 多级下钻 / 浮层规格）

实现依据见上一节 #178（Netcatty `components/terminal/autocomplete/*`）。

### 实现

- 新增 `src/terminal/autocompletePathModel.ts`（纯逻辑，无 React/副作用）+ `autocompletePathModel.test.ts`（31 例）：
  - `shouldCompletePath`：命令白名单（`ls/cd/cat/vim/...` 含 `dir`）、`-` 选项放行、直接输入 `/ ./ ../ ~/ . .. ~ \` 时总补全；`cd/mkdir/rmdir/pushd` 只给目录。
  - `resolvePathLookup`：`~`、相对 cwd、绝对、Windows 盘符、引号包裹；`joinDirectoryPath` 保留尾随分隔符。
  - `buildPathSuggestions`：目录补 `/`、`display/description/source/score=750/fileType/pathDir`；`sortPathEntries` 目录→符号链接→文件。
  - `createPathDirectoryCache`：TTL 5s、30 条 LRU、同 key in-flight 合并、加载失败返回 `[]` 并清 in-flight、`invalidate`。
  - `withPathBudget`：150ms 先返回，迟到的非空结果回调回填。
- `autocompleteModel.ts`：新增 `source`（history/command/path）与 `display/description/score/fileType/pathDir`；权重历史 1000+频次、路径实参历史 720、路径 750、系统命令 600；新增 `mergeAutocompleteSuggestions`（按 text 去重 + score 降序 + 截断）与浮层几何常量（400/28/240/8/子面板 240/面板间距 4）。
- `TerminalPane.tsx`：
  - provider：SSH 复用当前会话 `sftpConnectSession` + `sftpList`（不新开连接，失败清句柄重试），本地走 `localListDir`；串口 / Telnet 返回 null（无路径候选，静默降级）。
  - 缓存键 `sessionId + 目录`（SSH）/ `local + 目录`；home 按 provider 缓存；100ms 防抖 → 先 publish 命令候选 → 150ms 预算取路径 → 迟到 `merge` 回填。
  - 多级下钻：主列表选中目录后预列子目录；每级子面板 240 宽；`→` 聚焦/下钻，`↑↓` 夹取不回环，`Enter` 接受（子面板不直接执行），`Tab` 放行，`Esc` 回滚预览。
  - 浮层：`computeAutocompletePopupPlacement` 400 宽 / 28 行高 / 240 最高 / 锚点 8 / 视口 8 / 下方不足上翻；来源徽标 h（琥珀）/ c（绿），路径 14px Folder/File/Link 图标，右侧灰色描述。
  - 串口：`livePreview=false`，不做输入行替换；卸载释放 SFTP 子系统与目录缓存；设置订阅变化时 reset 或就地重算（热更新）。
- `styles.css`：浮层/子面板/行/徽标/图标/描述/ghost 样式；`ui/icons.tsx` 增 `file`、`link`。

### 实测

- 129（SSH）：`l` → 历史 `ll/lls/ls`（h）+ 系统 `less/ln/lsblk`（c）；`ls ` → 远端目录（SFTP）且目录补 `/`；`↓` 选中 `.cache/` → `→` 两级下钻（400+240+240）；`Enter` 接受后行为 `ls /home/tianzry/.cache/evolution/addressbook/`，再回车输出 `trash` 并回提示符。
- 本地（CMD）：`l` → 4 条系统命令；`ls ` / `dir ` → 本地目录；`dir ` + `↓` + `→` 预览 `C:\Users\tianzry\.agent-browser\browsers\`，接受 + 回车输出 `chrome-146.0.7680.80`（无「无效开关」）。
- 修复（本轮实测发现）：
  1. 本地 Shell 无 OSC 7 时 cwd 为空，路径被拼成 `~/.agent-browser/...`，cmd/PowerShell 不展开 `~` → 查询前用 `localHome` 兜底（只对本地 provider）。
  2. Windows 本地 cwd 但当前词无分隔符时 `detectSeparator` 返回 `/`，拼出 `C:/Users/...` 被 cmd 当作开关（实测 `无效开关 - Users`）→ 按 cwd 盘符判定为 `\`，补单测「Windows 下空词按 cwd 推断反斜杠分隔符」。

### 未完成 / 说明

- Telnet：本机 `telnet_profiles` 为空且无可用 Telnet 服务端，未做实机；按 Netcatty 语义（非 local 且有 sessionId 才走远端 SFTP，Telnet 无 SFTP 会静默失败）本实现直接返回无路径 provider，命令候选与 SSH 相同。
- 串口：COM1 仍被占用（沿用 #172），未实机；代码层已关闭 livePreview/行替换且不提供路径。
- 与 Netcatty 并排截图未做。
- 设置项：沿用已有 4 项（启用 / ghost / 候选浮层 / 历史范围 host/global），未新增字段；热更新走设置订阅回调（本轮未在 UI 实际点击切换）。
- 门禁：`npm run test:run` 65 文件 / 726 用例 ✓（首跑一次 worker `Channel closed` 偶发，复跑通过）；`npm run build` ✓；`cargo check` ✓。

证据截图：`shots/ac-44-local-l.png`、`ac-48-local-ls.png`、`ac-50-local-right.png`、`ac-63-ssh-ls.png`、`ac-65-ssh-right.png`、`ac-66-ssh-right2.png`、`ac-68-ssh-accept.png`、`ac-69-ssh-exec.png`、`ac-73-local-right-fixed.png`、`ac-90-right.png`、`ac-92-exec.png`。


## 2026-11-05 — #180 自动补全 review 修复 + 设置热更新 / Telnet / Netcatty 并排验证

### Review（子 agent，范围 `a0c43fa`：path provider / 下钻 / 浮层 / 缓存）

- 高危 3（已修）：
  1. 路径查询无版本号：切目录 / 换会话后旧异步响应会覆盖新状态 → 引入 `queryVersion`，配合 `typed` / `timer` 判定过期响应直接丢弃。
  2. 150ms 迟到回填无视用户操作：已选中候选或已预览时仍 merge，会打乱列表 / 覆盖选中 → 回调前检查 `selected` / `previewedCommand`，满足则丢弃。
  3. 接受 / Esc 会把已输入行清空：`dismissAutocomplete` 顺带清 `typed`，接受后继续输入不再出候选 → 改为只清浮层状态，保留 `typed` / `reliable`。
- 中危 6（已修）：SFTP 句柄跨会话复用只覆盖 ref 不关闭旧子通道 → 切会话时关闭旧句柄；根路径 `/` 与盘符根 `C:\` 退化成 cwd → 按分隔符 / 盘符判定；Windows 带空格目录用 POSIX 单引号（cmd 不认）→ 按分隔符选双引号；窄窗格子面板总宽溢出 pane → 子面板宽自适应 `(pane - 主宽 - 间距×层数)/层数`（下限 120）；`←` 在无子面板时清空层级 → 保留已有层级只回退聚焦；子面板 Enter/Tab 无条目仍吞键 → 直接 dismiss 并放行。
- 中危 3（部分处理）：子面板高度按条目数收缩（上限 240）；选中 / 预览状态与行替换的清理边界；重连 / 卸载时缓存与在途查询清理。
- 低危 4（未修，记录原因）：符号链接指向目录无法从后端拿到目标类型（`RemoteEntry` 只有 `is_symlink`，不新增后端字段）；缓存超上限是「淘汰最旧」近似而非严格 LRU；POSIX 反斜杠转义语义保留（Windows 单独关闭）；Esc 仍回滚预览而不清行（与 Netcatty 一致）。
- 验证中新发现（高危，已修 + 单测）：Windows 本地尾随 `\` 被 tokenizer 当成转义符，会把后面的空格吞进上一个实参，`dir C:\a\b\ ` 的前缀过滤拿到 `" "` 导致路径候选全空、只剩历史（`rv-55-space.png`、`rv-56-space-later.png`、`rv-59-trailbs.png` 复现）。修复：`tokenizeCommandLine` / `currentWordOf` / `commandPrefixOf` / `replaceCommandWord` / `shouldCompletePath` 增加 `windows` 开关，Windows 下不把 `\` 视为转义；新增单测覆盖尾随反斜杠与 POSIX 转义保持。

### 设置热更新（设置 → 终端，全程不关终端）

- 候选浮层关：`shots/rv-04-popup-off.png`（输入 `l` 无浮层）。
- ghost 开：`shots/rv-13-ghost-on.png`（灰色 ghost `s`）。
- ghost + 浮层：`shots/rv-15-ghost-popup.png`（放大 `rv-15-crop2.png`）。
- 总开关关：`shots/rv-20-disabled.png`、`rv-22-disabled-l.png`（输入 `l` 无候选 / 无 ghost）。
- 恢复原状：`shots/rv-28-restored.png`（启用开 / ghost 关 / 浮层开 / 来源 当前主机）。
- 历史范围 host/global：设置项可切换且即时重算，但本地只有一个主机桶，切换后候选内容无可辨识差异，本轮未做独立截图（不伪造结论）。

### Telnet（本地 Node 服务）

- `node evidence/telnet-echo-server.mjs`（:2325，`termx-telnet>` 提示符）+ 临时 Telnet profile。
- `shots/rv-38-telnet-connected.png` 握手成功；`rv-39-telnet-l.png` 输入 `l` 出系统命令候选（c 徽标）；`rv-40-telnet-ls.png` 输入 `ls ` 无路径候选（Telnet 无 SFTP provider，按实现静默降级）。命令候选行为与 SSH 一致。

### 与 Netcatty 并排对照

- Netcatty 实例（运行中窗口，129 会话）实拍：`shots/nc-02-command-l.png`（命令候选）、`shots/nc-03-dir-ls.png`（`ls ` 目录下拉）。
- 合成图：`shots/sbs-command-2026-11-05.png`（termX 129 SSH / termX 本地 cmd / Netcatty 129 SSH）、`shots/sbs-directory-2026-11-05.png`（同三栏，目录下拉）。

### 串口

- COM1 仍被其他进程占用（沿 #172），未实机，无截图（未伪造）。

### 门禁

- `npm run test:run`：65 文件 / 730 用例 ✓。
- `npm run build` ✓；`cargo check` ✓（本轮后端无改动）。
- review 修复单独提交 `ae2c362`。
