# 对外 MCP 移植方案（Settings → AI → 工具接入）

> 状态：方案 + 后端已落地（`feat/mcp-server` 分支，独立 worktree）。
> 前端设置页 UI 未落地（见 §9），其余实现与未实现清单见 §6/§10。

## 1. Netcatty 侧取证（唯一基准）

| 主题 | 文件 : 行号 | 事实 |
| --- | --- | --- |
| 主进程 TCP bridge | `electron/bridges/mcpServerBridge.cjs:L1325-L1395` | `net.createServer` 绑定 `127.0.0.1` + **随机端口**；成功后写 discovery 文件并回调 `externalMcpHostReadyHook({port, token})` |
| Token | `electron/bridges/mcpServerBridge.cjs:L104-L133` | `crypto.randomBytes(32)` 生成；撤销时清空 token 并断开已认证 external socket |
| Discovery 文件 | `electron/bridges/mcpServerBridge.cjs:L511-L568` | 内容含 `port/token/pid/permissionMode/updatedAt`；校验失败自动重写，避免客户端拿到过期信息 |
| 认证 | `electron/bridges/mcpServerBridge.cjs:L1454-L1537` | 首帧必须是 `auth/verify`；普通 token / external token / delegated token 三种；external socket 被强制绑定 `EXTERNAL_MCP_CHAT_SESSION_ID` |
| RPC 分派 | `electron/bridges/mcpServerBridge.cjs:L2239-L2351` | `netcatty/*` 走内置 capability handler，其余走 capability RPC；含权限评估、session scope 校验、写审批 |
| 对外 HTTP 运行时 | `electron/bridges/externalMcpController.cjs:L173-L204` | 绑定 `chatSessionId`，`getToken` 提供 bearer，RPC 走 `dispatchBuiltinRpc` + privacy guard |
| HTTP 启停/错误 | `electron/bridges/externalMcpController.cjs:L253-L296` | `listen_failed / port_in_use / invalid_address` 三类错误码；`httpEnabled/enabled` 决定启停 |
| 客户端片段 | `electron/domain/externalMcpHttp.ts:L15-L58` | `http://host:port/mcp` + `Authorization: Bearer`；生成 Codex TOML / 环境变量 / Claude 命令 / 通用 MCP JSON |
| 工具目录 | `electron/capabilities/catalog/index.cjs:L3-L27` | `META/TERMINAL/SFTP/VAULT/PORT_FORWARD/HARNESS` 汇总为 `ALL_CAPABILITIES` |
| 目录条目样例 | `electron/capabilities/catalog/terminal.cjs:L6-L89` | 字段：`id / description / policy / surfaces.builtin / surfaces.public / mcpTool / rpcMethod / inputShape / write / bypassesApproval` |
| SFTP 条目 | `electron/capabilities/catalog/sftp.cjs:L5-L139` | 11 个 sftp 工具，写工具标 `write: true` |
| 工具面生成 | `electron/capabilities/codegen/toolSurfaces.cjs:L57-L97` | 按 surface 过滤 → `listMcpTools()` |
| McpServer 注册 | `electron/capabilities/codegen/mcpToolRegistry.cjs:L118-L245` | `createToolHandler()` 依 `mcpTool/rpcMethod/inputShape/policy` 生成 handler，`server.tool(...)` 注册 |
| 渐进式工具集 | `electron/mcp/progressiveMcpTools.cjs:L9-L105` | `CORE_MCP_TOOL_NAMES` + `DEFERRED_MCP_TOOLSETS`（sftp_advanced / vault_hosts / notes / snippets / scripts / portforward） |
| 工具加载 | `electron/mcp/progressiveMcpTools.cjs:L145-L189` | 初始 15 个核心工具，`load_netcatty_tools` 按组动态加载 |
| stdio server | `electron/mcp/netcatty-mcp-server.cjs:L313-L359` | 创建 `McpServer`、写 instructions、注册渐进式或 delegated profile |
| server instructions | `electron/mcp/netcattyMcpInstructions.cjs:L3-L6` | 覆盖 terminals / hosts / SFTP / vault / snippets / scripts / port forwards，说明 `get_environment` 与 `load_netcatty_tools` |
| 设置页卡片 | `components/settings/tabs/ai/ExternalMcpCard.tsx:L49-L87, L248-L293, L335-L391, L393-L489` | 状态机（disabled/unavailable/running/starting/error）、开关+模式+超时+HTTP 配置、提交与轮询 |
| HTTP 区块 | `components/settings/tabs/ai/ExternalMcpHttpSection.tsx:L77-L133, L180-L290, L291-L375` | 端口 / 监听地址 / 客户端 host / 自定义绑定开关 / URL / token / Codex 配置 / Claude 命令 / 通用 JSON |
| 接入指引 | `components/settings/tabs/ai/ToolAccessGuidance.tsx:L10-L37, L95-L140` + `application/state/useToolAccessGuidanceState.ts:L40-L62, L81-L159` | 仅在 MCP 运行中且启用时展示 launcher / discovery 信息 |
| 权限三档 | `components/settings/tabs/ai/SafetySettings.tsx:L72-L93` | `observer / confirm / auto` |
| 状态点 / 弹窗 | `ToolStatusPill.tsx:L4-L14` / `ToolSettingsDialog.tsx:L6-L47` | `active/inactive/error` 三态；弹窗壳 |

