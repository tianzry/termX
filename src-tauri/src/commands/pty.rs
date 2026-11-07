use tauri::{AppHandle, Emitter, State};

use crate::emitter::b64_payload;
use crate::error::{locked, AppError, AppResult};
use crate::models::{ConnectorSpec, DynamicDiscoveryPlatform};
use crate::state::{AppState, SessionKind, SessionOwner};
use crate::terminal::pty;

/// 启动目录 `~` / `~/...` 展开为主目录（对齐 Netcatty localShellHost 语义）。
/// 空串 → None（继承全局起始目录）；拿不到主目录时 `~` 整项丢弃。
pub(crate) fn expand_start_dir(start_dir: Option<String>) -> Option<std::path::PathBuf> {
    let trimmed = start_dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    if trimmed == "~" {
        return dirs::home_dir();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return dirs::home_dir().map(|h| h.join(rest));
    }
    Some(std::path::PathBuf::from(trimmed))
}

/// 本地 shell 解析（与 `default_shell` 命令同一套优先级）：
/// 请求参数 → `local_shell` 设置 → `pty::default_shell()`。
pub(crate) fn resolve_local_shell(db: &crate::db::Db, requested: Option<String>) -> String {
    requested
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            crate::db::settings::get(db, "local_shell")
                .ok()
                .flatten()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(pty::default_shell)
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    session_id: Option<String>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    start_dir: Option<String>,
) -> AppResult<String> {
    let session_id = crate::commands::lifecycle::resolve_session_id(session_id)?;
    let shell = resolve_local_shell(&state.db, shell);
    let cwd = expand_start_dir(start_dir);
    let reservation = crate::commands::lifecycle::reserve_resource(
        &state,
        &session_id,
        SessionKind::Pty,
        SessionOwner::Window(window.label().to_owned()),
    )?;
    // 本地 shell 没有主机档案：默认不自动记录，需要时由工具栏手动开始。
    let log_slots = crate::commands::session_logs::prepare_log_slots(
        &state,
        &session_id,
        None,
    )
    .unwrap_or_default();
    let sink_slots = log_slots.clone();
    // Turn transport-agnostic PTY output into Tauri events. The headless ws
    // server builds a different sink over the same `pty::spawn`.
    let sink: pty::PtySink = std::sync::Arc::new(move |id: &str, out: pty::PtyOut| match out {
        pty::PtyOut::Data(b) => {
            sink_slots.record(&b);
            let _ = app.emit(&format!("pty:data:{id}"), b64_payload(&b));
        }
        pty::PtyOut::Close { exit_code, signal } => {
            sink_slots.finish();
            let _ = app.emit(
                &format!("pty:close:{id}"),
                crate::models::CloseInfo { exit_code, signal },
            );
        }
    });
    let (id, handle) = match pty::spawn_local_shell(session_id, cols, rows, sink, shell, args, cwd) {
        Ok(v) => v,
        Err(error) => {
            // spawn 失败时槽位已建好文件，立刻收尾，避免留下空 `.cast` 与悬挂句柄。
            log_slots.finish();
            return Err(error);
        }
    };
    reservation.activate_returned(&id, crate::commands::lifecycle::ReadySession::Pty(handle))?;
    Ok(id)
}

fn connector_command(spec: ConnectorSpec) -> AppResult<(DynamicDiscoveryPlatform, Vec<String>)> {
    match spec {
        ConnectorSpec::DockerExec {
            context,
            container_id,
            shell,
            ..
        } => {
            if context.trim().is_empty()
                || container_id.trim().is_empty()
                || shell.trim().is_empty()
            {
                return Err(AppError::config(
                    "dynamic_discovery_connector_invalid",
                    serde_json::json!({}),
                ));
            }
            Ok((
                DynamicDiscoveryPlatform::Docker,
                vec![
                    "--context".into(),
                    context,
                    "exec".into(),
                    "-it".into(),
                    container_id,
                    shell,
                ],
            ))
        }
        ConnectorSpec::KubectlExec {
            context,
            namespace,
            pod,
            container,
            shell,
        } => {
            if context.trim().is_empty()
                || namespace.trim().is_empty()
                || pod.trim().is_empty()
                || shell.trim().is_empty()
            {
                return Err(AppError::config(
                    "dynamic_discovery_connector_invalid",
                    serde_json::json!({}),
                ));
            }
            let mut args = vec![
                "--context".into(),
                context,
                "exec".into(),
                "-n".into(),
                namespace,
                "-it".into(),
                pod,
            ];
            if let Some(c) = container.filter(|c| !c.trim().is_empty()) {
                args.push("-c".into());
                args.push(c);
            }
            args.push("--".into());
            args.push(shell);
            Ok((DynamicDiscoveryPlatform::K8s, args))
        }
    }
}

