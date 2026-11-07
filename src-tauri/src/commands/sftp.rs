use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::json;
use tauri::State;

use crate::error::{locked, AppError, AppResult};
use crate::models::{Credential, CredentialType};
use crate::ssh::sftp::{FileStat, RemoteEntry, SftpHandle, WalkEntry};
use crate::state::AppState;
use crate::state::{SessionKind, SessionOwner};

#[cfg(desktop)]
use tauri_plugin_dialog::{DialogExt, FilePath};

/// Maximum recursion depth for the local walker. Mirrors the remote-side cap.
const LOCAL_WALK_DEPTH_CAP: u32 = 32;

/// RAII：注册 cancel flag 并在 drop 时自动 unregister，无论 streaming 正常返回、
/// 早 `?`、还是 panic。替代旧的手写 register/unregister 配对。
pub struct CancelGuard<'a> {
    state: &'a AppState,
    transfer_id: String,
}

impl<'a> CancelGuard<'a> {
    /// 注册 flag。返回 (guard, flag)：guard 控生命周期，flag 喂给 streaming 函数。
    /// `pub` 让 headless server 复用同一套 RAII 清理（drop 时 unregister，覆盖
    /// 正常返回 / 早 `?` / panic 三种路径），避免手写 register/remove 漏删。
    pub fn register(
        state: &'a AppState,
        transfer_id: String,
    ) -> AppResult<(Self, Arc<AtomicBool>)> {
        let flag = Arc::new(AtomicBool::new(false));
        locked(&state.transfer_cancels)?.insert(transfer_id.clone(), flag.clone());
        Ok((Self { state, transfer_id }, flag))
    }
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut m) = locked(&self.state.transfer_cancels) {
            m.remove(&self.transfer_id);
        }
    }
}

#[tauri::command]
pub async fn sftp_connect(
    window: tauri::Window,
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    secret: Option<String>,
    // 档案 id：有则沿用该主机的代理配置（无 / 不同档案 = 直连）。
    profile_id: Option<String>,
) -> AppResult<String> {
    let reservation = crate::commands::lifecycle::reserve_generated_resource(
        &state,
        SessionKind::Sftp,
        SessionOwner::Window(window.label().to_owned()),
    )?;
    let id = reservation.id().to_owned();
    let cred = Credential {
        id: String::new(),
        name: String::new(),
        username,
        credential_type: CredentialType::from_str(&auth_type),
        secret,
        save_to_remote: false,
    };

    let timeout_secs: u64 = crate::db::settings::get(&state.db, "connect_timeout")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(crate::ssh::client::DEFAULT_CONNECT_TIMEOUT);

    let known_hosts_path = crate::ssh::known_hosts::path_for(&state.data_dir);
    // 独立 SFTP 连接同样要刷新主机密钥校验策略（否则会残留终端连接的取值）。
    crate::commands::session::apply_ssh_runtime_settings(&state)?;
    let proxy = match profile_id.as_deref() {
        Some(pid) => {
            let profile = crate::db::profile::get(&state.db, pid)?;
            crate::commands::session::resolve_proxy_configs(&state, &[&profile])?
                .get(pid)
                .cloned()
        }
        None => None,
    };
    // 独立 SFTP 也要按主机的 known-host 策略；无档案 id 时跟随全局。
    let host_key_policy = match profile_id.as_deref() {
        Some(pid) => crate::db::profile::get(&state.db, pid)?.host_key_policy,
        None => None,
    };
    let handle = crate::ssh::client::run_blocking_ssh(move || async move {
        SftpHandle::connect(
            host,
            port,
            cred,
            known_hosts_path,
            timeout_secs,
            proxy,
            host_key_policy,
        )
        .await
    })
    .await?;
    reservation.activate(crate::commands::lifecycle::ReadySession::Sftp(Arc::new(
        handle,
    )))?;

    Ok(id)
}

/// Connect SFTP by reusing an active SSH session (no re-authentication).
#[tauri::command]
pub async fn sftp_connect_session(
    window: tauri::Window,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<String> {
    let (reservation, ssh_handle) = crate::commands::lifecycle::reserve_sftp_child(
        &state,
        &session_id,
        &SessionOwner::Window(window.label().to_owned()),
    )?;
    let id = reservation.id().to_owned();

    let parent = session_id.clone();
    let handle = crate::ssh::client::run_blocking_ssh(move || async move {
        SftpHandle::from_handle(&ssh_handle, parent).await
    })
    .await?;
    reservation.activate(crate::commands::lifecycle::ReadySession::Sftp(Arc::new(
        handle,
    )))?;

    Ok(id)
}

/// 从 Mutex 中 clone 出 Arc<SftpHandle>，释放锁后再 await。
fn get_sftp(state: &State<'_, AppState>, sftp_id: &str) -> AppResult<Arc<SftpHandle>> {
    locked(&state.sftp_sessions)?
        .get(sftp_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("sftp_session_not_found", json!({})))
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, sftp_id: String) -> AppResult<String> {
    let h = get_sftp(&state, &sftp_id)?;
    h.home_dir().await
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<Vec<RemoteEntry>> {
    let h = get_sftp(&state, &sftp_id)?;
    h.list_dir(&path).await
}

/// Recursively list every file under a remote directory (symlink-to-file is
/// followed, symlink-to-dir is skipped to prevent cycles). The frontend queues
/// each returned entry as an independent Transfer; the directory abstraction
/// exists only inside this command.
#[tauri::command]
pub async fn sftp_walk_remote_dir(
    state: State<'_, AppState>,
    sftp_id: String,
    remote_root: String,
) -> AppResult<Vec<WalkEntry>> {
    let h = get_sftp(&state, &sftp_id)?;
    h.walk_files(&remote_root).await
}

/// Recursively list every file under a local directory; the local-side
/// counterpart of `sftp_walk_remote_dir`. `rel_path` always uses '/'; the
/// frontend swaps the separator when rebuilding the local physical path.
#[tauri::command]
pub async fn walk_local_dir(local_root: String) -> AppResult<Vec<WalkEntry>> {
    let root = PathBuf::from(&local_root);
    let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
    queue.push_back((root.clone(), 0));
    let mut result: Vec<WalkEntry> = Vec::new();

    while let Some((dir, depth)) = queue.pop_front() {
        if depth >= LOCAL_WALK_DEPTH_CAP {
            return Err(AppError::other(
                "local_tree_too_deep",
                json!({
                    "path": dir.display().to_string(),
                    "depth": depth,
                    "limit": LOCAL_WALK_DEPTH_CAP,
                }),
            ));
        }
        let mut rd = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = rd.next_entry().await? {
            // `entry.metadata()` does not traverse symlinks — single syscall
            // covers both type discrimination and size for regular files,
            // replacing the previous file_type() + metadata() double-stat.
            let path = entry.path();
            let rel = rel_unix(&path, &root);
            let meta = entry.metadata().await?;
            if meta.is_dir() {
                result.push(WalkEntry {
                    rel_path: rel,
                    size: 0,
                    is_dir: true,
                });
                queue.push_back((path, depth + 1));
            } else if meta.is_file() {
                result.push(WalkEntry {
                    rel_path: rel,
                    size: meta.len(),
                    is_dir: false,
                });
            } else if meta.is_symlink() {
                // Follow once to learn what the target is. Skip symlink-to-dir
                // to avoid cycles, and silently skip broken symlinks.
                if let Ok(target_meta) = tokio::fs::metadata(&path).await {
                    if target_meta.is_file() {
                        result.push(WalkEntry {
                            rel_path: rel,
                            size: target_meta.len(),
                            is_dir: false,
                        });
                    }
                }
            }
            // Anything else (block/char/fifo): skip.
        }
    }
    Ok(result)
}

/// Convert the portion of `full` relative to `root` into a '/'-separated string.
/// On Windows std::path::Component uses '\'; we normalise here and the frontend
/// converts back to the platform separator when joining.
fn rel_unix(full: &Path, root: &Path) -> String {
    let stripped = full.strip_prefix(root).unwrap_or(full);
    stripped
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// 读远端文件到内存（`Vec<u8>` → 前端 number[]）。仅供 headless / CLI 的
/// 小文件读取；桌面前端大文件一律走流式 `sftp_download_to`（避免 IPC 4× 膨胀）。
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<Vec<u8>> {
    let h = get_sftp(&state, &sftp_id)?;
    h.download(&path).await
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    data: Vec<u8>,
) -> AppResult<()> {
    let h = get_sftp(&state, &sftp_id)?;
    h.upload(&path, &data).await
}

/// 内置编辑器整体读取的缺省上限：10 MiB（对齐 Netcatty
/// `MAX_BUILTIN_SFTP_EDITOR_BYTES`）。与 `local_read_file` 的 16 MiB 尾部读
/// 不同：编辑器要的是**全文**而非预览尾部，超限直接拒绝而不是截断。
pub const DEFAULT_EDITOR_READ_CAP: u64 = 10 << 20;

/// 编辑器读取尺寸预检（纯逻辑，可单测）：声明大小超过上限即拒绝。
/// `pub` 供 headless server dispatcher 复用同一预检（双注册一致语义）。
pub fn editor_size_guard(size: u64, cap: u64, path: &str) -> AppResult<()> {
    if size > cap {
        return Err(AppError::sftp(
            "sftp_file_too_large",
            json!({ "path": path, "size": size, "limit": cap }),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod editor_size_guard_tests {
    use super::*;

    #[test]
    fn allows_size_at_or_below_cap() {
        assert!(editor_size_guard(0, DEFAULT_EDITOR_READ_CAP, "/a").is_ok());
        assert!(editor_size_guard(DEFAULT_EDITOR_READ_CAP, DEFAULT_EDITOR_READ_CAP, "/a").is_ok());
    }

    #[test]
    fn rejects_size_above_cap_with_params() {
        let err = editor_size_guard(DEFAULT_EDITOR_READ_CAP + 1, DEFAULT_EDITOR_READ_CAP, "/big")
            .unwrap_err();
        assert_eq!(err.code(), "sftp_file_too_large");
    }

    #[test]
    fn custom_cap_is_honored() {
        assert!(editor_size_guard(10, 8, "/a").is_err());
        assert!(editor_size_guard(8, 8, "/a").is_ok());
    }
}

/// 为内置编辑器整体读取远端文件（全文，非尾部截断）。先 stat 预检大小，
/// 读后再兜底校验一次（防 stat 与实际读取之间的竞态增长）。
/// `max_bytes` 缺省 `DEFAULT_EDITOR_READ_CAP`。
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> AppResult<Vec<u8>> {
    let h = get_sftp(&state, &sftp_id)?;
    let cap = max_bytes.unwrap_or(DEFAULT_EDITOR_READ_CAP);
    let st = h.stat(&path).await?;
    editor_size_guard(st.size, cap, &path)?;
    let data = h.download(&path).await?;
    editor_size_guard(data.len() as u64, cap, &path)?;
    Ok(data)
}

/// 内置编辑器保存回写：整体覆盖远端文件（对应 Netcatty `writeTextFile`）。
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    data: Vec<u8>,
) -> AppResult<()> {
    let h = get_sftp(&state, &sftp_id)?;
    h.upload(&path, &data).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<()> {
    let h = get_sftp(&state, &sftp_id)?;
    h.mkdir(&path).await
}

#[tauri::command]
pub async fn sftp_close(
    window: tauri::Window,
    state: State<'_, AppState>,
    sftp_id: String,
) -> AppResult<()> {
    crate::commands::lifecycle::close_resource(
        &state,
        &sftp_id,
        SessionKind::Sftp,
        &SessionOwner::Window(window.label().to_owned()),
    )?;
    // 断开后立刻广播队列快照：前端用 `session_live` 渲染「会话离线」并禁用
    // 恢复/重试，不能等下一次入队或队列操作把 handle 缓存刷新后才更新。
    if let Ok(snapshot) = crate::sftp::transfer_center::refreshed_snapshot(&state) {
        use tauri::{Emitter as _, Manager as _};
        let _ = window.app_handle().emit("sftp:queue_changed", snapshot);
    }
    Ok(())
}

/// dialog plugin 的 FilePath → 本地 PathBuf。这里的命令仅在桌面注册，
/// 所以 dialog 总返回真实路径，移动端 URI 不会出现在这里。
#[cfg(desktop)]
fn dialog_to_path(fp: FilePath) -> AppResult<PathBuf> {
    fp.into_path()
        .map_err(|e| AppError::other("file_path_invalid", json!({ "err": e.to_string() })))
}

/// `spawn_blocking` 的 JoinError → AppError。
#[cfg(desktop)]
fn dialog_join_err(e: tokio::task::JoinError) -> AppError {
    AppError::other("dialog_task_failed", json!({ "err": e.to_string() }))
}

/// Download a remote file via native Save As dialog with streaming + progress.
#[cfg(desktop)]
#[tauri::command]
pub async fn sftp_save_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
    default_name: String,
) -> AppResult<Option<String>> {
    let dialog_app = app.clone();
    let picked = tokio::task::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(&default_name)
            .blocking_save_file()
    })
    .await
    .map_err(dialog_join_err)?;
    let Some(fp) = picked else { return Ok(None) };
    let local = dialog_to_path(fp)?;

    let sftp = get_sftp(&state, &sftp_id)?;
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let (_guard, cancel) = CancelGuard::register(&state, transfer_id.clone())?;
    let host = crate::emitter::Host::Tauri(app);
    sftp.download_streaming(&remote_path, &local, &host, &transfer_id, cancel)
        .await?;
    Ok(Some(local.display().to_string()))
}

/// Pick a local file via native Open dialog and upload with streaming + progress.
#[cfg(desktop)]
#[tauri::command]
pub async fn sftp_pick_and_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remote_dir: String,
) -> AppResult<Option<String>> {
    let dialog_app = app.clone();
    let picked =
        tokio::task::spawn_blocking(move || dialog_app.dialog().file().blocking_pick_file())
            .await
            .map_err(dialog_join_err)?;
    let Some(fp) = picked else { return Ok(None) };
    let local = dialog_to_path(fp)?;

    let name = local
        .file_name()
        .ok_or_else(|| AppError::other("sftp_invalid_filename", json!({})))?
        .to_string_lossy()
        .into_owned();
    let remote_path = if remote_dir == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), name)
    };

    let sftp = get_sftp(&state, &sftp_id)?;
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let (_guard, cancel) = CancelGuard::register(&state, transfer_id.clone())?;
    let host = crate::emitter::Host::Tauri(app);
    let mut reader = tokio::fs::File::open(&local).await?;
    let total = reader.metadata().await?.len();
    sftp.upload_streaming(
        &mut reader,
        total,
        &remote_path,
        &host,
        &transfer_id,
        cancel,
    )
    .await?;
    Ok(Some(name))
}

