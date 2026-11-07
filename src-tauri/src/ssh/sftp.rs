use std::collections::VecDeque;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt, AsyncWrite, AsyncWriteExt};

use futures_util::stream::{FuturesUnordered, StreamExt};
use russh_sftp::protocol::OpenFlags;

use crate::error::{AppError, AppResult};
use crate::models::Credential;
use crate::ssh::client;

/// i18n code returned when the user cancels a transfer. The frontend
/// (transfers.svelte.ts) matches this literal via `errStr.includes(...)` to
/// flip the status to "cancelled". Keep the constant in sync across both ends.
pub const CANCELLED_CODE: &str = "transfer_cancelled";

/// 进度事件节流间隔。对齐 Netcatty 传输进度上报（约 200ms 一条）：
/// 30MB 文件按 32KB 分块原本会发近千条事件，既拖慢 webview 也会让
/// 进度条更新相互覆盖；首帧立即发出，最后一块（100%）强制发出。
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// 流水线并发窗口：每个远端句柄同一时刻只有一条在途请求，开 N 个句柄即可
/// 维持 N 条并发请求。对齐 Netcatty（ssh2 fastXfer 默认 64 并发 / 32KB）；
/// 这里用 16 × 64KB ≈ 1MB 在途窗口，实测足以打满局域网链路。
const PIPELINE_WINDOW: usize = 16;
const PIPELINE_CHUNK: usize = 65536;

