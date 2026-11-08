use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
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
        rt.stop();
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
