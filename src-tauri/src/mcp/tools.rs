//! 对外 MCP 暴露的工具面。
//!
//! Netcatty 侧由 `electron/capabilities/catalog/*.cjs` 驱动（40+ 工具，渐进式加载）。
//! termX 本阶段只移植「已存在可复用执行链路」的 5 个工具，其余在
//! `docs/mcp-port-plan.md` 里列为未实现并说明缺口，绝不注册空转工具。

use serde_json::{json, Value};

use crate::state::{AppState, SessionKind};
use crate::commands::{lifecycle, plugin};
use super::config::{McpConfig, PermissionMode};

pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

impl ToolResult {
    fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: false,
        }
    }

    fn err(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: true,
        }
    }
}

fn schema(props: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false,
    })
}

pub fn definitions() -> Value {
    json!([
        {
            "name": "get_environment",
            "description": "列出 termX 当前活跃的终端 / SFTP / 端口转发会话，以及主机数量。用于在调用其他工具前确认可用的 sessionId。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "vault_hosts_list",
            "description": "列出已保存的主机（id / 名称 / 地址 / 端口 / 分组），不返回任何凭据或密钥。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "snippets_list",
            "description": "列出代码片段（id / 名称 / 分组 / 命令 / 说明）。命令文本可能包含敏感信息，仅返回元数据与命令本身。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "terminal_execute",
            "description": "在指定 sessionId 的已打开会话中执行一条命令，返回 stdout / stderr / exitCode。写操作，受权限档位与命令黑名单约束。",
            "inputSchema": schema(
                json!({
                    "sessionId": { "type": "string", "description": "get_environment 返回的会话 id" },
                    "command": { "type": "string", "description": "要执行的单条命令" },
                    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 600000, "description": "超时毫秒，默认 30000" }
                }),
                &["sessionId", "command"]
            ),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        },
        {
            "name": "session_close",
            "description": "关闭指定 sessionId 的会话。写操作，受权限档位约束。",
            "inputSchema": schema(
                json!({ "sessionId": { "type": "string" } }),
                &["sessionId"]
            ),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        }
    ])
}

fn kind_name(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Ssh => "ssh",
        #[cfg(desktop)]
        SessionKind::Pty => "pty",
        #[cfg(desktop)]
        SessionKind::Serial => "serial",
        SessionKind::Telnet => "telnet",
        SessionKind::Sftp => "sftp",
        SessionKind::Forward => "forward",
    }
}

fn write_gate(cfg: &McpConfig) -> Result<(), ToolResult> {
    if cfg.permission_mode.allows_write() {
        return Ok(());
    }
    let reason = match cfg.permission_mode {
        PermissionMode::Observer => "当前权限档位为 observer，写操作被拒绝",
        _ => "当前权限档位为 confirm，但本版本尚未实现审批卡片，写操作被拒绝；请切到 auto 或改用只读工具",
    };
    Err(ToolResult::err(reason))
}

fn owner_of(state: &AppState, session_id: &str) -> Result<crate::state::SessionOwner, ToolResult> {
    let registry = state.lock_sessions().map_err(ToolResult::err)?;
    registry
        .get(session_id)
        .map(|r| r.owner.clone())
        .ok_or_else(|| ToolResult::err(format!("session_not_found: {session_id}")))
}

fn kind_of(state: &AppState, session_id: &str) -> Result<SessionKind, ToolResult> {
    let registry = state.lock_sessions().map_err(ToolResult::err)?;
    registry
        .get(session_id)
        .map(|r| r.kind)
        .ok_or_else(|| ToolResult::err(format!("session_not_found: {session_id}")))
}

fn environment(state: &AppState) -> Result<Value, ToolResult> {
    let registry = state.lock_sessions().map_err(ToolResult::err)?;
    let mut sessions = Vec::new();
    for (id, record) in registry.iter() {
        sessions.push(json!({
            "id": id,
            "kind": kind_name(record.kind),
            "phase": match record.phase {
                crate::state::SessionPhase::Pending => "pending",
                crate::state::SessionPhase::Ready => "ready",
                crate::state::SessionPhase::Closed => "closed",
            },
        }));
    }
    drop(registry);
    let hosts = crate::db::profile::list(&state.db).map_err(|e| ToolResult::err(e.to_string()))?;
    Ok(json!({
        "sessions": sessions,
        "hostCount": hosts.len(),
    }))
}

