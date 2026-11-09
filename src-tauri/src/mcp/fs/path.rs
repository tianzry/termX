//! 远端路径规范化与 workspace jail。
//!
//! 文件类工具在拿到用户路径后必须先 `normalize` 再 `check`，两者都是纯字符串
//! 运算；真实软链是否逃逸由调用方用 SFTP `realpath` 再校验一次。

use serde_json::json;

use crate::error::{AppError, AppResult};

/// 规范化远端路径：
/// - `~` / `~/x` 用远端 home 展开；
/// - 相对路径按 `base` 解析；
/// - 折叠 `.` / `..`，越过 `/` 直接报错。
pub fn normalize(input: &str, home: &str, base: &str) -> AppResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::config("mcp_path_empty", json!({})));
    }
    if trimmed.contains('\0') {
        return Err(AppError::config(
            "mcp_path_invalid",
            json!({ "path": input }),
        ));
    }
    let expanded = if trimmed == "~" {
        home.to_string()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        format!("{}/{}", home.trim_end_matches('/'), rest)
    } else {
        trimmed.to_string()
    };
    let absolute = if expanded.starts_with('/') {
        expanded
    } else {
        format!("{}/{}", base.trim_end_matches('/'), expanded)
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in absolute.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(AppError::config(
                        "mcp_path_escape",
                        json!({ "path": input }),
                    ));
                }
            }
            other => parts.push(other),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

/// `path` 是否位于 `root` 之内（root 自身算内）。两者都应是已规范化的绝对路径。
pub fn is_within(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return path.starts_with('/');
    }
    path == root || path.starts_with(&format!("{root}/"))
}

/// jail 校验：路径必须在 workspace 根内。
pub fn check(jail_root: &str, path: &str) -> AppResult<()> {
    if is_within(jail_root, path) {
        Ok(())
    } else {
        Err(AppError::config(
            "mcp_path_outside_jail",
            json!({ "path": path, "root": jail_root }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home_and_relative_paths() {
        assert_eq!(
            normalize("~/code/a.c", "/home/u", "/home/u").unwrap(),
            "/home/u/code/a.c"
        );
        assert_eq!(
            normalize("code/a.c", "/home/u", "/home/u").unwrap(),
            "/home/u/code/a.c"
        );
        assert_eq!(normalize("/tmp/x", "/home/u", "/home/u").unwrap(), "/tmp/x");
    }

    #[test]
    fn folds_dots_and_rejects_root_escape() {
        assert_eq!(
            normalize("~/code/../code/./a.c", "/home/u", "/home/u").unwrap(),
            "/home/u/code/a.c"
        );
        assert_eq!(
            normalize("../../etc/passwd", "/home/u", "/home/u")
                .unwrap_err()
                .code(),
            "mcp_path_escape"
        );
    }

    #[test]
    fn jail_accepts_root_and_descendants_only() {
        assert!(is_within("/home/u/code", "/home/u/code"));
        assert!(is_within("/home/u/code", "/home/u/code/a/b.c"));
        assert!(!is_within("/home/u/code", "/home/u/codex"));
        assert!(!is_within("/home/u/code", "/etc/passwd"));
        assert!(check("/home/u/code", "/etc/passwd").is_err());
    }
}
