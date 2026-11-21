//! `sftp_put` / `sftp_get`：本地 ↔ 远端流式传输，返回里只有路径/大小/校验和。
//!
//! 关键收益：不走 shell、不回 base64，token 成本与文件大小无关；上传/下载都
//! 复用 UI 传输队列同款多句柄流水线引擎（分块 + 临时文件 + 原子 rename）。
//! 批内文件级并行（`concurrency`）；信封默认回汇总 + 本地 manifest 文件
//! （verbose=true 逐项），进度事件用 `Host::Tauri` 发到前端（MCP 没有窗口，
//! 事件无人订阅也不会出错），job 进度另经 [`JobProgress`] 上报给 job_wait。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::ai::remote_script::shell_quote;
use crate::emitter::Host;
use crate::error::{AppError, AppResult};
use crate::mcp::runtime_state::{JobControl, JobProgress};
use crate::ssh::client::{exec_once, SshHandle};
use crate::ssh::sftp::SftpHandle;
use crate::state::AppState;

use super::{handle, path as pathutil};

/// 单次调用最多处理的文件数（递归展开后计数）。
pub const MAX_TRANSFER_ITEMS: usize = 2000;
/// 批内文件级并行度默认值与上限（每文件独立流水线流）。
pub const DEFAULT_CONCURRENCY: usize = 4;
pub const MAX_CONCURRENCY: usize = 8;

pub struct TransferOutcome {
    pub local_path: String,
    pub remote_path: String,
    pub size: u64,
    pub sha256: String,
    pub ok: bool,
    pub skipped: bool,
    pub remote_sha256: Option<String>,
    pub verify: Option<&'static str>,
    pub code: Option<&'static str>,
    pub message: Option<String>,
}

impl TransferOutcome {
    pub(crate) fn ok(local_path: String, remote_path: String, size: u64, sha256: String) -> Self {
        Self {
            local_path,
            remote_path,
            size,
            sha256,
            ok: true,
            skipped: false,
            remote_sha256: None,
            verify: None,
            code: None,
            message: None,
        }
    }

    pub(crate) fn skipped(local_path: String, remote_path: String, size: u64) -> Self {
        Self {
            local_path,
            remote_path,
            size,
            sha256: String::new(),
            ok: true,
            skipped: true,
            remote_sha256: None,
            verify: None,
            code: None,
            message: None,
        }
    }

