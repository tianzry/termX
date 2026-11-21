//! `fs_grep`：远端按 glob / 正则搜索，封顶返回 `file:line:snippet`。
//!
//! 后端优先级 rg → python3 → grep（caps 探测一次缓存）：
//! - rg 原生并行扫描，远快于 python 单线程；双扫取精确 total（`-c` 计数 + 页扫），
//!   正则方言不兼容（lookahead/反向引用）exit 2、或二进制缺失（shell 126/127，
//!   caps 缓存无 TTL 可能过期）自动回落 python3；
//! - python3 脚本兜底（语义最完整：rel glob、before/after）；
//! - 无 rg 无 python3 时用 grep -rnI 原生兜底（嵌入式/busybox，无 2MB 上限、尽力而为）。
//! 三档都走 SSH exec 通道，参数 POSIX 转义；页扫 `cd root && ... .` 让路径相对 root。

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::ssh::client::exec_once;
use crate::state::AppState;

use super::{caps, handle, path as pathutil, shell, DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS};

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
            with open(full, 'rb') as handle:
                raw = handle.read()
            if b'\x00' in raw[:8192]:
                continue
            lines = raw.decode('utf-8', errors='replace').splitlines()
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
}

/// 各后端统一产出的原始命中（path 相对 search_root），finalize 再做开窗/截断/翻页。
struct RawMatch {
    path: String,
    line: usize,
    text: String,
    before: Vec<String>,
    after: Vec<String>,
}

struct RawResult {
    matches: Vec<RawMatch>,
    total: usize,
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

/// 取 marker 行的 `marker:value` 数值。
fn metric(text: &str, marker: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix(marker)?;
        rest.trim_start_matches(':').trim().parse().ok()
    })
}

/// 取两个 marker 行之间的内容；end=None 取到结尾并去掉末尾空行。
fn section(text: &str, start: &str, end: Option<&str>) -> Option<String> {
    let mut started = false;
    let mut body: Vec<&str> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !started {
            if trimmed == start {
                started = true;
            }
            continue;
        }
        if let Some(end) = end {
            if trimmed == end {
                return Some(body.join("\n"));
            }
        }
        body.push(line);
    }
    if !started {
        return None;
    }
    if end.is_some() {
        return None;
    }
    while body.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        body.pop();
    }
    Some(body.join("\n"))
}

/// exit 2 = 正则方言/参数不兼容；>=126 = shell 级失败（命令缺失/不可执行）。
fn rc_falls_back(rc: u64) -> bool {
    rc == 2 || rc >= 126
}

/// `path:count` 计数行求和（rsplit 取末段，路径含 ':' 也不误）。
fn sum_counts(text: &str) -> usize {
    text.lines()
        .filter_map(|line| line.rsplit_once(':'))
        .filter_map(|(_, count)| count.trim().parse::<usize>().ok())
        .sum()
}

/// rg/grep 对 `.` 扫描输出带 `./` 前缀，统一剥掉对齐 python relpath 语义。
fn rel_path(path: &str) -> String {
    path.strip_prefix("./").unwrap_or(path).to_string()
}

/// `path:line:text` 行解析（context=0 的 rg/grep 页扫输出）。
fn parse_line_matches(text: &str) -> Vec<RawMatch> {
    text.lines()
        .filter_map(|line| {
            let (path, rest) = line.split_once(':')?;
            let (num, body) = rest.split_once(':')?;
            let line_no = num.parse::<usize>().ok()?;
            Some(RawMatch {
                path: rel_path(path),
                line: line_no,
                text: body.to_string(),
                before: Vec::new(),
                after: Vec::new(),
            })
        })
        .collect()
}

fn trim_eol(text: &str) -> String {
    text.trim_end_matches(['\n', '\r']).to_string()
}

