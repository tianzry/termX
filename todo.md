# termX 移植待办（对标 netcatty）

> 基准：`/workspace/netcatty` 源码（`components/`、`types/global/*.d.ts`、`electron/capabilities/catalog/`），
> 不使用 rssh 命令表作为功能基准。
>
> 状态图例：⬜ 未开始 ｜ 🟨 进行中 ｜ ✅ 已完成 ｜ ⏸ 暂缓
>
> **维护规则**：每完成一项 → 勾选本项 + 更新「进度总览」+ 在 `changelogs.md` 追加改动与踩坑。

---

## 进度总览

| 分组 | 完成 / 总数 | 说明 |
|---|---|---|
| P0 日常可用性 | 7 / 14 | 不补齐难以日常使用 |
| P1 差异化能力 | 0 / 19 | 拉开与普通 SSH 客户端差距（含 1 项 ⏸ 不移植；#39 为范围修正新增） |
| P2 大工程 | 0 / 6 | 需单独立项（含 4 项 ⏸ 暂缓移植，见 plan.md） |
| **合计** | **7 / 39** | 2026-11-03：SFTP 实现③（状态保活 + OS 图标 + 低危收尾）：SftpView 改首次激活后常驻挂载 + `.nc-sftp-mount.hidden` 隐藏（对齐 Netcatty SftpViewMount sticky 保活，切 surface 不丢 pane tab/双栏状态）；新增 HostOs 判定（本地 userAgent / 复用会话 uname -s best-effort）与 os-* 原创图标（Netcatty GPL 资产与 host.os 字段判定不可复用，通用映射并说明）；低危 4 项闭环（FileStat.is_symlink、localRemove 守卫恒传、12 封装测试覆盖、孤儿 CSS）；门禁全绿（136✓/build✓/cargo check×2✓/test --lib 793✓），本地 commit 未推送；实现③实机比对受 CU 坐标 artifact 阻塞延后（构建/启动/空态渲染已确认，未见代码缺陷）；review+push 完成（无高/中危，门禁全绿，远端 main=3d9c143）；下一起点=SFTP 文件操作（上传/下载/删除/重命名/chmod，后端用 129 真实连接自动化验证） |

---

## 已完成（无需再做）

| 能力 | 状态 | 位置 |
|---|---|---|
| SSH 会话（密码 / 私钥 / keyboard-interactive） | ✅ | `src/App.tsx`、`src-tauri/src/commands/ssh.rs` |
| 本地 PTY 终端 | ✅ | `src/Terminal.tsx`、`commands/terminal.rs` |
| SFTP 基础 + 流式 + 递归 + 进度 + 取消 | ✅ | `src/SftpPanel.tsx`、`commands/sftp.rs` |
| 串口会话 | ✅ | `src/SerialPanel.tsx`、`commands/serial.rs` |
| Telnet 会话 | ✅ | `src/TelnetPanel.tsx`、`commands/telnet.rs` |
| 端口转发（local / remote / dynamic + 规则与统计） | ✅ | `src/ForwardPanel.tsx`、`commands/forward.rs` |
| 连接 / 凭据 / 分组管理 | ✅ | `src/ConnectionManager.tsx` |
| 多标签页 | ✅ | `src/Workspace.tsx`、`src/TerminalPane.tsx` |
| 分屏（水平 / 垂直 + 拖拽） | ✅ | `src/workspaceModel.ts`、`src/Workspace.tsx` |
| 会话恢复（localStorage + 恢复横幅） | ✅ | `src/backend/workspaceStore.ts` |
| 界面结构对齐 netcatty（TopTabs / 主机树 / Vault / AsidePanel） | ✅ | `src/TopTabs.tsx`、`src/HostSidebar.tsx`、`src/VaultView.tsx`、`src/AsidePanel.tsx` |
| 界面 1:1 复刻 netcatty（精确尺寸 / 配色 / 禁用未实现入口） | ✅ | `src/styles.css`、`src/TopTabs.tsx`、`src/VaultView.tsx` |
| Vault 首页两批差异（分组层级 / 置顶 / 多选 / 右键菜单 / 快速连接预填 / 右侧新建面板） | ✅ | `src/VaultView.tsx`、`src/ConnectionManager.tsx`、`src/App.tsx` |
| SSH 连接建立与管理（弹窗进度 / 逐跳日志 / 认证重试 / 主机密钥 / 超时 / 取消 / Enter 重连） | ✅ | `src/TerminalPane.tsx`、`src/terminal/TerminalConnectionDialog.tsx`、`src-tauri/src/ssh/client.rs` |
| 三平台 CI 构建 + Windows 代码签名 | ✅ | `.github/workflows/release.yml` |
| Known Hosts 管理页（列表 / 搜索 / 删除 / 转主机档案） | ✅ | `src/VaultView.tsx`、`src-tauri/src/ssh/known_hosts.rs` |
| 本地终端（shell 发现 + 本地 shell 主机 CRUD + LocalShellPanel + local 头像体系） | ✅ | `src/LocalShellPanel.tsx`、`src/domain/localShellHost.ts`、`src-tauri/src/terminal/shell_discovery.rs` |
| 设置中心（5 tab 1:1 + 3 占位 + 自启动命令 + 实机比对 + review 修复） | ✅ | `src/settings/`（model/store/i18n/keyBindings/Dialog/Tabs）、`src-tauri/src/commands/settings.rs` |

