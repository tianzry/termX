# termX MCP 接入指南

> 面向第一次接触 termX MCP 的使用者。本文内容以代码为准：`initialize.instructions`、工具的 `description` / `inputSchema`、设置页「接入指南」都来自 `src-tauri/src/mcp/guide.rs` 与 `src-tauri/src/mcp/tools.rs`。如果本文与界面文案不一致，以界面/协议返回为准并提 issue。

## 1. termX MCP 是什么

termX 是本机的 SSH / 串口 / 终端客户端。开启 MCP 服务后，termX 会在本机启动一个 Streamable HTTP 端点（默认 `http://127.0.0.1:47391/mcp`），把**已保存的主机**和**已打开的会话**以 22 个工具暴露给外部 AI 客户端（Qoder、Claude Desktop、Cursor、Claude Code 等）。

工具分三个平面：

- **控制平面（typed）**：`fs_read` / `fs_grep` / `fs_glob` / `fs_patch` / `fs_write` / `sftp_put` / `sftp_get` / `fs_delete` / `build_run`，按文件语义操作，token 成本与文件大小无关。
- **逃生平面（pty/exec）**：`term_run` 执行任意非交互命令，只拦真正破坏性的操作；`terminal_execute` 覆盖 ssh / pty / serial / telnet 四类会话（串口 / Telnet 为「写入 + 采集」，没有 exitCode）。
- **字节写（串口 / Telnet）**：`serial_write` / `telnet_write` 只把字节发到线路并返回 `bytesWritten`，没有命令与 `exitCode` 语义。

调用方向是单向的：

```text
外部 AI 客户端  ──HTTP POST + Bearer token──▶  termX MCP 服务  ──▶  termX 内已打开的会话 / vault 主机
```

`sessionId` 必须来自 `get_environment`；`hostId` 来自 `hosts[]` 或 `vault_hosts_list`。**传 `hostId` 时会按 vault 档案自动建连**（`SessionOwner::Headless`，与 UI 同链路：堡垒机链 / 代理 / known_hosts / 录制 / 发行版探测），无需先在 termX 里打开窗口。

**会话隔离**：服务端在 `initialize` 响应头下发 `Mcp-Session-Id`，客户端之后每次请求需带回该头（MCP 规范行为）。不同 MCP 会话各自独立：自动建连（`origin: "mcp"`）的会话只对建立它的会话可见，用户窗口会话共享，因此多个 agent 共用一个 token 也不会互相串会话。未带会话头的无状态请求按 `User-Agent` 区分客户端，仍无 UA 时才按共享的默认身份处理；服务端不认识的会话 id 返回 404，客户端重新 `initialize` 即可。

## 2. 快速开始

### 2.1 开启服务

进入 **设置 → AI → 工具接入**：

1. 打开「启用 MCP 服务」。
2. 端口默认 `47391`，允许范围 ≥ 1024。
3. 监听地址默认 `127.0.0.1`（仅本机可访问）。
4. 权限档位默认「确认」；初次接入建议保持该档位。
5. 远端路径（`path` / `remotePath` / `cwd`）支持绝对路径、`~` 与相对 home 的路径，不限制目录范围；`localPath` 只要求是绝对路径。一个 token 可服务多个会话与任意工作目录。
6. 右上角状态显示「运行中」即监听成功。

如果启动失败，状态会显示错误码：

| 错误码 | 含义 |
| --- | --- |
| `invalid_port` | 端口小于 1024 或非法 |
| `invalid_address` | 监听地址为空，或系统无法绑定该地址 |
| `custom_bind_disabled` | 绑定非回环地址前未打开「允许自定义绑定」 |
| `port_in_use` | 端口已被其它程序占用 |
| `listen_failed` | 其它监听失败原因，详情见错误信息 |

### 2.2 获取 URL 与 token

在「连接详情」里可以直接查看/复制：

- **URL**：`http://127.0.0.1:47391/mcp`（填了「客户端 host」时用该 host 生成）。
- **Bearer token**：默认打码显示，点复制取完整值；点「轮换 token」会生成新 token，旧 token 立即失效。

token 只在手动轮换时更换。关闭再开启服务、修改权限档位、重启 termX 都会沿用同一个 token。

### 2.3 客户端配置

设置页「接入指南」里每块都有独立复制按钮，下面的片段与它一致。

**Qoder** — 写入 `~/.qoder/settings.json` 的 `mcpServers`（Windows 为 `%USERPROFILE%\.qoder\settings.json`）：

```json
{
  "mcpServers": {
    "termx": {
      "url": "http://127.0.0.1:47391/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

**Claude Desktop** — 写入 `claude_desktop_config.json`，需要客户端版本支持 HTTP transport：

```json
{
  "mcpServers": {
    "termx": {
      "url": "http://127.0.0.1:47391/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      },
      "type": "http"
    }
  }
}
```

**Cursor** — 写入 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "termx": {
      "url": "http://127.0.0.1:47391/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      },
      "type": "http"
    }
  }
}
```

> 三个配置里的 `<token>` 都要换成设置页复制的真实值。客户端必须能发送 `Authorization: Bearer <token>` 请求头。

### 2.4 验证接通

用设置页复制的 curl 三步，或手动执行下面三条：

```bash
URL='http://127.0.0.1:47391/mcp'
TOKEN='<token>'
AUTH="Authorization: Bearer $TOKEN"

# 1) initialize
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2) tools/list
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 3) tools/call（列出当前环境）
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_environment","arguments":{}}}'
```

接通成功的标志：

