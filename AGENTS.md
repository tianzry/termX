# AGENTS.md — termX 仓库导航

> **本文件是导航，不是真实来源；与代码冲突时以代码为准。**
> 行号、数量、签名都会变；不要把这里的字面量复制进 PR。每条声明都给了**核对命令**，自己跑一遍再用。
> 所有方案必须是行业规范，不走偏门；确需偏离时先与用户沟通。

---

## 项目定位

termX = **原 rssh 的 Rust 后端（Tauri 2）+ netcatty 风格的 React 前端**，目标是把 netcatty 的 SSH/终端管理能力搬到轻量桌面框架上。

- **功能基准是 netcatty 源码**（`../Netcatty` 的 `components/`、`domain/`、`application/`），**不是旧 rssh 命令表**（见 [todo.md](todo.md) 开头）。
- 迁移方案与阶段计划：[docs/netcatty-tauri-migration.md](docs/netcatty-tauri-migration.md)、[docs/plan.md](docs/plan.md)。
- Rust 底座整份复制自 rssh。**2026-11-06 已完成改名**：crate `termx` / lib `termx_lib`、GUI 二进制 `termx`、CLI `termx-cli`、headless `termx-server`；**2026-11-07 已移除 rssh → termX 旧数据迁移逻辑（未发布，无需兼容）**，只使用 `~/.termX`。看到 `rssh_*` 先核对是否遗漏。

---

## 置顶规则（违反就回滚）

## R. 前端布局和样式跟netcatty一一复刻，严格一致

移植后的软件，必须保持跟netcatty界面UI和操作逻辑一致



### R1. 前端 ↔ 后端只走 `src/backend/client.ts`

所有 `invoke` / `listen` 必须封装在 [client.ts](src/backend/client.ts)（NFC 契约，形状对齐 netcatty 的 `window.netcatty` 服务面）。组件层禁止裸调 `invoke` / `listen`，否则会绕过 base64 解码、错误解析和事件命名约定；组件里只允许 `import type { UnlistenFn }` 这类纯类型导入。

```bash
rg 'from "@tauri-apps/api/(core|event)"' src/ --glob '!src/backend/client.ts'   # 应只剩 import type
```

### R2. 事件命名 `<domain>:<event>:<instanceId>`，字节下行 base64

终端字节流下行统一走 `pty:data:<id>` / `ssh:data:<id>` / `serial:data:<id>` / `telnet:data:<id>`，payload 是 `b64_payload()`（[emitter.rs](src-tauri/src/emitter.rs)）编码的 base64 文本；**不要用 JSON number 数组下行**（IPC 体积膨胀 ~4x）。上行 `write` 走 JSON number 数组（Uint8Array → Vec&lt;u8&gt;）。不带实例 ID 后缀的全局事件会在多 tab 并存时互相串话。

```bash
rg 'format!\("(pty|ssh|serial|telnet):' src-tauri/src/commands   # 核对事件构造点
rg ':data:|:close:' src/backend/client.ts                          # 核对前端订阅点
```

### R3. invoke 参数大小写：顶层 camelCase，嵌套 struct snake_case

Tauri 自动把顶层参数 camelCase → Rust snake_case；但嵌套 struct（credential / profile）内部字段走 serde 原样 snake_case 或别名（如 `Credential.type` 是 `credential_type` 的 serde alias）。新增接口时两头各核对一遍，不要凭直觉。

### R4. 新增 command 必须注册两处：`generate_handler!` + headless dispatcher

Tauri command 写在 `src-tauri/src/commands/`，注册进 [lib.rs](src-tauri/src/lib.rs) 的 `tauri::generate_handler!`；**同一功能若要在 headless / JetBrains 可用，必须在 [server.rs](src-tauri/src/server.rs) 的 dispatcher 暴露同名 command，且直接调用相同的 `crate::db::*` / 引擎函数**（INV-4：两个适配器共用同一引擎，不允许行为分叉）。漏注册 = 那个运行时 "command not found"。

```bash
rg 'generate_handler!' src-tauri/src/lib.rs
rg '"[a-z_]+" =>' src-tauri/src/server.rs
```

### R5. 错误必须 i18n：`AppError` + `CodedMsg`，没有裸字符串逃生通道

