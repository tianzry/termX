use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::mcp::approval::{self, ApprovalDecision, ApprovalRequestPayload};
use crate::mcp::config::{self, McpConfig};
use crate::mcp::grants::{self, PermissionGrant};
use crate::mcp::guide::{self, GuideBlock};
use crate::mcp::{
    blocklist,
    server::{client_snippet, McpRuntime, McpState, McpStatus},
};
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

/// 是否需要重建监听：未运行必然要起；运行中只有端口 / 监听地址变化要重启。
/// 权限档、client_host、「始终允许」工具名单等纯设置项原地生效，不重启也不换 token。
fn needs_restart(previous: &McpConfig, next: &McpConfig, running: bool) -> bool {
    !running || previous.bind_changed(next)
}

fn apply(
    app: &tauri::AppHandle,
    state: &AppState,
    rt: &Arc<McpRuntime>,
    cfg: McpConfig,
) -> AppResult<McpStatus> {
    config::validate(&cfg).map_err(|(code, msg)| invalid(code, msg))?;
    let previous = config::load(&state.db);
    config::save(&state.db, &cfg)?;
    let running = rt.status().running;
    let enabled = cfg.enabled;
    if !enabled {
        rt.stop(Some(app));
    } else if needs_restart(&previous, &cfg, running) {
        rt.start(app.clone(), cfg)
            .map_err(|(code, msg)| invalid(code, msg))?;
    } else {
        // 纯设置项：原地更新，token 与已连接客户端都不受影响。
        rt.set_config(cfg);
    }
    let mut status = rt.status();
    // 启动是异步的：立即读 status 可能仍是 listening=false，把配置里的端口先回给前端，
    // 前端随后通过 mcp_status 轮询到真实 bound port。
    status.enabled = enabled;
    status.clients = config::load_clients(&state.db);
    Ok(status)
}

#[tauri::command]
pub fn mcp_status(rt: State<'_, McpState>, state: State<'_, AppState>) -> AppResult<McpStatus> {
    let cfg = config::load(&state.db);
    let mut status = runtime(&rt).status();
    status.enabled = cfg.enabled;
    status.grants = grants::load(&state.db);
    if !status.running {
        status.permission_mode = cfg.permission_mode.as_str().to_string();
        status.allow_custom_bind = cfg.allow_custom_bind;
        status.listen_address = cfg.listen_address.clone();
        status.client_host = cfg.client_host.clone();
        status.port = cfg.port;
    }
    status.clients = config::load_clients(&state.db);
    Ok(status)
}

