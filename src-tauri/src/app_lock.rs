//! 应用锁 —— 锁定口令校验与锁定状态持久化。
//!
//! 对照 Netcatty `domain/appLock.ts`：应用锁是**用户自设的锁定口令**
//! （PBKDF2-SHA256 校验器，明文口令不落盘），不是系统凭据。系统级
//! Touch ID / Windows Hello 解锁在 Netcatty 里由原生 helper 实现，
//! termX 无对应基础设施，置灰（见设置中心文案）。
//!
//! 存储：`db.settings` 明文键——
//! - `app_lock_verifier`：`{"version":1,"algorithm":"PBKDF2-SHA256",
//!    "iterations":120000,"salt":"<b64>","hash":"<b64>"}`
//! - `app_lock_enabled`：`"true"` / `"false"`
//! - `app_lock_timeout_minutes`：`"0" / "1" / "5" / "15" / "30" / "60"`
//!
//! 校验器是单向哈希（16B salt + 32B hash），落 DB 不泄露口令；与凭据
//! 密文走 SecretStore 的路径相互独立。锁定是前端 UI 门（启动 / 失焦超时
//! 后遮罩），不是文件系统加密。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::db::{self, Db};
use crate::error::{AppError, AppResult};

const VERIFIER_KEY: &str = "app_lock_verifier";
const ENABLED_KEY: &str = "app_lock_enabled";
const TIMEOUT_KEY: &str = "app_lock_timeout_minutes";

const ALGORITHM: &str = "PBKDF2-SHA256";
const VERSION: u32 = 1;
/// 与 Netcatty 一致的下限（其 normalize 拒绝 < 100000 的校验器）。
const ITERATIONS: u32 = 120_000;
const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;
const DEFAULT_TIMEOUT_MINUTES: u64 = 15;
const TIMEOUT_OPTIONS: &[u64] = &[0, 1, 5, 15, 30, 60];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppLockVerifier {
    pub version: u32,
    pub algorithm: String,
    pub iterations: u32,
    pub salt: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppLockState {
    pub enabled: bool,
    pub has_password: bool,
    pub timeout_minutes: u64,
}

/// PBKDF2-HMAC-SHA256 派生 32B 哈希。
fn derive(password: &str, salt: &[u8], iterations: u32) -> [u8; HASH_LEN] {
    let mut out = [0u8; HASH_LEN];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut out);
    out
}

/// 定长恒时比较，避免按字节短路泄露前缀信息。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

fn read_verifier(db: &Db) -> AppResult<Option<AppLockVerifier>> {
    let Some(raw) = db::settings::get(db, VERIFIER_KEY)? else {
        return Ok(None);
    };
    let parsed: AppLockVerifier = serde_json::from_str(&raw).map_err(|e| {
        AppError::other(
            "app_lock_verifier_corrupt",
            serde_json::json!({ "err": e.to_string() }),
        )
    })?;
    if parsed.version != VERSION
        || parsed.algorithm != ALGORITHM
        || parsed.iterations < 100_000
        || B64.decode(&parsed.salt).map(|b| b.len()) != Ok(SALT_LEN)
        || B64.decode(&parsed.hash).map(|b| b.len()) != Ok(HASH_LEN)
    {
        return Err(AppError::other("app_lock_verifier_corrupt", serde_json::json!({})));
    }
    Ok(Some(parsed))
}

fn is_enabled(db: &Db) -> AppResult<bool> {
    Ok(db::settings::get(db, ENABLED_KEY)?.as_deref() == Some("true"))
}

fn timeout_minutes(db: &Db) -> AppResult<u64> {
    let raw = db::settings::get(db, TIMEOUT_KEY)?;
    let parsed = raw.and_then(|v| v.parse::<u64>().ok()).unwrap_or(DEFAULT_TIMEOUT_MINUTES);
    Ok(if TIMEOUT_OPTIONS.contains(&parsed) {
        parsed
    } else {
        DEFAULT_TIMEOUT_MINUTES
    })
}

fn build_state(db: &Db) -> AppResult<AppLockState> {
    // enabled 只在有校验器时才能为 true：校验器被删（或损坏修复）时
    // 不能让 UI 进入"锁定但无法解锁"的死锁。
    let verifier_present = read_verifier(db)?.is_some();
    Ok(AppLockState {
        enabled: is_enabled(db)? && verifier_present,
        has_password: verifier_present,
        timeout_minutes: timeout_minutes(db)?,
    })
}

fn verify_verifier(verifier: &AppLockVerifier, password: &str) -> bool {
    let Ok(salt) = B64.decode(&verifier.salt) else {
        return false;
    };
    let Ok(expected) = B64.decode(&verifier.hash) else {
        return false;
    };
    let actual = derive(password, &salt, verifier.iterations);
    constant_time_eq(&actual, &expected)
}

fn incorrect_password() -> AppError {
    AppError::other("app_lock_incorrect_password", serde_json::json!({}))
}

pub fn state(db: &Db) -> AppResult<AppLockState> {
    build_state(db)
}