后端所有业务错误装 `CodedMsg { code, params }`，`Display` 序列化为 `__termx_err__|{"code":...,"params":...}`（[error.rs](src-tauri/src/error.rs)）；前端 [domain/sshErrors.ts](src/domain/sshErrors.ts) 识别前缀解析。**不要在 Rust 里硬编码单一语言的用户文案**，也不要把裸 `String(e)` 展示给用户。

### R6. Secret 不进 DB 明文，只走 `secret/` 统一加密存储

调用方只能走 `SecretStore`（`src-tauri/src/secret/`，HybridStore：keychain 存 master key + ChaCha20-Poly1305 密文写 DB `secrets` 表）。不要直接读写 `secrets` 表，不要把原 secret 当 keychain value。GUI / CLI / headless 三条路径必须复用同一 store。

```bash
rg 'secret_store|SecretStore' src-tauri/src --files-with-matches
```

### R7. `db/schema.rs` 历史迁移块冻结，SCHEMA_VERSION 只增不改

`version < N` 的块（建表 / ALTER / 旧 seed）跑过就永远保持原样；要改表结构或默认数据就开新版本块、递增 `SCHEMA_VERSION`（当前 50，核对：`rg 'SCHEMA_VERSION' src-tauri/src/db/schema.rs`）。同一 version 在不同时间产出两种表结构 = 迁移不再是版本的纯函数。一次性数据迁移（搬 secret、加列回填）放 `src-tauri/src/migration/`，必须幂等，GUI / CLI / server 启动都要跑到。

### R8. Transport session 必须经过 lifecycle registry

SSH / PTY / 串口 / Telnet / SFTP / forward 的 open 路径必须先在 [commands/lifecycle.rs](src-tauri/src/commands/lifecycle.rs) 用 `resolve_session_id` 预留规范 UUID、绑定 `SessionOwner` 与 nonce，再把 handle 激活进 typed map；取消、关闭、窗口销毁、reload reconcile 都依赖这份 registry。**不要绕过它直接向 `sessions` / `pty_sessions` 等 map 插 handle**。前端在连接前就用预留 ID 订阅 `*:data:<id>`，快连接上也不会丢第一字节。

```bash
rg 'resolve_session_id|ResourceReservation|activate' src-tauri/src/commands
```

### R9. 每完成一项同步维护 todo.md + changelogs.md

工作流硬约束（[todo.md](todo.md) 维护规则、[changelogs.md](changelogs.md) 约定）：完成 → 勾选 todo 项 + 更新「进度总览」+ 在 changelogs.md 追加「修改点 + 踩坑经验」；**push 必须由用户确认**。

### R10. 不要新建"分析文档 / 实施计划归档"

临时计划用完即删。长期文档只有 `docs/` 下现有的迁移文档和 todo/changelogs，不要新增第三份过程记录。

### R11. 每次改完代码必须跑前端单元测试

任何代码改动后、交付前都要在仓库根目录跑 **`npm run test:run`**（一次性；监听模式是 `npm test`），门禁顺序：`npm run test:run` → `npm run build` / `cargo check`。改动涉及前端逻辑（domain / workspaceModel / backend 桥接层 / 组件）必须**全部测试通过**再交付；新增可测试逻辑（纯函数、invoke 封装、表单校验）要**同步补测试**。测试一律 mock `invoke` / `listen`（范式见 `src/backend/client.test.ts`），不得依赖真实网络 / SSH / Tauri 运行时；不写快照 / 像素类脆弱测试。

---

## 事实（Facts）— 文件 + 概念 + 核对命令

### 前端（React 19 + TS + xterm 6.0 + Vite）

