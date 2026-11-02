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
| P0 日常可用性 | 4 / 12 | 不补齐难以日常使用 |
| P1 差异化能力 | 0 / 14 | 拉开与普通 SSH 客户端差距 |
| P2 大工程 | 0 / 5 | 需单独立项 |
| **合计** | **4 / 31** | |

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

---

## P0 · 日常可用性（4 / 12）

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
  - 后端：`generateKeyPair` / `checkSshAgent` / `getDefaultKeys`（netcatty 侧），termX 需补命令。
  - 参考：`components/keychain/`。
- [ ] ⬜ **6. Known Hosts 管理页**
  - 已信任主机指纹列表、删除、编辑；连接弹窗之外的管理入口。
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
- [ ] ⬜ **12. 设置中心**
  - 主题（浅/深/跟随系统 + 终端主题）、字体与字号、快捷键、语言（i18n）、窗口透明度。
  - 参考：`components/settings/`、`application/state/fontStore.ts`、`customThemeStore.ts`。

---

## P1 · 差异化能力（0 / 14）

- [ ] ⬜ **13. 脚本系统**
  - 脚本运行 / 停止 / 暂停 / 恢复、录制回放、屏幕快照、脚本内对话框。
  - 参考：`components/scripts/`、`netcatty-bridge-script.d.ts` L148-L168。
- [ ] ⬜ **14. 主机监控面板**
  - CPU / 内存 / 磁盘 / 网络历史曲线，采样失败自动重试。
  - 后端已有 `getServerStats`，缺采集循环与图表。
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
- [ ] ⬜ **19. Mosh / Eternal Terminal 会话**
  - 新增会话类型；需要 sidecar（`mosh-client`、`et`）。
  - 参考：`startMoshSession` / `startEtSession`。
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

---

## P2 · 大工程（0 / 5）

- [ ] ⬜ **27. AI 侧栏（Catty 等价物）**
  - Provider / 模型管理、流式对话、工具调用审批、隐私脱敏、用量统计、上下文压缩。
  - termX 后端约 36 个命令已就绪，UI 为零。
  - 参考：`components/ai/`、`netcatty-bridge-ai.d.ts`。
- [ ] ⬜ **28. MCP server + RPC 能力面**
  - catalog 驱动对外暴露工具，外部 Agent 可调。
  - 参考：`electron/capabilities/catalog/`、`netcatty-mcp-server.cjs`。
- [ ] ⬜ **29. 插件宿主**
  - `.ncpkg` 安装 / 启停 / 卸载、沙箱运行时、Node 插件（实验）。
  - 参考：`components/plugins/`、`electron/plugins/`。
- [ ] ⬜ **30. Codex App Server 集成**
  - 持久 `codex app-server --stdio` 运行时、审批与 thread 路由。
  - 参考：`AGENTS.md`「Codex App Server」。
- [ ] ⬜ **31. 终端细节增强**
  - 命令块脱敏、命令黑名单、光标行高亮、OSC7 目录追踪、压缩包快捷解压、Unicode 宽字符、中文输入法适配。
  - 参考：`commandBlocklist.ts`、`cursorLineHighlight.ts`、`inheritedCwd.ts`。

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