    pub(crate) fn failure(local_path: String, remote_path: String, e: &AppError) -> Self {
        Self {
            local_path,
            remote_path,
            size: 0,
            sha256: String::new(),
            ok: false,
            skipped: false,
            remote_sha256: None,
            verify: None,
            code: Some(e.code()),
            message: Some(e.readable()),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            // Windows 反斜杠统一归一为 '/'，避免 agent 回传路径时混用分隔符。
            "localPath": self.local_path.replace('\\', "/"),
            "remotePath": self.remote_path,
            "size": self.size,
            "sha256": self.sha256,
            "status": if self.skipped { "skipped" } else if self.ok { "ok" } else { "error" },
            "remoteSha256": self.remote_sha256,
            "verify": self.verify,
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

pub fn parse_concurrency(args: &Value) -> usize {
    args.get("concurrency")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_CONCURRENCY)
        .clamp(1, MAX_CONCURRENCY)
}

fn flag(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
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
                name.clone()
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
                // 传输清单是本工具写在目录旁的副产物，不是用户的源文件，
                // 递归上传时排除，否则每轮同步都会把上一轮 manifest 传上远端。
                if name.starts_with(".termx-") && name.ends_with("-manifest.json") {
                    continue;
                }
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

fn epoch_secs(t: std::time::SystemTime) -> Option<i64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// 一个待传文件（递归展开后的最小单元），index 用于信封保序与进度键。
struct Unit {
    index: usize,
    local: PathBuf,
    remote: String,
    size: u64,
}

struct PutCtx<'a> {
    sftp: &'a SftpHandle,
    host: &'a Host,
    overwrite: bool,
    skip_unchanged: bool,
    cancel: Arc<AtomicBool>,
    progress: Option<Arc<JobProgress>>,
}

async fn upload_one(ctx: &PutCtx<'_>, unit: &Unit) -> AppResult<TransferOutcome> {
    let local = &unit.local;
    let remote = &unit.remote;
    let meta = tokio::fs::metadata(local)
        .await
        .map_err(|e| local_io("metadata", local, e))?;
    if meta.is_dir() {
        return Err(AppError::config(
            "mcp_transfer_is_dir",
            json!({ "path": local.display().to_string(), "hint": "目录请置 recursive=true" }),
        ));
    }
    let remote_exists = ctx.sftp.stat(remote).await.is_ok();
    if ctx.skip_unchanged && remote_exists {
        let (remote_size, remote_mtime) = ctx.sftp.remote_file_fingerprint(remote).await?;
        if remote_size == meta.len() {
            let local_mtime = meta.modified().ok().and_then(epoch_secs);
            let unchanged = match (remote_mtime, local_mtime) {
                // 远端副本不旧于本地源即视为已同步（上传会把远端 mtime 推到当前）。
                (Some(r), Some(l)) => r >= l,
                // 远端不给 mtime 时退化为尺寸比对。
                (None, _) => true,
                _ => false,
            };
            if unchanged {
                // 跳过的字节同样计入进度，否则含 skip 的 job 永远到不了 100%。
                if let Some(progress) = &ctx.progress {
                    progress.finish(unit.index, meta.len());
                }
                return Ok(TransferOutcome::skipped(
                    local.display().to_string(),
                    remote.clone(),
                    meta.len(),
                ));
            }
        }
    }
    if remote_exists && !ctx.overwrite {
        return Err(AppError::config(
            "mcp_file_exists",
            json!({ "path": remote }),
        ));
    }
    let mut file = tokio::fs::File::open(local)
        .await
        .map_err(|e| local_io("open", local, e))?;
    let total = meta.len();
    let checkpoint = Arc::new(AtomicU64::new(0));
    if let Some(progress) = &ctx.progress {
        progress.begin(unit.index, checkpoint.clone());
    }
    let size = ctx
        .sftp
        .upload_streaming_resumable(
            &mut file,
            total,
            remote,
            ctx.host,
            &format!("mcp-put-{}", unit.index),
            ctx.cancel.clone(),
            0,
            checkpoint,
        )
        .await?;
    if let Some(progress) = &ctx.progress {
        progress.finish(unit.index, size);
    }
    let sha256 = sha256_file(local).await?;
    Ok(TransferOutcome::ok(
        local.display().to_string(),
        remote.to_string(),
        size,
        sha256,
    ))
}

pub async fn sftp_put(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
    args: &Value,
    job: Option<&Arc<JobControl>>,
) -> AppResult<Vec<TransferOutcome>> {
    let items = parse_items(args)?;
    let overwrite = flag(args, "overwrite");
    let recursive = flag(args, "recursive");
    let skip_unchanged = flag(args, "skipUnchanged");
    let concurrency = parse_concurrency(args);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let host = Host::Tauri(app.clone());

    let mut units: Vec<Unit> = Vec::new();
    let mut settled: Vec<(usize, TransferOutcome)> = Vec::new();
    let mut next = 0usize;
    for item in items {
        let remote_base = match resolve_remote(&sftp, &home, &item.remote, true).await {
            Ok(value) => value,
            Err(e) => {
                settled.push((next, TransferOutcome::failure(item.local, item.remote, &e)));
                next += 1;
                continue;
            }
        };
        let local_root = PathBuf::from(&item.local);
        let meta = match tokio::fs::metadata(&local_root).await {
            Ok(value) => value,
            Err(e) => {
                settled.push((
                    next,
                    TransferOutcome::failure(
                        item.local,
                        remote_base,
                        &local_io("metadata", &local_root, e),
                    ),
                ));
                next += 1;
                continue;
            }
        };
        if meta.is_dir() {
            if !recursive {
                let err = AppError::config(
                    "mcp_transfer_is_dir",
                    json!({ "path": &item.local, "hint": "目录请置 recursive=true" }),
                );
                settled.push((next, TransferOutcome::failure(item.local, remote_base, &err)));
                next += 1;
                continue;
            }
            let files = match collect_local_files(&local_root).await {
                Ok(value) => value,
                Err(e) => {
                    settled.push((next, TransferOutcome::failure(item.local, remote_base, &e)));
                    next += 1;
                    continue;
                }
            };
            for (local_file, rel) in files {
                let size = tokio::fs::metadata(&local_file)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                units.push(Unit {
                    index: next,
                    local: local_file,
                    remote: join_remote(&remote_base, &rel),
                    size,
                });
                next += 1;
            }
        } else {
            units.push(Unit {
                index: next,
                local: local_root,
                remote: remote_base,
                size: meta.len(),
            });
            next += 1;
        }
    }
    if units.len() > MAX_TRANSFER_ITEMS {
        return Err(AppError::config(
            "mcp_too_many_items",
            json!({ "count": units.len(), "limit": MAX_TRANSFER_ITEMS }),
        ));
    }
    if let Some(job) = job {
        job.progress.set_total(units.iter().map(|u| u.size).sum());
    }

    let ctx = PutCtx {
        sftp: &sftp,
        host: &host,
        overwrite,
        skip_unchanged,
        cancel: job
            .map(|j| j.cancel.clone())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false))),
        progress: job.map(|j| j.progress.clone()),
    };
    // 与 sftp_get 同款所有权模式：引用在闭包外取好、unit 按值进 async move，
    // 避免 HRTB（FnOnce is not general enough）。
    let ctx = &ctx;
    let mut done: Vec<(usize, TransferOutcome)> = stream::iter(units.into_iter().map(|unit| {
        let ctx = ctx;
        async move {
            let outcome = upload_one(ctx, &unit).await.unwrap_or_else(|e| {
                TransferOutcome::failure(
                    unit.local.display().to_string(),
                    unit.remote.clone(),
                    &e,
                )
            });
            (unit.index, outcome)
        }
    }))
    .buffer_unordered(concurrency)
    .collect()
    .await;
    settled.append(&mut done);
    settled.sort_by_key(|(index, _)| *index);
    Ok(settled.into_iter().map(|(_, outcome)| outcome).collect())
}