---

## P0 · 日常可用性（7 / 14）

- [x] ✅ **1. 多标签页**
  - 终端区支持多个标签、每个标签独立会话与状态，切换不重建。
  - 实现：`src/Workspace.tsx`（标签栏 / 活动窗格）、`src/TerminalPane.tsx`（每格独立会话）。
  - 参考：`components/top-tabs/`、`application/state/activeTabStore.ts`。
- [x] ✅ **2. 分屏（水平 / 垂直）**
  - 同一标签内可分割窗格，每格一个终端；支持拖拽调整尺寸。
  - 实现：`src/workspaceModel.ts`（split/prune/ratio 纯函数）、`src/Workspace.tsx`（嵌套渲染 + 分隔条）。
  - 参考：`components/workspace/`、`domain/workspace.ts`（split/insert/prune/sizing）。
- [x] ✅ **3. 会话恢复**
  - 重启后恢复上次的工作区、标签与分屏布局。
  - 实现：`src/backend/workspaceStore.ts`（`termx.workspace.v1`）+ 启动恢复横幅（用户确认后才重连）。
  - 参考：`components/workspace/`、`infrastructure/persistence/localStorageAdapter.ts`。
- [x] ✅ **4. Vault 三视图 + 快速搜索 + 拖拽**
  - 已实现：网格 / 列表 / 树、关键字搜索、分组层级与面包屑、快速连接与快速切换器、7 种排序、
    标签筛选、置顶、最近连接、多选批量（连接 / 移动 / 删除）、右键菜单、拖拽归组、框选、方向键导航。
  - 受限：分组单层（无多级路径）；标签 / 顺序 / 单击行为 / 面板宽度仅存前端 localStorage。
  - 参考：`components/host-browser/`、`domain/hostBrowser.ts`。
- [ ] ⬜ **5. Keychain 管理**
  - 密钥对生成、ssh-agent 检测、默认密钥（`~/.ssh`）列出与选用。
  - 后端：`generateKeyPair` / `checkSshAgent` / `getDefaultKeys`（netcatty 侧），termX 需补命令（ssh-agent 检测随 SSH agent 转发已纳入移植，见 P1 #39）。
  - 参考：`components/keychain/`。
- [x] ✅ **6. Known Hosts 管理页**
  - 已信任主机指纹列表、删除、编辑；连接弹窗之外的管理入口。
  - 实现：`src/VaultView.tsx` known-hosts 子页（列表/搜索/删除/转换为主机档案；
    哈希条目 `|1|` 仅展示不可删）；后端 `ssh/known_hosts.rs` 解析 + SHA256 指纹，
    `commands/profile.rs` 的 `known_hosts_list` / `known_hosts_remove`（lib.rs 与
    server.rs 双注册）。netcatty 本身也只有删除/转换、无编辑，视为对齐完成。
  - 参考：Vault 子页（`AGENTS.md`）、`electron/capabilities/catalog/vault.cjs`。
- [ ] ⬜ **7. Snippets（命令片段）**
  - 片段 CRUD、按主机/分组绑定、一键下发到终端。
  - 后端已就绪：`load_snippets` / `save_snippets`。
  - 参考：`components/snippets/`。
- [ ] ⬜ **8. SFTP 内置编辑器 + 文件监视回写**
  - 双击远端文件在编辑器打开、保存即回写；本地改动监视后自动同步远端。
  - 参考：`components/editor/`、`startFileWatch` / `onFileWatchSynced`（`netcatty-bridge-files.d.ts`）。
