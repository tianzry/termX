//! 对外 MCP 暴露的工具面。
//!
//! Netcatty 侧由 `electron/capabilities/catalog/*.cjs` 驱动（40+ 工具，渐进式加载）。
//! termX 本阶段只移植「已存在可复用执行链路」的 5 个工具，其余在
//! `docs/mcp-port-plan.md` 里列为未实现并说明缺口，绝不注册空转工具。
//!
//! 返回结构统一为 `{code, message, hint, ...数据}`：
//! - 只读工具保留原有字段（sessions / hostCount / hosts / snippets），不破坏已验证客户端；
//! - `hint` 永远说明 agent 下一步该做什么，便于失败自纠。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::commands::{lifecycle, plugin};
use crate::state::{AppState, SessionKind, SessionOwner};
use super::config::{McpConfig, PermissionMode};
use super::server::McpRuntime;

const HINT_SESSION_ID: &str = "先调用 get_environment 获取当前活跃会话，用返回的 sessions[].id 作为 sessionId；不要臆造 id。";
const HINT_PERMISSION: &str = "写操作受「设置 → AI → 工具接入」权限档位约束：observer 只读拒绝、confirm 需用户在 termX 弹窗中允许、auto 直接放行。";

pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

impl ToolResult {
    fn ok(message: impl Into<String>, hint: impl Into<String>, data: Value) -> Self {
        Self {
            text: envelope("ok", message, hint, Some(data)).to_string(),
            is_error: false,
        }
    }

    fn err(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            text: envelope(code, message, hint, None).to_string(),
            is_error: true,
        }
    }
}

/// 统一信封：`{code, message, hint}`；成功时把业务字段平铺进来。
fn envelope(
    code: &str,
    message: impl Into<String>,
    hint: impl Into<String>,
    data: Option<Value>,
) -> Value {
    let mut out = json!({
        "code": code,
        "message": message.into(),
        "hint": hint.into()
    });
    if let (Some(Value::Object(extra)), Some(map)) = (data, out.as_object_mut()) {
        for (key, value) in extra {
            map.insert(key, value);
        }
    }
    out
}

