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
| P0 日常可用性 | 12 / 14 | 不补齐难以日常使用 |
| P1 差异化能力 | 0 / 19 | 拉开与普通 SSH 客户端差距（含 1 项 ⏸ 不移植；#39 为范围修正新增） |
| P2 大工程 | 0 / 6 | 需单独立项（含 4 项 ⏸ 暂缓移植，见 plan.md） |
| **合计** | **12 / 39** | 2026-11-03：会话日志阶段 B 完成（终端工具栏/More 手动开始-停止录制 + REC 状态、三格式导出落盘、ANSI 彩色渲染；129 实机录制→列表→详情→导出实测，导出保留 ANSI；同名同秒文件加序号防覆盖；回放明确留档不做）。#33 收官，#37 仅剩代理入口。历史：2026-11-03：会话日志阶段 A 完成（Vault「日志」页 + `session_logs` 索引 schema v38 + 列表/详情/导出/删除四命令双注册 + 11 前端/11 后端单测；尚未完成录制开关与导出落盘，故 #33 仍 ⬜，#37 仅日志页部分 ✅）。历史：2026-11-03：笔记阶段 B 完成（Markdown 预览/格式工具栏/分组/导入导出/ssh 链接跳转，129 实测），笔记子项收官、#37 仍差日志与代理入口；review 中危 2 修复；门禁 325✓/build✓/cargo check(server)✓/842✓；导出落盘与富文本待人工。历史：2026-11-03：Telnet 连接入口修复（同串口病根）：移除 `ensureTab()`，Vault 新增「Telnet」入口 → 单步模态 → 确认后建 `Connector.kind=telnet` 标签；`TerminalPane` 承担订阅/打开/输入/resize/关闭与本地回显，删除 `TelnetPanel`/`TermBridge`；Netcatty 取证为 host 协议 + 模态向导，独立入口与凭据字段差异已记录；门禁 306✓/build✓/cargo check(server)✓/836✓；证据 7 张（含 bug 前后对照）；待人工：真实 Telnet 设备、自动登录（P1 #20）。历史：2026-11-03：脚本与 Snippets 阶段 B（P0 #5）完成：脚本最小闭环（kind=script 发送到活动 shell）+ multiLineRunMode（paste/lineDelay 250ms）+ Netcatty snippet 导入导出（version 3）+ 129 实跑隔离验证；门禁 263✓/build✓/cargo check(server)✓/836✓；无高/中危；历史：2026-11-03：脚本与 Snippets 阶段 A 完成：后端字段补齐 + src/snippets 页面挂 Vault 导航 + 终端右键/快捷键插入（仅当前会话）+ 15 纯逻辑测试；门禁 242✓/build✓/cargo check(server)✓/836✓；CU 截图确认页面与 F2 插入执行；右键菜单插入待人工点测；本地 commit 未推送，阶段 B（脚本链路/导入导出/129/review+push）下轮。历史：2026-11-03：SFTP 拖放与面包屑/工具条（#9）全部完成：阶段 A 工具栏+面包屑+排序+隐藏开关（ca0afe0）；阶段 B 跨栏拖放入队（文件行拖对面栏=上传/下载入队，落点语义对齐 Netcatty：目录行=进该目录/空白=当前目录；同侧拖拽拒绝）+ 拖出到桌面明确不做（WebView2 无 CF_HDROP 桥，记后续原生桥候选）+ 129 live 等价验证 27✓ + 自审无高/中危；门禁 209✓/build✓/cargo check(server)✓/813✓，随阶段 A 推送；下一起点=串口。历史：2026-11-03：（#9）阶段 A 完成：两行工具栏+面包屑+列头排序+隐藏开关+双击/回车进入目录，sftpModel 纯逻辑+19 单测（202✓/813✓）。历史：2026-11-03：编辑器与监视回写（#8）阶段 B 收官、#8 全部完成：文件监视回写（本地轮询/远端 stat 比对 + 保存回环抑制 + 外部修改重载对话框）+ 外部编辑器打开（local_open_path / sftp_open_external，双注册）+ 129 live 全绿（揪出并修复 upload 不截断高危）+ 自审无遗留高/中危；门禁 183✓/build✓/cargo check✓/813✓/live✓，随推 d4b0886（阶段 A）+ 阶段 B；下一起点=SFTP 拖放与面包屑/工具条（#9）。历史：2026-11-03：编辑器与监视回写（#8）阶段 A 完成：远端读写命令（10 MiB 预检）+ src/editor 低依赖编辑器（保存/另存/未保存确认）+ 双注册 + 19 新单测（179✓/809✓），本地 commit 未推送；阶段 B 文件监视回写/外部编辑器/129 live/review+push 待办。2026-11-03：SFTP 实现③（状态保活 + OS 图标 + 低危收尾）：SftpView 改首次激活后常驻挂载 + `.nc-sftp-mount.hidden` 隐藏（对齐 Netcatty SftpViewMount sticky 保活，切 surface 不丢 pane tab/双栏状态）；新增 HostOs 判定（本地 userAgent / 复用会话 uname -s best-effort）与 os-* 原创图标（Netcatty GPL 资产与 host.os 字段判定不可复用，通用映射并说明）；低危 4 项闭环（FileStat.is_symlink、localRemove 守卫恒传、12 封装测试覆盖、孤儿 CSS）；门禁全绿（136✓/build✓/cargo check×2✓/test --lib 793✓），本地 commit 未推送；实现③实机比对受 CU 坐标 artifact 阻塞延后（构建/启动/空态渲染已确认，未见代码缺陷）；review+push 完成（无高/中危，门禁全绿，远端 main=3d9c143）；SFTP 文件操作（上传/下载/删除/重命名/chmod）实现完成：server.rs 补 sftp_chmod 双注册、SftpPaneView 右键菜单/对话框/传输条接线、129 真实连接 live 测试全链路绿；review+push 完成（中危 1 修复= sftp 错误码 i18n 映射，低危 5 记录，门禁 140✓/794✓，远端 main=87e197e）；下一起点=传输队列与冲突对话框（Netcatty 队列面板：暂停/恢复/优先级/并发 + 冲突提示），视觉比对留人工/新 CU；传输队列阶段 A（后端队列中心）完成：队列中心+冲突检测后端+事件契约+schema v35+9 命令双注册+11 单测（805✓），本地 commit 未推送，阶段 B 前端队列面板 / 阶段 C 冲突对话框+129 live 待办；阶段 B 完成（e9b2917）；阶段 C（冲突对话框 + apply-to-all 回溯 + 129 live 五场景全绿 + 自审无高/中危）完成，P0 #10 三阶段全部完成；门禁 163✓/build✓/cargo check✓/806✓/live✓，随推 e0e83c1+1cf1bcc+e9b2917+阶段 C；下一起点=编辑器与监视回写（#8） |
| 串口 1:1 重做（#35） | ✅ 完成 | 2026-11-03：常量表 + 输入语义 + 配置驱动 UI；阶段 B 视觉复检、COM1 实测、句柄释放/文案修复、review + push 完成。 |
| 串口热修（入口 + 弹窗形态） | ✅ 完成 | 2026-11-03 用户实测反馈：点「串口」误开本地终端（`ensureTab()` 新建 pty 标签）→ 改为弹窗先行，确认后建 `Connector.kind=serial` 标签；删除右侧 SerialPanel，重做 Netcatty 形态弹窗（标题/字段顺序/默认值/高级折叠/取消连接/自动聚焦）。证据：evidence/serial-after-click.png、serial-fixed-modal-final.png、serial-ui-compare.png。待人工：保存配置（无 host 模型，不复刻）、真实收发回环。笔记阶段暂缓。 |
| 笔记阶段 A（P0 #37 之一） | ✅ 完成 | 2026-11-03：DB `notes` 表（schema v37）+ `list/get/save/delete_note` 双注册；前端 `src/notes/`（列表 + 编辑 + 搜索 + 标签 + 置顶/删除 + 600ms 防抖保存 + Ctrl/Cmd+S），`VaultView` 启用「笔记」导航；8 例前端单测 + 6 例后端单测；Netcatty 对照截图（富文本差异留阶段 B）。证据：notes-termx/edited/tags/persisted/netcatty-notes。待人工：Markdown 预览、关联主机、分组、导入导出、大列表性能。 |
| 笔记阶段 B（P0 #37 之二） | ✅ 完成 | 2026-11-03：Markdown 原文/预览切换（自研低依赖解析，无 innerHTML）+ 8 按钮格式工具栏（H1/H2/B/I/列表×2/引用/代码，可切换）+ 分组路径与分组过滤 + 单条/全部导出（`<分组>/<标题>.md`）+ Markdown 导入（frontmatter/H1/文件名取标题）+ `[名称](ssh://user@host:port)` 主机链接插入与点击开会话（129 实测直连）。新增 `@tauri-apps/plugin-dialog`（capabilities 已有 dialog:default），读写复用 localfs。review 中危 2 已修（ref 先行防旧内容、导出取当前稿）。证据 notes-b-list/preview/hostlink-open + netcatty-notes。门禁 325✓/build✓/cargo check✓/842✓。待人工：导出落盘全流程、表格/图片/公式、大列表性能。 |
| 终端工具栏「更多」菜单 + 像素级统一 | ✅ 完成 | 2026-11-04：5 项逐项实现（命令历史 / 配置目录追踪 / 终端设置 / 开始-停止录制 / 终端编码），不支持的传输保留条目并置灰+行内原因；新增 OSC 7 hook 安装对话框与 cwd 回传、GB18030 终端编码（后端输入转码 + 前端流式解码 + 按主机持久化）、设置中心直达；工具栏按钮 24×24 / 6px 圆角 / 2px 间距 / 12px 图标 / hover 透明，菜单 192px / 4px 内边距 / 28px 行高 / 4px 行圆角 / 12px 字号 / shadow-md / 4px 偏移 / 150ms zoom-fade。真机 129 CDP 逐项验证；门禁 373✓/build✓/cargo check(server)✓/874✓。缺口：OSC 7 未 percent-encode、cwd 未接 SFTP 跟随、日志按钮下拉未做、GB18030 日志转码未做。 |
| 设置中心「终端」tab 1:1 复刻 | ✅ 完成 | 2026-11-04：主题跟随、字体 9 项（字体族/CJK/字号 10–32/两档字重/平滑/连字/行间距/仿真类型）、光标 4 项、键盘 3 项（置灰）、行为 30 行全量接通（右键三态+长按+全屏、中键三态、选择即复制/规范化、分隔符、括号粘贴、多行确认、Shift+Enter、标签双击、OSC 52、滚动 5 项、退出自动关闭、断开提示模式、回滚 0–100000、侧边栏 2 组、verifyHostKeys）；默认值与 Netcatty 逐键对齐；改设置即时生效、重启保留。真机 CDP 验证字号/字重/竖线/行高亮/右键菜单；门禁 379✓/build✓/cargo check(server)✓/874✓。缺口：Netcatty 实例不可用（像素并排待复核）、侧栏仅接 SFTP、本地 PTY TERM 固定、12 项保留置灰。 |
| Telnet 连接入口修复（同病根） | ✅ 完成 | 2026-11-03：移除 `ensureTab()` 兜底（全仓删除），Vault 补「Telnet」入口 → `TelnetConnectModal`（主机/端口 23/换行风格，单步模态）→ 确认后建 `Connector.kind=telnet` 标签；`TerminalPane` 负责订阅/打开/输入/resize/关闭 + 本地回声；删除 `TelnetPanel` 与 `TermBridge`。Netcatty 取证为模态向导（host 协议）；差异=独立入口与凭据字段（后端无凭据参数，不做假字段）。证据：telnet-before/after-click、telnet-connected、telnet-input、netcatty-quickconnect/telnet-selected/step2。门禁 306✓/build✓/cargo check✓/836✓。待人工：真实 Telnet 设备、用户名密码自动登录（P1 #20）。 |

