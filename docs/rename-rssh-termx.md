# rssh → termX 标识改名盘点（2026-11-06）

> **现状（2026-11-07）：改名已落地，旧数据迁移逻辑已整体移除（未发布，无需兼容）。**
> `~/.rssh` 探测、`data_dir_migration` 模块与锁文件、钥匙串 `rssh` service 双读/懒回写与 `rssh_master_key_v1` 回退、`RSSH_*` 环境变量旧名回退、`__rssh_err__` 解码、设置页迁移报告、远端 `rssh_backup.*` 文件名均已删除；数据目录固定 `~/.termX`（不存在时自动创建），远端备份改 `termx_backup.*`。
> 以下为当时的盘点与方案记录，保留用于追溯。

> 本轮只盘点，不改代码。扫描范围：`g:\AiCode\termX\termX` 全仓（`git grep -i rssh`，含 `src-tauri` / `src` / 配置 / 文档 / 构建脚本）+ 工作区级 `build-debug.bat` / `.launch-termx.vbs` + `g:\AiCode\termX\evidence` 取证脚本。
> 参考仓库 `g:\AiCode\termX\Netcatty` 不在改名范围。
>
> 统计：仓库内 **73 个文件 / 640 处**；`evidence/` **25 个文件 / 60 处**（历史取证，默认保留）。

## 1. 分类清单

### ① 产品 / 界面显示名

| 位置 | 现状 | 改为 |
|---|---|---|
| `src-tauri/src/commands/window.rs:149` | 新窗口标题 `"RSSH"` | `"termX"` |
| `src-tauri/src/ai/session.rs:1653` | AI 本地分析窗口 `"RSSH — Local Analysis"` | `"termX — Local Analysis"` |
| `src-tauri/src/bin/rssh/main.rs:32` | clap `about = "RSSH — SSH connection manager"` | `"termX — SSH connection manager"` |
| `src-tauri/Info.ios.plist:6` | 局域网用途说明 `RSSH uses your local network…` | `termX uses your local network…` |
| `src-tauri/src/ai/audit.rs:123` | 审计文件头 `# rssh AI 排障审计` | `# termX AI 排障审计` |
| `src-tauri/src/secret/mod.rs:137` | 错误提示「然后重启 rssh」 | 「然后重启 termX」 |
| `src-tauri/src/bin/rssh/commands/*.rs`（10 文件，约 110 行） | 帮助/示例/提示里的 `rssh profile list`、`rssh config …` 等 | 统一 `termx …` |
| `src-tauri/src/commands/cli.rs:174` 等 | 状态展示中的版本/命令示例 | `termx …` |

### ② crate / 包名

| 位置 | 现状 | 改为 |
|---|---|---|
| `src-tauri/Cargo.toml:2` | `package.name = "rssh"` | `termx` |
| `src-tauri/Cargo.toml:8` | `lib.name = "rssh_lib"` | `termx_lib` |
| `src-tauri/Cargo.lock:5112` | 锁定包名 `rssh` | 随 Cargo 重新生成 |
| `src-tauri/src/**`（10 文件 / 32 处） | `use rssh_lib::…` | `use termx_lib::…` |
| `src-tauri/tests/totp_mock.rs:4` | `rssh_lib` | `termx_lib` |
| `package.json` | 已是 `termx` | 不改 |

### ③ 二进制 / 命令名

| 位置 | 现状 | 改为 |
|---|---|---|
| `src-tauri/Cargo.toml:5` | `default-run = "rssh"` | `termx` |
| `src-tauri/Cargo.toml:149-164` | `[[bin]] rssh` / `rssh-cli` / `rssh-server` | `termx` / `termx-cli` / `termx-server` |
| `src-tauri/src/commands/cli.rs:26` | 安装目录 `Programs/rssh` | `Programs/termx` |
| `src-tauri/src/commands/cli.rs:34-36` | 已安装命令名 `rssh` / `rssh.exe` | `termx` / `termx.exe` |
| `src-tauri/src/commands/cli.rs:64,72-74` | 随包二进制 `rssh-cli(.exe)`、cargo bin 回退 | `termx-cli(.exe)` |
| `src-tauri/src/server_main.rs:1,16,23` | `rssh-server` 日志/注释 | `termx-server` |
| `src-tauri/src/bin/rssh/`（目录名） | `bin/rssh` | `bin/termx`（仅内部路径，Cargo `path` 同步） |
| `src-tauri/src/bin/rssh/main.rs:326-328` | `_RSSH_COMPLETE` / `.bin("rssh")` | `_TERMX_COMPLETE` / `.bin("termx")` |
| `src-tauri/src/commands/cli.rs:306` | PowerShell 补全 `-CommandName rssh` | `termx` |
| 工作区 `build-debug.bat:73`、`.launch-termx.vbs:1` | 指向 `target/debug/rssh.exe` | `termx.exe` |
| `AGENTS.md:147-148`、`docs/*` 构建命令 | `--bin rssh-cli`、`rssh-server` | `termx-cli`、`termx-server` |

