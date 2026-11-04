//! 本地文件系统命令组（SFTP 双栏 B1）。
//!
//! 对齐 Netcatty 的 listLocalDir / statLocal / mkdirLocal / renameLocalFile /
//! deleteLocalFile / readLocalFile / writeLocalFile / getHomeDir / 驱动器列表桥。
//! 与远端 `RemoteEntry` 的差异：本地条目带 `hidden`（"显示隐藏文件"开关用）与
//! `link_target`（链接的目标类型；断链为 None）。owner 不实现——Windows 本地
//! 的所有者列本来就显示 "--"。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::sftp::archive::{build_local_extract_plan, LocalExtractPlan, LocalSpawnPlan};

/// Windows FILE_ATTRIBUTE_HIDDEN。
#[cfg(windows)]
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

#[derive(Debug, Clone, Serialize)]
pub struct LocalEntry {
    pub name: String,
    /// "file" | "directory" | "symlink"
    pub kind: &'static str,
    pub size: u64,
    /// unix epoch 秒；0 表示不可用
    pub mtime: u64,
    /// 符号链接目标的类型（"file" | "directory"）；断链为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    pub hidden: bool,
}

#[tauri::command]
pub async fn local_home() -> AppResult<String> {
    dirs::home_dir()
        .map(|p| p.display().to_string())
        .ok_or_else(|| AppError::other("local_home_unavailable", json!({})))
}

/// Windows 探测 A:-Z: 盘符；非 Windows 返回空数组（主机选择器不渲染驱动器分区）。
#[tauri::command]
pub async fn local_list_drives() -> AppResult<Vec<String>> {
    Ok(list_drives())
}