/// 设置/更换锁定口令。已有口令时必须提供正确的 `current`；
/// 成功后同时把锁定开关打开（对标 Netcatty「设置并启用」）。
pub fn set_password(db: &Db, current: Option<&str>, next: &str) -> AppResult<AppLockState> {
    if next.trim().is_empty() {
        return Err(AppError::other("app_lock_empty_password", serde_json::json!({})));
    }
    if let Some(existing) = read_verifier(db)? {
        let current = current.unwrap_or("");
        if current.is_empty() {
            return Err(AppError::other(
                "app_lock_current_required",
                serde_json::json!({}),
            ));
        }
        if !verify_verifier(&existing, current) {
            return Err(incorrect_password());
        }
    }

    let mut salt = [0u8; SALT_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| {
        AppError::other(
            "app_lock_salt_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })?;
    let hash = derive(next, &salt, ITERATIONS);
    let verifier = AppLockVerifier {
        version: VERSION,
        algorithm: ALGORITHM.to_string(),
        iterations: ITERATIONS,
        salt: B64.encode(salt),
        hash: B64.encode(hash),
    };
    db::settings::set(db, VERIFIER_KEY, &serde_json::to_string(&verifier).map_err(|e| {
        AppError::other(
            "app_lock_verifier_serialize_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })?)?;
    db::settings::set(db, ENABLED_KEY, "true")?;
    build_state(db)
}

/// 关闭应用锁：必须用当前口令确认，随后删除校验器（下次启用需重新设口令）。
pub fn disable(db: &Db, current: &str) -> AppResult<AppLockState> {
    let Some(existing) = read_verifier(db)? else {
        db::settings::set(db, ENABLED_KEY, "false")?;
        return build_state(db);
    };
    if current.is_empty() {
        return Err(AppError::other(
            "app_lock_current_required",
            serde_json::json!({}),
        ));
    }
    if !verify_verifier(&existing, current) {
        return Err(incorrect_password());
    }
    db::settings::delete(db, VERIFIER_KEY)?;
    db::settings::set(db, ENABLED_KEY, "false")?;
    build_state(db)
}

/// 校验解锁口令。没有口令时视为未锁定（返回 true），避免 UI 死锁。
pub fn unlock(db: &Db, password: &str) -> AppResult<bool> {
    let Some(existing) = read_verifier(db)? else {
        return Ok(true);
    };
    if password.is_empty() {
        return Ok(false);
    }
    Ok(verify_verifier(&existing, password))
}

/// 开关应用锁；开启前必须已有口令。
pub fn set_enabled(db: &Db, enabled: bool) -> AppResult<AppLockState> {
    if enabled && read_verifier(db)?.is_none() {
        return Err(AppError::other(
            "app_lock_password_required",
            serde_json::json!({}),
        ));
    }
    db::settings::set(db, ENABLED_KEY, if enabled { "true" } else { "false" })?;
    build_state(db)
}

/// 失焦超时（分钟）；0 表示切回立即要求验证。
pub fn set_timeout_minutes(db: &Db, minutes: u64) -> AppResult<AppLockState> {
    if !TIMEOUT_OPTIONS.contains(&minutes) {
        return Err(AppError::other(
            "app_lock_timeout_invalid",
            serde_json::json!({ "value": minutes }),
        ));
    }
    db::settings::set(db, TIMEOUT_KEY, &minutes.to_string())?;
    build_state(db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_db() -> Arc<Db> {
        Arc::new(Db::open_in_memory().unwrap())
    }

    #[test]
    fn set_password_then_unlock_with_correct_and_wrong_password() {
        let db = test_db();
        let s = set_password(&db, None, "s3cret-lock").unwrap();
        assert!(s.enabled);
        assert!(s.has_password);
        assert_eq!(unlock(&db, "s3cret-lock").unwrap(), true);
        assert_eq!(unlock(&db, "wrong").unwrap(), false);
    }

    #[test]
    fn verifier_stored_as_hash_not_plaintext() {
        let db = test_db();
        set_password(&db, None, "s3cret-lock").unwrap();
        let raw = db::settings::get(&db, VERIFIER_KEY).unwrap().unwrap();
        assert!(!raw.contains("s3cret-lock"));
        let v: AppLockVerifier = serde_json::from_str(&raw).unwrap();
        assert_eq!(v.algorithm, ALGORITHM);
        assert!(v.iterations >= 100_000);
        assert_eq!(B64.decode(&v.salt).unwrap().len(), SALT_LEN);
        assert_eq!(B64.decode(&v.hash).unwrap().len(), HASH_LEN);
    }

    #[test]
    fn change_password_requires_current() {
        let db = test_db();
        set_password(&db, None, "old-pass").unwrap();
        assert!(set_password(&db, None, "new-pass").is_err());
        assert!(set_password(&db, Some("wrong"), "new-pass").is_err());
        set_password(&db, Some("old-pass"), "new-pass").unwrap();
        assert!(unlock(&db, "old-pass").unwrap() == false);
        assert!(unlock(&db, "new-pass").unwrap());
    }

    #[test]
    fn empty_password_rejected() {
        let db = test_db();
        assert!(set_password(&db, None, "   ").is_err());
        assert_eq!(build_state(&db).unwrap().enabled, false);
    }

    #[test]
    fn disable_requires_correct_password_and_clears_verifier() {
        let db = test_db();
        set_password(&db, None, "lock-pass").unwrap();
        assert!(disable(&db, "wrong").is_err());
        let s = disable(&db, "lock-pass").unwrap();
        assert_eq!(s.enabled, false);
        assert_eq!(s.has_password, false);
        assert_eq!(unlock(&db, "lock-pass").unwrap(), true);
    }

    #[test]
    fn enable_requires_password_and_timeout_validated() {
        let db = test_db();
        assert!(set_enabled(&db, true).is_err());
        assert!(set_timeout_minutes(&db, 7).is_err());
        let s = set_timeout_minutes(&db, 0).unwrap();
        assert_eq!(s.timeout_minutes, 0);
        set_password(&db, None, "p").unwrap();
        assert!(set_enabled(&db, false).unwrap().enabled == false);
        assert!(set_enabled(&db, true).unwrap().enabled);
    }

    #[test]
    fn enabled_flag_ignored_when_verifier_missing() {
        let db = test_db();
        db::settings::set(&db, ENABLED_KEY, "true").unwrap();
        let s = build_state(&db).unwrap();
        assert_eq!(s.enabled, false);
    }
}
