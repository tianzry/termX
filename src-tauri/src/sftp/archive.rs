//! 远端归档解压（#24）：格式识别 + 远程命令构造。
//!
//! 对齐 Netcatty `electron/bridges/sftpBridge/archiveExtract.cjs` 的
//! `buildExtractCommand`：归档在当前目录原地解压，依赖远端已有工具
//! （tar / unzip / gzip / bzip2 / xz），不额外捆绑解压二进制。
//! 单文件压缩（.gz/.bz2/.xz）解码到同名去后缀文件，先写临时文件再原子替换。
//!
//! 仅支持父级为 SSH 会话的 SFTP（需要 exec 通道）；独立 SFTP 连接由命令层拒绝。

use std::time::Duration;

use crate::error::{AppError, AppResult};

const BASE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    Tar,
    TarGz,
    TarBz2,
    TarXz,
    TarZst,
    Zip,
    Gz,
    Bz2,
    Xz,
}

/// 按文件名后缀识别（大小写不敏感；`.tar.gz` 优先于 `.gz`）。
pub fn detect(path: &str) -> Option<ArchiveKind> {
    let base = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    for (kind, suffixes) in [
        (ArchiveKind::TarGz, &[".tar.gz", ".tgz"][..]),
        (ArchiveKind::TarBz2, &[".tar.bz2", ".tbz2", ".tar.bzip2"][..]),
        (ArchiveKind::TarXz, &[".tar.xz", ".txz"][..]),
        (ArchiveKind::TarZst, &[".tar.zst", ".tzst"][..]),
        (ArchiveKind::Tar, &[".tar"][..]),
        (ArchiveKind::Zip, &[".zip"][..]),
        (ArchiveKind::Gz, &[".gz"][..]),
        (ArchiveKind::Bz2, &[".bz2"][..]),
        (ArchiveKind::Xz, &[".xz"][..]),
    ] {
        if suffixes
            .iter()
            .any(|s| base.ends_with(s) && base.len() > s.len())
        {
            return Some(kind);
        }
    }
    None
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 归档所在目录（POSIX）：`/a/b.zip` → `/a`，`/x.zip` → `/`，`x.zip` → `.`。
fn parent_dir(path: &str) -> AppResult<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return Err(AppError::sftp("sftp_extract_invalid_path", serde_json::json!({})));
    }
    match trimmed.rfind('/') {
        None => Ok(".".to_string()),
        Some(0) => Ok("/".to_string()),
        Some(idx) => Ok(trimmed[..idx].to_string()),
    }
}

/// 单文件压缩的输出路径：同目录，去掉压缩后缀。
fn stripped_output(path: &str, kind: ArchiveKind) -> AppResult<String> {
    let suffix = match kind {
        ArchiveKind::Gz => ".gz",
        ArchiveKind::Bz2 => ".bz2",
        ArchiveKind::Xz => ".xz",
        _ => return Err(AppError::sftp("sftp_extract_unsupported", serde_json::json!({}))),
    };
    let base = path.rsplit('/').next().unwrap_or(path);
    if base.len() <= suffix.len() || !base.to_lowercase().ends_with(suffix) {
        return Err(AppError::sftp("sftp_extract_invalid_path", serde_json::json!({})));
    }
    let stem = &base[..base.len() - suffix.len()];
    let parent = parent_dir(path)?;
    Ok(match parent.as_str() {
        "/" => format!("/{stem}"),
        "." => stem.to_string(),
        dir => format!("{dir}/{stem}"),
    })
}

