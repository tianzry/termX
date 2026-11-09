//! `fs_grep`：远端 python3 脚本按 glob / 正则搜索，封顶返回 `file:line:snippet`。
//!
//! 走 SSH exec 通道（非交互 PTY），脚本直接 `-c` 传入，参数全部 POSIX 转义。
//! perl 兜底留到 M2 与 `fs_patch` 的脚本提取一起做。

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::ssh::client::exec_once;
use crate::state::AppState;

use super::{caps, handle, path as jail, shell, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS};

const MAX_CONTEXT_LINES: u32 = 3;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SNIPPET_CHARS: usize = 400;

const PYTHON_GREP: &str = r#"import os, re, sys, json, fnmatch
root, pattern, globpat = sys.argv[1], sys.argv[2], sys.argv[3]
use_regex, ignore_case = sys.argv[4] == '1', sys.argv[5] == '1'
ctx, limit, max_bytes = int(sys.argv[6]), int(sys.argv[7]), int(sys.argv[8])
flags = re.IGNORECASE if ignore_case else 0
try:
    expr = re.compile(pattern if use_regex else re.escape(pattern), flags)
except re.error as exc:
    print(json.dumps({'error': 'invalid_regex: ' + str(exc)}))
    sys.exit(0)
matches, total, truncated = [], 0, False
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules')]
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root)
        if globpat not in ('', '*') and not fnmatch.fnmatch(rel, globpat) and not fnmatch.fnmatch(name, globpat):
            continue
        try:
            if os.path.getsize(full) > max_bytes:
                continue
            with open(full, 'r', encoding='utf-8', errors='replace') as handle:
                lines = handle.read().splitlines()
        except OSError:
            continue
        for index, line in enumerate(lines):
            if not expr.search(line):
                continue
            total += 1
            if len(matches) < limit:
                item = {'path': rel, 'line': index + 1, 'text': line}
                if ctx > 0:
                    item['before'] = lines[max(0, index - ctx):index]
                    item['after'] = lines[index + 1:index + 1 + ctx]
                matches.append(item)
            else:
                truncated = True
print(json.dumps({'matches': matches, 'total': total, 'truncated': truncated}))
"#;

#[derive(Debug, Deserialize)]
struct ScriptMatch {
    path: String,
    line: usize,
    text: String,
    #[serde(default)]
    before: Vec<String>,
    #[serde(default)]
    after: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ScriptOutput {
    matches: Vec<ScriptMatch>,
    total: usize,
    truncated: bool,
}

pub struct GrepOutcome {
    pub matches: Vec<Value>,
    pub total: usize,
    pub truncated: bool,
    pub next_cursor: Option<usize>,
}

fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let head: String = text.chars().take(limit).collect();
    format!("{head}…")
}

pub async fn fs_grep(
    state: &AppState,
    session_id: &str,
    profile_id: &str,
    ssh: &crate::ssh::client::SshHandle,
    args: &Value,
    jail_root: &str,
) -> AppResult<GrepOutcome> {
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "pattern" })))?;
    let glob_pattern = args
        .get("glob")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("*");
    let use_regex = args.get("regex").and_then(Value::as_bool).unwrap_or(true);
    let ignore_case = args
        .get("ignoreCase")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let context = args
        .get("contextLines")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(MAX_CONTEXT_LINES as u64) as u32;
    let cursor = args.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
    let max_results = args
        .get("maxResults")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_MAX_RESULTS);

    let remote_caps = caps::detect(ssh, profile_id).await?;
    if !remote_caps.python3 {
        return Err(AppError::config(
            "mcp_missing_interpreter",
            json!({ "required": "python3", "hint": "远端安装 python3 后重试；fs_read / fs_glob 不受影响" }),
        ));
    }

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

    // 多取一条用于判断是否还有下一页。
    let limit = cursor + max_results + 1;
    let cmd = shell::build_script_cmd(
        "python3",
        PYTHON_GREP,
        &[
            shell::prepare_remote_path(&search_root),
            shell::shell_quote(pattern),
            shell::shell_quote(glob_pattern),
            shell::shell_quote(if use_regex { "1" } else { "0" }),
            shell::shell_quote(if ignore_case { "1" } else { "0" }),
            shell::shell_quote(&context.to_string()),
            shell::shell_quote(&limit.to_string()),
            shell::shell_quote(&MAX_FILE_BYTES.to_string()),
        ],
    );

    let out = exec_once(ssh, &cmd, Duration::from_secs(120), false).await?;
    if out.exit_code != Some(0) {
        return Err(AppError::ssh(
            "mcp_grep_failed",
            json!({ "exitCode": out.exit_code, "stderr": out.stderr }),
        ));
    }
    let parsed: ScriptOutput = serde_json::from_str(out.stdout.trim())
        .map_err(|_| AppError::ssh("mcp_grep_bad_output", json!({ "stdout": out.stdout })))?;

    let page: Vec<&ScriptMatch> = parsed.matches.iter().skip(cursor).collect();
    let returned = page.len().min(max_results);
    let matches = page
        .into_iter()
        .take(returned)
        .map(|item| {
            let mut value = json!({
                "path": item.path,
                "line": item.line,
                "text": truncate_chars(&item.text, MAX_SNIPPET_CHARS),
            });
            if context > 0 {
                value["before"] = json!(item.before);
                value["after"] = json!(item.after);
            }
            value
        })
        .collect();
    let end = cursor + returned;
    let truncated = parsed.truncated || end < parsed.total;

    Ok(GrepOutcome {
        matches,
        total: parsed.total,
        truncated,
        next_cursor: if truncated { Some(end) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_snippets_on_char_boundary() {
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(truncate_chars("错误错误", 2), "错误…");
    }
}
