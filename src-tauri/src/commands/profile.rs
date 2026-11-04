use serde_json::json;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::db::profile_env::EnvVar;
use crate::models::{Credential, Profile, SshAlgorithmCatalog};
use crate::secret::cred_secret_key;
use crate::state::AppState;

#[tauri::command]
pub fn list_profiles(state: State<AppState>) -> Result<Vec<Profile>, AppError> {
    crate::db::profile::list(&state.db)
}

#[tauri::command]
pub fn get_profile(state: State<AppState>, id: String) -> Result<Profile, AppError> {
    crate::db::profile::get(&state.db, &id)
}

#[tauri::command]
pub fn create_profile(state: State<AppState>, profile: Profile) -> Result<(), AppError> {
    crate::db::profile::insert(&state.db, &profile)
}

#[tauri::command]
pub fn update_profile(state: State<AppState>, profile: Profile) -> Result<(), AppError> {
    crate::db::profile::update(&state.db, &profile)
}

#[tauri::command]
pub fn profile_env_list(
    state: State<AppState>,
    profile_id: String,
) -> AppResult<Vec<EnvVar>> {
    crate::db::profile_env::list(&state.db, &profile_id)
}

#[tauri::command]
pub fn profile_env_save(
    state: State<AppState>,
    profile_id: String,
    vars: Vec<EnvVar>,
) -> AppResult<()> {
    crate::db::profile_env::replace(&state.db, &profile_id, &vars)
}

#[tauri::command]
pub fn delete_profile(state: State<AppState>, id: String) -> Result<(), AppError> {
    crate::db::profile::delete(&state.db, &id)?;
    crate::db::profile_env::delete_for_profile(&state.db, &id)?;
    // 档案级 secret 与 metadata 同生命周期：档案没了就清掉，避免孤儿密文。
    state.secret_store.delete(&crate::secret::totp_secret_key(&id))?;
    state.secret_store.delete(&crate::secret::proxy_secret_key(&id))?;
    Ok(())
}

#[tauri::command]
pub fn ssh_algorithm_catalog() -> SshAlgorithmCatalog {
    crate::ssh::algorithms::catalog()
}

// ---------------------------------------------------------------------------
// Credentials — secret 走 SecretStore，metadata 走 DB
// 私钥 passphrase 不再持久化：连接时终端内交互输入，仅进程内缓存。
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_credentials(state: State<AppState>) -> Result<Vec<Credential>, AppError> {
    // 列表场景不返回 secret，避免无谓 keychain 查询
    crate::db::credential::list(&state.db)
}

#[tauri::command]
pub fn get_credential(state: State<AppState>, id: String) -> Result<Credential, AppError> {
    let mut cred = crate::db::credential::get(&state.db, &id)?;
    cred.secret = state.secret_store.get(&cred_secret_key(&id))?;
    Ok(cred)
}

#[tauri::command]
pub fn create_credential(state: State<AppState>, credential: Credential) -> Result<(), AppError> {
    crate::db::credential::insert(&state.db, &credential)?;
    save_credential_secrets(&state, &credential)
}

#[tauri::command]
pub fn update_credential(state: State<AppState>, credential: Credential) -> Result<(), AppError> {
    crate::db::credential::update(&state.db, &credential)?;
    save_credential_secrets(&state, &credential)
}

#[tauri::command]
pub fn delete_credential(state: State<AppState>, id: String) -> Result<(), AppError> {
    crate::db::credential::delete(&state.db, &id)?;
    state.secret_store.delete(&cred_secret_key(&id))?;
    Ok(())
}

fn save_credential_secrets(state: &State<AppState>, c: &Credential) -> Result<(), AppError> {
    let secret_key = cred_secret_key(&c.id);
    match c.secret.as_deref() {
        Some(s) if !s.is_empty() => state.secret_store.set(&secret_key, s)?,
        _ => state.secret_store.delete(&secret_key)?,
    }
    Ok(())
}