/// rg --json 事件流组装 before/after：每个 match 取相邻的 context 事件（各封顶 ctx）。
fn parse_rg_json(text: &str, ctx: usize) -> Vec<RawMatch> {
    #[derive(Deserialize)]
    struct Ev {
        #[serde(rename = "type")]
        kind: String,
        data: Option<EvData>,
    }
    #[derive(Deserialize)]
    struct EvData {
        path: Option<PathText>,
        line_number: Option<usize>,
        lines: Option<PathText>,
    }
    #[derive(Deserialize)]
    struct PathText {
        text: String,
    }
    let events: Vec<Ev> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Ev>(line).ok())
        .collect();
    let ctx_line = |ev: &Ev| -> Option<String> {
        if ev.kind != "context" {
            return None;
        }
        ev.data.as_ref()?.lines.as_ref().map(|l| trim_eol(&l.text))
    };
    let mut out = Vec::new();
    for (i, ev) in events.iter().enumerate() {
        if ev.kind != "match" {
            continue;
        }
        let Some(data) = &ev.data else { continue };
        let path = data.path.as_ref().map(|p| rel_path(&p.text)).unwrap_or_default();
        let line = data.line_number.unwrap_or(0);
        let body = data.lines.as_ref().map(|l| trim_eol(&l.text)).unwrap_or_default();
        let mut before = Vec::new();
        let mut j = i;
        while j > 0 && before.len() < ctx {
            j -= 1;
            match ctx_line(&events[j]) {
                Some(l) => before.push(l),
                None => break,
            }
        }
        before.reverse();
        let mut after = Vec::new();
        let mut k = i + 1;
        while k < events.len() && after.len() < ctx {
            match ctx_line(&events[k]) {
                Some(l) => after.push(l),
                None => break,
            }
            k += 1;
        }
        out.push(RawMatch { path, line, text: body, before, after });
    }
    out
}

/// grep -C 页扫解析：match 行 `path:line:text`、context 行 `path-line-text`、`--` 分组。
fn parse_grep_page(text: &str, ctx: usize) -> Vec<RawMatch> {
    if ctx == 0 {
        return parse_line_matches(text);
    }
    enum Tok {
        Match(RawMatch),
        Ctx(String),
        Sep,
    }
    let toks: Vec<Tok> = text
        .lines()
        .filter_map(|line| {
            if line.trim() == "--" {
                return Some(Tok::Sep);
            }
            if let Some((path, rest)) = line.split_once(':') {
                if let Some((num, body)) = rest.split_once(':') {
                    if let Ok(n) = num.parse::<usize>() {
                        return Some(Tok::Match(RawMatch {
                            path: rel_path(path),
                            line: n,
                            text: body.to_string(),
                            before: Vec::new(),
                            after: Vec::new(),
                        }));
                    }
                }
            }
            if let Some((_, rest)) = line.split_once('-') {
                if let Some((num, body)) = rest.split_once('-') {
                    if num.parse::<usize>().is_ok() {
                        return Some(Tok::Ctx(body.to_string()));
                    }
                }
            }
            None
        })
        .collect();
    let mut out = Vec::new();
    for (i, tok) in toks.iter().enumerate() {
        let Tok::Match(m) = tok else { continue };
        let mut before = Vec::new();
        let mut j = i;
        while j > 0 && before.len() < ctx {
            j -= 1;
            match &toks[j] {
                Tok::Ctx(l) => before.push(l.clone()),
                _ => break,
            }
        }
        before.reverse();
        let mut after = Vec::new();
        let mut k = i + 1;
        while k < toks.len() && after.len() < ctx {
            match &toks[k] {
                Tok::Ctx(l) => after.push(l.clone()),
                _ => break,
            }
            k += 1;
        }
        out.push(RawMatch {
            path: m.path.clone(),
            line: m.line,
            text: m.text.clone(),
            before,
            after,
        });
    }
    out
}

/// 统一收尾：snippet 截断 + cursor 开窗 + 精确 total 翻页。
fn finalize(raw: RawResult, cursor: usize, max_results: usize, context: u32) -> GrepOutcome {
    let total = raw.total;
    let page: Vec<&RawMatch> = raw.matches.iter().skip(cursor).collect();
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
    let truncated = end < total;
    GrepOutcome {
        matches,
        total,
        truncated,
        next_cursor: if truncated { Some(end) } else { None },
    }
}

fn rg_flags(ignore_case: bool, use_regex: bool, glob: &str) -> String {
    let mut flags = format!(
        "--no-heading --with-filename --color never --no-ignore --hidden --max-filesize {MAX_FILE_BYTES} \
         -g '!.git' -g '!node_modules'"
    );
    if ignore_case {
        flags.push_str(" -i");
    }
    if !use_regex {
        flags.push_str(" -F");
    }
    if !glob.is_empty() && glob != "*" {
        flags.push_str(&format!(" -g {}", shell::shell_quote(glob)));
    }
    flags
}

