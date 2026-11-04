//! 远端归档解压（#24）：格式识别 + 远程命令构造。
//!
//! 对齐 Netcatty `electron/bridges/sftpBridge/archiveExtract.cjs` 的
//! `buildExtractCommand`：归档在当前目录原地解压，依赖远端已有工具
//! （tar / unzip / gzip / bzip2 / xz），不额外捆绑解压二进制。
//! 单文件压缩（.gz/.bz2/.xz）解码到同名去后缀文件，先写临时文件再原子替换。
//!
//! 仅支持父级为 SSH 会话的 SFTP（需要 exec 通道）；独立 SFTP 连接由命令层拒绝。

use std::path::{Path, PathBuf};
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

// ── 本地归档解压（#31 本地压缩包快捷解压）────────────────────
//
// 对齐 Netcatty `archiveExtract.cjs` 的 `buildLocalExtractPlan`：本地原地
// 解压到归档所在目录，绝不经过 shell 拼接（进程参数是数组），因此带空格 /
// 单引号的路径无需转义。远端 `build_extract_command` 保持原样。

/// 本地解压外部进程（tar / unzip / bzip2 / xz）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSpawnPlan {
    pub command: String,
    pub args: Vec<String>,
}

/// 本地解压计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalExtractPlan {
    /// 直接执行解压进程；`fallback` 在首个二进制缺失时使用（unzip → tar）。
    Spawn {
        primary: LocalSpawnPlan,
        fallback: Option<LocalSpawnPlan>,
    },
    /// 单文件 `.gz`：内置 zlib 解码到 `output`。
    Gunzip { archive: PathBuf, output: PathBuf },
    /// 单文件 `.bz2` / `.xz`：外部解码器 stdout 写入 `output`（先 staging 再改名）。
    PipeToFile {
        command: String,
        archive: PathBuf,
        output: PathBuf,
    },
}

