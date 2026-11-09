//! MCP 文件原语层（M0 基础设施）。
//!
//! 设计见 `docs/mcp-refactor.md`：文件类工具用结构化参数表达语义，
//! 不拼 shell、不走命令黑名单；传输只回路径/大小/校验和。

pub mod caps;
pub mod delete;
pub mod glob;
pub mod grep;
pub mod handle;
pub mod patch;
pub mod path;
pub mod read;
pub mod session;
pub mod shell;
pub mod transfer;
pub mod write;

/// `fs_read` 默认开窗行数。
pub const DEFAULT_READ_LINES: usize = 200;
/// `fs_read` 单次最多返回行数（防止 agent 一次拉整文件）。
pub const MAX_READ_LINES: usize = 2000;
/// 搜索类工具默认返回条数。
pub const DEFAULT_MAX_RESULTS: usize = 50;
/// 搜索类工具单次最多返回条数。
pub const MAX_MAX_RESULTS: usize = 200;
/// `build_run` / `term_run` 默认尾部字节数。
pub const DEFAULT_OUTPUT_TAIL_BYTES: usize = 16 * 1024;
/// 输出尾部上限。
pub const MAX_OUTPUT_TAIL_BYTES: usize = 256 * 1024;

/// 一次按行开窗的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineWindow {
    pub lines: String,
    pub total_lines: usize,
    /// 本次窗口之后是否还有内容。
    pub truncated: bool,
    /// 下一页的起始行（1-based），没有更多内容时为 `None`。
    pub next_cursor: Option<usize>,
}

/// 从 `text` 中取 `[start_line, start_line + max_lines)` 行（1-based、闭开区间）。
///
/// 与 netcatty / 设计文档一致：默认只回一窗，同时回 `totalLines` 与游标，
/// 让上层按需翻页，避免一次性吐大文件。
pub fn window_lines(text: &str, start_line: usize, max_lines: usize) -> LineWindow {
    let all: Vec<&str> = text.lines().collect();
    let total = all.len();
    let start = start_line.max(1).min(total.saturating_add(1));
    let end = (start - 1 + max_lines.max(1)).min(total);
    let lines = if start - 1 < end {
        all[start - 1..end].join("\n")
    } else {
        String::new()
    };
    LineWindow {
        lines,
        total_lines: total,
        truncated: end < total,
        next_cursor: if end < total { Some(end + 1) } else { None },
    }
}

/// 输出尾部偏置截断（错误通常在末尾）。
///
/// 返回 `(尾部文本, 是否截断)`；截断点落在 UTF-8 字符边界上。
pub fn tail_bytes(text: &str, max_bytes: usize) -> (String, bool) {
    let max_bytes = max_bytes.max(1);
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_lines_pages_through_a_file() {
        let text = "1\n2\n3\n4\n5";
        let first = window_lines(text, 1, 2);
        assert_eq!(first.lines, "1\n2");
        assert_eq!(first.total_lines, 5);
        assert!(first.truncated);
        assert_eq!(first.next_cursor, Some(3));

        let last = window_lines(text, 5, 2);
        assert_eq!(last.lines, "5");
        assert!(!last.truncated);
        assert_eq!(last.next_cursor, None);
    }

    #[test]
    fn window_lines_past_eof_is_empty() {
        let out = window_lines("a\nb", 99, 10);
        assert_eq!(out.lines, "");
        assert_eq!(out.total_lines, 2);
        assert!(!out.truncated);
        assert_eq!(out.next_cursor, None);
    }

    #[test]
    fn tail_bytes_keeps_char_boundary() {
        let text = "错误信息";
        let (tail, truncated) = tail_bytes(text, 4);
        assert!(truncated);
        assert!(text.ends_with(&tail));
        // 4 字节装不下两个汉字（各 3 字节），只能回最后一个完整字符。
        assert_eq!(tail, "息");
        assert!(tail.len() <= 4);
    }
}
