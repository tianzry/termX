//! `build_run`：远端编译/执行，尾部偏置截断 + 可选完整日志落远端。
//!
//! 为什么不用 `exec_once` 直接收 stdout：`exec_once` 按**头部**封顶 256 KiB，
//! 构建失败的关键信息通常在最末尾。这里让远端先把两个流写进临时文件，再用
//! `tail -c` 取尾部、`wc -c` 取总量，返回体积与构建规模无关。

use std::time::Duration;

use serde_json::{json, Value};

use crate::ai::remote_script::shell_quote;
use crate::error::{AppError, AppResult};
use crate::ssh::client::{exec_once, SshHandle};
use crate::state::AppState;

use super::{handle, path as jail, shell};

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const DEFAULT_MAX_OUTPUT_BYTES: u64 = 16 * 1024;
pub const MIN_MAX_OUTPUT_BYTES: u64 = 256;
pub const MAX_MAX_OUTPUT_BYTES: u64 = 64 * 1024;
/// 单条命令长度上限，避免远程 `exec` 请求体过大。
const MAX_COMMAND_BYTES: usize = 64 * 1024;

pub struct BuildOutcome {
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub truncated: bool,
    pub full_log: Option<String>,
    pub tee_failed: bool,
    pub cwd: String,
}

fn metric(text: &str, marker: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.trim().strip_prefix(marker)?;
        rest.trim_start_matches(':').trim().parse().ok()
    })
}

/// 取两个 marker 行之间的内容；`end=None` 时取到结尾并去掉末尾空行。
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
    while body
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        body.pop();
    }
    Some(body.join("\n"))
}

pub async fn fs_build_run(
    state: &AppState,
    session_id: &str,
    ssh: &SshHandle,
    args: &Value,
    jail_root: &str,
) -> AppResult<BuildOutcome> {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("mcp_missing_argument", json!({ "arg": "command" })))?;
    if command.len() > MAX_COMMAND_BYTES {
        return Err(AppError::config(
            "mcp_command_too_long",
            json!({ "bytes": command.len(), "limit": MAX_COMMAND_BYTES }),
        ));
    }
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS);
    let max_output = args
        .get("maxOutputBytes")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_MAX_OUTPUT_BYTES)
        .clamp(MIN_MAX_OUTPUT_BYTES, MAX_MAX_OUTPUT_BYTES);
    let tee_input = args
        .get("teeToRemoteFile")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let sftp = handle::sftp_for(state, session_id).await?;
    let home = sftp.home_dir().await?;
    let root = jail::normalize(jail_root, &home, &home)?;

    let cwd = match args
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(input) => {
            shell::validate_remote_path(input)?;
            let target = jail::normalize(input, &home, &root)?;
            jail::check(&root, &target)?;
            let real = sftp.realpath(&target).await?;
            jail::check(&root, &real)?;
            real
        }
        None => root.clone(),
    };

    let tee = match tee_input {
        Some(input) => {
            shell::validate_remote_path(input)?;
            let target = jail::normalize(input, &home, &root)?;
            jail::check(&root, &target)?;
            if let Ok(real) = sftp.realpath(&target).await {
                jail::check(&root, &real)?;
            }
            Some(target)
        }
        None => None,
    };

    let tag = {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let short = &id[..8];
        format!("__TERMX_{short}")
    };
    let short = tag.trim_start_matches("__TERMX_").to_string();
    let out_file = format!("/tmp/termx-build-{short}.out");
    let err_file = format!("/tmp/termx-build-{short}.err");
    let m_ec = format!("{tag}_EC");
    let m_out_bytes = format!("{tag}_OUT_BYTES");
    let m_err_bytes = format!("{tag}_ERR_BYTES");
    let m_out_tail = format!("{tag}_OUT_TAIL");
    let m_err_tail = format!("{tag}_ERR_TAIL");
    let m_tee_failed = format!("{tag}_TEE_FAILED");
    let m_cd_failed = format!("{tag}_CD_FAILED");

    let tee_step = match &tee {
        Some(path) => format!(
            "cat {out} {err} > {tee} 2>/dev/null || echo {marker}\n",
            out = shell_quote(&out_file),
            err = shell_quote(&err_file),
            tee = shell_quote(path),
            marker = &m_tee_failed,
        ),
        None => String::new(),
    };

    let script = format!(
        "cd {cwd} || {{ echo {cd_failed}; exit 0; }}\n\
         (\n{command}\n) > {out} 2> {err}\n\
         ec=$?\n\
         echo {m_ec}:$ec\n\
         {tee_step}\
         echo {m_out_bytes}:$(wc -c < {out})\n\
         echo {m_err_bytes}:$(wc -c < {err})\n\
         echo {m_out_tail}\n\
         tail -c {n} {out}\n\
         echo \"\"\n\
         echo {m_err_tail}\n\
         tail -c {n} {err}\n\
         echo \"\"\n\
         rm -f {out} {err}\n",
        cwd = shell_quote(&cwd),
        cd_failed = &m_cd_failed,
        command = command,
        out = shell_quote(&out_file),
        err = shell_quote(&err_file),
        n = max_output,
    );

    let exec = exec_once(ssh, &script, Duration::from_millis(timeout_ms), false).await?;
    let text = exec.stdout;
    if text.lines().any(|line| line.trim() == m_cd_failed) {
        return Err(AppError::config(
            "mcp_cwd_invalid",
            json!({ "cwd": cwd, "hint": "cwd 不存在或不可进入" }),
        ));
    }
    let exit_code = metric(&text, &m_ec).map(|value| value as i32);
    let stdout_bytes = metric(&text, &m_out_bytes).unwrap_or(0);
    let stderr_bytes = metric(&text, &m_err_bytes).unwrap_or(0);
    let stdout_tail = section(&text, &m_out_tail, Some(&m_err_tail)).unwrap_or_default();
    let stderr_tail = section(&text, &m_err_tail, None).unwrap_or_default();
    let tee_failed = text.lines().any(|line| line.trim() == m_tee_failed);

    Ok(BuildOutcome {
        exit_code,
        truncated: stdout_bytes > stdout_tail.len() as u64
            || stderr_bytes > stderr_tail.len() as u64,
        stdout_tail,
        stderr_tail,
        stdout_bytes,
        stderr_bytes,
        full_log: tee.filter(|_| !tee_failed),
        tee_failed,
        cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_metrics_and_sections() {
        let text = "__M_EC:2
__M_OUT_BYTES:120
__M_ERR_BYTES:7
__M_OUT_TAIL
line1
line2
__M_ERR_TAIL
boom
";
        assert_eq!(metric(text, "__M_EC"), Some(2));
        assert_eq!(metric(text, "__M_OUT_BYTES"), Some(120));
        assert_eq!(metric(text, "__M_ERR_BYTES"), Some(7));
        assert_eq!(
            section(text, "__M_OUT_TAIL", Some("__M_ERR_TAIL")).unwrap(),
            "line1\nline2"
        );
        assert_eq!(section(text, "__M_ERR_TAIL", None).unwrap(), "boom");
    }

    #[test]
    fn section_requires_marker_line() {
        let text = "prefix __M_OUT_TAIL\nbody\n__M_ERR_TAIL\n";
        assert!(section(text, "__M_OUT_TAIL", Some("__M_ERR_TAIL")).is_none());
    }
}
