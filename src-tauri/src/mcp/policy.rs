//! 逃生平面命令策略：只拦真正破坏性的操作，不做「白名单/构建工具识别」。
//!
//! 与 `ai::command_blacklist` / `mcp::blocklist` 的区别：那两套面向终端命令全文拦截，
//! 容易误杀 `rm build/*.o`、`grep -r "mkfs" docs/` 这类正常构建操作。文件语义已由
//! typed 工具承担，这里只保留「一旦执行就不可收拾」的少量模式，供 `build_run` /
//! `term_run` 共用。

use std::sync::OnceLock;

use regex::Regex;

struct Rule {
    regex: Regex,
    label: &'static str,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        const PATTERNS: &[(&str, &str)] = &[
            (r"(?i)\brm\s+(?:-\S+\s+)*/(?:\*|\s|$)", "rm -rf /"),
            (
                r"(?im)(?:^|[;&|]\s*|\bsudo\s+)\s*mkfs(?:\.\w+)?\b",
                "格式化文件系统",
            ),
            (r"(?i)\bdd\b[^\n]*\bof=/dev/", "dd 直写块设备"),
            (
                r"(?im)(?:^|[;&|]\s*|\bsudo\s+)\s*(shutdown|reboot|poweroff|halt)\b",
                "关机/重启",
            ),
            (r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", "fork 炸弹"),
            (
                r"(?im)(?:^|[;&|]\s*|\bsudo\s+)\s*(wipefs|fdisk|parted)\b",
                "磁盘分区工具",
            ),
            (r"(?i)\bchmod\s+-R\s+777\s+/", "chmod -R 777 /"),
            (r"(?i)>\s*/dev/(sd|nvme|hd)", "直写块设备"),
        ];
        PATTERNS
            .iter()
            .filter_map(|(pattern, label)| {
                Regex::new(pattern).ok().map(|regex| Rule { regex, label })
            })
            .collect()
    })
}

/// 命中返回人类可读的原因；未命中返回 None（放行）。
pub fn destructive_reason(command: &str) -> Option<&'static str> {
    rules()
        .iter()
        .find(|rule| rule.regex.is_match(command))
        .map(|rule| rule.label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_build_commands() {
        for command in [
            "make -j8",
            "cargo build --release",
            "npm run build",
            "rm build/*.o",
            "grep -r mkfs docs/",
            "python3 -m pytest -q",
        ] {
            assert!(
                destructive_reason(command).is_none(),
                "误杀正常命令: {command}"
            );
        }
    }

    #[test]
    fn blocks_destructive_commands() {
        for command in [
            "sudo rm -rf /",
            "rm -rf --no-preserve-root /",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda",
            "shutdown -h now",
            ":(){ :|:& };:",
            "wipefs -a /dev/sdb",
        ] {
            assert!(
                destructive_reason(command).is_some(),
                "未拦截破坏性命令: {command}"
            );
        }
    }
}
