# termX MCP 接入指南

> 面向第一次接触 termX MCP 的使用者。本文内容以代码为准：`initialize.instructions`、工具的 `description` / `inputSchema`、设置页「接入指南」都来自 `src-tauri/src/mcp/guide.rs` 与 `src-tauri/src/mcp/tools.rs`。如果本文与界面文案不一致，以界面/协议返回为准并提 issue。

## 1. termX MCP 是什么

termX 是本机的 SSH / 串口 / 终端客户端。开启 MCP 服务后，termX 会在本机启动一个 Streamable HTTP 端点（默认 `http://127.0.0.1:47391/mcp`），把它**已经打开的会话**和**已保存的主机清单**以 5 个工具暴露给外部 AI 客户端（Trae、Claude Desktop、Cursor、Claude Code 等）。

调用方向是单向的：

```text
外部 AI 客户端  ──HTTP POST + Bearer token──▶  termX MCP 服务  ──▶  termX 内已打开的会话
```

termX 不会因为一次 MCP 调用去新建 SSH / 串口连接。要操作某台主机，必须先在 termX 里把对应会话打开；MCP 只是把已有能力交给外部 agent 使用。

## 2. 快速开始

### 2.1 开启服务

进入 **设置 → AI → 工具接入**：

1. 打开「启用 MCP 服务」。
2. 端口默认 `47391`，允许范围 ≥ 1024。
3. 监听地址默认 `127.0.0.1`（仅本机可访问）。
4. 权限档位默认「确认」；初次接入建议保持该档位。
5. 右上角状态显示「运行中」即监听成功。

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

**Trae** — 写入 `%APPDATA%\Trae CN\User\mcp.json`（macOS/Linux 为对应 Trae 用户目录）：

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
- `tools/list` 返回 5 个工具：`get_environment`、`vault_hosts_list`、`snippets_list`、`terminal_execute`、`session_close`；
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

**用途**：返回当前活跃会话和已保存主机数量，是拿 `sessionId` 的唯一入口。

**该用**：会话开始时；调用 `terminal_execute` / `session_close` 前确认目标会话存在。
**不该用**：只需要主机清单时用 `vault_hosts_list`；不要用它轮询等待新会话。

参数：无。

返回示例（`content[0].text` 解析后）：

```json
{
  "code": "ok",
  "message": "已返回当前环境快照",
  "hint": "用 sessions[].id 作为 terminal_execute / session_close 的 sessionId；phase 为 ready 的会话才能执行命令。",
  "sessions": [
    { "id": "ssh-1a2b3c", "kind": "ssh", "phase": "ready" },
    { "id": "serial-7f00aa", "kind": "serial", "phase": "ready" }
  ],
  "hostCount": 3
}
```

`kind` 可能为 `ssh` / `pty` / `serial` / `telnet` / `sftp` / `forward`；`phase` 为 `pending` / `ready` / `closed`。

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

**用途**：在已打开的会话里执行一条命令，返回标准输出、错误输出和退出码。

**该用**：需要与目标主机的现有会话交互、查看输出或运行命令时。
**不该用**：只查询会话/主机清单时用只读工具；没有 `sessionId` 时不要调用；不要用它发起与本机会话无关的网络操作。
**约束**：写操作，受权限档位和命令黑名单约束。

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| `sessionId` | string | 是 | `get_environment` 返回的 `sessions[].id` | `"ssh-1a2b3c"` |
| `command` | string | 是 | 单条非空命令 | `"uname -a"` |
| `timeoutMs` | integer | 否 | 超时毫秒，范围 1000–600000，默认 30000 | `30000` |

返回示例：

```json
{
  "code": "ok",
  "message": "命令执行完成",
  "hint": "如需在同一会话继续执行，复用相同的 sessionId；任务结束调用 session_close。",
  "stdout": "Linux web-01 6.1.0 x86_64 GNU/Linux\n",
  "stderr": "",
  "exitCode": 0
}
```

常见错误：

| code | 现象 | 处理 |
| --- | --- | --- |
| `missing_argument` | 缺少 `sessionId` 或 `command` | 按上表补齐；`sessionId` 必须来自 `get_environment` |
| `session_not_found` | 会话不存在或已关闭 | 重新 `get_environment` 拿新的 id |
| `command_blocked` | 命令命中黑名单 | 换用等价但更具体的命令，或请用户调整黑名单 |
| `permission_denied` | 权限档位为 observer，或审批被拒/超时 | 请用户在设置里放行或切换档位 |
| `execute_failed` | 会话断开、命令语法错误等 | 确认会话仍为 `ready` 后重试 |
| `internal_error` | 本地读取失败 | 重试；持续失败查看 termX 日志 |

### 3.5 `session_close`

**用途**：关闭指定会话。

**该用**：你打开且任务已完成、或明确需要释放会话资源时。
**不该用**：用户正在使用的会话不要关闭；会话不存在时先 `get_environment` 确认。
**约束**：写操作，受权限档位约束。

| 参数 | 类型 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- | --- |
| `sessionId` | string | 是 | `get_environment` 返回的 `sessions[].id` | `"ssh-1a2b3c"` |

返回示例：

```json
{
  "code": "ok",
  "message": "会话已关闭",
  "hint": "如需再次连接，请先在 termX 中重新打开会话，再调用 get_environment。",
  "closed": "ssh-1a2b3c"
}
```

常见错误：

| code | 现象 | 处理 |
| --- | --- | --- |
| `missing_argument` | 缺少 `sessionId` | 补齐参数 |
| `session_not_found` | 会话不存在 | 重新 `get_environment` |
| `permission_denied` | observer 档位或审批未通过 | 请用户放行 |
| `close_failed` | 关闭链路失败 | 重新确认会话是否仍存在；已关闭可忽略 |