---

## 已完成（无需再做）

| 能力 | 状态 | 位置 |
|---|---|---|
| SSH 会话（密码 / 私钥 / keyboard-interactive） | ✅ | `src/App.tsx`、`src-tauri/src/commands/ssh.rs` |
| 本地 PTY 终端 | ✅ | `src/Terminal.tsx`、`commands/terminal.rs` |
| SFTP 基础 + 流式 + 递归 + 进度 + 取消 | ✅ | `src/SftpPanel.tsx`、`commands/sftp.rs` |
| 串口会话 | ✅ | `src/serial/SerialConnectModal.tsx`、`src/TerminalPane.tsx`、`commands/serial.rs` |
| Telnet 会话 | ✅ | `src/telnet/TelnetConnectModal.tsx`、`src/TerminalPane.tsx`、`commands/telnet.rs` |
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
| 全应用逐功能比对·第一轮（Vault 首页与分组、主机新建/编辑/连接） | ✅ | `src/VaultView.tsx`、`src/styles.css`；差异清单见 `changelogs.md` 2026-11-04 |
| 全应用逐功能比对·第二轮（终端标签与分屏、工具栏与更多菜单） | ✅ | `src/TopTabs.tsx`、`src/Workspace.tsx`、`src/TerminalPane.tsx`、`src/Terminal.tsx`、`src/styles.css`；差异清单见 `changelogs.md` 2026-11-04 |
| 全应用逐功能比对·第四轮（SFTP） | ✅ | `src/sftp/SftpPaneView.tsx`、`src/sftp/sftpModel.ts`、`src/styles.css`；差异清单见 `changelogs.md` 2026-11-04 |