fn list_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        ('A'..='Z')
            .map(|c| format!("{c}:\\"))
            .filter(|root| Path::new(root).exists())
            .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> AppResult<Vec<LocalEntry>> {
    let dir = PathBuf::from(&path);
    let mut rd = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| io_err("read_dir", &path, e))?;
    let mut out: Vec<LocalEntry> = Vec::new();
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| io_err("read_dir", &path, e))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        // 单条失败（权限/竞态删除）不毁掉整个列表，跳过即可。
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        out.push(entry_from_meta(name, entry.path(), meta, false).await);
    }
    // 目录优先 + 名称大小写不敏感，与远端 list_dir 的排序一致。
    out.sort_by(|a, b| {
        let ad = a.kind == "directory";
        let bd = b.kind == "directory";
        bd.cmp(&ad).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// `follow=true` 走 metadata（跟随链接），`false` 走 symlink_metadata。
#[tauri::command]
pub async fn local_stat(path: String, follow: Option<bool>) -> AppResult<LocalEntry> {
    let p = PathBuf::from(&path);
    let follow = follow.unwrap_or(true);
    let meta = if follow {
        tokio::fs::metadata(&p).await
    } else {
        tokio::fs::symlink_metadata(&p).await
    }
    .map_err(|e| io_err("stat", &path, e))?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Ok(entry_from_meta(name, p, meta, follow).await)
}

/// canonicalize 后去掉 Windows 的 `\\?\` 扩展前缀，返回可展示路径。
#[tauri::command]
pub async fn local_realpath(path: String) -> AppResult<String> {
    let p = PathBuf::from(&path);
    let canon = tokio::fs::canonicalize(&p)
        .await
        .map_err(|e| io_err("realpath", &path, e))?;
    Ok(strip_extended_prefix(&canon))
}

/// Windows canonicalize 返回 verbatim 路径（`\\?\C:\...` / `\\?\UNC\server\...`），
/// UI 需要普通形态。非 Windows 原样返回。
fn strip_extended_prefix(p: &Path) -> String {
    let s = p.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> AppResult<()> {
    tokio::fs::create_dir_all(PathBuf::from(&path))
        .await
        .map_err(|e| io_err("mkdir", &path, e))
}

#[tauri::command]
pub async fn local_rename(old_path: String, new_path: String) -> AppResult<()> {
    tokio::fs::rename(&old_path, &new_path)
        .await
        .map_err(|e| io_err("rename", &old_path, e))
}

/// 删除文件或目录树。`expected_type` 是前端列表里的类型；与 lstat 结果不符
/// 说明列表过期，报 `local_type_stale` 让 UI 刷新后重试，避免误删。
/// 符号链接视为通配（前端可能按目标类型归类）。
#[tauri::command]
pub async fn local_remove(path: String, expected_type: Option<String>) -> AppResult<()> {
    let p = PathBuf::from(&path);
    let meta = tokio::fs::symlink_metadata(&p)
        .await
        .map_err(|e| io_err("remove", &path, e))?;
    let actual = if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "directory"
    } else {
        "file"
    };
    if let Some(expected) = expected_type.as_deref() {
        if expected != actual && actual != "symlink" {
            return Err(AppError::other(
                "local_type_stale",
                json!({ "path": path, "expected": expected, "actual": actual }),
            ));
        }
    }
    let res = if meta.is_dir() {
        tokio::fs::remove_dir_all(&p).await
    } else if meta.file_type().is_symlink() {
        // Windows 上指向目录的符号链接必须 remove_dir 删除；先试 remove_file。
        match tokio::fs::remove_file(&p).await {
            Ok(()) => Ok(()),
            Err(_) => tokio::fs::remove_dir(&p).await,
        }
    } else {
        tokio::fs::remove_file(&p).await
    };
    res.map_err(|e| io_err("remove", &path, e))
}

/// `max_bytes` 缺省时的读取上限：防止巨型文件整体读入内存并经 IPC 序列化
/// 打爆前端（JSON 数字数组约 4× 膨胀）。
const DEFAULT_READ_CAP: u64 = 16 << 20; // 16 MiB

/// 计算读取前跳过的字节数：文件大于上限时读**尾部**。
fn read_skip(len: u64, max_bytes: Option<u64>) -> u64 {
    len.saturating_sub(max_bytes.unwrap_or(DEFAULT_READ_CAP))
}

/// 读本地文件。`max_bytes` 小于文件大小时读**尾部**（编辑器预览大文件）；
/// 缺省按 16 MiB 上限同样读尾部，避免大文件打爆内存/IPC。
#[tauri::command]
pub async fn local_read_file(path: String, max_bytes: Option<u64>) -> AppResult<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let p = PathBuf::from(&path);
    let mut f = tokio::fs::File::open(&p)
        .await
        .map_err(|e| io_err("read", &path, e))?;
    let len = f
        .metadata()
        .await
        .map_err(|e| io_err("read", &path, e))?
        .len();
    let skip = read_skip(len, max_bytes);
    if skip > 0 {
        f.seek(std::io::SeekFrom::Start(skip))
            .await
            .map_err(|e| io_err("read", &path, e))?;
    }
    // 预分配封顶 1MiB，防止声明大小巨大的文件直接吃满内存。
    let mut buf = Vec::with_capacity((len - skip).min(1 << 20) as usize);
    f.read_to_end(&mut buf)
        .await
        .map_err(|e| io_err("read", &path, e))?;
    Ok(buf)
}

#[tauri::command]
pub async fn local_write_file(path: String, data: Vec<u8>) -> AppResult<()> {
    tokio::fs::write(PathBuf::from(&path), &data)
        .await
        .map_err(|e| io_err("write", &path, e))
}

/// 用系统默认程序打开文件（Netcatty openPath 等价物，外部编辑器入口）。
/// 本地直接打开；远端先经 `sftp_open_external` 落到临时目录再复用本逻辑。
#[tauri::command]
pub async fn local_open_path(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    if !tokio::fs::try_exists(&p).await.unwrap_or(false) {
        return Err(io_err(
            "open",
            &path,
            std::io::Error::new(std::io::ErrorKind::NotFound, "路径不存在"),
        ));
    }
    open_with_system(&p).map_err(|e| io_err("open", &path, e))
}

/// 本地归档原地解压（#31）：解压到归档所在目录，语义对齐 Netcatty
/// `extractLocalArchiveFile`（tar 系走系统 tar、zip 走 tar/unzip、单文件
/// gz 内置 zlib、bz2/xz 走外部解码器）。所有进程都用参数数组，不经 shell。
#[tauri::command]
pub async fn local_extract_archive(path: String) -> AppResult<()> {
    let archive = PathBuf::from(&path);
    // 只接受已存在的普通文件；目录 / 断链 / 不存在一律拒绝。
    let meta = tokio::fs::metadata(&archive)
        .await
        .map_err(|e| io_err("extract", &path, e))?;
    if !meta.is_file() {
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": "extraction target is not a regular file" }),
        ));
    }
    let plan = build_local_extract_plan(&path, current_platform())?;
    run_local_extract_plan(plan).await
}

fn current_platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// 外部解压进程超时：120s（本地磁盘 + 系统解压器，远超常规归档耗时）。
const LOCAL_EXTRACT_TIMEOUT: Duration = Duration::from_secs(120);
/// stderr 回传上限：避免巨型输出经 IPC 打爆前端。
const LOCAL_EXTRACT_STDERR_CAP: usize = 16 * 1024;