## 4. 推荐调用顺序与示例

推荐顺序：

```text
get_environment
   ├─（需要选主机）vault_hosts_list
   ├─（需要复用命令）snippets_list
   ├─ terminal_execute（可多次，复用同一 sessionId）
   └─ session_close（只关闭你打开且不再需要的会话）
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
      "sessionId": "ssh-1a2b3c",
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
    "arguments": { "sessionId": "ssh-1a2b3c" }
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
        "text": "{\"code\":\"ok\",\"message\":\"会话已关闭\",\"hint\":\"如需再次连接，请先在 termX 中重新打开会话，再调用 get_environment。\",\"closed\":\"ssh-1a2b3c\"}"
      }
    ],
    "isError": false
  }
}
```

## 5. 权限与审批

### 5.1 三档权限

| 档位 | 只读工具 | 写操作（`terminal_execute` / `session_close`） |
| --- | --- | --- |
| 只读（`observer`） | 正常可用 | 直接拒绝，返回 `permission_denied` |
| 确认（`confirm`，默认） | 正常可用 | 生成审批项，等用户在 termX 主窗选择；110 秒未处理自动拒绝 |
| 自动（`auto`） | 正常可用 | 直接执行，不弹审批 |

切换档位原地生效：不重启监听、不更换 token、不踢掉已连接客户端。已经挂起的审批项可以继续在浮层里处理，新档位只影响之后发起的调用。

### 5.2 审批浮层的三个选项

确认档位下，每次写操作会在主窗弹出审批卡片，显示工具名、目标会话和参数摘要（命令超过 200 字符会截断为 `…`）。三个按钮：

| 按钮 | 效果 |
| --- | --- |
| **允许一次** | 只放行当前这一次调用，不改变后续行为 |
| **始终允许 `<工具>`** | 放行当前调用，并把该工具加入「始终允许」名单；之后该工具的调用不再弹审批 |
| **拒绝** | 拒绝当前调用，客户端收到 `permission_denied` |

补充行为：

- 审批超时时间固定 **110 秒**（早于常见客户端 120 秒工具调用上限）。
- 客户端断开、MCP 服务停止或重启时，所有挂起审批按拒绝结算，客户端收到 `permission_denied`。
- 主窗不存在时没有审批通路，写操作直接拒绝。

### 5.3 「始终允许」存在哪、怎么撤销

- 「始终允许」按**工具粒度**持久化，不是按会话或按命令。名单存在 termX 本地设置 KV 的 `mcp.allowed_tools`（JSON 字符串数组），重启 termX 后仍然生效。
- 撤销入口：**设置 → AI → 工具接入**；确认档位下列出「始终允许的工具」，每个工具右侧有撤销按钮，点击后立刻从名单移除。
- 撤销只影响后续调用；正在执行的调用不会被打断。

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

- `terminal_execute`：在已打开会话中执行任意命令（受黑名单约束），命令以该会话的用户权限运行。
- `session_close`：关闭会话，可能中断用户正在进行的操作。
- 读取类工具会返回主机清单、会话信息和代码片段命令文本，后者可能含敏感信息。

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
| `session_not_found` | 会话已关闭或 id 过期 | 重新 `get_environment` |
| `400 parse_error` | 请求体不是合法 JSON | 检查 `Content-Type: application/json` 与 JSON 语法 |
| `413 body_too_large` / `431 headers_too_large` | 请求体 > 4 MB / 请求头 > 8 KB | 拆小请求；工具参数不应当这么大 |

客户端不发 SSE 时会发生什么：

- 服务端对 POST 一律返回**单次 JSON 响应**，`Content-Type: application/json`，随后 `Connection: close`；不依赖客户端声明 SSE。
- 如果客户端只接受 `text/event-stream` 流式响应，它不会工作；如果客户端能接受普通 JSON，则不受影响。
- 客户端如果主动 `GET /mcp` 建立 SSE 长连接，会收到 `405 sse_not_supported`，可安全忽略。

## 8. 已知限制

- **无 SSE**：仅 POST 单次 JSON；GET 返回 405。
- **无 `Mcp-Session-Id`**：每个 POST 都是独立请求，服务端不签发/校验会话 id；客户端不需要保存 session id。
- **无 stdio 传输**：只提供 HTTP 端点，不附带 Node launcher。
- **无 OAuth / 多用户**：只有一个 Bearer token；没有按用户或按客户端区分的权限。
- **确认模式无批量允许**：审批按调用逐项进行；「始终允许」只按工具粒度，没有「允许本会话全部命令」。
- **只支持 5 个工具**：`get_environment`、`vault_hosts_list`、`snippets_list`、`terminal_execute`、`session_close`。
- **资源只有一个**：`termx://environment`（等价 `get_environment` 只读快照）。
- **不支持服务端通知/订阅**：`listChanged: false`、`subscribe: false`，没有进度或日志推送。
- **protocolVersion 回显**：服务端把客户端请求的版本原样返回，不做严格协商。
- **工具错误是业务层错误**：`tools/call` 的 HTTP 状态仍是 200，错误放在 `content[0].text` 的 JSON 与外层 `isError` 里。

---

文档维护：本文对应的权威源在 `src-tauri/src/mcp/guide.rs`（`INSTRUCTIONS` 与设置页「接入指南」共用）和 `src-tauri/src/mcp/tools.rs`（工具 description / inputSchema / 返回结构）。修改这些代码后，请同步更新本文。
