//! 系统 keychain 后端。仅在 macOS / iOS / Windows / Linux（Secret Service 可达时）可用。
//!
//! service 名固定 `termx`；不保留旧 service 回退（未发布，无需兼容）。

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
        read_entry(entry(key)?, "get")
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
        delete_entry(entry(key)?, "delete")
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