/// 远端 sha256 基线（verifyRemote）：经 exec 通道跑 sha256sum，不走 shell 拼接用户输入。
async fn remote_sha256(ssh: &SshHandle, remote: &str) -> AppResult<String> {
    let script = format!("sha256sum {}", shell_quote(remote));
    let out = exec_once(ssh, &script, Duration::from_secs(120), false).await?;
    if out.exit_code != Some(0) {
        return Err(AppError::other(
            "mcp_verify_failed",
            json!({ "path": remote, "exitCode": out.exit_code, "stderr": out.stderr }),
        ));
    }
    out.stdout
        .split_whitespace()
        .next()
        .map(str::to_string)
        .filter(|hash| hash.len() == 64)
        .ok_or_else(|| {
            AppError::other(
                "mcp_verify_failed",
                json!({ "path": remote, "reason": "sha256sum 输出无法解析" }),
            )
        })
}

struct GetCtx<'a> {
    sftp: &'a SftpHandle,
    host: &'a Host,
    ssh: Option<&'a SshHandle>,
    overwrite: bool,
    skip_unchanged: bool,
    verify_remote: bool,
    cancel: Arc<AtomicBool>,
    progress: Option<Arc<JobProgress>>,
}

async fn download_one(ctx: &GetCtx<'_>, unit: &Unit) -> AppResult<TransferOutcome> {
    let local = &unit.local;
    let remote = &unit.remote;
    if ctx.skip_unchanged {
        if let Ok(meta) = tokio::fs::metadata(local).await {
            if meta.len() == unit.size {
                let (_, remote_mtime) = ctx.sftp.remote_file_fingerprint(remote).await?;
                let local_mtime = meta.modified().ok().and_then(epoch_secs);
                let unchanged = match (remote_mtime, local_mtime) {
                    (Some(r), Some(l)) => l >= r,
                    // 远端不给 mtime 时退化为尺寸比对（尺寸相同即视为未变）。
                    (None, _) => true,
                    _ => false,
                };
                if unchanged {
                    // 跳过的字节同样计入进度，否则含 skip 的 job 永远到不了 100%。
                    if let Some(progress) = &ctx.progress {
                        progress.finish(unit.index, unit.size);
                    }
                    return Ok(TransferOutcome::skipped(
                        local.display().to_string(),
                        remote.clone(),
                        unit.size,
                    ));
                }
            }
        }
    }
    if tokio::fs::metadata(local).await.is_ok() && !ctx.overwrite {
        return Err(AppError::config(
            "mcp_local_file_exists",
            json!({ "path": local.display().to_string() }),
        ));
    }
    let checkpoint = Arc::new(AtomicU64::new(0));
    if let Some(progress) = &ctx.progress {
        progress.begin(unit.index, checkpoint.clone());
    }
    let size = ctx
        .sftp
        .download_streaming_pipelined(
            remote,
            local,
            ctx.host,
            &format!("mcp-get-{}", unit.index),
            ctx.cancel.clone(),
            checkpoint,
        )
        .await?;
    if let Some(progress) = &ctx.progress {
        progress.finish(unit.index, size);
    }
    let sha256 = sha256_file(local).await?;
    let mut outcome = TransferOutcome::ok(
        local.display().to_string(),
        remote.clone(),
        size,
        sha256.clone(),
    );
    if ctx.verify_remote {
        let ssh = ctx.ssh.ok_or_else(|| {
            AppError::config(
                "mcp_unsupported_session_kind",
                json!({ "reason": "verifyRemote 需要 SSH exec 通道跑 sha256sum" }),
            )
        })?;
        let remote_hash = remote_sha256(ssh, remote).await?;
        outcome.remote_sha256 = Some(remote_hash.clone());
        outcome.verify = Some(if remote_hash == sha256 { "match" } else { "mismatch" });
        if remote_hash != sha256 {
            return Err(AppError::config(
                "mcp_verify_mismatch",
                json!({ "path": remote, "localSha256": sha256, "remoteSha256": remote_hash }),
            ));
        }
    }
    Ok(outcome)
}