### ④ 运行目录 / 配置路径

| 位置 | 现状 | 改为 |
|---|---|---|
| `src-tauri/src/db/mod.rs:174-184` | `data_dir()` → `~/.rssh` | `~/.termX`（带迁移，见 §3） |
| `src-tauri/src/db/mod.rs:69` | DB 文件 `rssh.db` | `termx.db`（带迁移） |
| `src-tauri/src/db/mod.rs:167,179` | 文档/错误提示里的 `~/.rssh` | `~/.termX` |
| `src-tauri/tauri.conf.json:35` | 插件 asset scope `$HOME/.rssh/plugins/**` | `$HOME/.termX/plugins/**` |
| `src-tauri/src/commands/settings.rs:180` | 录制目录注释 `~/.rssh/recordings` | `~/.termX/recordings`（派生路径，随目录迁移） |
| `src-tauri/src/ai/audit.rs:4` | 默认审计文件名 `rssh-diagnose-<session>-<ts>.log` | `termx-diagnose-…` |
| `src-tauri/src/ai/session/file_ops.rs:810` | 远端临时文件后缀 `.rssh-<suffix>` | `.termx-<suffix>` |
| `src-tauri/src/ai/tools.rs:87`、`prompts/general.md:108-109` | 示例路径 `/tmp/rssh-heap-*` | `/tmp/termx-heap-*` |
| `src-tauri/src/sync/github.rs:10-11` | 远端备份 `rssh_backup.json` / `.meta.json` | **保留**（见 §6） |
| `src-tauri/src/sync/webdav.rs:11-12` | 远端备份 `rssh_backup.enc` / `.meta.json` | **保留**（见 §6） |

### ⑤ 钥匙串服务名 / secret 前缀

| 位置 | 现状 | 改为 |
|---|---|---|
| `src-tauri/src/secret/mod.rs:79` | `SERVICE = "rssh"` | `"termx"`（双读回退，见 §3） |
| `src-tauri/src/secret/mod.rs:32,78` | 文档注释 service 名 | 同步 |
| `src-tauri/src/secret/master_key.rs:33` | keychain master key `rssh_master_key_v1` | `termx_master_key_v1`（回退读旧） |
| `src-tauri/src/secret/keyring_store.rs:8` | 探测键 `__rssh_probe__` | `__termx_probe__` |
| `src-tauri/src/secret/mod.rs:297-300` | 单测断言 service == `rssh` | 断言 `termx` + 旧名回退单测 |
| account 命名规则（`cred:` / `telnet:` / `setting:`） | 不变 | 不变（仅 service 名变化） |

### ⑥ 环境变量

| 位置 | 现状 | 改为 | 兼容 |
|---|---|---|---|
| `src-tauri/src/terminal/pty.rs:354,390` | `RSSH_APP=1` | `TERMX_APP=1` | — |
| `src-tauri/src/lib.rs:36` | `RSSH_DISABLE_WAYLAND_COMPAT` | `TERMX_DISABLE_WAYLAND_COMPAT` | 建议旧名回退读取 |
| `src-tauri/src/lib.rs:59` | `RSSH_KEEP_GBM_BACKEND` | `TERMX_KEEP_GBM_BACKEND` | 建议旧名回退读取 |
| `src-tauri/src/ai/web_search.rs:333` | `RSSH_WEB_SEARCH_PROVIDER` | `TERMX_WEB_SEARCH_PROVIDER` | 建议旧名回退读取 |
| 现有 `TERMX_SFTP_LIVE` / `TERMX_UPDATE_ENDPOINT` / `TERMX_SSH_TEST_*` 等 | 已正确 | 不改 | — |

### ⑦ 文档 / changelog 历史记录

