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
| P0 日常可用性 | 13 / 14 | 不补齐难以日常使用 |
| P1 差异化能力 | 14 / 19 | 拉开与普通 SSH 客户端差距（含 1 项 ⏸ 不移植；#39 为范围修正新增） |
| P2 大工程 | 0 / 6 | 需单独立项（含 5 项 ⏸ 暂缓移植：4 项见 plan.md，#38 依赖 #27） |
| **合计** | **28 / 39** | 2026-11-05：P2 #31 子项「本地压缩包快捷解压」完成（`build_local_extract_plan` + `local_extract_archive` 双注册，本地归档行右键「解压到当前目录」；debug+CDP 实测 tar.gz→txt 内容一致；顺带修复行右键被空白菜单覆盖并补组件回归测试；门禁 473✓/build✓/cargo check✓）。2026-11-05：P2 #38 会话快照迁移核定为 ⏸（Netcatty 快照 API 仅服务 AI 观察弹窗的活动会话接管，依赖 #27 + Electron webContents 归属与输出暂停/排空；termX 的 Tauri `emit` 广播无对应原语，重启后会话进程已消失，不在本项目范围）。2026-11-05：P1 #39 SSH Agent 转发收尾（exec 通道补 `auth-agent-req`，129 实测开/关 SSH_AUTH_SOCK 有/无；桥接端到端因本机无 agent 服务置灰）；#37 Vault 子页核对关闭。2026-11-05：P1 #26 部分完成（`rssh-cli` 新增 `snippet` CRUD + `sftp ls/get/put`，129 实测 put/get 校验一致；会话级操作因桌面端无 RPC 桥置灰）。2026-11-05：#24 尾巴（解压菜单按连接类型隐藏，独立 SFTP 不再显示）；P1 #25 文件名编码置灰（`russh-sftp` 协议层 `Into<String>` + lossy 解码，GBK 原始字节不可恢复，升级 3.0.1 无解，需 fork 协议层）。2026-11-05：P1 #24 SFTP 归档解压完成（`sftp/archive.rs` 格式识别与远程命令构造 + `sftp_extract_archive` 双注册；文件右键「解压到当前目录」；129 实测上传 tar.gz→解压 exit 0→读回内容一致，负例 `sftp_extract_unsupported`；独立 SFTP 无 exec 通道返回 `sftp_extract_no_ssh` 并写明原因；门禁 461✓/build✓/check(server)✓/archive 5✓）。历史：2026-11-05：P1 #23 应用锁完成（口径：Netcatty 应用锁=用户自设锁定口令 PBKDF2-SHA256 校验器 + 可选系统凭据解锁；termX 落地口令档位：Rust `app_lock` 模块 6 命令、DB settings 存 `app_lock_verifier`（120k 迭代/16B salt/32B hash，明文不落盘）+ enabled/timeout；前端启动锁 + 失焦切回按超时锁 + 设置中心「应用锁定」含设置/更换/关闭/超时/立即锁定；系统凭据（Touch ID/Windows Hello）无原生 helper，置灰写原因。实测：重启进程锁住、错误口令被拒（`锁定密码不正确。`）、正确口令进入、切回验证；DB 取证主库+WAL 均无明文探针 `PLAINTEXT_PROBE_9f3a`/锁定口令、含 `enc:v1:` 密文前缀，证据 `evidence/applock-*.json` + 4 张截图；门禁 458✓/build✓/check(server)✓/897✓（1 项 plugin 测试首跑偶发、单跑通过）。历史：2026-11-05：P1 #22 深链/单实例/多窗口完成：新增 `tauri-plugin-single-instance`（`deep-link` feature，首注册）+ `tauri-plugin-deep-link`，`tauri.conf.json` 声明 `ssh/telnet/termx` schemes，`capabilities` 加 `deep-link:default`；前端 `getCurrentDeepLinks`/`onDeepLink`/`openTabInNewWindow`，深链按 host/port 匹配 SSH 主机并新建会话，多窗口右键「在新窗口中打开」+ 新窗口读 `__rssh_clone` 恢复标签；托盘置灰（缺 `tray-icon` feature/图标/菜单/关闭到托盘语义，且无法自动化实测）。命令行第二实例带 `ssh://` 实测唤起首实例并建会话。历史：2026-11-05：P1 #21 自动更新（检查链路真做：新增 `check_update` 读取 Tauri updater 兼容 `latest.json`、按平台取产物并比较版本；设置「软件更新」可检查并显示新版本/说明；下载安装置灰并写明缺签名公钥、endpoint、CI 产物。本地 HTTP 源实测 0.0.1→v0.0.2，证据 `evidence/update-check.json` + 两张截图；门禁 451✓/build✓/890✓）。历史：2026-11-05：P1 #20 Telnet 自动登录完成（复用 `serial_auto_login` 状态机，`telnet_open` 增凭据双注册，mock 服务端实测 complete/cancelled，证据 `evidence/telnet-auto-login.json`；门禁 451✓/build✓/887✓）。历史：2026-11-05：P1 #17 内嵌图片完成（`@xterm/addon-image` + Kitty/SIXEL/iTerm IIP 三类协议设置与渲染，xterm 升 6.1.0-beta.336；129 实测三段真实序列均生成 image canvas 并绘制像素，证据 `evidence/inline-images-129.json` + 三张截图；门禁 447✓/build✓）。历史：2026-11-04：P1 #13 脚本系统收官（阶段 B：渲染层 onConnect / onOutput 自动触发 + `#@wait-prompt`/`wait-text`/`wait-regex` 屏幕等待 + 目标主机与同会话去重 + 触发日志；录制回放 / `nct.dialog` / `nct.progress` 不可移植置灰写原因；129 实测连接触发与输出触发均真实写文件、重复输出与负例主机不触发；门禁 441✓/build✓/cargo test --lib✓）。历史：2026-11-04：P1 #13 阶段 A（脚本数据模型 `language`/`trigger`/`trigger_pattern` + 脚本页活动终端运行链：运行/停止/暂停/恢复；自动触发与 nct.* JS 运行时置灰写原因；129 实测脚本真实执行 + T/S+/MISSING 状态验证）。历史：2026-11-04：P1 #34 补字符集字段（主机编辑面板 UTF-8/GB18030，与终端编码共用按主机偏好；129 实测写入/回读）。历史：2026-11-04：P1 #16 端口转发高级能力完成 —— 规则级自定义监听地址（`bind_address`，空=默认 loopback/sshd 默认）+ 条目级自动启动/断线重连（schema v42；渲染层监督器，有限 5 次重试；手动停止不回拉）；托盘开关不移植（未启用 Tauri tray-icon 基础设施），置灰写明原因；129 实测 `0.0.0.0:18099` 监听 + SSH banner 真实流量 + reload 自动启动 + 直接 stop 后自动重连。历史：2026-11-04：P1 #34 主机表单高级字段完成 —— 主机级环境变量（`profile_env_vars` schema v41 + 双注册 + SSH SetEnv + sync 顶层 payload + Vault 编辑器），其余高级字段置灰写原因；129 实测 `LC_ALL=C` SetEnv 生效（exec 通道对照为空）、`init_command` 生效；门禁 425✓/build✓/cargo check(server)✓/884✓。历史：2026-11-04：P1 #15 云同步全部收官（阶段 A 配置/推拉 + 阶段 B 冲突提示/本地快照；本机 WebDAV 真实推送 19860B、拉取还原改名主机、冲突弹窗截图）。历史：2026-11-04：P1 #15 云同步阶段 A（Vault「同步」页 + GitHub/WebDAV 配置与推拉 + 自动拉取；冲突提示/快照/其他 provider 待补）。历史：2026-11-04：P1 #14 主机监控收官（`monitor_sample` 双注册 + CPU/内存/磁盘/网络采样与曲线 + 129 真机 0.8% CPU / 35.5% 内存；延迟/GPU/磁盘 I/O/进程置灰写原因）。历史：2026-11-04：P1 #36 SFTP 同主机复制收官（`sftp_copy` 双注册 + 右键「复制到…」复用冲突对话框 + 129 实测 36B 内容一致）。历史：2026-11-04：全应用逐功能比对第六轮（P0 #11 终端搜索 / URL 识别 / 滚动缓冲）完成 —— SearchAddon 实时高亮 + `n / m` 计数、Cmd/Ctrl+F 搜索条、WebLinksAddon 链接识别（按「链接修饰键」设置激活）+ `open_external_url` 打开系统浏览器；本地 PTY 实测 2/2 高亮；门禁 411✓/build✓；无 Rust 改动。历史：2026-11-03：会话日志阶段 B 完成（终端工具栏/More 手动开始-停止录制 + REC 状态、三格式导出落盘、ANSI 彩色渲染；129 实机录制→列表→详情→导出实测，导出保留 ANSI；同名同秒文件加序号防覆盖；回放明确留档不做）。#33 收官，#37 仅剩代理入口。历史：2026-11-03：会话日志阶段 A 完成（Vault「日志」页 + `session_logs` 索引 schema v38 + 列表/详情/导出/删除四命令双注册 + 11 前端/11 后端单测；尚未完成录制开关与导出落盘，故 #33 仍 ⬜，#37 仅日志页部分 ✅）。历史：2026-11-03：笔记阶段 B 完成（Markdown 预览/格式工具栏/分组/导入导出/ssh 链接跳转，129 实测），笔记子项收官、#37 仍差日志与代理入口；review 中危 2 修复；门禁 325✓/build✓/cargo check(server)✓/842✓；导出落盘与富文本待人工。历史：2026-11-03：Telnet 连接入口修复（同串口病根）：移除 `ensureTab()`，Vault 新增「Telnet」入口 → 单步模态 → 确认后建 `Connector.kind=telnet` 标签；`TerminalPane` 承担订阅/打开/输入/resize/关闭与本地回显，删除 `TelnetPanel`/`TermBridge`；Netcatty 取证为 host 协议 + 模态向导，独立入口与凭据字段差异已记录；门禁 306✓/build✓/cargo check(server)✓/836✓；证据 7 张（含 bug 前后对照）；待人工：真实 Telnet 设备、自动登录（P1 #20）。历史：2026-11-03：脚本与 Snippets 阶段 B（P0 #5）完成：脚本最小闭环（kind=script 发送到活动 shell）+ multiLineRunMode（paste/lineDelay 250ms）+ Netcatty snippet 导入导出（version 3）+ 129 实跑隔离验证；门禁 263✓/build✓/cargo check(server)✓/836✓；无高/中危；历史：2026-11-03：脚本与 Snippets 阶段 A 完成：后端字段补齐 + src/snippets 页面挂 Vault 导航 + 终端右键/快捷键插入（仅当前会话）+ 15 纯逻辑测试；门禁 242✓/build✓/cargo check(server)✓/836✓；CU 截图确认页面与 F2 插入执行；右键菜单插入待人工点测；本地 commit 未推送，阶段 B（脚本链路/导入导出/129/review+push）下轮。历史：2026-11-03：SFTP 拖放与面包屑/工具条（#9）全部完成：阶段 A 工具栏+面包屑+排序+隐藏开关（ca0afe0）；阶段 B 跨栏拖放入队（文件行拖对面栏=上传/下载入队，落点语义对齐 Netcatty：目录行=进该目录/空白=当前目录；同侧拖拽拒绝）+ 拖出到桌面明确不做（WebView2 无 CF_HDROP 桥，记后续原生桥候选）+ 129 live 等价验证 27✓ + 自审无高/中危；门禁 209✓/build✓/cargo check(server)✓/813✓，随阶段 A 推送；下一起点=串口。历史：2026-11-03：（#9）阶段 A 完成：两行工具栏+面包屑+列头排序+隐藏开关+双击/回车进入目录，sftpModel 纯逻辑+19 单测（202✓/813✓）。历史：2026-11-03：编辑器与监视回写（#8）阶段 B 收官、#8 全部完成：文件监视回写（本地轮询/远端 stat 比对 + 保存回环抑制 + 外部修改重载对话框）+ 外部编辑器打开（local_open_path / sftp_open_external，双注册）+ 129 live 全绿（揪出并修复 upload 不截断高危）+ 自审无遗留高/中危；门禁 183✓/build✓/cargo check✓/813✓/live✓，随推 d4b0886（阶段 A）+ 阶段 B；下一起点=SFTP 拖放与面包屑/工具条（#9）。历史：2026-11-03：编辑器与监视回写（#8）阶段 A 完成：远端读写命令（10 MiB 预检）+ src/editor 低依赖编辑器（保存/另存/未保存确认）+ 双注册 + 19 新单测（179✓/809✓），本地 commit 未推送；阶段 B 文件监视回写/外部编辑器/129 live/review+push 待办。2026-11-03：SFTP 实现③（状态保活 + OS 图标 + 低危收尾）：SftpView 改首次激活后常驻挂载 + `.nc-sftp-mount.hidden` 隐藏（对齐 Netcatty SftpViewMount sticky 保活，切 surface 不丢 pane tab/双栏状态）；新增 HostOs 判定（本地 userAgent / 复用会话 uname -s best-effort）与 os-* 原创图标（Netcatty GPL 资产与 host.os 字段判定不可复用，通用映射并说明）；低危 4 项闭环（FileStat.is_symlink、localRemove 守卫恒传、12 封装测试覆盖、孤儿 CSS）；门禁全绿（136✓/build✓/cargo check×2✓/test --lib 793✓），本地 commit 未推送；实现③实机比对受 CU 坐标 artifact 阻塞延后（构建/启动/空态渲染已确认，未见代码缺陷）；review+push 完成（无高/中危，门禁全绿，远端 main=3d9c143）；SFTP 文件操作（上传/下载/删除/重命名/chmod）实现完成：server.rs 补 sftp_chmod 双注册、SftpPaneView 右键菜单/对话框/传输条接线、129 真实连接 live 测试全链路绿；review+push 完成（中危 1 修复= sftp 错误码 i18n 映射，低危 5 记录，门禁 140✓/794✓，远端 main=87e197e）；下一起点=传输队列与冲突对话框（Netcatty 队列面板：暂停/恢复/优先级/并发 + 冲突提示），视觉比对留人工/新 CU；传输队列阶段 A（后端队列中心）完成：队列中心+冲突检测后端+事件契约+schema v35+9 命令双注册+11 单测（805✓），本地 commit 未推送，阶段 B 前端队列面板 / 阶段 C 冲突对话框+129 live 待办；阶段 B 完成（e9b2917）；阶段 C（冲突对话框 + apply-to-all 回溯 + 129 live 五场景全绿 + 自审无高/中危）完成，P0 #10 三阶段全部完成；门禁 163✓/build✓/cargo check✓/806✓/live✓，随推 e0e83c1+1cf1bcc+e9b2917+阶段 C；下一起点=编辑器与监视回写（#8） |
| 串口 1:1 重做（#35） | ✅ 完成 | 2026-11-03：常量表 + 输入语义 + 配置驱动 UI；阶段 B 视觉复检、COM1 实测、句柄释放/文案修复、review + push 完成。 |
| 串口热修（入口 + 弹窗形态） | ✅ 完成 | 2026-11-03 用户实测反馈：点「串口」误开本地终端（`ensureTab()` 新建 pty 标签）→ 改为弹窗先行，确认后建 `Connector.kind=serial` 标签；删除右侧 SerialPanel，重做 Netcatty 形态弹窗（标题/字段顺序/默认值/高级折叠/取消连接/自动聚焦）。证据：evidence/serial-after-click.png、serial-fixed-modal-final.png、serial-ui-compare.png。待人工：保存配置（无 host 模型，不复刻）、真实收发回环。笔记阶段暂缓。 |
| 笔记阶段 A（P0 #37 之一） | ✅ 完成 | 2026-11-03：DB `notes` 表（schema v37）+ `list/get/save/delete_note` 双注册；前端 `src/notes/`（列表 + 编辑 + 搜索 + 标签 + 置顶/删除 + 600ms 防抖保存 + Ctrl/Cmd+S），`VaultView` 启用「笔记」导航；8 例前端单测 + 6 例后端单测；Netcatty 对照截图（富文本差异留阶段 B）。证据：notes-termx/edited/tags/persisted/netcatty-notes。待人工：Markdown 预览、关联主机、分组、导入导出、大列表性能。 |
| 笔记阶段 B（P0 #37 之二） | ✅ 完成 | 2026-11-03：Markdown 原文/预览切换（自研低依赖解析，无 innerHTML）+ 8 按钮格式工具栏（H1/H2/B/I/列表×2/引用/代码，可切换）+ 分组路径与分组过滤 + 单条/全部导出（`<分组>/<标题>.md`）+ Markdown 导入（frontmatter/H1/文件名取标题）+ `[名称](ssh://user@host:port)` 主机链接插入与点击开会话（129 实测直连）。新增 `@tauri-apps/plugin-dialog`（capabilities 已有 dialog:default），读写复用 localfs。review 中危 2 已修（ref 先行防旧内容、导出取当前稿）。证据 notes-b-list/preview/hostlink-open + netcatty-notes。门禁 325✓/build✓/cargo check✓/842✓。待人工：导出落盘全流程、表格/图片/公式、大列表性能。 |
| 终端工具栏「更多」菜单 + 像素级统一 | ✅ 完成 | 2026-11-04：5 项逐项实现（命令历史 / 配置目录追踪 / 终端设置 / 开始-停止录制 / 终端编码），不支持的传输保留条目并置灰+行内原因；新增 OSC 7 hook 安装对话框与 cwd 回传、GB18030 终端编码（后端输入转码 + 前端流式解码 + 按主机持久化）、设置中心直达；工具栏按钮 24×24 / 6px 圆角 / 2px 间距 / 12px 图标 / hover 透明，菜单 192px / 4px 内边距 / 28px 行高 / 4px 行圆角 / 12px 字号 / shadow-md / 4px 偏移 / 150ms zoom-fade。真机 129 CDP 逐项验证；门禁 373✓/build✓/cargo check(server)✓/874✓。缺口：OSC 7 未 percent-encode、cwd 未接 SFTP 跟随、日志按钮下拉未做、GB18030 日志转码未做。 |
| 工具栏类型自适应 + 删除主机浏览器/广播 + 日志默认自动记录 | ✅ 完成 | 2026-11-05：删除「主机浏览器」「广播模式」全部入口/占位/置灰/文案；`toolbarCapabilities` 派生 SSH/本地/串口/Telnet 四类工具栏按钮矩阵（不支持项直接隐藏），顺序/图标/tooltip/分隔与 Netcatty 对齐；日志改为默认自动落库（无需手动开启）+ 工具栏按钮走原生保存对话框写独立文件，按钮三态，关闭标签收尾。129 实测录制/列表/导出链路；门禁 537✓/build✓/cargo check✓/934✓（随提交 174a40a）。 |
| 脚本 / 笔记模块按 Netcatty 重做（段C/D） | ✅ 完成 | 2026-11-05：脚本页重写（搜索 + 新建下拉[片段 Zap/脚本 Play/分组 FolderPlus] + 导入/导出/视图/排序/多选、面包屑 + 分组/片段两节、56px 列表行与 68px 卡片、右键菜单、右侧常驻编辑面板含变量 chips / 目标主机 / 多行方式 / 快捷键录制 / 保存并运行）；笔记页重写（图标工具条 + 可折叠搜索、分组树 + 拖拽 + 计数含子树、54px 标题行 + 模式下拉 + 大纲 256px、格式工具栏 H1–H4/表格/公式/链接/图片、行号编辑器 + 分屏预览 + 自研 undo/redo、`ssh://` 链接起连、导入导出、空状态）。129 实测：右键「磁盘用量」运行到活动会话出现 df 输出；笔记「129 主机」预览点击 ssh 链接新开会话。差异清单与踩坑 163–169 见 changelogs；门禁 549✓/build✓/cargo check✓/934✓。 |
| 剪贴板授权框 / 日志页右键 / 主机与终端右键菜单 | ✅ 完成 | 2026-11-05：剪贴板读全部改走 Rust `clipboard_read`（右键/中键/工具栏 + OSC 52），前端只保留 `writeText`，实测无系统授权框、粘贴不自动回车；日志页根节点 + App 根容器捕获阶段屏蔽 WebView2 默认菜单（输入框放行）；新增 `hostContextMenuModel` 按协议派生主机菜单（SSH 有 SFTP、本地无复制地址/账密、串口/Telnet 无 SFTP），主机卡片与终端侧栏共用，侧栏新增右键菜单。证据 `evidence/ctx-vault-*.png`、`ctx-terminal-pane-local.png`、`paste-local-no-permission.png`、`logs-contextmenu-prevented.png`；踩坑 176–178；门禁 577✓/build✓/cargo check✓。 |
| 终端撰写栏按 Netcatty 重做 | ✅ 完成 | 2026-11-05：取证 `TerminalComposeBar` / `useComposeBarHeight` / `composeBarHistory` / `executeSnippetCommand` 后重写：固定在终端底部、默认 120 可拖拽 72–360（结束才持久化）、textarea 内部滚动、50ms 自动聚焦、关闭回焦终端；Enter/Ctrl-Alt-Cmd+Enter 发送、Shift+Enter 换行、Esc 收起、IME 组合态不拦截；↑↓ 首末行翻阅本会话历史（100 条、跳空白/连续重复、越界恢复草稿）；发送内容 LF 归一 + 多行 bracketed paste 包裹且 `\r` 在包裹外，整段走新增 `writeBulk` 不逐字拆分；关闭/发送失败保留草稿。改前改后与 Netcatty 截图 `evidence/compose-before-*.png` / `compose-after-*.png` / `nc-compose-tab.png`；差异清单与踩坑 172–175 见 changelogs；门禁 570✓/build✓。 |
| 终端工具栏 / tab 状态点 / 右键菜单按 Netcatty 对齐 | ✅ 完成 | 2026-11-05：工具栏删除「端口转发」与「命令历史」内联按钮（历史只留 More），新增 `toolbarLayout` 派生四类型集合与顺序（高亮→SFTP→撰写栏→搜索→日志→脚本→更多；标题行 复制主机地址→时间戳→系统监控→断开→重连）；新增 `connectionStatus` 派生 tab 状态点 8px / 三色 / 2px 外圈 + 关闭按钮 20px 圆形（Netcatty 无第二个端口状态点）；新增 `contextMenuLayout` 派生右键菜单（复制/粘贴/全选→SFTP→重连→分屏→清空→关闭），删除自造「插入片段/运行脚本」。实测 SSH 129 / 本地 pty / Telnet 三类型工具栏与菜单、tab 三态色点；截图 `shots/context-menu-*-scoped.png`、`tab-status-*.png`、`context-menu-telnet.png`；串口 COM1 占用未测（沿用 #172）。门禁 693✓/build✓。 |
| 日志页精简（格式筛选 + 冗余首行） | ✅ 完成 | 2026-11-05：左栏只保留「全部主机」，移除格式下拉及相关 state/派生/过滤参数；日志项去掉与主机名重复的标题行与 asciicast 徽标，仅自定义标题保留首行；条目收紧为两行 / 49px。改前改后截图 `evidence/logs-page-129.png` / `logs-page-after.png`，详情 `logs-page-after-detail.png`；门禁 552✓/build✓。 |
| 设置页样式按 Netcatty 取证照抄（#219） | ✅ 完成 | 2026-11-06：Netcatty 复制实例 + CDP 9336 取 8 tab × 明暗实测值（另 PrintWindow 抓实窗交叉校验）；`styles.css` 设置页新增 Snow/Midnight token、随包 Mona Sans（12 woff2）+ Noto Color Emoji Flags、header 61 / nav 224 / tab 36 8.4 shadow / 内容 24 / 分区 24 / 卡片 radius 10.4 px16 divide-y / 行 py12 透明底 分隔线 / 控件 36 8.4 / 开关 36×20 / 色板 flex 右对齐 swatch 24；`uiFonts.ts` 字体栈与 Netcatty `--font-sans` 完全一致。验证：980×720 明暗 8 tab + 720 窄窗无溢出；`document.fonts` 4 个 Mona Sans loaded（度量 200.51 vs 189.05 证明非回退）；三段对照图 `evidence/cmp-*`。门禁 754✓/build✓/cargo test✓/server✓/tauri debug✓。 |
| 设置页 UI 按 Netcatty 重做 | ✅ 完成 | 2026-11-05：三步完成 —— ①「应用 + 系统」、②「外观 + 终端 + 快捷键」、③「占位 tab 空状态 + 窄窗复查」。外壳 18px 标题/224px 导航/36px 控件、分组标题 14px + 卡片 `--card` 圆角 8、行高 12px + 分隔线、开关 36×20/拇指 16px、按钮 36px 高与 danger 变体全部对照 Netcatty 数值映射到 `styles.css` 令牌（未引入 Tailwind runtime）；应用 tab 双栏 320px + ActionRow（链接仍复制），系统 tab 14 组卡片；外观合并语言/字体、主题/强调色卡片，透明度滑杆堆叠 + 预设胶囊、色板 12 列网格；终端提示移到卡片外；快捷键改分类卡片 + 28px mono 键帽 + 图标按钮；SFTP/AI/同步改为居中空状态卡片（min-height 320/图标 40/标题 14/说明 12），720px 窄窗无横向溢出（nav 168、行纵排）。明暗截图 `evidence/set-*`；门禁 730✓/build✓。 |
| 设置中心「终端」tab 1:1 复刻 | ✅ 完成 | 2026-11-04：主题跟随、字体 9 项（字体族/CJK/字号 10–32/两档字重/平滑/连字/行间距/仿真类型）、光标 4 项、键盘 3 项（置灰）、行为 30 行全量接通（右键三态+长按+全屏、中键三态、选择即复制/规范化、分隔符、括号粘贴、多行确认、Shift+Enter、标签双击、OSC 52、滚动 5 项、退出自动关闭、断开提示模式、回滚 0–100000、侧边栏 2 组、verifyHostKeys）；默认值与 Netcatty 逐键对齐；改设置即时生效、重启保留。真机 CDP 验证字号/字重/竖线/行高亮/右键菜单；门禁 379✓/build✓/cargo check(server)✓/874✓。缺口：Netcatty 实例不可用（像素并排待复核）、侧栏仅接 SFTP、本地 PTY TERM 固定、12 项保留置灰。 |
| Telnet 连接入口修复（同病根） | ✅ 完成 | 2026-11-03：移除 `ensureTab()` 兜底（全仓删除），Vault 补「Telnet」入口 → `TelnetConnectModal`（主机/端口 23/换行风格，单步模态）→ 确认后建 `Connector.kind=telnet` 标签；`TerminalPane` 负责订阅/打开/输入/resize/关闭 + 本地回声；删除 `TelnetPanel` 与 `TermBridge`。Netcatty 取证为模态向导（host 协议）；差异=独立入口与凭据字段（后端无凭据参数，不做假字段）。证据：telnet-before/after-click、telnet-connected、telnet-input、netcatty-quickconnect/telnet-selected/step2。门禁 306✓/build✓/cargo check✓/836✓。待人工：真实 Telnet 设备、用户名密码自动登录（P1 #20）。 |

