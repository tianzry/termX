//! 对外 MCP 接入指南：`initialize` 的 `instructions` 与设置页「接入指南」共用这里的一份文案。
//!
//! 单一权威源约定：
//! - `INSTRUCTIONS` 是给外部 agent 的精简指南，`initialize` 直接返回它；
//! - 设置页的「system prompt」区块返回同一份 `INSTRUCTIONS`，前端不另抄文案；
//! - 工具速查表的参数部分从 `tools::definitions()` 实时生成，避免 schema 漂移。

use serde::Serialize;
use serde_json::{json, Value};

/// 给外部 agent 的精简接入指南（`initialize.instructions` 与设置页 system prompt 同源）。
pub const INSTRUCTIONS: &str = r#"termX 是本机的 SSH / 串口 / 终端客户端；本 MCP 服务器只操作 termX 中已经打开的会话和已保存的主机，不会自行发起新的网络连接。
可用工具（共 5 个）：
1) get_environment：只读。列出当前活跃会话（id / kind / phase）和已保存主机数量。会话开始时先调用它拿到 sessionId。
2) vault_hosts_list：只读。列出已保存主机的 id / name / host / port / groupId，不含密码、密钥等凭据。
3) snippets_list：只读。列出已保存代码片段（id / name / package / command / description），命令文本可能含敏感信息。
4) terminal_execute：写操作。在指定 sessionId 的已打开会话中执行一条命令，返回 stdout / stderr / exitCode。
5) session_close：写操作。关闭指定 sessionId 的会话。
推荐调用顺序：get_environment → vault_hosts_list（需要选主机时）→ snippets_list（需要复用命令时）→ terminal_execute → 任务完成后按需 session_close（只关闭你打开且不再需要的会话）。
规则：
- sessionId 必须来自 get_environment 的 sessions[].id，不要臆造；phase 不是 ready 的会话不能执行命令。
- 写操作是否放行由「设置 → AI → 工具接入」的权限档位决定：observer 只读并拒绝写操作、confirm 需要用户在 termX 弹窗中允许、auto 直接执行。
- 所有工具返回 JSON：成功为 {code:"ok", message, hint, ...数据}，失败为 {code, message, hint}。失败时先按 hint 自纠：session_not_found 重新 get_environment；permission_denied 请用户在 termX 中放行或切换档位；command_blocked 换用更具体的命令。
- 只在需要与目标主机交互时调用 terminal_execute；只查询信息优先使用只读工具，不要泄露 token 或凭据。"#;

/// 设置页展示的一个可复制区块。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideBlock {
    pub id: String,
    pub title: String,
    pub content: String,
}

const CURL_TEMPLATE: &str = r#"URL='__URL__'
TOKEN='__TOKEN__'
AUTH="Authorization: Bearer $TOKEN"

# 1) initialize：握手并拿到 instructions
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2) tools/list：查看 5 个工具与完整 inputSchema
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 3) tools/call：调用工具（示例为列出当前环境）
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_environment","arguments":{}}}'"#;

fn return_example(name: &str) -> &'static str {
    match name {
        "get_environment" => r#"{code:"ok", sessions:[{id, kind, phase}], hostCount}"#,
        "vault_hosts_list" => r#"{code:"ok", hosts:[{id, name, host, port, groupId}]}"#,
        "snippets_list" => r#"{code:"ok", snippets:[{id, name, package, command, description}]}"#,
        "terminal_execute" => r#"{code:"ok", stdout, stderr, exitCode}"#,
        "session_close" => r#"{code:"ok", closed: sessionId}"#,
        _ => "",
    }
}

fn param_text(schema: &Value) -> String {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return "无".to_string();
    };
    if props.is_empty() {
        return "无".to_string();
    }
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    props
        .iter()
        .map(|(name, spec)| {
            let ty = spec.get("type").and_then(Value::as_str).unwrap_or("any");
            let flag = if required.iter().any(|r| r == name) {
                "必填"
            } else {
                "可选"
            };
            format!("{name}: {ty}（{flag}）")
        })
        .collect::<Vec<_>>()
        .join("；")
}

/// 5 个工具的参数速查表（参数从 definitions 实时生成，返回示例保持一句话）。
pub fn tools_table() -> String {
    let defs = super::tools::definitions();
    let mut lines = vec![
        "工具 | 参数（必填/可选） | 返回示例".to_string(),
        "-----|------------------|----------".to_string(),
    ];
    for tool in defs.as_array().into_iter().flatten() {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        let empty = json!({});
        let schema = tool.get("inputSchema").unwrap_or(&empty);
        lines.push(format!(
            "{} | {} | {}",
            name,
            param_text(schema),
            return_example(name)
        ));
    }
    lines.join("\n")
}

fn pretty(value: Value) -> String {
    serde_json::to_string_pretty(&value).unwrap_or_default()
}

fn http_config(url: &str, token: &str, with_type: bool) -> String {
    let auth = format!("Bearer {token}");
    let mut server = json!({
        "url": url,
        "headers": { "Authorization": auth }
    });
    if with_type {
        if let Some(map) = server.as_object_mut() {
            map.insert("type".to_string(), json!("http"));
        }
    }
    pretty(json!({ "mcpServers": { "termx": server } }))
}

/// 设置页「接入指南」的六个区块。内容全部由后端生成，前端只做展示与复制。
pub fn blocks(url: Option<&str>, token: Option<&str>) -> Vec<GuideBlock> {
    let url = url.unwrap_or_default();
    let token = token.unwrap_or_default();
    let block = |id: &str, title: &str, content: String| GuideBlock {
        id: id.to_string(),
        title: title.to_string(),
        content,
    };
    vec![
        block(
            "trae",
            "Trae · %APPDATA%\\Trae CN\\User\\mcp.json",
            http_config(url, token, false),
        ),
        block(
            "claude",
            "Claude Desktop · claude_desktop_config.json",
            http_config(url, token, true),
        ),
        block(
            "cursor",
            "Cursor · ~/.cursor/mcp.json",
            http_config(url, token, true),
        ),
        block(
            "curl",
            "通用 curl（initialize → tools/list → tools/call）",
            CURL_TEMPLATE
                .replace("__URL__", url)
                .replace("__TOKEN__", token),
        ),
        block(
            "systemPrompt",
            "可直接粘贴的 system prompt",
            INSTRUCTIONS.to_string(),
        ),
        block("tools", "5 个工具参数速查表", tools_table()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_cover_tool_order_and_errors() {
        for name in [
            "get_environment",
            "vault_hosts_list",
            "snippets_list",
            "terminal_execute",
            "session_close",
        ] {
            assert!(INSTRUCTIONS.contains(name), "instructions 缺少 {name}");
        }
        assert!(INSTRUCTIONS.contains("推荐调用顺序"));
        assert!(INSTRUCTIONS.contains("{code, message, hint}"));
    }
}