---

## P0 · 日常可用性（12 / 14）

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
- [x] ✅ **5. Keychain 管理**
  - 密钥对生成、ssh-agent 检测、默认密钥（`~/.ssh`）列出与选用。
  - 后端：`generateKeyPair` / `checkSshAgent` / `getDefaultKeys`（netcatty 侧），termX 需补命令（ssh-agent 检测随 SSH agent 转发已纳入移植，见 P1 #39）。
  - 参考：`components/keychain/`。
  - 阶段 A（2026-11-03）✅：~/.ssh 文件密钥管理——后端六件套 `keychain_list_file_keys` / `keychain_generate_file_key`（ED25519/ECDSA/RSA + passphrase，同名拒绝覆盖、.pub 写失败回滚）/ `keychain_import_file_key` / `keychain_delete_file_key` / `keychain_set_default_key` / `keychain_get_default_key`（默认密钥 settings KV `ssh_default_key`，缺省回落 id_ed25519 并与 ConnectionManager 单一事实来源；私钥不出后端不落日志；is_plain_file_name 防穿越；双注册）；前端 `src/keychain/` KeychainView 挂 Vault「钥匙串」双子标签（系统密钥/已存密钥保留旧 keysPanel）+ keychainModel 纯逻辑 4 测 + sshErrors 5 码映射；门禁 220✓/build✓/cargo check✓/835✓；实机截图对照 Netcatty（设默认系 termX 新增、agent 状态属阶段 B）。
  - 阶段 B（2026-11-03）✅：SSH agent 状态与转发接线收尾——后端 `ssh_agent_status` 双注册（running 以 request_identities 成功为准，修 pageant 懒连接假阳性）；Profile `agent_forwarding`（schema v36 幂等迁移，默认关）；client.rs 在 pty/shell 前发 `auth-agent-req@openssh.com` + Handler `server_channel_open_agent_forward` 安全边界（未开启 reject AdministrativelyProhibited / 本机 agent 不可达 reject ConnectFailed / 可达 accept + copy_bidirectional 泵字节，逐跳独立判定）；前端钥匙串页状态卡 + ConnectionManager 表单与 VaultView 抽屉「转发 Agent」开关（开启且未运行告警）+ sshAgentStatus 纯逻辑 7 测；门禁 227✓/build✓/cargo check✓/836✓；129 实机：开启转发连接成功，但远端 `SOCK=[]` + `/tmp/ssh-*` 空 → sshd 静默未建监听（服务端问题，转人工 `sudo sshd -T`）；本机 ssh-agent 服务需管理员 → 正向身份（ssh-add 含 passphrase）转人工点测；review 两中危已修（pageant 假阳性、抽屉缺开关）；随阶段 A fc5e93e 一起快进推送 7c53f39→新 HEAD。
- [x] ✅ **6. Known Hosts 管理页**
  - 已信任主机指纹列表、删除、编辑；连接弹窗之外的管理入口。
  - 实现：`src/VaultView.tsx` known-hosts 子页（列表/搜索/删除/转换为主机档案；
    哈希条目 `|1|` 仅展示不可删）；后端 `ssh/known_hosts.rs` 解析 + SHA256 指纹，
    `commands/profile.rs` 的 `known_hosts_list` / `known_hosts_remove`（lib.rs 与
    server.rs 双注册）。netcatty 本身也只有删除/转换、无编辑，视为对齐完成。
  - 参考：Vault 子页（`AGENTS.md`）、`electron/capabilities/catalog/vault.cjs`。
