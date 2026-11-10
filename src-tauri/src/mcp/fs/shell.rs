//! MCP 侧远端 shell 拼装：复用 [`crate::ai::remote_script`]，仅把错误统一成 `AppError`。

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

pub use crate::ai::remote_script::{prepare_remote_path, shell_quote};

/// 单次调用允许注入的环境变量个数上限。
pub const MAX_ENV_VARS: usize = 64;
/// 单次调用环境变量名 + 值总字节上限。
pub const MAX_ENV_BYTES: usize = 64 * 1024;

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// 解析可选的 `env` 参数：键必须是合法 shell 变量名，值是字符串。
///
/// 返回按名字排序的列表，保证同一组 env 每次拼出的脚本完全一致。
pub fn parse_env(args: &Value) -> AppResult<Vec<(String, String)>> {
    let Some(raw) = args.get("env") else {
        return Ok(Vec::new());
    };
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let map = raw.as_object().ok_or_else(|| {
        AppError::config(
            "mcp_env_invalid",
            json!({ "reason": "env 必须是对象，例如 {\"CROSS_COMPILE\":\"arm-zephyr-eabi-\"}" }),
        )
    })?;
    if map.len() > MAX_ENV_VARS {
        return Err(AppError::config(
            "mcp_env_invalid",
            json!({ "reason": format!("env 最多 {MAX_ENV_VARS} 个变量"), "count": map.len() }),
        ));
    }
    let mut total = 0usize;
    let mut pairs = std::collections::BTreeMap::new();
    for (key, value) in map {
        if !is_env_name(key) {
            return Err(AppError::config(
                "mcp_env_invalid",
                json!({ "reason": "变量名必须是 [A-Za-z_][A-Za-z0-9_]*", "key": key }),
            ));
        }
        let Some(value) = value.as_str() else {
            return Err(AppError::config(
                "mcp_env_invalid",
                json!({ "reason": "变量值必须是字符串", "key": key }),
            ));
        };
        total += key.len() + value.len();
        pairs.insert(key.clone(), value.to_string());
    }
    if total > MAX_ENV_BYTES {
        return Err(AppError::config(
            "mcp_env_invalid",
            json!({ "reason": "env 总量超过上限", "bytes": total, "limit": MAX_ENV_BYTES }),
        ));
    }
    Ok(pairs.into_iter().collect())
}

/// 拼「export K='v'」行；值走 POSIX 单引号转义，注入不生效。
pub fn export_lines(env: &[(String, String)]) -> String {
    let mut out = String::new();
    for (key, value) in env {
        out.push_str(&format!("export {key}={}\n", shell_quote(value)));
    }
    out
}

/// 把 cwd / preamble / env / command 拼成一条远端脚本。
///
/// 顺序固定为 `cd → 会话 preamble → export → command`：preamble 先建立基础环境
/// （PATH、工具链），本次调用的 env 最后覆盖，语义等同「先 source 再带变量执行」；
/// cwd 不存在时往 stderr 打 `cd_marker` 并以 1 退出，让调用方明确报错而不是在
/// home 里跑错命令。每次调用都重新拼装，不依赖远端 shell 状态。
pub fn compose_remote_command(
    command: &str,
    cwd: Option<&str>,
    env: &[(String, String)],
    preamble: Option<&str>,
    cd_marker: &str,
) -> String {
    let mut script = String::new();
    if let Some(cwd) = cwd {
        script.push_str(&format!(
            "cd -- {} 2>/dev/null || {{ echo {cd_marker} >&2; exit 1; }}\n",
            prepare_remote_path(cwd)
        ));
    }
    if let Some(preamble) = preamble {
        let trimmed = preamble.trim_end();
        if !trimmed.trim().is_empty() {
            script.push_str(trimmed);
            script.push('\n');
        }
    }
    script.push_str(&export_lines(env));
    script.push_str(command);
    script
}

pub fn validate_remote_path(path: &str) -> AppResult<()> {
    crate::ai::remote_script::validate_path(path).map_err(|reason| {
        AppError::config(
            "mcp_path_invalid",
            json!({ "path": path, "reason": reason }),
        )
    })
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
    fn parse_env_accepts_names_and_strings() {
        let env = parse_env(&json!({ "env": { "CC": "clang", "PATH": "/a b:$PATH" } })).unwrap();
        assert_eq!(
            env,
            vec![
                ("CC".to_string(), "clang".to_string()),
                ("PATH".to_string(), "/a b:$PATH".to_string())
            ]
        );
        assert!(parse_env(&json!({})).unwrap().is_empty());
        assert!(parse_env(&json!({ "env": null })).unwrap().is_empty());
    }

    #[test]
    fn parse_env_rejects_bad_names_and_values() {
        for args in [
            json!({ "env": ["A=b"] }),
            json!({ "env": { "1A": "x" } }),
            json!({ "env": { "A-B": "x" } }),
            json!({ "env": { "A": 1 } }),
            json!({ "env": { "": "x" } }),
        ] {
            assert_eq!(parse_env(&args).unwrap_err().code(), "mcp_env_invalid");
        }
    }

    #[test]
    fn compose_orders_cd_env_preamble_command_and_quotes_values() {
        let env = vec![("CC".to_string(), "a b".to_string())];
        let script = compose_remote_command(
            "make -j8",
            Some("~/src"),
            &env,
            Some("source ~/zephyr-env.sh\n"),
            "__CD",
        );
        assert_eq!(
            script,
            "cd -- \"$HOME\"/'src' 2>/dev/null || { echo __CD >&2; exit 1; }\n\
             source ~/zephyr-env.sh\n\
             export CC='a b'\n\
             make -j8"
        );
        assert_eq!(
            compose_remote_command("uname -a", None, &[], None, "__CD"),
            "uname -a"
        );
    }

    #[test]
    fn compose_ignores_blank_preamble() {
        let script = compose_remote_command("ls", None, &[], Some("  \n"), "__CD");
        assert_eq!(script, "ls");
    }
}
