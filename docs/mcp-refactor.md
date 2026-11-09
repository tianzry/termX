# termX MCP 整改方案

## 目标

让 AI 通过 termX MCP 高效、安全、可控地完成远端 SSH 服务器上的完整开发工作流——代码查阅 / 搜索 / 编辑 / 删除、本地上传、编译、下载产物。

要求：调用频繁场景下不废 token、不冗余、不止于"能用"。

## 核心问题

1. 用「shell 命令 + 黑名单」表达文件语义 → 打地鼠式拦截、误杀、注入面大、无法批量。
2. termX 内部已有 `patch_file` / `match_file` / SFTP 会话等原生能力，但 MCP 层没封装出来。
3. 所有数据传输被迫走 stdout（base64），token 成本极高且有截断风险。

## 设计原则

1. **能力原生化**：文件/传输/构建用带类型的专用工具表达，不再靠解析 shell。termX 底层已有 `patch_file` / `match_file` / SFTP，MCP 只做薄适配。
2. **双平面**：控制平面（类型化 fs/sftp/build 原语，构造即安全，无需黑名单）+ 逃生平面（`term_run` 只读/执行，保留策略化黑名单）。文件工作彻底脱离黑名单。
3. **Token 优先**：传输永不回传内容，只回 `path+size+checksum`；读默认开窗；编辑走 diff；输出尾部偏置截断；支持批量与字段投影。
4. **安全可控**：分级权限（read/write/delete/transfer/build）、路径 jail（限定 workspace 根）、删除/覆盖强制 dry-run + 确认、全量审计日志、传输校验和。
5. **减少往返**：高频调用下，批量复合操作把 N 次 MCP 调用压成 1 次。

## 架构

```
┌────────────────────────── MCP Server (thin adapter) ──────────────────────────┐
│  控制平面 (typed, sanitize-by-construction, 无黑名单)                            │
│    fs_read / fs_grep / fs_glob / fs_patch / fs_write / fs_delete               │
│    sftp_put / sftp_get                                                          │
│    build_run                                                                    │
│    batch (复合)                                                                  │
│  逃生平面 (read/exec only, 策略化)                                               │
│    term_run                                                                     │
│  发现 (可缓存)                                                                   │
│    get_environment / vault_hosts_list                                           │
└───────────────┬─────────────────────────────────────────┬──────────────────────┘
                │ 直接调用 termX 原生能力                   │
        patch_file / match_file / SFTP put-get        pty exec (只读/执行 + 命令策略)
```

要点：

- 文件类工具直接映射 termX 的 `patch_file` / `match_file` / SFTP，参数是结构化路径与内容，不存在 shell 注入面，因此不需要黑名单，也就没有误杀。
- `term_run` 仅保留「跑命令/读输出」，命令策略只需防真正的破坏性操作（`rm -rf /`、`mkfs`、fork 炸弹等），不再承担文件语义。
- **会话句柄稳定化**：`get_environment` 结果可缓存，工具接受 `sessionId` 或 `hostId`（自动复用该主机已就绪会话），避免每次重新发现。

## 工具集规格

### 通用返回约定

- 成功 `{code:"ok", ...data}`；失败 `{code, message, hint}`。
- 成功时不再重复冗长 hint（指引放进工具 description，只在握手 instructions 里给一次）。
- 字段名短而稳定。
- 所有列表类返回带 `truncated` 与 `nextCursor`。

### 4.1 发现（精简、可缓存）

- `get_environment` → `{sessions:[{id,kind,phase,hostId}], hosts:[{id,name,host}], cacheable:true, ttl}`。
  把主机与会话合并返回并建立 `hostId` 关联，省掉单独调 `vault_hosts_list` 的往返。
- 其余工具支持传 `hostId` 替代 `sessionId`，服务端自动选该主机 ready 会话。

### 4.2 fs_read（查阅，默认开窗）