async fn run_local_extract_plan(plan: LocalExtractPlan) -> AppResult<()> {
    match plan {
        LocalExtractPlan::Spawn { primary, fallback } => {
            match run_local_spawn(&primary).await {
                // 与 Netcatty 一致：首个二进制缺失时回退（unzip → tar）。
                Err(err) if err.code() == "local_extract_binary_missing" => match fallback {
                    Some(fallback) => run_local_spawn(&fallback).await,
                    None => Err(err),
                },
                other => other,
            }
        }
        LocalExtractPlan::Gunzip { archive, output } => {
            tokio::task::spawn_blocking(move || gunzip_to_file(&archive, &output))
                .await
                .map_err(|e| {
                    AppError::other("local_extract_failed", json!({ "err": e.to_string() }))
                })?
        }
        LocalExtractPlan::PipeToFile {
            command,
            archive,
            output,
        } => pipe_decode_to_file(&command, &archive, &output).await,
    }
}

async fn run_local_spawn(plan: &LocalSpawnPlan) -> AppResult<()> {
    let mut child = tokio::process::Command::new(&plan.command)
        .args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| local_extract_spawn_err(&plan.command, e))?;
    let stderr_reader = tokio::spawn(read_stderr_capped(child.stderr.take()));
    match tokio::time::timeout(LOCAL_EXTRACT_TIMEOUT, child.wait()).await {
        Err(_) => {
            let _ = child.start_kill();
            Err(local_extract_timeout_err())
        }
        Ok(Ok(status)) => {
            let stderr = stderr_reader.await.unwrap_or_default();
            if status.success() {
                Ok(())
            } else {
                Err(AppError::other(
                    "local_extract_failed",
                    json!({ "exitCode": status.code(), "stderr": stderr.trim() }),
                ))
            }
        }
        Ok(Err(e)) => {
            drop(stderr_reader);
            Err(AppError::other(
                "local_extract_failed",
                json!({ "err": e.to_string() }),
            ))
        }
    }
}

/// 读取子进程 stderr，超过上限后继续排空但不保留（避免管道写满阻塞）。
async fn read_stderr_capped(mut stderr: Option<tokio::process::ChildStderr>) -> String {
    let mut bytes: Vec<u8> = Vec::new();
    let Some(stream) = stderr.as_mut() else {
        return String::new();
    };
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if bytes.len() < LOCAL_EXTRACT_STDERR_CAP {
                    let room = LOCAL_EXTRACT_STDERR_CAP - bytes.len();
                    bytes.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `bzip2 -dc` / `xz -dc` 的 stdout 先写 staging 文件，成功后再改名，
/// 失败 / 超时时只删 staging，不破坏已存在的目标文件。
async fn pipe_decode_to_file(command: &str, archive: &Path, output: &Path) -> AppResult<()> {
    let staging = staging_path(output);
    let mut child = tokio::process::Command::new(command)
        .arg("-dc")
        .arg(archive)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| local_extract_spawn_err(command, e))?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": "decoder stdout unavailable" }),
        ));
    };
    let stderr_reader = tokio::spawn(read_stderr_capped(child.stderr.take()));
    let mut out = match tokio::fs::File::create(&staging).await {
        Ok(file) => file,
        Err(e) => {
            let _ = child.start_kill();
            drop(stderr_reader);
            return Err(AppError::other(
                "local_extract_failed",
                json!({ "err": e.to_string() }),
            ));
        }
    };

    let work = async {
        let copied = async {
            tokio::io::copy(&mut stdout, &mut out).await?;
            out.flush().await?;
            Ok::<(), std::io::Error>(())
        }
        .await;
        let status = child.wait().await;
        (copied, status)
    };
    let (copied, status) = match tokio::time::timeout(LOCAL_EXTRACT_TIMEOUT, work).await {
        Err(_) => {
            let _ = child.start_kill();
            drop(out);
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(local_extract_timeout_err());
        }
        Ok(pair) => pair,
    };
    let stderr = stderr_reader.await.unwrap_or_default();
    drop(out);

    if let Err(e) = copied {
        let _ = tokio::fs::remove_file(&staging).await;
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": e.to_string() }),
        ));
    }
    match status {
        Ok(status) if status.success() => publish_staged_file(&staging, output).await,
        Ok(status) => {
            let _ = tokio::fs::remove_file(&staging).await;
            Err(AppError::other(
                "local_extract_failed",
                json!({ "exitCode": status.code(), "stderr": stderr.trim() }),
            ))
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&staging).await;
            Err(AppError::other(
                "local_extract_failed",
                json!({ "err": e.to_string() }),
            ))
        }
    }
}