pub async fn sftp_get(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
    args: &Value,
    job: Option<&Arc<JobControl>>,
) -> AppResult<Vec<TransferOutcome>> {
    let items = parse_items(args)?;
    let overwrite = flag(args, "overwrite");
    let recursive = flag(args, "recursive");
    let skip_unchanged = flag(args, "skipUnchanged");
    let verify_remote = flag(args, "verifyRemote");
    let concurrency = parse_concurrency(args);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let host = Host::Tauri(app.clone());
    let ssh = if verify_remote {
        let handles = crate::error::locked(&state.sessions)?;
        Some(
            handles
                .get(session_id)
                .map(|handle| handle.ssh_handle().clone())
                .ok_or_else(|| {
                    AppError::config(
                        "mcp_unsupported_session_kind",
                        json!({ "reason": "verifyRemote 需要 SSH exec 通道跑 sha256sum" }),
                    )
                })?,
        )
    } else {
        None
    };

    let mut units: Vec<Unit> = Vec::new();
    let mut settled: Vec<(usize, TransferOutcome)> = Vec::new();
    let mut next = 0usize;
    for item in items {
        let remote_path = match resolve_remote(&sftp, &home, &item.remote, false).await {
            Ok(value) => value,
            Err(e) => {
                settled.push((next, TransferOutcome::failure(item.local, item.remote, &e)));
                next += 1;
                continue;
            }
        };
        let stat = match sftp.stat(&remote_path).await {
            Ok(value) => value,
            Err(e) => {
                settled.push((next, TransferOutcome::failure(item.local, remote_path, &e)));
                next += 1;
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
                settled.push((next, TransferOutcome::failure(item.local, remote_path, &err)));
                next += 1;
                continue;
            }
            let entries = match sftp.walk_files(&remote_path).await {
                Ok(value) => value,
                Err(e) => {
                    settled.push((next, TransferOutcome::failure(item.local, remote_path, &e)));
                    next += 1;
                    continue;
                }
            };
            if entries.len() > MAX_TRANSFER_ITEMS {
                settled.push((
                    next,
                    TransferOutcome::failure(
                        item.local,
                        remote_path,
                        &AppError::config(
                            "mcp_too_many_items",
                            json!({ "count": entries.len(), "limit": MAX_TRANSFER_ITEMS }),
                        ),
                    ),
                ));
                next += 1;
                continue;
            }
            // 目录先建（含空目录），文件随后并行传。
            for entry in &entries {
                let rel = entry.rel_path.trim_start_matches('/');
                if rel.is_empty() || !entry.is_dir {
                    continue;
                }
                let local_dir = local_root.join(rel);
                if let Err(e) = tokio::fs::create_dir_all(&local_dir).await {
                    settled.push((
                        next,
                        TransferOutcome::failure(
                            local_dir.display().to_string(),
                            join_remote(&remote_path, rel),
                            &local_io("create_dir_all", &local_dir, e),
                        ),
                    ));
                    next += 1;
                }
            }
            for entry in entries {
                let rel = entry.rel_path.trim_start_matches('/').to_string();
                if rel.is_empty() || entry.is_dir {
                    continue;
                }
                units.push(Unit {
                    index: next,
                    local: local_root.join(&rel),
                    remote: join_remote(&remote_path, &rel),
                    size: entry.size,
                });
                next += 1;
            }
        } else {
            units.push(Unit {
                index: next,
                local: local_root,
                remote: remote_path,
                size: stat.size,
            });
            next += 1;
        }
    }
    if units.len() > MAX_TRANSFER_ITEMS {
        return Err(AppError::config(
            "mcp_too_many_items",
            json!({ "count": units.len(), "limit": MAX_TRANSFER_ITEMS }),
        ));
    }
    if let Some(job) = job {
        job.progress.set_total(units.iter().map(|u| u.size).sum());
    }

    let ctx = GetCtx {
        sftp: &sftp,
        host: &host,
        ssh: ssh.as_ref(),
        overwrite,
        skip_unchanged,
        verify_remote,
        cancel: job
            .map(|j| j.cancel.clone())
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false))),
        progress: job.map(|j| j.progress.clone()),
    };
    // 与 sftp_put 同款所有权模式：引用在闭包外取好、unit 按值进 async move，
    // 避免 `iter().map(|&unit| async {})` 触发 HRTB（FnOnce is not general enough）。
    let ctx = &ctx;
    let mut done: Vec<(usize, TransferOutcome)> = stream::iter(units.into_iter().map(|unit| {
        let ctx = ctx;
        async move {
            let outcome = download_one(ctx, &unit)
                .await
                .unwrap_or_else(|e| {
                    TransferOutcome::failure(
                        unit.local.display().to_string(),
                        unit.remote.clone(),
                        &e,
                    )
                });
            (unit.index, outcome)
        }
    }))
    .buffer_unordered(concurrency)
    .collect()
    .await;
    settled.append(&mut done);
    settled.sort_by_key(|(index, _)| *index);
    Ok(settled.into_iter().map(|(_, outcome)| outcome).collect())
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
        assert_eq!(value["message"], "mcp_file_exists");
    }

    #[test]
    fn outcome_serializes_skipped_and_verify() {
        let skipped = TransferOutcome::skipped("/l/a".into(), "/r/a".into(), 7);
        assert_eq!(skipped.to_json()["status"], "skipped");
        let mut ok = TransferOutcome::ok("/l/a".into(), "/r/a".into(), 7, "hash".into());
        ok.remote_sha256 = Some("hash".into());
        ok.verify = Some("match");
        let value = ok.to_json();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["verify"], "match");
        assert_eq!(value["remoteSha256"], "hash");
    }

    #[test]
    fn concurrency_defaults_and_clamps() {
        assert_eq!(parse_concurrency(&json!({})), DEFAULT_CONCURRENCY);
        assert_eq!(parse_concurrency(&json!({ "concurrency": 0 })), 1);
        assert_eq!(parse_concurrency(&json!({ "concurrency": 99 })), MAX_CONCURRENCY);
        assert_eq!(parse_concurrency(&json!({ "concurrency": 2 })), 2);
    }

    #[test]
    fn to_json_normalizes_windows_separators() {
        let outcome = TransferOutcome::ok(
            r"D:\dl\sub\a.bin".to_string(),
            "/r/a.bin".to_string(),
            3,
            "h".to_string(),
        );
        assert_eq!(outcome.to_json()["localPath"], "D:/dl/sub/a.bin");
    }

    #[tokio::test]
    async fn collect_local_files_excludes_transfer_manifests() {
        let dir = std::env::temp_dir().join(format!(
            "termx-collect-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("src.c"), b"x").await.unwrap();
        tokio::fs::write(dir.join(".termx-sftp_put-manifest.json"), b"{}")
            .await
            .unwrap();
        tokio::fs::write(dir.join(".termx-sftp_get-manifest.json"), b"{}")
            .await
            .unwrap();
        let files = collect_local_files(&dir).await.unwrap();
        let rels: Vec<&str> = files.iter().map(|(_, rel)| rel.as_str()).collect();
        assert_eq!(rels, vec!["src.c"]);
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}