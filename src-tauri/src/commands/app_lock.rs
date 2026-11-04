//! 应用锁 Tauri 命令（桌面 UI 门；headless server 无「锁定」语义，不转发）。

use tauri::State;

use crate::app_lock;
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn app_lock_state(state: State<AppState>) -> AppResult<app_lock::AppLockState> {
    app_lock::state(&state.db)
}

#[tauri::command]
pub fn app_lock_set_password(
    state: State<AppState>,
    current_password: Option<String>,
    next_password: String,
) -> AppResult<app_lock::AppLockState> {
    app_lock::set_password(&state.db, current_password.as_deref(), &next_password)
}

#[tauri::command]
pub fn app_lock_disable(
    state: State<AppState>,
    current_password: String,
) -> AppResult<app_lock::AppLockState> {
    app_lock::disable(&state.db, &current_password)
}

#[tauri::command]
pub fn app_lock_unlock(state: State<AppState>, password: String) -> AppResult<bool> {
    app_lock::unlock(&state.db, &password)
}

#[tauri::command]
pub fn app_lock_set_enabled(
    state: State<AppState>,
    enabled: bool,
) -> AppResult<app_lock::AppLockState> {
    app_lock::set_enabled(&state.db, enabled)
}

#[tauri::command]
pub fn app_lock_set_timeout(
    state: State<AppState>,
    minutes: u64,
) -> AppResult<app_lock::AppLockState> {
    app_lock::set_timeout_minutes(&state.db, minutes)
}
