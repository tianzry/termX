# netcatty → Tauri 2 + Rust 基本功能移植计划

> 本文档是 [netcatty-tauri-migration.md](./netcatty-tauri-migration.md) 的可执行落地计划。
> 范围：先完成「基本功能」移植；FIDO / Windows Hello / Mosh / MCP / 插件系统 **暂缓**。

---

## 1. 目标与范围

### 1.1 目标
- 前端 **React 保持不变**（复用 netcatty 的 `application/components/domain/infrastructure`）。
- 后端 **全部 Rust**（复用 rssh 底座），不再依赖 Node.js/Electron。
- 对齐 netcatty 基本功能与行为，先跑通核心链路再逐步扩大覆盖。

### 1.2 本次范围（基本功能）
| 类别 | 能力 |
|------|------|
| 连接 | SSH、串口（Serial）、Telnet |
| 终端 | 本地 PTY、远程 shell、resize、信号 |
| 文件 | SFTP 上传/下载/目录/权限 |
| 网络 | 端口转发（本地/远程/动态 SOCKS） |
| 数据 | 配置 / 分组 / 片段 / 高亮 / 凭据存储 / 会话日志 |
| 桌面 | 系统托盘、全局快捷键、剪贴板、通知、自动更新 |

### 1.3 本次暂缓（不实现）
- ❌ FIDO / WebAuthn 密钥
- ❌ Windows Hello / 系统锁（appLock）
- ❌ Mosh 协议（含 MoshCatty 集成）
- ❌ MCP Server
- ❌ 插件系统（plugin-contract/sdk/cli）

> 注：AI、云同步属「基本功能之外的增强」，若与 MCP 强耦合则随 MCP 一并延后，纯 LLM 调用部分可后续单独排期。

---

## 2. 技术定位

```
前端：netcatty React 不变（仅改接线层 window.* → invoke）
后端：全部 Rust（复用 rssh 底座）
  ├─ SSH        → russh
  ├─ 本地终端    → portable-pty
  ├─ SFTP       → russh-sftp
  ├─ 串口        → serialport4
  ├─ Telnet     → rssh terminal/telnet
  ├─ 端口转发    → rssh ssh/forward
  ├─ 凭据/密钥   → rssh secret/
  └─ 配置/数据   → rssh db/（SQLite）
```

关键映射：
- `ipcMain.handle` → `#[tauri::command]`
- `contextBridge`（preload） → `@tauri-apps/api` 的 `invoke`
- `ipcRenderer.on` / `webContents.send` → Tauri `emit` / `listen`
- `node-pty` / `ssh2` / `ssh2-sftp-client` / `serialport` → 上表 Rust crate

---

## 3. 分阶段计划

### 阶段 0：脚手架 + 最小可运行链路（POC）
**目标**：跑通「Rust 后端 + React 前端 + Tauri 2」闭环。

工作项：
- 以 rssh `src-tauri` 为 Rust 底座，接入 netcatty React 前端（Vite）。
- 建立前端后端调用封装层 `backend/client.ts`（统一 `invoke`）。
- 打通两条最小链路：`SSH 连接` + `本地终端 PTY`。

**验收**：
- [ ] 能成功 SSH 登录远程主机并渲染终端输出
- [ ] 本地 shell（PTY）可用，支持 resize
- [ ] 前端无需 Electron preload 即可运行

### 阶段 1：核心传输链路
**目标**：补齐 SSH 会话与文件传输的完整能力。

工作项：
- SSH：密码/公钥/keyboard-interactive 认证、shell/exec、交互式问答、known_hosts 处理。
- PTY：输出流回传、进程生命周期、退出状态、信号发送。
- SFTP：`sftp_connect` 及上传/下载/目录/权限/断点。
- 前后端事件流对齐（`pty:data`、`sftp` 进度等）。

**验收**：
- [ ] 三种认证方式均可连接
- [ ] 远程命令执行与交互式 shell 稳定
- [ ] SFTP 上传下载不丢数据、权限正确

### 阶段 2：连接类型 + 网络隧道
**目标**：扩展串口、Telnet 与端口转发。

工作项：
- 串口：借用 rssh `terminal/serial.rs`，对齐 rescan/open/波特率/流控。
- Telnet：复用 rssh `terminal/telnet.rs`，对齐登录脚本。
- 端口转发：本地/远程/动态（SOCKS5），复用并扩展 rssh `ssh/forward.rs`（动态转发需补齐）。

