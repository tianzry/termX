//! `fs_glob`：在 workspace 内按 glob 列举文件（SFTP walk，无 shell）。

use regex::Regex;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{handle, path as jail, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS};

pub struct GlobOutcome {
    pub matches: Vec<Value>,
    pub total: usize,
    pub truncated: bool,
    pub next_cursor: Option<usize>,
}

/// glob → 正则：`**` 跨目录，`*` / `?` 不跨 `/`。
pub fn glob_to_regex(pattern: &str) -> AppResult<Regex> {
    let mut out = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` 匹配零层或多层目录，`**` 其余情况匹配任意字符。
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        out.push_str("(?:.*/)?");
                    } else {
                        out.push_str(".*");
                    }
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            other => out.push(other),
        }
    }
    out.push('$');
    Regex::new(&out)
        .map_err(|_| AppError::config("mcp_glob_invalid", json!({ "pattern": pattern })))
}

pub async fn fs_glob(
    state: &AppState,
    session_id: &str,
    args: &Value,
    jail_root: &str,
) -> AppResult<GlobOutcome> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "pattern" })))?;
    let cursor = args.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
    let max_results = args
        .get("maxResults")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_MAX_RESULTS);

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let root = jail::normalize(jail_root, &home, &home)?;
    let input = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".");
    let search_root = jail::normalize(input, &home, &root)?;
    jail::check(&root, &search_root)?;

    let matcher = glob_to_regex(pattern)?;
    let match_basename = !pattern.contains('/');
    let entries = sftp.walk_files(&search_root).await?;

    let mut matched: Vec<&crate::ssh::sftp::WalkEntry> = entries
        .iter()
        .filter(|entry| !entry.is_dir)
        .filter(|entry| {
            if match_basename {
                let name = entry.rel_path.rsplit('/').next().unwrap_or(&entry.rel_path);
                matcher.is_match(name)
            } else {
                matcher.is_match(&entry.rel_path)
            }
        })
        .collect();
    matched.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let total = matched.len();
    let page: Vec<&crate::ssh::sftp::WalkEntry> =
        matched.into_iter().skip(cursor).take(max_results).collect();
    let end = cursor + page.len();
    let matches = page
        .into_iter()
        .map(|entry| {
            json!({
                "path": format!("{}/{}", search_root.trim_end_matches('/'), entry.rel_path),
                "size": entry.size,
            })
        })
        .collect();

    Ok(GlobOutcome {
        matches,
        total,
        truncated: end < total,
        next_cursor: if end < total { Some(end) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_basename_and_recursive_patterns() {
        let re = glob_to_regex("*.c").unwrap();
        assert!(re.is_match("a.c"));
        assert!(!re.is_match("src/a.c"));

        let re = glob_to_regex("**/*.c").unwrap();
        assert!(re.is_match("src/a.c"));
        assert!(re.is_match("a.c"));
        assert!(!re.is_match("src/a.h"));
    }

    #[test]
    fn glob_escapes_regex_metacharacters() {
        let re = glob_to_regex("a+b?.txt").unwrap();
        assert!(re.is_match("a+b1.txt"));
        assert!(!re.is_match("aab1.txt"));
    }
}