**传输结论**：Netcatty 对外有两跳 —— ①Electron 主进程 loopback TCP bridge（传 JSON-RPC，token 鉴权）；②可选对外 HTTP（`/mcp`，Bearer）与一个 Node stdio launcher（`netcatty-external-mcp-server.cjs`）作为 stdio 客户端适配层。termX 是单进程，**不需要 launcher 这一跳**。

## 2. termX 复用点与冲突点

| 主题 | termX 现状 | 结论 |
| --- | --- | --- |
| 双注册规则 | Tauri 命令在 `src-tauri/src/lib.rs:L179-L517` 的 `generate_handler!`；headless 在 `src-tauri/src/server.rs:L241` 的 `dispatch` + `dispatch_async` | 4 个 mcp 命令两处都已注册：`lib.rs:L512-L516`、`server.rs:L1113-L1137` |
| 唯一 invoke 出口 | `src/backend/client.ts` 扁平导出函数 | 新增 `mcpStatus/mcpSetConfig/mcpRotateToken/mcpClientConfig`（`client.ts:L1983-L2029`），页面不得直接 `invoke` |
| 嵌套 snake_case | 顶层参数 camelCase，嵌套 struct 原样 snake_case | `McpConfigPatch` 是顶层 struct，`#[serde(rename_all="camelCase")]`；返回 `McpStatus` 同样 camelCase |
| 设置存储 | `db::settings::get/set`（`src-tauri/src/db/settings.rs:L6/L20`），通用 KV | 用 `mcp.*` 六个键，**不新增表 → 不升 `SCHEMA_VERSION`** |
| 既有执行能力 | `plugin_exec_impl`（`commands/plugin.rs:L491`，SSH/Local，含超时）与 `ssh_exec_impl`（`commands/session.rs`） | `terminal_execute` 直接复用 `plugin_exec_impl` |
| 关闭能力 | `lifecycle::close_resource`（`commands/lifecycle.rs:L932`，需 `kind + owner`） | `session_close` 复用，owner/kind 从注册表读 |
| 会话注册表 | `AppState.lifecycle_sessions`（`state.rs:L77`），新增只读 `lock_sessions()`（`state.rs:L118`） | `get_environment` 数据源 |
| 命令黑名单 | `ai::command_blacklist::load`（`command_blacklist.rs:L91`）+ `sanitize::validate_with`（`sanitize.rs:L374`） | 写工具执行前必过黑名单（与 AI 面板同一套） |
| headless 冲突 | headless 无窗口、无前端 UI，MCP 监听器无意义 | `mcp_status` 只回配置快照（`errorCode: headless_no_listener`）；其余 3 个命令返回 `gui_only` |
| 事件契约 | 后端→前端走 `<domain>:data:<id>` 事件 | MCP 是**入站**请求，不产生新事件；状态由前端轮询 `mcp_status`（对齐 Netcatty 的静默轮询） |