#[tauri::command]
pub fn pty_spawn_connector(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    spec: ConnectorSpec,
    session_id: Option<String>,
) -> AppResult<String> {
    let session_id = crate::commands::lifecycle::resolve_session_id(session_id)?;
    let (platform, args) = connector_command(spec)?;
    let program = crate::commands::discovery::resolve_dynamic_discovery_program(platform)?;
    let reservation = crate::commands::lifecycle::reserve_resource(
        &state,
        &session_id,
        SessionKind::Pty,
        SessionOwner::Window(window.label().to_owned()),
    )?;
    let log_slots = crate::commands::session_logs::prepare_log_slots(
        &state,
        &session_id,
        None,
    )
    .unwrap_or_default();
    let sink_slots = log_slots.clone();
    let sink: pty::PtySink = std::sync::Arc::new(move |id: &str, out: pty::PtyOut| match out {
        pty::PtyOut::Data(b) => {
            sink_slots.record(&b);
            let _ = app.emit(&format!("pty:data:{id}"), b64_payload(&b));
        }
        pty::PtyOut::Close { exit_code, signal } => {
            sink_slots.finish();
            let _ = app.emit(
                &format!("pty:close:{id}"),
                crate::models::CloseInfo { exit_code, signal },
            );
        }
    });
    let (id, handle) = pty::spawn_command(
        session_id,
        cols,
        rows,
        sink,
        program.executable,
        program.search_path,
        args,
    )?;
    reservation.activate_returned(&id, crate::commands::lifecycle::ReadySession::Pty(handle))?;
    Ok(id)
}

// list_shells / refresh_shells 当前没有可失败的内部操作（lock poison 在
// pty 模块内部静默回退到现场扫描），返 AppResult 是为了遵循项目"所有 tauri
// command 走 AppResult"的统一约定 —— 将来要往里塞会失败的扫描器时，签名
// 不用动，前端 error 处理路径已通。
#[tauri::command]
pub fn list_shells() -> AppResult<Vec<String>> {
    Ok(pty::available_shells())
}

/// 本机「默认 shell」解析结果 —— 与 `pty_spawn` 完全同一套逻辑
///（`local_shell` 设置优先，空则退回 `pty::default_shell()`），
/// 供前端主机首页的本地终端卡显示真实 shell 名。
#[tauri::command]
pub fn default_shell(state: State<'_, AppState>) -> AppResult<String> {
    let configured = crate::db::settings::get(&state.db, "local_shell")?
        .filter(|s| !s.is_empty());
    Ok(configured.unwrap_or_else(pty::default_shell))
}

/// Shell 设置页"刷新"按钮触发：用户装了新 shell 后不必重启 app。
/// 同步重扫一遍（< 1ms），返回最新列表，前端直接覆盖下拉。
#[tauri::command]
pub fn refresh_shells() -> AppResult<Vec<String>> {
    pty::refresh_available_shells();
    Ok(pty::available_shells())
}

/// 本地终端主机面板的 shell 发现：返回带 id / 名称 / 命令 / 参数 / 图标 /
/// 默认标记的结构化列表（对齐 Netcatty discoverShells）。
#[tauri::command]
pub fn discover_shells() -> AppResult<Vec<crate::models::DiscoveredShell>> {
    Ok(crate::terminal::shell_discovery::discover())
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, session_id: String, data: Vec<u8>) -> AppResult<()> {
    let handle = locked(&state.pty_sessions)?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("pty_not_found", serde_json::json!({})))?;
    handle.write(&data)
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let handle = locked(&state.pty_sessions)?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("pty_not_found", serde_json::json!({})))?;
    handle.resize(cols, rows)
}

#[tauri::command]
pub fn pty_close(
    window: tauri::Window,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    crate::commands::lifecycle::close_resource(
        &state,
        &session_id,
        SessionKind::Pty,
        &SessionOwner::Window(window.label().to_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_start_dir_handles_tilde_and_plain_paths() {
        // 空 / 纯空白 → None（继承全局起始目录）
        assert_eq!(expand_start_dir(None), None);
        assert_eq!(expand_start_dir(Some("   ".into())), None);

        // 普通绝对路径原样透传
        let plain = expand_start_dir(Some("/tmp/work".into())).unwrap();
        assert_eq!(plain, std::path::PathBuf::from("/tmp/work"));

        // `~` 与 `~/...` 展开为主目录（拿不到主目录的环境里只验证不 panic）
        if let Some(home) = dirs::home_dir() {
            assert_eq!(expand_start_dir(Some("~".into())), Some(home.clone()));
            assert_eq!(
                expand_start_dir(Some("~/proj".into())),
                Some(home.join("proj"))
            );
        }
    }
}