```jsonc
// in
{ "sessionId|hostId": "...", "path": "~/code/x.c",
  "startLine": 1, "maxLines": 200,        // 默认 200 行窗口，不整文件
  "numbered": true }                        // 是否带行号
// out
{ "code":"ok", "lines":"...", "totalLines":1842, "size":54321,
  "mtime":..., "truncated":true, "nextCursor":201 }
```

Token 策略：默认窗口 + 回 `totalLines`，让上层按需翻页，绝不一次性吐大文件。

### 4.3 fs_grep / fs_glob（搜索，封顶）

```jsonc
// fs_grep in
{ "sessionId|hostId":"...", "pattern":"a2dp_*", "glob":"**/*.c",
  "regex":true, "ignoreCase":true, "contextLines":1, "maxResults":50 }
// out
{ "code":"ok", "matches":[{"path":"...","line":42,"text":"..."}],
  "total":317, "truncated":true, "nextCursor":50 }
```

封装 termX `match_file`。只回 `file:line:snippet`，封顶 + 游标。

### 4.4 fs_patch（编辑主力，diff 化，可批量多文件）★

```jsonc
// in
{ "sessionId|hostId":"...",
  "edits":[
    { "path":"~/code/a.c",
      "ops":[{"oldText":"foo();","newText":"bar();","replaceAll":false}] },
    { "path":"~/code/b.h",
      "ops":[{"oldText":"#define X 1","newText":"#define X 2"}] }
  ],
  "dryRun": false }
// out
{ "code":"ok", "results":[{"path":"...","applied":1,"sha256":"..."}] }
```

映射 `patch_file`。只传变更片段而非整文件——双向省 token；支持一次改多个文件，减少往返；`oldText` 不唯一时报错并回候选行号（可定位、不臆改）。

### 4.5 fs_write（新建/整体覆盖，仅小文件或全量替换时用）

```jsonc
{ "sessionId|hostId":"...", "path":"~/code/new.c", "content":"...", "overwrite":false }
```

大文件优先 `sftp_put`（不占 token），`fs_write` 仅用于小文本。

### 4.6 fs_delete（删除，强制 dry-run + 批量）★

```jsonc
// in
{ "sessionId|hostId":"...", "paths":["~/code/tmp/t_out"], "recursive":false, "dryRun":true }
// out (dryRun)
{ "code":"ok", "wouldDelete":[{"path":"...","size":15768}], "confirmToken":"dt_9f3..." }
// 二次调用带 confirmToken 真正删除
```

受控删除：先 dry-run 列出将删对象 + 发 `confirmToken`，确认后执行；路径必须在 jail 内；全量审计。

### 4.7 sftp_put / sftp_get（上传/下载，零内容 token）★★

```jsonc
// sftp_put in  (本地 -> 远端)
{ "sessionId|hostId":"...", "items":[{"localPath":"C:/.../a.c","remotePath":"~/code/a.c"}],
  "overwrite":true }
// out
{ "code":"ok", "results":[{"remotePath":"~/code/a.c","size":2048,"sha256":"...","status":"ok"}] }

// sftp_get in  (远端 -> 本地)
{ "sessionId|hostId":"...", "items":[{"remotePath":"~/code/build/app.elf","localPath":"C:/.../out/app.elf"}] }
// out
{ "code":"ok", "results":[{"localPath":"...","size":15768,"sha256":"...","status":"ok"}] }
```

复用 termX 现有 SFTP 会话（当前对 `terminal_execute` 返回 `plugin_no_exec` 的那两个）。

关键收益：文件流式直传本地磁盘，返回里只有路径/大小/校验和，没有 base64 内容——上传源码、下载编译产物的 token 成本从 O(文件大小) 降到 O(1)，且无 stdout 截断问题。支持批量数组、目录递归（`recursive`）、断点校验（sha256 比对）。

### 4.8 build_run（编译/执行，尾部偏置截断）★

```jsonc
// in
{ "sessionId|hostId":"...", "command":"make -j8", "cwd":"~/code/proj",
  "timeoutMs":120000, "maxOutputBytes":16384, "teeToRemoteFile":"~/code/tmp/build.log" }
// out
{ "code":"ok", "exitCode":2,
  "stdoutTail":"...(最后 N 字节)", "stderrTail":"...error: ...",
  "totalBytes":982341, "truncated":true, "fullLog":"~/code/tmp/build.log" }
```

