//! 远端路径规范化。
//!
//! 文件类工具在拿到用户路径后先 `normalize`：`~` 用远端 home 展开，相对路径按
//! `base`（通常是 home）解析，并折叠 `.` / `..`。不做目录范围限制。

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
        // 相对路径可以折叠到 home 之外，不做目录限制。
        let escaped = normalize("../../etc/passwd", "/home/u", "/home/u").unwrap();
        assert_eq!(escaped, "/etc/passwd");
        // 越过文件系统根（`..` 栈已空）才在 normalize 阶段报错。
        assert_eq!(
            normalize("/../etc", "/home/u", "/home/u")
                .unwrap_err()
                .code(),
            "mcp_path_escape"
        );
    }
}