## 3. 依赖选型

- **不引入 `rmcp` / `axum` / `hyper`**：仓库现有 `tokio` 已启用 `net/io-util/time`（`src-tauri/Cargo.toml:L39`），本实现用 `tokio::net::TcpListener` + 手写最小 HTTP/1.1 解析（`src-tauri/src/mcp/server.rs`）。
- JSON-RPC 手写（`dispatch`），仅支持单请求/批量数组，`id` 缺失即通知 → HTTP 202。
- token 用两段 `uuid::Uuid::new_v4()` 拼接（244 位随机），避免新增 RNG 依赖。
- 若后续要 SSE / 双向通知，再评估 `rmcp`（届时需新增依赖并重写传输层）。

## 4. 进程内 server 与 Tauri 生命周期

- 运行态 `McpRuntime` 独立于 `AppState`，以 `McpState(Arc<McpRuntime>)` 单独 `app.manage`（`lib.rs:L170-L171`），避免每个请求抢 DB 锁。
- 启动：`setup` 内读 `mcp.enabled`，开启则 `McpRuntime::start(app.handle().clone(), cfg)`（`lib.rs:L172-L176`）。
- 停止：`mcp_set_config` 里 `enabled=false` → `rt.stop()`；`stop` 用 `AtomicU64 generation` + `Notify` 让 accept 循环退出（旧连接凭 generation 失效）。
- 进程退出不额外清理：socket 随进程释放（与 Netcatty 进程退出一致）。
- 端口绑定冲突 → `port_in_use`；地址不可用 → `invalid_address`；其它 → `listen_failed`，均写回 `McpStatus.error/errorCode`。

## 5. 端口 / 鉴权 / 开关设计

| 项 | 设计 |
| --- | --- |
| 默认端口 | `47391`（与 Netcatty 同值），范围 ≥1024；改动即时重启监听 |
| 默认监听 | `127.0.0.1`；非回环地址必须显式打开 `allowCustomBind`，否则 `custom_bind_disabled` |
| 鉴权 | `Authorization: Bearer <token>`；定长比较防时序侧信道；token 每次启用重新生成，可手动轮换 |
| Host/Origin | 白名单 = `127.0.0.1 / localhost / ::1` + 用户 `clientHost`；不匹配 → 403 `forbidden_host / forbidden_origin` |
| 路径 | 仅 `POST /mcp`；`GET` → 405（不提供 SSE）；`DELETE` → 200；其它 → 404 |
| 体积 | header ≤8KB、body ≤4MB（超限 431/413） |
| 权限档位 | `observer` 全部写拒绝；`confirm` 写工具生成审批项（允许一次 / 始终允许 / 拒绝），只读工具直接放行；`auto` 写放行但仍过命令黑名单 |

## 6. 工具清单与映射

已实现（`src-tauri/src/mcp/tools.rs`）：

| 工具 | 类型 | 映射到 | 备注 |
| --- | --- | --- | --- |
| `get_environment` | 只读 | `AppState.lifecycle_sessions` + `db::profile::list` | 返回 `sessions[{id,kind,phase}]` 与 `hostCount`；同时对 `termx://environment` resource 提供同一快照 |
| `vault_hosts_list` | 只读 | `db::profile::list` | 只回 `id/name/host/port/groupId`，**不回凭据** |
| `snippets_list` | 只读 | `db::snippet::load` | 回 `id/name/package/command/description` |
| `terminal_execute` | 写 | `plugin::plugin_exec_impl` | `timeoutMs` 默认沿用 impl；执行前 `validate_with` 过黑名单；owner 从注册表取 |
| `session_close` | 写 | `lifecycle::close_resource` | kind/owner 从注册表取，避免越权关闭他人会话 |

