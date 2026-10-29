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