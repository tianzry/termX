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
