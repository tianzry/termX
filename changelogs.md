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