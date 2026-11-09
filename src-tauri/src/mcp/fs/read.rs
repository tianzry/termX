//! `fs_read`：按行开窗读取远端文本文件。
//!
//! 走 SFTP 直读（不经过 shell、不产生 stdout base64），默认只回 200 行 +
//! `totalLines`，由调用方按 `nextCursor` 翻页。

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{handle, path as pathutil, window_lines, DEFAULT_READ_LINES, MAX_READ_LINES};

const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

pub struct ReadOutcome {
    pub path: String,
    pub lines: String,
    pub total_lines: usize,
    pub size: u64,
    pub mtime: u64,
    pub truncated: bool,
    pub next_cursor: Option<usize>,
}

fn required_str<'a>(args: &'a Value, key: &str) -> AppResult<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": key })))
}

fn number_lines(text: &str, start: usize) -> String {
    text.lines()
        .enumerate()
        .map(|(offset, line)| format!("{}\t{}", start + offset, line))
        .collect::<Vec<_>>()
        .join("\n")
}

pub async fn fs_read(
    state: &AppState,
    session_id: &str,
    args: &Value,
) -> AppResult<ReadOutcome> {
    let input = required_str(args, "path")?;
    super::shell::validate_remote_path(input)?;
    let start_line = args
        .get("startLine")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let max_lines = args
        .get("maxLines")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_READ_LINES)
        .clamp(1, MAX_READ_LINES);
    let numbered = args
        .get("numbered")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let target = pathutil::normalize(input, &home, &home)?;

    let stat = sftp.stat(&target).await?;
    if stat.is_dir {
        return Err(AppError::config(
            "mcp_path_is_dir",
            json!({ "path": target }),
        ));
    }
    if stat.size > MAX_READ_BYTES {
        return Err(AppError::config(
            "mcp_file_too_large",
            json!({ "path": target, "size": stat.size, "limit": MAX_READ_BYTES }),
        ));
    }

    let bytes = sftp.download(&target).await?;
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::config("mcp_binary_file", json!({ "path": target })))?;
    let window = window_lines(&text, start_line, max_lines);
    let lines = if numbered {
        number_lines(&window.lines, start_line)
    } else {
        window.lines
    };

    Ok(ReadOutcome {
        path: target,
        lines,
        total_lines: window.total_lines,
        size: stat.size,
        mtime: stat.mtime,
        truncated: window.truncated,
        next_cursor: window.next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_lines_from_window_start() {
        assert_eq!(number_lines("a\nb", 10), "10\ta\n11\tb");
    }

    #[test]
    fn required_str_rejects_blank() {
        assert!(required_str(&json!({ "path": "  " }), "path").is_err());
        assert!(required_str(&json!({}), "path").is_err());
    }
}