/// Open native Save-As dialog and return the chosen path. No transfer happens here.
#[cfg(desktop)]
#[tauri::command]
pub async fn sftp_pick_save_path(
    app: tauri::AppHandle,
    default_name: String,
) -> AppResult<Option<String>> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&default_name)
            .blocking_save_file()
    })
    .await
    .map_err(dialog_join_err)?;
    match picked {
        Some(fp) => Ok(Some(dialog_to_path(fp)?.display().to_string())),
        None => Ok(None),
    }
}

/// Open native Open dialog and return the chosen path. No transfer happens here.
#[cfg(desktop)]
#[tauri::command]
pub async fn sftp_pick_open_path(app: tauri::AppHandle) -> AppResult<Option<String>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_file())
        .await
        .map_err(dialog_join_err)?;
    match picked {
        Some(fp) => Ok(Some(dialog_to_path(fp)?.display().to_string())),
        None => Ok(None),
    }
}

/// Pick a folder via the native dialog. Used both as the destination root
/// (multi-select download) and the source root (recursive upload) — both
/// flows want the same `blocking_pick_folder()` call, so a single command suffices.
#[cfg(desktop)]
#[tauri::command]
pub async fn sftp_pick_folder(app: tauri::AppHandle) -> AppResult<Option<String>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(dialog_join_err)?;
    match picked {
        Some(fp) => Ok(Some(dialog_to_path(fp)?.display().to_string())),
        None => Ok(None),
    }
}

/// Pick multiple source files for upload. `blocking_pick_files` supports
/// multi-selection on every desktop platform we ship to.
#[cfg(desktop)]
#[tauri::command]
pub async fn sftp_pick_open_files(app: tauri::AppHandle) -> AppResult<Option<Vec<String>>> {
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_files())
        .await
        .map_err(dialog_join_err)?;
    let Some(fps) = picked else { return Ok(None) };
    let paths = fps
        .into_iter()
        .map(|fp| dialog_to_path(fp).map(|p| p.display().to_string()))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Some(paths))
}

/// `sftp_io_failed` for a local open failure — same code/i18n as other SFTP IO.
fn open_err(e: std::io::Error) -> AppError {
    AppError::sftp(
        "sftp_io_failed",
        json!({ "op": "open", "err": e.to_string() }),
    )
}

/// Keeps an iOS security-scoped file URL active for exactly as long as the
/// transfer owns its file handle. Other platforms need no matching release.
struct FileAccessGuard {
    #[cfg(target_os = "ios")]
    app: tauri::AppHandle,
    #[cfg(target_os = "ios")]
    path: Option<tauri_plugin_fs::FilePath>,
}

impl FileAccessGuard {
    fn new(app: &tauri::AppHandle, path: &tauri_plugin_fs::FilePath) -> Self {
        #[cfg(target_os = "ios")]
        {
            let path = match path {
                tauri_plugin_fs::FilePath::Url(url) if url.scheme() == "file" => Some(path.clone()),
                _ => None,
            };
            Self {
                app: app.clone(),
                path,
            }
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = (app, path);
            Self {}
        }
    }
}

impl Drop for FileAccessGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "ios")]
        if let Some(path) = self.path.take() {
            use tauri_plugin_fs::FsExt;
            if let Err(e) = self.app.fs().stop_accessing_security_scoped_resource(path) {
                log::warn!("failed to release iOS security-scoped file: {e}");
            }
        }
    }
}

/// Resolve a desktop path, Android content URI, or iOS security-scoped file URL
/// to a real file. The guard must live until the file handle is dropped.
fn fs_open_read(
    app: &tauri::AppHandle,
    fp: tauri_plugin_fs::FilePath,
) -> AppResult<(std::fs::File, FileAccessGuard)> {
    use tauri_plugin_fs::{FsExt, OpenOptions};
    let mut opts = OpenOptions::new();
    opts.read(true);
    let access = FileAccessGuard::new(app, &fp);
    let file = app.fs().open(fp, opts).map_err(open_err)?;
    Ok((file, access))
}

/// Same as [`fs_open_read`] but opens (create + truncate) for writing — the
/// mobile download target.
fn fs_open_write(
    app: &tauri::AppHandle,
    fp: tauri_plugin_fs::FilePath,
) -> AppResult<(std::fs::File, FileAccessGuard)> {
    use tauri_plugin_fs::{FsExt, OpenOptions};
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    let access = FileAccessGuard::new(app, &fp);
    let file = app.fs().open(fp, opts).map_err(open_err)?;
    Ok((file, access))
}