- [ ] ⬜ **9. SFTP 双栏 + 拖放**
  - 本地/远端双栏并排，拖拽上传下载，支持拖到系统桌面。
  - 参考：`components/sftp/`、`startLocalFileDrag`。
- [ ] ⬜ **10. 传输队列持久化**
  - 队列落盘、重启续传；暂停 / 恢复 / 优先级 / 全局并发上限。
  - 参考：`netcatty-bridge-sftp.d.ts` L33-L36、`components/sftp/`。
- [ ] ⬜ **11. 终端搜索 / URL 识别 / 滚动缓冲**
  - 搜索高亮与跳转、Ctrl+点击打开链接、缓冲区上限可配。
  - 依赖：`@xterm/addon-search`、`@xterm/addon-web-links`。
- [x] ✅ **12. 设置中心**（2026-11-03 完成：实现 + 实机比对差异清零 + review 修复，门禁全绿）
  - 主题（浅/深/跟随系统 + 终端主题）、字体与字号、快捷键、语言（i18n）、窗口透明度。
  - 实现：`src/settings/`（settingsModel/keyBindings/i18n/settingsStore/SettingsDialog/SettingsTabs）+ 自启动命令（Windows 注册表，双注册）。
  - 已知残留（见 changelogs 2026-11-03 实机比对节）：en 字典仅 14 键、主题预设库仅内置、透明度 CSS 近似、更新器/崩溃日志等未移植。
  - 参考：`components/settings/`、`application/state/fontStore.ts`、`customThemeStore.ts`。
- [x] ✅ **32. 主机「测试连接」**
  - 已实现：composer 头部「测试连接」(zap) → 先落库 → `ssh_connect`，监听
    `ssh:progress` 事件驱动状态机（connecting→…→connected/error），
    展示阶段文案/错误原因，可取消（`stopConnectionTest` 清理监听并断开会话）；
    「只认证不开 shell」语义以连接成功后立即断开实现（代码注释说明）。
  - 块 D 对齐：对话框文案/超时与 netcatty 1:1（deadline 25s = TCP 8s +
    auth 15s + grace 2s）。
  - 实现：`src/VaultView.tsx`（startConnectionTest / stopConnectionTest /
    测试对话框）、`src/styles.css`（host-test-* / vault-test-dialog）。
  - 参考：`components/host-details/HostConnectionTestDialog.tsx`、
    `domain/hostConnectionTest.ts`。
- [ ] ⬜ **33. 会话日志 / 录制 UI**
  - 终端工具栏可开始/停止录制、查看与导出会话日志；点亮当前禁用的「会话日志 / 开始录制」入口。
  - 依据：netcatty `startManualSessionLog` / `exportSessionLogs`（`netcatty-bridge-session.d.ts` L315-L328）；termX 后端 `session/recorder.rs` 已就绪、前端未接线。

---

## P1 · 差异化能力（0 / 19，含 1 项 ⏸ 不移植）

- [ ] ⬜ **13. 脚本系统**
  - 脚本运行 / 停止 / 暂停 / 恢复、录制回放、屏幕快照、脚本内对话框。
  - 参考：`components/scripts/`、`netcatty-bridge-script.d.ts` L148-L168。
- [ ] ⬜ **14. 主机监控面板**
  - CPU / 内存 / 磁盘 / 网络历史曲线，采样失败自动重试。
  - 审计修正（2026-11-02）：termX 后端并不存在 `getServerStats` 命令（全后端检索确认），需先补后端采集命令，再做前端采集循环与图表。
  - 参考：`components/systemManager/`、`netcatty-bridge-monitor.d.ts`。
- [ ] ⬜ **15. 云端同步**
  - Gist / WebDAV 双向同步、自动同步、冲突提示、本地快照备份。
  - termX 后端已有 `sync` 模块（未验证、零 UI）。
  - 参考：`components/cloud-sync/`、`components/sync/`。
- [ ] ⬜ **16. 端口转发可视化 + 托盘开关**
  - 规则总览页（按主机分组、运行状态）、托盘快捷启停。
  - 参考：`components/port-forwarding/`、`onTrayTogglePortForward`。
- [ ] ⬜ **17. 内嵌图片（Kitty / SIXEL / iTerm）**
  - 远端程序输出的图形直接在终端渲染。
  - 依赖：`@xterm/addon-image`。