---

## 全应用比对差异待办（第七轮，2026-11-06）

P1 已修 2 项（已知主机卡片图标/3 列、端口转发居中空态），详见 `changelogs.md` #184。

| 项 | Netcatty vs termX | 等级 | 后续处理 |
|---|---|---|---|
| 监控页面板化 | Netcatty 面板 + 空态「一眼查看多台主机」；termX 为主机勾选 + 频率/范围控制台 | P2 | ✅ #189：删除勾选控制台，改居中空态 + 全部 SSH 主机面板卡/整表；指标与刷新逻辑未改｜✅ #206：新增 `monitor_panels` 表（v49）+ 面板 CRUD（名称/主机/布局/列数/间隔/排序），保留「全部 SSH 主机」默认面板，开始/停止只作用当前面板 |
| 钥匙串模型 | Netcatty 密钥/证书/身份单页；termX 系统密钥/已存密钥 tab + SSH Agent | P2 | ✅ #188：移除子 tab，改单页分区（已存密钥 + 系统密钥/Agent/证书）；数据层未动 |
| 日志页布局 | Netcatty 日期/用户/主机/收藏整页表格；termX 左列表 + 右详情 | P2 | ✅ #190：改整页表格（会话/主机、时间、时长、大小、操作）+ 排序 + 行操作 + 整页详情；保留导出；格式筛选仍移除｜✅ #193：按用户偏好行内改单行（保留表格结构与列），**不得反向改回两行** |
| 脚本页行样式 | Netcatty 透明 56px 行 + 40px 图标方块、Shell 历史；termX 卡片行、导出按钮 | P2 | ✅ #207：仅列表行对齐（56px/透明无边框/hover secondary60、图标盒 44×44 圆角12 实心底、标题14/副标题11、badge 4×8、hover 编辑 32×32）；卡片视图 68px 不动。CDP 实测见 `evidence/audit11-snippets-*`；Shell 历史仍未移植 |
| 笔记页信息架构 | Netcatty 简单列表 + 实时预览；termX 分组树 + 行号编辑器 + 分屏 | P2 | 保留 termX 超集，补「实时预览」提法｜✅ #209：真实 129 原生验证 #205 五项全过（截图 `evidence/audit12-*`、断言 16/16），并修复面板开关按标签记忆（`notesOpenTabs`）｜✅ #210 页面版 IA 对齐 Netcatty（树头无标题/图标左对齐、树体 6/6/16 + 4px 行距、虚线空态、零笔记隐藏树、标题行 24/32/4、空态 64×64 双按钮；与面板共用 `notesModel` 保存队列） |
| 终端侧栏 | Netcatty 200px（图标行 + 笔记面板）且本地会话隐藏侧栏；termX 170px 主机树常驻 | P2 | ✅ #186：实测 220px = Netcatty 默认 220（170 为缩放截图误差）；时间戳列已实现（gutter 81px，同公式）｜✅ #187：侧栏默认收起（可切换）+ 本地标签/标题显示 Shell 名 |
| Vault 首页 | Netcatty 8 项导航 + 监控 + 底部设置，无独立 Telnet；termX 多「同步」导航、多「Telnet」入口 | P2 | ✅ #185：移除「同步」导航 + 补底部「设置」；✅ #204：Telnet 纳入主机协议（`Profile.protocol` 支持 telnet，卡片/右键/快速切换器均按 protocol 派生），独立 Telnet 入口按要求保留不删 |
| 代理页按钮层级 | Netcatty 页头「添加代理」secondary、空态 primary；termX「新建代理」仅 secondary；区块计数文案不同 | P2/P3 | ✅ #191：区块头「代理」+「N 项」；补 64px Globe 空态 + primary 新建代理；页头保持 secondary（与 Netcatty 一致） |
| 串口弹窗细节 | 弹窗 407 vs 360px、「保存配置」vs「保存为主机」、端口框多一个箭头 | P3 | ✅ #213 文案/图标对齐（「保存配置」「配置名称」「例如 Arduino Uno」「连接并保存」+ Cpu/Save 图标）；✅ #215 实测宽度 448px（Netcatty `max-w-md`）、取消按钮补 outline 边框；端口框箭头按 Netcatty combobox 形态保留 |
| SFTP 空态图标 | Netcatty 左 Monitor / 右 HardDrive；termX 左 Monitor / 右 Server | P3 | ✅ #191：右栏改 hard-drive（源码 + 截图证实是硬盘图标，非文件夹） |
| 设置窗口形态 | Netcatty 独立 Electron 窗口 980×720（min 820×600，非 modal，隐藏预热）；termX 全屏 overlay | P3 | ✅ #192 调研；✅ #211 立项；**✅ #212 已决策：不做独立窗口，保留应用内 overlay**（spike 验证可行但双 WebView2 内存/跨窗同步/AppLock 联动成本不值，方案关闭，不再排期） |
| 主机新建/编辑弹窗 | Netcatty HostDetailsPanel（w420、白卡、分区顺序、SFTP 分区等 10 条差异） | P3 | ✅ #194–#204 已对齐：白卡+浅灰页底 / 卡片12·输入8·按钮8 圆角 / 输入40px / 补 SFTP 设置分区 + 代理归位 / 分组·标签图标与 X / 保存密码 + 密钥入口 / 说明改 ⓘ tooltip / 验证器一行式 / 默认宽固定 420 / **#201 证书认证保存链路放开**（`CredentialType::Certificate` + 路径逃逸校验复用 + 迁移 v47；SecretStore 只存指纹/路径，真机 CA 未实测）/ **#202 主机级 known-host 策略**（`profiles.host_key_policy` verify·skip·NULL=跟随全局，连接前覆盖全局；端到端 host key 变化场景未实测）/ **#204 协议选择补 Telnet**（`telnet_username`·`telnet_charset`，迁移 v48，Telnet 隐藏 SSH 专属分区，密码进 SecretStore；实机 echo 已验证）｜设置页：**#203 每行 48px 条状底色 + 边框 + 12px 左右内边距**，8 tab 覆盖、720 窄窗无横向溢出 |

