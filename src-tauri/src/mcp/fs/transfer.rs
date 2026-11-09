//! `sftp_put` / `sftp_get`：本地 ↔ 远端流式传输，返回里只有路径/大小/校验和。
//!
//! 关键收益：不走 shell、不回 base64，token 成本与文件大小无关；上传/下载都复用
//! [`SftpHandle`] 的流式实现（分块 + 临时文件 + 原子 rename），进度事件用
//! `Host::Tauri` 发到前端（MCP 没有窗口，事件无人订阅也不会出错）。

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::emitter::Host;
use crate::error::{AppError, AppResult};
use crate::ssh::sftp::SftpHandle;
use crate::state::AppState;

use super::{handle, path as pathutil};

/// 单次调用最多处理的文件数（递归展开后计数）。
pub const MAX_TRANSFER_ITEMS: usize = 2000;

pub struct TransferOutcome {
    pub local_path: String,
    pub remote_path: String,
    pub size: u64,
    pub sha256: String,
    pub ok: bool,
    pub code: Option<&'static str>,
    pub message: Option<String>,
}

impl TransferOutcome {
    fn ok(local_path: String, remote_path: String, size: u64, sha256: String) -> Self {
        Self {
            local_path,
            remote_path,
            size,
            sha256,
            ok: true,
            code: None,
            message: None,
        }
    }

    fn failure(local_path: String, remote_path: String, e: &AppError) -> Self {
        Self {
            local_path,
            remote_path,
            size: 0,
            sha256: String::new(),
            ok: false,
            code: Some(e.code()),
            message: Some(e.to_string()),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "localPath": self.local_path,
            "remotePath": self.remote_path,
            "size": self.size,
            "sha256": self.sha256,
            "status": if self.ok { "ok" } else { "error" },
            "code": self.code,
            "message": self.message,
        })
    }
}

#[derive(Debug)]
struct TransferItem {
    local: String,
    remote: String,
}

fn parse_items(args: &Value) -> AppResult<Vec<TransferItem>> {
    let items = args
        .get("items")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "items" })))?;
    if items.len() > MAX_TRANSFER_ITEMS {
        return Err(AppError::config(
            "mcp_too_many_items",
            json!({ "count": items.len(), "limit": MAX_TRANSFER_ITEMS }),
        ));
    }
    let mut parsed = Vec::with_capacity(items.len());
    for item in items {
        let local = item
            .get("localPath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::config(
                    "mcp_missing_argument",
                    json!({ "arg": "items[].localPath" }),
                )
            })?;
        let remote = item
            .get("remotePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::config(
                    "mcp_missing_argument",
                    json!({ "arg": "items[].remotePath" }),
                )
            })?;
        // 相对本地路径会落到 app 的进程工作目录，歧义且危险，统一要求绝对路径。
        if !Path::new(local).is_absolute() {
            return Err(AppError::config(
                "mcp_local_path_invalid",
                json!({ "path": local, "reason": "必须是绝对路径" }),
            ));
        }
        parsed.push(TransferItem {
            local: local.to_string(),
            remote: remote.to_string(),
        });
    }
    Ok(parsed)
}

fn local_io(op: &'static str, path: &Path, e: std::io::Error) -> AppError {
    AppError::other(
        "mcp_local_io_failed",
        json!({ "op": op, "path": path.display().to_string(), "err": e.to_string() }),
    )
}

async fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| local_io("open", path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .await
            .map_err(|e| local_io("read", path, e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 递归收集本地普通文件；返回 `(绝对路径, 相对根目录的 '/' 分隔路径)`。
async fn collect_local_files(root: &Path) -> AppResult<Vec<(PathBuf, String)>> {
    let mut stack = vec![(root.to_path_buf(), String::new())];
    let mut files = Vec::new();
    while let Some((dir, rel)) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| local_io("read_dir", &dir, e))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| local_io("read_dir", &dir, e))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let meta = entry
                .metadata()
                .await
                .map_err(|e| local_io("metadata", &entry.path(), e))?;
            if meta.is_dir() {
                stack.push((entry.path(), child_rel));
            } else if meta.is_file() {
                files.push((entry.path(), child_rel));
                if files.len() > MAX_TRANSFER_ITEMS {
                    return Err(AppError::config(
                        "mcp_too_many_items",
                        json!({ "count": files.len(), "limit": MAX_TRANSFER_ITEMS }),
                    ));
                }
            }
        }
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(files)
}

