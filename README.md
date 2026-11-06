# termX

termX 是一个基于 **Tauri 2 + React 19 + xterm** 的轻量桌面终端与连接管理器：SSH / SFTP / Telnet / 串口 / 本地 PTY 统一在一个窗口，配套 Vault（主机、分组、钥匙串、代理、端口转发）、主机监控、脚本/片段、笔记、会话日志、已知主机与云同步。界面与交互对标 Netcatty，Rust 后端源自 rssh。

## 环境要求

- Node.js 20+（`npm`）
- Rust stable（含 `cargo`）
- Windows 10/11（WebView2 运行时；NSIS / MSI 打包仅 Windows）
- 可选：本地 `sshd` 用于无 GUI 的 SSH 冒烟测试（未设置测试环境变量时自动跳过）

## 快速开始

```bash
npm install
npm run tauri dev        # 启动桌面应用（真机联调用这个）
npm run dev              # 仅前端 Vite（端口 1420，浏览器壳，无 Rust）
```

## 构建与打包

```bash
npm run build            # tsc --noEmit + vite build → dist/
npm run tauri -- build   # release 打包：Windows 同时产出 NSIS 与 MSI
```

- NSIS：`src-tauri/target/release/bundle/nsis/termX_<ver>_x64-setup.exe`（per-user，安装到 `%LOCALAPPDATA%\termX`）
- MSI：`src-tauri/target/release/bundle/msi/termX_<ver>_x64_en-US.msi`（per-machine，安装需管理员）
- 安装包实测记录见 [docs/installer-verification.md](docs/installer-verification.md)

其它二进制（开发/服务端）：

```bash
cargo build --features cli    --bin termx-cli      # 命令行（src-tauri/ 下执行）
npm run build && cargo build --features server --bin termx-server   # 顺序不能反：dist 会被嵌入二进制
```

## 数据目录

- 桌面端数据在 **`~/.termX`**：`termx.db`（SQLite，WAL）、`snippets.json`、`recordings/`、`plugins/`。
- 首次启动自动从旧 `~/.rssh` 迁移：同卷优先原子重命名，跨卷退化为复制→删除；若 `~/.termX` 已存在则以新目录为准、旧目录原样保留。迁移结果在 **设置 → 系统** 展示（表/行/录制数量、旧目录是否清理）。
- 卸载**不会删除** `~/.termX`（用户数据不属于安装产物）；旧版远端同步备份文件名 `rssh_backup.*` 刻意保留，改名不导致既有云备份“消失”。

## 测试与门禁

```bash
npm run test:run         # 前端单元测试（Vitest + jsdom，一次性）
npm run build            # 前端静态门禁（tsc --noEmit）
cd src-tauri && cargo test --lib          # Rust 单元/冒烟测试
cd src-tauri && cargo build --features server
npm run tauri -- build --debug --no-bundle
```

当前基线（2026-11-06）：前端 70 文件 / 769 用例；Rust lib 960；`npm run build`、`cargo build --features server`、debug 打包均通过。

## 已知边界

- AI 助手未移植（设置 → AI 保留 tab 但 disabled）。
- 「软件更新」仅支持检查新版本；下载/安装置灰（缺签名公钥、endpoint、CI 产物）。
- MSI 安装/卸载需管理员提权，测试环境未做 UAC 自动提权。
- 仍需人工确认：真实 CA 证书握手、Windows ssh-agent 转发、真实串口设备回环、原生文件对话框。详见 [docs/final-regression.md](docs/final-regression.md#等级结论)。

## 文档

- [AGENTS.md](AGENTS.md)：仓库导航、硬性规则与门禁
- [todo.md](todo.md)：移植进度与已完成项
- [changelogs.md](changelogs.md)：每轮改动与踩坑
- [docs/rename-rssh-termx.md](docs/rename-rssh-termx.md)：rssh → termX 改名盘点与实际落地
- [docs/final-regression.md](docs/final-regression.md)、[docs/installer-verification.md](docs/installer-verification.md)：最终回归 / 安装包验证