---

## 已完成（无需再做）

| 能力 | 状态 | 位置 |
|---|---|---|
| 收尾全应用最终回归（浅/深 + 四类终端 + 设置 8 tab，P1=0） | ✅ | `docs/final-regression.md`、`evidence/final-regression.json` |
| 收尾安装包验证（NSIS 安装/快捷方式/迁移/卸载残留；MSI 构建 + 权限阻塞说明） | ✅ | `docs/installer-verification.md` |
| 收尾文档收口（README / AGENTS 门禁基线 / 改名实际落地 / 人工确认项） | ✅ | `README.md`、`AGENTS.md`、`docs/rename-rssh-termx.md` §7 |
| SSH 会话（密码 / 私钥 / keyboard-interactive） | ✅ | `src/App.tsx`、`src-tauri/src/commands/ssh.rs` |
| 本地 PTY 终端 | ✅ | `src/Terminal.tsx`、`commands/terminal.rs` |
| SFTP 基础 + 流式 + 递归 + 进度 + 取消 | ✅ | `src/SftpPanel.tsx`、`commands/sftp.rs` |
| 串口会话 | ✅ | `src/serial/SerialConnectModal.tsx`、`src/TerminalPane.tsx`、`commands/serial.rs` |
| Telnet 会话 | ✅ | `src/telnet/TelnetConnectModal.tsx`、`src/TerminalPane.tsx`、`commands/telnet.rs` |
| 端口转发（local / remote / dynamic + 规则与统计） | ✅ | `src/ForwardPanel.tsx`、`commands/forward.rs` |
| 连接 / 凭据 / 分组管理 | ✅ | `src/ConnectionManager.tsx` |
| 主机级代理（HTTP / SOCKS5，密码走 SecretStore） | ✅ | `src/domain/proxyForm.ts`、`VaultView.tsx`、`ConnectionManager.tsx`、`ssh/proxy.rs` |
| 代理库（`proxy_profiles` schema v40 + Vault 页 + 主机引用） | ✅ | `src/ProxyProfilesView.tsx`、`src-tauri/src/db/proxy_profile.rs`、`commands/proxy.rs` |
| 代理库四项（schema v45：分组默认 / 钥匙串身份 / 拖拽排序 / ProxyCommand） | ✅ | `db/schema.rs`、`db/group.rs`、`db/proxy_profile.rs`、`ssh/proxy.rs`、`commands/session.rs`、`commands/proxy.rs`、`src/VaultView.tsx`、`src/ProxyProfilesView.tsx`、`src/backend/client.ts`；`cargo check` + `db::`/`ssh::proxy` 测试 + `tsc` 通过 |
| 系统代理 = 云同步 HTTP 代理（不改变 SSH） | ✅ | `commands/settings.rs http_client`、GitHub/WebDAV 构造 |
| SFTP 独立连接沿用主机档案代理 | ✅ | `sftp_connect(profile_id)`、`SftpHandle::connect(proxy)` |
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
| 端口转发 Vault 总览 + 条目 CRUD + 高级能力（P1 #16） | ✅ | `src/ForwardOverview.tsx`、`src/ForwardForm.tsx`、`src/forwardSupervisor.ts`、`src/domain/forwardOverview.ts`、`src/domain/forwardDraft.ts`、`commands/forward.rs`、`ssh/forward.rs`、`db/forward.rs`；schema v42：`forward_rules.bind_address` + `forwards.auto_start/auto_reconnect`；渲染层自动启动/断线重连监督器；托盘开关不移植（无 tray-icon 基础设施，置灰写原因）。 |
| Vault 顶部连接工具栏按导航显隐（对齐 Netcatty） | ✅ | `src/VaultView.tsx`、`src/styles.css`；仅「主机」分区显示，其余 9 页 `display:none`，无过渡。 |
| Vault 各子页左侧留白逐页对齐 Netcatty | ✅ | `src/VaultView.tsx`、`src/styles.css`、`monitor/MonitorView.tsx`、`sync/SyncView.tsx`、`ProxyProfilesView.tsx`、`snippets/snippets.css`、`keychain/keychain.css`、`notes/notes.css`、`sessionLogs/sessionLogs.css`。 |
| 主机发行版（distro）自动探测 + 持久化（schema v46） | ✅ | `src-tauri/src/ssh/distro.rs`、`db/schema.rs`、`db/profile.rs`、`commands/session.rs`、`models.rs`、`src/ui/DistroAvatar.tsx`；banner → `/etc/os-release` → `uname`，`set_distro_if_unset` + `COALESCE`；129 实测 Ubuntu 图标，未知回落 Server。 |
| Vault「主机」节回归修复（关标签后卡片观感丢失） | ✅ | `src/vault/rootHostsModel.ts` + `rootHostsModel.test.ts`、`src/VaultView.tsx`；剩余主机为空时回退全部主机，仅真正无主机才隐藏整节。 |

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
- [x] ✅ **11. 终端搜索 / URL 识别 / 滚动缓冲**（2026-11-04 完成）
  - 搜索高亮与跳转、Ctrl+点击打开链接、缓冲区上限可配。
  - 完成：xterm SearchAddon（`@xterm/addon-search` beta）实时高亮 + `findNext/findPrevious` + `onDidChangeResults` 的 `n / m` 计数；Cmd/Ctrl+F 拦截打开搜索条；WebLinksAddon 链接识别按设置「链接修饰键」（none/ctrl/alt/meta）激活，经 `open_external_url` 打开系统浏览器；滚动缓冲已由设置中心「回滚」接通。证据 `evidence/r6-search-link-01/02.png`；门禁 411✓/build✓。
  - 已知差异：链接 hover 下划线由 WebLinksAddon 默认样式；未逐像素比对 Netcatty 搜索条（基准实例不可用）；未实际点击打开浏览器（避免打扰）。