| 概念 | 在哪 | 说明 |
|---|---|---|
| 入口 | [main.tsx](src/main.tsx) | **故意不加 `React.StrictMode`**（dev 双跑 effect 会把本地 PTY spawn 两次），主干没跑通前别恢复 |
| 应用外壳 | [App.tsx](src/App.tsx) | 根标签（Vaults / SFTP / 终端）切换、主机与分组数据、工具面板桥接 |
| 标签 + 分屏 | `Workspace.tsx` + [workspaceModel.ts](src/workspaceModel.ts) | 分屏 split/prune/ratio 是**纯函数**，放 workspaceModel；渲染在 Workspace |
| 每格会话 | `TerminalPane.tsx` | 每窗格独立会话与生命周期；连接弹窗在 `src/terminal/` |
| 纯领域逻辑 | `src/domain/` | sshErrors / connectionProgress / hostKey / timeouts / marqueeSelection——无 React、无副作用 |
| 桥接层 | [backend/client.ts](src/backend/client.ts) | invoke/listen + base64 + 类型定义（Credential/Profile/AuthOverride…），文件头注释就是契约本体 |
| 工作区恢复 | `backend/workspaceStore.ts` | localStorage key `termx.workspace.v1`，启动恢复横幅（用户确认后才重连） |
| UI 组件层 | `VaultView / HostSidebar / TopTabs / AsidePanel / SftpPanel / SerialPanel / TelnetPanel / ForwardPanel / ConnectionManager` | 只消费 client.ts 与 domain 纯函数，不放业务逻辑 |
| 样式 | `src/styles.css` | **1:1 复刻 netcatty 的配色与尺寸**，改 UI 先对照 Netcatty，不要自创视觉 |
| 单元测试 | `src/**/*.test.{ts,tsx}` + [vitest.config.ts](vitest.config.ts) | Vitest + jsdom；`npm run test:run` 一次性跑完，详见「测试现状」 |

- localStorage key 约定：`termx.<域>.v<n>`（核对：`rg 'termx\.' src/`）。新增 key 沿用此前缀与版本号后缀。
- Vite：端口 1420 / `build.target = "es2021"`（xterm 6.0 的 requestMode 用 logical assignment，降级 es2020 会丢 `let` 声明导致运行时 ReferenceError，见 [vite.config.ts](vite.config.ts) 注释）。

### 后端（src-tauri，crate 名 `termx`）