- 输出尾部偏置截断（错误多在末尾），回 `totalBytes`，并可把完整日志 tee 到远端文件 + 回路径，需要时再 `fs_read` 开窗取。
- 命令策略：放行构建工具链（make/cmake/gcc/cargo/npm…），仅拦真正破坏性命令；`cwd` 限定 jail 内。
- 这才是「真实工程编译」的正道——配合 `sftp_put` 上传整棵源码树后直接 `make`。

### 4.9 batch（复合，压往返）★

```jsonc
// in
{ "sessionId|hostId":"...",
  "ops":[ {"tool":"fs_grep","args":{...}}, {"tool":"fs_read","args":{...}},
          {"tool":"fs_patch","args":{...}} ],
  "stopOnError":true }
// out
{ "code":"ok", "results":[ {...}, {...} ] }
```

高频场景把「搜索→读→改」等多步压成 1 次 MCP 调用，显著降低 per-call 开销与延迟。仅允许组合只读/写原语，破坏性操作仍单独走确认。

## 5. Token 效率专项（因调用频繁，单列）

1. **传输不回内容**：`sftp_*` 只回 `path+size+sha256`。杜绝 base64→stdout。
2. **读默认开窗**：`fs_read` 默认 200 行 + `totalLines`，按需翻页。
3. **编辑走 diff**：`fs_patch` 只传 `oldText/newText`，不传整文件。
4. **搜索封顶**：`maxResults` + `contextLines` 受控，回游标。
5. **输出尾截断**：`build_run` / `term_run` 尾部偏置 + 完整日志落远端文件回路径。
6. **批量复合**：`batch` 合并多步，减少调用次数（每次调用都有固定 schema/往返 token 成本）。
7. **精简返回**：成功不回冗长 hint；短字段名；支持 `fields` 投影只取所需。
8. **发现可缓存**：`get_environment` 合并 hosts、带 `ttl`，避免重复发现。

## 6. 安全与权限模型

- **分级权限**（沿用 termX「设置 → AI → 工具接入」档位，按工具类细化）：
  - read 类（`fs_read` / `grep` / `glob` / `get_environment`）：observer 即可。
  - write 类（`fs_patch` / `fs_write` / `sftp_put`）：confirm 或 auto。
  - delete 类（`fs_delete`）：强制 dry-run + confirmToken，auto 档也需二次确认或白名单。
  - transfer 下载（`sftp_get`）：confirm/auto。
  - `build_run` / `term_run`：命令策略 + 档位。
- **路径 jail**：`fs_` / `sftp_` 限定在配置的 workspace 根（如 `~/code`），拒绝 `..` 逃逸与指向根外的软链。
- **构造即安全**：文件类工具参数结构化，无 shell 拼接 → 无注入面 → 不需要黑名单误杀。
- **完整性**：所有传输/写入回 `sha256`，下载后本地比对。
- **审计日志**：每个变更操作记录 `{ts, tool, sessionId, path, size, sha256, permissionDecision}`，可追溯。
- **幂等/可回滚**：`fs_patch` 可先 `dryRun` 回预览 diff；`fs_delete` dry-run；`sftp_put overwrite=false` 防误覆盖。

## 7. 端到端工作流（整改后）

「本地改代码 → 上传 → 编译 → 下载产物」的最省 token 路径：

1. `get_environment`（缓存）→ 拿 209 的 `hostId`。
2. 查阅/搜索：`batch[fs_grep + fs_read]` 定位代码。
3. 编辑：远端直接 `fs_patch`（diff）；或本地改完整树用 `sftp_put`（递归，零内容 token）上传。
4. 编译：`build_run {command:"make -j8", teeToRemoteFile:"build.log"}` → 看 `exitCode` + 尾部；失败则 `fs_read build.log` 开窗定位。
5. 下载产物：`sftp_get {remotePath:"build/app.elf", localPath:...}` → 回 `sha256`，本地校验。
6. 清理：`fs_delete {dryRun:true}` → 确认 → 删。
7. 按需 `session_close`（只关自己开的）。