- [x] ✅ **12. 设置中心**（2026-11-03 完成：实现 + 实机比对差异清零 + review 修复，门禁全绿）
  - 主题（浅/深/跟随系统 + 终端主题）、字体与字号、快捷键、语言（i18n）、窗口透明度。
  - 实现：`src/settings/`（settingsModel/keyBindings/i18n/settingsStore/SettingsDialog/SettingsTabs）+ 自启动命令（Windows 注册表，双注册）。
  - 已知残留（见 changelogs 2026-11-03 实机比对节）：en 字典仅 14 键、主题预设库仅内置、透明度 CSS 近似、更新器/崩溃日志等未移植。
  - 终端 tab 置灰清理（2026-11-05，见 changelogs）：解除 `altAsMeta` / `optionArrowWordJump` / `preserveSelectionOnInput` / `oscNotifications` 四项；剩余置灰项改为逐项原因（Kitty 键盘协议、本地 ConPTY、剪贴板图片上传、clear 清回滚、提示符换行、动态标签标题、内置浏览器、本地 Shell 侧边栏）。
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

## P1 · 差异化能力（14 / 19，含 1 项 ⏸ 不移植）

- [x] ✅ **13. 脚本系统**
  - 阶段 A（2026-11-04 完成）：Snippet 增加 `language` / `trigger` / `trigger_pattern`（serde default，`snippets.json` 向后兼容；导入导出保留，不丢 Netcatty 数据）；脚本页新增活动终端运行条与「运行 / 停止（Ctrl-C）/ 暂停（Ctrl-Z）/ 恢复（fg）」，行内运行按钮按活动窗格连接态置灰；编辑器新增脚本语言与触发方式，javascript / python、onConnect / onOutput 全部置灰并写明原因（nct.* JS 运行时、连接生命周期钩子、输出匹配引擎均未移植）。
  - 129 实测：脚本逐行写入 `/tmp/termx-stagea-*`（3 行含主机名/时间，独立 exec 回读一致）；`sleep 60` 暂停后 `ps` 状态 `T`、恢复 `S+`、停止后进程 `MISSING`；未连接时运行按钮置灰并提示。证据 `evidence/script-stagea-129.json` + 编辑/运行截图。
  - 阶段 B（2026-11-04 完成）：渲染层真实现自动触发 —— 连接建立后按 `targets` / `targets_all_hosts` 执行 onConnect 脚本；下行业务输出 300ms 防抖匹配 `trigger_pattern`（同一会话同一脚本只触发一次）；触发过程写入内存环形日志并在脚本页展示（执行中/完成/失败，不伪造成功）。屏幕等待以 xterm 缓冲实现：`#@wait-prompt [ms]`、`#@wait-text <文本> [ms]`、`#@wait-regex <正则> [ms]`（默认 30s，超时抛错）。数据模型补 `targets` / `targets_all_hosts`。
  - 置灰写明原因（不可移植）：录制回放（Netcatty 依赖主进程会话录制与回放协议）、脚本内 `nct.dialog`（需主进程原生对话框回调）、`nct.progress` / `startLog`（宿主级进度与日志宿主未移植）。
  - 129 实测：onConnect 连接后自动写 `/tmp/termx-stageb-connect-*`（含主机名），脚本内 `#@wait-text` 命中回显后才继续；终端输入 `echo TERMX-OUTPUT-42` 触发 onOutput 写 `/tmp/termx-stageb-output-*`；重复输出不再二次触发；目标主机不匹配的负例脚本未触发。证据 `evidence/script-stageb-129.json` + `script-stageb-log.png`。
  - 参考：`components/scripts/`、`netcatty-bridge-script.d.ts` L148-L168。
- [x] ✅ **14. 主机监控面板**
  - CPU / 内存 / 磁盘 / 网络历史曲线，采样失败自动重试。
  - 完成（2026-11-04）：后端 `monitor_sample(session_id, timeout_ms)` Linux 只读采样（CPU/内存/磁盘/网络，逐项容错、8s 超时、本地 Δt 差分），`lib.rs` + `server.rs` 双注册；前端 `src/monitor/MonitorView.tsx` + `src/domain/monitorModel.ts`，Vault「监控」页启用（多选、图表/列表、2s 默认重采样、5/15/30min 趋势、状态与退避重连、SVG 曲线）。129 真机实测 CPU 0.8% / 内存 1188.9–3355.1 MiB / 磁盘 93.7% / 网络 1.1 KB/s；门禁 417✓ / 881✓。多面板 CRUD、macOS 采集未移植。
  - 监控扩项（2026-11-05）：同一条采样脚本新增 `/proc/diskstats`（sectors×512B 差分）、`/proc/[0-9]*/stat`（utime+stime 增量 / 全机 total）与 `/proc/[0-9]*/status` VmRSS；`MonitorSample.disk_io`（按速率降序）+ `processes`（Top 5），逐核 CPU 接入监控页与终端浮层；首次采样速率/进程 CPU 为 null 显示 `--`，缺 diskstats / 进程表时 warnings + 置灰。129 实测逐核 0.7% / 1.3%，sda 写 7065.5 B/s（UI 窗口 ↑45.3 KB/s），Top 进程 `gnome-shell 289.4 MB / kworker 0.1%`。延迟、GPU 仍置灰写原因。证据 `evidence/p2-monitor-expand*.json`。
  - 审计修正（2026-11-02）：termX 后端并不存在 `getServerStats` 命令（全后端检索确认），需先补后端采集命令，再做前端采集循环与图表。
  - 参考：`components/systemManager/`、`netcatty-bridge-monitor.d.ts`。
- [x] ✅ **15. 云端同步**
  - Gist / WebDAV 双向同步、自动同步、冲突提示、本地快照备份。
  - 阶段 A（2026-11-04）：Vault「同步」页启用 —— GitHub（owner/repo + 分支 + PAT，Token 存 SecretStore）与 WebDAV（URL/用户名/密码）配置、保存、推送、拉取、检查远端、本地版本刷新、启动时自动拉取开关（密码存 SecretStore）；复用 `commands/sync.rs` 既有 9 个命令并补前端类型/包装，`src/domain/syncModel.ts` 5 例单测；debug 实机探测本地 v1、未配置远端为空、空密码拦截与置灰说明均验证（`evidence/sync-page.png`）。
  - 阶段 B（2026-11-04）：推送/拉取前 `sync_check_remotes` + `detectSyncConflict` 判定 `remote_newer` / `local_newer` / `diverged`，破坏性方向弹窗提供「覆盖远端 / 改用远端 / 取消」（拉取前自动快照）；后端补 5 个本地快照命令（`sync_backup_create|list|restore|delete|clear`，双注册），快照 JSON 整体加密存 SecretStore、索引存 settings，最多 20 份，拉取与恢复前自动落保护性快照；Vault 同步页新增快照面板（创建/列表/恢复/删除/清空）。
  - 实测（本机 WebDAV 服务器模拟，`evidence/sync-phaseb-verify.json`）：推送写出 `rssh_backup.enc` **19860 B** + `rssh_backup.meta.json` v2；改主机名推送→改回→拉取后名字还原为推送值；快照列表出现 `before_restore` 与 `manual` 两条；远端版本 +1 后 UI 推送弹出「检测到同步冲突 远端 v4 高于本地 v3」截图（`evidence/sync-phaseb-conflict.png`）。
  - 剩余置灰：Google Drive / OneDrive / S3、OAuth 设备码、逐类目开关、逐条目三向合并、「打开备份目录」（快照在 SecretStore）；真实 GitHub PAT 推拉仍待有凭据时验证。
  - 参考：`components/cloud-sync/`、`components/sync/`。
- [x] ✅ **16. 端口转发可视化 + 自动启动/重连/监听地址（托盘不移植）**
  - 规则总览页（按主机分组、运行状态）、条目/规则级启停、列表/卡片视图、搜索与全部启停。
  - 进度（2026-11-04）：Vault「端口转发」总览 ✅（按主机分组、条目/规则级启停、2s 统计轮询、终端工具栏入口、跨界面运行态恢复）；Vault 页条目新建/编辑/复制/删除 ✅（复用 `ForwardForm`，校验前置、删除确认、运行中禁编辑并给出行内原因）；终端侧栏条目编辑/复制 ✅；总览页第一层 ✅（计数、搜索、全部启停）；**第二层 ✅**（列表/卡片视图持久化切换、规则行状态徽标、终端侧栏规则行常驻 + 2s 自动统计 + 规则级启停按钮、真实 129 链路实测）。
  - **第三层 ✅**（2026-11-04）：`forward_rules.bind_address`（Netcatty bindAddress）——local/dynamic 自定义监听地址，remote 传给 `tcpip_forward`；`forwards.auto_start` + `auto_reconnect`（三态，未设置跟随 auto_start）；渲染层监督器每 2.5s 轮询，启动自动拉起、意外断开有限 5 次重连、手动停止不回拉；129 实测 `0.0.0.0:18099` 监听 + 真实 SSH banner 流量、reload 后自动启动、直接 stop 后自动重连。托盘快捷启停**不移植**：未启用 Tauri `tray-icon` 特性、无托盘图标/菜单，总览页置灰并写明原因。
  - 参考：`components/port-forwarding/`、`onTrayTogglePortForward`。
