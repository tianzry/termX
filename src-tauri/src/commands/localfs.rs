//! 本地文件系统命令组（SFTP 双栏 B1）。
//!
//! 对齐 Netcatty 的 listLocalDir / statLocal / mkdirLocal / renameLocalFile /
//! deleteLocalFile / readLocalFile / writeLocalFile / getHomeDir / 驱动器列表桥。
//! 与远端 `RemoteEntry` 的差异：本地条目带 `hidden`（"显示隐藏文件"开关用）与
//! `link_target`（链接的目标类型；断链为 None）。owner 不实现——Windows 本地
//! 的所有者列本来就显示 "--"。

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::json;

use crate::error::{AppError, AppResult};

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