/// 保存多客户端接入配置；token 为空时自动生成。
///
/// 认证按请求实时读设置，因此保存后无需重启监听，新 token 立即可用。
#[tauri::command]
pub fn mcp_clients_save(
    state: State<'_, AppState>,
    clients: Vec<config::McpClientConfig>,
) -> AppResult<Vec<config::McpClientConfig>> {
    config::save_clients_checked(&state.db, clients)
        .map_err(|(code, msg)| invalid(code, msg))
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
pub fn mcp_rotate_token(app: tauri::AppHandle, rt: State<'_, McpState>) -> AppResult<McpStatus> {
    runtime(&rt).rotate_token(&app);
    Ok(runtime(&rt).status())
}

#[tauri::command]
pub fn mcp_client_config(rt: State<'_, McpState>, kind: String) -> AppResult<String> {
    Ok(client_snippet(&runtime(&rt).status(), &kind))
}

/// 设置页「接入指南」：与 `initialize.instructions` 共用 `mcp::guide` 的同一份文案。
#[tauri::command]
pub fn mcp_guide(rt: State<'_, McpState>) -> AppResult<Vec<GuideBlock>> {
    let status = runtime(&rt).status();
    Ok(guide::blocks(
        status.url.as_deref(),
        status.bearer_token.as_deref(),
    ))
}

#[tauri::command]
pub fn mcp_approval_pending(rt: State<'_, McpState>) -> AppResult<Vec<ApprovalRequestPayload>> {
    Ok(runtime(&rt).pending_approvals())
}

/// 结算一个待审批项：`once` 允许一次、`always` 允许并把本次操作沉淀成放行规则、`reject` 拒绝。
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
        let mut all = grants::load(&state.db);
        let incoming =
            grants::build_grants_from_approval(&taken.tool, &taken.args, taken.note.clone());
        grants::merge_grants(&mut all, incoming);
        if let Err(e) = grants::save(&state.db, &all) {
            let _ = taken.tx.send(false);
            approval::emit_cleared(&app, &[approval_id.clone()], "rejected");
            approval::sync_attention(&app, rt.approvals().pending_count());
            return Err(e);
        }
        rt.approvals().set_grants(all);
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

/// 删除一条许可记忆规则（设置页「许可记忆表」）。
#[tauri::command]
pub fn mcp_grant_remove(
    rt: State<'_, McpState>,
    state: State<'_, AppState>,
    grant_id: String,
) -> AppResult<Vec<PermissionGrant>> {
    let mut all = grants::load(&state.db);
    all.retain(|grant| grant.id != grant_id);
    grants::save(&state.db, &all)?;
    runtime(&rt).approvals().remove_grant(&grant_id);
    Ok(all)
}

#[tauri::command]
pub fn mcp_grants_list(state: State<'_, AppState>) -> AppResult<Vec<PermissionGrant>> {
    Ok(grants::load(&state.db))
}

/// 保存整张许可记忆表（手动编辑后回写，并同步到运行中的 MCP 服务）。
#[tauri::command]
pub fn mcp_grants_save(
    rt: State<'_, McpState>,
    state: State<'_, AppState>,
    grants_list: Vec<PermissionGrant>,
) -> AppResult<Vec<PermissionGrant>> {
    let mut all = grants_list;
    all.retain(|grant| !grant.capability_id.trim().is_empty());
    for grant in &mut all {
        grant.capability_id = grant.capability_id.trim().to_string();
    }
    grants::save(&state.db, &all)?;
    runtime(&rt).approvals().set_grants(all.clone());
    Ok(all)
}

#[tauri::command]
pub fn mcp_grants_import(
    rt: State<'_, McpState>,
    state: State<'_, AppState>,
    raw: String,
) -> AppResult<Vec<PermissionGrant>> {
    let all = grants::import_json(&state.db, &raw)
        .map_err(|message| invalid("mcp_invalid_grants".to_string(), message))?;
    runtime(&rt).approvals().set_grants(all.clone());
    Ok(all)
}

#[tauri::command]
pub fn mcp_grants_export(state: State<'_, AppState>) -> AppResult<String> {
    grants::export_json(&state.db)
}

#[tauri::command]
pub fn mcp_blocklist_get(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(blocklist::load(&state.db))
}

#[tauri::command]
pub fn mcp_blocklist_set(
    state: State<'_, AppState>,
    patterns: Vec<String>,
) -> AppResult<Vec<String>> {
    let list: Vec<String> = patterns
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .take(200)
        .collect();
    blocklist::save(&state.db, &list)?;
    Ok(list)
}

/// 恢复出厂规则清单（用户自定义项按 Netcatty 行为一并清空）。
#[tauri::command]
pub fn mcp_blocklist_reset(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    blocklist::reset(&state.db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::config::PermissionMode;

    fn running_cfg() -> McpConfig {
        McpConfig {
            enabled: true,
            ..McpConfig::default()
        }
    }

    #[test]
    fn permission_mode_change_does_not_restart() {
        let prev = running_cfg();
        let mut next = prev.clone();
        next.permission_mode = PermissionMode::Auto;
        assert!(!needs_restart(&prev, &next, true));
        assert!(!prev.bind_changed(&next));
    }

    #[test]
    fn client_host_change_does_not_restart() {
        let prev = running_cfg();
        let mut next = prev.clone();
        next.client_host = "192.168.1.10".to_string();
        assert!(!needs_restart(&prev, &next, true));
    }

    #[test]
    fn port_change_requires_restart() {
        let prev = running_cfg();
        let mut next = prev.clone();
        next.port = 49391;
        assert!(needs_restart(&prev, &next, true));
    }

    #[test]
    fn stopped_listener_always_restarts() {
        let cfg = running_cfg();
        assert!(needs_restart(&cfg, &cfg.clone(), false));
    }
}