/// 进度节流器。用 `Mutex` 而不是 `Cell`：进度闭包会被 async 任务捕获，
/// future 要满足 Send，`&Cell` 不满足 Sync，会直接编译失败。
struct ProgressThrottle {
    last: std::sync::Mutex<Option<Instant>>,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last: std::sync::Mutex::new(None),
        }
    }

    fn should_emit(&self, transferred: u64, total: u64) -> bool {
        // 完成帧必须发出，保证前端能拿到 100%（不依赖状态事件补齐）。
        if total > 0 && transferred >= total {
            return true;
        }
        let now = Instant::now();
        let mut last = self
            .last
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match *last {
            None => {
                *last = Some(now);
                true
            }
            Some(prev) if now.duration_since(prev) >= PROGRESS_EMIT_INTERVAL => {
                *last = Some(now);
                true
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// unix epoch seconds; 0 means the server did not provide the mtime
    pub mtime: u64,
    /// 远端所有者（侧栏 SFTP 5 列布局展示；服务器未返回时缺省）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileStat {
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<u32>,
}

/// Flat walk output. `rel_path` is always '/'-separated (even when the host is
/// Windows); the frontend swaps separators when joining the local path.
#[derive(Debug, Clone, Serialize)]
pub struct WalkEntry {
    pub rel_path: String,
    pub size: u64,
}

/// Maximum recursion depth, counting the root as depth 0. With CAP = 32 the
/// walker accepts paths up to 32 segments deep (root through depth 31) and
/// fails the whole command at depth 32 — guards against symlink cycles and
/// pathological server-side trees.
const WALK_DEPTH_CAP: u32 = 32;

/// Owns an AI download's deterministic `.part` path. Dropping the future at
/// any await point drops this guard after the open file, so cancellation cannot
/// leave a partial artifact behind.
struct PartialDownloadGuard {
    path: PathBuf,
    committed: bool,
}

impl PartialDownloadGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(mut self, local_path: &Path) -> std::io::Result<()> {
        replace_local_file(&self.path, local_path)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for PartialDownloadGuard {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Replace the completed download without yielding. On Windows, `rename`
/// cannot overwrite an existing file, so removal and rename stay in one
/// synchronous section where task cancellation cannot split them.
fn replace_local_file(tmp_path: &Path, local_path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        match std::fs::remove_file(local_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    std::fs::rename(tmp_path, local_path)
}

/// Join a remote path segment. Special-cases dir == "/" so the result never
/// contains "//foo"; matches the convention used by the existing callers.
fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

pub struct SftpHandle {
    sftp: russh_sftp::client::SftpSession,
    /// 父 SSH 会话 id；None 表示这条 SFTP 走的是独立 TCP（`SftpHandle::connect`）。
    /// SSH 关闭时会按这个字段反向找到所有 children 并清理。
    parent_ssh_id: Option<String>,
}

impl SftpHandle {
    pub fn parent_ssh_id(&self) -> Option<&str> {
        self.parent_ssh_id.as_deref()
    }

    /// Open SFTP subsystem on an existing SSH connection.
    pub async fn from_handle(
        ssh_handle: &crate::ssh::client::SshHandle,
        parent_ssh_id: String,
    ) -> AppResult<Self> {
        let channel = {
            let h = ssh_handle.lock().await;
            h.channel_open_session().await.map_err(|e| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "open channel", "err": e.to_string() }),
                )
            })?
        };

        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "request_subsystem", "err": e.to_string() }),
            )
        })?;

        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| AppError::sftp("sftp_init_failed", json!({ "err": e.to_string() })))?;

        Ok(Self {
            sftp,
            parent_ssh_id: Some(parent_ssh_id),
        })
    }

    pub async fn connect(
        host: String,
        port: u16,
        credential: Credential,
        known_hosts_path: PathBuf,
        timeout_secs: u64,
        proxy: Option<crate::ssh::proxy::ProxyConfig>,
        host_key_policy: Option<String>,
    ) -> AppResult<Self> {
        let dial = client::DialCtx {
            config: crate::ssh::client::default_client_config(),
            known_hosts_path,
            timeout_secs,
            log: crate::ssh::client::null_logger(),
            prompt_ctx: None,
            progress: None,
            // SFTP 后台连接不参与 agent 转发（转发只由终端会话按档案开关发起）。
            agent_forwarding: false,
            // 独立连接沿用主机档案的代理配置（终端 / SFTP 一致）。
            proxy,
            // 主机级 known-host 策略随档案；SFTP 无终端上下文，未知主机默认拒绝。
            host_key_policy,
            // SFTP 独立连接不做发行版探测，无需 banner 截获。
            banner: None,
        };
        let mut handle = client::ssh_connect(dial, host, port).await?;

        client::authenticate(&mut handle, credential, None).await?;

        let channel = handle.channel_open_session().await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "open channel", "err": e.to_string() }),
            )
        })?;

        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "request_subsystem", "err": e.to_string() }),
            )
        })?;

        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| AppError::sftp("sftp_init_failed", json!({ "err": e.to_string() })))?;

        Ok(Self {
            sftp,
            parent_ssh_id: None,
        })
    }

    pub async fn home_dir(&self) -> AppResult<String> {
        self.sftp.canonicalize(".").await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "canonicalize", "err": e.to_string() }),
            )
        })
    }

    pub async fn list_dir(&self, path: &str) -> AppResult<Vec<RemoteEntry>> {
        let entries = self.sftp.read_dir(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "read_dir", "err": e.to_string() }),
            )
        })?;

        let mut result: Vec<RemoteEntry> = entries
            .map(|e| {
                let name = e.file_name();
                let ft = e.file_type();
                let meta = e.metadata();
                RemoteEntry {
                    name,
                    is_dir: ft.is_dir(),
                    is_symlink: ft.is_symlink(),
                    size: meta.size.unwrap_or(0),
                    mtime: meta.mtime.map(u64::from).unwrap_or(0),
                    user: meta.user.clone(),
                    group: meta.group.clone(),
                }
            })
            .collect();

        result.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(result)
    }

    /// Recursively list every downloadable file under `root`, returning a flat
    /// list of (relative path, size).
    ///
    /// - BFS to avoid blowing the stack on deep trees.
    /// - Symlink-to-file: follow once for size, treat as a regular file.
    ///   Symlink-to-dir: skipped to prevent loops.
    /// - Depth exceeding `WALK_DEPTH_CAP` fails the whole command.
    /// - Per-file failures are not handled here: each file is later dispatched
    ///   as an independent Transfer, which owns its own retry/cancel surface.
    ///   This function only builds the work list.
    pub async fn walk_files(&self, root: &str) -> AppResult<Vec<WalkEntry>> {
        let root_norm = root.trim_end_matches('/').to_string();
        let mut queue: VecDeque<(String, u32)> = VecDeque::new();
        queue.push_back((root.to_string(), 0));
        let mut result: Vec<WalkEntry> = Vec::new();

        while let Some((dir, depth)) = queue.pop_front() {
            if depth >= WALK_DEPTH_CAP {
                return Err(AppError::sftp(
                    "sftp_tree_too_deep",
                    json!({ "path": dir, "depth": depth, "limit": WALK_DEPTH_CAP }),
                ));
            }
            let entries = self.sftp.read_dir(&dir).await.map_err(|e| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "read_dir", "path": dir, "err": e.to_string() }),
                )
            })?;
            for e in entries {
                let name = e.file_name();
                let full = join_remote(&dir, &name);
                let rel = full
                    .strip_prefix(&root_norm)
                    .unwrap_or(&full)
                    .trim_start_matches('/')
                    .to_string();
                let ft = e.file_type();
                if ft.is_dir() {
                    queue.push_back((full, depth + 1));
                } else if ft.is_file() {
                    result.push(WalkEntry {
                        rel_path: rel,
                        size: e.metadata().size.unwrap_or(0),
                    });
                } else if ft.is_symlink() {
                    // Follow once via STAT to learn what the target is.
                    if let Ok(meta) = self.sftp.metadata(&full).await {
                        if meta.file_type().is_file() {
                            result.push(WalkEntry {
                                rel_path: rel,
                                size: meta.size.unwrap_or(0),
                            });
                        }
                        // symlink-to-dir: skip to avoid cycles.
                        // anything else (block/char/fifo): skip.
                    }
                    // metadata failure (e.g. broken symlink): silently skip.
                }
                // Other types (block/char/fifo) are skipped.
            }
        }
        Ok(result)
    }

    pub async fn download(&self, remote_path: &str) -> AppResult<Vec<u8>> {
        self.sftp.read(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "read", "err": e.to_string() }),
            )
        })
    }

    pub async fn upload(&self, remote_path: &str, data: &[u8]) -> AppResult<()> {
        // 不用 `SftpSession::write`：它只以 OpenFlags::WRITE 打开——文件不存在
        // 报 No such file，收缩内容时旧尾部残留（编辑器保存损坏）。改用
        // create（CREATE | TRUNCATE | WRITE）+ write_all，整体覆盖与本地写一致。
        use tokio::io::AsyncWriteExt;
        let mut file = self
            .sftp
            .create(remote_path)
            .await
            .map_err(|e| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "write", "err": e.to_string() }),
                )
            })?;
        file.write_all(data).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "write", "err": e.to_string() }),
            )
        })
    }

    pub async fn mkdir(&self, path: &str) -> AppResult<()> {
        self.sftp.create_dir(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "create_dir", "err": e.to_string() }),
            )
        })
    }

    pub async fn remove_file(&self, path: &str) -> AppResult<()> {
        self.sftp.remove_file(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "remove_file", "err": e.to_string() }),
            )
        })
    }

    pub async fn remove_dir(&self, path: &str) -> AppResult<()> {
        self.sftp.remove_dir(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "remove_dir", "err": e.to_string() }),
            )
        })
    }

    /// Delete a file or a directory tree. LSTAT decides which — the frontend's
    /// listing can be stale (e.g. a deploy swapped a real dir for a symlink
    /// since the last refresh), and recursing through a symlink would delete
    /// the *target's* contents. Anything that is not a real directory — file,
    /// symlink, special — is removed by name.
    pub async fn remove(&self, path: &str) -> AppResult<()> {
        let meta = self.sftp.symlink_metadata(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "lstat", "err": e.to_string() }),
            )
        })?;
        if meta.file_type().is_dir() {
            self.remove_dir_all(path).await
        } else {
            self.remove_file(path).await
        }
    }

    /// Recursively delete a directory tree.
    ///
    /// Single BFS over `read_dir`: real directories are queued for traversal
    /// and recorded for bottom-up removal; everything else — regular files,
    /// symlinks (even symlinks to directories) and special files — is removed
    /// on the spot, because SFTP REMOVE deletes the name itself, never the
    /// target. Depth is capped like `walk_files`, so a hostile server (or a
    /// bind-mount cycle) cannot make the walk run forever.
    async fn remove_dir_all(&self, root: &str) -> AppResult<()> {
        let mut dirs: Vec<String> = Vec::new();
        let mut queue: VecDeque<(String, u32)> = VecDeque::new();
        queue.push_back((root.trim_end_matches('/').to_string(), 0));
        while let Some((dir, depth)) = queue.pop_front() {
            if depth >= WALK_DEPTH_CAP {
                return Err(AppError::sftp(
                    "sftp_tree_too_deep",
                    json!({ "path": dir, "depth": depth, "limit": WALK_DEPTH_CAP }),
                ));
            }
            let entries = self.sftp.read_dir(&dir).await.map_err(|e| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "read_dir", "path": dir, "err": e.to_string() }),
                )
            })?;
            for e in entries {
                let full = join_remote(&dir, &e.file_name());
                if e.file_type().is_dir() {
                    queue.push_back((full.clone(), depth + 1));
                    dirs.push(full);
                } else {
                    self.remove_file(&full).await?;
                }
            }
        }
        // BFS order puts parents before children, so reverse = deepest-first.
        for d in dirs.iter().rev() {
            self.remove_dir(d).await?;
        }
        self.remove_dir(root).await
    }

    pub async fn rename(&self, old: &str, new: &str) -> AppResult<()> {
        self.sftp.rename(old, new).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "rename", "err": e.to_string() }),
            )
        })
    }

    /// 同主机复制单个文件：远端读 → 远端写，64 KiB 分块流式，内存占用恒定。
    /// 目标先写 `<dst>.part`，成功后替换，避免中断留下半截文件（与 upload_streaming 同策略）。
    /// 目录复制暂不支持（前端只对文件提供入口），由调用方回 `sftp_io_failed`。
    pub async fn copy_file(&self, src: &str, dst: &str) -> AppResult<u64> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let meta = self.sftp.metadata(src).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "metadata", "err": e.to_string() }),
            )
        })?;
        if meta.is_dir() {
            return Err(AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "copy", "err": "directories are not supported" }),
            ));
        }
        if let Some((parent, _)) = dst.rsplit_once('/') {
            if !parent.is_empty() {
                self.mkdir_p(parent).await?;
            }
        }

        let tmp = format!("{dst}.part");
        let mut src_file = self.sftp.open(src).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "open", "err": e.to_string() }),
            )
        })?;
        let mut dst_file = self.sftp.create(&tmp).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "create", "err": e.to_string() }),
            )
        })?;

        let mut buf = vec![0u8; 64 * 1024];
        let mut written: u64 = 0;
        let result = async {
            loop {
                let n = src_file.read(&mut buf).await.map_err(|e| {
                    AppError::sftp(
                        "sftp_io_failed",
                        json!({ "op": "copy_read", "err": e.to_string() }),
                    )
                })?;
                if n == 0 {
                    break;
                }
                dst_file.write_all(&buf[..n]).await.map_err(|e| {
                    AppError::sftp(
                        "sftp_io_failed",
                        json!({ "op": "copy_write", "err": e.to_string() }),
                    )
                })?;
                written += n as u64;
            }
            Ok::<(), AppError>(())
        }
        .await;

        let _ = src_file.shutdown().await;

        match result {
            Ok(()) => {
                dst_file.shutdown().await.map_err(|e| {
                    AppError::sftp(
                        "sftp_io_failed",
                        json!({ "op": "close", "err": e.to_string() }),
                    )
                })?;
                // 部分服务器 rename 不允许覆盖已存在目标，先删再改名。
                let _ = self.sftp.remove_file(dst).await;
                self.sftp.rename(&tmp, dst).await.map_err(|e| {
                    AppError::sftp(
                        "sftp_io_failed",
                        json!({ "op": "rename", "err": e.to_string() }),
                    )
                })?;
                Ok(written)
            }
            Err(e) => {
                let _ = self.sftp.remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    pub async fn stat(&self, path: &str) -> AppResult<FileStat> {
        let meta = self.sftp.metadata(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "metadata", "err": e.to_string() }),
            )
        })?;
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        Ok(FileStat {
            name,
            is_dir: meta.file_type().is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.map(u64::from).unwrap_or(0),
            uid: meta.uid,
            gid: meta.gid,
            user: meta.user.clone(),
            group: meta.group.clone(),
            permissions: meta.permissions,
        })
    }

    /// LSTAT：不跟随符号链接的 metadata。双栏 UI 需要它区分链接与真实目录
    /// （类型列、删除路径选择、冲突检测）。
    pub async fn lstat(&self, path: &str) -> AppResult<FileStat> {
        let meta = self.sftp.symlink_metadata(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "lstat", "err": e.to_string() }),
            )
        })?;
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        Ok(FileStat {
            name,
            is_dir: meta.file_type().is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.map(u64::from).unwrap_or(0),
            uid: meta.uid,
            gid: meta.gid,
            user: meta.user.clone(),
            group: meta.group.clone(),
            permissions: meta.permissions,
        })
    }

    /// realpath：规范化远端路径（"." 解析为会话 cwd）。
    pub async fn realpath(&self, path: &str) -> AppResult<String> {
        self.sftp.canonicalize(path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "realpath", "err": e.to_string() }),
            )
        })
    }

    /// 修改远端文件权限位（chmod）。只设 `permissions`，其余字段全 `None`：
    /// russh-sftp 的 `FileAttributes::default()` 会填 size/uid/gid/times，
    /// 直接 setstat 会把这些元数据一并覆盖、破坏文件。这里手动构造最小 attrs。
    pub async fn chmod(&self, path: &str, mode: u32) -> AppResult<()> {
        let attrs = russh_sftp::protocol::FileAttributes {
            size: None,
            uid: None,
            user: None,
            gid: None,
            group: None,
            permissions: Some(mode),
            atime: None,
            mtime: None,
        };
        self.sftp.set_metadata(path, attrs).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "chmod", "err": e.to_string() }),
            )
        })
    }

    /// Stream-download a remote file to a local path with a hard size cap.
    /// 优先用 metadata.size 早期 bail；metadata.size=None 或服务器撒谎时，
    /// 流式 cap 也会在超限的瞬间中止下载。
    ///
    /// 原子性：下载先写入 `<local_path>.part`，全部成功后 rename 到 local_path。
    /// 任何失败路径（size cap、IO error、metadata 错误）都会清理 .part，
    /// **不会污染 local_path**。无前端进度事件——AI 排障流程用。
    pub async fn download_to_path(
        &self,
        remote_path: &str,
        local_path: &Path,
        max_bytes: u64,
    ) -> AppResult<u64> {
        // 预检：metadata 已知大小且超限就早 bail，省一次 open。size=None
        // 时不能假装它是 0（之前的 unwrap_or(0) 会让任何"未声明大小"的文件
        // 直接绕过 max_bytes）—— 交给下面的 streaming cap 兜底。
        let meta = self.sftp.metadata(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "metadata", "err": e.to_string() }),
            )
        })?;
        if let Some(size) = meta.size {
            if size > max_bytes {
                return Err(AppError::sftp(
                    "sftp_file_too_large",
                    json!({ "path": remote_path, "size": size, "limit": max_bytes }),
                ));
            }
        }

        // tmp_path = "<local_path>.part"。用 with_file_name 保留目录前缀。
        let file_name = local_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "create", "err": "invalid local path" }),
                )
            })?;
        let tmp_path = local_path.with_file_name(format!("{file_name}.part"));
        let partial = PartialDownloadGuard::new(tmp_path.clone());
        let mut remote_file = self.sftp.open(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "open", "err": e.to_string() }),
            )
        })?;
        // `tokio::fs::File::create` runs on the blocking pool; dropping its
        // future cannot cancel an already-started create, so it could recreate
        // `.part` after the guard had removed it. The syscall is tiny: perform
        // it in this poll, then hand the open descriptor to Tokio for writes.
        let local_file = std::fs::File::create(&tmp_path)?;
        let mut local_file = tokio::fs::File::from_std(local_file);

        let mut transferred: u64 = 0;
        let mut buf = vec![0u8; 32768];
        loop {
            let n = remote_file.read(&mut buf).await.map_err(|e| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "read", "err": e.to_string() }),
                )
            })?;
            if n == 0 {
                break;
            }
            // 运行时 cap：metadata 缺失 / 撒谎 / 下载途中文件增长都靠这里兜底。
            // 这是 max_bytes 的唯一权威检查点，预检只是优化。
            let next = transferred + n as u64;
            if next > max_bytes {
                // 主动关闭 server-side handle，免得让远端 fd 等到 session drop 才回收。
                let _ = remote_file.shutdown().await;
                return Err(AppError::sftp(
                    "sftp_file_too_large",
                    json!({ "path": remote_path, "size": next, "limit": max_bytes }),
                ));
            }
            local_file.write_all(&buf[..n]).await?;
            transferred = next;
        }

        remote_file.shutdown().await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "close", "err": e.to_string() }),
            )
        })?;
        local_file.shutdown().await?;
        drop(local_file);
        partial.commit(local_path)?;
        Ok(transferred)
    }

    /// Stream-download a remote file to a local path, emitting progress events.
    ///
    /// `cancel` 是用户取消的旗子；streaming 循环每个 chunk 之间查一次。
    /// 命中即提前返回 `Sftp(CANCELLED_MSG)`，下游靠这条文本识别"取消"和"出错"。
    pub async fn download_streaming(
        &self,
        remote_path: &str,
        local_path: &Path,
        host: &crate::emitter::Host,
        transfer_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<u64> {
        // Get file size for progress
        let meta = self.sftp.metadata(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "metadata", "err": e.to_string() }),
            )
        })?;
        let total = meta.size.unwrap_or(0);

        let mut remote_file = self.sftp.open(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "open", "err": e.to_string() }),
            )
        })?;

        // For multi-select downloads, local_path may live inside a subdirectory
        // we haven't created yet (e.g. <pick_dir>/<root>/<subdir>/file.txt).
        // For a single-file download the parent already exists, so
        // create_dir_all is a no-op.
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Atomicity: write to `<local_path>.part` first; rename to final name
        // only on full success. Cancel / read-error / write-error all leave
        // only a partial `.part` (cleaned up below) — never a truncated file
        // sitting where users might pick it up. Mirrors `download_to_path`.
        let file_name = local_path
            .file_name()
            .ok_or_else(|| AppError::sftp("sftp_invalid_filename", json!({})))?
            .to_string_lossy()
            .into_owned();
        let tmp_path = local_path.with_file_name(format!("{file_name}.part"));

        let event = format!("sftp:progress:{transfer_id}");
        // 32KB 一块 × 大文件 = 每秒数百条事件；按 200ms 节流，首帧与 100% 必发。
        let throttle = ProgressThrottle::new();
        let result = async {
            let mut local_file = tokio::fs::File::create(&tmp_path).await?;
            stream_download(
                &mut remote_file,
                &mut local_file,
                |t| {
                    if throttle.should_emit(t, total) {
                        let _ = host.emit(
                            &event,
                            serde_json::json!({ "transferred": t, "total": total }),
                        );
                    }
                },
                &cancel,
            )
            .await
        }
        .await;
        match result {
            Ok(transferred) => {
                // Best-effort: remove any pre-existing destination so rename
                // doesn't fail on Windows (Unix rename overwrites silently).
                let _ = tokio::fs::remove_file(local_path).await;
                tokio::fs::rename(&tmp_path, local_path).await?;
                let _ = remote_file.shutdown().await.map_err(|e| {
                    AppError::sftp(
                        "sftp_io_failed",
                        json!({ "op": "close", "err": e.to_string() }),
                    )
                });
                Ok(transferred)
            }
            Err(e) => {
                // Best-effort cleanup; even if unlink fails we just leak `.part`.
                let _ = tokio::fs::remove_file(&tmp_path).await;
                Err(e)
            }
        }
    }

    /// Stream-download a remote file into a caller-supplied writer, with no
    /// local `.part`/rename step. Used on mobile, where the destination is a SAF
    /// `content://` handle that has no filesystem path to rename through — so we
    /// write the target directly (failure leaves a truncated file, as agreed).
    /// Desktop keeps the atomic `download_streaming` path above.
    pub async fn download_streaming_to_writer<W>(
        &self,
        remote_path: &str,
        dst: &mut W,
        host: &crate::emitter::Host,
        transfer_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<u64>
    where
        W: AsyncWrite + Unpin,
    {
        let meta = self.sftp.metadata(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "metadata", "err": e.to_string() }),
            )
        })?;
        let total = meta.size.unwrap_or(0);

        let mut remote_file = self.sftp.open(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "open", "err": e.to_string() }),
            )
        })?;

        let event = format!("sftp:progress:{transfer_id}");
        let throttle = ProgressThrottle::new();
        let transferred = stream_download(
            &mut remote_file,
            dst,
            |t| {
                if throttle.should_emit(t, total) {
                    let _ = host.emit(
                        &event,
                        serde_json::json!({ "transferred": t, "total": total }),
                    );
                }
            },
            &cancel,
        )
        .await?;
        let _ = remote_file.shutdown().await;
        Ok(transferred)
    }

    /// Remote `mkdir -p`: ensure every ancestor directory of `path` exists.
    ///
    /// Concurrency note: under MAX_CONCURRENT uploads several tasks may race
    /// to create the same shared subdirectory. We therefore *blindly attempt*
    /// `create_dir` per segment and, on failure, fall back to a metadata probe.
    /// If a directory is now present, treat it as success (a peer created it);
    /// otherwise propagate the original create error. This trades a few extra
    /// SFTP round-trips on the cold path for race-freeness — `mkdir_p` is
    /// already off the hot single-file path because callers short-circuit
    /// when the parent already exists.
    async fn mkdir_p(&self, path: &str) -> AppResult<()> {
        if path.is_empty() || path == "/" {
            return Ok(());
        }
        if let Ok(meta) = self.sftp.metadata(path).await {
            // A non-directory occupying the target path would cause obscure
            // failures later when the upload tries to write under it.
            if !meta.is_dir() {
                return Err(AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "mkdir_p", "path": path, "err": "path exists but is not a directory" }),
                ));
            }
            return Ok(());
        }
        let mut current = String::new();
        for part in path.split('/').filter(|s| !s.is_empty()) {
            current.push('/');
            current.push_str(part);
            if let Err(create_err) = self.sftp.create_dir(&current).await {
                // Race-safe fallback: verify a directory now exists.
                match self.sftp.metadata(&current).await {
                    Ok(meta) if meta.is_dir() => {} // created by a concurrent peer
                    _ => {
                        return Err(AppError::sftp(
                            "sftp_io_failed",
                            json!({ "op": "mkdir_p", "path": &current, "err": create_err.to_string() }),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Stream-upload from a caller-supplied reader to a remote path, emitting
    /// progress. The local end is just a reader, so desktop (a file path) and
    /// mobile (a SAF `content://` handle) share this one path — only how the
    /// caller opens the reader differs. `total` is the source size for progress
    /// (0 if unknown).
    ///
    /// Atomicity (remote-side, platform-independent): stream to
    /// `<remote_path>.part`, then rename on full success. Cancel / read-error /
    /// write-error leave only a partial `.part` (cleaned up below) — never a
    /// truncated file at the real path, and never a *destroyed* pre-existing
    /// remote file (raw `create(remote_path)` truncates the target the instant
    /// it opens, so a mid-transfer failure on an overwrite lost the original
    /// irrecoverably).
    pub async fn upload_streaming<R>(
        &self,
        reader: &mut R,
        total: u64,
        remote_path: &str,
        host: &crate::emitter::Host,
        transfer_id: &str,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<u64>
    where
        R: AsyncRead + Unpin,
    {
        // When uploading a folder via multi-select, remote_path may live in a
        // remote subdirectory we haven't created yet. For a single-file upload
        // the parent already exists, so mkdir_p hits the hot-path early return.
        if let Some((parent, _)) = remote_path.rsplit_once('/') {
            if !parent.is_empty() {
                self.mkdir_p(parent).await?;
            }
        }

        let tmp_path = format!("{remote_path}.part");
        let event = format!("sftp:progress:{transfer_id}");
        let throttle = ProgressThrottle::new();
        let result = async {
            let mut remote_file = self.sftp.create(&tmp_path).await.map_err(|e| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "create", "err": e.to_string() }),
                )
            })?;
            let n = stream_upload(
                reader,
                &mut remote_file,
                |t| {
                    if throttle.should_emit(t, total) {
                        let _ = host.emit(
                            &event,
                            serde_json::json!({ "transferred": t, "total": total }),
                        );
                    }
                },
                &cancel,
            )
            .await?;
            remote_file.shutdown().await.map_err(|e| {
                AppError::sftp(
                    "sftp_io_failed",
                    json!({ "op": "close", "err": e.to_string() }),
                )
            })?;
            Ok(n)
        }
        .await;

        match result {
            Ok(transferred) => {
                // SFTP rename fails on many servers if the destination exists, so
                // remove the old file first (best-effort — an absent target, the
                // common create-new case, is fine to ignore).
                let _ = self.sftp.remove_file(remote_path).await;
                self.sftp
                    .rename(&tmp_path, remote_path)
                    .await
                    .map_err(|e| {
                        AppError::sftp(
                            "sftp_io_failed",
                            json!({ "op": "rename", "err": e.to_string() }),
                        )
                    })?;
                Ok(transferred)
            }
            Err(e) => {
                // Best-effort cleanup; even if unlink fails we just leak `.part`.
                let _ = self.sftp.remove_file(&tmp_path).await;
                Err(e)
            }
        }
    }

    /// 远端文件的大小与 mtime（秒），用于断点续传前校验源是否变化。
    pub async fn remote_file_fingerprint(&self, remote_path: &str) -> AppResult<(u64, Option<i64>)> {
        let meta = self.sftp.metadata(remote_path).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "metadata", "err": e.to_string() }),
            )
        })?;
        Ok((meta.size.unwrap_or(0), meta.mtime.map(|v| v as i64)))
    }

    /// 删除远端 `.part` 断点文件（取消 / 冲突重开时使用）。
    pub async fn remove_remote_partial(&self, remote_path: &str) {
        let _ = self.sftp.remove_file(format!("{remote_path}.part")).await;
    }

    /// 断点续传上传：从 `start_offset` 续写远端 `.part`，多句柄流水线并发。
    ///
    /// `checkpoint` 在每批成功后更新为「连续已写入的绝对偏移」，暂停/取消时
    /// 调用方读取该值即可精确续传；绝不重新 create+truncate（除首传偏移 0）。
    pub async fn upload_streaming_resumable<R>(
        &self,
        reader: &mut R,
        total: u64,
        remote_path: &str,
        host: &crate::emitter::Host,
        transfer_id: &str,
        cancel: Arc<AtomicBool>,
        start_offset: u64,
        checkpoint: Arc<AtomicU64>,
    ) -> AppResult<u64>
    where
        R: AsyncRead + AsyncSeek + Unpin,
    {
        if let Some((parent, _)) = remote_path.rsplit_once('/') {
            if !parent.is_empty() {
                self.mkdir_p(parent).await?;
            }
        }
        let tmp_path = format!("{remote_path}.part");
        let event = format!("sftp:progress:{transfer_id}");
        let throttle = ProgressThrottle::new();

        reader.seek(SeekFrom::Start(start_offset)).await.map_err(|e| {
            AppError::sftp("sftp_io_failed", json!({ "op": "seek", "err": e.to_string() }))
        })?;

        let remaining = if total > 0 {
            total.saturating_sub(start_offset)
        } else {
            u64::MAX
        };
        let window = if total == 0 {
            PIPELINE_WINDOW
        } else {
            ((remaining as usize) / PIPELINE_CHUNK).clamp(1, PIPELINE_WINDOW)
        };

        // 固定句柄池 + 连续流水线：任何时刻最多 window 条写请求在途，完成一条
        // 立刻补下一条。之前是「整批栅栏」（join_all 等整批完成再发下一批），
        // 高延迟链路上每批都要等最慢的一块 + 本地读盘空窗，实测把 16×64KB 的
        // 并发窗口退化成接近串行（100MB 仅 12.8MB/s）。
        let mut pool: VecDeque<russh_sftp::client::fs::File> = VecDeque::with_capacity(window);
        for i in 0..window {
            let mut flags = OpenFlags::WRITE | OpenFlags::CREATE;
            if i == 0 && start_offset == 0 {
                flags |= OpenFlags::TRUNCATE;
            }
            let file = self.sftp.open_with_flags(&tmp_path, flags).await.map_err(|e| {
                AppError::sftp("sftp_io_failed", json!({ "op": "open", "err": e.to_string() }))
            })?;
            pool.push_back(file);
        }

        type WriteFuture = std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = (russh_sftp::client::fs::File, u64, u64, AppResult<()>),
                    > + Send,
            >,
        >;
        let mut inflight: FuturesUnordered<WriteFuture> = FuturesUnordered::new();
        let mut next_read = start_offset;
        let mut contig = start_offset;
        let mut done: std::collections::BTreeMap<u64, u64> = std::collections::BTreeMap::new();
        let mut eof = false;
        let mut cancelled = false;
        let mut first_err: Option<AppError> = None;

        loop {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
            }

            // 补满在途窗口：读一块 → 交给一个空闲句柄。
            while !cancelled && !eof && !pool.is_empty() {
                let left = if total > 0 {
                    total.saturating_sub(next_read)
                } else {
                    u64::MAX
                };
                if left == 0 {
                    eof = true;
                    break;
                }
                let want = left.min(PIPELINE_CHUNK as u64) as usize;
                let mut buf = vec![0u8; want];
                let mut filled = 0usize;
                while filled < want {
                    let n = reader.read(&mut buf[filled..]).await.map_err(|e| {
                        AppError::sftp(
                            "sftp_io_failed",
                            json!({ "op": "read_source", "err": e.to_string() }),
                        )
                    })?;
                    if n == 0 {
                        break;
                    }
                    filled += n;
                }
                if filled == 0 {
                    if total > 0 && next_read < total {
                        // 源文件在传输期间变短：不能静默续传。
                        first_err = Some(AppError::sftp(
                            "sftp_resume_source_changed",
                            json!({ "expected": total, "got": next_read }),
                        ));
                        cancelled = true;
                    }
                    eof = true;
                    break;
                }
                if total > 0 && filled < want && next_read + (filled as u64) < total {
                    first_err = Some(AppError::sftp(
                        "sftp_resume_source_changed",
                        json!({ "expected": total, "got": next_read + (filled as u64) }),
                    ));
                    cancelled = true;
                    break;
                }
                buf.truncate(filled);
                let mut f = pool.pop_front().expect("pool 非空由循环条件保证");
                let off = next_read;
                let len = filled as u64;
                next_read += len;
                inflight.push(Box::pin(async move {
                    let res = async {
                        f.seek(SeekFrom::Start(off)).await.map_err(|e| {
                            AppError::sftp(
                                "sftp_io_failed",
                                json!({ "op": "seek", "err": e.to_string() }),
                            )
                        })?;
                        f.write_all(&buf).await.map_err(|e| {
                            AppError::sftp(
                                "sftp_io_failed",
                                json!({ "op": "write", "err": e.to_string() }),
                            )
                        })
                    }
                    .await;
                    (f, off, len, res)
                }));
            }

            if inflight.is_empty() {
                break;
            }
            let Some((f, off, len, res)) = inflight.next().await else {
                break;
            };
            pool.push_back(f);
            if let Err(e) = res {
                if first_err.is_none() {
                    first_err = Some(e);
                }
                cancelled = true;
                continue;
            }
            if first_err.is_none() && !cancelled {
                // 检查点只推进「连续成功」前缀：乱序完成的块先记账，等前面的
                // 块也成功后再一起前移，避免续传偏移跳过失败的块。
                done.insert(off, len);
                while let Some(l) = done.remove(&contig) {
                    contig += l;
                }
                checkpoint.store(contig, Ordering::SeqCst);
                if throttle.should_emit(contig, total) {
                    let _ =
                        host.emit(&event, json!({ "transferred": contig, "total": total }));
                }
            }
        }

        for mut f in std::mem::take(&mut pool) {
            let _ = f.shutdown().await;
        }
        checkpoint.store(contig, Ordering::SeqCst);
        if let Some(e) = first_err {
            let _ = host.emit(&event, json!({ "transferred": contig, "total": total }));
            return Err(e);
        }
        if cancelled || cancel.load(Ordering::SeqCst) {
            return Err(AppError::sftp(CANCELLED_CODE, json!({})));
        }
        if total > 0 && contig < total {
            return Err(AppError::sftp(
                "sftp_resume_source_changed",
                json!({ "expected": total, "got": contig }),
            ));
        }

        let _ = self.sftp.remove_file(remote_path).await;
        self.sftp.rename(&tmp_path, remote_path).await.map_err(|e| {
            AppError::sftp("sftp_io_failed", json!({ "op": "rename", "err": e.to_string() }))
        })?;
        checkpoint.store(contig, Ordering::SeqCst);
        let _ = host.emit(
            &event,
            json!({ "transferred": contig, "total": if total > 0 { total } else { contig } }),
        );
        Ok(contig)
    }

    /// 断点续传下载：从 `start_offset` 续写本地 `.part`，多句柄流水线并发读。
    /// 本地 `.part` 长度必须与 `start_offset` 一致，否则返回明确错误而不是
    /// 静默覆盖（调用方负责重新开始）。
    pub async fn download_streaming_resumable(
        &self,
        remote_path: &str,
        dst: &mut tokio::fs::File,
        total: u64,
        host: &crate::emitter::Host,
        transfer_id: &str,
        cancel: Arc<AtomicBool>,
        start_offset: u64,
        checkpoint: Arc<AtomicU64>,
    ) -> AppResult<u64> {
        if total > 0 && start_offset > total {
            return Err(AppError::sftp(
                "sftp_resume_mismatch",
                json!({ "expected": total, "offset": start_offset }),
            ));
        }
        let local_len = dst
            .metadata()
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if start_offset == 0 {
            if local_len > 0 {
                dst.set_len(0).await.map_err(|e| {
                    AppError::sftp(
                        "sftp_io_failed",
                        json!({ "op": "truncate_local", "err": e.to_string() }),
                    )
                })?;
            }
        } else if local_len != start_offset {
            return Err(AppError::sftp(
                "sftp_resume_mismatch",
                json!({ "expected": start_offset, "actual": local_len }),
            ));
        }
        dst.seek(SeekFrom::Start(start_offset)).await.map_err(|e| {
            AppError::sftp("sftp_io_failed", json!({ "op": "seek_local", "err": e.to_string() }))
        })?;

        let remaining = if total > 0 {
            total.saturating_sub(start_offset)
        } else {
            u64::MAX
        };
        let window = if total == 0 {
            PIPELINE_WINDOW
        } else {
            ((remaining as usize) / PIPELINE_CHUNK).clamp(1, PIPELINE_WINDOW)
        };
        let mut pool: VecDeque<russh_sftp::client::fs::File> = VecDeque::with_capacity(window);
        for _ in 0..window {
            let file = self.sftp.open(remote_path).await.map_err(|e| {
                AppError::sftp("sftp_io_failed", json!({ "op": "open", "err": e.to_string() }))
            })?;
            pool.push_back(file);
        }

        let event = format!("sftp:progress:{transfer_id}");
        let throttle = ProgressThrottle::new();

        // 连续流水线读：保持 window 条读请求在途，完成即补；收到的块按偏移
        // 进重排缓冲，只按顺序落盘并推进 checkpoint。
        type ReadFuture = std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = (russh_sftp::client::fs::File, u64, usize, AppResult<Vec<u8>>),
                    > + Send,
            >,
        >;
        let mut inflight: FuturesUnordered<ReadFuture> = FuturesUnordered::new();
        let mut pending: std::collections::BTreeMap<u64, Vec<u8>> =
            std::collections::BTreeMap::new();
        let mut next_req = start_offset;
        let mut write_pos = start_offset;
        let mut eof = false;
        let mut cancelled = false;
        let mut first_err: Option<AppError> = None;

        loop {
            if cancel.load(Ordering::SeqCst) {
                cancelled = true;
            }
            while !cancelled && !eof && !pool.is_empty() {
                let left = if total > 0 {
                    total.saturating_sub(next_req)
                } else {
                    u64::MAX
                };
                if left == 0 {
                    eof = true;
                    break;
                }
                let want = left.min(PIPELINE_CHUNK as u64) as usize;
                let mut f = pool.pop_front().expect("pool 非空由循环条件保证");
                let off = next_req;
                next_req += want as u64;
                inflight.push(Box::pin(async move {
                    let res = async {
                        f.seek(SeekFrom::Start(off)).await.map_err(|e| {
                            AppError::sftp(
                                "sftp_io_failed",
                                json!({ "op": "seek", "err": e.to_string() }),
                            )
                        })?;
                        let mut buf = vec![0u8; want];
                        let mut filled = 0usize;
                        while filled < want {
                            let n = f.read(&mut buf[filled..]).await.map_err(|e| {
                                AppError::sftp(
                                    "sftp_io_failed",
                                    json!({ "op": "read", "err": e.to_string() }),
                                )
                            })?;
                            if n == 0 {
                                break;
                            }
                            filled += n;
                        }
                        buf.truncate(filled);
                        Ok(buf)
                    }
                    .await;
                    (f, off, want, res)
                }));
            }

            if inflight.is_empty() {
                break;
            }
            let Some((f, off, want, res)) = inflight.next().await else {
                break;
            };
            pool.push_back(f);
            match res {
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                    cancelled = true;
                }
                Ok(data) => {
                    if first_err.is_none() {
                        if total > 0 && data.len() < want {
                            // 远端在传输期间变短：明确报错，避免生成残缺文件。
                            first_err = Some(AppError::sftp(
                                "sftp_resume_source_changed",
                                json!({ "off": off, "want": want, "got": data.len() }),
                            ));
                            cancelled = true;
                        } else {
                            if data.is_empty() {
                                // 未知大小：读到 EOF。
                                eof = true;
                            } else {
                                pending.insert(off, data);
                            }
                        }
                    }
                    while let Some(chunk) = pending.remove(&write_pos) {
                        dst.write_all(&chunk).await.map_err(AppError::from)?;
                        write_pos += chunk.len() as u64;
                    }
                    checkpoint.store(write_pos, Ordering::SeqCst);
                    if throttle.should_emit(write_pos, total) {
                        let _ =
                            host.emit(&event, json!({ "transferred": write_pos, "total": total }));
                    }
                }
            }
        }

        let _ = dst.flush().await;
        for mut f in std::mem::take(&mut pool) {
            let _ = f.shutdown().await;
        }
        checkpoint.store(write_pos, Ordering::SeqCst);
        let _ = host.emit(&event, json!({ "transferred": write_pos, "total": total }));
        if let Some(e) = first_err {
            return Err(e);
        }
        if cancelled || cancel.load(Ordering::SeqCst) {
            return Err(AppError::sftp(CANCELLED_CODE, json!({})));
        }
        if total > 0 && write_pos < total {
            return Err(AppError::sftp(
                "sftp_resume_source_changed",
                json!({ "expected": total, "got": write_pos }),
            ));
        }
        Ok(write_pos)
    }
}