/// 单文件 `.gz` 解压（内置 zlib，不依赖系统 gzip）。阻塞 IO 放在
/// `spawn_blocking` 里跑，避免占用 async worker。
fn gunzip_to_file(archive: &Path, output: &Path) -> AppResult<()> {
    use flate2::read::GzDecoder;
    use std::io::{Read, Write};

    let staging = staging_path(output);
    let deadline = std::time::Instant::now() + LOCAL_EXTRACT_TIMEOUT;
    let decoded = (|| -> std::io::Result<()> {
        let mut decoder = GzDecoder::new(std::fs::File::open(archive)?);
        let mut dst = std::fs::File::create(&staging)?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            if std::time::Instant::now() > deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "local extraction timed out",
                ));
            }
            let read = decoder.read(&mut buf)?;
            if read == 0 {
                break;
            }
            dst.write_all(&buf[..read])?;
        }
        dst.flush()
    })();
    if let Err(e) = decoded {
        let _ = std::fs::remove_file(&staging);
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": e.to_string() }),
        ));
    }
    publish_staged_file_sync(&staging, output)
}

/// staging 文件与目标同目录（`name.termx-extract.<uuid>`），改名是原子发布。
fn staging_path(output: &Path) -> PathBuf {
    let suffix = format!(".termx-extract.{}", uuid::Uuid::new_v4());
    match output.file_name().and_then(|n| n.to_str()) {
        Some(name) => output.with_file_name(format!("{name}{suffix}")),
        None => output.with_file_name(format!("extract{suffix}")),
    }
}

/// 目标已是目录时拒绝覆盖（mkdir 同名等）；否则原子改名。
async fn publish_staged_file(staging: &Path, output: &Path) -> AppResult<()> {
    let dest_is_dir = matches!(
        tokio::fs::symlink_metadata(output).await,
        Ok(meta) if meta.is_dir()
    );
    if dest_is_dir {
        let _ = tokio::fs::remove_file(staging).await;
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": "extraction target is a directory" }),
        ));
    }
    if let Err(e) = tokio::fs::rename(staging, output).await {
        let _ = tokio::fs::remove_file(staging).await;
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": e.to_string() }),
        ));
    }
    Ok(())
}

fn publish_staged_file_sync(staging: &Path, output: &Path) -> AppResult<()> {
    let dest_is_dir = std::fs::symlink_metadata(output)
        .map(|meta| meta.is_dir())
        .unwrap_or(false);
    if dest_is_dir {
        let _ = std::fs::remove_file(staging);
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": "extraction target is a directory" }),
        ));
    }
    if let Err(e) = std::fs::rename(staging, output) {
        let _ = std::fs::remove_file(staging);
        return Err(AppError::other(
            "local_extract_failed",
            json!({ "err": e.to_string() }),
        ));
    }
    Ok(())
}

fn local_extract_spawn_err(command: &str, err: std::io::Error) -> AppError {
    if err.kind() == std::io::ErrorKind::NotFound {
        AppError::other(
            "local_extract_binary_missing",
            json!({ "binary": command }),
        )
    } else {
        AppError::other(
            "local_extract_failed",
            json!({ "err": err.to_string() }),
        )
    }
}

fn local_extract_timeout_err() -> AppError {
    AppError::other(
        "local_extract_failed",
        json!({ "err": format!("timed out after {} ms", LOCAL_EXTRACT_TIMEOUT.as_millis()) }),
    )
}

/// 以系统默认程序启动：Windows `cmd /C start`、macOS `open`、其他 Unix `xdg-open`。
/// spawn 只拉起调度器，不等待子进程。
pub fn open_with_system(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        // `start` 的第一个带引号参数会被当作窗口标题，先传空标题占位。
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(path).spawn()?;
    }
    Ok(())
}

/// 系统临时目录下生成唯一临时文件路径（termX-external 子目录）：
/// 远端文件下载后外部打开使用；前端记录该路径供后续「保存后回传」或提示。
pub fn external_temp_path(name: &str) -> PathBuf {
    let safe: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::env::temp_dir()
        .join("termX-external")
        .join(format!("{uniq}-{safe}"))
}

// ── 内部辅助 ─────────────────────────────────────────────