- [x] ✅ **7. Snippets（命令片段 + 脚本最小闭环）**
  - 阶段 A：后端 Snippet 字段补齐（id/description/package/tags/shortkey/no_auto_run，serde default 向后兼容）；`src/snippets/` 页面挂 Vault「脚本」导航（列表/搜索/分组/新建/编辑/删除 + 右编辑面板）；终端插入 = 右键菜单「插入片段」+ 逐片段快捷键（仅当前窗格会话）；纯逻辑 15 测试。
  - 阶段 B：字段补 `kind`（snippet|script）与 `multi_line_run_mode`（paste|lineDelay）；`snippetWritePlan` 实现「整段 + 末尾单回车」与「逐行 250ms」；`snippetsTransfer.ts` 对齐 Netcatty 传输格式（version 1~3 导入、导出 3、按 command 判冲突）；Snippets 页加类型筛选/导入/导出/类型与多行方式编辑；终端工具栏「脚本」真实下拉 + 右键拆「插入片段/运行脚本」；逐行定时器随 teardown 清理。
  - 脚本裁定：Netcatty 的 `nct.*` JS 运行时（scriptRun/Stop/Pause/Resume、屏幕等待、录制回放）未移植，最小闭环 = 发送到活动 shell、输出在终端回显；触发器/targets/language 留档 P1 #13。
  - 验证：129 实跑 F5 + 菜单三轮输出 STEP-A/uptime/STEP-B；干净「本地终端 4」无输出（跨会话隔离成立）；导入新增 1 条正常。
  - 待人工：右键菜单插入/运行（自动化合成右键不触发 WebView2 contextmenu）；package 网格/卡片视图未复刻（分组行列表功能等价，已留档）。
  - 后端：`load_snippets` / `save_snippets`（双注册 + 同步覆盖）。
  - 参考：`components/snippets/`、`domain/snippetTransfer.ts`、`domain/snippetScript.ts`。
- [x] ✅ **8. SFTP 内置编辑器 + 文件监视回写**
  - 双击远端文件在编辑器打开、保存即回写；本地改动监视后自动同步远端。
  - 阶段 A（编辑器，2026-11-03）✅：远端 `sftp_read_file`（10 MiB 预检，对齐 Netcatty MAX_BUILTIN_SFTP_EDITOR_BYTES，stat+读后双检）/ `sftp_write_file` 双注册；`src/editor/`（editorFile.ts 纯逻辑：二进制扩展名 + NUL 采样、BOM/UTF-8/gb18030 解码、尺寸断言；EditorDialog 低依赖 textarea 视图：保存/Ctrl+S/另存为/未保存三按钮确认）；SftpPaneView 右键「编辑」+ 双击文件打开（本地/远端双向）；`sftp_file_too_large` 文案带 size/limit；16 前端单测 + 3 Rust 单测。
  - 阶段 B（2026-11-03）✅：文件监视回写（本地轮询/远端 stat 比对、保存回环抑制、外部修改「重新加载/忽略」对话框）+ 外部编辑器打开（`local_open_path` / `sftp_open_external` 下载临时目录，双注册，记录临时路径并提示）+ 129 live 全绿（读→写→再读一致/超限拒绝/二进制拒绝；揪出并修复 upload 不截断高危）+ 自审无遗留高/中危；门禁 183✓/build✓/cargo check✓/813✓/live✓，已推送。
  - 参考：`components/editor/`、`startFileWatch` / `onFileWatchSynced`（`netcatty-bridge-files.d.ts`）。
- [x] ✅ **9. SFTP 双栏 + 拖放**（2026-11-03 阶段 A+B 完成）
  - 本地/远端双栏并排，拖拽上传下载。拖到系统桌面明确不做：WebView2 网页内容无法发起 CF_HDROP OS 拖放、Tauri v2 无 Electron startDrag 等价 API、原生 OLE 实现须与手势同帧耦合不可靠，记后续原生桥候选（详见 changelogs 阶段 B 节）。
  - 阶段 A（工具栏 / 面包屑 / 排序 / 隐藏，2026-11-03）✅：两行工具栏（面包屑行：回主目录 / 回根 / 可点路径段，超 4 段截断出省略号菜单；动作行：复制路径 / 新建文件夹 / 显示隐藏文件 / 刷新）+ 列头排序（名称 / 大小 / 修改时间，目录恒置顶）+ 隐藏文件开关（本地 hidden 属性 / 远端点前缀约定）+ 双击 / 回车进入目录（单击仅选中）；sftpModel 纯逻辑（面包屑分段 / 根判定 / 截断 / 排序比较器 / 隐藏过滤 / 大小时间格式化）+ 19 单测；纯前端无新后端命令。
  - 阶段 B（跨栏拖放 + 入队联动，2026-11-03）✅：文件行可拖（目录不可拖，队列仅单文件），拖到对面栏松手即入队（远端→本地=下载 / 本地→远端=上传，走既有 sftp_transfer_enqueue，冲突策略沿用阶段 C）；落点语义对齐 Netcatty（目录行=进该目录，文件行/空白/".."=当前路径）；同侧拖拽 dragover 即拒（no-drop=取消）；容器/落点高亮；载荷全校验（拒穿越名/坏 JSON/缺会话）；+7 单测（209✓）+ 129 live 等价验证 27✓ + 自审无高/中危；随阶段 A 推送。
  - 参考：`components/sftp/`、`startLocalFileDrag`。