**验收**：
- [ ] 串口、Telnet 可正常连接交互
- [ ] 三类端口转发均可建立并转发流量

### 阶段 3：数据与凭据
**目标**：持久化配置与安全存储凭据。

工作项：
- 配置/分组/片段/高亮 → rssh `db/`（SQLite），对齐 schema。
- 凭据/密钥 → rssh `secret/`（keyring + DB 混合存储）。
- 会话日志/录制 → rssh `terminal/recorder.rs`。
- **数据迁移**：netcatty 旧数据 → 新 SQLite + keyring 的映射与导入。

**验收**：
- [ ] 配置重启后正确恢复
- [ ] 密钥不落明文，可安全读取
- [ ] 存量数据可迁移、无丢失

### 阶段 4：桌面体验
**目标**：补齐桌面集成能力。

工作项：
- 系统托盘（TrayIcon）、全局快捷键（GlobalShortcut）。
- 剪贴板（clipboard-manager）、通知（notification）。
- 自动更新（tauri-plugin-updater）与签名通道。
- 文件拖拽 / 监听（需要时引入 `tauri-plugin-fs`/drag）。

**验收**：
- [ ] 托盘菜单、全局快捷键可用
- [ ] 剪贴板、通知正常
- [ ] 更新通道可发布并检测

### 阶段 5：打磨与发布
**目标**：达到可发布质量。

工作项：
- 性能/内存压测（对照 netcatty 基准）。
- 三平台打包（Win msi/nsis、mac dmg、Linux deb/AppImage）+ 签名。
- 行为对齐回归（xterm 渲染一致性、边界 case）。
- CI 矩阵构建（Windows/macOS/Linux）。

**验收**：
- [ ] 安装包体积显著下降（目标 ≥ 60%）
- [ ] 运行时内存下降（目标 ≥ 50%）
- [ ] 关键链路自动化回归测试通过

---

## 4. 前端迁移策略（贯穿各阶段）

- **保留**：`components/`、`domain/`（纯领域逻辑）、`application/`、`lib/`。
- **改造**：`infrastructure/` 中依赖 `window.*` 的服务 → `invoke('命令名', 参数)`。
- **统一封装**：一个 `backend/client.ts` 承接既有 service 接口，上层业务无感。

```ts
// 改造前（Electron preload）
const s = await window.netcatty.ssh.connect(profile);
// 改造后（Tauri invoke）
const s = await invoke("ssh_connect", { profile });
```

---

## 5. 里程碑（按顺序）

| 里程碑 | 对应阶段 | 完成标志 |
|--------|---------|---------|
| M0 | 阶段 0 | POC 可运行 |
| M1 | 阶段 1 | 核心终端的 SSH/SFTP 可用 |
| M2 | 阶段 2 | 串口/Telnet/端口转发可用 |
| M3 | 阶段 3 | 数据与凭据可持久化 |
| M4 | 阶段 4 | 桌面集成能力齐全 |
| M5 | 阶段 5 | 达到发布标准 |

---

## 6. 主要风险

1. **`ssh2` → `russh` 算法/兼容性差异**：需对齐算法集与交互式认证（rssh 已有 `ssh/algorithms.rs`、`auth.rs` 封装）。
2. **`node-pty` → `portable-pty` 边界行为**：resize/编码/信号需逐一回归。
3. **xterm 渲染一致性**：决定"对齐 netcatty 行为"的成败，需在阶段 5 专项回归。
4. **数据迁移**：旧 schema 与凭据格式平滑迁移有落数据风险，需备份 + 校验。
5. **动态 SOCKS 转发**：rssh `forward.rs` 需扩展，是阶段 2 的技术难点。

---

## 7. 依赖与前置

- 复用 rssh 的 Rust 后端（`src-tauri/src`）作为起点，保持其模块边界。
- 参考 rssh 的 `ssh/client.rs`（worker + `LocalSet` 隔离模型）处理异步 SSH。
- 前端依赖当前 netcatty 仓库的 React 分层，不改 UI 结构。

---

## 附：文档关联

- 总体迁移方案（含能力矩阵、Electron→Tauri 映射）：[netcatty-tauri-migration.md](./netcatty-tauri-migration.md)