fn grep_flags(ignore_case: bool, use_regex: bool, glob: &str) -> String {
    let mut flags = String::from("-I --exclude-dir=.git --exclude-dir=node_modules");
    flags.push_str(if use_regex { " -E" } else { " -F" });
    if ignore_case {
        flags.push_str(" -i");
    }
    if !glob.is_empty() && glob != "*" {
        flags.push_str(&format!(" --include={}", shell::shell_quote(glob)));
    }
    flags
}

/// 计数 + 页扫单 exec：rc 紧跟计数命令捕获（不被管道掩盖），count/page 用 marker 分段。
async fn grep_rg(
    ssh: &crate::ssh::client::SshHandle,
    root: &str,
    pattern: &str,
    glob: &str,
    use_regex: bool,
    ignore_case: bool,
    context: u32,
    limit: usize,
) -> AppResult<Option<RawResult>> {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let short = &tag[..8];
    let m_cd = format!("__TERMX_{short}_CD");
    let m_rc = format!("__TERMX_{short}_RC");
    let m_count = format!("__TERMX_{short}_COUNT");
    let m_page = format!("__TERMX_{short}_PAGE");
    let flags = rg_flags(ignore_case, use_regex, glob);
    let pq = shell::shell_quote(pattern);
    let count_cmd = format!("rg -c {flags} -- {pq} .");
    let page_cmd = if context > 0 {
        let json_limit = limit * (2 * context as usize + 2) + 16;
        format!("rg --json -C {context} {flags} -- {pq} . 2>/dev/null | head -n {json_limit}")
    } else {
        format!("rg -n {flags} -- {pq} . 2>/dev/null | head -n {limit}")
    };
    let script = format!(
        "cd {root} || {{ echo {m_cd}; exit 0; }}\n\
         cnt=$({count_cmd} 2>/dev/null); rc=$?\n\
         echo {m_rc}:$rc\n\
         echo {m_count}\n\
         printf '%s\\n' \"$cnt\"\n\
         echo {m_page}\n\
         {page_cmd}\n",
        root = shell::shell_quote(root),
    );
    let out = exec_once(ssh, &script, Duration::from_secs(120), false).await?;
    let text = out.stdout;
    if text.lines().any(|l| l.trim() == m_cd) {
        return Err(AppError::config("mcp_cwd_invalid", json!({ "path": root })));
    }
    // rg exit 2 = 正则方言不兼容/参数错误 → 回落 python3/grep；exit 1 = 无命中。
    let rc = metric(&text, &m_rc).unwrap_or(2);
    if rc_falls_back(rc) {
        return Ok(None);
    }
    let total = if rc == 1 {
        0
    } else {
        sum_counts(&section(&text, &m_count, Some(&m_page)).unwrap_or_default())
    };
    let page_text = section(&text, &m_page, None).unwrap_or_default();
    let matches = if context > 0 {
        parse_rg_json(&page_text, context as usize)
    } else {
        parse_line_matches(&page_text)
    };
    Ok(Some(RawResult { matches, total }))
}

async fn grep_grep(
    ssh: &crate::ssh::client::SshHandle,
    root: &str,
    pattern: &str,
    glob: &str,
    use_regex: bool,
    ignore_case: bool,
    context: u32,
    limit: usize,
) -> AppResult<Option<RawResult>> {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let short = &tag[..8];
    let m_cd = format!("__TERMX_{short}_CD");
    let m_rc = format!("__TERMX_{short}_RC");
    let m_count = format!("__TERMX_{short}_COUNT");
    let m_page = format!("__TERMX_{short}_PAGE");
    let flags = grep_flags(ignore_case, use_regex, glob);
    let pq = shell::shell_quote(pattern);
    let count_cmd = format!("grep -rc {flags} -- {pq} .");
    let ctx_flag = if context > 0 {
        format!("-C {context} ")
    } else {
        String::new()
    };
    let page_cmd = format!("grep -rn {ctx_flag}{flags} -- {pq} . 2>/dev/null | head -n {limit}");
    let script = format!(
        "cd {root} || {{ echo {m_cd}; exit 0; }}\n\
         cnt=$({count_cmd} 2>/dev/null); rc=$?\n\
         echo {m_rc}:$rc\n\
         echo {m_count}\n\
         printf '%s\\n' \"$cnt\"\n\
         echo {m_page}\n\
         {page_cmd}\n",
        root = shell::shell_quote(root),
    );
    let out = exec_once(ssh, &script, Duration::from_secs(120), false).await?;
    let text = out.stdout;
    if text.lines().any(|l| l.trim() == m_cd) {
        return Err(AppError::config("mcp_cwd_invalid", json!({ "path": root })));
    }
    let rc = metric(&text, &m_rc).unwrap_or(2);
    if rc_falls_back(rc) {
        return Ok(None);
    }
    let total = if rc == 1 {
        0
    } else {
        sum_counts(&section(&text, &m_count, Some(&m_page)).unwrap_or_default())
    };
    let page_text = section(&text, &m_page, None).unwrap_or_default();
    Ok(Some(RawResult {
        matches: parse_grep_page(&page_text, context as usize),
        total,
    }))
}