对比现状：第 3/5 步现在根本做不了（写/传被拦），第 4 步跑不了真实工程；整改后全链路打通且传输零内容 token。

---

## 8. 现状核对（2026-11-09，实施前必读）

以上设计有两条前提与当前代码不符，规划按实际情况修正：

| 设计假设 | 代码事实 | 影响 |
|---|---|---|
| termX 已有原生 `patch_file` / `match_file` 能力，MCP 只做薄适配 | 它们是 **AI 面板工具**：`ai/session/file_ops.rs` 的 `handle_match_file`（L634）/ `handle_patch_file`（L761），实现方式是**远端 python3/perl 脚本 + 终端 exec**，并强绑定 AI 会话（审批卡片、`run_file_op`、`ensure_remote_caps`） | 不能直接调用；只能复用其纯逻辑（脚本构造/JSON 解析/路径校验），或另建原语层 |
| SFTP 会话可直接复用 | 真实：`ssh/sftp.rs` 的 `SftpSession` 有 `download` / `upload` / `download_streaming` / `upload_streaming` / `walk_files` / `stat` / `remove` / `remove_dir` / `realpath`；`SftpHandle::from_handle(&SshHandle, parent)` 可无重认证开子通道（范例 `commands/sftp.rs::sftp_connect_session` L120） | 这才是可薄适配的原生能力，`sftp_put/get` 与 `fs_*` 都建在它上面 |

现有 MCP 面：`mcp/tools.rs`（单文件 5 工具 + envelope）、`mcp/server.rs`（JSON-RPC 分发 L650-702）、`mcp/config.rs`（观察者/确认/自动三档）、`mcp/grants.rs`（按 capabilityId 的允许规则）、`mcp/blocklist.rs`、`mcp/guide.rs`（instructions）。

结论：MCP 需要**新建文件原语层**：读/写/删/列举以 SFTP 为底座；grep 与 patch 复用 AI 面板的远端脚本，但把脚本构造逻辑提取为共用模块，执行与审批由 MCP 自己完成（不进入 AI 会话队列）。

## 9. 验收标准

整改完成的判定以端到端实测为准，逐条留证：

1. **编辑闭环**：`fs_patch` 改远端源码后，`fs_read` 读回内容正确、diff 与预期一致、文件 `sha256` 发生变化。
2. **源码树上传**：`sftp_put` 递归上传整棵源码树，返回仅 `path + size + sha256`，无任何 base64 内容。
3. **真实编译**：`build_run` 跑 `make`，失败时尾部 `stdoutTail/stderrTail` 足以定位；完整日志已 tee 到远端文件，可用 `fs_read` 开窗读取。
4. **产物下载**：`sftp_get` 把编译产物下载到本地，本地与远端 `sha256` 一致，无截断。
5. **受控删除**：`fs_delete` 先 dry-run 返回 `wouldDelete + confirmToken`，确认后才删除；jail 外路径被拒绝。
6. **复合压往返**：`batch` 一次完成「grep + read + patch」，MCP 往返次数低于逐条调用。
7. **无黑名单误杀**：全流程文件类操作不触发命令黑名单；`fs_*` 不依赖 shell 拼接（`fs_grep`/`fs_patch` 的脚本参数已转义）。
8. **Token 量级**：单次典型工作流（发现 → 搜 → 读 → 改 → 编译 → 下载）的 token 消耗较 base64 方案下降一个数量级；传输恒为 O(1)（只回路径/大小/校验和）。
9. **会话解析**：`hostId` 在无 ready 会话时按 vault 凭据自动建连并复用；重复调用命中同一会话不重复建连；连接断开后能重建。

## 10. 实施规划

### M0 基础设施（不新增工具）

