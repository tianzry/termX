use tauri::{AppHandle, Emitter, State};

use crate::error::{locked, AppError, AppResult};
use crate::models::TelnetProfile;
use crate::state::{AppState, SessionKind, SessionOwner};
use crate::terminal::telnet;

/// Async on purpose: DNS resolution + TCP connect can block for up to 10s per
/// address. A sync command would sit on the main thread and freeze the UI, so
/// the blocking connect runs on a worker via spawn_blocking.
///
/// `cols`/`rows` seed the NAWS activation reply with the real terminal size
/// (same contract as `ssh_connect`).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat fields preserve the existing invoke wire contract.
pub async fn telnet_open(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    host: String,
    port: u16,
    cols: u16,
    rows: u16,
    input_newline: Option<String>,
    username: Option<String>,
    password: Option<String>,
    session_id: Option<String>,
) -> AppResult<String> {
    // Turn transport-agnostic telnet output into Tauri events. The headless ws
    // server builds a different sink over the same `telnet::open`.
    let session_id = crate::commands::lifecycle::resolve_session_id(session_id)?;
    let input_newline = input_newline.unwrap_or_else(|| "crlf".into());
    let reservation = crate::commands::lifecycle::reserve_resource(
        &state,
        &session_id,
        SessionKind::Telnet,
        SessionOwner::Window(window.label().to_owned()),
    )?;
    let log_title = format!("Telnet {host}:{port}");
    let log_slots = crate::commands::session_logs::prepare_log_slots(
        &state,
        &session_id,
        &log_title,
        u32::from(cols),
        u32::from(rows),
    )
    .unwrap_or_default();
    let sink_slots = log_slots.clone();
    let sink: telnet::TelnetSink =
        std::sync::Arc::new(move |id: &str, out: telnet::TelnetOut| match out {
            telnet::TelnetOut::Data(b) => {
                sink_slots.record(&b);
                let _ = app.emit(
                    &format!("telnet:data:{id}"),
                    crate::emitter::b64_payload(&b),
                );
            }
            telnet::TelnetOut::RemoteEcho(enabled) => {
                let _ = app.emit(&format!("telnet:echo:{id}"), enabled);
            }
            telnet::TelnetOut::AutoLogin(status) => {
                let _ = app.emit(
                    &format!("telnet:auto_login:{id}"),
                    serde_json::json!({ "status": status }),
                );
            }
            telnet::TelnetOut::Close => {
                sink_slots.finish();
                let _ = app.emit(&format!("telnet:close:{id}"), ());
            }
        });
    let spawn_session_id = session_id.clone();
    let opened = tauri::async_runtime::spawn_blocking(move || {
        telnet::open(
            spawn_session_id,
            &host,
            port,
            cols,
            rows,
            &input_newline,
            username,
            password,
            sink,
        )
    })
    .await
    .map_err(|e| {
        AppError::other(
            "task_join_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    });
    let (id, handle) = match opened {
        Ok(inner) => match inner {
            Ok(v) => v,
            Err(error) => {
                // 连不上时槽位已建好文件，立刻收尾，避免留下空 `.cast` 与悬挂句柄。
                log_slots.finish();
                return Err(error);
            }
        },
        Err(error) => {
            log_slots.finish();
            return Err(error);
        }
    };
    reservation.activate_returned(
        &id,
        crate::commands::lifecycle::ReadySession::Telnet(handle),
    )?;
    Ok(id)
}

/// Look up an open telnet session's handle (cloned — `TelnetHandle` is Arc-backed).
fn telnet_handle(state: &State<'_, AppState>, session_id: &str) -> AppResult<telnet::TelnetHandle> {
    locked(&state.telnet_sessions)?
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("telnet_not_found", serde_json::json!({})))
}

#[tauri::command]
pub fn telnet_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
    encoding: Option<String>,
) -> AppResult<()> {
    let bytes = crate::terminal::encoding::encode_terminal_input(&data, encoding.as_deref());
    telnet_handle(&state, &session_id)?.write(&bytes)
}

#[tauri::command]
pub fn telnet_write_line(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    telnet_handle(&state, &session_id)?.write_line(&text)
}

/// Report the terminal size to the server (NAWS). Unlike serial, telnet HAS
/// rows/cols; before the server activates NAWS this is a silent no-op.
#[tauri::command]
pub fn telnet_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    telnet_handle(&state, &session_id)?.resize(cols, rows)
}

#[tauri::command]
pub fn telnet_close(
    window: tauri::Window,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    crate::commands::lifecycle::close_resource(
        &state,
        &session_id,
        SessionKind::Telnet,
        &SessionOwner::Window(window.label().to_owned()),
    )
}

// ── Saved telnet profiles (peer of serial profiles; SQLite-persisted CRUD) ──

#[tauri::command]
pub fn list_telnet_profiles(state: State<'_, AppState>) -> AppResult<Vec<TelnetProfile>> {
    crate::telnet_profile::list_metadata(&state.db)
}

#[tauri::command]
pub fn get_telnet_profile(state: State<'_, AppState>, id: String) -> AppResult<TelnetProfile> {
    crate::telnet_profile::get_full(&state.db, state.secret_store.as_ref(), &id)
}

#[tauri::command]
pub fn create_telnet_profile(state: State<'_, AppState>, profile: TelnetProfile) -> AppResult<()> {
    let intent = crate::telnet_profile::LoginScriptIntent::from_profile(&profile);
    crate::telnet_profile::upsert(&state.db, state.secret_store.as_ref(), &profile, intent)
}

#[tauri::command]
pub fn update_telnet_profile(
    state: State<'_, AppState>,
    profile: TelnetProfile,
    login_script_update: Option<crate::telnet_profile::LoginScriptUpdate>,
) -> AppResult<()> {
    let intent = crate::telnet_profile::LoginScriptIntent::from_update_profile(
        &profile,
        login_script_update,
    );
    crate::telnet_profile::update(&state.db, state.secret_store.as_ref(), &profile, intent)
}

#[tauri::command]
pub fn delete_telnet_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::telnet_profile::delete(&state.db, state.secret_store.as_ref(), &id)
}