async fn grep_python(
    ssh: &crate::ssh::client::SshHandle,
    root: &str,
    pattern: &str,
    glob: &str,
    use_regex: bool,
    ignore_case: bool,
    context: u32,
    limit: usize,
) -> AppResult<Option<RawResult>> {
    let cmd = shell::build_script_cmd(
        "python3",
        PYTHON_GREP,
        &[
            shell::prepare_remote_path(root),
            shell::shell_quote(pattern),
            shell::shell_quote(glob),
            shell::shell_quote(if use_regex { "1" } else { "0" }),
            shell::shell_quote(if ignore_case { "1" } else { "0" }),
            shell::shell_quote(&context.to_string()),
            shell::shell_quote(&limit.to_string()),
            shell::shell_quote(&MAX_FILE_BYTES.to_string()),
        ],
    );
    let out = exec_once(ssh, &cmd, Duration::from_secs(120), false).await?;
    if matches!(out.exit_code, Some(126) | Some(127)) {
        return Ok(None);
    }
    if out.exit_code != Some(0) {
        return Err(AppError::ssh(
            "mcp_grep_failed",
            json!({ "exitCode": out.exit_code, "stderr": out.stderr }),
        ));
    }
    let value: Value = serde_json::from_str(out.stdout.trim())
        .map_err(|_| AppError::ssh("mcp_grep_bad_output", json!({ "stdout": out.stdout })))?;
    if let Some(err) = value.get("error").and_then(Value::as_str) {
        return Err(AppError::config(
            "mcp_grep_invalid_regex",
            json!({ "pattern": pattern, "error": err }),
        ));
    }
    let parsed: ScriptOutput = serde_json::from_value(value)
        .map_err(|_| AppError::ssh("mcp_grep_bad_output", json!({ "stdout": out.stdout })))?;
    Ok(Some(RawResult {
        matches: parsed
            .matches
            .into_iter()
            .map(|m| RawMatch {
                path: m.path,
                line: m.line,
                text: m.text,
                before: m.before,
                after: m.after,
            })
            .collect(),
        total: parsed.total,
    }))
}

