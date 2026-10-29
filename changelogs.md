# termX 开发日志（changelogs）

> 约定：每次开发修改后，先把「修改点 + 踩坑经验」记录到这里，再由用户确认后才 push 到 termX 仓库。

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