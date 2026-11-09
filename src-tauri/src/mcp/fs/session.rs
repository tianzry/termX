//! MCP 会话解析：`sessionId` 直用，`hostId` 复用或按需自动建连。
//!
//! 自动建连复用 `commands::session::connect_profile`（与 UI 完全同一条链路：
//! 堡垒机链、代理、known_hosts、录制设置都一致），owner 使用
//! `SessionOwner::Headless`，因此不会占用窗口、也不会出现在标签页里。

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::error::{locked, AppError, AppResult};
use crate::ssh::client::SshHandle;
use crate::state::{AppState, SessionKind, SessionOwner, SessionPhase};

use super::super::config::McpClient;
use super::super::runtime_state;

/// 会话来源：用户窗口打开，或 MCP 自动建立。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionOrigin {
    User,
    Mcp,
}

pub struct ResolvedSession {
    pub session_id: String,
    pub profile_id: String,
    pub handle: SshHandle,
    pub origin: SessionOrigin,
}

impl SessionOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionOrigin::User => "user",
            SessionOrigin::Mcp => "mcp",
        }
    }
}

pub fn session_id_arg(args: &Value) -> Option<String> {
    args.get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn host_id_arg(args: &Value) -> Option<String> {
    ["hostId", "profileId"]
        .iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 会话对客户端可见：用户窗口会话共享；MCP 自动建连的只归建立它的客户端。
pub fn visible_to_client(owner: &SessionOwner, client: &McpClient) -> bool {
    match owner {
        SessionOwner::Window(_) => true,
        SessionOwner::Headless(id) => *id == runtime_state::owner_for_client(&client.id),
    }
}

fn forbidden(session_id: &str) -> AppError {
    AppError::config("mcp_session_forbidden", json!({ "id": session_id }))
}

/// 解析工具参数里的会话：`sessionId` 优先，其次 `hostId`。
pub async fn resolve(
    app: &AppHandle,
    state: &AppState,
    args: &Value,
    client: &McpClient,
) -> AppResult<ResolvedSession> {
    if let Some(session_id) = session_id_arg(args) {
        return ready_by_id(state, &session_id, client);
    }
    if let Some(host_id) = host_id_arg(args) {
        return ensure_for_host(app, state, &host_id, client).await;
    }
    Err(AppError::config("mcp_session_missing", json!({})))
}

fn ready_by_id(
    state: &AppState,
    session_id: &str,
    client: &McpClient,
) -> AppResult<ResolvedSession> {
    let origin = {
        let registry = locked(&state.lifecycle_sessions)?;
        let record = registry.get(session_id).ok_or_else(|| {
            AppError::not_found("mcp_session_not_found", json!({ "id": session_id }))
        })?;
        if !visible_to_client(&record.owner, client) {
            return Err(forbidden(session_id));
        }
        ensure_ssh_ready(session_id, record.kind, record.phase)?;
        origin_of(record.owner.clone())
    };
    let handle = {
        let sessions = locked(&state.sessions)?;
        sessions
            .get(session_id)
            .ok_or_else(|| {
                AppError::not_found("mcp_session_not_found", json!({ "id": session_id }))
            })?
            .clone()
    };
    Ok(ResolvedSession {
        session_id: session_id.to_string(),
        profile_id: handle.profile_id().to_string(),
        handle: handle.ssh_handle().clone(),
        origin,
    })
}

/// 需要 SFTP / exec 通道的工具只接受 ready 的 SSH 会话：
/// - 其它传输（串口 / Telnet / PTY / SFTP / 转发）回 `mcp_unsupported_session_kind`；
/// - SSH 但未 ready 回 `mcp_session_not_ready`。
fn ensure_ssh_ready(session_id: &str, kind: SessionKind, phase: SessionPhase) -> AppResult<()> {
    if kind != SessionKind::Ssh {
        return Err(AppError::config(
            "mcp_unsupported_session_kind",
            json!({ "id": session_id, "kind": kind.as_str() }),
        ));
    }
    if phase != SessionPhase::Ready {
        return Err(AppError::config(
            "mcp_session_not_ready",
            json!({ "id": session_id }),
        ));
    }
    Ok(())
}

fn origin_of(owner: SessionOwner) -> SessionOrigin {
    match owner {
        SessionOwner::Headless(_) => SessionOrigin::Mcp,
        SessionOwner::Window(_) => SessionOrigin::User,
    }
}

/// 复用该主机的 ready 会话；没有就自动建连（同客户端同主机单飞）。
pub async fn ensure_for_host(
    app: &AppHandle,
    state: &AppState,
    host_id: &str,
    client: &McpClient,
) -> AppResult<ResolvedSession> {
    // 先确认 vault 里有这个主机档案；不存在直接回 not_found，避免无意义建连。
    crate::db::profile::get(&state.db, host_id)?;
    if let Some(found) = find_ready_for_host(state, host_id, client)? {
        return Ok(found);
    }

    let gate = runtime_state::connect_gate(&client.id, host_id);
    let _guard = gate.lock().await;
    if let Some(found) = find_ready_for_host(state, host_id, client)? {
        return Ok(found);
    }

    let owner = SessionOwner::Headless(runtime_state::owner_for_client(&client.id));
    crate::commands::session::connect_profile(
        app.clone(),
        state,
        owner,
        host_id.to_string(),
        None,
        80,
        24,
        None,
        None,
    )
    .await?;

    find_ready_for_host(state, host_id, client)?
        .ok_or_else(|| AppError::other("mcp_session_lost", json!({ "hostId": host_id })))
}

fn find_ready_for_host(
    state: &AppState,
    host_id: &str,
    client: &McpClient,
) -> AppResult<Option<ResolvedSession>> {
    let candidates: Vec<(String, SessionOrigin)> = {
        let registry = locked(&state.lifecycle_sessions)?;
        registry
            .iter()
            .filter(|(_, record)| {
                record.kind == SessionKind::Ssh
                    && record.phase == SessionPhase::Ready
                    && visible_to_client(&record.owner, client)
            })
            .map(|(id, record)| (id.clone(), origin_of(record.owner.clone())))
            .collect()
    };

    let sessions = locked(&state.sessions)?;
    for (session_id, origin) in candidates {
        let Some(handle) = sessions.get(&session_id) else {
            continue;
        };
        if handle.profile_id() == host_id {
            return Ok(Some(ResolvedSession {
                session_id,
                profile_id: handle.profile_id().to_string(),
                handle: handle.ssh_handle().clone(),
                origin,
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取出 `__termx_err__|{...}` 协议串里的 code 与 params。
    fn error_parts(result: AppResult<()>) -> (&'static str, Value) {
        let error = result.expect_err("expected an error");
        let text = error.to_string();
        let payload = text
            .strip_prefix("__termx_err__|")
            .unwrap_or_else(|| panic!("missing protocol prefix: {text}"));
        let value: Value = serde_json::from_str(payload).expect("params must be JSON");
        (error.code(), value["params"].clone())
    }

    #[test]
    fn non_ssh_session_kinds_report_unsupported() {
        let (code, params) = error_parts(ensure_ssh_ready(
            "telnet-1",
            SessionKind::Telnet,
            SessionPhase::Ready,
        ));
        assert_eq!(code, "mcp_unsupported_session_kind");
        assert_eq!(params, json!({ "id": "telnet-1", "kind": "telnet" }));

        let (code, params) = error_parts(ensure_ssh_ready(
            "sftp-1",
            SessionKind::Sftp,
            SessionPhase::Pending,
        ));
        assert_eq!(code, "mcp_unsupported_session_kind");
        assert_eq!(params, json!({ "id": "sftp-1", "kind": "sftp" }));

        #[cfg(desktop)]
        {
            let (code, params) = error_parts(ensure_ssh_ready(
                "serial-1",
                SessionKind::Serial,
                SessionPhase::Ready,
            ));
            assert_eq!(code, "mcp_unsupported_session_kind");
            assert_eq!(params, json!({ "id": "serial-1", "kind": "serial" }));
        }
    }

    #[test]
    fn ssh_session_only_fails_when_not_ready() {
        let (code, params) = error_parts(ensure_ssh_ready(
            "ssh-1",
            SessionKind::Ssh,
            SessionPhase::Pending,
        ));
        assert_eq!(code, "mcp_session_not_ready");
        assert_eq!(params, json!({ "id": "ssh-1" }));

        assert!(ensure_ssh_ready("ssh-1", SessionKind::Ssh, SessionPhase::Ready).is_ok());
    }
}