### 6.1 写操作审批（confirm）

对齐 Netcatty `mcpServerBridge` 的 approval gate，落在 `src-tauri/src/mcp/approval.rs`：

- 触发：`confirm` 档位下的 `terminal_execute` / `session_close`。参数校验（缺失参数、命令黑名单、会话不存在）先做，通过后才生成审批项。
- 待审批项：`approvalId / toolName / argsSummary / sessionId / targetLabel / timeoutMs / createdAtMs`；主进程通过 `mcp:approval-request` 广播，结算后广播 `mcp:approval-cleared`（`approvalIds + reason`）。
- 前端：`src/mcp/McpApprovalHost.tsx` 常驻主窗右下角，提供「允许一次 / 始终允许该工具 / 拒绝」；窗口不在前台时后端 `request_user_attention` 闪任务栏。
- 超时：110 秒（外部客户端常见 120 秒工具调用上限之前），到时按拒绝结算。
- 断开与重启：读写半连接拆分后监听客户端 EOF，断开即拒绝；`McpRuntime::stop` / `start`（generation++）会拒绝全部挂起项，重启后不残留悬空等待。
- 「始终允许」：按工具粒度存 `mcp.allowed_tools`（settings KV，JSON 数组），重启后仍生效；设置页 confirm 档位下列出已允许工具并可撤销。
- 只读工具（`get_environment` / `vault_hosts_list` / `snippets_list`）不进入审批。

未实现（与 Netcatty 对应关系，**不注册假工具**）：

| Netcatty 工具组 | 未实现原因 | 补齐前提 |
| --- | --- | --- |
| `terminal_start / poll / stop` | termX 有 SSH/PTY 会话创建，但没有「MCP 拥有并可见于 UI 的 tab」语义；`SessionOwner::Headless` 开的会话前端不可见 | 需要前端 tab 绑定 + 关闭事件回放（Phase 2） |
| `sftp.*`（11 个） | `commands/sftp.rs` 只有 `#[tauri::command]` 直连 `State`，没有 `*_impl` 可复用；MCP 不能持有 `State` | 先把 sftp 命令抽成 `*_impl(state, ...)`（与 plugin/session 同风格） |
| `vault.host.open` | 依赖上面两条 | Phase 2 |
| `vault.notes.*` / `scripts.*` / `snippets.*` 写 | 未暴露写入口（只读已覆盖） | 按需求逐项开 |
| `portforward.*` | 代理与端口转发已按既定决策暂停 | 恢复该模块后同步开 |
| `attachments` / `web_search` / `web_fetch` | termX 无对应能力 | 不移植 |
| `load_netcatty_tools` 渐进式加载 | termX 只有 5 个工具，无需渐进 | 工具数 > 15 时再引入分组 |
| stdio 传输 / Node launcher | 单进程 Tauri，HTTP 已覆盖主流客户端 | 若必须支持仅 stdio 的客户端，再单独做 `termx-mcp-stdio` 小二进制 |

## 7. 失败与取消语义

- 工具业务失败 → `tools/call` 返回 `content[0].text` + `isError: true`（不抛 JSON-RPC error），与 Netcatty 一致。
- 参数缺失 → `isError` + `missing_argument`；未知工具 → `isError` + `unknown_tool`。
- 审批拒绝 / 超时 / 客户端断开 → `isError` + `permission_denied`，由外部客户端自行处理。
- 方法不存在 → JSON-RPC `-32601`；`resources/read` 未知 uri → `-32602`；解析失败 → `-32700`。
- 取消：**未实现** `notifications/cancelled` 与 AbortSignal 透传；`terminal_execute` 靠 `timeoutMs` 兜底（`plugin_exec_impl` 自带超时）。

## 8. 日志与调试入口

- 监听/accept 失败：`log::warn!("mcp accept failed: ...")`；autostart 失败 `log::warn!("mcp autostart failed: ...")`。
- 前端可见错误：`McpStatus.error` + `errorCode`（`port_in_use / invalid_address / listen_failed / custom_bind_disabled / mcp_restarted`）。
- 手工调试：`curl -s -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:47391/mcp`。