/// 远端路径规范化。`exist_ok=false` 时要求目标已存在。
async fn resolve_remote(
    sftp: &SftpHandle,
    home: &str,
    input: &str,
    exist_ok: bool,
) -> AppResult<String> {
    super::shell::validate_remote_path(input)?;
    let target = pathutil::normalize(input, home, home)?;
    if sftp.realpath(&target).await.is_err() && !exist_ok {
        return Err(AppError::not_found(
            "mcp_transfer_not_found",
            json!({ "path": target }),
        ));
    }
    Ok(target)
}

fn join_remote(base: &str, rel: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), rel)
}

async fn upload_one(
    sftp: &SftpHandle,
    host: &Host,
    index: usize,
    local: &Path,
    remote: &str,
    overwrite: bool,
) -> AppResult<TransferOutcome> {
    let meta = tokio::fs::metadata(local)
        .await
        .map_err(|e| local_io("metadata", local, e))?;
    if meta.is_dir() {
        return Err(AppError::config(
            "mcp_transfer_is_dir",
            json!({ "path": local.display().to_string(), "hint": "目录请置 recursive=true" }),
        ));
    }
    if sftp.stat(remote).await.is_ok() && !overwrite {
        return Err(AppError::config(
            "mcp_file_exists",
            json!({ "path": remote }),
        ));
    }
    let mut file = tokio::fs::File::open(local)
        .await
        .map_err(|e| local_io("open", local, e))?;
    let total = meta.len();
    sftp.upload_streaming(
        &mut file,
        total,
        remote,
        host,
        &format!("mcp-put-{index}"),
        Arc::new(AtomicBool::new(false)),
    )
    .await?;
    let sha256 = sha256_file(local).await?;
    Ok(TransferOutcome::ok(
        local.display().to_string(),
        remote.to_string(),
        total,
        sha256,
    ))
}

pub async fn sftp_put(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
    args: &Value,
) -> AppResult<Vec<TransferOutcome>> {
    let items = parse_items(args)?;
    let overwrite = args
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let host = Host::Tauri(app.clone());
    let mut results = Vec::new();
    let mut index = 0usize;

    for item in items {
        let remote_base = match resolve_remote(&sftp, &home, &item.remote, true).await {
            Ok(value) => value,
            Err(e) => {
                results.push(TransferOutcome::failure(item.local, item.remote, &e));
                continue;
            }
        };
        let local_root = PathBuf::from(&item.local);
        let meta = match tokio::fs::metadata(&local_root).await {
            Ok(value) => value,
            Err(e) => {
                results.push(TransferOutcome::failure(
                    item.local,
                    remote_base,
                    &local_io("metadata", &local_root, e),
                ));
                continue;
            }
        };

        if meta.is_dir() {
            if !recursive {
                let err = AppError::config(
                    "mcp_transfer_is_dir",
                    json!({ "path": &item.local, "hint": "目录请置 recursive=true" }),
                );
                results.push(TransferOutcome::failure(item.local, remote_base, &err));
                continue;
            }
            let files = match collect_local_files(&local_root).await {
                Ok(value) => value,
                Err(e) => {
                    results.push(TransferOutcome::failure(item.local, remote_base, &e));
                    continue;
                }
            };
            for (local_file, rel) in files {
                index += 1;
                let remote = join_remote(&remote_base, &rel);
                let outcome = upload_one(&sftp, &host, index, &local_file, &remote, overwrite)
                    .await
                    .unwrap_or_else(|e| {
                        TransferOutcome::failure(
                            local_file.display().to_string(),
                            remote.clone(),
                            &e,
                        )
                    });
                results.push(outcome);
            }
        } else {
            index += 1;
            let outcome = upload_one(&sftp, &host, index, &local_root, &remote_base, overwrite)
                .await
                .unwrap_or_else(|e| {
                    TransferOutcome::failure(item.local.clone(), remote_base.clone(), &e)
                });
            results.push(outcome);
        }
    }

    Ok(results)
}

