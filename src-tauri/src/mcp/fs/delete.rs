//! `fs_delete`：先 dry-run 列出将删对象并发 `confirmToken`，确认后才真正删除。
//!
//! 删除是唯一即使在 auto 档位也要二次确认的操作（见 `mcp/permissions.rs`），
//! 因此 token 绑定「会话 + 规范化路径集合 + 递归开关」，5 分钟过期、取用即失效。

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{handle, path as pathutil, shell};

pub const MAX_DELETE_PATHS: usize = 200;

pub struct DeleteEntry {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

impl DeleteEntry {
    pub fn to_json(&self) -> Value {
        json!({ "path": self.path, "size": self.size, "isDir": self.is_dir })
    }
}

pub struct DeleteOutcome {
    /// `true` 表示只做了计划，未删任何东西。
    pub dry_run: bool,
    pub entries: Vec<DeleteEntry>,
    pub confirm_token: Option<String>,
}

fn parse_paths(args: &Value) -> AppResult<Vec<String>> {
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "paths" })))?;
    if paths.len() > MAX_DELETE_PATHS {
        return Err(AppError::config(
            "mcp_too_many_paths",
            json!({ "count": paths.len(), "limit": MAX_DELETE_PATHS }),
        ));
    }
    let mut parsed = Vec::with_capacity(paths.len());
    for value in paths {
        let path = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "paths[]" })))?;
        shell::validate_remote_path(path)?;
        parsed.push(path.to_string());
    }
    Ok(parsed)
}

pub async fn fs_delete(
    state: &AppState,
    session_id: &str,
    args: &Value,
) -> AppResult<DeleteOutcome> {
    let inputs = parse_paths(args)?;
    let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let dry_run = args.get("dryRun").and_then(Value::as_bool).unwrap_or(true);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;

    let mut entries = Vec::with_capacity(inputs.len());
    for input in &inputs {
        let target = pathutil::normalize(input, &home, &home)?;
        sftp.realpath(&target)
            .await
            .map_err(|_| AppError::not_found("mcp_delete_not_found", json!({ "path": target })))?;
        let stat = sftp.stat(&target).await?;
        if stat.is_dir && !recursive {
            return Err(AppError::config(
                "mcp_delete_is_dir",
                json!({ "path": target, "hint": "目录请置 recursive=true" }),
            ));
        }
        entries.push(DeleteEntry {
            path: target,
            size: stat.size,
            is_dir: stat.is_dir,
        });
    }

    if dry_run {
        let token = format!("dt_{}", uuid::Uuid::new_v4().simple());
        let paths: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
        crate::mcp::runtime_state::store_delete_token(
            token.clone(),
            crate::mcp::runtime_state::DeleteToken {
                session_id: session_id.to_string(),
                paths,
                recursive,
                created: std::time::Instant::now(),
            },
        );
        return Ok(DeleteOutcome {
            dry_run: true,
            entries,
            confirm_token: Some(token),
        });
    }

    let token = args
        .get("confirmToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("mcp_delete_token_required", json!({})))?;
    let stored = crate::mcp::runtime_state::take_delete_token(token).ok_or_else(|| {
        AppError::config(
            "mcp_delete_token_invalid",
            json!({ "hint": "重新 dryRun 获取新 token" }),
        )
    })?;
    let paths: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
    if stored.session_id != session_id || stored.paths != paths || stored.recursive != recursive {
        return Err(AppError::config(
            "mcp_delete_token_mismatch",
            json!({ "hint": "会话/路径/递归开关与 dryRun 时不一致，请重新 dryRun" }),
        ));
    }

    for entry in &entries {
        if entry.is_dir {
            // `remove` 走 lstat + 递归删除，软链只删链接本身。
            sftp.remove(&entry.path).await?;
        } else {
            sftp.remove_file(&entry.path).await?;
        }
    }

    Ok(DeleteOutcome {
        dry_run: false,
        entries,
        confirm_token: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_paths_rejects_empty_and_oversized_lists() {
        assert_eq!(
            parse_paths(&json!({ "paths": [] })).unwrap_err().code(),
            "mcp_missing_argument"
        );
        let too_many: Vec<Value> = (0..=MAX_DELETE_PATHS)
            .map(|index| json!(format!("/tmp/{index}")))
            .collect();
        assert_eq!(
            parse_paths(&json!({ "paths": too_many }))
                .unwrap_err()
                .code(),
            "mcp_too_many_paths"
        );
    }

    #[test]
    fn parse_paths_rejects_control_characters() {
        assert_eq!(
            parse_paths(&json!({ "paths": ["/tmp/a\nb"] }))
                .unwrap_err()
                .code(),
            "mcp_path_invalid"
        );
    }

    #[test]
    fn delete_entry_serializes_shape() {
        let entry = DeleteEntry {
            path: "/tmp/a".to_string(),
            size: 12,
            is_dir: false,
        };
        let value = entry.to_json();
        assert_eq!(value["path"], "/tmp/a");
        assert_eq!(value["size"], 12);
        assert_eq!(value["isDir"], false);
    }
}
