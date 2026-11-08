//! 命令黑名单（正则层）。
//!
//! 1:1 移植 Netcatty `lib/commandBlocklist.json` 的正则清单与匹配语义：
//! - 默认清单逐条照抄（common / posixNative / posix / powershell 分组平铺）；
//! - 匹配大小写不敏感（Netcatty 编译时统一加 `i` 标志）；
//! - 用户规则优先，其次才是默认规则；默认规则只有在仍留在清单里时才生效
//!   （删掉某条默认规则即禁用该条，对齐 Netcatty `commandSafety.cjs`）；
//! - 仅拦 AI / MCP 发起的执行，**不拦用户在终端里的手动输入**：Netcatty 只把
//!   这个检查挂在 agent / MCP 执行链路上（`mcpServerBridge.cjs`、`netcatty-mcp-server.cjs`），
//!   用户手动输入不会经过它。
//!
//! termX 不改写任何一条默认正则；含 `(?=...)` 的规则用 `fancy-regex` 编译，
//! `regex` crate 不支持前瞻。

use crate::db::{settings, Db};
use crate::error::AppResult;

pub const KEY_BLOCKLIST: &str = "mcp.command_blocklist";

/// Netcatty 默认清单（`lib/commandBlocklist.json` 各分组按出现顺序平铺，共 21 条）。
pub const DEFAULT_PATTERNS: &[&str] = &[
    // common
    r"\brm\s+(?=[^\n;&|]*(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b|-[a-zA-Z]*r[a-zA-Z]*\b[^\n;&|]*-[a-zA-Z]*f[a-zA-Z]*\b|-[a-zA-Z]*f[a-zA-Z]*\b[^\n;&|]*-[a-zA-Z]*r[a-zA-Z]*\b|--recursive\b[^\n;&|]*(?:--force\b|-[a-zA-Z]*f[a-zA-Z]*\b)|(?:--force\b|-[a-zA-Z]*f[a-zA-Z]*\b)[^\n;&|]*--recursive\b))",
    r"\b(shutdown|reboot|poweroff|halt)\b",
    // posixNative
    r"\bmkfs\.",
    r"\bdd\s+if=.*\s+of=/dev/",
    r">\s*/dev/sd",
    r"\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s+777\s+/",
    r"\bmv\s+/\s",
    r"\bcurl\s+.*\|\s*\bsudo\s+\bbash\b",
    r"\bwget\s+.*\|\s*\bsudo\s+\bbash\b",
    r"base64.*\|.*(?:ba)?sh",
    // posix
    r":\(\)\{\s*:\|:&\s*\};:",
    r":\s*>\s*/etc/",
    r"\beval\b",
    r"\$\(",
    r"`.+`",
    // powershell
    r"\b(Remove-Item|del|erase|rd|ri|rm|rmdir)\b[^\n;&|]*-(rec\w*|re|r)\b[^\n;&|]*-(fo\w*|f)\b",
    r"\b(Remove-Item|del|erase|rd|ri|rm|rmdir)\b[^\n;&|]*-(fo\w*|f)\b[^\n;&|]*-(rec\w*|re|r)\b",
    r"\b(iex|Invoke-Expression)\b",
    r"\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n;&|]*\|\s*(iex|Invoke-Expression)\b",
    r"\bSet-ExecutionPolicy\b[^\n;&|]*\b(Bypass|Unrestricted)\b",
    r"\b(Format-Volume|Clear-Disk|Initialize-Disk|Stop-Computer|Restart-Computer)\b",
];

fn default_patterns() -> Vec<String> {
    DEFAULT_PATTERNS.iter().map(|p| p.to_string()).collect()
}

/// 恢复出厂清单（用户自定义项会被清空，对齐 Netcatty `SafetySettings` 的「恢复默认」）。
pub fn reset(db: &Db) -> AppResult<Vec<String>> {
    let list = default_patterns();
    save(db, &list)?;
    Ok(list)
}

pub fn load(db: &Db) -> Vec<String> {
    let configured = settings::get(db, KEY_BLOCKLIST)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_else(default_patterns);
    configured
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .collect()
}

pub fn save(db: &Db, patterns: &[String]) -> AppResult<()> {
    let raw = serde_json::to_string(patterns).unwrap_or_else(|_| "[]".to_string());
    settings::set(db, KEY_BLOCKLIST, &raw)
}

/// 编译单条正则并忽略大小写；非法正则静默跳过（不阻断其余规则）。
fn matches(pattern: &str, text: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    // fancy-regex 只能通过内联标志设置大小写不敏感（对齐 Netcatty 的 `i` 标志）。
    let source = format!("(?i){pattern}");
    fancy_regex::Regex::new(&source)
        .map(|re| re.is_match(text).unwrap_or(false))
        .unwrap_or(false)
}

/// 返回首个命中的规则原文（用于告诉调用方到底撞了哪条）。
///
/// 顺序对齐 Netcatty：用户自定义规则优先，其次是仍保留在清单里的默认规则。
pub fn first_match(patterns: &[String], command: &str) -> Option<String> {
    if command.trim().is_empty() {
        return None;
    }
    let defaults = DEFAULT_PATTERNS;
    for pattern in patterns {
        if defaults.iter().any(|d| *d == pattern.as_str()) {
            continue;
        }
        if matches(pattern, command) {
            return Some(pattern.clone());
        }
    }
    for pattern in defaults {
        let kept = patterns.iter().any(|p| p == pattern);
        if kept && matches(pattern, command) {
            return Some(pattern.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Vec<String> {
        default_patterns()
    }

    #[test]
    fn blocks_signature_dangerous_commands() {
        let list = cfg();
        for command in [
            "rm -rf /",
            "shutdown -h now",
            "reboot",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda bs=1M",
            "echo hi > /dev/sda",
        ] {
            assert!(
                first_match(&list, command).is_some(),
                "应当命中黑名单：{command}"
            );
        }
    }

    #[test]
    fn allows_safe_commands() {
        let list = cfg();
        for command in ["ls -la", "df -h", "npm run build", "cat /etc/hosts"] {
            assert!(
                first_match(&list, command).is_none(),
                "不应命中黑名单：{command}"
            );
        }
    }

    #[test]
    fn user_rule_wins_and_missing_default_is_disabled() {
        let mut list = vec!["systemctl stop nginx".to_string()];
        assert_eq!(
            first_match(&list, "systemctl stop nginx").as_deref(),
            Some("systemctl stop nginx")
        );
        assert!(
            first_match(&list, "shutdown -h now").is_none(),
            "默认规则被移除后不应再生效"
        );
        list.push(r"\b(shutdown|reboot|poweroff|halt)\b".to_string());
        assert!(first_match(&list, "shutdown -h now").is_some());
    }

    #[test]
    fn empty_and_invalid_patterns_are_skipped() {
        let list = vec!["".to_string(), "(".to_string()];
        assert!(first_match(&list, "anything").is_none());
    }
}
