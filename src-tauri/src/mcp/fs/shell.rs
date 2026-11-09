//! MCP 侧远端 shell 拼装：复用 [`crate::ai::remote_script`]，仅把错误统一成 `AppError`。

use serde_json::json;

use crate::error::{AppError, AppResult};

pub use crate::ai::remote_script::{prepare_remote_path, shell_quote};

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