## 9. 前端 UI 落点

- 数据出口：`src/backend/client.ts` 9 个函数（状态 / 改配置 / 轮换 token / 客户端片段 / 待审批 / 结算 / 撤销始终允许）。
- 审批浮层：`src/mcp/McpApprovalHost.tsx`，常驻 `App.tsx` 根节点，不受当前页面切换影响。
- 组件落点：`src/settings/AiTab.tsx`（新建，已在 `SettingsDialog.tsx` 启用 ai tab），结构与 Netcatty `ExternalMcpCard` 对齐：标题+说明+状态胶囊、错误条、启用开关、权限三档、端口/监听地址/允许自定义绑定/客户端 host、连接详情折叠区（URL / 打码 token / 轮换 / Codex TOML / Claude 命令 / 通用 JSON）、3 秒静默轮询。
- 文案：`src/settings/i18n.ts` 中英文 `settings.ai.*` 与 `mcp.approval.*`；样式追加在 `src/styles.css` 的 `.nc-mcp-*` / `.mcp-approval-*`。
- 与 Netcatty 的差异：无 `env` 片段入口（后端支持但 UI 未展示，避免超出三片段范围）。

## 10. 风险与不做的部分

1. **任意命令执行面**：`terminal_execute` 等价于「持有 token 的人可在已打开会话里执行任意命令」，仅靠命令黑名单（49 条种子）与权限档位约束；默认 `confirm` 且默认关闭监听，是当前唯一的兜底。**不做**命令白名单/路径白名单。
2. **跨进程权限边界**：单机 loopback + Bearer，无 OS 级 ACL；同机同用户进程可读 token（内存/设置页复制）。Netcatty 同样如此。
3. **审批绕过面**：`auto` 档与「始终允许」会跳过确认。默认为 `confirm` 且默认关闭监听；「始终允许」可在设置页撤销。
4. **会话所有权**：MCP 不是会话 owner，`plugin_exec_impl` 用的是注册表里的真实 owner；若 owner 是某个窗口，MCP 实质是替该窗口执行。这是为「不越权」付出的语义折中，需在 UI 提示。
5. **headless**：不启动监听器，只读配置快照，避免无界面进程偷偷开端口。
6. **不新增 schema 表**：纯 settings KV，故 `SCHEMA_VERSION` 不变；如未来要给 MCP 建审计表再提升版本。
7. **不做的**：SSE 服务端推送、stdio launcher、OAuth、多客户端 session 管理（当前无状态、无 `Mcp-Session-Id`）、渐进式工具加载。

## 11. 验证状态

### 11.1 构建与门禁

- `cargo check --lib --offline`：通过（修复 4 处编译错误后复跑 exit 0）。
- `npx tsc --noEmit`：通过（`npm install` 后执行，exit 0）。
- 完整门禁（vitest / build / cargo test）见 `changelogs.md` 的 MCP 条目。

### 11.2 Trae CN 3.4.15 真实客户端联调（2026-11-08）

**Trae 配置位置与写法**：`%APPDATA%\Trae CN\User\mcp.json`（用户级）。

```json
{
  "mcpServers": {
    "termx": {
      "url": "http://127.0.0.1:47391/mcp",
      "headers": { "Authorization": "Bearer <设置页复制的 token>" }
    }
  }
}
```

- 只需 `url` + `headers`，**不需要** `"type"`（Trae 直接按 streamable-http 处理）。
- token 来自 设置 → AI → 工具接入 → 连接详情；打码展示，点「轮换」可重新生成。
- 联调时插了一层本地观测代理（`127.0.0.1:47392` → 转发 47391），用于完整抓取 Trae 的请求头/报文；正式使用时把 `url` 直接写 `47391` 即可。

**Trae 的握手序列（实测）**：

