//! `fs_patch`：按 `oldText/newText` 做远端替换，支持多文件与 dry-run diff。
//!
//! 走远端 python3 脚本（文件不回流、oldText 不唯一时回候选行号），写回采用
//! `临时文件 + os.replace` 原子替换。dry-run 只回 unified diff，不落盘。

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::ssh::client::{exec_once, SshHandle};
use crate::state::AppState;

use super::{caps, handle, path as pathutil, shell};

const MAX_EDITS: usize = 20;
const MAX_OPS_JSON_BYTES: usize = 256 * 1024;
const MAX_DIFF_CHARS: usize = 12_000;

const PYTHON_PATCH: &str = r#"import sys, json, os, hashlib, difflib
path, dry, ops_json = sys.argv[1], sys.argv[2] == '1', sys.argv[3]
ops = json.loads(ops_json)
try:
    with open(path, 'rb') as handle:
        raw = handle.read()
    original = raw.decode('utf-8')
except UnicodeDecodeError:
    print(json.dumps({'error': 'binary'}))
    sys.exit(0)
text = original
for index, op in enumerate(ops):
    old = op.get('oldText', '')
    new = op.get('newText', '')
    if not old:
        print(json.dumps({'error': 'empty_old_text', 'opIndex': index}))
        sys.exit(0)
    occurrences = text.count(old)
    if occurrences == 0:
        print(json.dumps({'error': 'no_match', 'opIndex': index}))
        sys.exit(0)
    if occurrences > 1 and not op.get('replaceAll', False):
        lines = [n + 1 for n, line in enumerate(text.splitlines()) if old in line][:20]
        print(json.dumps({'error': 'ambiguous', 'opIndex': index, 'count': occurrences, 'lines': lines}))
        sys.exit(0)
    text = text.replace(old, new) if op.get('replaceAll', False) else text.replace(old, new, 1)
data = text.encode('utf-8')
digest = hashlib.sha256(data).hexdigest()
diff = ''
if dry:
    diff = '\n'.join(difflib.unified_diff(
        original.splitlines(), text.splitlines(), fromfile=path, tofile=path, lineterm=''))
else:
    tmp = path + '.rssh-tmp'
    with open(tmp, 'wb') as handle:
        handle.write(data)
    os.replace(tmp, path)
print(json.dumps({'applied': len(ops), 'sha256': digest, 'diff': diff}))
"#;

#[derive(Debug, Deserialize)]
struct ScriptOutput {
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "opIndex")]
    op_index: Option<usize>,
    #[serde(default)]
    count: Option<usize>,
    #[serde(default)]
    lines: Vec<usize>,
    #[serde(default)]
    applied: usize,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    diff: String,
}

pub struct PatchResult {
    pub path: String,
    pub applied: usize,
    pub sha256: String,
    pub diff: Option<String>,
}

fn truncate_diff(diff: &str) -> String {
    if diff.chars().count() <= MAX_DIFF_CHARS {
        return diff.to_string();
    }
    let head: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    format!("{head}\n… (diff 已截断)")
}

pub async fn fs_patch(
    state: &AppState,
    session_id: &str,
    profile_id: &str,
    ssh: &SshHandle,
    args: &Value,
) -> AppResult<Vec<PatchResult>> {
    let edits = args
        .get("edits")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "edits" })))?;
    if edits.len() > MAX_EDITS {
        return Err(AppError::config(
            "mcp_too_many_edits",
            json!({ "count": edits.len(), "limit": MAX_EDITS }),
        ));
    }
    let dry_run = args.get("dryRun").and_then(Value::as_bool).unwrap_or(false);

    let remote_caps = caps::detect(ssh, profile_id).await?;
    if !remote_caps.python3 {
        return Err(AppError::config(
            "mcp_missing_interpreter",
            json!({ "required": "python3", "hint": "远端安装 python3 后重试" }),
        ));
    }

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;

    let mut results = Vec::new();
    for edit in edits {
        let input = edit
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "path" })))?;
        super::shell::validate_remote_path(input)?;
        let ops = edit
            .get("ops")
            .and_then(Value::as_array)
            .filter(|list| !list.is_empty())
            .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "ops" })))?;

        let target = pathutil::normalize(input, &home, &home)?;
        sftp.stat(&target)
            .await
            .map_err(|_| AppError::not_found("mcp_patch_not_found", json!({ "path": target })))?;

        let ops_json = serde_json::to_string(&Value::Array(ops.clone())).map_err(|e| {
            AppError::config("mcp_patch_invalid", json!({ "error": e.to_string() }))
        })?;
        if ops_json.len() > MAX_OPS_JSON_BYTES {
            return Err(AppError::config(
                "mcp_patch_too_large",
                json!({ "size": ops_json.len(), "limit": MAX_OPS_JSON_BYTES }),
            ));
        }

        let cmd = shell::build_script_cmd(
            "python3",
            PYTHON_PATCH,
            &[
                shell::prepare_remote_path(&target),
                shell::shell_quote(if dry_run { "1" } else { "0" }),
                shell::shell_quote(&ops_json),
            ],
        );
        let out = exec_once(ssh, &cmd, Duration::from_secs(120), false).await?;
        if out.exit_code != Some(0) {
            return Err(AppError::ssh(
                "mcp_patch_failed",
                json!({ "path": target, "exitCode": out.exit_code, "stderr": out.stderr }),
            ));
        }
        let parsed: ScriptOutput = serde_json::from_str(out.stdout.trim()).map_err(|_| {
            AppError::ssh(
                "mcp_patch_bad_output",
                json!({ "path": target, "stdout": out.stdout }),
            )
        })?;
        if let Some(error) = parsed.error.as_deref() {
            let op_index = parsed.op_index.unwrap_or(0);
            return Err(match error {
                "binary" => AppError::config("mcp_binary_file", json!({ "path": target })),
                "empty_old_text" => AppError::config(
                    "mcp_patch_empty_old",
                    json!({ "path": target, "opIndex": op_index }),
                ),
                "no_match" => AppError::config(
                    "mcp_patch_no_match",
                    json!({ "path": target, "opIndex": op_index }),
                ),
                "ambiguous" => AppError::config(
                    "mcp_patch_ambiguous",
                    json!({
                        "path": target,
                        "opIndex": op_index,
                        "count": parsed.count.unwrap_or(0),
                        "lines": parsed.lines,
                    }),
                ),
                other => AppError::config(
                    "mcp_patch_invalid",
                    json!({ "path": target, "error": other }),
                ),
            });
        }

        results.push(PatchResult {
            path: target,
            applied: parsed.applied,
            sha256: parsed.sha256,
            diff: if dry_run {
                Some(truncate_diff(&parsed.diff))
            } else {
                None
            },
        });
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_truncates_on_char_boundary() {
        let diff = "a".repeat(MAX_DIFF_CHARS + 5);
        let out = truncate_diff(&diff);
        assert!(out.ends_with("… (diff 已截断)"));
        assert!(out.chars().count() > MAX_DIFF_CHARS);
    }
}
