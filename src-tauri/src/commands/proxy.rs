//! 代理库命令层：元数据走 `db::proxy_profile`，密码走 SecretStore
//! （key `proxy_profile:<id>`），与主机级代理密码同一套生命周期约定。

use tauri::State;

use crate::db::proxy_profile as db;
use crate::error::AppError;
use crate::models::ProxyProfile;
use crate::state::AppState;

pub fn list_impl(state: &AppState) -> Result<Vec<ProxyProfile>, AppError> {
    db::list(&state.db)
}

pub fn save_impl(
    state: &AppState,
    profile: &ProxyProfile,
    password: Option<&str>,
) -> Result<(), AppError> {
    db::save(&state.db, profile)?;
    // None = 未提供密码（编辑时前端可能只想改标签）；空串 = 显式清除。
    if let Some(secret) = password {
        let key = crate::secret::proxy_profile_secret_key(&profile.id);
        if secret.trim().is_empty() {
            state.secret_store.delete(&key)?;
        } else {
            state.secret_store.set(&key, secret)?;
        }
    }
    Ok(())
}

pub fn password_get_impl(state: &AppState, id: &str) -> Result<Option<String>, AppError> {
    state
        .secret_store
        .get(&crate::secret::proxy_profile_secret_key(id))
}

pub fn delete_impl(state: &AppState, id: &str) -> Result<(), AppError> {
    db::delete(&state.db, id)?;
    state
        .secret_store
        .delete(&crate::secret::proxy_profile_secret_key(id))?;
    Ok(())
}

#[tauri::command]
pub fn list_proxy_profiles(state: State<AppState>) -> Result<Vec<ProxyProfile>, AppError> {
    list_impl(&state)
}

#[tauri::command]
pub fn save_proxy_profile(
    state: State<AppState>,
    profile: ProxyProfile,
    password: Option<String>,
) -> Result<(), AppError> {
    save_impl(&state, &profile, password.as_deref())
}

#[tauri::command]
pub fn proxy_profile_password_get(
    state: State<AppState>,
    id: String,
) -> Result<Option<String>, AppError> {
    password_get_impl(&state, &id)
}

#[tauri::command]
pub fn delete_proxy_profile(state: State<AppState>, id: String) -> Result<(), AppError> {
    delete_impl(&state, &id)
}
