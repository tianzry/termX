//! 远端命令拼装的纯函数（AI 文件操作与 MCP 文件原语共用）。
//!
//! 从 `ai/session/file_ops.rs` 提取：这里的函数不依赖会话状态，只负责把
//! 路径/脚本安全地拼进一条 shell 命令。

/// ANSI-C quoting：把任意文本编码成 `$'...'`（脚本本体用）。
///
/// 单行 ASCII：控制字符走 `\xHH`，避免 PTY 里出现真换行触发 zsh ZLE
/// multi-line quote race。
pub fn ansi_c_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    out.push('$');
    out.push('\'');
    for ch in s.chars() {
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\'' => out.push_str("\\x27"),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || (c as u32) == 0x7F => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// POSIX 单引号转义：整个串包进单引号，内部单引号替换为 `'\''`。
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 校验 path 不含会破坏单行命令或注入终端转义的字符。
pub fn validate_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() {
        return Err("empty path");
    }
    for c in path.chars() {
        let code = c as u32;
        if c == '\n' || c == '\r' {
            return Err("path contains newline (\\n or \\r) — would break the single-line command");
        }
        if code < 0x20 || code == 0x7F {
            return Err("path contains control character");
        }
    }
    Ok(())
}

/// 远端文件路径准备：`~` / `~/...` 交给 `$HOME` 展开，其余走 shell_quote。
pub fn prepare_remote_path(path: &str) -> String {
    if path == "~" {
        "\"$HOME\"".to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("\"$HOME\"/{}", shell_quote(rest))
    } else {
        shell_quote(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_neutralizes_metacharacters() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(shell_quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(shell_quote("a\nb"), "'a\nb'");
    }

    #[test]
    fn prepare_remote_path_expands_home_only_with_slash() {
        assert_eq!(prepare_remote_path("~"), "\"$HOME\"");
        assert_eq!(prepare_remote_path("~/a b"), "\"$HOME\"/'a b'");
        assert_eq!(prepare_remote_path("~user/x"), "'~user/x'");
    }

    #[test]
    fn validate_path_rejects_controls() {
        assert!(validate_path("").is_err());
        assert!(validate_path("a\nb").is_err());
        assert!(validate_path("a\u{1b}b").is_err());
        assert!(validate_path("/tmp/a.c").is_ok());
    }

    #[test]
    fn ansi_c_quote_keeps_single_line_ascii() {
        let quoted = ansi_c_quote("print('x')\n");
        assert!(!quoted.contains('\n'));
        assert!(quoted.starts_with("$'"));
        assert!(quoted.ends_with('\''));
    }
}