- 新增 `src-tauri/src/mcp/fs/` 模块：`mod.rs`（统一结果信封 + `truncated/nextCursor`）、`path.rs`（`~` 展开、规范化、jail 校验，拒绝 `..` 与指向根外的软链）、`session.rs`（`sessionId|hostId` 解析为 `(SshHandle, Option<Arc<SftpHandle>>)`）。
- **`hostId` 自动建连**：`session.rs` 解析顺序为 `sessionId` → 该 profile 的 ready SSH 会话 → 按 vault 档案（profile + credential + secret + bastion 链 + known_hosts）走 `resolve_session_id` + `client::connect` + `activate_returned` 建连。MCP 建连使用独立 owner（`SessionOwner::Headless(uuid)`），不占用窗口；`get_environment` 的 `sessions[]` 增加 `origin: "mcp" | "user"` 便于识别。
- **建连单飞**：进程内 `hostId → 进行中的建连 Future` 表，并发请求共享同一次建连，避免重复连接；连接失败清表并回 `connect_failed`（附 AppError code）。
- **不支持交互认证**：自动建连只接受已保存凭据；若后端要求 keyboard-interactive / passphrase / host key 确认，返回 `interactive_auth_required` 并提示用户在 termX 中手动连接一次（MCP 无弹窗通道）。`host_key_policy=ask` 视同该错误，`accept-new`/`skip` 可自动完成。
- 新增 `src-tauri/src/mcp/fs/handle.rs`：优先复用 `state.sftp_sessions` 中 `parent_ssh_id == sessionId` 的通道；否则 `SftpHandle::from_handle` 开临时通道（调用结束 drop）。
- **提取远端脚本纯函数**（供 AI 面板与 MCP 共用，避免复制）：把 `ai/session/file_ops.rs` 的 `validate_path` / `select_interpreter` / `extract_json_payload` / `build_match_cmd` / `build_cp_cmd` / `build_modify_cmd` / `build_diff_cmd` / `build_mv_cmd` 迁到 `ai/remote_script.rs`，可见性 `pub(crate)`；AI handler 改为调用新模块，行为不变。
- 新增 `src-tauri/src/mcp/fs/caps.rs`：远端解释器与 `diff` 能力探测（python3 > perl，diff 缺失时 `fs_patch` 退回无 diff 预览），结果按 `profile_id` 缓存复用 `ai_remote_shell_cache` 的模式。
- 新增 `src-tauri/src/mcp/permissions.rs`：把三档扩展为「档位 × 工具类（read/write/delete/transfer/build）」矩阵，设置键 `mcp.permission_matrix`（JSON，缺省按设计 §6）。
- 新增 `src-tauri/src/mcp/audit.rs`：变更操作落结构化日志（首期写 tracing + `settings` 环形 JSON 上限 500 条，不新增表、不动 `SCHEMA_VERSION`）。
- 验收：jail 单测（`~`、`..`、绝对路径、软链逃逸）、矩阵单测、`sessionId/hostId` 解析单测、脚本函数迁移后 AI 面板既有 1523–1590 行单测保持全绿。

### M1 只读工具

`get_environment` 扩展（`sessions[].hostId`、`hosts[]` 合并、`cacheable/ttl`）、`fs_read`、`fs_grep`、`fs_glob`。

- `fs_read`：SFTP `stat` 预检 + 下载（单文件上限 8 MiB）+ 行窗口；二进制（含 NUL）拒绝。
- `fs_grep`：**复用远端 `build_match_cmd` 脚本**（`ssh_exec`/`plugin_exec_impl` 执行，非 PTY），回 `file:line:snippet`；`glob` 前缀先由 `fs_glob` 展开再逐个 match，`maxResults` 封顶 + 游标。
- `fs_glob`：SFTP `walk_files` + 通配匹配，封顶 + `nextCursor`。

验收：大文件 200 行窗口、`nextCursor` 翻页、`truncated`、二进制拒绝、`totalLines` 正确、无 python3/perl 时返回明确 `missing_interpreter` 错误。

### M2 写工具

`fs_patch`（多文件、`oldText` 唯一性校验、失败回候选行号、`dryRun` 回统一 diff）、`fs_write`（`overwrite` 保护、小文件上限 256KB）。