- [x] ✅ **17. 内嵌图片（Kitty / SIXEL / iTerm）**
  - 接入 `@xterm/addon-image`（与 Netcatty 同一实现），新增 `src/terminal/inlineImages.ts` 解析设置：总开关（默认关闭，对齐 Netcatty）、三类协议独立开关、缓存上限 8-512MB、单图像素上限 1-64MP、单条序列上限 1-64MB，全部夹紧。
  - `Terminal.tsx` 在创建终端时按设置加载 addon，设置变更即时同步（先 dispose 旧 addon）；addon 加载失败只关闭图片渲染、不阻断终端。设置中心「终端 → 内嵌图片」新增开关与三项上限，中英文案齐备。
  - `@xterm/xterm` 升到 `6.1.0-beta.336`（addon-image 需要 `registerApcHandler` 新版解析器 API，6.0.0 会抛 TypeError 导致整页空白）。
  - 129 实测：远端写入 SIXEL / Kitty(f=32 RGBA) / iTerm IIP(PNG) 三段真实序列，终端依次 `cat` 后均生成 `.xterm-image-layer-top` canvas 且实际绘制像素（SIXEL 2368 / Kitty 3072 / IIP 3072）。证据 `evidence/inline-images-129.json` + `inline-sixel.png` / `inline-kitty.png` / `inline-iip.png`。
  - 说明：三类协议均能真渲染，无需置灰；图片只存在于当前终端生命周期，休眠/重连后需重新输出（设置页已提示）。
- [x] ✅ **18. Zmodem / Ymodem 传输**
  - 已移植 ZMODEM：`src/terminal/zmodem.ts` 基于 `zmodem.js` 的 Sentry 包住 SSH 下行字节流，自动检测远端 `sz` 的 ZRQINIT（下载）与 `rz` 的 ZRINIT（上传）；协议字节经 `sshWriteBytes`（原始二进制，不走文本编码）写回，非协议字节继续进终端。
  - 下载落盘固定 `~/Downloads`（重名自动加序号），终端左下角显示检测 / 进度 / 完成横幅；消耗 4 秒后自动收起，失败保留错误。
  - 拖拽上传：文件拖进终端 → 自动发送 `rz -y` → 检测到 ZRINIT 后逐个 `send_offer` 发送（10 秒无响应给出「远端未安装 rz」提示）；仅 SSH 会话启用。
  - 129 真机实测：远端 lrzsz（无 root：`apt-get download lrzsz` + `dpkg-deb -x`）真实 `sz` 下载 78894B 与远端逐字节一致；拖拽 10000B 上传后远端 md5 与本地一致。证据 `evidence/zmodem-129.json` + `zmodem-download-129.png` / `zmodem-upload-129.png`。
  - YMODEM 置灰：Netcatty 的 `sendSerialYmodem` 只存在于 Electron 主进程串口桥（直接持有 `serialPort` 双向流 + `node:fs` 读写），termX 串口为 Rust 后端字节流、前端无串口级流控/取消语义，且本轮无串口硬件可实测；不移植。
  - 差异留档：无 Electron 目录选择框（固定 Downloads）、无传输队列/断点续传/拖出桌面、无 ZMODEM 之外的协议（X/YMODEM）。
- [ ] ⏸ **19. Mosh / Eternal Terminal 会话（不移植）**
  - 按计划跳过，不算差距；详见「不移植」节。`VaultView.tsx` `ADVANCE_PLACEHOLDERS` 已留占位文案。
- [x] ✅ **20. Telnet 自动登录**
  - 复用串口自动登录状态机（`src-tauri/src/terminal/serial_auto_login.rs`，对齐 Netcatty `telnetAutoLogin.cjs`）：从下行文本匹配 `login:` / `Password:` 等提示，按凭据自动应答；`telnet_open` 新增 `username` / `password`（lib.rs + server.rs 双注册），读线程按 100ms tick 驱动过期，用户键入即取消。
  - 事件：`telnet:auto_login:<id>`，状态 `complete` / `cancelled` / `incomplete`（与串口同名事件载荷一致）；前端 `onTelnetAutoLogin` 接入状态栏。
  - 弹窗：`TelnetConnectModal` 补用户名 / 密码字段（密码为 password 输入框），两项都空则不启用、在终端内交互登录；行尾按 NVT CRLF 发送，避免未协商 BINARY 时被映射成 CR NUL。
  - 实测：本机 Python mock Telnet 服务端（`evidence/mock-telnet-login.py`，提示序列 + 延迟模式），CDP 实测两条路径——自动登录 `complete`（终端出现 Login OK / `mock#`，服务端日志收到 admin/secret）与用户抢先输入 `cancelled`（服务端从未收到凭据）；证据 `evidence/telnet-auto-login.json` + `telnet-modal-2324.png` / `telnet-auto-login-complete.png` / `telnet-auto-login-cancelled.png`。
  - 未实测：真实 Telnet 设备（本机无硬件，标记为待人工）；Netcatty 的完成后启动命令（termX 无对应延迟命令通道）未接。
- [x] ✅ **21. 自动更新（检查链路；安装置灰）**
  - 新增 `check_update`（`src-tauri/src/commands/update.rs`）：GET Tauri updater 兼容 `latest.json`，校验 http(s)、按 `platform_key()` 取当前平台产物、`version_gt` 比较（支持 `v` 前缀 / 预发布），返回版本 / 说明 / 产物 URL / 签名 / 平台；`lib.rs` + `server.rs` 双注册。默认源为 GitHub release 资产，可用 `TERMX_UPDATE_ENDPOINT` 指向本地 / 自建源。
  - 设置「应用 → 软件更新」：当前版本、检查更新按钮、发现新版本 / 已是最新、最新版本、发布平台、更新说明、错误文案（i18n）。`下载并安装` 保持置灰，行内写明缺签名公钥 / endpoint / CI 产物及补全位置。
  - 实测：本地 `python -m http.server` 提供 `latest.json`（v0.0.2）+ mock 包，应用以 `TERMX_UPDATE_ENDPOINT` 指向该源，点击检查后显示「发现新版本 · v0.0.2 / 最新版本 v0.0.2 / windows-x86_64 / 更新说明」；证据 `evidence/update-check.json` + `update-check-before.png` / `update-check-result.png`。
  - 未做（诚实置灰）：`tauri-plugin-updater` 插件、签名公钥、`latest.json` / 已签名安装包的 CI 发布流程、下载进度与安装重启。恢复步骤见 changelogs 2026-11-05「#21 自动更新」。真实安装未端到端（无签名密钥与可执行测试安装包）。
- [x] ✅ **22. 深链 / 单实例 / 托盘 / 多窗口**
  - `ssh://` / `telnet://` 深链 + 单实例聚焦已接入（`tauri-plugin-single-instance` 开 `deep-link` feature 首注册 + `tauri-plugin-deep-link`，`tauri.conf.json` 声明 schemes）；命令行传 `ssh://` 会唤起已有实例、按 host/port 匹配已有 SSH 主机并新建会话。`jms://` 仍置灰（无 JMS 后端）。
  - 多窗口：`open_tab_in_new_window` 已接前端「在新窗口中打开」，新窗口读 `window.__rssh_clone` 恢复同连接标签。
  - 托盘置灰：需 `tauri` 开 `tray-icon` feature + 托盘图标/菜单/关闭到托盘语义，且无法在本轮自动化环境实测托盘点击；设置与转发总览保留置灰并写明缺项。
- [x] ✅ **23. 应用锁 + 凭据加密存储**
  - 启动密码/生物识别解锁；凭据落盘加密。
  - 参考：`components/AppLock*.tsx`、`credentialsEncrypt` / `credentialsDecrypt`。
  - 落地：口令档位（PBKDF2-SHA256 校验器 + 启动/切回锁 + 设置中心管理；改动 `src-tauri/src/app_lock.rs`、`commands/app_lock.rs`、`src/appLock/`）；系统凭据（Touch ID / Windows Hello）需原生 helper，置灰并写明原因；凭据存储沿用 SecretStore，DB/WAL 取证无明文（`evidence/applock-db-forensics.json`）。
- [x] ✅ **24. 归档解压**
  - SFTP 右键解压 `.tar` / `.zip` 等。
  - 参考：`extractSftpArchive`。
- [ ] ⬜ **25. 文件名编码切换**（置灰，技术阻塞）
  - SFTP 目录与读写支持 GBK 等编码；参考 `SftpFilenameEncoding`。
  - 阻塞原因（2026-11-05 核实）：后端 `russh-sftp 2.1.1` 的协议层把路径/文件名固定为
    `String`，解码处 `try_get_string` 用 `String::from_utf8_lossy`（`src/buf.rs:22-26`），
    GBK 文件名在列表阶段即被替换成 U+FFFD、原始字节丢失；发送侧同样只能发 UTF-8 字节。
    `russh-sftp 3.0.1` 未改此行为。真实支持需 fork/补丁协议层按 `Vec<u8>` 透传路径，
    termX 侧 `iconv` 补不回来。主机档案 `sftp_encoding` 字段与保存链路保留，表单不暴露假入口。
- [ ] ⬜ **26. CLI**（部分完成：片段 + 直连传输；会话级操作置灰）
  - `termx-tool` 命令行（会话/传输/vault/转发/片段），供 Agent 与脚本调用。
  - 后端已有 `cli_status` / `cli_install`，缺命令实现。参考 `electron/cli/netcatty-tool-cli.cjs`。
  - 已完成（2026-11-05，`rssh-cli`）：`snippet list|show|add|rm`（读写 `snippets.json`，
    `filter_snippets` 单测）、`sftp ls|get|put`（复用 lib `SftpHandle`，密码/私钥非交互，
    内联代理可用）；129 实测 ls 33 项、put/get 33B SHA256 一致。
  - 2026-11-05 增量：`sftp home|mkdir|rm|mv|stat|chmod`（`parse_octal_mode` 单测；
    129 实测 mkdir→stat 0775→chmod 0700→mv→rm，非法 `999` 报 `sftp_invalid_mode`；
    证据 `evidence/cli-26-e2e.txt`）。`cargo test --bin rssh-cli --features cli` 9✓。
  - 置灰：会话级 `list/read/write/send` 需运行中应用的 RPC 桥（Netcatty `netcattyRpcClient.cjs`），
    termX 桌面端无此通道；`--json` / `--session` 与之绑定；传输不接跳板链与 `proxy_profile_id`。
- [x] ✅ **34. 主机表单高级字段**（2026-11-04 完成）
  - 已补：主机级环境变量（`profile_env_vars` schema v41 + `profile_env_list/save` 双注册 + SSH `SetEnv` 在 pty/shell 前发送 + sync payload 顶层导出/导入 + Vault 编辑器交互）；启动命令沿用既有 `init_command`。
  - 2026-11-04 补：**字符集 / 终端编码** 纳入主机编辑面板（UTF-8 / GB18030），按主机保存并与终端「更多 → 终端编码」共用同一份偏好（Netcatty `Host.charset`）；保存主机时写入，编辑时回读。
  - 置灰并写原因（后端无字段/无消费方）：主题/字体/字号覆盖（仅全局设置）、启动命令运行模式（`lineDelay`/`paste`）、登录/连接脚本/输出触发器（依赖 #13）、Mosh/ET/X11、设备类型/OS 覆盖、SSH 算法（字段有但编辑器未暴露）、Keepalive/超时（无主机级字段）、系统 SSH Agent 路径/IdentitiesOnly；SFTP 协议/Sudo/文件名编码/图标仍属“字段有、消费方未接”，保持置灰。
  - 129 实测（两轮）：`init_command` + `LC_ALL=C` 连接成功，标记文件 `TERMX-INIT-OK / LC_ALL=C`，exec 对照通道为空 → SetEnv 生效；129 sshd `AcceptEnv LANG LC_* COLORTERM NO_COLOR`；主机面板保存 `GB18030` 后按主机 localStorage 回读一致并恢复 UTF-8。门禁（补字符集后）433✓/build✓。
  - 依据：netcatty `domain/models/connection.ts` Host 约 30 字段；termX 表单从 11 个扩到 13 个（+环境变量、+字符集）。