- [ ] ⬜ **18. Zmodem / Ymodem 传输**
  - 终端内 `rz`/`sz` 自动接管，拖拽上传走 zmodem。
  - 参考：`onZmodemEvent` / `sendSerialYmodem`。
- [ ] ⏸ **19. Mosh / Eternal Terminal 会话（不移植）**
  - 按计划跳过，不算差距；详见「不移植」节。`VaultView.tsx` `ADVANCE_PLACEHOLDERS` 已留占位文案。
- [ ] ⬜ **20. Telnet 自动登录**
  - 按 login/password 提示自动应答，完成/取消事件。
  - 参考：`onTelnetAutoLoginComplete`。
- [ ] ⬜ **21. 自动更新**
  - 检查 / 下载 / 安装 / 进度事件；接 `tauri-plugin-updater`。
  - 现状：只有 `fetch_latest_release_tag`。
  - 参考：`netcatty-bridge-app.d.ts` L5-L31。
- [ ] ⬜ **22. 深链 / 单实例 / 托盘 / 多窗口**
  - `ssh://` `telnet://` `jms://` 协议唤起、单实例聚焦、托盘面板、会话开新窗口。
  - 参考：`electron-builder.config.cjs` protocols、`openSessionInNewWindow`。
- [ ] ⬜ **23. 应用锁 + 凭据加密存储**
  - 启动密码/生物识别解锁；凭据落盘加密。
  - 参考：`components/AppLock*.tsx`、`credentialsEncrypt` / `credentialsDecrypt`。
- [ ] ⬜ **24. 归档解压**
  - SFTP 右键解压 `.tar` / `.zip` 等。
  - 参考：`extractSftpArchive`。
- [ ] ⬜ **25. 文件名编码切换**
  - SFTP 目录与读写支持 GBK 等编码。
  - 参考：`SftpFilenameEncoding`。
- [ ] ⬜ **26. CLI**
  - `termx-tool` 命令行（会话/传输/vault/转发/片段），供 Agent 与脚本调用。
  - 后端已有 `cli_status` / `cli_install`，缺命令实现。
  - 参考：`electron/cli/netcatty-tool-cli.cjs`。
- [ ] ⬜ **34. 主机表单高级字段**
  - 至少补：环境变量、字符集、启动命令执行模式、主题/字体覆盖、图标；向 netcatty Host 模型字段面对齐。
  - 依据：netcatty `domain/models/connection.ts` Host 约 30 字段；termX 表单仅 11 个（名称/地址/端口/凭据/分组/标签/登录方式/用户名/密码/密钥文件/启动命令）。
- [ ] ⬜ **35. 串口参数缺口**
  - 补 mark/space 校验、1.5 停止位、字符集、串口自动登录（username/password）。
  - 依据：netcatty `startSerialSession` 参数面（`netcatty-bridge-session.d.ts` L133-L147）；termX `SerialConfig` 仅 none/odd/even 校验与 1/2 停止位，`serial_open` 无登录参数。
- [ ] ⬜ **36. SFTP 细节交互**
  - 面包屑导航、覆盖冲突对话框、同主机复制（与 #24 归档解压联动）。
  - 依据：netcatty `components/sftp/SftpBreadcrumb.tsx` / `SftpConflictDialog.tsx`；termX `SftpPanel.tsx` 为单栏、无面包屑、无冲突提示。
- [ ] ⬜ **37. Vault 其余子页**
  - 笔记、会话日志页、代理配置入口（当前导航为禁用占位）。
  - 依据：netcatty `components/notes/`、会话日志与代理配置入口；termX `VaultView.tsx` navItems 中 monitor/keys/proxies/port/snippets/notes/logs 均禁用。
- [ ] ⬜ **39. SSH agent 转发（2026-11-02 范围修正纳入移植）**
  - 按 Netcatty 的代理/agent 转发界面与逻辑 1:1：agent 列表、转发开关、认证走 agent（以 Netcatty 实际行为为准）。
  - 与「代理」配置（#37 入口）一起排期，建议紧跟端口转发/代理模块，先后按依赖定。
  - 安全口径：SSH_AUTH_SOCK 路径与密钥信息不进日志、提交与文档；实机验证不明文落盘凭据。
  - mosh / eternalTerminal / X11 转发仍不移植。

---

