use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::mcp::approval::{self, ApprovalDecision, ApprovalRequestPayload};
use crate::mcp::config::{self, McpConfig};
use crate::mcp::server::{client_snippet, McpRuntime, McpState, McpStatus};
use crate::state::AppState;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfigPatch {
    pub enabled: Option<bool>,
    pub port: Option<u16>,
    pub allow_custom_bind: Option<bool>,
    pub listen_address: Option<String>,
    pub client_host: Option<String>,
    pub permission_mode: Option<String>,
}

fn runtime(state: &State<'_, McpState>) -> Arc<McpRuntime> {
    state.0.clone()
}

fn merge(cfg: &mut McpConfig, patch: &McpConfigPatch) {
    if let Some(v) = patch.enabled {
        cfg.enabled = v;
    }
    if let Some(v) = patch.port {
        cfg.port = v;
    }
    if let Some(v) = patch.allow_custom_bind {
        cfg.allow_custom_bind = v;
    }
    if let Some(v) = patch.listen_address.as_ref() {
        cfg.listen_address = v.trim().to_string();
    }
    if let Some(v) = patch.client_host.as_ref() {
        cfg.client_host = v.trim().to_string();
    }
    if let Some(v) = patch.permission_mode.as_ref() {
        cfg.permission_mode = config::PermissionMode::parse(v);
    }
}

fn invalid(code: String, msg: String) -> AppError {
    AppError::config(
        "mcp_invalid_config",
        serde_json::json!({ "code": code, "message": msg }),
    )
}

fn apply(
    app: &tauri::AppHandle,
    state: &AppState,
    rt: &Arc<McpRuntime>,
    cfg: McpConfig,
) -> AppResult<McpStatus> {
    config::validate(&cfg).map_err(|(code, msg)| invalid(code, msg))?;
    config::save(&state.db, &cfg)?;
    let enabled = cfg.enabled;
    if enabled {
        rt.start(app.clone(), cfg)
            .map_err(|(code, msg)| invalid(code, msg))?;
    } else {
        rt.stop(Some(app));
    }
    let mut status = rt.status();
    // 启动是异步的：立即读 status 可能仍是 listening=false，把配置里的端口先回给前端，
    // 前端随后通过 mcp_status 轮询到真实 bound port。
    status.enabled = enabled;
    Ok(status)
}

#[tauri::command]
pub fn mcp_status(rt: State<'_, McpState>, state: State<'_, AppState>) -> AppResult<McpStatus> {
    let cfg = config::load(&state.db);
    let mut status = runtime(&rt).status();
    status.enabled = cfg.enabled;
    status.allowed_tools = config::load_allowed_tools(&state.db);
    if !status.running {
        status.permission_mode = cfg.permission_mode.as_str().to_string();
        status.allow_custom_bind = cfg.allow_custom_bind;
        status.listen_address = cfg.listen_address.clone();
        status.client_host = cfg.client_host.clone();
        status.port = cfg.port;
    }
    Ok(status)
}

#[tauri::command]
pub fn mcp_set_config(
    app: tauri::AppHandle,
    rt: State<'_, McpState>,
    state: State<'_, AppState>,
    patch: McpConfigPatch,
) -> AppResult<McpStatus> {
    let mut cfg = config::load(&state.db);
    merge(&mut cfg, &patch);
    apply(&app, &state, &runtime(&rt), cfg)
}

#[tauri::command]
pub fn mcp_rotate_token(rt: State<'_, McpState>) -> AppResult<McpStatus> {
    runtime(&rt).rotate_token();
    Ok(runtime(&rt).status())
}

#[tauri::command]
pub fn mcp_client_config(rt: State<'_, McpState>, kind: String) -> AppResult<String> {
    Ok(client_snippet(&runtime(&rt).status(), &kind))
}

#[tauri::command]
pub fn mcp_approval_pending(rt: State<'_, McpState>) -> AppResult<Vec<ApprovalRequestPayload>> {
    Ok(runtime(&rt).pending_approvals())
}

/// 结算一个待审批项：`once` 允许一次、`always` 允许并持久化该工具、`reject` 拒绝。
#[tauri::command]
pub fn mcp_approval_resolve(
    app: tauri::AppHandle,
    rt: State<'_, McpState>,
    state: State<'_, AppState>,
    approval_id: String,
    decision: String,
) -> AppResult<bool> {
    let decision = ApprovalDecision::parse(&decision).ok_or_else(|| {
        invalid(
            "mcp_bad_decision".to_string(),
            "decision 必须是 once / always / reject".to_string(),
        )
    })?;
    let rt = runtime(&rt);
    let Some(taken) = rt.take_approval(&approval_id) else {
        return Ok(false);
    };
    let allow = decision.allows();
    if decision == ApprovalDecision::Always {
        if let Err(e) = config::add_allowed_tool(&state.db, &taken.tool) {
            let _ = taken.tx.send(false);
            approval::emit_cleared(&app, &[approval_id.clone()], "rejected");
            approval::sync_attention(&app, rt.approvals().pending_count());
            return Err(e);
        }
        rt.approvals().allow_tool(&taken.tool);
    }
    let _ = taken.tx.send(allow);
    approval::emit_cleared(
        &app,
        &[approval_id],
        if allow { "approved" } else { "rejected" },
    );
    approval::sync_attention(&app, rt.approvals().pending_count());
    Ok(true)
}

/// 撤销某工具的「始终允许」。
#[tauri::command]
pub fn mcp_approval_revoke(
    rt: State<'_, McpState>,
    state: State<'_, AppState>,
    tool_name: String,
) -> AppResult<Vec<String>> {
    config::remove_allowed_tool(&state.db, &tool_name)?;
    let rt = runtime(&rt);
    let mut tools = rt.approvals().allowed_tools();
    tools.retain(|t| t != &tool_name);
    rt.approvals().set_allowed_tools(tools.clone());
    Ok(tools)
}