- [x] ✅ **10. 传输队列持久化**（2026-11-03 三阶段全部完成）
  - 队列落盘、重启续传；暂停 / 恢复 / 优先级 / 全局并发上限。
  - 阶段 A（后端，2026-11-03）✅：队列中心 `sftp/transfer_center.rs` + 持久化 `db/sftp_transfer.rs`（schema v35 `sftp_transfer_queue`，重启恢复 Running→Queued）；冲突检测后端（启动前 stat 目标，`resolve_conflict` replace/skip/rename + 应用到全部，批次作用域）；事件契约（新增 `sftp:transfer_updated:<id>` / `sftp:queue_changed`，进度复用 `sftp:progress:<id>`）；9 命令 lib.rs + server.rs 双注册；11 单测（cargo test --lib 805✓）。
  - 阶段 B（前端，2026-11-03）✅：全局队列面板 `src/sftp/SftpQueuePanel.tsx`（列表：文件名/方向/大小/进度/状态图标；暂停/恢复/取消；并发数 1-8 设置；清空已结束）挂于双栏下方；上传/下载统一入队（`sftp_transfer_enqueue`），SftpPaneView 旧传输条移除、上传完成自动刷新；纯逻辑 `src/domain/transferQueue.ts`（排序/计数/按钮规则/格式化）+ 14 单测；事件全走 client.ts 封装（`sftp:transfer_updated:*` / `sftp:queue_changed` / `sftp:progress:*`）；`sftp_transfer_not_found` / `sftp_transfer_state_invalid` 中文映射补齐（R5）。
  - 阶段 C（冲突对话框，2026-11-03）✅：`src/sftp/SftpConflictDialog.tsx`（标题「{文件名} 已存在」/方向化说明覆盖本地远端双向/按钮序 跳过|创建副本|替换 危险样式/Esc 与遮罩=跳过/「应用到剩余的 N 个冲突」按批次）+ `resolve_conflict` 同批已冲突项回溯套用（锁内复检防竞态）+ `pickActiveConflict` 纯逻辑（+3 单测）；129 live 五场景全绿（无同名直过证 remote_exists 文案判定/skip/rename 副本名/replace/apply-to-all 批量回溯）；自审无高/中危（低危 2 记录）；门禁 163✓/build✓/cargo check✓/806✓/live✓；随推 e0e83c1+1cf1bcc+e9b2917+本轮。
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
- [x] ✅ **33. 会话日志 / 录制 UI**
  - 终端工具栏可开始/停止录制、查看与导出会话日志；点亮当前禁用的「会话日志 / 开始录制」入口。
  - 依据：netcatty `startManualSessionLog` / `exportSessionLogs`（`netcatty-bridge-session.d.ts` L315-L328）；termX 后端 `session/recorder.rs` 已就绪、前端未接线。
  - 完成（2026-11-03）：阶段 A = Vault「日志」页 + `session_logs` 索引表（schema v38）+ 列表/详情/导出/删除四命令双注册；阶段 B = 会话级录制槽（自动/手动共用，工具栏按钮与 More「开始/停止录制」+ REC 徽标）、ANSI 彩色/原文切换（自研解析，无 innerHTML）、导出 cast/txt/html 落盘（Tauri dialog，txt 保留 ANSI）。129 实机：录制→停止→列表→详情→导出全链路通过；回放（时间轴重放）明确留档不做。

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
  - 进度（2026-11-04 全应用比对第一轮）：Vault 表单已补「启动命令」textarea（`init_command` 后端连接后写入生效）；仍缺 Netcatty 的 SFTP 文件协议/Sudo/文件名编码（`sftp_*` 字段当前无后端消费，禁止先做假控件）、图标（`icon_source/icon_color` 无消费方）、启动命令 runMode（`lineDelay`/`paste`，后端无对应语义）、环境变量/算法/keepalive/超时/设备类型/外观覆盖；备注（Netcatty 为主机关联笔记）与自动化连接脚本队列另属 #37 / 新能力。
- [x] ✅ **35. 串口 1:1 重做**
  - ✅ 阶段 A（2026-11-03）：`serialFormConfig.ts` 对照表 + `serialInput.ts` 输入语义 + `SerialPanel` 常量表驱动重构；本地 commit `7a29ed3`。
  - ✅ 阶段 B（2026-11-03）：间距/标签/主按钮视觉复检并修正；补卸载时串口句柄释放与 `serial_not_found` 文案；本机 COM1 真实打开 + 行模式/本地回显/退格手测通过；门禁 294✓/build✓/cargo check(server)✓/836✓；commit `be07732` 已 push（远端 main=`be07732`）。
  - 留档（待人工）：ymodem（后端未实现且无设备验证，未加假按钮）；命名管道（crate 不支持，明确报错）；保存配置为主机（无 host 模型）。
- [ ] ⬜ **36. SFTP 细节交互**
  - 面包屑导航、覆盖冲突对话框、同主机复制（与 #24 归档解压联动）。
  - 依据：netcatty `components/sftp/SftpBreadcrumb.tsx` / `SftpConflictDialog.tsx`；termX `SftpPanel.tsx` 为单栏、无面包屑、无冲突提示。
  - 冲突检测后端与冲突对话框前端已随 #10 阶段 A/C 完成（2026-11-03）；面包屑已随 #9 阶段 A 完成（2026-11-03，双栏 SftpPaneView）；同主机复制仍缺。