- `fs_patch`：**复用远端脚本四步链路**（`cp → modify → diff → mv`），与 AI 面板同语义：`oldText` 计数必须等于 `expectedCount`（缺省 1），不匹配时回候选行号；`dryRun` 只走到 `diff` 并删除临时文件。执行走 `plugin_exec_impl`，审批走 MCP `approval_gate`（不进 AI 审批队列）。
- `fs_write`：SFTP `upload`；`overwrite=false` 先 `stat`；返回 `size/sha256`。

验收：唯一性冲突回候选行号、`replaceAll`、多文件部分失败语义、`dryRun` 不改盘、`sha256` 一致、临时文件不留存。

### M3 传输工具

`sftp_put` / `sftp_get`，支持 `items[]`、`recursive`、`overwrite`、sha256。返回只含 `path/size/sha256/status`。
实现：复用 `upload_streaming` / `download_streaming`；远端路径过 jail，本地路径过 `localfs` 现有校验；`overwrite=false` 先 `stat`。
验收：目录递归、覆盖保护、校验和不匹配报错、零 base64 内容。

### M4 删除

`fs_delete`：`dryRun` 默认 true → 回 `wouldDelete[] + confirmToken`；确认调用带 token 执行。token 进程内表 + 5 分钟 TTL + 绑定会话与路径集合。走 SFTP `stat/remove/remove_dir`（递归需显式开关）。
验收：token 失效/路径变更拒绝、递归开关、jail 逃逸拒绝。

### M5 执行

`build_run`：`cwd` 过 jail、尾部偏置截断、`totalBytes`、`teeToRemoteFile`（同时写远端文件，回路径）。
`term_run`：现 `terminal_execute` 实现更名；`terminal_execute` 保留为兼容别名（不进 `tools/list`，避免工具表膨胀）。
验收：尾部截断边界、超时、exitCode 透传、tee 文件可被 `fs_read` 读到。

### M6 复合

`batch`：白名单内工具组合，`stopOnError`，结果按序平铺；拒绝嵌套 `batch`、`fs_delete` 与非只读+删除混合。
验收：3 步 `grep→read→patch` 单次调用成功、失败短路、总耗时打印。

### M7 收尾

- `mcp/guide.rs` 的 instructions 重写（工具分组 + 典型工作流各一句，成功路径不再回 hint）。
- `mcp/tools.rs` 的 `ToolResult::ok` 去掉必填 hint。
- 前端 `src/settings/AiTab.tsx` 增加「工作区根（jail）」「工具类权限矩阵」；`src/backend/client.ts` 封装新设置字段（R1）。
- 文档：`docs/mcp-guide.md` 与 `docs/mcp-port-plan.md` 更新工具表。
- 门禁：`npm run test:run`、`npm run build`、`cargo check`（本沙箱缺 glib，需真机/CI）、`cargo test --lib`。

## 11. 已确认决策（2026-11-09）

1. **fs 底座：混合模式**——`fs_read` / `fs_write` / `fs_delete` / `fs_glob` / `sftp_*` 走 SFTP 原生；`fs_grep` / `fs_patch` 复用 AI 面板的远端脚本（python3/preferred，perl 兜底），脚本纯函数提到 `ai/remote_script.rs` 共用。
2. **`hostId` 语义：可自动建连**——vault 中存在该主机档案时，无 ready 会话则按档案自动建连并复用；MCP 使用独立 `SessionOwner::Headless(uuid)`，不占窗口、不弹 UI。并发请求单飞；需要交互认证（keyboard-interactive / passphrase / 未知主机确认）时回 `interactive_auth_required`，并提示用户在 termX 手动连接一次。连接本身不单独走审批卡片，工具级审批照旧（observer 只读、confirm 写操作审批、auto 放行）。
3. **审计落盘**：首期 settings 环形日志（零 schema 变更）；需要查询界面时再开 `mcp_audit` 表并递增 `SCHEMA_VERSION`。
4. **权限矩阵默认值**：沿用 observer/confirm/auto 作为总开关；delete 类在任何档位都强制 dry-run + confirmToken。
