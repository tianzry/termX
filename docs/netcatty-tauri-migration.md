# netcatty → Tauri 2 + Rust 迁移方案

> 目标：保留 netcatty 的功能与交互体验，将桌面框架从 Electron 替换为 Tauri 2、后端语言从 Node.js 替换为 Rust，从而显著降低编译产物体积与运行时资源占用。

---

## 1. 背景与目标

### 1.1 背景
netcatty 是一个功能丰富的 SSH/终端管理器，当前技术栈为：

- **桌面框架**：Electron
- **前端**：React 19 + TypeScript + Vite
- **后端**：Node.js（主进程 + 100+ bridge 模块）
- **关键库**：`ssh2`、`node-pty`、`ssh2-sftp-client`、`serialport`、`zmodem.js`、`webdav`、`electron-updater`、MCP SDK、多家 AI SDK

### 1.2 目标
1. 桌面框架迁移到 **Tauri 2**，后端语言迁移到 **Rust**。
2. **前端与功能尽量保持与 netcatty 一致**（保留 React UI 与既有交互）。
3. 实现 netcatty **大部分功能**与接近/更优的**性能**。
4. **显著减小**编译产物体积与运行时内存开销。

### 1.3 参考实现
[rssh](https://github.com/rssh-org/rssh) 是一个同类的 Tauri 2 + Rust 终端管理器，其后端已用 Rust 实现了 SSH/SFTP/PTY/串口/Telnet/端口转发/凭据存储/AI/云同步等能力，可作为本次迁移的底座与技术参照。

---

## 2. 现状架构分析

### 2.1 netcatty（Electron）

```
netcatty/
├── electron/                 # Electron 后端（Node.js）
│   ├── main.cjs              # 主进程入口
│   ├── preload.cjs           # contextBridge 暴露给渲染进程的 API
│   ├── launch.cjs            # 开发启动
│   ├── cli/                  # 命令行工具
│   ├── bridges/              # 100+ 业务桥接模块
│   │   ├── sshBridge.cjs     # SSH 连接（ssh2）
│   │   ├── sftpBridge.cjs    # SFTP（ssh2-sftp-client）
│   │   ├── terminalBridge.cjs# 本地终端（node-pty）
│   │   ├── portForwardingBridge.cjs
│   │   ├── credentialBridge.cjs
│   │   ├── fidoAgentManager.cjs  # FIDO/WebAuthn
│   │   ├── cloudSyncBridge.cjs   # 云同步 + OAuth
│   │   ├── autoUpdateBridge.cjs
│   │   ├── aiBridge.cjs      # AI
│   │   └── ...               # MCP、串口、ZMODEM、Mosh 等
│   ├── mcp/                  # MCP
│   ├── plugins/              # 插件系统
│   ├── capabilities/         # 能力/工具
│   └── terminalWorker/       # 终端 Worker
├── application/              # 前端应用层（状态、i18n）
├── components/               # React UI 组件
├── domain/                   # 领域逻辑（含 CRDT 同步，纯 TS）
├── infrastructure/           # 基础设施（AI/config/monaco/persistence）
├── lib/                      # 工具
├── packages/                 # 插件 SDK/CLI
├── index.tsx / App.tsx       # 前端入口
└── package.json
```

**依赖 Node/Electron 专属能力的点**：`node-pty`（PTY）、`ssh2`（SSH）、`serialport`（串口）、`child_process`、`electron-updater`、`contextBridge`/`ipcMain`、系统托盘/全局快捷键、Windows Hello 系统认证、macOS Local Network 权限等。

### 2.2 rssh（Tauri 参考实现）

```
rssh/src-tauri/src/
├── ssh/                      # russh 封装：client/auth/bastion/forward/known_hosts/prompt/sftp
├── terminal/                 # pty/serial/telnet/recorder
├── secret/                   # 凭据存储（keyring + DB + hybrid）
├── sync/                     # 云同步（github/webdav/remote）
├── ai/                       # AI（anthropic/deepseek/工具/skills)
├── db/                       # SQLite 数据层（profile/credential/secret/settings...）
├── commands/                 # #[tauri::command] 暴露层：session/sftp/pty/serial/telnet/forward...
├── models.rs / state.rs / emitter.rs / error.rs
└── Cargo.toml               # russh、tokio、portable-pty、serialport4、russh-sftp、reqwest
```

**关键模式**：每个后端能力经 `#[tauri::command]`（`src-tauri/src/commands/*.rs`）暴露，前端通过 `invoke(...)` 调用；流式数据（终端输出等）通过 Tauri `emit`/`listen` 事件推送。

---

## 3. 目标架构

```
┌─────────────────────────────────────────────────────────┐
│                  前端（保留 netcatty）                     │
│        React 19 + TypeScript + Vite                       │
│   application / components / domain / infrastructure      │
│             （复用 netcatty 现有 UI 与领域逻辑）             │
└───────────────────────────┬─────────────────────────────┘
                            │ invoke / listen（@tauri-apps/api）
┌───────────────────────────▼─────────────────────────────┐
│              Tauri 2 运行时（薄壳）                        │
│   窗口管理 / 事件 / updater / 系统能力（托盘、快捷键等）      │
└───────────────────────────┬─────────────────────────────┘
                            │ #[tauri::command] / emit
┌───────────────────────────▼─────────────────────────────┐
│                  Rust 后端（核心）                         │
│   复用 rssh：ssh / terminal / secret / sync / ai / db      │
│   新增：netcatty 差异化能力（见 §5 矩阵）                   │
│   SSH=russh  PTY=portable-pty  SFTP=russh-sftp            │
│   串口=serialport4  配置=SQLite                            │
└─────────────────────────────────────────────────────────┘
```

要点：
- **前端框架不变**（React），仅替换「调用后端」的接线层。
- **后端全部落到 Rust**，不再有 Node.js/Electron 主进程。
- **rssh 的 Rust 后端作为起点**，逐项补齐 netcatty 差异化功能。

---

## 4. 技术映射（Electron → Tauri）

| Electron | Tauri 2 + Rust |
|----------|----------------|
| `ipcMain.handle(channel, handler)` | `#[tauri::command] async fn ...` |
| `contextBridge.exposeInMainWorld`（preload） | `@tauri-apps/api` 的 `invoke('cmd', args)` |
| `ipcRenderer.send` / `ipcMain.on` | `emit` / `app.listen`（事件系统） |
| `webContents.send`（主→渲染） | `emit`（按窗口/事件名广播） |
| `BrowserWindow` / `Tray` / `globalShortcut` | `WebviewWindow` / `TrayIcon` / `GlobalShortcut`（Tauri 插件） |
| `node-pty`（PTY） | `portable-pty` |
| `ssh2`（SSH） | `russh` |
| `ssh2-sftp-client`（SFTP） | `russh-sftp` |
| `serialport`（串口） | `serialport4` |
| `electron-updater` | `tauri-plugin-updater` |
| `keytar` / 系统钥匙串 | `keyring` crate / Secret Service / Credential Manager |
| `child_process` / `execFile` | `tokio::process::Command` |
| `fs` 文件访问 | `rfd` + `tokio::fs` / `tauri-plugin-fs` |
| 剪贴板 | `tauri-plugin-clipboard-manager` |
| 通知 | `tauri-plugin-notification` |

---

## 5. 后端能力迁移矩阵

> 复用优先级：✅ 直接复用 rssh · 🔶 复用 rssh 但需扩展 · ⛔ 需从零用 Rust 实现

| 能力 | netcatty 当前实现 | rssh Rust 现状 | 迁移策略 |
|------|------------------|----------------|---------|
| SSH 连接/认证 | sshBridge + `ssh2` | `ssh/`（russh）✅ | 复用，补齐交互式认证细节 |
| 本地终端 PTY | `node-pty` | `terminal/pty.rs` ✅ | 复用 |
| SFTP 文件传输 | `ssh2-sftp-client` | `ssh/sftp.rs` ✅ | 复用 |
| 串口 | `serialport` | `terminal/serial.rs` ✅ | 复用 |
| Telnet | 自研 | `terminal/telnet.rs` ✅ | 复用 |
| 端口转发（本地/远程/动态） | portForwardingBridge | `ssh/forward.rs` 🔶 | 复用，补齐 socks5 动态转发 |
| X11 转发 | x11Forwarding | 部分（forward）🔶 | 扩展 |
| 凭据/密钥存储 | credentialBridge + keytar | `secret/` ✅ | 复用 |
| 配置持久化 | 各 store | `db/`（SQLite）✅ | 复用，对齐 schema |
| AI 助手 | aiBridge + MCP SDK | `ai/`（多 LLM）🔶 | 复用框架，补齐 Provider/工具 |
| 云同步 | cloudSyncBridge + OAuth | `sync/`（github/webdav）🔶 | 扩展 Google/OneDrive OAuth |
| 自动更新 | `electron-updater` | tauri-plugin-updater 🔶 | 用官方插件 + 签名通道 |
| 片段/高亮/分组 | 各 store | `db/`（snippet/highlight/group）✅ | 复用 |
| 会话日志/录制 | sessionLogsBridge | `terminal/recorder.rs` ✅ | 复用 |
| CRDT 同步 | `domain/convergentSync` | ⛔ 前端纯逻辑可复用 | 前端保留，后端仅落盘 |
| **FIDO/WebAuthn 密钥** | fidoAgent 系列 | ⛔ 无 | 新增 `fido2`/`yubikey` crate |
| **Windows Hello/系统锁** | windowsHelloHelper/appLock | ⛔ 无 | 新增（biometric / 自研） |
| **ZMODEM/YMODEM** | `zmodem.js`/ymodem | ⛔ 无 | 新移植 Rust 实现 |
| **Mosh 协议** | moshHandshake | ⛔ 无 | 视优先级，暂缓或第三方 |
| **MCP Server** | mcpServerBridge + `@modelcontextprotocol/sdk` | ⛔ 无（仅消费方工具） | 新增 Rust MCP server |
| **插件系统** | packages/plugin-contract⁄sdk⁄cli | ⛔ 无 | 需重新设计（§7.4） |
| 网络代理（HTTP/SOCKS） | httpNetworkProxyAgent | 部分（reqwest proxy）🔶 | 统一走 reqwest/`hyper` |
| S3 上传 | `@aws-sdk/client-s3` | ⛔ 无 | `aws-sdk-s3` Rust 或 `rust-s3` |
| SSH Agent | systemSshAgent | `ssh/auth.rs` 部分 🔶 | 扩展 `russh` agent 支持 |
| PPK 私钥转换 | ppkConverter | ⛔ 无 | 新增 `.ppk` 解析 |
| TOTP | totpBridge | `totp` crate | 新增轻量实现 |

---

## 6. 前端迁移策略（保留 React）

Tauri 不绑定前端框架，netcatty 的 React 前端可整体保留。迁移范围仅限「接线层」：

1. **保留**：`components/`（UI）、`domain/`（纯领域逻辑，含 CRDT）、`application/`（状态/i18n）、`lib/`。
2. **改造 `infrastructure/`**：其中依赖 `window.*`（Electron preload 暴露的 API）的服务，改为调用 `@tauri-apps/api` 的 `invoke`.
3. **统一封装**：建一层 `backend/client.ts`，把 `invoke('命令名', 参数)` 按现有 service 接口封装，使上层逻辑几乎无感。

示例改造：

```ts
// 改造前（Electron preload 暴露）
const sessions = await window.netcatty.ssh.connect(profile);

// 改造后（Tauri invoke）
import { invoke } from "@tauri-apps/api/core";
const sessions = await invoke("ssh_connect", { profile });
```

4. **流式数据**：终端输出/事件由 `ipcRenderer.on` 改为 `listen('pty:data', handler)`，其余逻辑不变。
5. **目录结构**：前端保持 netcatty 的 `application/components/domain/infrastructure` 分层，整体搬入 Tauri 项目的前端目录，`index.html` 入口改为 Tauri 的 `index.html`。

---

## 7. 分阶段实施计划

### 阶段 0：脚手架搭建（POC）
- 以 rssh 的 `src-tauri` 为 Rust 底座，接入 netcatty 的 React 前端（Vite）。
- 跑通：`SSH 连接` + `本地终端 PTY` 两条最小链路。
- 验收：能登录远程主机、渲染终端输出、本地 shell 可用。

### 阶段 1：核心终端链路
- 迁移 SSH/SFTP/PTY/串口/Telnet/端口转发。
- 对齐 rssh 与 netcatty 的 session/命令事件约定。
- 验收：核心终端可用（连接、交互、文件传输、隧道）。

### 阶段 2：数据与凭据
- 迁移配置/分组/片段/高亮/凭据/会话日志到 `db/` + `secret/`。
- 确保数据可迁移（新旧 schema 映射）。

### 阶段 3：平台与体验能力
- 托盘、全局快捷键、剪贴板、通知、自动更新、文件拖拽/监听。
- Windows Hello / Mac 系统锁、FIDO 密钥（高优先级安全项）。

### 阶段 4：高级能力
- AI/MCP、云同步（含 OAuth）、ZMODEM/YMODEM、SSH Agent、PPK、TOTP、S3。
- 插件系统重新设计（考虑以 Tauri sidecar 或 WASM 承载插件运行时）。

### 阶段 5：打磨与发布
- 性能/内存压测、三平台打包（msi/nsis/dmg/deb/AppImage）、签名、自动更新通道。

---

## 8. 体积与资源占用优化（目标收益）

| 指标 | Electron | Tauri 2 + Rust（预期） |
|------|----------|------------------------|
| 安装包体积 | 80–150 MB（含 Chromium + Node） | 8–20 MB |
| 运行时内存 | 300–800 MB（多进程） | 80–200 MB |
| 进程模型 | 主进程 + 渲染进程 + GPU 进程 | 1 个系统 WebView + 轻量 Rust 进程 |
| 启动时间 | 较慢 | 更快 |
| 后端语言 | JS（JIT） | Rust（原生，无 GC 停顿） |

**注意**：Tauri 复用系统 WebView（Windows=WebView2，macOS=WKWebView，Linux=WebKitGTK），终端渲染若使用 xterm.js + WebGL，仍需衡量渲染层性能；Rust 后端对高吞吐终端 I/O 与并发会话通常更省资源。

---

## 9. 主要风险与难点

1. **FIDO/Windows Hello/Mosh/MCP Server/插件系统**：netcatty 独有且无现成 Rust 等价实现，是最大工作量与风险点。
2. **`node-pty` → `portable-pty` 行为差异**：终端尺寸/信号/编码等边界行为需逐一回归。
3. **`ssh2` → `russh` 能力差异**：算法、kex、交互式问答等需对齐（rssh 已覆盖大半）。
4. **ZMODEM/YMODEM** 需 Rust 移植，涉及二进制协议，风险较高。
5. **插件运行时**：Electron 下插件可依赖 Node 运行时，Tauri 需重新选定插件宿主（sidecar/WASM），对第三方插件生态有影响。
6. **交叉编译限制**：Tauri 各平台需对应平台构建（Windows 需 MSVC+WebView2，mac 需 macOS），需在 CI 中矩阵构建。
7. **数据迁移**：存量用户配置/密钥需平滑迁移到新的 SQLite + keyring 方案。

---

## 10. 验收标准（迁移完成定义）

- [ ] 三平台（Windows/macOS/Linux）Tauri 安装包可构建并支持自动更新。
- [ ] 核心能力对齐：SSH/SFTP/PTY/串口/Telnet/端口转发/凭据存储/配置。
- [ ] 高级能力按阶段清单完成，标注暂缓项（Mosh 等）。
- [ ] 前端 UI 与交互与 netcatty 保持一致（保留 React + 既有组件）。
- [ ] 安装包体积下降 ≥ 60%，运行时内存下降 ≥ 50%。
- [ ] 既有用户数据可平滑迁移，无数据丢失。
- [ ] 关键链路有自动化回归测试（连接/终端/文件传输）。

---

## 附录：参考文件位置

- netcatty Electron 入口：`electron/main.cjs`、`electron/preload.cjs`、`electron/main/registerBridges.cjs`
- netcatty 前端分层：`application/`、`components/`、`domain/`、`infrastructure/`、`lib/`、`packages/`
- rssh Rust 后端：`src-tauri/src/`（`ssh/`、`terminal/`、`secret/`、`sync/`、`ai/`、`db/`、`commands/`）
- rssh 依赖清单：`src-tauri/Cargo.toml`