pub async fn fs_grep(
    state: &AppState,
    session_id: &str,
    profile_id: &str,
    ssh: &crate::ssh::client::SshHandle,
    args: &Value,
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
    if !remote_caps.rg && !remote_caps.python3 && !remote_caps.grep {
        return Err(AppError::config(
            "mcp_missing_interpreter",
            json!({ "required": "rg / python3 / grep", "hint": "远端安装 ripgrep（首选）或 python3 后重试；fs_read / fs_glob 不受影响" }),
        ));
    }

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let input = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".");
    let search_root = pathutil::normalize(input, &home, &home)?;

    // 多取一条用于判断是否还有下一页。
    let limit = cursor + max_results + 1;

    // rg 首选；exit 2（正则方言/参数不兼容）或解析失败回落 python3，再回落 grep。
    let mut raw: Option<RawResult> = None;
    if remote_caps.rg {
        raw = grep_rg(
            ssh, &search_root, pattern, glob_pattern, use_regex, ignore_case, context, limit,
        )
        .await?;
    }
    if raw.is_none() && remote_caps.python3 {
        raw = grep_python(
            ssh, &search_root, pattern, glob_pattern, use_regex, ignore_case, context, limit,
        )
        .await?;
    }
    if raw.is_none() && remote_caps.grep {
        raw = grep_grep(
            ssh, &search_root, pattern, glob_pattern, use_regex, ignore_case, context, limit,
        )
        .await?;
    }
    let raw = raw.ok_or_else(|| {
        AppError::ssh(
            "mcp_grep_failed",
            json!({ "hint": "rg / grep 均无法处理该模式，且远端无 python3 兜底" }),
        )
    })?;

    Ok(finalize(raw, cursor, max_results, context))
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

    #[test]
    fn sums_count_lines_with_colon_in_path() {
        assert_eq!(sum_counts("a.rs:3\nsub/b.rs:5\nweird:name.rs:2"), 10);
        assert_eq!(sum_counts(""), 0);
    }

    #[test]
    fn parses_line_matches() {
        let text = "./src/main.rs:12:fn main() {\nCargo.toml:3:name = \"x\"";
        let m = parse_line_matches(text);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].path, "src/main.rs");
        assert_eq!(m[0].line, 12);
        assert_eq!(m[0].text, "fn main() {");
        assert_eq!(m[1].path, "Cargo.toml");
        assert_eq!(m[1].line, 3);
        assert_eq!(rel_path("./a/b"), "a/b");
        assert_eq!(rel_path("a/b"), "a/b");
    }

    #[test]
    fn parses_rg_json_context() {
        let text = r#"{"type":"begin","data":{"path":{"text":"./a.rs"}}}
{"type":"context","data":{"path":{"text":"./a.rs"},"line_number":1,"lines":{"text":"line1\n"}}}
{"type":"context","data":{"path":{"text":"./a.rs"},"line_number":2,"lines":{"text":"line2\n"}}}
{"type":"match","data":{"path":{"text":"./a.rs"},"line_number":3,"lines":{"text":"hit\n"},"submatches":[]}}
{"type":"context","data":{"path":{"text":"./a.rs"},"line_number":4,"lines":{"text":"line4\n"}}}
{"type":"end","data":{"path":{"text":"./a.rs"}}}"#;
        let m = parse_rg_json(text, 2);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].path, "a.rs");
        assert_eq!(m[0].line, 3);
        assert_eq!(m[0].text, "hit");
        assert_eq!(m[0].before, vec!["line1", "line2"]);
        assert_eq!(m[0].after, vec!["line4"]);
    }

    #[test]
    fn parses_grep_context_groups() {
        let text = "./a.rs-1-line1\n./a.rs-2-line2\n./a.rs:3:hit\n./a.rs-4-line4\n--\nb.rs:9:other";
        let m = parse_grep_page(text, 2);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].path, "a.rs");
        assert_eq!(m[0].line, 3);
        assert_eq!(m[0].before, vec!["line1", "line2"]);
        assert_eq!(m[0].after, vec!["line4"]);
        assert_eq!(m[1].path, "b.rs");
        assert_eq!(m[1].line, 9);
        assert!(m[1].before.is_empty());
    }

    #[test]
    fn finalize_paginates_with_exact_total() {
        let raw = RawResult {
            matches: (1..=6)
                .map(|i| RawMatch {
                    path: "f".into(),
                    line: i,
                    text: format!("t{i}"),
                    before: vec![],
                    after: vec![],
                })
                .collect(),
            total: 20,
        };
        let out = finalize(raw, 2, 3, 0);
        assert_eq!(out.total, 20);
        assert_eq!(out.matches.len(), 3);
        assert_eq!(out.matches[0]["line"], 3);
        assert!(out.truncated);
        assert_eq!(out.next_cursor, Some(5));
    }

    #[test]
    fn rg_flags_exclude_and_literal() {
        let f = rg_flags(true, false, "*.c");
        assert!(f.contains("-i"));
        assert!(f.contains("-F"));
        assert!(f.contains("-g '!.git'"));
        assert!(f.contains("--max-filesize 2097152"));
        assert!(f.contains("-g '*.c'"));
        assert!(!rg_flags(false, true, "*").contains("-g '*'"));
    }

    #[test]
    fn python_grep_skips_binary_and_oversize() {
        assert!(PYTHON_GREP.contains("b'\\x00' in raw[:8192]"));
        assert!(PYTHON_GREP.contains("os.path.getsize(full) > max_bytes"));
    }

    #[test]
    fn rc_falls_back_on_dialect_and_shell_failure() {
        assert!(rc_falls_back(2));
        assert!(rc_falls_back(126));
        assert!(rc_falls_back(127));
        assert!(rc_falls_back(137));
        assert!(!rc_falls_back(0));
        assert!(!rc_falls_back(1));
    }
}