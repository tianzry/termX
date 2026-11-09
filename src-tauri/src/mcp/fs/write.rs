//! `fs_write`：新建或整体覆盖小文本文件（走 SFTP，零 shell）。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{handle, path as jail};

/// `fs_write` 只用于小文本；大文件走 `sftp_put`。
pub const MAX_WRITE_BYTES: usize = 512 * 1024;

pub struct WriteOutcome {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub created: bool,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub async fn fs_write(
    state: &AppState,
    session_id: &str,
    args: &Value,
    jail_root: &str,
) -> AppResult<WriteOutcome> {
    let input = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "path" })))?;
    super::shell::validate_remote_path(input)?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "content" })))?;
    if content.len() > MAX_WRITE_BYTES {
        return Err(AppError::config(
            "mcp_content_too_large",
            json!({ "size": content.len(), "limit": MAX_WRITE_BYTES }),
        ));
    }
    let overwrite = args
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let root = jail::normalize(jail_root, &home, &home)?;
    let target = jail::normalize(input, &home, &root)?;
    jail::check(&root, &target)?;
    if let Ok(real) = sftp.realpath(&target).await {
        jail::check(&root, &real)?;
    }

    let created = sftp.stat(&target).await.is_err();
    if !created && !overwrite {
        return Err(AppError::config(
            "mcp_file_exists",
            json!({ "path": target }),
        ));
    }

    sftp.upload(&target, content.as_bytes()).await?;

    Ok(WriteOutcome {
        path: target,
        size: content.len() as u64,
        sha256: sha256_hex(content.as_bytes()),
        created,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_is_stable() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