- `initialize` 的 `result.serverInfo.name` 是 `termX`，并带有非空 `instructions`；
- `tools/list` 返回 22 个工具：`get_environment`、`vault_hosts_list`、`snippets_list`、`terminal_execute`、`session_open`、`set_session_preamble`、`session_close`、`serial_write`、`serial_read`、`telnet_write`、`telnet_read`、`fs_read`、`fs_grep`、`fs_glob`、`fs_patch`、`fs_write`、`sftp_put`、`sftp_get`、`fs_delete`、`build_run`、`term_run`、`batch`；
- `tools/call` 返回 `content[0].text`，能解析出 `code`、`message`、`hint` 与业务字段。

## 3. 工具参考

### 3.0 统一返回约定

`tools/call` 的协议层结果是：

```json
{
  "content": [{ "type": "text", "text": "<这里的 JSON 字符串>" }],
  "isError": false
}
```

`text` 内的 JSON 有两种形态：

- 成功：`{ "code": "ok", "message": "...", "hint": "...", ...业务字段 }`
- 失败：`{ "code": "<错误码>", "message": "...", "hint": "..." }`，且外层 `isError` 为 `true`

`hint` 是给 agent 的下一步建议，出错时先按它自纠。只读工具（前三个）原有业务字段保持不变。

### 3.1 `get_environment`

**用途**：返回当前活跃会话和已保存主机清单，是拿 `sessionId` / `hostId` 的入口。`sessions` 只包含本 MCP 会话可见的会话：用户窗口打开的会话 + 本会话自动建连的会话。

**该用**：会话开始时；调用其它工具前确认目标会话或主机存在。
**不该用**：只需要主机清单时也可用 `vault_hosts_list`；不要用它轮询等待新会话。

参数：无。

返回示例（`content[0].text` 解析后）：

```json
{
  "code": "ok",
  "message": "已返回当前环境快照",
  "hint": "用 sessions[].id 或 hosts[].id 作为后续工具的 sessionId / hostId；hostId 无就绪会话时会自动建连。",
  "cacheable": true,
  "ttl": 30,
  "sessions": [
    { "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "kind": "ssh", "phase": "ready", "hostId": "h-01", "origin": "window" },
    { "id": "6b8f2c14-2f6a-4d0e-9a55-8f0d1c2e4a71", "kind": "serial", "phase": "ready", "origin": "window" }
  ],
  "hosts": [
    { "id": "h-01", "name": "dev", "host": "10.0.0.5", "port": 22, "groupId": "g-1" }
  ],
  "hostCount": 3
}
```

`kind` 可能为 `ssh` / `pty` / `serial` / `telnet` / `sftp` / `forward`；`phase` 为 `pending` / `ready` / `closed`；`origin` 为 `window`（UI 打开）或 `mcp`（MCP 自动建连）。

常见错误：`internal_error`（本地数据库读取失败，重试或查看 termX 日志）。

### 3.2 `vault_hosts_list`

**用途**：列出已保存主机（不含任何凭据）。

**该用**：想知道用户保存了哪些主机、该选哪台时。
**不该用**：查活跃会话用 `get_environment`；本工具不会打开连接，也不会执行命令。

参数：无。

返回示例：

```json
{
  "code": "ok",
  "message": "已返回已保存主机清单",
  "hint": "这些主机尚未打开连接；要执行命令需先在 termX 中打开会话，再调用 get_environment。",
  "hosts": [
    { "id": "h-001", "name": "prod-web", "host": "192.168.1.10", "port": 22, "groupId": "prod" }
  ]
}
```

常见错误：`internal_error`。

### 3.3 `snippets_list`

**用途**：列出已保存的代码片段/命令，便于复用。

**该用**：需要复用用户预置命令或脚本时。
**不该用**：不要用本工具执行命令；执行请用 `terminal_execute`。

参数：无。

返回示例：

```json
{
  "code": "ok",
  "message": "已返回已保存代码片段",
  "hint": "找到目标命令后，用 terminal_execute 在指定会话中执行。",
  "snippets": [
    {
      "id": "s-001",
      "name": "查看磁盘",
      "package": "运维",
      "command": "df -h",
      "description": "列出各分区使用率"
    }
  ]
}
```

注意：`command` 字段可能包含敏感信息，不要把返回内容原样发到不可信位置。

常见错误：`internal_error`。

### 3.4 `terminal_execute`

**用途**：在已打开的会话里执行一条命令。四类终端都支持，语义按 `kind` 区分：

| 会话 kind | 执行方式 | 返回要点 |
| --- | --- | --- |
| `ssh` | 在既有连接上新开 exec channel，一次性收取输出 | `stdout` / `stderr`（各只回尾部 `maxOutputBytes`）/ `exitCode` / `stdoutBytes` / `stderrBytes` / `totalBytes` / `truncated` |
| `pty`（本地终端） | 每次调用新起子进程（POSIX `sh -c` / Windows `cmd /C`）一次性收取输出；**不写入用户可见的终端 pane**，也不继承该 pane 的 cwd / 环境 | 同 `ssh` |
| `serial` / `telnet` | 写入「命令 + `lineEnding`」，再从会话输出流采集，直到 `idleMs` 静默 / `waitRegex` 命中 / `timeoutMs` 超时；**没有命令边界与退出码** | `stdout`（采集文本）/ `exitCode: null` / `bytesWritten` / `bytesRead` / `terminatedBy` / `idleMs` / `timeoutMs` / `encoding` / `truncated` |

