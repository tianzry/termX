use tauri::State;

use crate::error::AppResult;
use crate::models::Note;
use crate::state::AppState;

// ── Notes（Vault 笔记 CRUD；SQLite 持久化，对齐 Netcatty VaultNote） ──

#[tauri::command]
pub fn list_notes(state: State<'_, AppState>) -> AppResult<Vec<Note>> {
    crate::db::notes::list(&state.db)
}

#[tauri::command]
pub fn get_note(state: State<'_, AppState>, id: String) -> AppResult<Note> {
    crate::db::notes::get(&state.db, &id)
}

#[tauri::command]
pub fn save_note(state: State<'_, AppState>, note: Note) -> AppResult<()> {
    crate::db::notes::save(&state.db, &note)
}

#[tauri::command]
pub fn delete_note(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::db::notes::delete(&state.db, &id)
}