## P2 · 大工程（0 / 6，含 4 项 ⏸ 暂缓移植）

- [ ] ⏸ **27. AI 侧栏（Catty 等价物）（暂缓移植，plan.md 口径）**
  - Provider / 模型管理、流式对话、工具调用审批、隐私脱敏、用量统计、上下文压缩。
  - termX 后端约 36 个命令已就绪，UI 为零；按 `docs/plan.md` 暂缓口径，前端侧栏暂缓移植，待 P0/P1 收敛后再启动。
  - 参考：`components/ai/`、`netcatty-bridge-ai.d.ts`。
- [ ] ⏸ **28. MCP server + RPC 能力面（暂缓，plan.md 口径）**
  - catalog 驱动对外暴露工具，外部 Agent 可调。`docs/plan.md` 列为暂缓项，待 P0/P1 收敛后再启动。
  - 参考：`electron/capabilities/catalog/`、`netcatty-mcp-server.cjs`。
- [ ] ⏸ **29. 插件宿主（暂缓，plan.md 口径）**
  - `.ncpkg` 安装 / 启停 / 卸载、沙箱运行时、Node 插件（实验）。`docs/plan.md` 列为暂缓项；后端已有 plugin 命令，前端零 UI。
  - 参考：`components/plugins/`、`electron/plugins/`。
- [ ] ⏸ **30. Codex App Server 集成（暂缓移植，plan.md 口径）**
  - 持久 `codex app-server --stdio` 运行时、审批与 thread 路由。
  - 按 `docs/plan.md` 暂缓口径，属暂缓移植范围，待 P0/P1 收敛后再启动。
  - 参考：`AGENTS.md`「Codex App Server」。
- [ ] ⬜ **31. 终端细节增强**
  - 命令块脱敏、命令黑名单、光标行高亮、OSC7 目录追踪、压缩包快捷解压、Unicode 宽字符、中文输入法适配。
  - 参考：`commandBlocklist.ts`、`cursorLineHighlight.ts`、`inheritedCwd.ts`。
- [ ] ⬜ **38. 会话快照迁移**
  - 跨窗口 / 重启的会话状态交接（序号、回滚缓冲、激活态），配合 #22 多窗口。
  - 依据：netcatty `requestTerminalSessionSnapshot` / `requestTerminalSnapshotStream` / `applyTerminalSnapshot` 等（`netcatty-bridge-session.d.ts` L301-L310）；termX 仅有布局级恢复，无会话内容快照。

---

## 不移植（按计划跳过，不算差距）

| 项 | 口径 |
|---|---|
| Mosh | 按计划跳过（原 #19 已标 ⏸）；`VaultView.tsx` `ADVANCE_PLACEHOLDERS` 已留占位文案 |
| Eternal Terminal | 按计划跳过（原 #19 已标 ⏸）；同上 |
| ~~SSH 代理（agent 认证 / 转发）~~ **已纳入移植**（2026-11-02 范围修正） | 见 P1 #39，与「代理」模块一起排期；mosh / eternalTerminal / X11 仍不移植 |
| X11 转发 | 按计划跳过；占位文案同上 |
| FIDO / Windows Hello、MCP（#28）、插件宿主（#29）、AI 侧栏（#27）、Codex App Server（#30） | `docs/plan.md` 暂缓项，已标 ⏸ 暂缓移植，不算当前差距 |

---

## 代码质量问题（2026-11-02 只读审计）

> 来源：对照 netcatty 的只读审计（快照时间 2026-11-02 约 18:35）。此处只记录问题与建议动作，不代改代码。