- [ ] ⬜ **37. Vault 其余子页**
  - 笔记、会话日志页、代理配置入口（当前导航为禁用占位）。
  - 进度（2026-11-03）：笔记阶段 A ✅（列表/编辑/搜索/标签/置顶/删除，DB 持久化）；阶段 B ✅（Markdown 预览 + 最小格式工具栏、ssh 主机链接关联与跳转、分组路径与过滤、Markdown 导入导出；分享未做，Netcatty 亦无独立分享入口）。日志阶段 A/B ✅（列表/筛选/ANSI 详情/删除 + schema v38 索引 + 会话级录制开关 + 三格式导出落盘）；代理入口仍 ⬜。
  - 依据：netcatty `components/notes/`、会话日志与代理配置入口；termX `VaultView.tsx` navItems 中 monitor/proxies/port 仍禁用，keys/snippets/notes/logs 已启用。
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
  - 进度（2026-11-04）：OSC 7 目录追踪部分完成——「更多 → 配置目录追踪」可一键写入 bash/zsh/fish 幂等 hook，回传 cwd 显示在菜单标题；**未接** SFTP 跟随目录与状态栏显示（剩余部分待 #31 后续）。
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
| 2026-11-03 | SFTP 传输队列与冲突对话框·阶段 A（后端队列中心）完成：新增 `sftp/transfer_center.rs` + `db/sftp_transfer.rs`（TransferItem 状态机、并发上限 `sftp_transfer_concurrency`、暂停/恢复、优先级重排、取消、冲突检测与 `resolve_conflict` 批次作用域、自动重命名、重启恢复）；事件 `sftp:transfer_updated:<id>` / `sftp:queue_changed`；schema v35 `sftp_transfer_queue`；9 命令 lib.rs + server.rs 双注册；+11 单测（805✓）；门禁 cargo check×2 + build ✓；P0 #10 标 🟨（阶段 B 前端队列面板 / 阶段 C 冲突对话框+129 live 待办），#36 补冲突后端进展注记；本地 commit 未推送。 |
| 2026-11-03 | SFTP 传输队列与冲突对话框·阶段 B（前端队列面板）+ 阶段 C（冲突对话框）完成，P0 #10 收官（8 / 39）：阶段 B 全局队列面板 + 传输条整合（160✓）；阶段 C `SftpConflictDialog`（跳过/创建副本/替换 + 应用到全部，按钮序与危险样式对齐 Netcatty）+ `resolve_conflict` 同批回溯 + `pickActiveConflict`（+3 单测）；129 live 五场景全绿（含 remote_exists 文案判定实证与 apply-to-all 批量回溯）；自审无高/中危（低危 2 记录）；门禁 163✓/build✓/cargo check✓/806✓/live✓；随推 e0e83c1+1cf1bcc+e9b2917+阶段 C；下一起点=编辑器与监视回写（#8）。 |
| 2026-11-03 | 编辑器与监视回写（P0 #8）阶段 B 收官（9 / 39）：文件监视回写（基准 stat 快照 + 本地 1.5s 轮询/远端 3s stat + writingRef 回环抑制 + 「重新加载/忽略」对话框，定时器随状态重建/卸载清理）+ 外部编辑器打开（`local_open_path` / `sftp_open_external` 下载临时目录并系统打开，100 MiB 上限，双注册，前端记录临时路径并提示手动回传）+ 129 live `live_sftp_editor_read_write_guards` 全绿（读→写→再读一致含收缩截断、超限拒绝、二进制拒绝）；**live 揪出并修复高危**：`SftpHandle::upload` 原用 russh-sftp `write`（仅 OpenFlags::WRITE）收缩内容残留旧尾部 → 改 `create`(CREATE\|TRUNCATE\|WRITE)+write_all；自审无遗留高/中危；门禁 183✓/build✓/cargo check(server)✓/813✓/live✓；随推 d4b0886+阶段 B；下一起点=SFTP 拖放与面包屑/工具条（#9）。 |
| 2026-11-03 | **代理 / 端口转发暂停（用户指令）**：立即停止两项移植，端口转发从未开始。代理阶段 A 后端已完成并本地 WIP 提交 `d633866`（HTTP CONNECT/SOCKS5 握手 + 认证 + IPv6 + no_proxy + schema v39 + SecretStore 密码 + 终端/堡垒/转发/headless/CLI 接线 + 2 命令双注册 + 系统代理兜底）；半成品=主机表单/连接弹窗未接线、系统代理文案未改、129 实连与 Netcatty 截图比对未做、SFTP 独立连接尚未接代理。门禁全绿（349✓/build✓/cargo check✓/863✓），debug 实例已停；远端 main 仍 b1db6cb，未推送；恢复只需补前端表单或 revert 该提交。 |
| 2026-11-03 | 终端工具栏对照表 + 录制拆分（本轮）：`开始会话日志`（工具栏 file-text，后端 `TextLogRecorder` 写 txt/raw/html 文件）与 `开始录制`（More actions，前端命令序列→片段库，全局单会话互斥）彻底拆为两套独立状态/产物/入口，删除共享录制槽语义；被圈按钮（历史/高亮/SFTP/撰写/搜索/会话日志）全部接通；默认日志改为 txt + `YYYY-MM-DDTHH-mm-ss.txt` + 主目录；真机 129 验证「单独日志」「单独录制」「两者同时」三条路径均产出正确产物（日志 178B/337B、片段 `录制 23:50:15`）；门禁 358✓/build✓/cargo check✓/869✓；截图 `shots/round2-*`；下一起点=More 菜单逐项实现（做不出者置灰+悬停说明）+ 像素级统一 + review/push。 |
| 2026-11-03 | **后续大任务登记（本轮不执行，工具栏任务推送完成后启动）**：全应用级逐功能比对——termX debug 与 Netcatty 同场景并排，每轮 2~3 模块（≤40 工具），覆盖 Vault 首页与分组 / 主机新建编辑连接 / 终端（标签/分屏/工具栏/右键/更多菜单）/ SFTP / 串口 / Telnet / 本地终端 / 设置中心 / 钥匙串 / 脚本片段 / 笔记 / 日志 / 已知主机；每项分「功能点 + UI 点」两列，差异三级（逻辑必改/交互必改/视觉按像素标准），每轮门禁 + changelogs + todo + review + push；全部完成后再恢复代理与端口转发。工具栏任务推送完成后先汇报「工具栏任务完成」再自行进入第一轮，无需用户确认。 |
| 2026-11-04 | 「更多」菜单逐项实现 + 像素级统一收官：5 项全部可点（命令历史 / 配置目录追踪 / 终端设置 / 开始-停止录制 / 终端编码），不支持传输改为置灰 + 行内原因（不删项）；新增 `src/terminal/osc7.ts`（bash/zsh/fish 幂等 hook + 对话框 + cwd 回传）与 `src/terminal/terminalEncoding.ts` + `src-tauri/src/terminal/encoding.rs`（GB18030 输入后端转码 / 输出前端流式解码 / 按主机持久化）；`onOpenSettings` 链路打通设置中心；工具栏与菜单按 Netcatty 量值统一（24×24/6px/2px/12px/hover 透明；菜单 192px/28px 行/4px 圆角/shadow-md/4px 偏移/150ms）；129 CDP 逐项实机验证；门禁 373✓/build✓/cargo check(server)✓/874✓。缺口：OSC 7 未 percent-encode、cwd 未接 SFTP 跟随、日志按钮下拉未做、GB18030 日志转码未做。 |
| 2026-11-04 | **后续任务登记（下一轮执行，本轮未动）**：移植「设置 → 外观」「设置 → 终端」两个 tab，一比一复刻，**先重新对照 Netcatty 实现，不沿用旧结论**。外观：主题预设库全量（含调色值）、窗口透明度真实实现（Windows acrylic/原生 API 而非 CSS 近似）、背景模糊、UI 字体（搜索型 combo + 回退链）、强调色完整色板与自定义取色、图标变体真正生效、主机库 6 个开关逐项生效、自定义 CSS 注入 + 即时预览、语言切换生效范围。终端：字体区 9 项、光标区 4 项、行为区 13 项、侧边栏 2 组、主机密钥校验策略、终端主题跟随开关——每项必须落到 xterm 实例或对应行为，改后立即生效且重启保留，不能只写 localStorage。判定=UI 一致 + 逻辑一模一样（默认值/范围/边界/禁用/文案/生效时机/持久化），改一项截图验证、必要时重启确认，Netcatty 并排对照。每轮 1~2 个 tab，门禁→changelogs→todo→review→push。两项全部完成后才进入全应用逐功能比对第一轮，之后才恢复代理与端口转发。 |
| 2026-11-04 | 设置中心「外观」tab 1:1 复刻完成：主题预设全量移植（浅 62 / 深 62，19 令牌逐项落 :root）、主题色板 UI、强调色 18 色板 + 自定义取色 + WCAG 前景、搜索型字体 combo（22 预设 + 本机字体 + CJK/emoji 回退）、窗口透明度改 Windows 原生分层 alpha、背景模糊按 Netcatty isMac 条件（Windows 不渲染）+ mac 原生路径、12 个图标变体缩略图 + 原生 set_icon、主机库 6 开关全部接通、自定义 CSS 即时注入、外观 tab en 全量。真机：CDP 逐项 + Win32 读回 alpha、重启持久化；门禁 377✓/build✓/cargo check✓/874✓。缺口：Netcatty 实例不可用（像素并排复核待下轮）、mac 透明度、全应用 i18n。 |
| 2026-11-04 | 外观 tab review 修复完成：原生 IPC 去重 + 串行（相同值跳过/连续变更只发最终态）、persist 200ms 去抖、系统主题监听补 emit、FontCombo 外部点击与 Esc 关闭、appIconVariant 白名单（非法回落 original）、autoImport known_hosts 按实际能力置灰 + 行内原因、清理死代码与死键；复跑门禁 378✓/build✓/cargo check✓/874✓。 |
| 2026-11-04 | 设置中心「终端」tab 1:1 复刻完成：主题跟随（含系统明暗监听）、字体 9 项、光标 4 项、键盘 3 项（置灰 + 行内原因）、行为 30 行全量（右键/中键/选词/长按/全屏菜单、选择即复制与规范化、括号粘贴、多行确认、Shift+Enter 自定义序列、标签双击、OSC 52 四态、滚动五项、断开提示模式、回滚 0–100000）、侧边栏 2 组（SFTP 已接通、其余置灰）、verifyHostKeys 下发后端；默认值逐键对齐 Netcatty，旧值迁移（右键 menu/none、中键 copy/none、disconnectPrompt）；全部落地 xterm options / CSS / 事件路径并即时生效 + 重启保留。真机 CDP：字号 15、字重 300、竖线光标、行高亮 decoration、行距 36.8、右键菜单；门禁 379✓/build✓/cargo check(server)✓/874✓。缺口：Netcatty 实例不可用（像素并排待复核）、侧栏仅 SFTP、本地 PTY TERM 固定、12 项保留置灰。 |
| 2026-11-04 | **后续任务登记（下一轮执行，本轮未动）**：进入「全应用逐功能比对第一轮」——termX debug 与 Netcatty 同场景并排，每轮 2~3 模块（≤40 工具），覆盖 Vault 首页与分组 / 主机新建编辑连接 / 终端（标签/分屏/工具栏/右键/更多菜单）/ SFTP / 串口 / Telnet / 本地终端 / 设置中心 / 钥匙串 / 脚本片段 / 笔记 / 日志 / 已知主机；每项分「功能点 + UI 点」，差异三级（逻辑必改/交互必改/视觉按像素标准），每轮门禁 + changelogs + todo + review + push。全部完成后再恢复代理与端口转发（WIP `d633866` / `60d8deb` 不得触碰）。 |
| 2026-11-04 | 全应用逐功能比对·第二轮完成（终端标签与分屏 + 工具栏与更多菜单）：标签右键菜单补齐 9 项（复制标签页/重命名/重新连接/关闭/分隔线/关闭其他/关闭左侧/关闭右侧/关闭所有）+ 批量项按锚点置灰 + 关闭危险色；中键关闭；HTML5 拖拽排序；重命名模态（Enter/Esc/空值禁用）；`PaneHandle.reconnect` + `Workspace.reconnectTab`（最新 connect 闭包）；`closeLeft`/`closeAll`；分屏右窗格标题保留（`.term-toolbar-left min-width`）；浅色主题终端底部黑条修复（容器底色跟随主题 + `.xterm-viewport` 透明，设置变更实时同步）。工具栏项/顺序/24×24/12px 与 Netcatty 一致。129 CDP 逐项验证；门禁 379✓/build✓/cargo check(server)✓/874✓。缺口：YMODEM 发送/接收、工具栏「打开会话日志」、工具栏自定义布局（show/collapse/hide + 右键定制）未实现，未加假按钮；下一起点=SFTP 模块。 |
| 2026-11-04 | 全应用逐功能比对·第三轮完成（串口 + Telnet + 本地终端）：串口弹窗字段/尺寸/提示与 Netcatty 1:1；本地终端面板四字段与双保存按钮 1:1；Vault「终端」快捷开标签、侧栏打开时入口折叠一致。缺口（无假控件，已登记）：串口/Telnet 主机档案与保存配置（termX 无对应协议档案）、Netcatty 快速连接向导体系。129 CDP 截图 r3-serial/r3-telnet/r3-localshell/r3-menu2。 |
| 2026-11-04 | 全应用逐功能比对·第四轮完成（SFTP）：新增名称过滤（工具栏按钮 + 输入行 + Esc 清除，`filterEntriesByName` + 3 单测）、新建文件（工具栏/空白右键/弹窗，远端 `sftp_write_file`、本地 `local_write_file`）、空白右键补刷新与新建文件、列序改为 名称/修改时间/大小/类型 并支持类型排序、底部状态栏（项数/选中/当前路径）。缺口（无假按钮，已登记）：多选与批量操作、树视图/密度/编码/书签/跟随终端 CWD、所有者列、冲突对话框「停止/合并」完整对齐。门禁 382✓/build✓；debug 重编后 CDP 实测。 |
| 2026-11-04 | 全应用逐功能比对·第五轮完成（设置各 tab）：系统 tab 补齐 Netcatty 缺失 5 节（启动与会话恢复 / SSH 深链 / JMS 深链 / 资源管理器右键菜单 / 全局热键与托盘）与会话日志保存目录+清空、临时目录打开入口，全部按实际能力置灰并在行内写明原因；节顺序对齐 Netcatty。设置「终端」tab 复核通过；file-associations（SFTP）/ ai / sync 保持占位，SFTP 设置留待第二步。缺口登记：快捷键 scheme「禁用」三态（需改 HotkeyScheme 类型与迁移）、外观 notes 字体三行与自定义 CSS 帮助弹窗（随笔记模块）。门禁 382✓/build✓/cargo check(server)✓/874✓；debug 重编 + CDP 实测节顺序。 |
| 2026-11-04 | 全应用逐功能比对·第六轮完成（钥匙串）：头部搜索（名称/指纹/类型/路径，无结果提示）、列表/网格视图切换、条目计数、点击条目打开详情面板（类型/指纹/路径/公钥全文 + 复制公钥/设默认/删除）、删除确认由 `window.confirm` 改为应用内模态。缺口（后端无模型，未放假控件）：身份（identities）区、证书/FIDO 安全密钥、导出到主机（exportAndAttach）、拖拽排序与编辑面板。门禁 382✓/build✓/cargo check(server)✓/874✓；debug 重编 + CDP 实测搜索/网格/详情。 |
| 2026-11-04 | 全应用逐功能比对·第七轮完成（脚本与片段）：分组级重命名（模态 + 级联子分组 `renameSnippetPackage`）与分组删除（`deleteSnippetPackage`）、快捷键冲突检测 `findShortkeyConflict`（保存时报「已被片段 X 占用」）；新增 6 条单测。缺口登记：导入预览模态、目标主机/分组 targets（需后端字段）、执行历史与运行日志、终端内快速添加、录制保存为脚本。门禁 388✓/build✓/cargo check(server)✓/874✓；debug 重编 + CDP 实测分组操作与重命名模态。 |
| 2026-11-04 | 全应用逐功能比对·第八轮完成（笔记）：新增大纲侧栏（`extractNoteOutline` 解析 1–6 级标题、跳过围栏代码块、层级缩进、点击跳转编辑器对应行、可折叠「大纲」按钮），新增 3 条解析单测。缺口登记：MDXEditor 富文本/语法高亮、工具栏全量（链接/图片/表格/数学）、导出 HTML/PDF、图片粘贴布局/代码 tooltip/数学渲染、主机级笔记。门禁 391✓/build✓/cargo check(server)✓/874✓；debug 重编 + CDP 实测大纲生成与跳转。 |