1. `POST /mcp` `initialize`：`protocolVersion: "2025-11-25"`，`clientInfo {name:"Trae",version:"3.4.15"}`，`capabilities.extensions` 带 `io.modelcontextprotocol/ui`；`User-Agent: Trae/3.4.15`，`Accept: application/json, text/event-stream`。
2. `POST /mcp` `notifications/initialized`（无 id，TermX 回 202），带 `mcp-protocol-version: 2025-11-25` 头。
3. `GET /mcp` `Accept: text/event-stream` —— **SSE 探测**，termX 回 `405 {"error":"sse_not_supported"}`。
4. `POST /mcp` `tools/list`，之后每次请求都带 `mcp-protocol-version` 头。

**结论**：

- **SSE 不需要做**：Trae 收到 405 后未重试、未报错，继续 `tools/list` 并正常工作；其 POST 请求由 `Accept: application/json, text/event-stream` 覆盖，termX 回纯 JSON 即可。
- **`Mcp-Session-Id` 不需要**：Trae 既不发送也不期待；termX 无状态、每请求独立可正常工作。
- Trae 容忍服务端 `Connection: close`（termX 每响应即关连接），不要求 keep-alive。
- `mcp-protocol-version` 头 termX 目前忽略即可；Trae 不因缺失而失败。

**5 个工具实调结果（confirm / observer / auto 三档）**：

| 工具 | 档位 | 结果 |
| --- | --- | --- |
| `get_environment` | confirm / observer / auto | `isError:false`，返回 `hostCount:7`、2 个 pty 会话（含 phase） |
| `vault_hosts_list` | confirm / observer / auto | `isError:false`，7 台主机，仅元数据无凭据 |
| `snippets_list` | confirm / observer / auto | `isError:false`，5 个片段元数据 |
| `terminal_execute` | observer | `isError:true` + `permission_denied: 当前权限档位为 observer，写操作被拒绝`（8ms） |
| `terminal_execute` | auto | `isError:false`，`exitCode:0`、`stdout:"trae-auto-ok"`（35ms） |
| `terminal_execute` | confirm + 允许一次 | 请求挂起约 4.2s，点「允许一次」后 `exitCode:0`、`stdout:"approval-once"` |
| `terminal_execute` | confirm + 始终允许 | 挂起约 8.7s 后放行；`mcp.allowed_tools` 变 `["terminal_execute"]`，**后续调用 30ms 免审批** |
| `session_close` | auto | `isError:false`，`{"closed":"<sessionId>"}`，`get_environment` 里该会话 phase 变 `closed` |
| `session_close` | confirm + 拒绝 | 挂起约 3.7s，点「拒绝」后 `isError:true` + `permission_denied`，会话仍为 `ready` |

**审批浮层实测**：三按钮文案为「允许一次 / 始终允许 terminal_execute / 拒绝」，悬浮于主窗右下角；confirm 档下只读工具不触发浮层。

**需要用户知道的遗留点**：

1. **改任何 MCP 配置都会重启监听并轮换 token**（`apply()` 无条件 `rt.start()`，`start` 里 `new_token()`）。因此切权限档、改端口后，Trae/Claude 里的旧 token 立即失效，必须重新复制；若 Trae 未自动重连，需要重载 MCP 配置或重启 IDE。这是当前实现的副作用，后续可优化为「仅连接参数变化才重启」。
2. **MCP 工具在 Trae 会话里的可见性取决于会话建立时机**：服务上线前就已创建/续接的会话，其工具表不会注入这 5 个工具（本轮 Trae 自身完成了 initialize / initialized / tools/list / SSE 探测，但模型侧未拿到工具，`tools/call` 是用同一报文特征回放执行的）。要在 Trae 里让模型直接调用，请新开一个会话。
3. 本轮结束时的本机状态：`mcp.enabled = 开`、`permissionMode = confirm`、`allowedTools = []`（如不希望常驻监听，请在设置页关闭；关闭后 Trae 连接即失效）。
4. `McpApprovalHost` 只在主窗渲染；实测设置页打开时浮层仍压在设置之上可见（右下角显示待审批条数 + 倒计时），不需要切回主界面。