1. **headless dispatcher 注册缺口（违反 R4）**：`src-tauri/src/server.rs` 缺 `ssh_exec`、`known_hosts_list` / `known_hosts_remove`、5 个 discovery 命令、`open_external_url` 的分支 → JetBrains/headless 运行时这些命令会 command not found。建议：补齐 dispatcher 分支（`lib.rs` 侧均已注册）。
2. **两套主机表单字段不一致**：`VaultView.tsx` 右侧新建面板与 `ConnectionManager.tsx` 弹窗各有一套 profile+credential 表单；后者有跳板机选择，前者建出来 `bastion_profile_id` 恒为 null → 同一操作两个入口两种能力，易产生数据不一致。建议：收敛为单一表单模型/组件。
3. **大文件职责混杂**：前端 `VaultView.tsx`（86KB：导航+三视图+搜索排序+标签+多选+右键+拖拽+框选+快速连接+已知主机页）、`TerminalPane.tsx`（40KB：状态机+工具栏+菜单+弹窗编排）、`styles.css`（103KB）；后端 `commands/lifecycle.rs`（105KB）、`ai/sanitize.rs`（100KB）、`ai/session.rs`（95KB）、`server.rs`（76KB）、`sync/config.rs`（76KB）、`ssh/client.rs`（68KB）。建议：相关维护时按职责拆分，不专项重写。
4. **前端无测试 runner（已解决 2026-11-02）**：已引入 Vitest 3 + jsdom（`vitest.config.ts` + `src/test/setup.ts`，9 个测试文件 / 71 用例，`npm run test:run` 全绿），覆盖 domain 纯逻辑 / workspaceModel / backend 桥接 / 工作区持久化 / 认证表单；门禁规则见 AGENTS.md R11，细节见 changelogs.md 同日条目。
5. **sftp_download 内存版 IPC 膨胀**：返回 `number[]`，大文件约 4 倍膨胀；已有流式版 `sftpDownloadTo`。建议：内存版仅限小文件场景或移除。
6. **多组后端命令前端零调用**：discovery(5)、plugin(7)、command_block(3)、window(3：`open_tab_in_new_window` / `clipboard_read` / `clipboard_write`)、update（`fetch_latest_release_tag`）、sync(11)、AI（约 36）、`reconcile_sessions`。建议：随对应模块（#15/#26/#27 等）接线，或显式标 ⏸，避免长期死代码。
7. **cargo check 6 个 dead-code 警告**：`ai/llm.rs` 字段、`sanitize::decode_lossy`、`cli_status_headless`、`forward_rule_start_impl` / `forward_rule_stop_impl`（后两者疑似与 SSH 移植会话的快照时间差所致）。建议：移植收尾后复查清理。
8. **todo 口径冲突已修正**：P1 #14 原称「后端已有 getServerStats」不实（已改写）；#19 与「不移植」口径冲突（已标 ⏸）；#28/#29 与 plan.md 暂缓口径对齐（已标 ⏸）。

---

## 更新记录