- [x] ✅ **35. 串口 1:1 重做**
  - ✅ 阶段 A（2026-11-03）：`serialFormConfig.ts` 对照表 + `serialInput.ts` 输入语义 + `SerialPanel` 常量表驱动重构；本地 commit `7a29ed3`。
  - ✅ 阶段 B（2026-11-03）：间距/标签/主按钮视觉复检并修正；补卸载时串口句柄释放与 `serial_not_found` 文案；本机 COM1 真实打开 + 行模式/本地回显/退格手测通过；门禁 294✓/build✓/cargo check(server)✓/836✓；commit `be07732` 已 push（远端 main=`be07732`）。
  - 留档（待人工）：ymodem（后端未实现且无设备验证，未加假按钮）；命名管道（crate 不支持，明确报错）；保存配置为主机（无 host 模型）。
- [x] ✅ **36. SFTP 细节交互**（2026-11-04 完成）
  - 面包屑导航、覆盖冲突对话框、同主机复制（与 #24 归档解压联动）。
  - 依据：netcatty `components/sftp/SftpBreadcrumb.tsx` / `SftpConflictDialog.tsx`；termX `SftpPanel.tsx` 为单栏、无面包屑、无冲突提示。
  - 冲突检测后端与冲突对话框前端已随 #10 阶段 A/C 完成（2026-11-03）；面包屑已随 #9 阶段 A 完成（2026-11-03，双栏 SftpPaneView）；同主机复制 2026-11-04 完成：`sftp_copy` 双注册 + `copy_file` 分块流式/原子覆盖，右键「复制到…」复用冲突对话框（跳过/创建副本/替换）；129 实测 36B 复制内容一致；目录复制与进度事件未做（菜单只对文件出现）。
- [x] ✅ **37. Vault 其余子页**
  - 笔记、会话日志页、代理库入口、监控页均可从 Vault 侧栏进入（2026-11-05 核对：
    `VaultView.tsx` navItems 四项全启用，MonitorView/NotesView/LogsView/ProxiesView 均已挂载；
    monitor 在 #14 即已启用，原「仅 monitor 仍为禁用占位」描述过期）。
  - 进度（2026-11-04）：笔记阶段 A/B ✅；日志阶段 A/B ✅；代理库 ✅（Vault「代理」页列表/新建/编辑/删除 + schema v40 `proxy_profiles` + 单主/连接管理器引用 + 删除清引用）。2026-11-05 补齐四项（schema v45）：分组默认代理（`groups.proxy_profile_id`，主机优先/分组继承）、钥匙串身份（`proxy_profiles.identity_id`）、拖拽手动排序（`reorder_proxy_profiles`）、ProxyCommand（`proxy_profiles.command` + `%h/%p/%%`）；四项均有后端/前端实现与单测，无置灰项遗留。
  - 依据：netcatty `components/notes/`、会话日志与 `ProxyProfilesManager.tsx`；termX `VaultView.tsx` navItems 中 monitor 仍禁用，proxies 已启用。
- [x] ✅ **39. SSH agent 转发（2026-11-02 范围修正纳入移植）**
  - 按 Netcatty 的代理/agent 转发界面与逻辑 1:1：agent 列表、转发开关、认证走 agent（以 Netcatty 实际行为为准）。
  - 完成（2026-11-05）：档案 `agent_forwarding` 开关 + 主机表单已就位；shell 通道早已请求
    `auth-agent-req@openssh.com`，本轮补上 **exec 通道**（`exec_once` 增参，`ssh_exec` 按档案开关传入）。
  - 129 实测：开关 true → `ssh_exec 'echo ${SSH_AUTH_SOCK:-EMPTY}'` 返回 `/tmp/ssh-…/agent.<pid>`；
    改回 false → `EMPTY`；测试结束已恢复档案原值。
  - 置灰：桥接到本机 agent 的端到端（远端 `ssh-add -l` 取到本机身份）未实测——本机 Windows
    `ssh-agent` 服务 Stopped/Disabled（启动需管理员）且无 Pageant；已验到「请求发出 → sshd 建 socket」。
  - 与「代理」配置（#37 入口）一起排期，建议紧跟端口转发/代理模块，先后按依赖定。
  - 安全口径：SSH_AUTH_SOCK 路径与密钥信息不进日志、提交与文档；实机验证不明文落盘凭据。
  - mosh / eternalTerminal / X11 转发仍不移植。

---

## P2 · 大工程（0 / 6，含 5 项 ⏸ 暂缓移植）

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
  - 进度（2026-11-05）：OSC 7 目录追踪已接通 SFTP——新增 `domain/sftpFollowCwd.ts` 判定纯函数，
    `PaneHandle` 暴露 `cwd()/subscribeCwd`，`App` 透传活动窗格目录，`SftpPanel` 支持首次进入与实时跟随
    （不可达回退 home 并记 blocked；设置中心「追随终端目录」开关默认关）。
    端到端复检（129 + CDP）通过：首进 `/home/tianzry`，`cd /tmp` 后跟到 `/tmp`；
    复检 v2 追加真实传输场景：64 MiB 上传 running 期间 `cd /var` 不抢目录（仍 `/tmp`），
    取消后跟到 `/var`（证据 `evidence/sftp-follow-129-v2.json` + 3 张截图）。
    本地压缩包快捷解压已完成（2026-11-05）：`build_local_extract_plan` +
    `local_extract_archive` 双注册，本地归档行右键「解压到当前目录」；
    debug 版 + CDP 实测 `sample.tar.gz` → `hello-local.txt`（内容一致），
    证据 `evidence/local-extract-31.json` + 两张截图。
    输入兼容模式（中文 IME 逐字发送）已完成（2026-11-05）：schema v43 主机级
    `ssh_input_compatibility`（NULL = 老数据视为开启）、`splitCompatibleWrites` 纯函数、
    连接时快照 + 逐码点 sshWrite、两处主机表单开关；129 实测粘贴 4 汉字远端回读完整，
    证据 `evidence/ime-compat-31.json`（Tauri 冻结 internals，IPC 计数取证不可行，已记录）。
    宽字符核验：xterm 默认 Unicode provider 覆盖 CJK（Netcatty 亦未用 unicode11），
    129 实测中文渲染完整，无需额外改动。
    光标行高亮已完成（2026-11-05）：按 Netcatty `CursorLineHighlighter` 语义重写（pending→onRender、
    选区/alternate buffer 清除、contentEnd 裁剪 + tail range、buffer change 与 tracking 自愈），
    底色改由终端主题派生（background/foreground/selectionBackground，对比度 ≥4.5）；
    debug + CDP 连 129 实测移动光标 / 选区 / 滚动 / 换主题四场景，
    证据 `evidence/cursorline-31.json` + 5 张截图；门禁 497✓/build✓。
    剩余：命令黑名单 / 命令块脱敏依赖 Netcatty AI 执行器（termX 无 AI，置灰）。
  - 参考：`commandBlocklist.ts`、`cursorLineHighlight.ts`、`inheritedCwd.ts`。
- [ ] ⏸ **38. 会话快照迁移（暂缓移植；口径修正为 AI 观察弹窗的活动会话接管）**
  - 原规格「跨窗口 / 重启的会话状态交接（序号、回滚缓冲、激活态）」与 Netcatty 实际不符：
    `requestTerminalSessionSnapshot` / `applyTerminalSessionSnapshot` 只服务 **AI 观察弹窗**
    （`attachExistingSession`）接管运行中的会话——`components/terminal/useTerminalEffects.ts`
    L693-L721 的流程是「暂停输出并排空 → 请求快照 → rebind 输出 → 恢复」，不是窗口迁移，
    也不在应用重启后保留任何内容。
  - termX 阻塞（源码层核对，2026-11-05）：
    1. 唯一消费方是 AI 观察弹窗，依赖 #27 AI 侧栏（plan.md 暂缓），termX 当前无调用场景；
    2. Netcatty 依靠 Electron 主进程的 webContents 归属与授权码做输出重绑
       （`electron/bridges/terminalBridge.cjs` L210-L247），并由终端 worker 提供
       `acquireSessionFlowPauseLease` 暂停/排空；termX 的 Tauri 后端把每块数据用
       `AppHandle::emit` **广播到所有 webview**（`src-tauri/src/ssh/client.rs` L2125、
       `src-tauri/src/emitter.rs` L65；`tauri-2.12.5/src/lib.rs` L961-L978），没有按会话的窗口归属、
       输出暂停或回放缓冲，无法保证「快照 → 接管」之间不丢字节、不重复渲染。
    3. 「重启恢复」不可达：SESSIONS/PTY 都在进程内存，进程退出即销毁；快照只剩文本，
       与 Netcatty 行为也不一致。
  - 结论：标 ⏸，不新增假入口。若启动 #27，需单独立项「会话输出路由 + 暂停排空 + 快照传输」
    子系统（跨 ssh/pty/serial/telnet 四类会话），再做 AI 观察弹窗接管。

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
   **【2026-11-06 ✅ 已关闭】** 已补 `ssh_exec`、5 个 discovery、`open_external_url`（改用 opener 自由函数），并顺带补 `app_lock` 6 个与 `clipboard_read/write`；`known_hosts_*` 此前已在。剩余 12 个为 GUI 专属（窗口/原生对话框/图标），在 `server.rs` 注释中显式列为不实现。
2. **两套主机表单字段不一致**：`VaultView.tsx` 右侧新建面板与 `ConnectionManager.tsx` 弹窗各有一套 profile+credential 表单；后者有跳板机选择，前者建出来 `bastion_profile_id` 恒为 null → 同一操作两个入口两种能力，易产生数据不一致。建议：收敛为单一表单模型/组件。
3. **大文件职责混杂**：前端 `VaultView.tsx`（86KB：导航+三视图+搜索排序+标签+多选+右键+拖拽+框选+快速连接+已知主机页）、`TerminalPane.tsx`（40KB：状态机+工具栏+菜单+弹窗编排）、`styles.css`（103KB）；后端 `commands/lifecycle.rs`（105KB）、`ai/sanitize.rs`（100KB）、`ai/session.rs`（95KB）、`server.rs`（76KB）、`sync/config.rs`（76KB）、`ssh/client.rs`（68KB）。建议：相关维护时按职责拆分，不专项重写。
4. **前端无测试 runner（已解决 2026-11-02）**：已引入 Vitest 3 + jsdom（`vitest.config.ts` + `src/test/setup.ts`，9 个测试文件 / 71 用例，`npm run test:run` 全绿），覆盖 domain 纯逻辑 / workspaceModel / backend 桥接 / 工作区持久化 / 认证表单；门禁规则见 AGENTS.md R11，细节见 changelogs.md 同日条目。
5. **sftp_download 内存版 IPC 膨胀**：返回 `number[]`，大文件约 4 倍膨胀；已有流式版 `sftpDownloadTo`。建议：内存版仅限小文件场景或移除。
   **【2026-11-06 ✅ 已关闭】** 删除前端零调用的 `sftpDownload` 封装；后端命令保留给 headless/CLI 小文件读取并加文档约束，桌面前端统一走流式 `sftp_download_to`。
