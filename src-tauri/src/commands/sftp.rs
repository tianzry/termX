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
    let handle = crate::ssh::client::run_blocking_ssh(move || async move {
        SftpHandle::connect(host, port, cred, known_hosts_path, timeout_secs, proxy).await
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
            let meta = entry.metadata().await?;
            if meta.is_dir() {
                queue.push_back((path, depth + 1));
            } else if meta.is_file() {
                result.push(WalkEntry {
                    rel_path: rel_unix(&path, &root),
                    size: meta.len(),
                });
            } else if meta.is_symlink() {
                // Follow once to learn what the target is. Skip symlink-to-dir
                // to avoid cycles, and silently skip broken symlinks.
                if let Ok(target_meta) = tokio::fs::metadata(&path).await {
                    if target_meta.is_file() {
                        result.push(WalkEntry {
                            rel_path: rel_unix(&path, &root),
                            size: target_meta.len(),
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
    )
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
        crate::ssh::client::exec_once(&ssh, &command, timeout).await
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

    /// 真实远端主机的文件操作全链路（默认档案 "129"）：
    /// 连接 → mkdir → upload → list/stat → rename → chmod → download 比对 → remove → rmdir。
    /// 仅当 TERMX_SFTP_LIVE=1 时运行：依赖真实网络 + 本机 keychain（读取与应用相同的
    /// ~/.rssh DB / SecretStore 凭据），不纳入默认 `cargo test --lib` 门禁。
    #[tokio::test]
    async fn live_sftp_file_ops_roundtrip() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let name = std::env::var("TERMX_SFTP_LIVE_PROFILE").unwrap_or_else(|_| "129".into());
        let data_dir = dirs::home_dir().expect("home dir").join(".rssh");
        let db = Arc::new(crate::db::Db::open(&data_dir).expect("open ~/.rssh db"));
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
        let handle =
            SftpHandle::connect(profile.host, profile.port, cred, known_hosts, 15, None)
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
    /// 与 roundtrip 相同门禁：仅 TERMX_SFTP_LIVE=1，凭据取自 ~/.rssh DB +
    /// SecretStore（与应用同路径），密码不落明文、不进日志。
    #[tokio::test]
    async fn live_sftp_transfer_conflict() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let name = std::env::var("TERMX_SFTP_LIVE_PROFILE").unwrap_or_else(|_| "129".into());
        let data_dir = dirs::home_dir().expect("home dir").join(".rssh");
        let db = Arc::new(crate::db::Db::open(&data_dir).expect("open ~/.rssh db"));
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
            SftpHandle::connect(profile.host, profile.port, cred, known_hosts, 15, None)
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
    /// 凭据同走 ~/.rssh DB + SecretStore，密码不落明文；测后清理远端临时目录。
    #[tokio::test]
    async fn live_sftp_editor_read_write_guards() {
        if std::env::var("TERMX_SFTP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let name = std::env::var("TERMX_SFTP_LIVE_PROFILE").unwrap_or_else(|_| "129".into());
        let data_dir = dirs::home_dir().expect("home dir").join(".rssh");
        let db = Arc::new(crate::db::Db::open(&data_dir).expect("open ~/.rssh db"));
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
        let handle =
            SftpHandle::connect(profile.host, profile.port, cred, known_hosts, 15, None)
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
}