**该用**：需要与目标会话交互、查看输出或运行命令时；最常见的是 SSH。
**不该用**：只查询会话/主机清单时用只读工具；串口 / Telnet 只需要写字节时用 `serial_write` / `telnet_write`。
**约束**：写操作，受权限档位和命令黑名单约束。判定顺序固定为「类型校验 → 长度校验（4096 字节）→ 黑名单 → 审批 → 执行」。

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| `sessionId` | string | 是 | `get_environment` 返回的 `sessions[].id`（UUID） | `"3f2504e0-4f89-11d3-9a0c-0305e82c3301"` |
| `command` | string | 是 | 单条非空命令 | `"uname -a"` / `"AT+GMR"` |
| `timeoutMs` | integer | 否 | 总超时毫秒，范围 1000–60000，默认 30000。ssh / pty 为执行超时，serial / telnet 为采集总超时 | `30000` |
| `maxOutputBytes` | integer | 否 | 仅 ssh / pty。`stdout`、`stderr` 各自保留的尾部字节数，范围 256–65536，默认 16384；超出时 `truncated=true` | `16384` |
| `idleMs` | integer | 否 | 仅 serial / telnet。连续多少毫秒无新数据视为响应结束，范围 50–5000，默认 500 | `500` |
| `waitRegex` | string | 否 | 仅 serial / telnet。累计输出命中该正则即提前结束采集（Rust regex 语法） | `"OK\|ERROR"` |
| `lineEnding` | string | 否 | 仅 serial / telnet。命令后追加的行结束符：`crlf`(默认) / `lf` / `cr` / `none` | `"crlf"` |
| `encoding` | string | 否 | 仅 serial / telnet。`stdout` 编码：`utf8`(默认，非法字节按 `from_utf8_lossy` 替换) / `base64`（返回采集到的原始字节） | `"utf8"` |

SSH / pty 返回示例：

```json
{
  "code": "ok",
  "message": "命令执行完成",
  "hint": "如需在同一会话继续执行，复用相同的 sessionId；任务结束调用 session_close。",
  "stdout": "Linux web-01 6.1.0 x86_64 GNU/Linux\n",
  "stderr": "",
  "exitCode": 0,
  "stdoutBytes": 37,
  "stderrBytes": 0,
  "totalBytes": 37,
  "truncated": false
}
```

> ssh / pty 默认只保留 `stdout`、`stderr` 各自最后 16 KiB（`maxOutputBytes` 可调到 256–65536）。`truncated=true` 表示有内容被截掉；需要完整日志时，把命令输出重定向到远端文件再用 `fs_read` 翻页，或改用 `build_run` 的 `teeToRemoteFile`。

serial / telnet 返回示例（没有退出码，不伪造 0）：

```json
{
  "code": "ok",
  "message": "serial 命令已写入并完成采集",
  "hint": "exitCode 恒为 null（串口 / Telnet 没有命令边界与退出码），结束原因见 terminatedBy。用户正在查看的终端会同时收到同一份字节（物理链路决定的），不要重复解析。",
  "sessionId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "stdout": "AT+GMR\r\r\nAT version:1.7.4.0\r\nOK\r\n",
  "exitCode": null,
  "bytesWritten": 8,
  "bytesRead": 34,
  "terminatedBy": "idle",
  "idleMs": 500,
  "timeoutMs": 30000,
  "encoding": "utf8",
  "truncated": false
}
```

> 串口 / Telnet 的采集复用会话既有的读线程：**用户正在看的终端会同时收到同一份字节**（一条物理链路不存在独占读取），MCP 只是多一个订阅者。`terminatedBy` 取值 `idle` / `pattern` / `timeout` / `closed`。

常见错误：

| code | 现象 | 处理 |
| --- | --- | --- |
| `missing_argument` | 缺少 `sessionId` 或 `command` | 按上表补齐；`sessionId` 必须来自 `get_environment` |
| `invalid_argument` | `waitRegex` 非法、`idleMs` / `timeoutMs` 不是整数、`lineEnding` / `encoding` 取值不支持 | 按提示改用合法取值 |
| `session_not_found` | 会话不存在或已关闭 | 重新 `get_environment` 拿新的 id |
| `mcp_session_not_ready` | 会话存在但 `phase` 不是 `ready`（串口未打开、SSH 仍在建连 / 已关闭、句柄已释放） | 先在 termX 里打开会话，再 `get_environment` 确认 `phase=ready` |
| `mcp_unsupported_session_kind` | 会话是 SFTP / 端口转发等确实没有命令通道的类型（类型判定在审批之前，不会弹窗） | 改用 ssh / pty / serial / telnet 会话 |
| `plugin_exec_command_too_long` | 命令超过 4096 字节（长度校验在审批之前） | 拆分为多条命令，或把长脚本写入远端文件再执行 |
| `command_blocked` | 命令命中黑名单 | 换用等价但更具体的命令，或请用户调整黑名单 |
| `permission_denied` | 权限档位为 observer，或审批被拒/超时 | 请用户在设置里放行或切换档位 |
| `plugin_exec_timeout` / `plugin_exec_spawn_failed` / `session_owner_mismatch` | 执行链路自身失败（不再折叠成 `execute_failed`） | 确认会话仍为 `ready` 后重试；持续失败查看 termX 日志 |
| `internal_error` | 本地读取失败 | 重试；持续失败查看 termX 日志 |

### 3.5 `session_close`

**用途**：关闭指定会话。