| 日期 | 变更 |
|---|---|
| 2026-10-30 | 建立清单：P0 12 项、P1 14 项、P2 5 项；已移植 8 项归档。 |
| 2026-10-30 | 完成 P0 #1~#3：多标签、分屏、会话恢复（3 / 31）。 |
| 2026-11-01 | 浅色 snow 默认主题；首页页头「终端 / 串口」入口；全部主机 + 最近连接分区；终端窗格顶部工具栏（31 项清单外，属 UI 复刻补全）。 |
| 2026-11-01 | 终端工具栏左侧改为 时钟 / 系统监控(仅 SSH) / 断开 / 重连；⋮ 只留 终端外观、开始录制；分屏移入终端右键菜单（复制/粘贴/全选/浏览器/重连/分屏/清屏/关闭）。 |
| 2026-11-02 | Vault 首页两批差异补齐：导航补已知主机/日志、侧栏拖宽、分组层级与面包屑、置顶、真实在线数、视图/排序持久化、快速连接预填、右键菜单、多选批量删除、右侧新建主机面板；P0 #4 剩拖拽归组。 |
| 2026-11-02 | Vault 首页继续对齐：7 种排序 + 手动顺序、标签系统与筛选、最近连接规则、单击行为、快速切换器/快速连接向导、分组右键管理、拖拽归组、框选、方向键导航、可拖宽主机面板、toast；P0 #4 完成（4 / 31）。 |
| 2026-11-02 | SSH 主机连接收尾：composer 重构为 netcatty 四分区（名称/地址/端口与凭据/高级占位，Mosh、永恒终端、SSH 代理、X11、TOTP、certificate 显式禁用）；已知主机管理页（解析列表/搜索/删除/转为主机档案）；新增 list_ssh_key_files、known_hosts_list、known_hosts_remove 三命令双注册；P0 #6 完成（5 / 31）。 |
| 2026-11-02 | 只读审计结论落档：新增 #32~#33（P0）、#34~#37（P1）、#38（P2），进度总览更新为 5 / 38；修正 P1 #14（termX 后端并无 getServerStats，需先补后端采集）；#19 改 ⏸ 不移植、#28/#29 改 ⏸ 暂缓（plan.md 口径）；新增「不移植」「代码质量问题（8 项）」两节；「已完成」表补 Known Hosts 行。 |
| 2026-11-02 | P2 #27 AI 侧栏、#30 Codex App Server 改 ⏸ 暂缓移植（plan.md 口径）：AI 后端 36 命令保留、前端侧栏暂缓；P2 节标题与进度总览同步为「含 4 项 ⏸ 暂缓移植」；「不移植」节同步列入两项。 |
| 2026-11-02 | 代码质量问题 #4（前端无测试 runner）已解决：引入 Vitest 3 + jsdom 单元测试设施（9 文件 / 71 用例全绿），AGENTS.md 新增 R11 门禁（`npm run test:run` → `npm run build` / `cargo check`）。 |
| 2026-11-02 | 第二轮 1:1 对齐块 D/E 完成：块 D 连接建立对话框文案/字段/超时逐字对齐 netcatty（认证对话框 SSH Key tab + 分体「继续/继续并保存」、主机密钥「尚未确认…/记住并继续」、逐跳日志中英混排、认证重试默认密码 tab + root 预填、测试连接 25s）；块 E 主机卡片右键菜单对齐 netcatty 9 项（删「标签…」与分隔线、删孤儿 tagEditor）、「新建主机」caret 文案（本地终端 (CMD)/导入/导出）；门禁修复块 A 遗留（v33 迁移补 table_exists 守卫、migration_32 断言改 SCHEMA_VERSION、PTY 冒烟测试 cfg(unix)）。门禁全绿（npm build ✓ / cargo check ✓ ×2 / cargo test --lib 780✓）。P0 #32 完成（6 / 38）。 |
| 2026-11-02 | 范围修正：SSH agent 转发纳入移植（新增 P1 #39，与「代理」一起排期）；「不移植」节 SSH 代理条目改写为已纳入，mosh / eternalTerminal / X11 维持不移植；总数 38 → 39。实机验收（对运行中 Netcatty 1.1.90）差异清单已落 changelogs，修复进行中。 |
| 2026-11-02 | 十功能计划①本地终端完成：shell 发现 + 本地 shell 主机 CRUD + LocalShellPanel 1:1（对照运行中 Netcatty）；实机比对差异清零（下拉选中态 / local 实底蓝白头像含卡·树·切换器 / local 标签 chip）；子 agent review 两必须修复项（CM 过滤 local、切换器头像）已修；门禁 97/97 + cargo 全绿。 |
| 2026-11-03 | 按用户指令顺序调整：下一功能=设置中心（#12 标 🟨），SFTP 延后（研究已落盘 Temp）；设置中心研究完成（Netcatty 源码地图+termX 现状+CU 顶栏/SFTP 取证），实现开工。 |
| 2026-11-03 | 设置中心实现 + 门禁完成：5 tab（应用/外观/终端/快捷键/系统）1:1 + 3 占位（文件关联/AI/同步），全屏 overlay 承载（Netcatty 独立窗口形态差异记录在案）；新增 get_auto_launch/set_auto_launch（Windows 注册表，lib.rs + server.rs 双注册），复用 list_fonts/secret_backend；新增前端单测 12 例；门禁全绿（109/109 + build ✓ + cargo check ×2 + cargo test --lib 789✓）；实机比对与子 agent review 留下一轮。 |
| 2026-11-03 | 设置中心实机比对 + review 收尾，P0 #12 完成（7 / 39）：CU 对照运行中 Netcatty 逐 tab 比对，差异当场修并复检一致（SFTP 标签/外观/终端主题/快捷键文案与中文绑定标签/系统软件更新节/侧栏残留按钮）；实时生效与 SSH 129 连接验证通过（钥匙串凭据，密码不落盘）；子 agent review（高=无）中危 4 项已修（--termx-accent 只写不读→映射 --primary/--accent、set_auto_launch 失败语义改 Result、headless 守卫、server.rs spawn_blocking），低危记录待后续；门禁 112/112 + build ✓ + cargo check ✓ + cargo test --lib 789✓；按指令本地 commit 未 push（另一会话清理历史中，后续改 SSH 推送）。 |
| 2026-11-03 | 推送完成：`3724ff1` + `f3f9dd3` 经 SSH 推送，远端 main = `f3f9dd3`（ls-remote 核对）。SFTP·研究阶段收尾：对照 Netcatty 界面观察与源码核实缺口清单（双栏/标签栏/面包屑/列头虚拟列表/传输队列底部面板/冲突对话框/编辑器+监视回写/拖放/编码等，前端 14 组全缺 + 后端 8 组需补），落盘 changelogs 2026-11-03 SFTP 研究节；下一轮按依赖顺序实现（先本地 FS 后端 + 双栏骨架）。 |
| 2026-11-03 | 研究文档单独提交 `078b35a`（docs）。SFTP 实现①（后端）完成：新建 commands/localfs.rs 10 个本地 FS 命令（LocalEntry 含 hidden/link_target；Win 盘符探测；realpath 去 \\?\ 前缀；remove 类型守卫 local_type_stale；read_file 超限读尾）+ sftp_lstat/sftp_realpath（FileStat 增量加 is_symlink）；lib.rs + server.rs 双注册；单测 +3（792✓）；cargo check ×2 ✓；client.ts 封装与前端留②。 |
| 2026-11-03 | SFTP 实现②（前端骨架）完成：新建 src/sftp/（sftpModel 纯逻辑 + SftpView 双栏/聚焦三角 + SftpTabBar + SftpPaneEmptyState + SftpHostPicker 三分区/键盘导航 + SftpPaneView 骨架列表）；连接流三分支（本地/复用 SSH 会话/独立连接）；client.ts 封装实现①全部命令（不裸 invoke）；App.tsx surface==="sftp" 挂载切换为全幅双栏；单测 +14（126✓）；门禁 test/build/cargo check 全绿；实机比对与推送留下一轮。 |
| 2026-11-03 | SFTP 实现①②推送前 review + push：子 agent review 无高危（八大重点：路径边界/大文件/类型守卫/错误映射/凭据安全/双注册/无裸 invoke/测试可信度）；中危 2 已修（local_read_file 缺省 16MiB 尾部读上限 + read_skip 纯函数与用例、3 个本地错误码 i18n 映射），低危 4 记录待后续；门禁全绿（126✓ + build✓ + cargo check×2✓ + cargo test --lib 793✓）；核对远端 main=1f5af63（本地祖先）后经 SSH 推送，远端 HEAD 以 ls-remote 核对。 |
| 2026-11-03 | SFTP 实现③完成（状态保活 + OS 图标 + 低危收尾）：App.tsx SftpView 改首次激活后常驻挂载 + `.nc-sftp-mount.hidden` 隐藏（对齐 Netcatty SftpViewMount sticky 保活，切 surface 不丢 pane tab/双栏状态）；sftpModel 新增 HostOs/detectLocalOs/osFromUname/osIconName（纯函数 + 单测），本地标签图标随本机 OS、复用会话远端标签 uname -s best-effort 探测、独立连接回落服务器图标（Netcatty GPL 资产与 host.os 字段判定不可复用，采原创通用映射并落 changelogs）；低危 4 项闭环（FileStat.is_symlink 声明、localRemove expectedType 必传、client.test.ts +8 例覆盖 12 封装、孤儿 .nc-sftp-page CSS 删除）；门禁全绿（136/136 + build✓ + cargo check×2✓ + cargo test --lib 793✓）；本地 commit 未推送，实机比对留下一轮。 |
| 2026-11-03 | SFTP 实现③·实机比对：CU 验证受坐标 artifact 阻塞延后（多种坐标映射证伪、按钮 7 次点击仅焦点变化 picker 未弹、overlay fixed 排除 CSS 回归、devtools 注入无效、无快捷键可绕过）；构建/启动/双栏空态渲染已确认，源码核查未见缺陷，本轮无代码修复，门禁沿用 35e988a 全绿；仅文档提交，轮末结束 rssh.exe 防构建锁；下一起点=review+push → SFTP 文件操作。 |
| 2026-11-03 | SFTP 实现③推送前 review + push：子 agent review 范围 0132eea..HEAD，六大重点全过（保活无泄漏 / display 切换无副作用 / uname 探测安全 / OS 回退健全 / localRemove 无破坏 / 测试非形式主义），无高/中危，低危 2 项记录（osFromUname startsWith 容忍度、保活拉长死标签驻留）；门禁全绿（136/136 + build✓ + cargo check×2✓ + cargo test --lib 793✓）；推送 35e988a+3d9c143，远端 main=3d9c143（ls-remote 复核）；下一起点=SFTP 文件操作（后端用 129 真实连接自动化验证，不依赖 CU）。 |