/// Pure download copy loop: read from `src` (remote), write to `dst` (local),
/// 32 KiB at a time. Reports cumulative bytes via `on_progress` and checks
/// `cancel` between chunks. No Tauri/Host dependency — progress is injected — so
/// it's unit-testable over in-memory `Cursor`/`Vec`. `read` errors are the
/// remote side (`sftp_io_failed` op:read); `write` errors are the local side
/// (bare IO error, e.g. disk full or a SAF `content://` write fault).
async fn stream_download<R, W>(
    src: &mut R,
    dst: &mut W,
    mut on_progress: impl FnMut(u64),
    cancel: &AtomicBool,
) -> AppResult<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut transferred: u64 = 0;
    let mut buf = vec![0u8; 32768];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::sftp(CANCELLED_CODE, json!({})));
        }
        let n = src.read(&mut buf).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "read", "err": e.to_string() }),
            )
        })?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        transferred += n as u64;
        on_progress(transferred);
    }
    Ok(transferred)
}

/// Pure upload copy loop: read from `src` (local), write to `dst` (remote).
/// Mirror of `stream_download` with the remote side on the write end, so the
/// error mapping is flipped: `read` errors are local (bare IO), `write` errors
/// are remote (`sftp_io_failed` op:write).
async fn stream_upload<R, W>(
    src: &mut R,
    dst: &mut W,
    mut on_progress: impl FnMut(u64),
    cancel: &AtomicBool,
) -> AppResult<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut transferred: u64 = 0;
    let mut buf = vec![0u8; 32768];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::sftp(CANCELLED_CODE, json!({})));
        }
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| {
            AppError::sftp(
                "sftp_io_failed",
                json!({ "op": "write", "err": e.to_string() }),
            )
        })?;
        transferred += n as u64;
        on_progress(transferred);
    }
    Ok(transferred)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn dropping_partial_download_removes_the_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let tmp_path = dir.path().join("artifact.part");
        std::fs::write(&tmp_path, b"partial").unwrap();

        {
            let _partial = PartialDownloadGuard::new(tmp_path.clone());
        }

        assert!(!tmp_path.exists());
    }

    #[test]
    fn committing_partial_download_replaces_the_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let local_path = dir.path().join("artifact");
        let tmp_path = dir.path().join("artifact.part");
        std::fs::write(&local_path, b"old").unwrap();
        std::fs::write(&tmp_path, b"new").unwrap();

        PartialDownloadGuard::new(tmp_path.clone())
            .commit(&local_path)
            .unwrap();

        assert_eq!(std::fs::read(&local_path).unwrap(), b"new");
        assert!(!tmp_path.exists());
    }

    /// Both copy loops must move every byte intact and report monotonic progress
    /// ending at the total. Driven over in-memory buffers — no SSH, no Tauri.
    #[tokio::test]
    async fn stream_download_copies_all_bytes_with_progress() {
        let data: Vec<u8> = (0..100_000u32).map(|i| i as u8).collect();
        let mut src = Cursor::new(data.clone());
        let mut dst: Vec<u8> = Vec::new();
        let mut ticks: Vec<u64> = Vec::new();
        let cancel = AtomicBool::new(false);
        let n = stream_download(&mut src, &mut dst, |t| ticks.push(t), &cancel)
            .await
            .unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(dst, data);
        assert_eq!(*ticks.last().unwrap(), data.len() as u64);
        assert!(ticks.windows(2).all(|w| w[0] < w[1]));
    }

    #[tokio::test]
    async fn stream_upload_copies_all_bytes_with_progress() {
        let data: Vec<u8> = (0..100_000u32).map(|i| (i * 7) as u8).collect();
        let mut src = Cursor::new(data.clone());
        let mut dst: Vec<u8> = Vec::new();
        let mut ticks: Vec<u64> = Vec::new();
        let cancel = AtomicBool::new(false);
        let n = stream_upload(&mut src, &mut dst, |t| ticks.push(t), &cancel)
            .await
            .unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(dst, data);
        assert_eq!(*ticks.last().unwrap(), data.len() as u64);
    }

    /// A pre-raised cancel flag must bail before writing a single byte, and the
    /// error must carry CANCELLED_CODE so the frontend can tell cancel from fault.
    #[tokio::test]
    async fn stream_download_cancels_before_writing() {
        let mut src = Cursor::new(vec![1u8; 100_000]);
        let mut dst: Vec<u8> = Vec::new();
        let cancel = AtomicBool::new(true);
        let err = stream_download(&mut src, &mut dst, |_| {}, &cancel)
            .await
            .unwrap_err();
        assert_eq!(err.code(), CANCELLED_CODE);
        assert!(dst.is_empty());
    }

    #[tokio::test]
    async fn stream_upload_cancels_before_writing() {
        let mut src = Cursor::new(vec![2u8; 100_000]);
        let mut dst: Vec<u8> = Vec::new();
        let cancel = AtomicBool::new(true);
        let err = stream_upload(&mut src, &mut dst, |_| {}, &cancel)
            .await
            .unwrap_err();
        assert_eq!(err.code(), CANCELLED_CODE);
        assert!(dst.is_empty());
    }
}
