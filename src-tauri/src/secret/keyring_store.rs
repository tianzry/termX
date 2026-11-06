//! 系统 keychain 后端。仅在 macOS / iOS / Windows / Linux（Secret Service 可达时）可用。
//!
//! service 名已从 `rssh` 改为 `termx`。读取时先查新 service，未命中再查旧
//! service 并回写新 service（懒迁移）；旧条目**不删**，保留一个发布周期，
//! 避免迁移失败/回滚时丢密钥。显式 delete 时两个 service 都清。

use super::SecretStore;
use crate::error::{AppError, AppResult};

pub struct KeyringStore;

const PROBE_KEY: &str = "__termx_probe__";
const PROBE_VALUE: &str = "ok";

/// 实测 keychain 可用性：写 → 读回 → 删。任何一步失败就拒绝。
pub fn try_open() -> Option<KeyringStore> {
    let entry = entry(PROBE_KEY).ok()?;
    if entry.set_password(PROBE_VALUE).is_err() {
        return None;
    }
    let read_ok = entry
        .get_password()
        .ok()
        .as_deref()
        .map(|s| s == PROBE_VALUE)
        .unwrap_or(false);
    let _ = entry.delete_credential();
    if !read_ok {
        return None;
    }
    Some(KeyringStore)
}

fn entry_for(service: &str, key: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(service, key).map_err(|e| {
        AppError::other(
            "keyring_failed",
            serde_json::json!({ "op": "entry", "service": service, "err": e.to_string() }),
        )
    })
}

fn entry(key: &str) -> AppResult<keyring::Entry> {
    entry_for(super::SERVICE, key)
}

fn legacy_entry(key: &str) -> AppResult<keyring::Entry> {
    entry_for(super::LEGACY_SERVICE, key)
}

impl KeyringStore {
    /// 读旧 service 的同名条目（不写新 service）。给 master key 的旧 key 名迁移用。
    pub fn get_legacy(&self, key: &str) -> AppResult<Option<String>> {
        read_entry(legacy_entry(key)?, "get-legacy")
    }
}

fn read_entry(entry: keyring::Entry, op: &str) -> AppResult<Option<String>> {
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::other(
            "keyring_failed",
            serde_json::json!({ "op": op, "err": e.to_string() }),
        )),
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, key: &str) -> AppResult<Option<String>> {
        match read_entry(entry(key)?, "get") {
            Ok(Some(value)) => Ok(Some(value)),
            Ok(None) => {
                // 旧 service 回退：读到后回写新 service；旧条目保留。
                let Some(value) = read_entry(legacy_entry(key)?, "get-legacy")? else {
                    return Ok(None);
                };
                if let Err(e) = entry(key)?.set_password(&value) {
                    log::warn!("keychain lazy migration write failed for {key}: {e}");
                } else {
                    log::info!("keychain entry lazily migrated from rssh to termx service: {key}");
                }
                Ok(Some(value))
            }
            Err(e) => Err(e),
        }
    }

    fn set(&self, key: &str, value: &str) -> AppResult<()> {
        entry(key)?.set_password(value).map_err(|e| {
            AppError::other(
                "keyring_failed",
                serde_json::json!({ "op": "set", "err": e.to_string() }),
            )
        })
    }

    fn delete(&self, key: &str) -> AppResult<()> {
        delete_entry(entry(key)?, "delete")?;
        // 显式删除必须同时清旧 service，否则下次 get 会把已删条目"复活"。
        if let Err(e) = delete_entry(legacy_entry(key)?, "delete-legacy") {
            log::warn!("keychain legacy delete failed for {key}: {e}");
        }
        Ok(())
    }

    fn backend_name(&self) -> &'static str {
        if cfg!(target_os = "macos") {
            "macos-keychain"
        } else if cfg!(target_os = "ios") {
            "ios-keychain"
        } else if cfg!(target_os = "windows") {
            "windows-credential-manager"
        } else {
            "linux-secret-service"
        }
    }
}

fn delete_entry(entry: keyring::Entry, op: &str) -> AppResult<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::other(
            "keyring_failed",
            serde_json::json!({ "op": op, "err": e.to_string() }),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_name_matches_the_native_store() {
        let expected = if cfg!(target_os = "macos") {
            "macos-keychain"
        } else if cfg!(target_os = "ios") {
            "ios-keychain"
        } else if cfg!(target_os = "windows") {
            "windows-credential-manager"
        } else {
            "linux-secret-service"
        };
        assert_eq!(KeyringStore.backend_name(), expected);
    }

    #[test]
    fn probe_key_uses_new_service_name() {
        assert_eq!(PROBE_KEY, "__termx_probe__");
    }
}