| 文件 | 处数 | 处置 |
|---|---|---|
| `changelogs.md` | 86 | **保留历史原文**，只在 #218 起的新条目写改名说明 |
| `docs/plan.md` | 17 | **保留**（历史计划归档） |
| `docs/netcatty-tauri-migration.md` | 12 | **保留**（迁移历史） |
| `todo.md` 历史行 | 9 | **保留**，仅新增改名专项清单 |
| `evidence/`（25 文件） | 60 | **保留**（历史取证与旧脚本，不复跑） |
| `AGENTS.md` | 16 | **更新**（项目定位、R5 错误前缀、P1 改名警告、构建命令、数据目录说明） |
| `src-tauri/src/ai/ai-diagnose-design.md` | 23 | 更新（活文档） |
| `src-tauri/src/ai/prompts/general.md` | 12 | 更新（运行时提示词） |

### ⑧ 补充：其它内部协议 / 标记（不在原 7 类，但同属标识）

| 位置 | 现状 | 改为 | 兼容 |
|---|---|---|---|
| `src-tauri/src/error.rs:25,164` | 错误前缀 `__rssh_err__\|` | `__termx_err__\|` | 前端 `sshErrors.ts` 同时识别新旧前缀 |
| `src/domain/sshErrors.ts` + 测试 | 只认 `__rssh_err__` | 双前缀 | 必须同步 |
| `src-tauri/src/ai/session/file_ops.rs:84` | JSON 标记 `__RSSH_JSON__` | `__TERMX_JSON__` | 仅 Rust 内部，无需回退 |
| `src-tauri/src/ai/shell.rs:70` | 哨兵 `__rssh_done_<uuid>` | `__termx_done_<uuid>` | 仅 Rust 内部 |
| `src-tauri/src/ai/session.rs:1610-1630` | `window.__rssh_ai_handoff`、窗口 label `rssh-ai-` | `__termx_ai_handoff`、`termx-ai-` | 与前端同步 |
| `src-tauri/src/commands/window.rs:147` + `capabilities/default.json:4` | 窗口 label `rssh-<uuid>` / `windows: ["main","rssh-*"]` | `termx-<uuid>` / `termx-*` | 旧多窗口 label 不持久化，无需迁移 |
| `src/backend/client.ts:525-534`、`src/App.tsx:462-464`、`workspaceStore.test.ts:152` | `__rssh_clone`、label 相关测试键 | `__termx_clone` | 冷启动注入，无需迁移 |
| `src-tauri/src/sync/config.rs:79,1619`、`db/schema.rs:578` | 默认 `anonymous@rssh` | `anonymous@termx` | 旧库保留旧默认值（仅新库变更） |
| `src-tauri/src/ssh/forward.rs:976` | 断开原因 `"rssh forward stopped"` | `"termx forward stopped"` | 内部原因串 |
| `src-tauri/src/commands/update.rs:158,233`、`ai/web_fetch.rs:18`、`ai/web_search.rs:259` | HTTP UA `rssh/<ver>` | `termx/<ver>` | 外部服务可见；无兼容需求 |
| `src-tauri/src/db/schema.rs:281`、`ai` 注释、`vite.config.ts:9` 等 | 纯注释 | 顺手同步 | — |

## 2. 改名映射表（口径）

| 类型 | 旧 | 新 |
|---|---|---|
| 用户可见名 | `RSSH` / `rssh` | `termX` |
| crate / lib | `rssh` / `rssh_lib` | `termx` / `termx_lib` |
| GUI 二进制 | `rssh(.exe)` | `termx(.exe)` |
| CLI 随包二进制 | `rssh-cli(.exe)` | `termx-cli(.exe)` |
| CLI 安装命令 | `rssh` | `termx`（Windows `Programs\termx\termx.exe`） |
| headless | `rssh-server` | `termx-server` |
| 数据目录 | `~/.rssh` | `~/.termX` |
| DB 文件 | `rssh.db` | `termx.db` |
| keychain service | `rssh` | `termx` |
| master key 键 | `rssh_master_key_v1` | `termx_master_key_v1` |
| 错误前缀 | `__rssh_err__\|` | `__termx_err__\|` |
| 环境变量 | `RSSH_*` | `TERMX_*` |

## 3. 数据与兼容方案（已废止，2026-11-07 整体移除）

> 本节及 §3.1–§3.3 为历史方案记录；未发布前提下不再需要任何旧数据/钥匙串/备份文件名兼容，现状见文首。

### 3.1 目录与 DB（首次启动，GUI / headless / CLI 三端共用）