/// 由 lstat/stat 元数据构建条目。`follow=false` 且条目是链接时，跟随一次
/// 获取目标类型与大小；断链保留链接自身大小、`link_target=None`。
async fn entry_from_meta(
    name: String,
    path: PathBuf,
    meta: std::fs::Metadata,
    follow: bool,
) -> LocalEntry {
    let ft = meta.file_type();
    // 先算好借用 `name` 的字段，避免结构体字面量里 move 后再借用。
    let hidden = is_hidden(&name, &meta);
    let mtime = mtime_secs(&meta);
    if ft.is_symlink() && !follow {
        let (link_target, size) = match symlink_target_info(&path).await {
            Some((kind, size)) => (Some(kind), size),
            None => (None, meta.len()),
        };
        return LocalEntry {
            name,
            kind: "symlink",
            size,
            mtime,
            link_target,
            hidden,
        };
    }
    LocalEntry {
        name,
        kind: if ft.is_dir() { "directory" } else { "file" },
        size: if ft.is_dir() { 0 } else { meta.len() },
        mtime,
        link_target: None,
        hidden,
    }
}

/// 跟随符号链接一次，取目标类型与大小。断链 → None。
async fn symlink_target_info(path: &Path) -> Option<(String, u64)> {
    let m = tokio::fs::metadata(path).await.ok()?;
    let kind = if m.is_dir() { "directory" } else { "file" };
    Some((kind.to_string(), m.len()))
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let _ = name;
        meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        name.starts_with('.')
    }
}

fn io_err(op: &'static str, path: &str, e: std::io::Error) -> AppError {
    AppError::other(
        "local_io_failed",
        json!({ "op": op, "path": path, "err": e.to_string() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!("termx_localfs_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn strip_extended_prefix_variants() {
        assert_eq!(strip_extended_prefix(Path::new(r"C:\x\y")), r"C:\x\y");
        assert_eq!(strip_extended_prefix(Path::new(r"\\?\C:\x")), r"C:\x");
        assert_eq!(
            strip_extended_prefix(Path::new(r"\\?\UNC\server\share")),
            r"\\server\share"
        );
    }

    #[test]
    fn read_skip_tail_and_default_cap() {
        assert_eq!(read_skip(5, None), 0);
        assert_eq!(read_skip(DEFAULT_READ_CAP + 10, None), 10);
        assert_eq!(read_skip(100, Some(30)), 70);
        assert_eq!(read_skip(10, Some(30)), 0);
    }

    #[tokio::test]
    async fn localfs_roundtrip() {
        let root = tmp_root();
        let dir = root.join("sub");
        local_mkdir(dir.display().to_string()).await.unwrap();
        let file = dir.join("a.txt");
        local_write_file(file.display().to_string(), b"hello".to_vec())
            .await
            .unwrap();

        let list = local_list_dir(dir.display().to_string()).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "a.txt");
        assert_eq!(list[0].kind, "file");
        assert_eq!(list[0].size, 5);
        assert!(list[0].mtime > 0);

        // 目录优先：再建一个以字母序更靠后的目录，列表首项仍应是目录。
        local_mkdir(root.join("zz").display().to_string())
            .await
            .unwrap();
        let list = local_list_dir(root.display().to_string()).await.unwrap();
        assert_eq!(list[0].kind, "directory");

        let st = local_stat(file.display().to_string(), None).await.unwrap();
        assert_eq!(st.size, 5);

        let renamed = dir.join("b.txt");
        local_rename(file.display().to_string(), renamed.display().to_string())
            .await
            .unwrap();
        assert!(local_stat(file.display().to_string(), None).await.is_err());

        // max_bytes 小于文件 → 读尾部
        let tail = local_read_file(renamed.display().to_string(), Some(2))
            .await
            .unwrap();
        assert_eq!(tail, b"lo");
        // 不传 max_bytes → 读全文
        let all = local_read_file(renamed.display().to_string(), None)
            .await
            .unwrap();
        assert_eq!(all, b"hello");

        // 类型守卫：把文件当目录删 → local_type_stale
        let e = local_remove(renamed.display().to_string(), Some("directory".to_string()))
            .await
            .unwrap_err();
        assert!(e.to_string().contains("local_type_stale"));

        local_remove(renamed.display().to_string(), Some("file".to_string()))
            .await
            .unwrap();
        local_remove(dir.display().to_string(), None).await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn list_drives_shape() {
        let drives = local_list_drives().await.unwrap();
        #[cfg(windows)]
        assert!(!drives.is_empty());
        #[cfg(not(windows))]
        assert!(drives.is_empty());
    }
}