pub async fn call_tool(
    state: &AppState,
    cfg: &McpConfig,
    name: &str,
    args: &Value,
) -> ToolResult {
    match name {
        "get_environment" => match environment(state) {
            Ok(v) => ToolResult::ok(v.to_string()),
            Err(e) => e,
        },
        "vault_hosts_list" => match crate::db::profile::list(&state.db) {
            Ok(list) => {
                let items: Vec<Value> = list
                    .iter()
                    .map(|p| {
                        json!({
                            "id": p.id,
                            "name": p.name,
                            "host": p.host,
                            "port": p.port,
                            "groupId": p.group_id,
                        })
                    })
                    .collect();
                ToolResult::ok(json!({ "hosts": items }).to_string())
            }
            Err(e) => ToolResult::err(e.to_string()),
        },
        "snippets_list" => match crate::db::snippet::load(&state.data_dir) {
            Ok(list) => {
                let items: Vec<Value> = list
                    .iter()
                    .map(|s| {
                        json!({
                            "id": s.id,
                            "name": s.name,
                            "package": s.package,
                            "command": s.command,
                            "description": s.description,
                        })
                    })
                    .collect();
                ToolResult::ok(json!({ "snippets": items }).to_string())
            }
            Err(e) => ToolResult::err(e.to_string()),
        },
        "terminal_execute" => {
            if let Err(e) = write_gate(cfg) {
                return e;
            }
            let session_id = match args.get("sessionId").and_then(Value::as_str) {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => return ToolResult::err("missing_argument: sessionId"),
            };
            let command = match args.get("command").and_then(Value::as_str) {
                Some(v) if !v.trim().is_empty() => v.to_string(),
                _ => return ToolResult::err("missing_argument: command"),
            };
            let timeout = args.get("timeoutMs").and_then(Value::as_u64);
            let blacklist = match crate::ai::command_blacklist::load(&state.db) {
                Ok(bl) => bl,
                Err(e) => return ToolResult::err(format!("blacklist_load_failed: {e}")),
            };
            if let Err(e) = crate::ai::sanitize::validate_with(&command, &blacklist) {
                return ToolResult::err(format!("command_blocked: {e:?}"));
            }
            let owner = match owner_of(state, &session_id) {
                Ok(o) => o,
                Err(e) => return e,
            };
            match plugin::plugin_exec_impl(state, &owner, session_id, command, timeout).await {
                Ok(out) => ToolResult::ok(
                    json!({
                        "stdout": out.stdout,
                        "stderr": out.stderr,
                        "exitCode": out.exit_code,
                    })
                    .to_string(),
                ),
                Err(e) => ToolResult::err(e.to_string()),
            }
        }
        "session_close" => {
            if let Err(e) = write_gate(cfg) {
                return e;
            }
            let session_id = match args.get("sessionId").and_then(Value::as_str) {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => return ToolResult::err("missing_argument: sessionId"),
            };
            let owner = match owner_of(state, &session_id) {
                Ok(o) => o,
                Err(e) => return e,
            };
            let kind = match kind_of(state, &session_id) {
                Ok(k) => k,
                Err(e) => return e,
            };
            match lifecycle::close_resource(state, &session_id, kind, &owner) {
                Ok(()) => ToolResult::ok(json!({ "closed": session_id }).to_string()),
                Err(e) => ToolResult::err(e.to_string()),
            }
        }
        _ => ToolResult::err(format!("unknown_tool: {name}")),
    }
}

pub fn resources() -> Value {
    json!([
        {
            "uri": "termx://environment",
            "name": "termX environment",
            "description": "当前活跃会话与主机数量（等同 get_environment 的只读快照）",
            "mimeType": "application/json"
        }
    ])
}

pub fn read_resource(state: &AppState, uri: &str) -> ToolResult {
    match uri {
        "termx://environment" => match environment(state) {
            Ok(v) => ToolResult::ok(v.to_string()),
            Err(e) => e,
        },
        _ => ToolResult::err(format!("unknown_resource: {uri}")),
    }
}
