//! 对外 MCP 接入指南：`initialize` 的 `instructions` 与设置页「接入指南」共用这里的一份文案。
//!
//! 单一权威源约定：
//! - `INSTRUCTIONS` 是给外部 agent 的精简指南，`initialize` 直接返回它；
//! - 设置页的「system prompt」区块返回同一份 `INSTRUCTIONS`，前端不另抄文案；
//! - 工具速查表的参数部分从 `tools::definitions()` 实时生成，避免 schema 漂移。

use serde::Serialize;
use serde_json::{json, Value};

/// 给外部 agent 的精简接入指南（`initialize.instructions` 与设置页 system prompt 同源）。
pub const INSTRUCTIONS: &str = r#"termX 是本机的 SSH / 串口 / 终端客户端；本 MCP 服务器操作 termX 已保存的主机和已打开的会话。
sessionId 来自 get_environment；hostId 也可直接引用（vault 中有该主机时按档案自动建连，无需先开窗口）。

推荐工作流（token 高效）：
1) get_environment：拿 sessions[].id / hosts[]（cacheable 30s）。
2) 查阅：fs_glob 列文件 → fs_grep 定位 → fs_read 按行开窗；不要整读大文件。
3) 修改：fs_patch 先 dryRun 看 diff 再落盘；小文件整体覆盖用 fs_write。
4) 传输：sftp_put / sftp_get 流式传输，返回只有路径 / size / sha256，token 与文件大小无关。
5) 构建：build_run 只回尾部日志与 exitCode；需要完整日志时传 teeToRemoteFile。
6) 删除：fs_delete 默认 dryRun=true，先拿 confirmToken，再以 dryRun=false 执行。
7) batch：把多个 fs_read / fs_grep / fs_glob / fs_patch / fs_write 合成一次调用（≤50）。
8) 逃生平面：term_run 执行任意非交互命令（只拦破坏性命令）；terminal_execute 为旧客户端保留。
9) 串口 / Telnet：serial_write / telnet_write 只写字节并回 bytesWritten，没有 exitCode；这类会话调用文件类工具会得到 mcp_unsupported_session_kind。

可用工具（共 18 个）：get_environment、vault_hosts_list、snippets_list、terminal_execute、serial_write、telnet_write、session_close、fs_read、fs_grep、fs_glob、fs_patch、fs_write、sftp_put、sftp_get、fs_delete、build_run、term_run、batch。
规则：
- sessionId 必须来自 get_environment；hostId 必须来自 hosts[] 或 vault_hosts_list，不要臆造。
- 远端路径（path / remotePath / cwd）默认 jail 在 workspace 根（设置 → AI → Workspace 根），越界返回 mcp_path_outside_jail；localPath 只校验是绝对路径，不受 jail 约束。
- 写操作受权限档位约束：observer 只读拒绝、confirm 需用户在 termX 弹窗中允许、auto 直接执行；fs_delete 无论档位都要 confirmToken。
- 所有工具返回 JSON：成功为 {code:"ok", message, hint, ...数据}，失败为 {code, message, hint}。失败时先按 hint 自纠。
- 大文件用传输/开窗工具，不要把内容塞进 arguments；不要泄露 token 或凭据。"#;

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

# 2) tools/list：查看全部工具与完整 inputSchema
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 3) tools/call：调用工具（示例为列出当前环境）
curl -s "$URL" \
  -H "$AUTH" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_environment","arguments":{}}}'"#;

fn return_example(name: &str) -> &'static str {
    match name {
        "get_environment" => {
            r#"{code:"ok", sessions:[{id, kind, phase, hostId, origin}], hosts:[...], hostCount}"#
        }
        "vault_hosts_list" => r#"{code:"ok", hosts:[{id, name, host, port, groupId}]}"#,
        "snippets_list" => r#"{code:"ok", snippets:[{id, name, package, command, description}]}"#,
        "terminal_execute" => r#"{code:"ok", stdout, stderr, exitCode}"#,
        "serial_write" | "telnet_write" => r#"{code:"ok", sessionId, bytesWritten}"#,
        "session_close" => r#"{code:"ok", closed: sessionId}"#,
        "fs_read" => r#"{code:"ok", path, lines, totalLines, size, truncated, nextCursor}"#,
        "fs_grep" => r#"{code:"ok", matches:[{path, line, text}], total, truncated, nextCursor}"#,
        "fs_glob" => r#"{code:"ok", matches:[{path, size}], total, truncated, nextCursor}"#,
        "fs_patch" => r#"{code:"ok", dryRun, results:[{path, applied, sha256, diff}]}"#,
        "fs_write" => r#"{code:"ok", path, size, sha256, created}"#,
        "sftp_put" | "sftp_get" => {
            r#"{code:"ok", ok, failed, results:[{localPath, remotePath, size, sha256, status}]}"#
        }
        "fs_delete" => r#"{code:"ok", dryRun, wouldDelete:[{path, size, isDir}], confirmToken}"#,
        "build_run" => {
            r#"{code:"ok", exitCode, stdoutTail, stderrTail, totalBytes, truncated, fullLog}"#
        }
        "term_run" => r#"{code:"ok", exitCode, stdoutTail, stderrTail, totalBytes, truncated}"#,
        "batch" => r#"{code:"ok", results:[{tool, isError, result}], failed}"#,
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

/// 全部工具的参数速查表（参数从 definitions 实时生成，返回示例保持一句话）。
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
        block("tools", "工具参数速查表", tools_table()),
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
            "serial_write",
            "telnet_write",
            "session_close",
            "fs_read",
            "fs_grep",
            "fs_glob",
            "fs_patch",
            "fs_write",
            "sftp_put",
            "sftp_get",
            "fs_delete",
            "build_run",
            "term_run",
            "batch",
        ] {
            assert!(INSTRUCTIONS.contains(name), "instructions 缺少 {name}");
        }
        assert!(INSTRUCTIONS.contains("推荐工作流"));
        assert!(INSTRUCTIONS.contains("confirmToken"));
        assert!(INSTRUCTIONS.contains("{code, message, hint}"));
    }

    /// 单一权威源：设置页 system prompt 必须等于 initialize 的 instructions，
    /// 速查表参数必须来自 `tools::definitions()`，不允许前后端各维护一份。
    #[test]
    fn settings_guide_and_initialize_share_one_source() {
        let list = blocks(Some("http://127.0.0.1:47391/mcp"), Some("tok"));
        let prompt = list.iter().find(|b| b.id == "systemPrompt").unwrap();
        assert_eq!(prompt.content, INSTRUCTIONS);

        let table = tools_table();
        let defs = crate::mcp::tools::definitions();
        for tool in defs.as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            assert!(table.contains(name), "速查表缺少 {name}");
            for (param, spec) in tool["inputSchema"]["properties"].as_object().unwrap() {
                let ty = spec["type"].as_str().unwrap();
                assert!(
                    table.contains(&format!("{param}: {ty}")),
                    "速查表缺少参数 {name}.{param}: {ty}"
                );
            }
        }
    }
}