6. **多组后端命令前端零调用**：discovery(5)、plugin(7)、command_block(3)、window(3：`open_tab_in_new_window` / `clipboard_read` / `clipboard_write`)、update（`fetch_latest_release_tag`）、sync(11)、AI（约 36）、`reconcile_sessions`。建议：随对应模块（#15/#26/#27 等）接线，或显式标 ⏸，避免长期死代码。
   **【2026-11-06 ✅ 已关闭】** 复核结论：discovery/plugin/command_block/update/sync/AI/`reconcile_sessions` 由 headless、CLI 或暂缓模块（#15/#26/#27）使用，非死代码；`clipboard_read/write` 已补 headless 分支。保留不删，后续随模块接线。
7. **cargo check 6 个 dead-code 警告**：`ai/llm.rs` 字段、`sanitize::decode_lossy`、`cli_status_headless`、`forward_rule_start_impl` / `forward_rule_stop_impl`（后两者疑似与 SSH 移植会话的快照时间差所致）。建议：移植收尾后复查清理。
   **【2026-11-06 ✅ 已关闭】** 删除 `decode_lossy` 与 `app_lock` 未用导入，`cli_status_headless` / `forward_rule_*_impl` 加 `cfg_attr(not(feature="server"), allow(dead_code))`，`ChatDelta` 未消费字段加注释 + `allow`；另清两个测试警告（crypto 未用变量、telnet 未读初值）。`cargo check --all-targets`（含 server feature）零警告。
8. **todo 口径冲突已修正**：P1 #14 原称「后端已有 getServerStats」不实（已改写）；#19 与「不移植」口径冲突（已标 ⏸）；#28/#29 与 plan.md 暂缓口径对齐（已标 ⏸）。

---

## 改名专项：rssh → termX（2026-11-06）

> 盘点详见 [docs/rename-rssh-termx.md](docs/rename-rssh-termx.md)。仓库内 73 文件 / 640 处，`evidence/` 25 文件 / 60 处（历史保留）。