1. `db::data_dir()` 前置一次性迁移（`OnceLock` 守卫，三端都会走）：
   - 若 `~/.termX` 存在 → 直接用新目录，**不动**旧目录（避免覆盖/双写）。
   - 若 `~/.termX` 不存在且 `~/.rssh` 存在 → **移动**（`fs::rename`，同卷原子）；跨卷失败时退化为「递归复制 → 校验文件数 → 删除旧目录」。
   - 若移动失败 → **回退用 `~/.rssh` 运行并告警**，保证可用性优先，不阻断启动。
   - 选择移动而非复制的理由：避免新旧二进制各写一份导致数据分叉；同卷 rename 原子，中断风险最小。
2. 目录内：`rssh.db`（及 `-wal` / `-shm`）→ `termx.db`；`recordings/`、`plugins/`、`master.key` 原样保留在移动后的目录中，无需单独改名。
3. Android：`app_data_dir` 内同样 `rssh.db` → `termx.db`（无旧目录迁移场景，仅改文件名）。

### 3.2 钥匙串（双读回退 + 懒迁移）

- 新 service `termx`；`get(key)` 未命中时再读旧 service `rssh` 的同名 account，命中则回写新 service（懒迁移，不批量枚举）。
- master key：先读 `termx_master_key_v1`，未命中读 `rssh_master_key_v1`，命中后写新键。
- 理由：各平台 keychain 枚举能力不一致，批量迁移易漏；按 key 懒回退可保证旧条目永远可读，且不会因为一次失败丢密钥。
- 回退保留期：至少保留一个发布周期，后续通过设置标记再清理旧 service。

### 3.3 明确后果

- 迁移成功后：DB、录制、插件、密钥引用全部继续可读；`~/.rssh` 不再存在（避免双写）。
- 新旧目录同时存在：以 `~/.termX` 为准，`~/.rssh` 原样保留（需要人工合并）。
- 迁移失败：回退读旧目录，功能可用，但数据仍写在 `~/.rssh`（会在日志中告警）。
- 远端同步备份文件名**不改**（`rssh_backup.*`）：改名会让既有 GitHub / WebDAV 备份「消失」，等同旧备份丢失；保留旧名是兼容性优先的选择。
- 旧库中 `command_block_prompt_replacement` 的 `anonymous@rssh` 默认值随 DB 保留；仅新建库写入 `anonymous@termx`。

## 4. 验证计划

1. `npm run test:run`、`npm run build`、`cargo test --lib`、`cargo build --features server`、`npm run tauri -- build --debug --no-bundle` 全绿。
2. 实机（129）：先用旧版生成/保留 `~/.rssh` 数据 → 启动新版 → 确认自动迁移、连 `tianzry@192.168.126.129`、开 SFTP、写一条日志、重启后数据仍在；截图 + JSON 取证。
3. 钥匙串：校验旧 service 的 GitHub token / 主机密码可读回（keyring 探针）。

## 5. 提交拆分

1. `docs(rename): rssh 标识盘点与迁移方案`（本文件 + todo）
2. `refactor(rename): crate/二进制/显示名改为 termX`
3. `feat(rename): 数据目录/DB/keychain 迁移与旧值回退`
4. `docs(rename): AGENTS/设计文档/脚本同步 + changelog #218`

## 6. 保留不改及原因

- `changelogs.md`、`docs/plan.md`、`docs/netcatty-tauri-migration.md`、TODO 历史行：历史记录，保留可追溯性。
- `evidence/`：历史取证产物与已执行脚本；新验证脚本另起并改用 `termx.exe`。
- ~~`sync` 远端备份文件名 `rssh_backup.*`：兼容既有远端备份。~~ 已废止（2026-11-07）：未发布、无既有远端备份，改为 `termx_backup.*`。
- `TERMX_*` 既有环境变量、`termx.<域>.v<n>` localStorage 前缀、`com.termx.app` identifier、深链 scheme `termx`：本来就是 termX 口径。

## 7. 实际落地（2026-11-06）

本节记录盘点方案的最终执行结果与偏差；未列出的条目均按 §1–§3 落地。

### 7.1 标识与构建