fn internal_error(e: impl std::fmt::Display) -> ToolResult {
    ToolResult::err(
        "internal_error",
        format!("{e}"),
        "稍后重试；若持续失败，请在 termX 中查看日志。",
    )
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
            "description": "只读。返回 termX 当前活跃的终端 / SFTP / 端口转发 / 串口会话（id / kind / phase）与已保存主机数量。\
何时用：会话开始时先调用它拿 sessionId；调用 terminal_execute / session_close 前确认真实会话。\
何时不用：只需要主机清单时用 vault_hosts_list；不要用它轮询等待新会话。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "vault_hosts_list",
            "description": "只读。返回已保存主机的 id / name / host / port / groupId，不含密码、密钥等凭据。\
何时用：需要知道用户保存了哪些主机、该选哪台时。\
何时不用：获取当前活跃会话用 get_environment；本工具不会打开连接，也不会执行命令。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "snippets_list",
            "description": "只读。返回已保存代码片段的 id / name / package / command / description；命令文本可能含敏感信息。\
何时用：需要复用用户预置的命令或脚本时。\
何时不用：不要用本工具执行命令；执行请用 terminal_execute。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "terminal_execute",
            "description": "写操作。在 get_environment 返回的某个已打开会话中执行一条命令，返回 stdout / stderr / exitCode。\
何时用：需要与目标主机的现有会话交互、查看输出或运行命令时。\
何时不用：只查询会话 / 主机清单时用只读工具；没有 sessionId 时不要调用；不要用它发起与本机会话无关的网络操作。\
受权限档位与命令黑名单约束。",
            "inputSchema": schema(
                json!({
                    "sessionId": {
                        "type": "string",
                        "description": "get_environment 返回的 sessions[].id",
                        "examples": ["ssh-1a2b3c", "serial-7f00aa"]
                    },
                    "command": {
                        "type": "string",
                        "description": "要执行的单条非空命令",
                        "examples": ["uname -a", "df -h", "systemctl status nginx"]
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 1000,
                        "maximum": 600000,
                        "default": 30000,
                        "description": "可选。执行超时毫秒，默认 30000"
                    }
                }),
                &["sessionId", "command"]
            ),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        },
        {
            "name": "session_close",
            "description": "写操作。关闭 get_environment 返回的指定会话。\
何时用：你打开且任务已完成的会话，或明确需要释放会话资源时。\
何时不用：用户正在使用的会话不要关闭；会话不存在时先 get_environment 确认。\
受权限档位约束。",
            "inputSchema": schema(
                json!({
                    "sessionId": {
                        "type": "string",
                        "description": "get_environment 返回的 sessions[].id",
                        "examples": ["ssh-1a2b3c"]
                    }
                }),
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

fn summarize_command(command: &str) -> String {
    const MAX_CHARS: usize = 200;
    let trimmed = command.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        trimmed.to_string()
    } else {
        let head: String = trimmed.chars().take(MAX_CHARS).collect();
        format!("{head}…")
    }
}

/// 写操作审批：auto 直接放行；observer 直接拒绝；confirm 走 UI 审批（含「始终允许」）。
#[allow(clippy::too_many_arguments)]
async fn approval_gate(
    cfg: &McpConfig,
    rt: &Arc<McpRuntime>,
    app: &AppHandle,
    gen: u64,
    disconnected: Arc<AtomicBool>,
    tool: &str,
    args_summary: String,
    session_id: Option<String>,
    target_label: Option<String>,
) -> Result<(), ToolResult> {
    match cfg.permission_mode {
        PermissionMode::Auto => Ok(()),
        PermissionMode::Observer => Err(ToolResult::err(
            "permission_denied",
            "当前权限档位为 observer，写操作被拒绝",
            HINT_PERMISSION,
        )),
        PermissionMode::Confirm => {
            let allowed = rt
                .request_approval(
                    app,
                    gen,
                    tool,
                    args_summary,
                    session_id,
                    target_label,
                    disconnected,
                )
                .await;
            if allowed {
                Ok(())
            } else {
                Err(ToolResult::err(
                    "permission_denied",
                    format!("{tool} 的审批被拒绝、超时或客户端已断开"),
                    HINT_PERMISSION,
                ))
            }
        }
    }
}

fn session_meta(state: &AppState, session_id: &str) -> Result<(SessionOwner, SessionKind), ToolResult> {
    let registry = state.lock_sessions().map_err(|e| internal_error(e))?;
    match registry.get(session_id) {
        Some(record) => Ok((record.owner.clone(), record.kind)),
        None => Err(ToolResult::err(
            "session_not_found",
            format!("找不到会话 {session_id}"),
            "重新调用 get_environment 获取当前活跃会话 id；会话可能已关闭。",
        )),
    }
}

fn environment(state: &AppState) -> Result<Value, ToolResult> {
    let registry = state.lock_sessions().map_err(|e| internal_error(e))?;
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
    let hosts = crate::db::profile::list(&state.db).map_err(internal_error)?;
    Ok(json!({
        "sessions": sessions,
        "hostCount": hosts.len(),
    }))
}

pub async fn call_tool(
    state: &AppState,
    cfg: &McpConfig,
    rt: &Arc<McpRuntime>,
    app: &AppHandle,
    gen: u64,
    disconnected: Arc<AtomicBool>,
    name: &str,
    args: &Value,
) -> ToolResult {
    match name {
        "get_environment" => match environment(state) {
            Ok(v) => ToolResult::ok(
                "已返回当前环境快照",
                "用 sessions[].id 作为 terminal_execute / session_close 的 sessionId；phase 为 ready 的会话才能执行命令。",
                v,
            ),
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
                ToolResult::ok(
                    "已返回已保存主机清单",
                    "这些主机尚未打开连接；要执行命令需先在 termX 中打开会话，再调用 get_environment。",
                    json!({ "hosts": items }),
                )
            }
            Err(e) => internal_error(e),
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
                ToolResult::ok(
                    "已返回已保存代码片段",
                    "找到目标命令后，用 terminal_execute 在指定会话中执行。",
                    json!({ "snippets": items }),
                )
            }
            Err(e) => internal_error(e),
        },
        "terminal_execute" => {
            let session_id = match args.get("sessionId").and_then(Value::as_str) {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 sessionId",
                        HINT_SESSION_ID,
                    )
                }
            };
            let command = match args.get("command").and_then(Value::as_str) {
                Some(v) if !v.trim().is_empty() => v.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 command",
                        "command 必须是非空字符串，例如 \"uname -a\"。",
                    )
                }
            };
            let timeout = args.get("timeoutMs").and_then(Value::as_u64);
            let blacklist = match crate::ai::command_blacklist::load(&state.db) {
                Ok(bl) => bl,
                Err(e) => return internal_error(e),
            };
            if let Err(e) = crate::ai::sanitize::validate_with(&command, &blacklist) {
                return ToolResult::err(
                    "command_blocked",
                    format!("命令被黑名单拦截：{e:?}"),
                    "改用等价但更具体的命令，或请用户在设置中调整命令黑名单。",
                );
            }
            let (owner, kind) = match session_meta(state, &session_id) {
                Ok(v) => v,
                Err(e) => return e,
            };
            let target_label = Some(format!("{} · {}", kind_name(kind), session_id));
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "terminal_execute",
                summarize_command(&command),
                Some(session_id.clone()),
                target_label,
            )
            .await
            {
                return e;
            }
            match plugin::plugin_exec_impl(state, &owner, session_id, command, timeout).await {
                Ok(out) => ToolResult::ok(
                    "命令执行完成",
                    "如需在同一会话继续执行，复用相同的 sessionId；任务结束调用 session_close。",
                    json!({
                        "stdout": out.stdout,
                        "stderr": out.stderr,
                        "exitCode": out.exit_code,
                    }),
                ),
                Err(e) => ToolResult::err(
                    "execute_failed",
                    e.to_string(),
                    "确认会话仍处于 ready 且命令语法正确后重试；会话断开时重新 get_environment。",
                ),
            }
        }
        "session_close" => {
            let session_id = match args.get("sessionId").and_then(Value::as_str) {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 sessionId",
                        HINT_SESSION_ID,
                    )
                }
            };
            let (owner, kind) = match session_meta(state, &session_id) {
                Ok(v) => v,
                Err(e) => return e,
            };
            let target_label = Some(format!("{} · {}", kind_name(kind), session_id));
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "session_close",
                format!("关闭会话 {session_id}"),
                Some(session_id.clone()),
                target_label,
            )
            .await
            {
                return e;
            }
            match lifecycle::close_resource(state, &session_id, kind, &owner) {
                Ok(()) => ToolResult::ok(
                    "会话已关闭",
                    "如需再次连接，请先在 termX 中重新打开会话，再调用 get_environment。",
                    json!({ "closed": session_id }),
                ),
                Err(e) => ToolResult::err(
                    "close_failed",
                    e.to_string(),
                    "重新 get_environment 确认会话是否仍存在；若已关闭可忽略。",
                ),
            }
        }
        _ => ToolResult::err(
            "unknown_tool",
            format!("未知工具：{name}"),
            "调用 tools/list 查看可用工具；仅支持 get_environment / vault_hosts_list / snippets_list / terminal_execute / session_close。",
        ),
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
            Ok(v) => ToolResult::ok(
                "已返回当前环境快照",
                "该资源等同 get_environment；需要执行命令时改用 terminal_execute。",
                v,
            ),
            Err(e) => e,
        },
        _ => ToolResult::err(
            "unknown_resource",
            format!("未知资源：{uri}"),
            "可用资源：termx://environment。",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_keeps_business_fields_and_unified_shape() {
        let ok = envelope(
            "ok",
            "done",
            "next",
            Some(json!({ "sessions": [], "hostCount": 3 })),
        );
        assert_eq!(ok["code"], "ok");
        assert_eq!(ok["message"], "done");
        assert_eq!(ok["hint"], "next");
        assert_eq!(ok["hostCount"], 3);
        assert!(ok["sessions"].is_array());

        let err = envelope("session_not_found", "missing", "retry", None);
        assert_eq!(err["code"], "session_not_found");
        assert_eq!(err.as_object().map(|m| m.len()), Some(3));
    }

    #[test]
    fn definitions_cover_five_tools_with_full_schemas() {
        let defs = definitions();
        let list = defs.as_array().unwrap();
        assert_eq!(list.len(), 5);
        for tool in list {
            let name = tool["name"].as_str().unwrap();
            let desc = tool["description"].as_str().unwrap();
            assert!(desc.contains("何时用"), "{name} 缺少何时用");
            assert!(desc.contains("何时不用"), "{name} 缺少何时不用");
            let schema = &tool["inputSchema"];
            assert_eq!(schema["type"], "object");
            assert!(schema["properties"].is_object());
            assert!(schema["required"].is_array());
        }
        let exec = list.iter().find(|t| t["name"] == "terminal_execute").unwrap();
        let props = &exec["inputSchema"]["properties"];
        assert_eq!(props["sessionId"]["type"], "string");
        assert!(props["sessionId"]["examples"].is_array());
        assert_eq!(props["timeoutMs"]["type"], "integer");
        assert_eq!(
            exec["inputSchema"]["required"],
            json!(["sessionId", "command"])
        );
    }

    #[test]
    fn read_only_tools_keep_original_fields() {
        let ok = ToolResult::ok("msg", "hint", json!({ "sessions": [], "hostCount": 1 }));
        assert!(!ok.is_error);
        let parsed: Value = serde_json::from_str(&ok.text).unwrap();
        assert!(parsed["sessions"].is_array());
        assert_eq!(parsed["hostCount"], 1);
    }
}