/// Stream-download to a caller-supplied local target. transfer_id is used as the
/// `sftp:progress:{transfer_id}` event suffix (R1) so the frontend listens
/// per-transfer instead of multiplexing one global stream.
#[tauri::command]
pub async fn sftp_download_to(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> AppResult<()> {
    let sftp = get_sftp(&state, &sftp_id)?;
    let (_guard, cancel) = CancelGuard::register(&state, transfer_id.clone())?;
    let host = crate::emitter::Host::Tauri(app.clone());
    // Desktop sends a filesystem path → keep the atomic `.part` + rename.
    // Mobile sends a SAF `content://` URI → open it through plugin-fs (which
    // resolves the URI to a real fd) and stream straight in. There's no path to
    // rename through on mobile, so that download has no local atomicity (agreed).
    match local_path
        .parse::<tauri_plugin_fs::FilePath>()
        .expect("FilePath::from_str is infallible")
    {
        tauri_plugin_fs::FilePath::Path(p) => sftp
            .download_streaming(&remote_path, &p, &host, &transfer_id, cancel)
            .await
            .map(|_| ()),
        fp @ tauri_plugin_fs::FilePath::Url(_) => {
            let (dst, _access) = fs_open_write(&app, fp)?;
            let mut dst = tokio::fs::File::from_std(dst);
            sftp.download_streaming_to_writer(&remote_path, &mut dst, &host, &transfer_id, cancel)
                .await
                .map(|_| ())
        }
    }
}

/// Stream-upload from a caller-supplied local source. transfer_id mirrors above.
#[tauri::command]
pub async fn sftp_upload_from(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> AppResult<()> {
    let sftp = get_sftp(&state, &sftp_id)?;
    let (_guard, cancel) = CancelGuard::register(&state, transfer_id.clone())?;
    let host = crate::emitter::Host::Tauri(app.clone());
    // Local end is just a reader, so desktop (path) and mobile (content:// URI)
    // share one path — plugin-fs resolves either to a real fd.
    let fp = local_path
        .parse::<tauri_plugin_fs::FilePath>()
        .expect("FilePath::from_str is infallible");
    let (reader, _access) = fs_open_read(&app, fp)?;
    let mut reader = tokio::fs::File::from_std(reader);
    // content:// fds may not support fstat; fall back to 0 (indeterminate bar).
    let total = reader.metadata().await.map(|m| m.len()).unwrap_or(0);
    sftp.upload_streaming(
        &mut reader,
        total,
        &remote_path,
        &host,
        &transfer_id,
        cancel,
    )
    .await
    .map(|_| ())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<()> {
    let h = get_sftp(&state, &sftp_id)?;
    h.remove(&path).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    sftp_id: String,
    old_path: String,
    new_path: String,
) -> AppResult<()> {
    let h = get_sftp(&state, &sftp_id)?;
    h.rename(&old_path, &new_path).await
}

/// 远端归档原地解压（#24）。命令构造见 [`crate::sftp::archive`]；
/// 需要父 SSH 会话提供 exec 通道，独立 SFTP 连接（`parent_ssh_id=None`）拒绝。
pub(crate) async fn extract_archive(
    state: &AppState,
    handle: &Arc<SftpHandle>,
    path: &str,
) -> AppResult<crate::models::PluginExecResult> {
    let size = handle.stat(path).await.map(|s| s.size).unwrap_or(0);
    let parent_id = handle
        .parent_ssh_id()
        .map(str::to_owned)
        .ok_or_else(|| AppError::sftp("sftp_extract_no_ssh", json!({})))?;
    let ssh = {
        let sessions = locked(&state.sessions)?;
        sessions.get(&parent_id).map(|s| s.ssh_handle().clone())
    };
    let Some(ssh) = ssh else {
        return Err(AppError::sftp("sftp_extract_no_ssh", json!({})));
    };
    let command = crate::sftp::archive::build_extract_command(path)?;
    let timeout = crate::sftp::archive::compute_timeout(size);
    let result = crate::ssh::client::run_blocking_ssh(move || async move {
        crate::ssh::client::exec_once(&ssh, &command, timeout, false).await
    })
    .await?;
    if result.exit_code != Some(0) {
        let stderr: String = result.stderr.chars().take(400).collect();
        return Err(AppError::sftp(
            "sftp_extract_failed",
            json!({ "exitCode": result.exit_code, "stderr": stderr }),
        ));
    }
    Ok(result)
}

#[tauri::command]
pub async fn sftp_extract_archive(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<crate::models::PluginExecResult> {
    let handle = get_sftp(&state, &sftp_id)?;
    extract_archive(&state, &handle, &path).await
}

/// 同主机复制单个文件（远端读 → 远端写），返回写入字节数。
#[tauri::command]
pub async fn sftp_copy(
    state: State<'_, AppState>,
    sftp_id: String,
    src_path: String,
    dst_path: String,
) -> AppResult<u64> {
    let h = get_sftp(&state, &sftp_id)?;
    h.copy_file(&src_path, &dst_path).await
}

#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<FileStat> {
    let h = get_sftp(&state, &sftp_id)?;
    h.stat(&path).await
}

#[tauri::command]
pub async fn sftp_lstat(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<FileStat> {
    let h = get_sftp(&state, &sftp_id)?;
    h.lstat(&path).await
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<String> {
    let h = get_sftp(&state, &sftp_id)?;
    h.realpath(&path).await
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    mode: u32,
) -> AppResult<()> {
    let h = get_sftp(&state, &sftp_id)?;
    h.chmod(&path, mode).await
}

/// 用户在传输页点"取消"调用：把 transfer_id 对应的 cancel flag 置 1，
/// streaming 循环下一次 chunk 检查时退出。
#[tauri::command]
pub fn sftp_cancel_transfer(state: State<'_, AppState>, transfer_id: String) -> AppResult<()> {
    use std::sync::atomic::Ordering;
    if let Some(flag) = locked(&state.transfer_cancels)?.get(&transfer_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// 编辑器二进制采样判定（镜像前端 editorFile.looksBinary 语义）：
/// 头部 8 KiB 内出现 NUL 即判二进制。仅测试链路使用（生产判定在前端），
/// 故 cfg(test) 避免 dead_code 告警。
#[cfg(test)]
pub fn looks_binary(data: &[u8]) -> bool {
    const SAMPLE: usize = 8 * 1024;
    data[..data.len().min(SAMPLE)].contains(&0)
}

#[cfg(test)]
mod looks_binary_tests {
    use super::*;

    #[test]
    fn text_is_not_binary() {
        assert!(!looks_binary(b"hello world\n"));
        assert!(!looks_binary(&[]));
    }

    #[test]
    fn nul_within_sample_is_binary() {
        assert!(looks_binary(&[b'a', 0, b'b']));
    }

    #[test]
    fn nul_beyond_sample_window_is_ignored() {
        let mut v = vec![b'a'; 8 * 1024 + 16];
        *v.last_mut().unwrap() = 0;
        assert!(!looks_binary(&v));
    }
}

/// 「下载到临时目录并外部打开」的上限：100 MiB（整体进内存后落盘，
/// 防超大文件打爆内存）。超限复用 `sftp_file_too_large` 文案。
pub const EXTERNAL_OPEN_CAP: u64 = 100 << 20;

/// 用外部（系统默认）编辑器打开远端文件：下载到临时目录后用系统默认程序
/// 打开（Netcatty downloadToTempAndOpen 等价物）。返回临时文件路径，
/// 前端记录供后续「保存后回传」或提示。
#[tauri::command]
pub async fn sftp_open_external(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<String> {
    let h = get_sftp(&state, &sftp_id)?;
    let st = h.stat(&path).await?;
    editor_size_guard(st.size, EXTERNAL_OPEN_CAP, &path)?;
    let data = h.download(&path).await?;
    editor_size_guard(data.len() as u64, EXTERNAL_OPEN_CAP, &path)?;
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "remote_file".into());
    let temp = crate::commands::localfs::external_temp_path(&name);
    if let Some(parent) = temp.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&temp, &data).await?;
    crate::commands::localfs::open_with_system(&temp).map_err(|e| {
        AppError::other(
            "local_io_failed",
            json!({ "op": "open", "path": temp.display().to_string(), "err": e.to_string() }),
        )
    })?;
    Ok(temp.display().to_string())
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::sftp::transfer_center as tc;
    use crate::sftp::transfer_center::{ConflictAction, Direction, NewTransfer, Status};
    use russh::ChannelMsg;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    /// 真实远端主机的文件操作全链路（默认档案 "129"）：
    /// 连接 → mkdir → upload → list/stat → rename → chmod → download 比对 → remove → rmdir。
    /// 仅当 TERMX_SFTP_LIVE=1 时运行：依赖真实网络 + 本机 keychain（读取与应用相同的
    /// ~/.termX DB / SecretStore 凭据），不纳入默认 `cargo test --lib` 门禁。
    #[tokio::test]
    async fn live_sftp_file_ops_roundtrip() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let name = std::env::var("TERMX_SFTP_LIVE_PROFILE").unwrap_or_else(|_| "129".into());
        let data_dir = dirs::home_dir().expect("home dir").join(".termX");
        let db = Arc::new(crate::db::Db::open(&data_dir).expect("open ~/.termX db"));
        let secrets = crate::secret::open(db.clone(), &data_dir).expect("open secret store");

        let profile = crate::db::profile::list(&db)
            .expect("list profiles")
            .into_iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("profile {name} not found"));
        let cred_row =
            crate::db::credential::get(&db, &profile.credential_id).expect("get credential");
        let secret = secrets
            .store
            .get(&crate::secret::cred_secret_key(&cred_row.id))
            .expect("decrypt credential secret");
        let cred = Credential { secret, ..cred_row };

        let known_hosts = crate::ssh::known_hosts::path_for(&data_dir);
        let handle = SftpHandle::connect(
            profile.host,
            profile.port,
            cred,
            known_hosts,
            15,
            None,
            profile.host_key_policy.clone(),
        )
                .await
                .expect("sftp connect");

        let (host, _rx) = crate::ssh::test_support::headless_host();
        let dir = format!("/tmp/termx-live-{}", std::process::id());
        let a = format!("{dir}/a.txt");
        let b = format!("{dir}/b.txt");
        let payload = b"termx live sftp roundtrip";

        handle.mkdir(&dir).await.expect("mkdir");
        // 走生产流式上传路径（sftp_upload_from 同款）；引擎的 upload() = sftp.write
        // 对不存在的目标文件报 No such file（疑似 russh write 未带 CREATE），
        // 本链路不用它，发现已记入 changelogs。
        let mut reader: &[u8] = payload;
        let up_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        handle
            .upload_streaming(&mut reader, payload.len() as u64, &a, &host, "live-up", up_cancel)
            .await
            .expect("upload");
        let entries = handle.list_dir(&dir).await.expect("list");
        assert!(entries.iter().any(|e| e.name == "a.txt"), "list after upload");
        let st = handle.stat(&a).await.expect("stat");
        assert_eq!(st.size, payload.len() as u64);

        handle.rename(&a, &b).await.expect("rename");
        handle.chmod(&b, 0o640).await.expect("chmod");
        let st2 = handle.lstat(&b).await.expect("lstat");
        assert_eq!(st2.permissions.unwrap_or(0) & 0o777, 0o640, "chmod persisted");

        let tmp = std::env::temp_dir().join("termx-live-download.txt");
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let n = handle
            .download_streaming(&b, &tmp, &host, "live", cancel)
            .await
            .expect("download");
        assert_eq!(n, payload.len() as u64);
        assert_eq!(std::fs::read(&tmp).expect("read downloaded"), payload);
        let _ = std::fs::remove_file(&tmp);

        handle.remove(&b).await.expect("remove file");
        handle.remove(&dir).await.expect("remove dir");
    }

    // ── 传输冲突全链路（阶段 C） ────────────────────────────

    /// 用生产流式上传在远端种一个文件（冲突检测的"已存在"前提）。
    async fn seed_remote(handle: &SftpHandle, host: &crate::emitter::Host, path: &str, content: &[u8]) {
        let mut reader: &[u8] = content;
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        handle
            .upload_streaming(&mut reader, content.len() as u64, path, host, "seed", cancel)
            .await
            .unwrap_or_else(|e| panic!("seed {path}: {e}"));
    }

    /// 下载远端文件内容用于断言比对。
    async fn remote_content(handle: &SftpHandle, host: &crate::emitter::Host, path: &str) -> Vec<u8> {
        let tmp = std::env::temp_dir().join(format!(
            "termx-live-conflict-dl-{}",
            uuid::Uuid::new_v4()
        ));
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        handle
            .download_streaming(path, &tmp, host, "verify", cancel)
            .await
            .unwrap_or_else(|e| panic!("download {path}: {e}"));
        let data = std::fs::read(&tmp).expect("read verify file");
        let _ = std::fs::remove_file(&tmp);
        data
    }

    /// 轮询单项至目标状态；Failed/Cancelled 提前 panic（错误终态即失败）。
    async fn wait_status(state: &AppState, id: &str, expected: Status) -> tc::TransferItem {
        for _ in 0..200 {
            let items = tc::list(state).await.expect("transfer list");
            if let Some(it) = items.iter().find(|i| i.id == id) {
                if it.status == expected {
                    return it.clone();
                }
                if matches!(it.status, Status::Failed | Status::Cancelled) {
                    panic!(
                        "transfer {id} 进入 {:?}（error: {:?}）",
                        it.status, it.error
                    );
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("等待 transfer {id} → {expected:?} 超时");
    }

    /// 轮询一批项全部到达目标状态。
    async fn wait_status_many(state: &AppState, ids: &[String], expected: Status) {
        for _ in 0..200 {
            let items = tc::list(state).await.expect("transfer list");
            let picked: Vec<_> = items
                .iter()
                .filter(|i| ids.contains(&i.id))
                .cloned()
                .collect();
            if picked.len() == ids.len() && picked.iter().all(|i| i.status == expected) {
                return;
            }
            if let Some(bad) = picked
                .iter()
                .find(|i| matches!(i.status, Status::Failed | Status::Cancelled))
            {
                panic!(
                    "transfer {} 进入 {:?}（error: {:?}）",
                    bad.id, bad.status, bad.error
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("等待批量传输 → {expected:?} 超时");
    }

    /// 真实远端主机的传输冲突全链路（默认档案 "129"）：
    /// (a) 无同名直接完成（证 remote_exists 假分支在真实服务器不误判）；
    /// (b) skip 保留远端原内容；(c) rename 生成 `file (copy)` 副本；
    /// (d) replace 覆盖；(e) apply-to-all 对同批已冲突项回溯生效。
    /// 与 roundtrip 相同门禁：仅 TERMX_SFTP_LIVE=1，凭据取自 ~/.termX DB +
    /// SecretStore（与应用同路径），密码不落明文、不进日志。
    #[tokio::test]
    async fn live_sftp_transfer_conflict() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let name = std::env::var("TERMX_SFTP_LIVE_PROFILE").unwrap_or_else(|_| "129".into());
        let data_dir = dirs::home_dir().expect("home dir").join(".termX");
        let db = Arc::new(crate::db::Db::open(&data_dir).expect("open ~/.termX db"));
        let secrets = crate::secret::open(db.clone(), &data_dir).expect("open secret store");

        let profile = crate::db::profile::list(&db)
            .expect("list profiles")
            .into_iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("profile {name} not found"));
        let cred_row =
            crate::db::credential::get(&db, &profile.credential_id).expect("get credential");
        let secret = secrets
            .store
            .get(&crate::secret::cred_secret_key(&cred_row.id))
            .expect("decrypt credential secret");
        let cred = Credential { secret, ..cred_row };

        let known_hosts = crate::ssh::known_hosts::path_for(&data_dir);
        let handle = Arc::new(
            SftpHandle::connect(
                profile.host,
                profile.port,
                cred,
                known_hosts,
                15,
                None,
                profile.host_key_policy.clone(),
            )
                .await
                .expect("sftp connect"),
        );

        // headless AppState（同 lifecycle::tests::empty_state 结构）：内存 DB +
        // 空会话表，真实 handle 挂到 sftp_sessions["live"]。
        let mem_db = Arc::new(crate::db::Db::open_in_memory().expect("in-memory db"));
        let secret_store: Arc<dyn crate::secret::SecretStore> =
            Arc::new(crate::secret::DbStore::new(mem_db.clone()));
        let mut sftp_sessions = std::collections::HashMap::new();
        sftp_sessions.insert("live".to_string(), handle.clone());
        let state = AppState {
            transfer_center: Arc::new(tc::TransferCenter::new(mem_db.clone())),
            db: mem_db,
            secret_store,
            lifecycle_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            #[cfg(desktop)]
            pty_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            #[cfg(desktop)]
            serial_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            telnet_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            sftp_sessions: std::sync::Mutex::new(sftp_sessions),
            transfer_cancels: std::sync::Mutex::new(std::collections::HashMap::new()),
            active_forwards: std::sync::Mutex::new(std::collections::HashMap::new()),
            auth_waiters: std::sync::Mutex::new(std::collections::HashMap::new()),
            passphrase_waiters: std::sync::Mutex::new(std::collections::HashMap::new()),
            host_key_waiters: std::sync::Mutex::new(std::collections::HashMap::new()),
            passphrase_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            ai_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            ai_session_owners: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            ai_remote_shell_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            data_dir: PathBuf::new(),
        };

        let (host, _rx) = crate::ssh::test_support::headless_host();
        let dir = format!("/tmp/termx-live-conflict-{}", std::process::id());
        handle.mkdir(&dir).await.expect("mkdir remote temp dir");
        let local_dir = std::env::temp_dir().join(format!(
            "termx-live-conflict-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&local_dir).expect("create local temp dir");
        let write_local = |fname: &str, content: &[u8]| -> String {
            let p = local_dir.join(fname);
            std::fs::write(&p, content).expect("write local file");
            p.display().to_string()
        };
        let enqueue_upload = |local: String, remote: String| NewTransfer {
            sftp_id: "live".into(),
            direction: Direction::Upload,
            local_path: local,
            remote_path: remote,
            size: 0,
            priority: Default::default(),
        };

        // (a) 无同名 → 直接完成：证实 remote_exists 对"不存在"的错误文案判定
        // 在真实服务器上返回 false（而非误报冲突或抛错）。
        let fresh_remote = format!("{dir}/fresh.txt");
        let created = tc::enqueue(
            &state,
            &host,
            vec![enqueue_upload(
                write_local("fresh.txt", b"no conflict"),
                fresh_remote.clone(),
            )],
        )
        .await
        .expect("enqueue fresh");
        wait_status(&state, &created[0].id, Status::Completed).await;
        assert_eq!(
            remote_content(&handle, &host, &fresh_remote).await,
            b"no conflict"
        );

        // (b) skip：冲突后跳过，远端内容保持原样。
        let conflict_remote = format!("{dir}/conflict.txt");
        seed_remote(&handle, &host, &conflict_remote, b"remote-v1").await;
        let created = tc::enqueue(
            &state,
            &host,
            vec![enqueue_upload(
                write_local("conflict.txt", b"local-v1"),
                conflict_remote.clone(),
            )],
        )
        .await
        .expect("enqueue conflict");
        let id = created[0].id.clone();
        wait_status(&state, &id, Status::Conflict).await;
        tc::resolve_conflict(&state, &host, id.clone(), ConflictAction::Skip, false)
            .await
            .expect("resolve skip");
        wait_status(&state, &id, Status::Skipped).await;
        assert_eq!(
            remote_content(&handle, &host, &conflict_remote).await,
            b"remote-v1",
            "skip 不得改动远端"
        );

        // (c) rename：生成 `conflict (copy).txt` 副本，原文件保留。
        let created = tc::enqueue(
            &state,
            &host,
            vec![enqueue_upload(
                write_local("conflict.txt", b"local-v1"),
                conflict_remote.clone(),
            )],
        )
        .await
        .expect("enqueue conflict 2");
        let id = created[0].id.clone();
        wait_status(&state, &id, Status::Conflict).await;
        tc::resolve_conflict(&state, &host, id.clone(), ConflictAction::Rename, false)
            .await
            .expect("resolve rename");
        let done = wait_status(&state, &id, Status::Completed).await;
        let copy_remote = format!("{dir}/conflict (copy).txt");
        assert_eq!(done.remote_path, copy_remote, "rename 目标路径应回写");
        assert_eq!(remote_content(&handle, &host, &copy_remote).await, b"local-v1");
        assert_eq!(
            remote_content(&handle, &host, &conflict_remote).await,
            b"remote-v1",
            "rename 不得改动原文件"
        );

        // (d) replace：覆盖远端。
        let created = tc::enqueue(
            &state,
            &host,
            vec![enqueue_upload(
                write_local("conflict.txt", b"local-v1"),
                conflict_remote.clone(),
            )],
        )
        .await
        .expect("enqueue conflict 3");
        let id = created[0].id.clone();
        wait_status(&state, &id, Status::Conflict).await;
        tc::resolve_conflict(&state, &host, id.clone(), ConflictAction::Replace, false)
            .await
            .expect("resolve replace");
        wait_status(&state, &id, Status::Completed).await;
        assert_eq!(
            remote_content(&handle, &host, &conflict_remote).await,
            b"local-v1",
            "replace 应覆盖远端"
        );

        // (e) apply-to-all：批量入队 2 项 → 双双 Conflict → 解首个
        // replace+applyToAll → 同批已冲突项回溯套用，双双完成。
        tc::set_concurrency(&state, &host, 8).await.expect("set concurrency");
        let b1_remote = format!("{dir}/bulk1.txt");
        let b2_remote = format!("{dir}/bulk2.txt");
        seed_remote(&handle, &host, &b1_remote, b"r1").await;
        seed_remote(&handle, &host, &b2_remote, b"r2").await;
        let created = tc::enqueue(
            &state,
            &host,
            vec![
                enqueue_upload(write_local("bulk1.txt", b"l1"), b1_remote.clone()),
                enqueue_upload(write_local("bulk2.txt", b"l2"), b2_remote.clone()),
            ],
        )
        .await
        .expect("enqueue bulk");
        let ids: Vec<String> = created.iter().map(|i| i.id.clone()).collect();
        wait_status_many(&state, &ids, Status::Conflict).await;
        tc::resolve_conflict(&state, &host, ids[0].clone(), ConflictAction::Replace, true)
            .await
            .expect("resolve replace apply-to-all");
        wait_status_many(&state, &ids, Status::Completed).await;
        assert_eq!(remote_content(&handle, &host, &b1_remote).await, b"l1");
        assert_eq!(remote_content(&handle, &host, &b2_remote).await, b"l2");

        // 清理：远端临时文件/目录 + 本地临时目录（单项失败不阻塞其余）。
        for p in [&fresh_remote, &conflict_remote, &copy_remote, &b1_remote, &b2_remote] {
            let _ = handle.remove(p).await;
        }
        let _ = handle.remove(&dir).await;
        let _ = std::fs::remove_dir_all(&local_dir);
    }

    // ── 编辑器读写与守卫全链路（P0 #8 阶段 B） ────────────────

    /// 真实远端主机（默认档案 "129"）编辑器链路：
    /// 读 → 回写（覆盖已有文件，含收缩场景验证截断语义）→ 再读一致；
    /// 超限拒绝（真实 stat 尺寸 + guard）；二进制拒绝（NUL 采样）。
    /// 凭据同走 ~/.termX DB + SecretStore，密码不落明文；测后清理远端临时目录。
    #[tokio::test]
    async fn live_sftp_editor_read_write_guards() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let name = std::env::var("TERMX_SFTP_LIVE_PROFILE").unwrap_or_else(|_| "129".into());
        let data_dir = dirs::home_dir().expect("home dir").join(".termX");
        let db = Arc::new(crate::db::Db::open(&data_dir).expect("open ~/.termX db"));
        let secrets = crate::secret::open(db.clone(), &data_dir).expect("open secret store");
        let profile = crate::db::profile::list(&db)
            .expect("list profiles")
            .into_iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("profile {name} not found"));
        let cred_row =
            crate::db::credential::get(&db, &profile.credential_id).expect("get credential");
        let secret = secrets
            .store
            .get(&crate::secret::cred_secret_key(&cred_row.id))
            .expect("decrypt credential secret");
        let cred = Credential { secret, ..cred_row };
        let known_hosts = crate::ssh::known_hosts::path_for(&data_dir);
        let handle = SftpHandle::connect(
            profile.host,
            profile.port,
            cred,
            known_hosts,
            15,
            None,
            profile.host_key_policy.clone(),
        )
                .await
                .expect("sftp connect");

        let (host, _rx) = crate::ssh::test_support::headless_host();
        let dir = format!("/tmp/termx-live-editor-{}", std::process::id());
        let f = format!("{dir}/edit.txt");
        handle.mkdir(&dir).await.expect("mkdir");

        // 1) 种一个已存在文件：编辑器只打开已有文件，保存 = 覆盖已有文件。
        let long = b"termx editor live seed -- long initial content v1";
        seed_remote(&handle, &host, &f, long).await;

        // 2) 读：stat 预检 + 全文读（sftp_read_file 同款路径），且不判二进制。
        let st = handle.stat(&f).await.expect("stat");
        editor_size_guard(st.size, DEFAULT_EDITOR_READ_CAP, &f).expect("size guard ok");
        let data = handle.download(&f).await.expect("read");
        assert_eq!(data, long, "读取应与种入内容一致");
        assert!(!looks_binary(&data), "文本文件不得判二进制");

        // 3) 回写：h.upload（sftp_write_file 同款路径）覆盖，刻意写入更短内容
        //    验证截断语义；再读必须完全一致（读→写→再读一致）。
        let short = b"v2 short";
        handle.upload(&f, short).await.expect("write back");
        let again = handle.download(&f).await.expect("re-read");
        assert_eq!(again, short, "读→写→再读一致（含收缩截断）");

        // 4) 超限拒绝：用真实远端尺寸触发 guard，错误码须一致。
        let st2 = handle.stat(&f).await.expect("stat after write");
        let err = editor_size_guard(st2.size, st2.size.saturating_sub(1), &f).unwrap_err();
        assert_eq!(err.code(), "sftp_file_too_large");

        // 5) 二进制拒绝：含 NUL 文件读回后采样判二进制（编辑器入口拒绝）。
        let bin = format!("{dir}/bin.dat");
        seed_remote(&handle, &host, &bin, &[b'T', b'X', 0, 1, 2, 0, b'\n']).await;
        let bdata = handle.download(&bin).await.expect("read binary");
        assert!(looks_binary(&bdata), "含 NUL 文件应判二进制");

        // 清理。
        for p in [&f, &bin] {
            let _ = handle.remove(p).await;
        }
        let _ = handle.remove(&dir).await;
    }

    // ── 深路径 / 队列验收（SFTP 验收轮）─────────────────────

    struct LiveCtx {
        handle: Arc<SftpHandle>,
        cred: Credential,
        ssh_host: String,
        ssh_port: u16,
        known_hosts: PathBuf,
        host_key_policy: Option<String>,
    }

    async fn live_ctx() -> LiveCtx {
        let name = std::env::var("TERMX_SFTP_LIVE_PROFILE").unwrap_or_else(|_| "129".into());
        let data_dir = dirs::home_dir().expect("home dir").join(".termX");
        let db = Arc::new(crate::db::Db::open(&data_dir).expect("open ~/.termX db"));
        let secrets = crate::secret::open(db.clone(), &data_dir).expect("open secret store");
        let profile = crate::db::profile::list(&db)
            .expect("list profiles")
            .into_iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("profile {name} not found"));
        let cred_row =
            crate::db::credential::get(&db, &profile.credential_id).expect("get credential");
        let secret = secrets
            .store
            .get(&crate::secret::cred_secret_key(&cred_row.id))
            .expect("decrypt credential secret");
        let cred = Credential { secret, ..cred_row };
        let known_hosts = crate::ssh::known_hosts::path_for(&data_dir);
        let handle = Arc::new(
            SftpHandle::connect(
                profile.host.clone(),
                profile.port,
                cred.clone(),
                known_hosts.clone(),
                15,
                None,
                profile.host_key_policy.clone(),
            )
            .await
            .expect("sftp connect"),
        );
        LiveCtx {
            handle,
            cred,
            ssh_host: profile.host,
            ssh_port: profile.port,
            known_hosts,
            host_key_policy: profile.host_key_policy,
        }
    }

    fn live_state(handle: Arc<SftpHandle>) -> AppState {
        let mem_db = Arc::new(crate::db::Db::open_in_memory().expect("in-memory db"));
        let secret_store: Arc<dyn crate::secret::SecretStore> =
            Arc::new(crate::secret::DbStore::new(mem_db.clone()));
        let mut sftp_sessions = std::collections::HashMap::new();
        sftp_sessions.insert("live".to_string(), handle);
        AppState {
            transfer_center: Arc::new(tc::TransferCenter::new(mem_db.clone())),
            db: mem_db,
            secret_store,
            lifecycle_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            #[cfg(desktop)]
            pty_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            #[cfg(desktop)]
            serial_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            telnet_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            sftp_sessions: std::sync::Mutex::new(sftp_sessions),
            transfer_cancels: std::sync::Mutex::new(std::collections::HashMap::new()),
            active_forwards: std::sync::Mutex::new(std::collections::HashMap::new()),
            auth_waiters: std::sync::Mutex::new(std::collections::HashMap::new()),
            passphrase_waiters: std::sync::Mutex::new(std::collections::HashMap::new()),
            host_key_waiters: std::sync::Mutex::new(std::collections::HashMap::new()),
            passphrase_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            ai_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            ai_session_owners: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            ai_remote_shell_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            data_dir: PathBuf::new(),
        }
    }

    /// 建一条独立 SSH 执行通道（用于创建符号链接 / 原生命名 / sha256sum）。
    async fn live_exec(ctx: &LiveCtx, cmd: &str) -> String {
        let dial = crate::ssh::client::DialCtx {
            config: crate::ssh::client::default_client_config(),
            known_hosts_path: ctx.known_hosts.clone(),
            timeout_secs: 15,
            log: crate::ssh::client::null_logger(),
            prompt_ctx: None,
            progress: None,
            agent_forwarding: false,
            proxy: None,
            host_key_policy: ctx.host_key_policy.clone(),
            banner: None,
        };
        let mut h = crate::ssh::client::ssh_connect(dial, ctx.ssh_host.clone(), ctx.ssh_port)
            .await
            .expect("ssh connect (exec)");
        crate::ssh::client::authenticate(&mut h, ctx.cred.clone(), None)
            .await
            .expect("ssh auth (exec)");
        let mut ch = h.channel_open_session().await.expect("channel");
        ch.exec(true, cmd).await.expect("exec");
        let mut out = Vec::new();
        loop {
            match ch.wait().await {
                Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// 生成确定内容的本地文件（分块写，避免一次性大内存）。
    fn write_sized(path: &Path, size: u64) {
        let mut f = std::io::BufWriter::new(std::fs::File::create(path).expect("create local"));
        let chunk: Vec<u8> = (0..65536u32).map(|i| (i % 251) as u8).collect();
        let mut left = size;
        while left > 0 {
            let n = left.min(chunk.len() as u64) as usize;
            f.write_all(&chunk[..n]).expect("write chunk");
            left -= n as u64;
        }
        f.flush().expect("flush");
    }

    fn sha_local(path: &Path) -> String {
        let mut f = std::fs::File::open(path).expect("open for sha");
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).expect("read for sha");
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        format!("{:x}", hasher.finalize())
    }

    async fn remote_sha(ctx: &LiveCtx, path: &str) -> String {
        let out = live_exec(ctx, &format!("sha256sum '{path}'")).await;
        let first = out.split_whitespace().next().unwrap_or("").to_string();
        if first.len() == 64 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            return first;
        }
        // 远端缺 sha256sum 时回退：下载后本地哈希。
        let tmp = std::env::temp_dir().join(format!("termx-sha-{}", uuid::Uuid::new_v4()));
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (host, _rx) = crate::ssh::test_support::headless_host();
        ctx.handle
            .download_streaming(path, &tmp, &host, "sha", cancel)
            .await
            .expect("download for sha");
        let sha = sha_local(&tmp);
        let _ = std::fs::remove_file(&tmp);
        sha
    }

    async fn status_of(state: &AppState, id: &str) -> Option<tc::TransferItem> {
        tc::list(state)
            .await
            .expect("transfer list")
            .into_iter()
            .find(|i| i.id == id)
    }

    /// 轮询到指定状态（不因中间 Failed/Cancelled 提前 panic，便于断言错误码）。
    async fn wait_exact(
        state: &AppState,
        id: &str,
        expected: Status,
        timeout: Duration,
    ) -> tc::TransferItem {
        let start = Instant::now();
        let mut last = String::new();
        while start.elapsed() < timeout {
            if let Some(it) = status_of(state, id).await {
                last = format!("{:?}", it.status);
                if it.status == expected {
                    return it;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("等待 {id} → {expected:?} 超时（最后状态 {last}）");
    }

    async fn wait_terminal(
        state: &AppState,
        id: &str,
        timeout: Duration,
    ) -> tc::TransferItem {
        let start = Instant::now();
        let mut last = String::new();
        while start.elapsed() < timeout {
            if let Some(it) = status_of(state, id).await {
                last = format!("{:?}", it.status);
                if it.status.is_terminal() {
                    return it;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("等待 {id} 终态超时（最后状态 {last}）");
    }

    /// 1) 冲突三态 + rename 命名链 + 跨批次作用域 + concurrency=1 时
    /// applyToAll 对「尚未启动的后续条目」生效。
    #[tokio::test]
    async fn live_sftp_conflict_three_states_and_scope() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let ctx = live_ctx().await;
        let state = live_state(ctx.handle.clone());
        let (host, _rx) = crate::ssh::test_support::headless_host();
        let tag = uuid::Uuid::new_v4().to_string();
        let dir = format!("/tmp/termx-acc-conflict-{tag}");
        ctx.handle.mkdir(&dir).await.expect("mkdir");
        let local_dir = std::env::temp_dir().join(format!("termx-acc-conflict-{tag}"));
        std::fs::create_dir_all(&local_dir).expect("create local dir");
        let write = |n: &str, c: &[u8]| -> String {
            let p = local_dir.join(n);
            std::fs::write(&p, c).expect("write local");
            p.display().to_string()
        };
        let up = |local: String, remote: String, prio: tc::Priority| NewTransfer {
            sftp_id: "live".into(),
            direction: Direction::Upload,
            local_path: local,
            remote_path: remote,
            size: 0,
            priority: prio,
        };

        // (1) rename 链：`chain (copy).txt` → `chain (copy 2).txt`。
        let chain = format!("{dir}/chain.txt");
        seed_remote(&ctx.handle, &host, &chain, b"remote").await;
        let local_chain = write("chain.txt", b"uploaded");
        for expected in ["chain (copy).txt", "chain (copy 2).txt"] {
            let created = tc::enqueue(
                &state,
                &host,
                vec![up(local_chain.clone(), chain.clone(), tc::Priority::Normal)],
            )
            .await
            .expect("enqueue rename chain");
            let id = created[0].id.clone();
            wait_exact(&state, &id, Status::Conflict, Duration::from_secs(30)).await;
            tc::resolve_conflict(&state, &host, id.clone(), ConflictAction::Rename, false)
                .await
                .expect("resolve rename");
            let done = wait_exact(&state, &id, Status::Completed, Duration::from_secs(30)).await;
            let want = format!("{dir}/{expected}");
            assert_eq!(done.remote_path, want, "rename 链命名应与 Netcatty 一致");
            assert_eq!(remote_content(&ctx.handle, &host, &want).await, b"uploaded");
        }

        // (2) 下载侧 rename：本地同名 → `dl (copy).txt`。
        let remote_dl = format!("{dir}/dl.txt");
        seed_remote(&ctx.handle, &host, &remote_dl, b"remote-dl").await;
        let local_dl = write("dl.txt", b"local-old");
        let created = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Download,
                local_path: local_dl.clone(),
                remote_path: remote_dl.clone(),
                size: 0,
                priority: Default::default(),
            }],
        )
        .await
        .expect("enqueue download conflict");
        let id = created[0].id.clone();
        wait_exact(&state, &id, Status::Conflict, Duration::from_secs(30)).await;
        tc::resolve_conflict(&state, &host, id.clone(), ConflictAction::Rename, false)
            .await
            .expect("resolve download rename");
        let done = wait_exact(&state, &id, Status::Completed, Duration::from_secs(30)).await;
        assert!(
            done.local_path.ends_with("dl (copy).txt"),
            "下载 rename 目标应回写，实际 {}",
            done.local_path
        );
        assert_eq!(
            std::fs::read(PathBuf::from(&done.local_path)).expect("read downloaded copy"),
            b"remote-dl"
        );
        assert_eq!(
            std::fs::read(&local_dl).expect("read original local"),
            b"local-old",
            "rename 不得改动原本地文件"
        );

        // (3) 批次作用域：batch1 skip+applyAll 不影响 batch2（仍 Conflict）。
        let b1 = format!("{dir}/b1.txt");
        let b2 = format!("{dir}/b2.txt");
        let b3 = format!("{dir}/b3.txt");
        let b4 = format!("{dir}/b4.txt");
        for p in [&b1, &b2, &b3, &b4] {
            seed_remote(&ctx.handle, &host, p, b"remote").await;
        }
        let batch1 = tc::enqueue(
            &state,
            &host,
            vec![
                up(write("b1.txt", b"l1"), b1.clone(), tc::Priority::Normal),
                up(write("b2.txt", b"l2"), b2.clone(), tc::Priority::Normal),
            ],
        )
        .await
        .expect("batch1");
        let batch2 = tc::enqueue(
            &state,
            &host,
            vec![
                up(write("b3.txt", b"l3"), b3.clone(), tc::Priority::Normal),
                up(write("b4.txt", b"l4"), b4.clone(), tc::Priority::Normal),
            ],
        )
        .await
        .expect("batch2");
        let ids1: Vec<String> = batch1.iter().map(|i| i.id.clone()).collect();
        let ids2: Vec<String> = batch2.iter().map(|i| i.id.clone()).collect();
        for id in ids1.iter().chain(ids2.iter()) {
            wait_exact(&state, id, Status::Conflict, Duration::from_secs(30)).await;
        }
        tc::resolve_conflict(&state, &host, ids1[0].clone(), ConflictAction::Skip, true)
            .await
            .expect("skip apply-all");
        for id in &ids1 {
            wait_exact(&state, id, Status::Skipped, Duration::from_secs(30)).await;
        }
        for id in &ids2 {
            let it = status_of(&state, id).await.expect("batch2 item");
            assert_eq!(it.status, Status::Conflict, "applyToAll 不得跨批次生效");
        }
        tc::resolve_conflict(&state, &host, ids2[0].clone(), ConflictAction::Rename, true)
            .await
            .expect("rename apply-all");
        for id in &ids2 {
            wait_exact(&state, id, Status::Completed, Duration::from_secs(30)).await;
        }
        assert_eq!(remote_content(&ctx.handle, &host, &b3).await, b"remote");
        assert_eq!(remote_content(&ctx.handle, &host, &b4).await, b"remote");
        assert_eq!(
            remote_content(&ctx.handle, &host, &format!("{dir}/b3 (copy).txt")).await,
            b"l3"
        );
        assert_eq!(
            remote_content(&ctx.handle, &host, &format!("{dir}/b4 (copy).txt")).await,
            b"l4"
        );

        // (4) 后续条目：冲突项不占并发槽（对齐 Netcatty：worker 落 attention 后释放），
        //     concurrency=1 时第二项随即也探测并进入 Conflict；
        //     replace+applyAll 回溯同批已冲突项，两项都无需再逐个答复。
        tc::set_concurrency(&state, &host, 1).await.expect("concurrency 1");
        let f1 = format!("{dir}/seq1.txt");
        let f2 = format!("{dir}/seq2.txt");
        seed_remote(&ctx.handle, &host, &f1, b"r1").await;
        seed_remote(&ctx.handle, &host, &f2, b"r2").await;
        let seq = tc::enqueue(
            &state,
            &host,
            vec![
                up(write("seq1.txt", b"s1"), f1.clone(), tc::Priority::Normal),
                up(write("seq2.txt", b"s2"), f2.clone(), tc::Priority::Normal),
            ],
        )
        .await
        .expect("seq batch");
        let sid1 = seq[0].id.clone();
        let sid2 = seq[1].id.clone();
        wait_exact(&state, &sid1, Status::Conflict, Duration::from_secs(30)).await;
        wait_exact(&state, &sid2, Status::Conflict, Duration::from_secs(30)).await;
        tc::resolve_conflict(&state, &host, sid1.clone(), ConflictAction::Replace, true)
            .await
            .expect("replace apply-all");
        wait_exact(&state, &sid1, Status::Completed, Duration::from_secs(30)).await;
        wait_exact(&state, &sid2, Status::Completed, Duration::from_secs(30)).await;
        assert_eq!(remote_content(&ctx.handle, &host, &f1).await, b"s1");
        assert_eq!(remote_content(&ctx.handle, &host, &f2).await, b"s2");
        tc::set_concurrency(&state, &host, 6).await.expect("restore concurrency");

        // 清理。
        for p in [&chain, &remote_dl, &b1, &b2, &b3, &b4, &f1, &f2] {
            let _ = ctx.handle.remove(p).await;
        }
        for extra in ["chain (copy).txt", "chain (copy 2).txt", "b3 (copy).txt", "b4 (copy).txt"] {
            let _ = ctx.handle.remove(&format!("{dir}/{extra}")).await;
        }
        for p in [
            local_chain.clone(),
            local_dl.clone(),
            local_dir.join("dl (copy).txt").display().to_string(),
        ] {
            let _ = std::fs::remove_file(p);
        }
        let _ = ctx.handle.remove(&dir).await;
        let _ = std::fs::remove_dir_all(&local_dir);
    }

    /// 2) 暂停/恢复（断点续传 + SHA256 回归）、取消（运行中/排队中）、重试失败项。
    #[tokio::test]
    async fn live_sftp_pause_resume_cancel_retry() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let ctx = live_ctx().await;
        let state = live_state(ctx.handle.clone());
        let (host, _rx) = crate::ssh::test_support::headless_host();
        let tag = uuid::Uuid::new_v4().to_string();
        let dir = format!("/tmp/termx-acc-queue-{tag}");
        ctx.handle.mkdir(&dir).await.expect("mkdir");
        let local_dir = std::env::temp_dir().join(format!("termx-acc-queue-{tag}"));
        std::fs::create_dir_all(&local_dir).expect("local dir");

        let big_size: u64 = 128 << 20;
        let big_local = local_dir.join("big.bin");
        write_sized(&big_local, big_size);
        let big_sha = sha_local(&big_local);
        let big_remote = format!("{dir}/big.bin");

        // 上传：中途暂停 → Paused 且 checkpoint 在 (0, size) → 恢复 → SHA 一致。
        let created = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: big_local.display().to_string(),
                remote_path: big_remote.clone(),
                size: big_size,
                priority: Default::default(),
            }],
        )
        .await
        .expect("enqueue big upload");
        let id = created[0].id.clone();
        wait_exact(&state, &id, Status::Running, Duration::from_secs(20)).await;
        // 列表快照只在 worker 收尾时回写 checkpoint，运行中读到的始终是 0；
        // 必须先让 worker 真正写出一批数据（流水线 ~64KB/块）再暂停。
        tokio::time::sleep(Duration::from_millis(600)).await;
        tc::pause(&state, &host, id.clone()).await.expect("pause upload");
        let paused = wait_exact(&state, &id, Status::Paused, Duration::from_secs(30)).await;
        assert!(
            paused.checkpoint > 0 && paused.checkpoint < big_size,
            "暂停断点应在 (0,{big_size})，实际 {}",
            paused.checkpoint
        );
        eprintln!(
            "[pause/upload] checkpoint={} / {} ({:.1}%)",
            paused.checkpoint,
            big_size,
            paused.checkpoint as f64 / big_size as f64 * 100.0
        );
        tc::resume(&state, &host, id.clone()).await.expect("resume upload");
        wait_exact(&state, &id, Status::Completed, Duration::from_secs(180)).await;
        let remote_sha_up = remote_sha(&ctx, &big_remote).await;
        assert_eq!(remote_sha_up, big_sha, "恢复后续传结果 SHA256 必须一致");
        eprintln!("[pause/upload] resume+sha ok");

        // 下载：中途暂停 → Paused 且 .part 保留 → 恢复 → SHA 一致。
        let dl_local = local_dir.join("big-dl.bin");
        let created = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Download,
                local_path: dl_local.display().to_string(),
                remote_path: big_remote.clone(),
                size: 0,
                priority: Default::default(),
            }],
        )
        .await
        .expect("enqueue big download");
        let dl_id = created[0].id.clone();
        wait_exact(&state, &dl_id, Status::Running, Duration::from_secs(20)).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        tc::pause(&state, &host, dl_id.clone()).await.expect("pause download");
        let paused = wait_exact(&state, &dl_id, Status::Paused, Duration::from_secs(30)).await;
        assert!(paused.checkpoint > 0 && paused.checkpoint < big_size);
        let part = PathBuf::from(format!("{}.part", dl_local.display()));
        assert!(part.exists(), "暂停后本地 .part 应保留");
        eprintln!("[pause/download] checkpoint={}/{}", paused.checkpoint, big_size);
        tc::resume(&state, &host, dl_id.clone()).await.expect("resume download");
        wait_exact(&state, &dl_id, Status::Completed, Duration::from_secs(180)).await;
        assert!(!part.exists(), "完成后 .part 应更名为目标文件");
        assert_eq!(sha_local(&dl_local), big_sha, "下载续传结果 SHA256 必须一致");

        // 取消排队中：concurrency=1，阻塞项运行中取消后面的排队项。
        tc::set_concurrency(&state, &host, 1).await.expect("c1");
        let blocker_remote = format!("{dir}/blocker.bin");
        let blocker = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: big_local.display().to_string(),
                remote_path: blocker_remote.clone(),
                size: big_size,
                priority: Default::default(),
            }],
        )
        .await
        .expect("blocker");
        let blocker_id = blocker[0].id.clone();
        wait_exact(&state, &blocker_id, Status::Running, Duration::from_secs(20)).await;
        let victim_local = local_dir.join("victim.txt");
        std::fs::write(&victim_local, b"victim").expect("victim file");
        let victim = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: victim_local.display().to_string(),
                remote_path: format!("{dir}/victim.txt"),
                size: 6,
                priority: Default::default(),
            }],
        )
        .await
        .expect("victim");
        let victim_id = victim[0].id.clone();
        assert_eq!(
            status_of(&state, &victim_id).await.expect("victim").status,
            Status::Queued
        );
        tc::cancel(&state, &host, victim_id.clone()).await.expect("cancel queued");
        wait_exact(&state, &victim_id, Status::Cancelled, Duration::from_secs(10)).await;
        wait_exact(&state, &blocker_id, Status::Completed, Duration::from_secs(180)).await;

        // 取消运行中：checkpoint 清 0，远端 .part 清理。
        let cancel_remote = format!("{dir}/cancel.bin");
        let created = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: big_local.display().to_string(),
                remote_path: cancel_remote.clone(),
                size: big_size,
                priority: Default::default(),
            }],
        )
        .await
        .expect("cancel target");
        let cid = created[0].id.clone();
        wait_exact(&state, &cid, Status::Running, Duration::from_secs(20)).await;
        tc::cancel(&state, &host, cid.clone()).await.expect("cancel running");
        let cancelled = wait_exact(&state, &cid, Status::Cancelled, Duration::from_secs(30)).await;
        assert_eq!(cancelled.checkpoint, 0, "取消后 checkpoint 应清零");
        let names = ctx.handle.list_dir(&dir).await.expect("list after cancel");
        assert!(
            !names.iter().any(|e| e.name.ends_with(".part")),
            "取消后远端临时文件应被清理"
        );

        // 重试失败项：源不存在 → Failed → 补齐源 → 重试 → Completed。
        let missing = local_dir.join("missing.txt");
        let retry_remote = format!("{dir}/retry.txt");
        let created = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: missing.display().to_string(),
                remote_path: retry_remote.clone(),
                size: 0,
                priority: Default::default(),
            }],
        )
        .await
        .expect("retry enqueue");
        let rid = created[0].id.clone();
        let failed = wait_exact(&state, &rid, Status::Failed, Duration::from_secs(30)).await;
        assert!(
            failed.error.as_deref().unwrap_or("").contains("io_error"),
            "本地源缺失应记 io_error，实际 {:?}",
            failed.error
        );
        eprintln!("[retry] 失败项 code={:?}", failed.error);
        std::fs::write(&missing, b"now exists").expect("create missing source");
        tc::retry(&state, &host, rid.clone()).await.expect("retry");
        wait_exact(&state, &rid, Status::Completed, Duration::from_secs(30)).await;
        assert_eq!(remote_content(&ctx.handle, &host, &retry_remote).await, b"now exists");
        tc::set_concurrency(&state, &host, 6).await.expect("restore");

        // 清理。
        for p in [&big_remote, &blocker_remote, &cancel_remote, &retry_remote] {
            let _ = ctx.handle.remove(p).await;
        }
        let _ = ctx.handle.remove(&format!("{dir}/victim.txt")).await;
        let _ = ctx.handle.remove(&dir).await;
        let _ = std::fs::remove_dir_all(&local_dir);
    }

    /// 3) 并发上限 1 / 8 的实际并行数；优先级 High > Normal > Low 的启动顺序。
    #[tokio::test]
    async fn live_sftp_concurrency_and_priority() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let ctx = live_ctx().await;
        let state = live_state(ctx.handle.clone());
        let (host, _rx) = crate::ssh::test_support::headless_host();
        let tag = uuid::Uuid::new_v4().to_string();
        let dir = format!("/tmp/termx-acc-par-{tag}");
        ctx.handle.mkdir(&dir).await.expect("mkdir");
        let local_dir = std::env::temp_dir().join(format!("termx-acc-par-{tag}"));
        std::fs::create_dir_all(&local_dir).expect("local dir");
        let file_8 = local_dir.join("f8.bin");
        write_sized(&file_8, 8 << 20);
        let file_16 = local_dir.join("f16.bin");
        write_sized(&file_16, 16 << 20);

        let mk = |local: &Path, remote: String, prio: tc::Priority| NewTransfer {
            sftp_id: "live".into(),
            direction: Direction::Upload,
            local_path: local.display().to_string(),
            remote_path: remote,
            size: 8 << 20,
            priority: prio,
        };
        let max_running = |items: &[tc::TransferItem]| {
            items.iter().filter(|i| i.status == Status::Running).count()
        };

        // 并发 1：入队瞬间恰有 1 个 Running，全程最大并行数 = 1。
        tc::set_concurrency(&state, &host, 1).await.expect("c1");
        let mut ids1 = Vec::new();
        let mut expected = Vec::new();
        for i in 0..4 {
            let r = format!("{dir}/c1-{i}.bin");
            expected.push(mk(&file_8, r.clone(), tc::Priority::Normal));
            ids1.push(r);
        }
        let created = tc::enqueue(&state, &host, expected).await.expect("enqueue c1");
        let ids: Vec<String> = created.iter().map(|i| i.id.clone()).collect();
        let now = tc::list(&state).await.expect("list c1");
        let running_now = max_running(&now);
        assert_eq!(running_now, 1, "并发=1 入队后应立即只有 1 个 Running");
        let mut max1 = running_now;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(120) {
            let items = tc::list(&state).await.expect("list");
            max1 = max1.max(max_running(&items));
            if items.iter().filter(|i| ids.contains(&i.id)).all(|i| i.status.is_terminal()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(max1, 1, "并发=1 实际并行数应恒为 1");
        eprintln!("[concurrency] set=1 observed_max={max1}");

        // 并发 8：入队瞬间 8 个 Running，全程最大并行数 = 8。
        tc::set_concurrency(&state, &host, 8).await.expect("c8");
        let mut expected = Vec::new();
        let mut targets8 = Vec::new();
        for i in 0..8 {
            let r = format!("{dir}/c8-{i}.bin");
            targets8.push(r.clone());
            expected.push(mk(&file_8, r, tc::Priority::Normal));
        }
        let created = tc::enqueue(&state, &host, expected).await.expect("enqueue c8");
        let ids8: Vec<String> = created.iter().map(|i| i.id.clone()).collect();
        let now = tc::list(&state).await.expect("list c8");
        let running_now = max_running(&now);
        assert_eq!(running_now, 8, "并发=8 入队后应有 8 个 Running");
        let mut max8 = running_now;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(120) {
            let items = tc::list(&state).await.expect("list");
            max8 = max8.max(max_running(&items));
            if items.iter().filter(|i| ids8.contains(&i.id)).all(|i| i.status.is_terminal()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(max8, 8, "并发=8 实际并行数应达到 8");
        eprintln!("[concurrency] set=8 observed_max={max8}");

        // 优先级：并发 1，阻塞项运行中入队 Low → High → Normal，启动顺序须 High/Normal/Low。
        tc::set_concurrency(&state, &host, 1).await.expect("c1 again");
        let blocker_r = format!("{dir}/prio-blocker.bin");
        let blocker = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: file_16.display().to_string(),
                remote_path: blocker_r.clone(),
                size: 16 << 20,
                priority: tc::Priority::Normal,
            }],
        )
        .await
        .expect("prio blocker");
        let blocker_id = blocker[0].id.clone();
        wait_exact(&state, &blocker_id, Status::Running, Duration::from_secs(30)).await;
        let mut prio_targets = Vec::new();
        let mut prio_reqs = Vec::new();
        for (label, prio) in [
            ("low", tc::Priority::Low),
            ("high", tc::Priority::High),
            ("normal", tc::Priority::Normal),
        ] {
            let r = format!("{dir}/prio-{label}.bin");
            prio_targets.push((label.to_string(), r.clone()));
            prio_reqs.push(mk(&file_8, r, prio));
        }
        let created = tc::enqueue(&state, &host, prio_reqs).await.expect("prio enqueue");
        let prio_ids: Vec<String> = created.iter().map(|i| i.id.clone()).collect();
        let mut order: Vec<String> = Vec::new();
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(120) {
            let items = tc::list(&state).await.expect("list");
            for (label, _r) in &prio_targets {
                if order.iter().any(|o| o == label) {
                    continue;
                }
                let is_running = items.iter().any(|i| {
                    i.remote_path == format!("{dir}/prio-{label}.bin")
                        && i.status == Status::Running
                });
                if is_running {
                    order.push(label.clone());
                }
            }
            if order.len() == 3
                && items
                    .iter()
                    .filter(|i| prio_ids.contains(&i.id))
                    .all(|i| i.status.is_terminal())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            order,
            vec!["high".to_string(), "normal".to_string(), "low".to_string()],
            "优先级启动顺序应为 High → Normal → Low"
        );
        eprintln!("[priority] start order={order:?}");
        wait_exact(&state, &blocker_id, Status::Completed, Duration::from_secs(180)).await;
        tc::set_concurrency(&state, &host, 6).await.expect("restore");

        // 清理。
        for r in ids1
            .iter()
            .chain(targets8.iter())
            .chain(std::iter::once(&blocker_r))
        {
            let _ = ctx.handle.remove(r).await;
        }
        for (label, _) in &prio_targets {
            let _ = ctx.handle.remove(&format!("{dir}/prio-{label}.bin")).await;
        }
        let _ = ctx.handle.remove(&dir).await;
        let _ = std::fs::remove_dir_all(&local_dir);
    }

    /// 4) 目录递归：嵌套 / 空目录 / 大量小文件 / 符号链接（远端按真实路径去环跟随）。
    #[tokio::test]
    async fn live_sftp_walk_tree_remote_and_local() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let ctx = live_ctx().await;
        let tag = uuid::Uuid::new_v4().to_string();
        let root = format!("/tmp/termx-acc-walk-{tag}");
        let script = format!(
            "set -e; mkdir -p '{root}/nested/deep' '{root}/empty' '{root}/many'; \
             printf top > '{root}/top.txt'; printf inner > '{root}/nested/deep/inner.txt'; \
             seq 1 100 | xargs -I@ touch '{root}/many/f@.txt'; \
             ln -s top.txt '{root}/link-file'; ln -s nested '{root}/link-dir'; \
             ln -s /nonexistent '{root}/broken'; ln -s '{root}' '{root}/loop'"
        );
        live_exec(&ctx, &script).await;
        let t0 = Instant::now();
        let entries = ctx.handle.walk_files(&root).await.expect("remote walk");
        let ms = t0.elapsed().as_millis();
        let files: Vec<&str> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.rel_path.as_str())
            .collect();
        let dirs: Vec<&str> = entries
            .iter()
            .filter(|e| e.is_dir)
            .map(|e| e.rel_path.as_str())
            .collect();
        assert_eq!(files.len(), 104, "文件数应为 104（含跟随的文件链接）");
        assert_eq!(dirs.len(), 6, "目录数应为 6（含空目录与跟随的链接目录）");
        for want in [
            "top.txt",
            "nested/deep/inner.txt",
            "link-file",
            "link-dir/deep/inner.txt",
            "many/f1.txt",
            "many/f100.txt",
        ] {
            assert!(files.contains(&want), "walk 缺少文件 {want}");
        }
        for want in ["nested", "nested/deep", "empty", "many", "link-dir", "link-dir/deep"] {
            assert!(dirs.contains(&want), "walk 缺少目录 {want}");
        }
        assert!(!files.contains(&"broken"), "坏链应跳过");
        assert!(!files.iter().any(|p| p.contains("loop")), "指向根的链接环应跳过");
        let top = entries.iter().find(|e| e.rel_path == "top.txt").expect("top");
        assert_eq!(top.size, 3);
        eprintln!(
            "[walk/remote] entries={} files={} dirs={} elapsed={ms}ms",
            entries.len(),
            files.len(),
            dirs.len()
        );

        // 本地侧：嵌套 + 空目录 + 100 小文件；符号链接可用时验证跟随/跳过。
        let lroot = std::env::temp_dir().join(format!("termx-acc-walk-{tag}"));
        std::fs::create_dir_all(lroot.join("nested").join("deep")).expect("mkdir nested");
        std::fs::create_dir_all(lroot.join("empty")).expect("mkdir empty");
        std::fs::create_dir_all(lroot.join("many")).expect("mkdir many");
        std::fs::write(lroot.join("top.txt"), b"top").expect("write top");
        std::fs::write(lroot.join("nested").join("deep").join("inner.txt"), b"inner")
            .expect("write inner");
        for i in 1..=100 {
            std::fs::write(lroot.join("many").join(format!("f{i}.txt")), b"x").expect("write many");
        }
        let t0 = Instant::now();
        let local = walk_local_dir(lroot.display().to_string())
            .await
            .expect("local walk");
        let lms = t0.elapsed().as_millis();
        let lfiles: Vec<&str> = local
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.rel_path.as_str())
            .collect();
        let ldirs: Vec<&str> = local
            .iter()
            .filter(|e| e.is_dir)
            .map(|e| e.rel_path.as_str())
            .collect();
        assert_eq!(lfiles.len(), 102);
        assert_eq!(ldirs.len(), 4, "本地空目录也应出现在结果中");
        assert!(ldirs.contains(&"empty"));
        eprintln!(
            "[walk/local] entries={} files={} dirs={} elapsed={lms}ms",
            local.len(),
            lfiles.len(),
            ldirs.len()
        );
        #[cfg(windows)]
        {
            let link_file = lroot.join("link-file");
            let link_dir = lroot.join("link-dir");
            let file_ok =
                std::os::windows::fs::symlink_file(lroot.join("top.txt"), &link_file).is_ok();
            let dir_ok =
                std::os::windows::fs::symlink_dir(lroot.join("nested"), &link_dir).is_ok();
            let after = walk_local_dir(lroot.display().to_string())
                .await
                .expect("local walk with links");
            if file_ok {
                assert!(
                    after.iter().any(|e| !e.is_dir && e.rel_path == "link-file"),
                    "本地文件链接应跟随为文件"
                );
            } else {
                eprintln!("[walk/local] 文件符号链接创建无权限，跳过该项验证");
            }
            if dir_ok {
                assert!(
                    !after.iter().any(|e| e.is_dir && e.rel_path == "link-dir"),
                    "上传语义下目录链接应跳过（避免环）"
                );
            } else {
                eprintln!("[walk/local] 目录符号链接创建无权限，跳过该项验证");
            }
        }
        let _ = std::fs::remove_dir_all(&lroot);
        live_exec(&ctx, &format!("rm -rf '{root}'")).await;
    }

    /// 5) chmod 3×3、重命名、新建目录、删除非空目录、复制到已存在目标。
    #[tokio::test]
    async fn live_sftp_fs_ops_remote_and_local() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let ctx = live_ctx().await;
        let (host, _rx) = crate::ssh::test_support::headless_host();
        let tag = uuid::Uuid::new_v4().to_string();
        let root = format!("/tmp/termx-acc-ops-{tag}");
        ctx.handle.mkdir(&root).await.expect("mkdir root");
        let f = format!("{root}/f.txt");
        seed_remote(&ctx.handle, &host, &f, b"v1").await;

        // chmod 3×3：755 / 644 / 600 逐个生效。
        for mode in [0o755u32, 0o644, 0o600] {
            ctx.handle.chmod(&f, mode).await.expect("chmod");
            let st = ctx.handle.stat(&f).await.expect("stat");
            assert_eq!(
                st.permissions.unwrap_or(0) & 0o777,
                mode,
                "chmod {mode:o} 未生效"
            );
        }
        eprintln!("[fsops] chmod 755/644/600 ok");

        // rename：旧路径消失、新路径内容一致。
        let g = format!("{root}/g.txt");
        ctx.handle.rename(&f, &g).await.expect("rename");
        assert!(ctx.handle.stat(&f).await.is_err(), "重命名后旧路径应不存在");
        assert_eq!(remote_content(&ctx.handle, &host, &g).await, b"v1");

        // copy_file：新目标；再覆盖已存在目标。
        let h = format!("{root}/h.txt");
        let copied = ctx.handle.copy_file(&g, &h).await.expect("copy new");
        assert_eq!(copied, 2);
        assert_eq!(remote_content(&ctx.handle, &host, &h).await, b"v1");
        seed_remote(&ctx.handle, &host, &h, b"old-old").await;
        ctx.handle.copy_file(&g, &h).await.expect("copy overwrite");
        assert_eq!(
            remote_content(&ctx.handle, &host, &h).await,
            b"v1",
            "复制到已存在目标应覆盖"
        );

        // 新建目录 + 删除非空目录。
        let d = format!("{root}/d");
        ctx.handle.mkdir(&d).await.expect("mkdir d");
        seed_remote(&ctx.handle, &host, &format!("{d}/child.txt"), b"child").await;
        ctx.handle.remove(&d).await.expect("remove non-empty dir");
        assert!(ctx.handle.stat(&d).await.is_err(), "非空目录应被递归删除");

        // 本地侧：mkdir / rename / 删除非空目录 / 类型过期守卫。
        let lroot = std::env::temp_dir().join(format!("termx-acc-ops-{tag}"));
        crate::commands::localfs::local_mkdir(lroot.join("a").display().to_string())
            .await
            .expect("local mkdir");
        let lf = lroot.join("a").join("f.txt");
        std::fs::write(&lf, b"lv").expect("write lf");
        let lg = lroot.join("a").join("g.txt");
        crate::commands::localfs::local_rename(lf.display().to_string(), lg.display().to_string())
            .await
            .expect("local rename");
        assert!(!lf.exists());
        assert_eq!(std::fs::read(&lg).expect("read lg"), b"lv");
        crate::commands::localfs::local_remove(
            lroot.join("a").display().to_string(),
            Some("file".into()),
        )
        .await
        .expect_err("类型不符应拒绝");
        crate::commands::localfs::local_remove(
            lroot.join("a").display().to_string(),
            Some("directory".into()),
        )
        .await
        .expect("local remove non-empty dir");
        assert!(!lroot.join("a").exists());
        let _ = std::fs::remove_dir_all(&lroot);

        live_exec(&ctx, &format!("rm -rf '{root}'")).await;
    }

    /// 6) 异常文件名：中文 / 空格 / 超长 / 特殊字符；GBK 非法编码实测结论。
    #[tokio::test]
    async fn live_sftp_odd_names() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let ctx = live_ctx().await;
        let (host, _rx) = crate::ssh::test_support::headless_host();
        let tag = uuid::Uuid::new_v4().to_string();
        let root = format!("/tmp/termx-acc-names-{tag}");
        ctx.handle.mkdir(&root).await.expect("mkdir");
        // 长名边界探测：逐长度真实上传，记录 SFTP 服务端实际接受的最大字节数。
        for n in [180usize, 220, 240, 250, 251] {
            let name = format!("{}.txt", "x".repeat(n));
            let r = ctx
                .handle
                .upload(&format!("{root}/{name}"), b"x")
                .await;
            eprintln!(
                "[names/long] {} bytes => {}",
                n + 4,
                match &r {
                    Ok(_) => "ok".to_string(),
                    Err(e) => format!("err {}", e.code()),
                }
            );
            if r.is_ok() {
                let _ = ctx.handle.remove(&format!("{root}/{name}")).await;
            }
        }
        let long_name = format!("{}.txt", "x".repeat(240));
        let names = vec![
            "中文 文件.txt".to_string(),
            "a b.txt".to_string(),
            "!@#$%^&()[]{}'\",;=+?*.txt".to_string(),
            long_name.clone(),
        ];
        for n in &names {
            let p = format!("{root}/{n}");
            seed_remote(&ctx.handle, &host, &p, n.as_bytes()).await;
        }
        let listed = ctx.handle.list_dir(&root).await.expect("list odd names");
        for n in &names {
            assert!(
                listed.iter().any(|e| &e.name == n),
                "列目录缺少文件名 {n}"
            );
        }
        let cn = ctx.handle.download(&format!("{root}/中文 文件.txt")).await.expect("download 中文");
        assert_eq!(cn, "中文 文件.txt".as_bytes());
        eprintln!("[names] 中文/空格/特殊字符/{}字节长名 均真实可用", long_name.len());

        // GBK 原始字节文件名：用远端 shell 构造非 UTF-8 名，观察协议层行为。
        let py = format!(
            "python3 -c \"import os; p=b'{root}/gbk-\\\\xd6\\\\xd0\\\\xce\\\\xc4.txt'; open(p,'wb').close()\""
        );
        let perl = format!(
            "perl -e 'open(my $f, \">\", \"{root}/gbk-\\\\xd6\\\\xd0\\\\xce\\\\xc4.txt\"); close($f)'"
        );
        let out = live_exec(
            &ctx,
            &format!("(command -v python3 >/dev/null 2>&1 && {py}) || ({perl}); ls -1 '{root}'"),
        )
        .await;
        assert!(out.contains("gbk-"), "GBK 原始字节名应已创建：{out}");
        match ctx.handle.list_dir(&root).await {
            Ok(entries) => {
                let gbk = entries.iter().find(|e| e.name.starts_with("gbk-"));
                match gbk {
                    Some(e) => {
                        eprintln!(
                            "[names/GBK] list 返回 name={:?}（含 U+FFFD={}）",
                            e.name,
                            e.name.contains('\u{FFFD}')
                        );
                        // 用该 lossy 名回写操作：必然指向不同字节序列 → 应失败。
                        let err = ctx
                            .handle
                            .download(&format!("{root}/{}", e.name))
                            .await;
                        assert!(err.is_err(), "lossy 名不应能读取原始 GBK 文件");
                        eprintln!(
                            "[names/GBK] 操作 error.code={}",
                            err.err().map(|e| e.code()).unwrap_or("none")
                        );
                    }
                    None => panic!("list 未返回 gbk- 前缀条目"),
                }
            }
            Err(e) => {
                eprintln!("[names/GBK] list_dir 直接失败 code={}", e.code());
            }
        }

        // 队列上传走断点续传路径（先写同目录临时文件再 rename）：255 字节名
        // 若沿用 `<目标>.part` 会让单段名超 255 字节，必须仍能成功。
        let state = live_state(ctx.handle.clone());
        let max_name = format!("{}.txt", "z".repeat(251));
        let local_max = std::env::temp_dir().join(format!("termx-acc-max-{tag}.txt"));
        std::fs::write(&local_max, b"max").expect("write max name source");
        let created = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: local_max.display().to_string(),
                remote_path: format!("{root}/{max_name}"),
                size: 3,
                priority: Default::default(),
            }],
        )
        .await
        .expect("enqueue max name");
        let max_id = created[0].id.clone();
        wait_exact(&state, &max_id, Status::Completed, Duration::from_secs(30)).await;
        assert_eq!(
            remote_content(&ctx.handle, &host, &format!("{root}/{max_name}")).await,
            b"max",
            "255 字节文件名经队列（续传路径）上传后内容应一致"
        );
        let _ = std::fs::remove_file(&local_max);
        eprintln!("[names/queue] {} 字节名经续传路径上传成功", max_name.len());

        // 本地侧异常名（避开 Windows 非法字符）。
        let lroot = std::env::temp_dir().join(format!("termx-acc-names-{tag}"));
        std::fs::create_dir_all(&lroot).expect("local dir");
        let lnames = vec![
            "中文 文件.txt".to_string(),
            "a b.txt".to_string(),
            "!@#$%^&()[]{}'+,;=.txt".to_string(),
            format!("{}.txt", "y".repeat(180)),
        ];
        for n in &lnames {
            std::fs::write(lroot.join(n), n.as_bytes()).expect("write local odd name");
        }
        let walked = walk_local_dir(lroot.display().to_string()).await.expect("local walk names");
        for n in &lnames {
            assert!(
                walked.iter().any(|e| !e.is_dir && &e.rel_path == n),
                "本地 walk 缺少 {n}"
            );
        }
        eprintln!("[names/local] 中文/空格/特殊字符/{}字节长名 均真实可用", lnames[3].len());
        let _ = std::fs::remove_dir_all(&lroot);
        live_exec(&ctx, &format!("rm -rf '{root}'")).await;
    }

    /// 7) 断线：运行中任务标记失败；离线时 resume/retry 明确报错；重连后 retry 从头完成。
    #[tokio::test]
    async fn live_sftp_disconnect_queue_state() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let ctx = live_ctx().await;
        let state = live_state(ctx.handle.clone());
        let (host, _rx) = crate::ssh::test_support::headless_host();
        let tag = uuid::Uuid::new_v4().to_string();
        let dir = format!("/tmp/termx-acc-drop-{tag}");
        ctx.handle.mkdir(&dir).await.expect("mkdir");
        let local_dir = std::env::temp_dir().join(format!("termx-acc-drop-{tag}"));
        std::fs::create_dir_all(&local_dir).expect("local dir");
        let medium = local_dir.join("m32.bin");
        write_sized(&medium, 32 << 20);
        let sha_local_medium = sha_local(&medium);
        let remote = format!("{dir}/m32.bin");

        let created = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: medium.display().to_string(),
                remote_path: remote.clone(),
                size: 32 << 20,
                priority: Default::default(),
            }],
        )
        .await
        .expect("enqueue disconnect");
        let id = created[0].id.clone();
        wait_exact(&state, &id, Status::Running, Duration::from_secs(20)).await;
        let t0 = Instant::now();
        ctx.handle.close_for_test().await;
        let after = wait_terminal(&state, &id, Duration::from_secs(20)).await;
        let ms = t0.elapsed().as_millis();
        assert_eq!(
            after.status,
            Status::Failed,
            "链路断开后运行中任务应标记 Failed（实际 {:?}）",
            after.status
        );
        eprintln!(
            "[disconnect] running→{:?} in {ms}ms error={:?}",
            after.status, after.error
        );

        // 模拟生命周期清理：移除 SFTP 句柄 → snapshot.session_live=false，UI 显示离线。
        state
            .sftp_sessions
            .lock()
            .expect("lock sessions")
            .remove("live");
        tc::pump(&state, &host).expect("pump after drop");
        let snap = tc::list(&state).await.expect("snapshot");
        let item = snap.iter().find(|i| i.id == id).expect("item");
        assert!(!item.session_live, "断线后 session_live 应为 false");

        let err = tc::retry(&state, &host, id.clone()).await.expect_err("retry offline");
        assert_eq!(err.code(), "sftp_resume_session_offline");
        eprintln!("[disconnect] retry offline code={}", err.code());

        // 排队项的暂停/恢复：离线时 resume 必须明确拒绝，不得假装继续。
        std::fs::write(local_dir.join("q.txt"), b"q").expect("q file");
        let q = tc::enqueue(
            &state,
            &host,
            vec![NewTransfer {
                sftp_id: "live".into(),
                direction: Direction::Upload,
                local_path: local_dir.join("q.txt").display().to_string(),
                remote_path: format!("{dir}/q.txt"),
                size: 1,
                priority: Default::default(),
            }],
        )
        .await
        .expect("enqueue offline queued");
        let qid = q[0].id.clone();
        tc::pause(&state, &host, qid.clone()).await.expect("pause queued");
        let err = tc::resume(&state, &host, qid.clone()).await.expect_err("resume offline");
        assert_eq!(err.code(), "sftp_resume_session_offline");
        eprintln!("[disconnect] resume offline code={}", err.code());

        // 重连（新句柄）后 retry 可用：从头传输（checkpoint 已清 0）。
        let ctx2 = live_ctx().await;
        state
            .sftp_sessions
            .lock()
            .expect("lock sessions")
            .insert("live".to_string(), ctx2.handle.clone());
        tc::pump(&state, &host).expect("pump reconnect");
        tc::retry(&state, &host, id.clone())
            .await
            .expect("retry after reconnect");
        let retried = status_of(&state, &id).await.expect("retried item");
        assert_eq!(
            retried.checkpoint, 0,
            "重连重试应从头开始（不支持跨会话续传）"
        );
        wait_exact(&state, &id, Status::Completed, Duration::from_secs(180)).await;
        assert_eq!(
            remote_sha(&ctx2, &remote).await,
            sha_local_medium,
            "重连后重试应完整传输"
        );
        eprintln!("[disconnect] reconnect retry from scratch ok");

        live_exec(&ctx2, &format!("rm -rf '{dir}'")).await;
        let _ = std::fs::remove_dir_all(&local_dir);
    }

    /// 本地 walk 单元（无需 live 环境）：目录条目 + 空目录出现在结果里。
    #[tokio::test]
    async fn walk_local_dir_reports_directories() {
        let tag = uuid::Uuid::new_v4().to_string();
        let root = std::env::temp_dir().join(format!("termx-walk-unit-{tag}"));
        std::fs::create_dir_all(root.join("a").join("b")).expect("mkdir");
        std::fs::create_dir_all(root.join("empty")).expect("mkdir empty");
        std::fs::write(root.join("a").join("b").join("f.txt"), b"x").expect("write");
        let entries = walk_local_dir(root.display().to_string()).await.expect("walk");
        let dirs: Vec<&str> = entries
            .iter()
            .filter(|e| e.is_dir)
            .map(|e| e.rel_path.as_str())
            .collect();
        assert!(dirs.contains(&"a"));
        assert!(dirs.contains(&"a/b"));
        assert!(dirs.contains(&"empty"), "空目录必须出现在结果中");
        assert!(entries.iter().any(|e| !e.is_dir && e.rel_path == "a/b/f.txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

}