/// 本地父目录：`C:/a/b.zip` → `C:/a`；无父级（`x.zip`）→ `.`。
fn local_parent(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// 单文件压缩的输出路径：同目录下去掉压缩后缀。语义与 `stripped_output`
/// 一致，但走 `std::path`（Windows 反斜杠路径也能正确取文件名）。
fn local_stripped_output(path: &Path, kind: ArchiveKind) -> AppResult<PathBuf> {
    let suffix = match kind {
        ArchiveKind::Gz => ".gz",
        ArchiveKind::Bz2 => ".bz2",
        ArchiveKind::Xz => ".xz",
        _ => {
            return Err(AppError::other(
                "local_extract_unsupported",
                serde_json::json!({ "path": path.display().to_string() }),
            ))
        }
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if name.len() <= suffix.len() || !name.to_lowercase().ends_with(suffix) {
        return Err(AppError::other(
            "local_extract_failed",
            serde_json::json!({ "err": "archive name does not match compression suffix" }),
        ));
    }
    let parent = local_parent(path);
    let stem = &name[..name.len() - suffix.len()];
    // 与远端 `stripped_output` 一致：无父级时直接输出裸文件名，避免 "./x"。
    Ok(if parent == Path::new(".") {
        PathBuf::from(stem)
    } else {
        parent.join(stem)
    })
}

/// 构造本地解压计划。`platform` 用于 zip 分支（Windows 走 `tar -xf`，
/// 其他平台优先 `unzip -qo`、缺失时回退 `tar`），测试可显式传入。
pub fn build_local_extract_plan(path: &str, platform: &str) -> AppResult<LocalExtractPlan> {
    let archive = Path::new(path);
    let kind = detect(path).ok_or_else(|| {
        AppError::other(
            "local_extract_unsupported",
            serde_json::json!({ "path": path }),
        )
    })?;
    let parent = local_parent(archive).display().to_string();
    let path_str = path.to_string();

    let tar = |flag: &str| LocalSpawnPlan {
        command: "tar".to_string(),
        args: vec![flag.to_string(), path_str.clone(), "-C".to_string(), parent.clone()],
    };
    let plan = match kind {
        ArchiveKind::Tar => tar("-xf"),
        ArchiveKind::TarGz => tar("-xzf"),
        ArchiveKind::TarBz2 => tar("-xjf"),
        ArchiveKind::TarXz => tar("-xJf"),
        ArchiveKind::TarZst => LocalSpawnPlan {
            command: "tar".to_string(),
            args: vec![
                "--zstd".to_string(),
                "-xf".to_string(),
                path_str.clone(),
                "-C".to_string(),
                parent.clone(),
            ],
        },
        ArchiveKind::Zip => {
            if platform == "windows" {
                return Ok(LocalExtractPlan::Spawn {
                    primary: tar("-xf"),
                    fallback: None,
                });
            }
            return Ok(LocalExtractPlan::Spawn {
                primary: LocalSpawnPlan {
                    command: "unzip".to_string(),
                    args: vec![
                        "-qo".to_string(),
                        path_str.clone(),
                        "-d".to_string(),
                        parent.clone(),
                    ],
                },
                fallback: Some(tar("-xf")),
            });
        }
        ArchiveKind::Gz => {
            return Ok(LocalExtractPlan::Gunzip {
                archive: archive.to_path_buf(),
                output: local_stripped_output(archive, kind)?,
            })
        }
        ArchiveKind::Bz2 | ArchiveKind::Xz => {
            return Ok(LocalExtractPlan::PipeToFile {
                command: if kind == ArchiveKind::Bz2 { "bzip2" } else { "xz" }.to_string(),
                archive: archive.to_path_buf(),
                output: local_stripped_output(archive, kind)?,
            })
        }
    };
    Ok(LocalExtractPlan::Spawn {
        primary: plan,
        fallback: None,
    })
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

    // ── 本地解压计划（#31）─────────────────────────────────────

    /// 带空格 + 单引号的路径必须原样进入参数数组（不经过 shell）。
    #[test]
    fn local_plan_tar_gz_keeps_raw_path_args() {
        let plan = build_local_extract_plan("C:/data/a b/it's.tar.gz", "windows").unwrap();
        let LocalExtractPlan::Spawn { primary, fallback } = plan else {
            panic!("tar.gz should spawn tar");
        };
        assert_eq!(primary.command, "tar");
        assert_eq!(
            primary.args,
            vec![
                "-xzf",
                "C:/data/a b/it's.tar.gz",
                "-C",
                "C:/data/a b"
            ]
        );
        assert!(fallback.is_none());

        let plan = build_local_extract_plan("/tmp/a b/it's.tgz", "linux").unwrap();
        let LocalExtractPlan::Spawn { primary, .. } = plan else {
            panic!("tgz should spawn tar");
        };
        assert_eq!(primary.args[0], "-xzf");
        assert_eq!(primary.args[3], "/tmp/a b");
    }

    #[test]
    fn local_plan_zip_branches_by_platform() {
        let plan = build_local_extract_plan("C:/data/a b/it's.zip", "windows").unwrap();
        let LocalExtractPlan::Spawn { primary, fallback } = plan else {
            panic!("zip should spawn");
        };
        assert_eq!(primary.command, "tar");
        assert_eq!(
            primary.args,
            vec!["-xf", "C:/data/a b/it's.zip", "-C", "C:/data/a b"]
        );
        assert!(fallback.is_none());

        let plan = build_local_extract_plan("/tmp/a b/it's.zip", "linux").unwrap();
        let LocalExtractPlan::Spawn { primary, fallback } = plan else {
            panic!("zip should spawn");
        };
        assert_eq!(primary.command, "unzip");
        assert_eq!(
            primary.args,
            vec!["-qo", "/tmp/a b/it's.zip", "-d", "/tmp/a b"]
        );
        let fallback = fallback.expect("non-windows zip must fall back to tar");
        assert_eq!(fallback.command, "tar");
        assert_eq!(fallback.args[0], "-xf");
    }

    #[test]
    fn local_plan_single_file_compression_targets_stripped_path() {
        let plan = build_local_extract_plan("/tmp/a b/it's.txt.gz", "linux").unwrap();
        let LocalExtractPlan::Gunzip { archive, output } = plan else {
            panic!("gz should use builtin gunzip");
        };
        assert_eq!(archive, PathBuf::from("/tmp/a b/it's.txt.gz"));
        assert_eq!(output, PathBuf::from("/tmp/a b/it's.txt"));

        let plan = build_local_extract_plan("/tmp/a b/dump.xz", "linux").unwrap();
        let LocalExtractPlan::PipeToFile {
            command,
            archive,
            output,
        } = plan
        else {
            panic!("xz should pipe to file");
        };
        assert_eq!(command, "xz");
        assert_eq!(archive, PathBuf::from("/tmp/a b/dump.xz"));
        assert_eq!(output, PathBuf::from("/tmp/a b/dump"));

        let plan = build_local_extract_plan("data.bz2", "linux").unwrap();
        let LocalExtractPlan::PipeToFile { command, output, .. } = plan else {
            panic!("bz2 should pipe to file");
        };
        assert_eq!(command, "bzip2");
        assert_eq!(output, PathBuf::from("data"));
    }

    #[test]
    fn local_plan_rejects_unsupported_formats() {
        let err = build_local_extract_plan("C:/data/a b/readme.txt", "windows").unwrap_err();
        assert_eq!(err.code(), "local_extract_unsupported");
        assert!(err.to_string().contains("a b/readme.txt"));

        let err = build_local_extract_plan("/tmp/.zip", "linux").unwrap_err();
        assert_eq!(err.code(), "local_extract_unsupported");
    }
}
