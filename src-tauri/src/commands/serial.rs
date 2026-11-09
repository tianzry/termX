use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{locked, AppError, AppResult};
use crate::models::SerialProfile;
use crate::state::{AppState, SessionKind, SessionOwner};
use crate::terminal::serial;

#[tauri::command]
pub fn serial_list_ports() -> AppResult<Vec<serial::PortInfo>> {
    Ok(serial::available_ports())
}

#[tauri::command]
pub fn serial_open(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    port: String,
    config: serial::SerialConfig,
    session_id: Option<String>,
    // 来源已保存主机的档案 id；临时串口连接没有，默认不自动记录日志。
    profile_id: Option<String>,
) -> AppResult<String> {
    serial_open_for_owner(
        &app,
        &state,
        SessionOwner::Window(window.label().to_owned()),
        port,
        config,
        session_id,
        profile_id,
    )
}

/// 打开串口会话。UI 与 MCP（headless owner）共用同一条链路。
pub fn serial_open_for_owner(
    app: &AppHandle,
    state: &AppState,
    owner: SessionOwner,
    port: String,
    config: serial::SerialConfig,
    session_id: Option<String>,
    profile_id: Option<String>,
) -> AppResult<String> {
    let session_id = crate::commands::lifecycle::resolve_session_id(session_id)?;
    let reservation = crate::commands::lifecycle::reserve_resource(
        state,
        &session_id,
        SessionKind::Serial,
        owner,
    )?;
    let auto_log = crate::commands::settings::auto_session_log_path_for_profile_id(
        state,
        profile_id.as_deref(),
    );
    let log_slots = crate::commands::session_logs::prepare_log_slots(
        state,
        &session_id,
        auto_log,
    )
    .unwrap_or_default();
    let sink_slots = log_slots.clone();
    let sink_app = app.clone();
    // Turn transport-agnostic serial output into Tauri events. The headless ws
    // server builds a different sink over the same `serial::open`.
    let sink: serial::SerialSink =
        std::sync::Arc::new(move |id: &str, out: serial::SerialOut| match out {
            serial::SerialOut::Data(b) => {
                sink_slots.record(&b);
                let _ = sink_app.emit(
                    &format!("serial:data:{id}"),
                    crate::emitter::b64_payload(&b),
                );
            }
            serial::SerialOut::Close => {
                sink_slots.finish();
                crate::commands::lifecycle::mark_closed(&sink_app.state::<AppState>(), id);
                let _ = sink_app.emit(&format!("serial:close:{id}"), ());
            }
            serial::SerialOut::AutoLogin(status) => {
                let _ = sink_app.emit(
                    &format!("serial:auto_login:{id}"),
                    serde_json::json!({ "status": status }),
                );
            }
        });
    let (id, handle) = match serial::open(session_id, &port, config, sink) {
        Ok(v) => v,
        Err(error) => {
            // 端口打不开时槽位已建好文件，立刻收尾，避免留下空 `.cast` 与悬挂句柄。
            log_slots.finish();
            return Err(error);
        }
    };
    reservation.activate_returned(
        &id,
        crate::commands::lifecycle::ReadySession::Serial(handle),
    )?;
    Ok(id)
}

/// Look up an open serial session's handle (cloned — `SerialHandle` is Arc-backed).
fn serial_handle(state: &State<'_, AppState>, session_id: &str) -> AppResult<serial::SerialHandle> {
    locked(&state.serial_sessions)?
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("serial_not_found", serde_json::json!({})))
}

#[tauri::command]
pub fn serial_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> AppResult<()> {
    serial_handle(&state, &session_id)?.write(&data)
}

/// Drive the DTR control line (`true` = asserted). Manual line control for
/// MCU reset / bootloader entry / modem signalling.
#[tauri::command]
pub fn serial_set_dtr(
    state: State<'_, AppState>,
    session_id: String,
    level: bool,
) -> AppResult<()> {
    serial_handle(&state, &session_id)?.set_dtr(level)
}

/// Drive the RTS control line (`true` = asserted).
#[tauri::command]
pub fn serial_set_rts(
    state: State<'_, AppState>,
    session_id: String,
    level: bool,
) -> AppResult<()> {
    serial_handle(&state, &session_id)?.set_rts(level)
}

/// Send a serial BREAK pulse (~250ms) — attention/interrupt signal for U-Boot,
/// kernel SysRq-over-serial, telco gear.
#[tauri::command]
pub fn serial_send_break(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    serial_handle(&state, &session_id)?.send_break()
}

// No serial_resize: a serial line has no rows/cols. The frontend's transport
// table maps serial's resize entry to null, so it simply never calls it.

#[tauri::command]
pub fn serial_close(
    window: tauri::Window,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    crate::commands::lifecycle::close_resource(
        &state,
        &session_id,
        SessionKind::Serial,
        &SessionOwner::Window(window.label().to_owned()),
    )
}

// ── Saved serial profiles (peer of profile/forward; SQLite-persisted CRUD) ──

#[tauri::command]
pub fn list_serial_profiles(state: State<'_, AppState>) -> AppResult<Vec<SerialProfile>> {
    crate::db::serial_profile::list(&state.db)
}

#[tauri::command]
pub fn get_serial_profile(state: State<'_, AppState>, id: String) -> AppResult<SerialProfile> {
    crate::db::serial_profile::get(&state.db, &id)
}

#[tauri::command]
pub fn create_serial_profile(state: State<'_, AppState>, profile: SerialProfile) -> AppResult<()> {
    crate::db::serial_profile::insert(&state.db, &profile)
}

#[tauri::command]
pub fn update_serial_profile(state: State<'_, AppState>, profile: SerialProfile) -> AppResult<()> {
    crate::db::serial_profile::update(&state.db, &profile)
}

#[tauri::command]
pub fn delete_serial_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::db::serial_profile::delete(&state.db, &id)
}
