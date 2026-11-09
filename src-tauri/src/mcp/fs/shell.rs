//! 远端 shell 片段拼装。
//!
//! 与 `ai/session/file_ops.rs` 同源的最小副本：MCP 走 SSH exec 通道（非交互 PTY），
//! 没有 zsh ZLE 的多行 quote 问题，因此只需要 POSIX 单引号转义。
//!
//! TODO(M2)：把 `file_ops.rs` 的纯函数提取到 `ai/remote_script.rs` 后删除本文件，
//! 两处合并为一处。

use serde_json::json;

use crate::error::{AppError, AppResult};

/// POSIX 单引号转义：`$ ` * ? & | ; < >` 等元字符在引号内全部按字面。
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 远端路径准备：`~` / `~/x` 交给 `$HOME` 展开，其余走单引号。
pub fn prepare_remote_path(path: &str) -> String {
    if path == "~" {
        "\"$HOME\"".to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("\"$HOME\"/{}", shell_quote(rest))
    } else {
        shell_quote(path)
    }
}

/// 拒绝会破坏单行命令或触发终端转义注入的路径字符。
pub fn validate_remote_path(path: &str) -> AppResult<()> {
    if path.is_empty() {
        return Err(AppError::config("mcp_path_empty", json!({})));
    }
    for c in path.chars() {
        let code = c as u32;
        if c == '\n' || c == '\r' {
            return Err(AppError::config(
                "mcp_path_invalid",
                json!({ "path": path, "reason": "newline" }),
            ));
        }
        if code < 0x20 || code == 0x7F {
            return Err(AppError::config(
                "mcp_path_invalid",
                json!({ "path": path, "reason": "control" }),
            ));
        }
    }
    Ok(())
}

/// 拼 `<interp> -c '<script>' <arg>...`。`args` 必须已是可直接拼接的 shell 片段
/// （路径用 [`prepare_remote_path`]，文本用 [`shell_quote`]）。
pub fn build_script_cmd(interp: &str, script: &str, args: &[String]) -> String {
    let mut cmd = format!("{interp} -c {}", shell_quote(script));
    for arg in args {
        cmd.push(' ');
        cmd.push_str(arg);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_shell_metacharacters() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(shell_quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(prepare_remote_path("~/a b"), "\"$HOME\"/'a b'");
    }

    #[test]
    fn rejects_control_characters_in_paths() {
        assert!(validate_remote_path("a\nb").is_err());
        assert!(validate_remote_path("a\u{1b}b").is_err());
        assert!(validate_remote_path("/tmp/a.c").is_ok());
    }
}