**该用**：你打开且任务已完成、或明确需要释放会话资源时。
**不该用**：用户正在使用的会话不要关闭；会话不存在时先 `get_environment` 确认。
**约束**：写操作，受权限档位约束。

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| `sessionId` | string | 是 | `get_environment` 返回的 `sessions[].id`（UUID） | `"3f2504e0-4f89-11d3-9a0c-0305e82c3301"` |

返回示例：

```json
{
  "code": "ok",
  "message": "会话已关闭",
  "hint": "如需再次连接，请先在 termX 中重新打开会话，再调用 get_environment。",
  "closed": "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
}
```

常见错误：

| code | 现象 | 处理 |
| --- | --- | --- |
| `missing_argument` | 缺少 `sessionId` | 补齐参数 |
| `session_not_found` | 会话不存在 | 重新 `get_environment` |
| `permission_denied` | observer 档位或审批未通过 | 请用户放行 |
| `close_failed` | 关闭链路失败 | 重新确认会话是否仍存在；已关闭可忽略 |

### 3.5.1 会话 preamble（`set_session_preamble` / `session_open.preamble`）

**用途**：给一个 SSH 会话注册一次性的 setup 命令（例如 `source ~/zephyrproject/zephyr/zephyr-env.sh`），之后该会话每次 `term_run` / `build_run` 都按 `cd → preamble → env → command` **确定性重放**（本次 `env` 最后覆盖 preamble 的同名变量）。不是有状态 shell：termX 不会保留远端 shell，preamble 只是每次拼进脚本的固定前缀，因此不会出现「这条命令跑在上一条命令的环境里」的隐藏状态。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionId` / `hostId` | string | 二选一 | `hostId` 无就绪会话时按 vault 档案自动建连 |
| `preamble` | string | 是 | setup 命令（可多行，≤ 8 KiB）；**空串表示清除** |

- `session_open` 也接受同名 `preamble` 参数（仅 `kind=ssh`），建链成功后立即注册。
- preamble 只影响当前 MCP 会话可见的该 SSH 会话，不影响用户窗口或其它 MCP 会话；`session_close` 成功时一并清除。
- 一次性环境差异用 `term_run` / `build_run` 的 `env`，不要为每条命令都改 preamble。
- 写操作，受权限档位约束；preamble 本身也要通过破坏性命令策略检查。

返回示例：

```json
{
  "code": "ok",
  "message": "会话 preamble 已设置",
  "hint": "该 preamble 只影响本会话：每次 term_run / build_run 前重放，不影响用户窗口或其它 MCP 会话。",
  "sessionId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "preamble": "source ~/zephyrproject/zephyr/zephyr-env.sh",
  "cleared": false
}
```

### 3.6 文件 / 传输 / 构建工具

这些工具都接受 `sessionId` **或** `hostId`（`anyOf`，二选一）；`hostId` 无就绪会话时自动按 vault 档案建连。远端路径支持绝对路径、`~` 与相对 home 的路径，不限制目录范围；`localPath` 只要求是绝对路径。

| 工具 | 类型 | 主要参数 | 返回要点 |
| --- | --- | --- | --- |
| `fs_read` | 只读 | `path` / `startLine`(1) / `maxLines`(200，≤2000) / `numbered`(true) | `lines` / `totalLines` / `size` / `truncated` / `nextCursor` |
| `fs_grep` | 只读 | `pattern` / `path` / `glob`(`*`) / `regex`(true) / `ignoreCase` / `contextLines`(0–3) / `maxResults`(50，≤200) / `cursor` | `matches[{path,line,text}]` / `total` / `truncated` / `nextCursor` |
| `fs_glob` | 只读 | `pattern` / `path` / `maxResults`(50，≤200) / `cursor` | `matches[{path,size}]` / `total` / `nextCursor` |
| `fs_patch` | 写 | `edits[{path, ops:[{oldText,newText,replaceAll}]}]`（≤20 文件）/ `dryRun` | `results[{path,applied,sha256,diff}]` |
| `fs_write` | 写 | `path` / `content`(≤512 KiB) / `overwrite`(false) | `path` / `size` / `sha256` / `created` |
| `sftp_put` | 写 | `items[{localPath,remotePath}]`（≤2000）/ `overwrite`(false) / `recursive`(false) | `ok` / `failed` / `results[{...,size,sha256,status}]` |
| `sftp_get` | 写 | `items[{remotePath,localPath}]` / `overwrite`(false) / `recursive`(false) | 同上 |
| `fs_delete` | 写 | `paths`(≤200) / `recursive`(false) / `dryRun`(**true**) / `confirmToken` | dry-run：`wouldDelete` + `confirmToken`；执行：`deleted` |
| `build_run` | 写 | `command` / `cwd` / `env` / `timeoutMs`(120s) / `maxOutputBytes`(16 KiB) / `teeToRemoteFile` | `exitCode` / `stdoutTail` / `stderrTail` / `totalBytes` / `truncated` / `fullLog` |
| `term_run` | 写 | `command` / `cwd` / `env` / `timeoutMs`(30s) / `maxOutputBytes`(16 KiB) | 同上（无 `fullLog`），另回 `cwd` / `preambleApplied` |
| `batch` | 写 | `ops[{tool,args}]`(1–50) / `stopOnError`(true) | `results[{tool,isError,result}]` / `failed` |

关键行为：

- **fs_patch**：`oldText` 必须唯一；不唯一返回 `ambiguous` + 候选行号，加长上下文或 `replaceAll=true`。`dryRun=true` 只回 unified diff。
- **fs_write / sftp_***：`overwrite` 默认 false，已存在返回 `mcp_file_exists` / `mcp_local_file_exists`；本地路径必须是绝对路径。
- **fs_delete**：`dryRun` 默认 true；把返回的 `confirmToken` 原样带回并置 `dryRun=false` 才会删除。token 5 分钟过期、绑定会话/路径/递归、取用即失效。**任何权限档位都需要 token。**
- **build_run**：远端把 stdout/stderr 落到临时文件后取**尾部**，失败信息不会因日志过长被丢掉；`teeToRemoteFile` 写完整日志（stdout 后接 stderr），失败回 `teeFailed=true`。
- **term_run / build_run**：只拦破坏性命令（`rm -rf /`、`mkfs`、`dd of=/dev/*`、关机、fork 炸弹等），不套 `terminal_execute` 的全量黑名单。
- **cwd / env**：执行顺序固定为 `cd → 会话 preamble → export → command`，每次调用都重新拼装，不继承上一条命令的 shell 状态。`env` 是「变量名 → 字符串」对象（最多 64 个，名字须匹配 `[A-Za-z_][A-Za-z0-9_]*`，值走 POSIX 单引号转义）；`cwd` 进不去返回 `mcp_cwd_invalid`。
- **后台进程**：`term_run` 每次都是全新的远端 shell，`cmd &` 会随 shell 退出被回收；要常驻请 `setsid nohup <cmd> </dev/null >/tmp/task.log 2>&1 & echo $!`，再轮询日志。
- **batch**：只允许 `fs_read` / `fs_grep` / `fs_glob` / `fs_patch` / `fs_write`；`fs_delete` / `build_run` / `term_run` / `sftp_*` 与嵌套 `batch` 会被拒绝（`batch_tool_not_allowed`）。

### 3.7 串口 / Telnet 字节写

这两个工具只接受对应传输的会话（`serial_write` → `kind=serial`，`telnet_write` → `kind=telnet`），不做命令解析、不等 `exitCode`，返回实际写出的字节数。

| 工具 | 类型 | 主要参数 | 返回要点 |
| --- | --- | --- | --- |
| `serial_write` | 写 | `sessionId` / `data` / `encoding`(`utf8` \| `base64`，默认 utf8) | `sessionId` / `bytesWritten`（按会话字符集转码后） |
| `telnet_write` | 写 | 同上 | `sessionId` / `bytesWritten`（含 IAC 转义） |

关键行为：

- `bytesWritten` 是**交给传输层**的字节数：串口按会话字符集转码后的长度，Telnet 含 IAC 转义。UTF-8 文本在直连环回时与 `data.len()` 一致。
- Telnet 不做会话字符集转换；GBK 等内容用 `encoding=base64` 传已编码字节。
- 工具只写不读，设备回复请在 termX 终端查看；需要在 MCP 里读回响应时用 `terminal_execute`（serial / telnet 分支会写入后采集，见 3.4）。
- 对 SSH 会话调用返回 `mcp_unsupported_session_kind`；串口 / Telnet 会话调用 `fs_*` / `sftp_*` / `build_run` / `term_run` / `batch` 同样返回该错误码（`terminal_execute` 例外，四类终端都支持）。

## 4. 推荐调用顺序与示例

```text
get_environment（拿 sessionId / hostId / hosts）
   ├─ fs_glob → fs_grep → fs_read            查阅（先定位再开窗）
   ├─ fs_patch dryRun → fs_patch 落盘        修改（小文件整体覆盖用 fs_write）
   ├─ sftp_put → build_run → sftp_get        上传源码 → 编译 → 下载产物
   ├─ fs_delete dryRun → fs_delete + token   删除（两次确认）
   ├─ batch [fs_grep, fs_read, fs_patch]     一次往返完成「搜索→读→改」
   └─ term_run / session_close               逃生执行 / 释放会话
```

### 示例 1：握手并查看环境

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "curl", "version": "1.0" }
  }
}
```

响应（`instructions` 有删节）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": { "listChanged": false },
      "resources": { "subscribe": false, "listChanged": false }
    },
    "serverInfo": { "name": "termX", "version": "0.0.1" },
    "instructions": "termX 是本机的 SSH / 串口 / 终端客户端；…（完整内容见设置页 system prompt 块）"
  }
}
```

### 示例 2：执行命令（确认档位下会弹审批）

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "terminal_execute",
    "arguments": {
      "sessionId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "command": "uname -a",
      "timeoutMs": 30000
    }
  }
}
```

用户在审批浮层点「允许一次」后的响应：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"code\":\"ok\",\"message\":\"命令执行完成\",\"hint\":\"如需在同一会话继续执行，复用相同的 sessionId；任务结束调用 session_close。\",\"stdout\":\"Linux web-01 6.1.0 x86_64 GNU/Linux\\n\",\"stderr\":\"\",\"exitCode\":0}"
      }
    ],
    "isError": false
  }
}
```

用户拒绝或 110 秒内未处理时的响应（`content[0].text` 解析后）：

```json
{
  "code": "permission_denied",
  "message": "terminal_execute 的审批被拒绝、超时或客户端已断开",
  "hint": "写操作受「设置 → AI → 工具接入」权限档位约束：observer 只读拒绝、confirm 需用户在 termX 弹窗中允许、auto 直接放行。"
}
```

外层 `isError` 为 `true`。

### 示例 3：任务结束，关闭会话

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "session_close",
    "arguments": { "sessionId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }
  }
}
```

响应：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"code\":\"ok\",\"message\":\"会话已关闭\",\"hint\":\"如需再次连接，请先在 termX 中重新打开会话，再调用 get_environment。\",\"closed\":\"3f2504e0-4f89-11d3-9a0c-0305e82c3301\"}"
      }
    ],
    "isError": false
  }
}
```

## 5. 权限与审批

### 5.1 三档权限

| 档位 | 只读工具（`fs_read` / `fs_grep` / `fs_glob` / `get_environment` / `vault_hosts_list` / `snippets_list` / `serial_read` / `telnet_read`） | 写操作（`fs_patch` / `fs_write` / `sftp_put` / `sftp_get` / `fs_delete` 真实删除 / `build_run` / `term_run` / `terminal_execute` / `serial_write` / `telnet_write` / `session_open` / `set_session_preamble` / `session_close`，含 `batch` 内层写 op） |
| --- | --- | --- |
| 只读（`observer`） | 正常可用 | 直接拒绝，返回 `permission_denied` |
| 确认（`confirm`，默认） | 正常可用 | 生成审批项，等用户在 termX 主窗选择；110 秒未处理自动拒绝 |
| 自动（`auto`） | 正常可用 | 直接执行，不弹审批（`fs_delete` 仍必须带 confirmToken） |

`fs_delete` 的 `dryRun=true` 只做预览，不触发审批；只有 `dryRun=false` 的真实删除才进入审批。

切换档位原地生效：不重启监听、不更换 token、不踢掉已连接客户端。已经挂起的审批项可以继续在浮层里处理，新档位只影响之后发起的调用。

### 5.2 审批浮层的三个选项

确认档位下，每次写操作会在主窗弹出审批卡片，显示工具名、目标会话和参数摘要（命令超过 200 字符会截断为 `…`）。三个按钮：

| 按钮 | 效果 |
| --- | --- |
| **允许一次** | 只放行当前这一次调用，不改变后续行为 |
| **一律许可** | 放行当前调用，并把本次操作沉淀成一条**放行规则**；之后匹配的同类操作不再弹审批 |
| **拒绝** | 拒绝当前调用，客户端收到 `permission_denied` |

补充行为：

- 审批超时时间固定 **110 秒**（早于常见客户端 120 秒工具调用上限）。
- 客户端断开、MCP 服务停止或重启时，所有挂起审批按拒绝结算，客户端收到 `permission_denied`。
- 主窗不存在时没有审批通路，写操作直接拒绝。

### 5.3 「一律许可」生成什么规则

规则模型对齐 Netcatty `PermissionGrant`（能力 / 命令模式 / 目标范围），持久化在设置 KV `mcp.permission_grants`：

| 场景 | 生成的规则 |
| --- | --- |
| `terminal_execute` | 按 shell 运算符（`&&`、`\|\|`、`;`、`\|`、换行）拆分命令，每段按 arity 前缀生成一条 `"<前缀> *"` 规则，例如 `git status --short` → `git status *`；`cd /tmp && npm run dev` → `npm run dev *` |
| 其他写工具（如 `session_close`） | 一条 `capabilityId = <工具名>` 的规则，放行该工具的所有调用 |

匹配语义（与 Netcatty `matchPermissionGrant` 一致）：

1. 命令模式规则优先；命令被拆分后**每一段都必须命中**某条规则，否则不免审批。
2. 其次匹配非命令规则：能力（工具）相同 + 会话范围匹配。当前 MCP 审批没有主机维度，规则统一落全局 `sessionPattern: "*"`。
3. `commandPattern` 支持通配符 `*`（末尾 ` .*` 可省略参数），也支持 `/正则/flags` 形式。

撤销与管理：**设置 → AI → 许可记忆表**；删除一条规则只影响后续调用。旧的按工具粒度 `mcp.allowed_tools` 在首次读取时自动迁移成能力规则，之后只保留这一套逻辑。

### 5.4 命令黑名单（正则层）

设置 → AI → 命令黑名单维护一组正则表达式，拦截 AI / MCP 发起的执行：

- 默认清单逐条照抄 Netcatty `lib/commandBlocklist.json`（21 条，覆盖 `rm -rf`、`shutdown|reboot|poweroff|halt`、`mkfs.`、`dd ... of=/dev/`、`> /dev/sdX` 等）；大小写不敏感。
- 匹配顺序：**用户自定义规则优先**，其次是仍保留在清单里的默认规则；删掉某条默认规则即禁用该条。
- 「恢复默认」把清单整体还原为出厂 21 条，用户自定义项会被清空（与 Netcatty 行为一致）。
- **拦截时机**：`terminal_execute` 在命令 sanitize 之前检查；命中直接返回（不进入审批）：
  ```
  { "code": "command_blocked",
    "message": "命令被命令黑名单拦截：命中规则 \"<命中的正则>\"",
    "hint": "改用等价但更具体的命令，或请用户在「设置 → AI → 命令黑名单」中调整规则。" }
  ```
- **只拦 AI / MCP 发起的执行，不拦用户在终端里的手动输入**：黑名单挂在 MCP / agent 执行链路，用户键盘输入不经过该检查。termX 原有的一层「裸命令名 + 分类」黑名单（如 `rm`、`cp`）仍在其后执行，两层叠加，本层只负责正则级拦截。
- **`build_run` / `term_run` 不走本黑名单**：构建命令经常包含 `rm -rf build/`、`grep -r mkfs docs/` 等正常内容，全量黑名单会误杀。这两个工具只应用 `mcp/policy.rs` 的破坏性模式（`rm -rf /`、`mkfs`、`dd of=/dev/*`、关机、fork 炸弹、`wipefs/fdisk/parted`、`chmod -R 777 /`、直写块设备），命中返回 `mcp_command_destructive`。`terminal_execute` 仍走本黑名单。


## 6. 安全说明

### 6.1 监听地址

- 默认只监听 `127.0.0.1`，仅本机可访问。
- 改成非回环地址（如 `0.0.0.0`、局域网 IP）前必须打开「允许自定义绑定」；否则启动报 `custom_bind_disabled`。
- 服务是**纯 HTTP，没有 TLS**。一旦绑定到局域网，流量（含 Bearer token 和命令输出）以明文传输，只建议在可信内网 / VPN 中使用。

### 6.2 Bearer token

- 所有 POST / DELETE 请求都要求 `Authorization: Bearer <token>`；缺失或不匹配返回 `401` 并带 `WWW-Authenticate: Bearer`。
- 比较使用定长比较，降低时序侧信道风险。
- token 持久化在 termX 本地设置 KV（`mcp.token`），不是系统钥匙串；拿到本机该用户数据目录的人可以读到它。
- 「轮换 token」会立即作废旧值；怀疑泄露时应先轮换，再检查客户端配置。

### 6.3 Host / Origin 白名单

请求的 `Host` 头只允许：

```text
127.0.0.1 / localhost / ::1 /（用户填写的「客户端 host」）
```

`Origin` 头（如果存在）只允许上述 host 的 `http://`、`https://` 形式，以及 `http://<host>:<端口>`。不匹配分别返回：

- `403 {"error":"forbidden_host"}`
- `403 {"error":"forbidden_origin"}`

白名单里的主机取「客户端 host」；该字段为空时取监听地址。所以监听 `0.0.0.0` 时要额外把客户端实际使用的局域网 IP 填进「客户端 host」，否则 Host 校验会先拦下。

### 6.4 能做什么风险操作

- **控制平面**：`fs_patch` / `fs_write` / `sftp_put` / `fs_delete` 会在远端写入、覆盖或删除文件 —— 路径可指向远端任意目录，`fs_delete` 另有 dry-run + token；覆盖/删除不可恢复。
- **传输**：`sftp_get` 会把远端文件写到**本机**（默认不覆盖已有文件），`sftp_put` 会把本机文件上传到远端；本地路径必须是绝对路径。
- **构建/执行**：`build_run` / `term_run` 在远端执行任意非交互命令（只拦破坏性命令），以登录用户权限运行；`terminal_execute` 仍受全量命令黑名单约束。
- `session_close`：关闭会话，可能中断用户正在进行的操作。
- 读取类工具会返回主机清单、会话信息、文件内容与代码片段命令文本，后者可能含敏感信息。

### 6.5 审批不是强隔离

必须讲清的边界：

- 审批只是在调用前加一道人工确认，**不限制命令内容、不隔离进程、不做权限降级**。用户点「允许」后，命令就和用户在终端里亲手输入一样执行。
- 命令黑名单是启发式防护，不可能覆盖所有危险命令，也不能替代沙箱。
- `auto` 档位完全跳过人工确认；只应在完全信任的客户端和环境中使用。
- 能拿到 token 的客户端就等同于「有权调用这些工具」，审批档位是最后一道人审，不是身份隔离。
- 不要把监听地址暴露到公网；不要把 token 写进共享仓库或聊天记录。

## 7. 排错

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| HTTP `401 {"error":"unauthorized"}` | 没带 `Authorization`、token 拼错、token 已轮换 | 从设置页重新复制 token；确认使用 `Bearer ` 前缀 |
| 连接被拒 / curl 连不上 | 服务未启用或未运行；端口被占用；监听地址不对 | 看设置页状态与错误码（`port_in_use` 等）；确认 URL 的 host/port |
| `403 forbidden_host` | 通过局域网 IP 访问，但「客户端 host」没填该 IP | 在设置里填写客户端 host，或改回 `127.0.0.1` |
| `403 forbidden_origin` | 请求带了不被允许的 `Origin` | 去掉 Origin，或使用白名单内 host |
| 客户端看不到工具 | initialize 失败（多为 401）；只探测 GET SSE 被判 405；客户端只支持 stdio | 先用 curl 验证 initialize + tools/list；确认客户端支持 HTTP transport |
| 写操作被拒（`permission_denied`） | observer 档位；确认档位下拒绝/超时；客户端断开导致审批作废 | 切到「确认」并处理弹窗，或临时切「自动」；检查客户端超时设置 |
| `405 {"error":"sse_not_supported"}` | 客户端用 GET 探测 SSE | 这是预期行为；termX 只接受 POST，忽略该探测即可 |
| `503 {"error":"mcp_disabled"}` | 请求到达时服务已停止 | 在设置页重新开启服务 |
| `503 {"error":"mcp_restarted"}` | 调用过程中服务被重启 | 重新 initialize 后再调用 |
| `command_blocked` | 命令命中黑名单 | 换命令或调整黑名单 |
| `mcp_command_destructive` | `build_run` / `term_run` 命中破坏性策略 | 拆分命令；确需执行请在终端手动操作 |
| `mcp_unsupported_session_kind` | 该工具需要 SSH 的 SFTP / exec 通道，但 `sessionId` 指向串口 / Telnet / SFTP / 端口转发等传输（`params` 带 `id` 与 `kind`） | 改用 `kind=ssh` 的会话；串口 / Telnet 只有各自的字节写工具，`terminal_execute` 不受此限 |
| `mcp_session_not_ready` | 会话存在但 `phase` 不是 `ready`（SSH 仍在建连 / 已关闭、串口未打开、句柄已释放） | 重新 `get_environment` 确认 `phase=ready` 后重试 |
| `mcp_env_invalid` | `env` 不是对象、变量名不合法、值不是字符串或总量超限 | 变量名用 `[A-Za-z_][A-Za-z0-9_]*`；最多 64 个；值必须是字符串 |
| `mcp_preamble_too_long` | preamble 超过 8 KiB | 把初始化逻辑写进远端脚本，preamble 只留 `source` 一行 |
| `mcp_cwd_invalid` | `cwd` 不存在或当前用户不可进入 | 确认路径；不传 `cwd` 时从 home 开始 |
| `mcp_file_exists` / `mcp_local_file_exists` | 目标已存在且 `overwrite=false` | 显式传 `overwrite=true` |
| `mcp_delete_token_required` / `_invalid` / `_mismatch` | 未先 dryRun、token 过期或参数不一致 | 重新 `dryRun=true` 拿新 token，并保持路径/recursive 一致 |
| `mcp_delete_is_dir` / `mcp_transfer_is_dir` | 目录未显式递归 | 传 `recursive=true` |
| `mcp_missing_interpreter` | 远端缺 `python3` | 安装 python3，或改用 `fs_glob` + `fs_read` |
| `transfer_partial` | 批量传输部分失败 | 按 `results[].code` 只重传失败项 |
| `session_not_found` | 会话已关闭或 id 过期 | 重新 `get_environment` |
| `400 parse_error` | 请求体不是合法 JSON | 检查 `Content-Type: application/json` 与 JSON 语法 |
| `413 body_too_large` / `431 headers_too_large` | 请求体 > 4 MB / 请求头 > 8 KB | 拆小请求；工具参数不应当这么大 |

客户端不发 SSE 时会发生什么：

- 服务端对 POST 一律返回**单次 JSON 响应**，`Content-Type: application/json`，随后 `Connection: close`；不依赖客户端声明 SSE。
- 如果客户端只接受 `text/event-stream` 流式响应，它不会工作；如果客户端能接受普通 JSON，则不受影响。
- 客户端如果主动 `GET /mcp` 建立 SSE 长连接，会收到 `405 sse_not_supported`，可安全忽略。

## 8. 已知限制

- **无 SSE**：仅 POST 单次 JSON；GET 返回 405。
- **有 `Mcp-Session-Id`（隔离用，不是有状态执行）**：`initialize` 下发 `Mcp-Session-Id`，客户端回传后各自只看到自己自动建连的会话；不发该头的客户端按 `User-Agent` 区分。命令执行本身仍然无状态，每次调用都是新的远端 shell。
- **无 stdio 传输**：只提供 HTTP 端点，不附带 Node launcher。
- **无 OAuth / 多用户**：只有一个 Bearer token；没有按用户或按客户端区分的权限。
- **确认模式无批量允许**：审批按调用逐项进行；「始终允许」只按工具粒度，没有「允许本会话全部命令」。
- **22 个工具**：`get_environment`、`vault_hosts_list`、`snippets_list`、`terminal_execute`、`session_open`、`set_session_preamble`、`session_close`、`serial_write`、`serial_read`、`telnet_write`、`telnet_read`、`fs_read`、`fs_grep`、`fs_glob`、`fs_patch`、`fs_write`、`sftp_put`、`sftp_get`、`fs_delete`、`build_run`、`term_run`、`batch`。
- **`fs_grep` 依赖远端 `python3`**：缺失时返回 `mcp_missing_interpreter`，可改用 `fs_glob` + `fs_read` 或 `term_run` 的 `grep`。
- **远端路径不设目录限制**：`~` 与相对路径按远端 home 展开，`..` 只做折叠；绝对路径可指向任意目录，请自行确认目标位置。
- **`fs_read` 上限 8 MiB**：更大文件请用 `sftp_get` 下载到本地处理，或分段开窗。
- **`build_run` 只保留尾部**：完整日志需要 `teeToRemoteFile`；stdout/stderr 合并且 stdout 在前，不保证时间交错顺序。
- **`terminal_execute` 的 ssh / pty 只保留尾部**：`stdout`、`stderr` 各默认 16 KiB（`maxOutputBytes` 最大 65536），`truncated=true` 时需改用重定向文件或分页方式获取全文。
- **`sftp_get` 的 sha256 是本地文件**：如需确认远端内容，请用 `fs_read` / `build_run` 的远端校验命令自行比对。
- **MCP 进度事件无人订阅**：传输走 `Host::Tauri` 发事件，但 MCP 没有窗口，客户端看不到进度；只能等工具调用返回。
- **资源只有一个**：`termx://environment`（等价 `get_environment` 只读快照）。
- **不支持服务端通知/订阅**：`listChanged: false`、`subscribe: false`，没有进度或日志推送。
- **protocolVersion 回显**：服务端把客户端请求的版本原样返回，不做严格协商。
- **工具错误是业务层错误**：`tools/call` 的 HTTP 状态仍是 200，错误放在 `content[0].text` 的 JSON 与外层 `isError` 里。

---

文档维护：本文对应的权威源在 `src-tauri/src/mcp/guide.rs`（`INSTRUCTIONS` 与设置页「接入指南」共用）和 `src-tauri/src/mcp/tools.rs`（工具 description / inputSchema / 返回结构）。修改这些代码后，请同步更新本文。
