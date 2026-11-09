//! MCP 工具分级权限矩阵。
//!
//! 与 `config::PermissionMode` 三档叠加：read 永远放行；delete 在任何档位都
//! 需要二次确认（dry-run + confirmToken 之外的审批）；其余按档位判定。

use super::config::PermissionMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolClass {
    /// 只读：get_environment / fs_read / fs_grep / fs_glob。
    Read,
    /// 写入：fs_patch / fs_write / sftp_put。
    Write,
    /// 删除：fs_delete。
    Delete,
    /// 下载：sftp_get。
    Transfer,
    /// 执行：build_run / term_run。
    Build,
    /// 会话管理：session_close。
    Session,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
    /// 需要用户审批（confirm 档位，或 delete 类的强制确认）。
    Ask,
}

pub fn classify(tool: &str) -> ToolClass {
    match tool {
        "fs_read" | "fs_grep" | "fs_glob" | "get_environment" | "vault_hosts_list"
        | "snippets_list" => ToolClass::Read,
        "fs_patch" | "fs_write" | "sftp_put" => ToolClass::Write,
        "fs_delete" => ToolClass::Delete,
        "sftp_get" => ToolClass::Transfer,
        "build_run" | "term_run" | "terminal_execute" => ToolClass::Build,
        _ => ToolClass::Session,
    }
}

pub fn decide(mode: PermissionMode, class: ToolClass) -> Decision {
    if class == ToolClass::Read {
        return Decision::Allow;
    }
    if mode == PermissionMode::Observer {
        return Decision::Deny;
    }
    // 删除在任何档位都必须走确认（auto 也不例外）。
    if class == ToolClass::Delete {
        return Decision::Ask;
    }
    match mode {
        PermissionMode::Auto => Decision::Allow,
        _ => Decision::Ask,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_is_always_allowed() {
        for mode in [
            PermissionMode::Observer,
            PermissionMode::Confirm,
            PermissionMode::Auto,
        ] {
            assert_eq!(decide(mode, ToolClass::Read), Decision::Allow);
        }
    }

    #[test]
    fn observer_denies_everything_else() {
        assert_eq!(
            decide(PermissionMode::Observer, ToolClass::Write),
            Decision::Deny
        );
        assert_eq!(
            decide(PermissionMode::Observer, ToolClass::Build),
            Decision::Deny
        );
        assert_eq!(
            decide(PermissionMode::Observer, ToolClass::Session),
            Decision::Deny
        );
    }

    #[test]
    fn auto_allows_write_but_asks_for_delete() {
        assert_eq!(
            decide(PermissionMode::Auto, ToolClass::Write),
            Decision::Allow
        );
        assert_eq!(
            decide(PermissionMode::Auto, ToolClass::Delete),
            Decision::Ask
        );
        assert_eq!(
            decide(PermissionMode::Confirm, ToolClass::Write),
            Decision::Ask
        );
    }

    #[test]
    fn tool_names_map_to_classes() {
        assert_eq!(classify("fs_grep"), ToolClass::Read);
        assert_eq!(classify("fs_patch"), ToolClass::Write);
        assert_eq!(classify("fs_delete"), ToolClass::Delete);
        assert_eq!(classify("sftp_get"), ToolClass::Transfer);
        assert_eq!(classify("build_run"), ToolClass::Build);
        assert_eq!(classify("session_close"), ToolClass::Session);
    }
}