/// 构造远端解压命令。路径整体单引号转义，避免空格 / 引号注入。
pub fn build_extract_command(path: &str) -> AppResult<String> {
    let kind = detect(path).ok_or_else(|| {
        AppError::sftp(
            "sftp_extract_unsupported",
            serde_json::json!({ "path": path }),
        )
    })?;
    let parent = parent_dir(path)?;
    let q_archive = shell_quote(path);
    let q_parent = shell_quote(&parent);

    let command = match kind {
        ArchiveKind::Tar => format!("tar -xf {q_archive} -C {q_parent}"),
        ArchiveKind::TarGz => format!("tar -xzf {q_archive} -C {q_parent}"),
        ArchiveKind::TarBz2 => format!("tar -xjf {q_archive} -C {q_parent}"),
        ArchiveKind::TarXz => format!("tar -xJf {q_archive} -C {q_parent}"),
        ArchiveKind::TarZst => format!("tar --zstd -xf {q_archive} -C {q_parent}"),
        ArchiveKind::Zip => [
            "if command -v unzip >/dev/null 2>&1; then".to_string(),
            format!("  unzip -qo {q_archive} -d {q_parent} >/dev/null"),
            format!("elif tar -tf {q_archive} >/dev/null 2>&1; then"),
            format!("  tar -xf {q_archive} -C {q_parent}"),
            "else".to_string(),
            "  echo 'unzip is not installed on the remote host' >&2".to_string(),
            "  exit 127".to_string(),
            "fi".to_string(),
        ]
        .join("\n"),
        ArchiveKind::Gz | ArchiveKind::Bz2 | ArchiveKind::Xz => {
            let decoder = match kind {
                ArchiveKind::Gz => "gzip",
                ArchiveKind::Bz2 => "bzip2",
                _ => "xz",
            };
            let out = stripped_output(path, kind)?;
            let q_out = shell_quote(&out);
            [
                "set -e".to_string(),
                format!("out={q_out}"),
                "tmp=\"$out.termx-extract.$$\"".to_string(),
                "trap 'rm -f -- \"$tmp\"' EXIT".to_string(),
                format!("{decoder} -dc -- {q_archive} > \"$tmp\""),
                "if [ -d \"$out\" ]; then".to_string(),
                "  echo 'extraction target is a directory' >&2".to_string(),
                "  exit 1".to_string(),
                "fi".to_string(),
                "mv -f -- \"$tmp\" \"$out\"".to_string(),
                "trap - EXIT".to_string(),
            ]
            .join("\n")
        }
    };
    Ok(command)
}

/// 解压超时：60s 起步，每 10 MiB 加 30s，封顶 10 分钟（对齐 Netcatty）。
pub fn compute_timeout(size: u64) -> Duration {
    let extra = size.div_ceil(10 * 1024 * 1024) * 30;
    BASE_TIMEOUT + Duration::from_secs(extra).min(MAX_TIMEOUT - BASE_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_suffixes_case_insensitively() {
        assert_eq!(detect("/a/b.TAR.GZ"), Some(ArchiveKind::TarGz));
        assert_eq!(detect("x.tgz"), Some(ArchiveKind::TarGz));
        assert_eq!(detect("x.tar.bz2"), Some(ArchiveKind::TarBz2));
        assert_eq!(detect("x.tar.xz"), Some(ArchiveKind::TarXz));
        assert_eq!(detect("x.tar.zst"), Some(ArchiveKind::TarZst));
        assert_eq!(detect("x.tar"), Some(ArchiveKind::Tar));
        assert_eq!(detect("x.zip"), Some(ArchiveKind::Zip));
        assert_eq!(detect("x.gz"), Some(ArchiveKind::Gz));
        assert_eq!(detect("x.bz2"), Some(ArchiveKind::Bz2));
        assert_eq!(detect("x.xz"), Some(ArchiveKind::Xz));
        assert_eq!(detect("x.txt"), None);
        assert_eq!(detect("archive.tar.gz.bak"), None);
    }

    #[test]
    fn builds_commands_with_parent_dir_and_quotes() {
        let cmd = build_extract_command("/tmp/a b/it's.tar.gz").unwrap();
        assert_eq!(cmd, "tar -xzf '/tmp/a b/it'\\''s.tar.gz' -C '/tmp/a b'");
        assert_eq!(
            build_extract_command("/x.zip").unwrap().lines().count(),
            8
        );
        assert!(build_extract_command("/x.zip").unwrap().contains("unzip -qo '/x.zip' -d '/'"));
        assert!(build_extract_command("x.tar").unwrap().ends_with("-C '.'"));
    }

    #[test]
    fn single_file_compression_strips_suffix_and_stages() {
        let cmd = build_extract_command("/data/log.txt.gz").unwrap();
        assert!(cmd.contains("out='/data/log.txt'"));
        assert!(cmd.contains("gzip -dc -- '/data/log.txt.gz'"));
        assert!(cmd.contains("mv -f -- \"$tmp\" \"$out\""));
        assert!(cmd.contains("trap 'rm -f -- \"$tmp\"' EXIT"));
    }

    #[test]
    fn rejects_unsupported_and_rootless_paths() {
        assert!(build_extract_command("/a/readme.txt").is_err());
        assert!(build_extract_command("/").is_err());
        assert!(detect("/a/x.zip").is_some());
        assert!(detect("/a/x.iso").is_none());
    }

    #[test]
    fn timeout_scales_with_size_and_caps() {
        assert_eq!(compute_timeout(0), Duration::from_secs(60));
        assert_eq!(compute_timeout(10 * 1024 * 1024), Duration::from_secs(90));
        assert_eq!(compute_timeout(500 * 1024 * 1024), Duration::from_secs(600));
    }
}