/// A real private key is a few KB; anything past 1 MiB is not a key. Matches the
/// webview pick-file path's cap so both key-import routes reject oversized files
/// identically (see `pickTextFile({ maxBytes })` in the frontend).
pub(crate) const MAX_KEY_FILE_BYTES: u64 = 1024 * 1024;

/// webview 是不可信边界：name 只允许 `~/.ssh` 下的单层普通文件名，
/// 任何路径分隔符 / `..` / 空名一律拒绝（join 后不可能逃逸出 `~/.ssh`）。
pub(crate) fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.chars().any(|c| (c as u32) < 0x20)
}

/// 私钥内容嗅探：PEM（`-----BEGIN … PRIVATE KEY-----`）或 OpenSSH v1 格式。
/// 用它把 config / known_hosts 之类的非私钥文件挡在读取接口之外。
pub(crate) fn looks_like_private_key(content: &str) -> bool {
    content.starts_with("openssh-key-v1") || content.contains("PRIVATE KEY-----")
}

/// 读 `~/.ssh/<name>` 私钥文件原文，供凭据面板的「本地密钥」选择器用。
/// name 必须是单层文件名且内容嗅探为私钥，否则拒绝；
/// 文件不存在 → not_found，让前端给友好提示而不是 IO 噪声。
#[tauri::command]
pub fn read_default_key_file(name: String) -> AppResult<String> {
    if !is_plain_file_name(&name) {
        return Err(AppError::other("invalid_key_name", json!({ "name": name })));
    }
    let home =
        dirs::home_dir().ok_or_else(|| AppError::other("home_dir_unavailable", json!({})))?;
    let text = read_key_file_capped(&home.join(".ssh").join(&name), &format!("~/.ssh/{name}"))?;
    if !looks_like_private_key(&text) {
        // 不返回内容、不写日志——只报一个稳定的错误码。
        return Err(AppError::other("not_a_private_key", json!({ "name": name })));
    }
    Ok(text)
}