| 项目 | 实际结果 |
|---|---|
| crate / lib | `termx` / `termx_lib`（`Cargo.toml`、`src-tauri/tests`） |
| 二进制 | `termx`（GUI，`default-run`）、`termx-cli`（feature `cli`，源码在 `src/bin/termx/`）、`termx-server`（feature `server`） |
| 版本 / identifier | `0.0.1` / `com.termx.app`（`tauri.conf.json`） |
| 显示名 | 窗口标题 `termX`、CLI `about`、AI 本地分析窗口、iOS plist 说明、审计文件头均为 termX |
| 安装包 | `termX_0.0.1_x64-setup.exe`（NSIS）、`termX_0.0.1_x64_en-US.msi`（MSI）；NSIS per-user 安装到 `%LOCALAPPDATA%\termX`，快捷方式 `termX.lnk`（开始菜单 + 桌面） |
| 工作区脚本 | `build-debug.bat`、`.launch-termx.vbs` 指向 `target/debug/termx.exe` |
| 深链 | schemes `ssh` / `telnet` / `termx`；窗口 label `termx-<uuid>`、冷启动注入键 `__termx_clone` |

### 7.2 数据目录与迁移

- `db::data_dir()` 经 `db/data_dir_migration.rs` 一次性迁移（`OnceLock` 守卫，GUI / CLI / server 共用）：
  - `~/.termX` 已存在 → 直接用新目录，旧目录不动；
  - 不存在且 `~/.rssh` 存在 → 同卷 `fs::rename` 原子移动；跨卷退化为复制 → 校验文件数 → 删除旧目录；
  - 失败 → 回退读 `~/.rssh` 并告警，不阻断启动。
- 目录内 DB 文件 `rssh.db` → `termx.db`（`db::db_path` 仍兼容旧文件名回退）；`recordings/`、`plugins/`、`master.key` 随目录移动。
- 迁移报告写 `<data_dir>/.rename-migration.json`，设置 → 系统读取后删除并展示。
- **实测（隔离副本，不动真实数据）**：`status=migrated` / mode `rename` / tables 23/23 / rows 334/334 / recordings 0/0 / `old_dir_removed=true`；设置-系统文案与实际一致。详见 [installer-verification.md](installer-verification.md)。

### 7.3 兼容回退（按方案保留）

| 项目 | 实际实现 |
|---|---|
| keychain service | 新 `termx`；未命中读 `LEGACY_SERVICE="rssh"`，命中懒迁移回写新 service |
| master key | 新 `termx_master_key_v1`；未命中读 `rssh_master_key_v1` 后回写 |
| 错误前缀 | `__termx_err__\|`；前端 `sshErrors.ts` 双前缀兼容 `__rssh_err__\|` |
| 环境变量 | 新 `TERMX_DISABLE_WAYLAND_COMPAT` / `TERMX_KEEP_GBM_BACKEND` / `TERMX_WEB_SEARCH_PROVIDER`；旧 `RSSH_*` 保留一个发布周期回退读取 |
| 远端同步备份 | `rssh_backup.json` / `rssh_backup.enc` / `.meta.json` 保持旧名，避免既有云备份“消失” |
| 旧默认值 | 旧库中 `anonymous@rssh` 随 DB 保留；仅新建库写 `anonymous@termx` |

### 7.4 与盘点方案的偏差

- 盘点 §5 的 4 个提交按实际依赖合并为改名专项的连续提交（crate/二进制/显示名、数据目录与 keychain 迁移、文档与 AGENTS 同步），changelog 从 #218 起记录，未拆成额外的“回退单测”提交（回退逻辑的单测随实现提交）。
- 安装包层面出现一个方案外结果：MSI 为 per-machine（写 HKLM `Software\Classes\ssh` 等 URL protocol），在非管理员会话无法静默安装（exit 1603 / Error 1925 与 1406）；NSIS 为 per-user 可全链路验证。详见 [installer-verification.md](installer-verification.md)。
- `commands/cli.rs` 的“已安装命令”检查路径随二进制名改为 `termx` / `termx.exe`；`Programs\termx` 由 CLI 自装流程创建（不在安装包内）。

### 7.5 验证结论

- 改名后 `termx.exe` 全应用回归（浅/深、Vault 9 页、设置 8 tab、SSH/本地/Telnet/串口）通过，P1=0：[final-regression.md](final-regression.md)。
- 门禁：前端 769（70 文件）、`npm run build`、Rust lib 960、`cargo build --features server`、debug 打包全绿；详见 README / changelogs #226。
- 仍需人工确认：证书真实 CA 握手、Windows ssh-agent 转发、真实串口设备回环、原生文件对话框、MSI 管理员安装/卸载。