| 概念 | 在哪 | 说明 |
|---|---|---|
| GUI 二进制 `termx` | `src/main.rs` + `src/lib.rs` | lib.rs 是 setup + `generate_handler!` 总表 |
| CLI 二进制 `termx-cli` | `src/bin/termx/`，feature `cli` | **直接读写 DB / SecretStore，不经 Tauri command**；复用 `db/`、`secret/`、`sync::config` 共享函数 |
| Headless `termx-server` | `src/server_main.rs` + `src/server.rs`，feature `server` | WS JSON 协议 `{type:"invoke"/"response"/"event"}`；编译期嵌入 `../dist`，**构建前必须先 `npm run build`**；故意不放 `src/bin/`（Tauri bundler 会把 src/bin/* 自动当 app 二进制） |
| 跨宿主抽象 | [emitter.rs](src-tauri/src/emitter.rs) `Host` | Tauri 包 AppHandle / Headless 包 sink 闭包，引擎代码不感知自己跑在哪个宿主；`b64_payload()` 是字节下行的唯一定义 |
| 全局运行态 | `state.rs` `AppState` | db、secret_store、各 transport session map、auth/passphrase/host_key waiters |
| command 层 | `src/commands/` | session/pty/sftp/serial/telnet/forward/profile/group/settings/sync/discovery/plugin/lifecycle/update/window… |
| SSH 引擎 | `src/ssh/` | russh 封装：client/auth/bastion/forward/known_hosts/prompt/sftp/algorithms |
| 本地终端 | `src/terminal/` | pty（portable-pty）/ serial / telnet / recorder（会话日志） |
| 数据层 | `src/db/` | rusqlite bundled，schema.rs 迁移，按表分文件 |
| Secret | `src/secret/` | keyring（三平台原生 backend）+ 加密 DB |
| 云同步 | `src/sync/` | github / webdav / remote / config / metadata |
| AI | `src/ai/` | llm（anthropic/deepseek/protocol）、tools、session、sanitize、redact_rules、command_blacklist、skills、audit |
| 权限 | `src-tauri/capabilities/default.json` | Tauri v2 ACL，新增插件能力在这里加 |

- 数据目录与插件 asset scope 指向 `~/.termX/plugins`（tauri.conf.json）；目录不存在时启动自动创建，不再探测旧目录。

### 构建命令

```bash
npm run dev                    # Vite dev（浏览器壳，无 Rust）
npm run build                  # tsc --noEmit + vite build → ../dist
npm run test                   # Vitest 监听模式（开发时用）
npm run test:run               # 前端单元测试一次性跑完（门禁，见 R11）
npm run test:coverage          # 前端测试覆盖率（v8）
npm run tauri dev              # 本地 GUI（真机验证用这个）
npm run tauri build            # release 打包（Windows 产出 NSIS + MSI）
npm run tauri -- build --debug --no-bundle   # debug 打包门禁（不产安装器）
cargo check                    # 在 src-tauri/ 下，编译门禁
cargo test --lib               # 无 GUI 冒烟（见下）
cargo build --features cli --bin termx-cli
npm run build && cargo build --features server --bin termx-server   # 顺序不能反，dist 被嵌入
```

工作区根目录的 `../build-debug.bat` 是 Windows debug 一键脚本：检查 NASM（aws-lc-sys 依赖）、设 `CARGO_INCREMENTAL=0`（规避 rustc 增量编译 ICE）、产物在 `src-tauri/target/debug/`。

### 测试现状

- 后端有大量 `#[cfg(test)]` 单测（`rg -c '#\[cfg\(test\)\]' src-tauri/src` 核对）；关键无 GUI 冒烟：`local_pty_write_roundtrip`（PTY 回显链路）、`ssh_connect_to_local_sshd_roundtrip`（本地 sshd + 密钥认证，未设 env 时静默跳过）。
- 前端单元测试 = **Vitest 3 + jsdom**：配置在 [vitest.config.ts](vitest.config.ts)（独立于 vite.config.ts，不碰 Tauri devServer），setup 在 `src/test/setup.ts`（jest-dom 匹配器 + 每个用例后 RTL cleanup）。在**仓库根目录**执行、前置 `npm install`：`npm run test:run` 一次性 / `npm test` 监听 / `npm run test:coverage` 覆盖率。
- 前端测试范围：`src/domain/` 纯逻辑（sshErrors / sshConnectionTimeouts / hostKey / connectionProgress / vaultMarqueeSelection）、`workspaceModel.ts` 分屏树、`backend/client.ts`（mock `@tauri-apps/api` 验证 invoke 参数形状与 base64 编解码）、`backend/workspaceStore.ts`（localStorage 往返与损坏兜底）、`TerminalAuthDialog` 组件级交互。**约束（R11）**：不依赖真实网络 / SSH / Tauri 运行时，不写快照 / 像素测试；known_hosts 解析后端 Rust 已有测试，前端不重复。
- 当前门禁基线（2026-11-06）：`npm run test:run` 70 文件 / 769 用例、`npm run build`、`cargo test --lib` 960、`cargo build --features server`、`npm run tauri -- build --debug --no-bundle` 全绿；`cargo test --lib` 的 `commands::plugin::tests::local_exec_caps_output_without_breaking_the_pipe` 偶发 10s 超时（重跑通过，既有 flake）。
- 收尾验证记录：[docs/final-regression.md](docs/final-regression.md)（页面清单 / Netcatty 对照 / P1=0）、[docs/installer-verification.md](docs/installer-verification.md)（NSIS 全链路 + MSI 权限阻塞）。
- CI：`.github/workflows/release.yml`（三平台构建 + Windows 签名）。

---

## 坑（Pitfalls）— 非显然，会咬人

### P1. `termx` 字面量是跨层 wire contract，不是笔误

二进制名、crate 名、`__termx_err__` 错误前缀、事件名、`~/.termX` 数据目录、打包产物 `termx.exe` 已统一为 termX；旧 `__rssh_err__` 前缀、旧 keychain service、`rssh_backup.*` 等兼容回退已随「未发布」前提整体移除，不要再加回来。单点改名会炸另一头；再改名必须是一次专项（前后端 + 数据目录 + 打包一起）。

### P2. StrictMode 恢复 = PTY 双开

见 main.tsx 注释。同理，任何 dev 模式 effect 双跑敏感的副作用（连接、spawn、订阅）都要写成幂等。

### P3. reconcile-before-create 顺序（后端已备好，前端尚未接线）

后端 `reconcile_sessions` command 与 owner/nonce 机制已存在（lifecycle.rs），但当前前端没有任何调用点（`rg reconcile src/` 为空）。接入时必须在启动阶段先 reconcile（清掉残留 session），再放开创建新 transport；顺序反了会把刚创建的新会话当孤儿杀掉。

### P4. SFTP `FileStat.permissions` 是 u32 权限位

不是 netcatty 的 `"rwxr-xr-x"` 字符串（client.ts 注释已标注）。从 netcatty 抄 UI 代码时权限列要自己格式化。

### P5. CLI 与 headless 不走 Tauri command

改表结构、改 SecretStore key、改 sync payload 时，**同时审 `src/bin/termx/` 和 `server.rs` 两条路径**；只改 `commands/` wrapper 不会自动覆盖它们。改了同步 payload 要保证新客户端能读旧配置（单向兼容：旧→新映射，不反向冗余）。

### P6. headless 构建顺序

`termx-server` 编译期嵌入 `../dist`；先 cargo 后 npm 会得到一个打进旧前端的二进制。CI/本地都要 `npm run build` 在前。

---

## 偏好（Preferences）— 风格 / 流程

### Pr1. 命名与注释

- Rust：snake_case 函数与字段，PascalCase 类型；TS：camelCase 变量函数，PascalCase 类型与组件。
- 注释用中文，且只解释"为什么"（现有代码风格：契约、坑、决策原因都写在注释里）；不复述代码本身。
- 错误 code 用语义化 snake_case（`session_id_invalid`、`db_error`），前端按 code 渲染。

### Pr2. 分层（对齐 Netcatty 的 domain/application/infrastructure 思路）

- `src/domain/`、`workspaceModel.ts`：纯函数、无 IO、可单测。
- `src/backend/`：唯一的外部 IO 边界（invoke / listen / localStorage 恢复状态）。
- 组件层只做视图胶水；prop 列表膨胀时在 hook/上层派生 view model，不要继续 drilling。
- 后端同理：`db/`、`ssh/`、`terminal/` 是引擎；`commands/` 只做参数接线。

### Pr3. UI 改动节奏

- 对标 netcatty 的现有交互与视觉（尺寸/配色/布局），改前先读 `../Netcatty` 对应组件；未实现的功能入口置灰禁用，不要留假按钮。
- UI 改动跑 `npm run tauri dev` 实际点一遍。

### Pr4. 提交纪律

- 渐进式 > 大爆炸；一个 commit 一件事，不顺手重构无关代码。
- 分支沿用 `feat/`、`fix/`、`chore/`、`refactor/` 前缀；**禁止 force push**；不跳 hook。
- 完成一项走 R9 的 todo/changelogs 维护，**push 前由用户确认**。

### Pr5. 提交前自查

1. `npm run test:run` 通过（前端单元测试，R11：改代码必跑、新增可测试逻辑同步补测试）
2. `npm run build` 通过（tsc --noEmit 是前端静态门禁）
3. `cargo check` 通过；改了引擎跑相关 `cargo test --lib` 冒烟
4. 新增/改 command？lib.rs `generate_handler!` 与 server.rs dispatcher 两处都注册（R4）
5. 改事件名 / wire 形状？前后端 grep 同步（R2/R3），并审 CLI 路径（P5）
6. 改 schema？只开新版本块（R7），审 sync import/export
7. 改 UI？`tauri dev` 实际点，对照 netcatty

---

## 不要做的事（速查）

- 在组件里裸调 `invoke` / `listen`（R1）
- 用 JSON number 数组下行传终端字节（R2）
- 在 Rust 里硬编码单一语言用户文案（R5）
- 直接读写 `secrets` 表 / 绕过 SecretStore（R6）
- 修改 `schema.rs` 历史迁移块、复用旧 version 号（R7）
- 绕过 lifecycle registry 直接插 session handle（R8）
- 恢复 StrictMode（P2）
- 新建分析/计划归档文档（R10）
- 跳过 `npm run test:run` 交付前端逻辑改动、新增可测试逻辑不补测试（R11）
- 擅自把 `termx` 命名再"顺手"改成别的名字，或重新引入 rssh 旧数据/钥匙串/环境变量/备份文件名的兼容回退（P1）
- 自创 UI 视觉而不对标 netcatty（Pr3）