/// 列出 `~/.ssh` 下的私钥文件名（只给文件名，不给内容）。
/// 用内容嗅探过滤：`.pub` / config / known_hosts / authorized_keys 一概不出现。
/// 目录不存在 → 空列表（首次使用属正常状态，不是错误）。
#[tauri::command]
pub fn list_ssh_key_files() -> AppResult<Vec<String>> {
    let home =
        dirs::home_dir().ok_or_else(|| AppError::other("home_dir_unavailable", json!({})))?;
    let dir = home.join(".ssh");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_file() || name.ends_with(".pub") || !is_plain_file_name(&name) {
            continue;
        }
        // 只嗅探小文件：真私钥都是几 KB；超大（或非 UTF-8）文件直接跳过。
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size == 0 || size > MAX_KEY_FILE_BYTES {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if looks_like_private_key(&content) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/// 解析 `~/.ssh/known_hosts` 为结构化条目列表（含 SHA256 指纹），坏行跳过。
/// impl 与 command 拆开：headless dispatcher 与 GUI 共用同一引擎（AGENTS.md R4/INV-4）。
pub fn known_hosts_list_impl(
    state: &AppState,
) -> Result<Vec<crate::ssh::known_hosts::KnownHostEntry>, AppError> {
    let path = crate::ssh::known_hosts::path_for(&state.data_dir);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    Ok(crate::ssh::known_hosts::parse_known_hosts(&content))
}

#[tauri::command]
pub fn known_hosts_list(state: State<AppState>) -> Result<Vec<crate::ssh::known_hosts::KnownHostEntry>, AppError> {
    known_hosts_list_impl(&state)
}

/// 删除 `host:port` 的全部 known_hosts 条目，返回删除条数（同样拆 impl）。
pub fn known_hosts_remove_impl(state: &AppState, host: &str, port: u16) -> Result<usize, AppError> {
    let path = crate::ssh::known_hosts::path_for(&state.data_dir);
    Ok(crate::ssh::known_hosts::remove_host(host, port, &path)?)
}

#[tauri::command]
pub fn known_hosts_remove(
    state: State<AppState>,
    host: String,
    port: u16,
) -> Result<usize, AppError> {
    known_hosts_remove_impl(&state, &host, port)
}

/// 「扫描系统」：重读 `~/.ssh/known_hosts`。termX 的已知主机列表本身就是
/// 系统文件（连接时 TOFU 写入也落在这里），所以扫描 = 重新读取并返回条数。
/// `None` = 文件不存在；`Some(n)` = 解析出 n 条。
pub fn known_hosts_scan_system_impl(state: &AppState) -> Result<Option<usize>, AppError> {
    let path = crate::ssh::known_hosts::path_for(&state.data_dir);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    Ok(Some(crate::ssh::known_hosts::parse_known_hosts(&content).len()))
}

#[tauri::command]
pub fn known_hosts_scan_system(state: State<AppState>) -> Result<Option<usize>, AppError> {
    known_hosts_scan_system_impl(&state)
}

/// 「导入文件」：把外部 known_hosts 文件去重合并进 `~/.ssh/known_hosts`，
/// 返回新增条数（0 = 没有新主机）。
pub fn known_hosts_import_file_impl(state: &AppState, path: &str) -> Result<usize, AppError> {
    let target = crate::ssh::known_hosts::path_for(&state.data_dir);
    let content = std::fs::read_to_string(path)?;
    Ok(crate::ssh::known_hosts::merge_entries(&content, &target)?)
}

#[tauri::command]
pub fn known_hosts_import_file(
    state: State<AppState>,
    path: String,
) -> Result<usize, AppError> {
    known_hosts_import_file_impl(&state, &path)
}

// ---------------------------------------------------------------------------
// TOTP（验证器）— secret 走 SecretStore（key `totp:<profile_id>`），不入表。
// auto_submit / regex 等非密字段在 profiles 表（totp_auto_submit / totp_regex）。
// ---------------------------------------------------------------------------

pub fn profile_totp_get_impl(state: &AppState, profile_id: &str) -> Result<Option<String>, AppError> {
    state
        .secret_store
        .get(&crate::secret::totp_secret_key(profile_id))
}

#[tauri::command]
pub fn profile_totp_get(
    state: State<AppState>,
    profile_id: String,
) -> Result<Option<String>, AppError> {
    profile_totp_get_impl(&state, &profile_id)
}

/// secret 为 None / 空白 = 移除验证器。
pub fn profile_totp_set_impl(
    state: &AppState,
    profile_id: &str,
    secret: Option<&str>,
) -> Result<(), AppError> {
    let key = crate::secret::totp_secret_key(profile_id);
    match secret.map(str::trim) {
        Some(s) if !s.is_empty() => state.secret_store.set(&key, s),
        _ => state.secret_store.delete(&key),
    }
}

#[tauri::command]
pub fn profile_totp_set(
    state: State<AppState>,
    profile_id: String,
    secret: Option<String>,
) -> Result<(), AppError> {
    profile_totp_set_impl(&state, &profile_id, secret.as_deref())
}

// ---------------------------------------------------------------------------
// 主机连接代理密码 — 同样走 SecretStore（key `proxy:<profile_id>`），
// profiles 表只存 type/host/port/username/no_proxy（schema v39）。
// ---------------------------------------------------------------------------

pub fn profile_proxy_password_get_impl(
    state: &AppState,
    profile_id: &str,
) -> Result<Option<String>, AppError> {
    state
        .secret_store
        .get(&crate::secret::proxy_secret_key(profile_id))
}

#[tauri::command]
pub fn profile_proxy_password_get(
    state: State<AppState>,
    profile_id: String,
) -> Result<Option<String>, AppError> {
    profile_proxy_password_get_impl(&state, &profile_id)
}

/// secret 为 None / 空白 = 清除代理密码。
pub fn profile_proxy_password_set_impl(
    state: &AppState,
    profile_id: &str,
    secret: Option<&str>,
) -> Result<(), AppError> {
    let key = crate::secret::proxy_secret_key(profile_id);
    match secret.filter(|s| !s.is_empty()) {
        Some(s) => state.secret_store.set(&key, s),
        None => state.secret_store.delete(&key),
    }
}

#[tauri::command]
pub fn profile_proxy_password_set(
    state: State<AppState>,
    profile_id: String,
    secret: Option<String>,
) -> Result<(), AppError> {
    profile_proxy_password_set_impl(&state, &profile_id, secret.as_deref())
}

/// Read a key file's text. Split out from the command so the cap / not-found
/// logic is unit-testable without a real `~/.ssh`. `display` is the user-facing
/// path shown on not_found (`~/.ssh/id_rsa`), kept separate from the real fs
/// path so the error message stays the friendly relative form.
fn read_key_file_capped(path: &std::path::Path, display: &str) -> AppResult<String> {
    // Cap before slurping into memory. metadata() follows symlinks, matching
    // read_to_string; a stat failure (missing / permission) yields 0 here and
    // falls through to the read below, which maps NotFound → key_file_not_found
    // and other IO → io_error, so the not-found path keeps its friendly message.
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_KEY_FILE_BYTES {
        return Err(AppError::other(
            "key_file_too_large",
            json!({ "size": size }),
        ));
    }
    match std::fs::read_to_string(path) {
        Ok(c) => Ok(c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(AppError::not_found(
            "key_file_not_found",
            json!({ "path": display }),
        )),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    //! Key-file reads for the default-key quick fill: capped at 1 MiB,
    //! NotFound maps to the friendly key_file_not_found code.
    use super::*;

    #[test]
    fn read_key_file_capped_reads_a_normal_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_rsa");
        std::fs::write(&path, "PEM-CONTENT").unwrap();
        assert_eq!(
            read_key_file_capped(&path, "~/.ssh/id_rsa").unwrap(),
            "PEM-CONTENT"
        );
    }

    #[test]
    fn read_key_file_capped_rejects_oversized_file() {
        // One byte past the 1 MiB cap — too big to be a private key, so it must
        // be rejected before it is slurped into memory. Mirrors the webview
        // pick-file path's guard so both key-import routes behave identically.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_rsa");
        std::fs::write(&path, vec![b'x'; 1024 * 1024 + 1]).unwrap();
        let err = read_key_file_capped(&path, "~/.ssh/id_rsa").unwrap_err();
        assert_eq!(err.code(), "key_file_too_large");
    }

    #[test]
    fn read_key_file_capped_reports_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_rsa");
        let err = read_key_file_capped(&path, "~/.ssh/id_rsa").unwrap_err();
        assert_eq!(err.code(), "key_file_not_found");
    }

    #[test]
    fn is_plain_file_name_rejects_traversal_and_separators() {
        assert!(is_plain_file_name("id_rsa"));
        assert!(is_plain_file_name("my-key"));
        assert!(!is_plain_file_name(""));
        assert!(!is_plain_file_name("."));
        assert!(!is_plain_file_name(".."));
        assert!(!is_plain_file_name("../id_rsa"));
        assert!(!is_plain_file_name("sub/dir/key"));
        assert!(!is_plain_file_name("sub\\dir\\key"));
        assert!(!is_plain_file_name("a\nb"));
    }

    #[test]
    fn looks_like_private_key_detects_both_formats() {
        assert!(looks_like_private_key("-----BEGIN OPENSSH PRIVATE KEY-----\n..."));
        assert!(looks_like_private_key("-----BEGIN RSA PRIVATE KEY-----\n..."));
        assert!(looks_like_private_key("openssh-key-v1\0\0\0..."));
        assert!(!looks_like_private_key("Host example.com\n  IdentityFile ~/.ssh/id_rsa"));
        assert!(!looks_like_private_key("example.com ssh-ed25519 AAAA..."));
    }
}