async fn download_one(
    sftp: &SftpHandle,
    host: &Host,
    index: usize,
    remote: &str,
    local: &Path,
    overwrite: bool,
) -> AppResult<TransferOutcome> {
    if tokio::fs::metadata(local).await.is_ok() && !overwrite {
        return Err(AppError::config(
            "mcp_local_file_exists",
            json!({ "path": local.display().to_string() }),
        ));
    }
    let size = sftp
        .download_streaming(
            remote,
            local,
            host,
            &format!("mcp-get-{index}"),
            Arc::new(AtomicBool::new(false)),
        )
        .await?;
    let sha256 = sha256_file(local).await?;
    Ok(TransferOutcome::ok(
        local.display().to_string(),
        remote.to_string(),
        size,
        sha256,
    ))
}

pub async fn sftp_get(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
    args: &Value,
) -> AppResult<Vec<TransferOutcome>> {
    let items = parse_items(args)?;
    let overwrite = args
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let host = Host::Tauri(app.clone());
    let mut results = Vec::new();
    let mut index = 0usize;

    for item in items {
        let remote_path = match resolve_remote(&sftp, &home, &item.remote, false).await {
            Ok(value) => value,
            Err(e) => {
                results.push(TransferOutcome::failure(item.local, item.remote, &e));
                continue;
            }
        };
        let stat = match sftp.stat(&remote_path).await {
            Ok(value) => value,
            Err(e) => {
                results.push(TransferOutcome::failure(item.local, remote_path, &e));
                continue;
            }
        };
        let local_root = PathBuf::from(&item.local);

        if stat.is_dir {
            if !recursive {
                let err = AppError::config(
                    "mcp_transfer_is_dir",
                    json!({ "path": &remote_path, "hint": "目录请置 recursive=true" }),
                );
                results.push(TransferOutcome::failure(item.local, remote_path, &err));
                continue;
            }
            let entries = match sftp.walk_files(&remote_path).await {
                Ok(value) => value,
                Err(e) => {
                    results.push(TransferOutcome::failure(item.local, remote_path, &e));
                    continue;
                }
            };
            if entries.len() > MAX_TRANSFER_ITEMS {
                results.push(TransferOutcome::failure(
                    item.local,
                    remote_path,
                    &AppError::config(
                        "mcp_too_many_items",
                        json!({ "count": entries.len(), "limit": MAX_TRANSFER_ITEMS }),
                    ),
                ));
                continue;
            }
            for entry in entries {
                let rel = entry.rel_path.trim_start_matches('/').to_string();
                if rel.is_empty() {
                    continue;
                }
                let local_target = local_root.join(&rel);
                if entry.is_dir {
                    if let Err(e) = tokio::fs::create_dir_all(&local_target).await {
                        results.push(TransferOutcome::failure(
                            local_target.display().to_string(),
                            join_remote(&remote_path, &rel),
                            &local_io("create_dir_all", &local_target, e),
                        ));
                    }
                    continue;
                }
                index += 1;
                let remote_file = join_remote(&remote_path, &rel);
                let outcome =
                    download_one(&sftp, &host, index, &remote_file, &local_target, overwrite)
                        .await
                        .unwrap_or_else(|e| {
                            TransferOutcome::failure(
                                local_target.display().to_string(),
                                remote_file.clone(),
                                &e,
                            )
                        });
                results.push(outcome);
            }
        } else {
            index += 1;
            let outcome = download_one(&sftp, &host, index, &remote_path, &local_root, overwrite)
                .await
                .unwrap_or_else(|e| {
                    TransferOutcome::failure(item.local.clone(), remote_path.clone(), &e)
                });
            results.push(outcome);
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_items_requires_absolute_local_path() {
        let args = json!({ "items": [{ "localPath": "relative/a.c", "remotePath": "~/a.c" }] });
        let err = parse_items(&args).unwrap_err();
        assert_eq!(err.code(), "mcp_local_path_invalid");
    }

    #[test]
    fn parse_items_rejects_empty_list() {
        let err = parse_items(&json!({ "items": [] })).unwrap_err();
        assert_eq!(err.code(), "mcp_missing_argument");
    }

    #[test]
    fn join_remote_avoids_double_slash() {
        assert_eq!(join_remote("/home/u/", "a/b.c"), "/home/u/a/b.c");
    }

    #[test]
    fn outcome_serializes_failure_shape() {
        let failure = TransferOutcome::failure(
            "/l/a".to_string(),
            "/r/a".to_string(),
            &AppError::config("mcp_file_exists", json!({})),
        );
        let value = failure.to_json();
        assert_eq!(value["status"], "error");
        assert_eq!(value["code"], "mcp_file_exists");
        assert_eq!(value["size"], 0);
    }
}