- [x] 盘点清单（docs/rename-rssh-termx.md）
- [x] 代码改名：crate `termx` / lib `termx_lib` / bin `termx`·`termx-cli`·`termx-server`；显示名、窗口标题、AI 窗口、iOS 用途说明、CLI 帮助/提示、错误前缀 `__termx_err__`（前端双前缀兼容）
- [x] 路径迁移：`~/.rssh` → `~/.termX`（同卷原子 rename / 跨卷复制校验 + 失败回退、staging 恢复、幂等 lock）、`rssh.db` → `termx.db`（含 `-wal`/`-shm`/`.bak-*`）、keychain service `rssh` → `termx`（旧 service 双读 + 懒迁移、旧条目保留一轮）、`RSSH_*` 环境变量改 `TERMX_*` 并旧名回退
- [x] 可观测：系统 tab 显示数据目录/DB 路径 + 一次性迁移提示（`.rename-migration.json` 读取即删）
- [x] 文档与脚本：AGENTS、AI 设计文档/提示词、build-debug.bat、.launch-termx.vbs、changelog #218
- [x] 5 项门禁 + 129 实机迁移验证：DB 23 表/301 行不变，录制 179 全跟随，连 129 成功，重启后 302 行 / 日志 180 条仍在（截图 `evidence/rename-migrate-01..05`，JSON `rename-migrate-verify/restart/notice`）
- 明确保留：`changelogs` 历史、`docs/plan.md`、迁移文档、`evidence/`、远端同步文件名 `rssh_backup.*`、旧 `__rssh_err__` / 旧 keychain service / `rssh-org` 外链

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
| 2026-11-06 | #213 串口弹窗收尾：文案改用 Netcatty 原文（「保存配置」/「配置名称」/占位「例如 Arduino Uno」/「连接并保存」），主按钮随勾选切换 Cpu/Save 图标；实测宽度 448px 与 Netcatty `max-w-md` 一致。 |
| 2026-11-06 | #214 技术债（#208 review P2-7/8）：`toolbarLayout` 新增 `TOOLBAR_CAPABILITY_OF` / `TERMINAL_MORE_ACTIONS`，工具栏与 More 菜单的可见性/顺序由 spec 驱动；新增 `terminalActionText.ts` 作为工具栏/More/右键唯一文案来源，JSX 不再另写一套。 |
| 2026-11-06 | #215 第二轮全应用比对：debug 实跑 + CDP 逐页截图；P1 无；P2 串口取消按钮补 outline 边框（已修并重建复测）；P3 为已知能力差异（Netcatty 独有 browser/ymodem/openSessionLog、右键上传下载、插件菜单）。Netcatty 实例无 CDP，逐页像素自动化列为未验证。 |
| 2026-11-06 | #216 129 SSH 全矩阵实机验证：工具栏 13 项 + 关闭窗格、More 5 项、tab 三态点、右键 8/9 项与点击行为、时间戳对位/reflow/分屏独立、撰写栏多行与历史/Esc、`.cast` 即时落盘与日志页、自动补全 `l`/`ls `/↓/→/Tab、分屏连开 3 次稳定全部通过；P2 修复 `.cast` 录制中 0 字节（Recorder/TextLogRecorder 即时 flush）与右键粘贴字面量 `[200~`（`buildPastePayload` + `writeBulk`）；P3 记录 More「开始录制」内联文案、OSC7 Esc 未确认；门禁 753✓/build✓/948✓/tauri debug✓。 |
| 2026-11-06 | #219 设置页样式取证照抄：Netcatty 复制实例 + CDP 9336 取 8 tab × 明暗实测值；随包 Mona Sans + Noto Color Emoji Flags，设置页 Snow/Midnight token，header 61 / nav 224 / tab 36 8.4 shadow / 内容 24 / 分区 24 / 卡片 radius 10.4 px16 divide-y / 行 py12 透明底分隔线 / 控件 36 8.4 / 开关 36×20 / 色板 flex 右对齐 swatch 24；字体度量证明非回退；720 窄窗无溢出；对照图 `evidence/cmp-*`；门禁 754✓/build✓/cargo test✓/server✓/tauri debug✓。 |
| 2026-11-06 | #217 剩余低危技术债清理：headless dispatcher 补 15 条分支（ssh_exec / 5 discovery / open_external_url / app_lock 6 / clipboard 2），缺口 27→12（剩余全部 GUI 专属并在 server.rs 注释列明）；前端删除零调用 `sftpDownload`；dead-code 警告清零（删 decode_lossy/未用 Arc，server-only 函数加 cfg_attr allow，ChatDelta 加注释 allow，另清 2 个测试告警）；#6 复核为 headless/CLI/暂缓模块在用，保留；#2/#3 非低危保留；门禁 753✓/build✓/949✓/server✓/tauri debug✓。 |
| 2026-11-06 | rssh→termX 改名专项盘点完成（未改代码）：仓库 73 文件 / 640 处 + evidence 25 文件 / 60 处；清单与迁移方案见 `docs/rename-rssh-termx.md`；确定 crate/二进制/显示名、`~/.termX` + `termx.db` 移动迁移、keychain 双读懒迁移、`RSSH_*` 旧名回退；历史文档与远端备份名保留。 |
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
| 2026-11-05 | 终端工具栏类型自适应 + 删除主机浏览器/广播 + 会话日志默认记录（本轮）：删除地球图标、广播按钮、终端右键「浏览器」、Vault 主机右键「打开浏览器」及 `broadcast` 快捷键/i18n；新增 `src/terminal/toolbarCapabilities.ts` 纯函数（4 例单测）按 SSH/本地/串口/Telnet 派生可见性，不支持项直接隐藏；非 SSH 会话补 hostInfo（串口=端口名 / Telnet=host），复制主机地址可用；`recording_enabled` 与前端 `sessionLogs.enabled` 默认改 `true`，PTY/串口/Telnet 新增 `LogSlots` 接入默认 asciicast 录制，手动文本日志四类均可用且与自动记录并行；`close_resource` / owner 级关闭 / sink Close 三处幂等刷盘；录制文件名过滤 Windows 保留字符（Telnet `host:port`）。矩阵与踩坑 154-162 见 `changelogs.md`。门禁 `test:run` 537✓ / `build`✓ / `cargo check`✓ / `cargo test --lib` 934✓；debug + CDP 实测四类工具栏与 129 日志链路（截图 `evidence/toolbar-*.png`、`logs-page-129.png`）。 |
| 2026-11-04 | 全应用逐功能比对·第七轮完成（脚本与片段）：分组级重命名（模态 + 级联子分组 `renameSnippetPackage`）与分组删除（`deleteSnippetPackage`）、快捷键冲突检测 `findShortkeyConflict`（保存时报「已被片段 X 占用」）；新增 6 条单测。缺口登记：导入预览模态、目标主机/分组 targets（需后端字段）、执行历史与运行日志、终端内快速添加、录制保存为脚本。门禁 388✓/build✓/cargo check(server)✓/874✓；debug 重编 + CDP 实测分组操作与重命名模态。 |
| 2026-11-04 | 全应用逐功能比对·第八轮完成（笔记）：新增大纲侧栏（`extractNoteOutline` 解析 1–6 级标题、跳过围栏代码块、层级缩进、点击跳转编辑器对应行、可折叠「大纲」按钮），新增 3 条解析单测。缺口登记：MDXEditor 富文本/语法高亮、工具栏全量（链接/图片/表格/数学）、导出 HTML/PDF、图片粘贴布局/代码 tooltip/数学渲染、主机级笔记。门禁 391✓/build✓/cargo check(server)✓/874✓；debug 重编 + CDP 实测大纲生成与跳转。 |
| 2026-11-04 | 全应用逐功能比对·第九轮完成（日志）：数据源为 asciicast recordings（Netcatty 为连接日志缓冲），复核浏览/筛选/彩色与原文/导出三格式/删除确认均等价；新增查看器字号定制 `A−/A+`（9–22px，实时生效）。缺口登记：收藏/取消收藏、进行中状态、用户名列、按日志持久化主题与字号（需后端元数据）。门禁 391✓/build✓/cargo check(server)✓/874✓；debug 重编 + CDP 实测 13px→15px。 |
| 2026-11-04 | 全应用逐功能比对·第十轮完成（已知主机）：此前已 1:1，本轮对照 Netcatty `KnownHostsManager` 复核搜索/网格列表/排序/扫描/导入/删除/空态，全部通过，无代码改动。缺口登记：导入时过滤公共服务器（github 等）并提示数量（需后端合并前判定）、RENDER_LIMIT 分页（数据量小，不做）。门禁 391✓/build✓/cargo check(server)✓/874✓；CDP 实测 6 条 + 搜索空态。 |
| 2026-11-04 | 全应用逐功能比对：登记清单全部完成（Vault 首页与分组、主机新建/编辑/连接、终端标签与分屏、工具栏与更多菜单、串口/Telnet/本地终端、SFTP、设置各 tab、钥匙串、脚本与片段、笔记、日志、已知主机）。下一步进入第二步：设置 → SFTP tab 一比一复刻（先列 Netcatty 实际清单再逐项落地，即时生效且重启保留，无法落地项置灰写明原因）。 |
| 2026-11-04 | 第二步完成：设置 → SFTP tab 1:1（12 项对照 Netcatty SettingsFileAssociationsTab）。落地：双击行为 open/transfer（transfer=传到对侧焦点面板，复用拖动载荷；无对侧/同类型回落打开）、隐藏文件默认值即时生效、连接自动开侧栏绑定 `sidePanelAutoOpen`、传输并发 1–16 单一来源（设置 store → 后端并持久化，后端默认 2→6 上限 8→16，队列面板改读写 store）。置灰+原因：树视图、自动同步、压缩传输、追随 CWD、跳过未改文件、SSH 保活 TTL、默认打开方式、文件关联表。门禁 392✓/build✓/cargo check(server)✓/874✓；CDP 实测 12 行与禁用状态、改值后刷新持久化并已还原。剩余：无（代理/端口转发仍暂停）。 |
| 2026-11-05 | P2 #38「会话快照迁移」核定 ⏸：核对 Netcatty 源码确认快照 API 的唯一用途是 AI 观察弹窗（`attachExistingSession`）接管活动会话（暂停/排空 → 快照 → rebind → 恢复），不是跨窗口/重启迁移；termX 缺 #27 消费方，且 Tauri `AppHandle::emit` 为全窗口广播、无会话级窗口归属/输出暂停/回放缓冲，重启后进程内会话已销毁。无代码改动（不放假入口）；详细代码引用见 #38 条目。 |
| 2026-11-05 | P2「证书认证」完成：russh 0.62 原生支持 `authenticate_openssh_cert`；凭据新增 certificate 类型，私钥/证书分别存 SecretStore（`cred:<id>:secret` / `cred:<id>:certificate`），auth.rs 解析 `*-cert.pub` 后走证书认证；钥匙串新增证书区（扫描 `~/.ssh/*-cert.pub`，展示算法/principals/有效期/缺私钥，「用作凭据（绑定主机）」组合凭据）。实机用临时 CA 证书被 `keychain_list_certificates` 正确解析；缺真实信任 CA 的 sshd，证书登录未实测。门禁 526✓/build✓/cargo check✓/cargo test lib✓。 |
| 2026-11-05 | P2「TOTP」完成：新增 totp.rs（BASE32 + HMAC-SHA1，RFC 6238，30s/6 位），keyboard-interactive 命中验证码提示时自动回答（支持 totp_regex / auto_submit），未命中仍人工弹窗。RFC 六组向量通过；paramiko mock sshd 实测自动填充一次成功（`tests/totp_mock.rs`，`--ignored`）。 |
| 2026-11-05 | Vault 顶部「+」改为 Netcatty QuickSwitcher：新增 `src/QuickSwitcher.tsx`，分区「主机 → 标签页（Vaults / SFTP / 会话标签）→ 本地 Shell」+ 搜索框 +「跳转到 Ctrl+J」；↑↓/Enter/Esc 与点遮罩关闭；主机直连、本地 Shell 按发现 shell 新建 pty 标签、Vaults/SFTP/标签激活；「+ 新建工作区」按 termX 无工作区能力置灰并写行内原因。几何/阴影/圆角/列表高度按 Netcatty `top-12 pt-2 / max-w-2xl / rounded-xl / shadow-2xl / min(360px,…)` 对齐。debug 重编 + CDP 实测（`evidence/plus-menu.png`、`plus-menu-check.json`）。 |
| 2026-11-05 | Vault / 顶部标签 / 快速切换器图标对齐 Netcatty：装 `lucide-react@0.560.0`（同版本）；拷入 Netcatty `public/distro`（28）与 `public/shells`（10）资源；新增 `DistroAvatar`（xs/sm/md/tree/log/lg）与 `shellIcons`；左导航 10 项、顶部根标签/加号/会话标签、快速切换器菜单行、主机卡与列表头像全部替换。SSH 主机因 termX 无 distro 数据走 Netcatty 同款「主色+Server」兜底；「同步」导航保留 Cloud。门禁 tsc/526 tests/build 全绿，CDP 截图 `evidence/plus-menu.png`。 |
| 2026-11-05 | 分屏重连修复 + 自动补全 + 命令历史 + SFTP 自动连接 + 撰写栏片段 + 时间戳/内边距（本轮）：分屏改为布局矩形与终端实例解耦（paneId 恒定、split/close 不重建，回归测试断言原 pane 挂载次数 1）；自动补全按 Netcatty（默认开、ghost 默认关、下拉默认开、100ms、50 条、host/global、↑↓ 预览、Tab 放行、Enter 执行、Esc 恢复）；命令历史 localStorage（500/主机分桶/去重），四类终端 More 入口；SFTP 右键与工具栏共用开标签+自动连接（复用当前 SSH 会话、代次守卫、独立连接 ref 修正）；撰写栏顶部片段按钮（追加多行、管理浮层）；视口内边距（上10/右4/下4/左4）与时间戳 gutter 可开关。门禁 test:run 61/643✓ build✓ cargo check✓；CDP 证据 `evidence/r11-*.png|json`。剩余：时间戳 reflow 重映射、bracketed paste 多行历史、非 SSH 历史 hostId 稳定化、串口/Telnet 截图、SFTP 传输人工验证。 |
| 2026-11-05 | 剩余待办收口（本轮）：#169 时间戳 gutter 改用 xterm marker 锚定（reflow 安全）+ scrollback 饱和用 onLineFeed 补打点 + reflow 重置上次打点行；#170 bracketed paste 多行按一条命令（跨 chunk + 逻辑行校准）+ 孤立 ESC 不吞字符；#171 非 SSH 历史 hostId 改连接参数（pty/serial/telnet，改名不换桶）；#172 串口实机阻塞（COM1 拒绝访问、无 com0com 虚拟对）+ Telnet 本地服务握手/回显成功；#173 SFTP 129 上传/下载 1300B SHA256 一致，原生对话框待人工。门禁 61 文件/661 用例 + build + cargo check 全绿；review 高危 2 + 中危 2 已修。证据 evidence/serial-telnet-verify.json、sftp-upload-download-129.json、sftp-source-129.txt、sftp-downloaded-129.txt、debug-app-after-fixes.png（不入库）。剩余：串口实机（装 com0com 或换空闲端口 + 环回线）。 |
| 2026-11-05 | #179 自动补全实现（本轮）：新增 `terminal/autocompletePathModel.ts`（31 单测：路径解析、目录补 `/`、目录缓存 TTL 5s + in-flight 合并 + 失败降级、150ms 软预算 + 迟到回填）；SSH 复用当前会话 SFTP、本地走 fs、串口/Telnet 无路径 provider；多级下钻子面板（每级 240）+ 接受键状态机；浮层 400/28/240 与 h/c 徽标、目录/文件/链接图标、描述列；串口关闭 livePreview 与行替换。实测 129：`l` 历史+系统候选、`ls ` 远端目录两级下钻并接受执行；本地 CMD：`dir ` 下钻预览 `C:\Users\tianzry\.agent-browser\browsers\` 并执行输出 `chrome-146.0.7680.80`；修复本地 cwd 缺失时 `~` 拼接与 Windows 混合分隔符导致的 `无效开关`。门禁 65 文件/726 用例 + build + cargo check。未完成：Telnet 无服务端未实机、串口 COM1 占用未测、Netcatty 并排截图未做；设置项沿用已有 4 项（启用/ghost/候选浮层/来源范围）。 |
| 2026-11-05 | #180 自动补全 review 修复 + 三项验证（本轮）：子 agent review `a0c43fa` 出高危 3 / 中危 9 / 低危 4；高危全修（查询版本号竞态、迟到回填覆盖选中、接受/Esc 清空输入行），中危 6 修 + 3 部分处理（SFTP 旧句柄、根路径退化、Windows 引号、子面板自适应宽度、`←` 保留层级、空条目按键放行），低危 4 记录原因（symlink 目标类型、近似 LRU、POSIX 转义、Esc 语义）；验证中新发现 Windows 尾随 `\` 被当转义吞空格（路径候选全空）→ 加 `windows` 开关并补单测。设置热更新三开关（启用/ghost/浮层）在不关终端下逐项验证并还原，历史范围 host/global 因单主机桶无差异未单独截图；本地 Node Telnet 服务（:2325）实机验证命令候选一致、无路径 provider；与运行中的 Netcatty 129 会话实拍并合成命令候选 / 目录下拉两张三栏对比图。串口 COM1 占用，仍阻塞。门禁 65 文件/730 用例 + build + cargo check；review 修复单独提交 `ae2c362`。 |
| 2026-11-06 | #220 设置-关键字高亮完成（全局规则层）：Netcatty 取证为全局 `terminalKeywordHighlightEnabled` + `terminalKeywordHighlightRules`（另有主机级覆盖未做），规则 `{id,label,patterns,color,enabled}`、7 组内置、按行忽略大小写先规则优先、前景着色、持久化设置 JSON；termX 新增 `terminal/keywordHighlight.ts`（编译/匹配/单元格列，7 单测）+ settingsModel 默认值/normalize + 设置页分区（开关/规则列表/取色/启用/恢复/增删/弹窗实时预览/非法正则报错）+ 工具栏浮层同一份规则 + xterm marker/decoration 前景着色（80ms 去抖，订阅设置即时重绘）。129 实测：五关键字与 URL/IP 命中着色；设置改色/关规则/总开关在不重启下 8→6→8、17→0→17；重载后颜色持久；浮层 7 条与设置一致。修复初版 200 字符正则截断导致内置 IPV6/URL 失效（上限 2000 + 回归单测）。门禁 761✓/build✓/957✓/cargo build --features server✓/tauri debug✓；证据 `evidence/hl-*.png|json`。 |
| 2026-11-06 | #221 主机级关键字高亮完成：Netcatty 主机级模型为「追加」语义（`host.keywordHighlightEnabled` / `host.keywordHighlightRules`，总开关 `global\|\|host`，关开关保留规则）；后端 Profile 两字段 + schema v50（可空，NULL=跟随全局）、47 列 upsert/update、JSON 解析回落 None、≤30 条 / id·label 非空 / `#RRGGBB` / ≤16 正则×2000 字符校验；前端 `normalizeHostKeywordHighlightRules`（空=\[\] 不回落内置）、`mergeKeywordHighlightRules`、`hostKeywordHighlight` 广播，终端仅在 connected 时合并（断开回落全局），工具栏浮层与 Vault 主机编辑器双入口、保存即热更新；修 `openComposerForEdit` 读最新档案防覆盖。129 实测同输出全局主机 delta 2 / 红 217、覆盖主机 delta 4 / 品红 418，浮层改色 `#22CCCC` 青 490、关开关青 490→64、`exit` 后 COVERED span 消失，Vault 保存后色保持。门禁 767✓/build✓/960✓/server✓/tauri debug✓；证据 `evidence/hl-12..19.png`、`hl-host-verify.json`。 |
| 2026-11-06 | #222 设置页剩差清理完成：WebView2 不支持 `overflow-y: overlay`（computed 仍 auto、占 14–15px），改为 8px 自绘滚动条 + `scrollbar-gutter: stable` + `padding-right 24→31`，改前后卡片宽度 693.6→693（Δ0.6px），滚动出现/消失 `clientWidth` 恒 748（改前 742↔756 横跳 14px）；字号普查设置页全为显式 18/14/12，基准 13→16 前后计数不变（14px×161 / 12px×59 / 18px×1）→ 基准差异无观感影响，保留 13px，并把残留 13px 显式值按 Netcatty 改为 14px（`.nc-set-value` / stepper / link-btn / app-status）。门禁 767✓/build✓/960✓/server✓/tauri debug✓；证据 `evidence/set-scroll-*.png`、`settings-scroll-verify.json`。 |
| 2026-11-06 | #223 P3 收尾完成：More 菜单录制文案迁入 `terminalActionText.ts`（`terminalRecordingText`，删除死常量 `TERMINAL_MORE_TEXT.recording`，+2 单测）；OSC 7 配置对话框补 Esc 关闭（window capture + stopPropagation）。129 实测 More 菜单 5 项、录制项 `开始录制/开始录制脚本`；OSC7 打开 → Esc 关闭 → 终端仍 connected，二次 Esc 无副作用；假入口审计：设置仅 AI tab `disabled=true` 且点击不激活，占位文案命中 0；P2 #27/#28/#29/#30/#38 按 plan 暂缓且无入口，P3 独有能力（browser/ymodem/openSessionLog/插件/右键上传下载/Paste Selection/保存屏幕）不移植。门禁 769✓(70 文件)/build✓/960✓/server✓/tauri debug✓；证据 `evidence/p3-*.png`、`p3-leftovers-verify.json`、`p3-placeholder-audit.json`。 |
