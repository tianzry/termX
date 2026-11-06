//! known_hosts 路径策略：复用系统标准位置 `~/.ssh/known_hosts`，
//! 让用户在 OpenSSH / termx / 其他 SSH 客户端之间共享同一份信任链。
//!
//! 移动端没有可依赖的用户 home，退到 app_data_dir/.ssh/known_hosts。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// known_hosts 单条解析结果（供「已知主机」管理页展示）。
#[derive(Debug, Clone, Serialize)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub public_key: String,
    /// `SHA256:...` 指纹，用 russh 对公钥原文计算，与连接校验一致。
    pub fingerprint: String,
    /// `|1|...` 哈希条目：明文主机名不可恢复，管理页只读展示。
    pub hashed: bool,
}

/// 解析一行 known_hosts。注释 / 空行 / 字段不足 / 公钥非法 → None（跳过）。
/// 解析规则对齐 netcatty `KnownHostsManager`：
/// - host 字段逗号分隔多模式时取第一个；
/// - `[host]:port` 方括号写法提取端口；
/// - `|1|` 开头视为哈希条目。
pub fn parse_line(line: &str) -> Option<KnownHostEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let mut parts = trimmed.split_whitespace();
    let host_field = parts.next()?;
    let key_type = parts.next()?;
    let public_key = parts.next()?;
    let hashed = host_field.starts_with("|1|");
    let (host, port) = if hashed {
        ("(hashed)".to_string(), 22)
    } else {
        parse_host_port(host_field.split(',').next().unwrap_or(host_field))
    };
    let key = russh::keys::ssh_key::PublicKey::from_openssh(&format!(
        "{key_type} {public_key}"
    ))
    .ok()?;
    let fingerprint = key
        .fingerprint(russh::keys::HashAlg::Sha256)
        .to_string();
    Some(KnownHostEntry {
        host,
        port,
        key_type: key_type.to_string(),
        public_key: public_key.to_string(),
        fingerprint,
        hashed,
    })
}

/// `example.com` / `example.com:2222` / `[example.com]:2222` → (host, port)。
/// 纯 IPv6（多段冒号、无方括号端口）不拆，原样当主机名。
fn parse_host_port(field: &str) -> (String, u16) {
    if let Some(rest) = field.strip_prefix('[') {
        if let Some(idx) = rest.rfind(']') {
            let host = rest[..idx].to_string();
            let port = rest[idx + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(22);
            return (host, port);
        }
    }
    if let Some((h, p)) = field.rsplit_once(':') {
        if !h.is_empty() && !h.contains(':') && p.parse::<u16>().is_ok() {
            if let Ok(port) = p.parse::<u16>() {
                return (h.to_string(), port);
            }
        }
    }
    (field.to_string(), 22)
}

/// 整份 known_hosts 文本 → 结构化条目，坏行静默跳过。
pub fn parse_known_hosts(content: &str) -> Vec<KnownHostEntry> {
    content.lines().filter_map(parse_line).collect()
}

/// 解析 known_hosts 文件路径。`fallback_dir` 仅移动端使用。
pub fn path_for(fallback_dir: &Path) -> PathBuf {
    #[cfg(mobile)]
    {
        return fallback_dir.join(".ssh").join("known_hosts");
    }
    #[cfg(desktop)]
    {
        let _ = fallback_dir;
        if let Some(home) = dirs::home_dir() {
            home.join(".ssh").join("known_hosts")
        } else {
            // 不正常的环境（CI、容器无 HOME）兜底
            fallback_dir.join("known_hosts")
        }
    }
}

/// 非哈希条目的去重键：host + port + 密钥类型 + 公钥原文。
/// 同一主机不同密钥（轮换 / 多算法）视为不同条目，都保留。
fn entry_key(host: &str, port: u16, key_type: &str, public_key: &str) -> String {
    format!("{host}|{port}|{key_type}|{public_key}")
}

/// 把外部 known_hosts 文本去重合并进 `path` 文件，返回新增条数。
/// 对齐 netcatty「导入文件 / 扫描系统」的合并语义：
/// - 注释 / 空行 / 坏行（公钥非法等）跳过；
/// - 非哈希条目按 (host, port, key_type, public_key) 去重，写入时规范化为
///   `host` 或 `[host]:port` 形式；
/// - 哈希条目（`|1|...`）明文不可恢复，按整行精确去重，原样追加。
pub fn merge_entries(content: &str, path: &Path) -> std::io::Result<usize> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut seen_lines: HashSet<String> = HashSet::new();
    for line in existing.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        seen_lines.insert(t.to_string());
        if let Some(e) = parse_line(t) {
            if !e.hashed {
                seen.insert(entry_key(&e.host, e.port, &e.key_type, &e.public_key));
            }
        }
    }
    let mut additions: Vec<String> = Vec::new();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some(e) = parse_line(t) else {
            continue;
        };
        if e.hashed {
            if seen_lines.insert(t.to_string()) {
                additions.push(t.to_string());
            }
        } else if seen.insert(entry_key(&e.host, e.port, &e.key_type, &e.public_key)) {
            let host_field = if e.port == 22 {
                e.host.clone()
            } else {
                format!("[{}]:{}", e.host, e.port)
            };
            additions.push(format!("{host_field} {} {}", e.key_type, e.public_key));
        }
    }
    if additions.is_empty() {
        return Ok(0);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    for l in &additions {
        out.push_str(l);
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(additions.len())
}

/// 删除 `host:port` 在 known_hosts 中的所有匹配条目，返回删除条数。
/// 用于 host key 变更后用户在终端中确认 'replace' 的场景——移动端没有
/// 命令行 `ssh-keygen -R`，所以由我们就地实现。
///
/// 复用 russh 的 `known_host_keys_path` 定位匹配行（含 hashed `|1|...` 条目），
/// 只重写文件，不解析 host 模式——把模式匹配 deleg 给 russh 是好品味。
pub fn remove_host(host: &str, port: u16, path: &Path) -> std::io::Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    let matches = russh::keys::known_hosts::known_host_keys_path(host, port, path)
        .map_err(|e| std::io::Error::other(format!("known_host_keys_path: {e}")))?;
    if matches.is_empty() {
        return Ok(0);
    }
    let drop_lines: HashSet<usize> = matches.iter().map(|(n, _)| *n).collect();
    let content = std::fs::read_to_string(path)?;
    let mut out = String::new();
    let mut removed = 0;
    // russh 的行号是"非注释行"序号：注释行 skip 不递增，其他（含空行）递增。
    // 我们用并行计数器 mirror 这套规则，否则注释/空行会让物理 idx 与 russh 行号错位，
    // 导致误删邻近条目。判断"是不是注释"用首字节比对，与 russh 一致——
    // 不要 trim：以空格开头再跟 `#`，russh 视作有效行，我们也要跟着。
    let mut russh_line: usize = 1;
    for line in content.lines() {
        let is_comment = line.as_bytes().first() == Some(&b'#');
        if is_comment {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if drop_lines.contains(&russh_line) {
            removed += 1;
        } else {
            out.push_str(line);
            out.push('\n');
        }
        russh_line += 1;
    }
    std::fs::write(path, out)?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个合法的 ed25519 公钥（base64 已校验，固定字面量供测试用）。
    /// 不是任何真实主机的密钥，只是格式合法的样本。
    const SAMPLE_ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILZqOrxKsAQNKvmw0XX0pQrDrlBJpZj9PLfZN1RNxVFL";

    fn write_known_hosts(path: &Path, lines: &[&str]) {
        let body = lines.join("\n") + "\n";
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn remove_host_returns_zero_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nope");
        assert_eq!(remove_host("anything", 22, &p).unwrap(), 0);
    }

    #[test]
    fn remove_host_returns_zero_when_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        write_known_hosts(
            &p,
            &[
                &format!("alpha.example {SAMPLE_ED25519}"),
                &format!("beta.example {SAMPLE_ED25519}"),
            ],
        );
        assert_eq!(remove_host("gamma.example", 22, &p).unwrap(), 0);
        // 文件未被修改：两行都还在
        let after = std::fs::read_to_string(&p).unwrap();
        assert!(after.contains("alpha.example"));
        assert!(after.contains("beta.example"));
    }

    #[test]
    fn remove_host_drops_matching_line_keeps_others() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        write_known_hosts(
            &p,
            &[
                &format!("target.example {SAMPLE_ED25519}"),
                &format!("other.example {SAMPLE_ED25519}"),
            ],
        );
        let removed = remove_host("target.example", 22, &p).unwrap();
        assert_eq!(removed, 1);
        let after = std::fs::read_to_string(&p).unwrap();
        assert!(!after.contains("target.example"));
        assert!(after.contains("other.example"));
    }

    #[test]
    fn remove_host_drops_all_matching_lines() {
        // 同一个 host 写多行（轮换 key 时容易出现）— 应当全删
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        write_known_hosts(
            &p,
            &[
                &format!("dup.example {SAMPLE_ED25519}"),
                &format!("keep.example {SAMPLE_ED25519}"),
                &format!("dup.example {SAMPLE_ED25519}"),
            ],
        );
        let removed = remove_host("dup.example", 22, &p).unwrap();
        assert_eq!(removed, 2);
        let after = std::fs::read_to_string(&p).unwrap();
        assert!(!after.contains("dup.example"));
        assert!(after.contains("keep.example"));
    }

    /// 回归 net：known_hosts 含空行/注释时不能误删邻近条目。
    /// 早期实现把物理行号当成 russh 行号，alpha 会被误删。
    #[test]
    fn remove_host_preserves_unrelated_garbage_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        let body = format!(
            "# comment line\n\nalpha.example {SAMPLE_ED25519}\ntarget.example {SAMPLE_ED25519}\n# tail\n"
        );
        std::fs::write(&p, body).unwrap();
        let removed = remove_host("target.example", 22, &p).unwrap();
        assert_eq!(removed, 1);
        let after = std::fs::read_to_string(&p).unwrap();
        assert!(after.contains("# comment line"));
        assert!(after.contains("alpha.example"));
        assert!(after.contains("# tail"));
        assert!(!after.contains("target.example"));
    }

    #[test]
    fn parse_line_plain_host_default_port_and_fingerprint() {
        let e = parse_line(&format!("example.com {SAMPLE_ED25519} user@note")).unwrap();
        assert_eq!(e.host, "example.com");
        assert_eq!(e.port, 22);
        assert_eq!(e.key_type, "ssh-ed25519");
        assert!(!e.hashed);
        assert!(e.fingerprint.starts_with("SHA256:"));
        assert!(!e.fingerprint.is_empty());
    }

    #[test]
    fn parse_line_bracketed_port() {
        let e = parse_line(&format!("[example.com]:2222 {SAMPLE_ED25519}")).unwrap();
        assert_eq!(e.host, "example.com");
        assert_eq!(e.port, 2222);
    }

    #[test]
    fn parse_line_bare_host_colon_port() {
        let e = parse_line(&format!("example.com:2200 {SAMPLE_ED25519}")).unwrap();
        assert_eq!(e.host, "example.com");
        assert_eq!(e.port, 2200);
    }

    #[test]
    fn parse_line_ipv6_without_port_is_not_split() {
        let e = parse_line(&format!("fe80::1 {SAMPLE_ED25519}")).unwrap();
        assert_eq!(e.host, "fe80::1");
        assert_eq!(e.port, 22);
    }

    #[test]
    fn parse_line_comma_pattern_takes_first() {
        let e = parse_line(&format!(
            "first.example,second.example {SAMPLE_ED25519}"
        ))
        .unwrap();
        assert_eq!(e.host, "first.example");
    }

    #[test]
    fn parse_line_hashed_entry() {
        let e = parse_line("|1|abcsalt|defhash ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILZqOrxKsAQNKvmw0XX0pQrDrlBJpZj9PLfZN1RNxVFL").unwrap();
        assert!(e.hashed);
        assert_eq!(e.host, "(hashed)");
        assert_eq!(e.port, 22);
    }

    #[test]
    fn parse_line_skips_bad_input() {
        assert!(parse_line("").is_none());
        assert!(parse_line("# comment").is_none());
        assert!(parse_line("only-one-field").is_none());
        assert!(parse_line("two fields").is_none());
        // 非法 base64 / 非法 key type → 跳过
        assert!(parse_line("example.com not-a-key-type AAAA").is_none());
        assert!(parse_line(&format!("example.com ssh-ed25519 @@@notbase64@@@")).is_none());
    }

    #[test]
    fn parse_known_hosts_skips_garbage_keeps_good() {
        let content = format!(
            "# header\n\nalpha.example {SAMPLE_ED25519}\nbroken line\n[beta.example]:2222 {SAMPLE_ED25519}\n"
        );
        let entries = parse_known_hosts(&content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host, "alpha.example");
        assert_eq!(entries[1].host, "beta.example");
        assert_eq!(entries[1].port, 2222);
    }

    #[test]
    fn merge_entries_into_missing_file_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".ssh").join("known_hosts");
        let n = merge_entries(&format!("alpha.example {SAMPLE_ED25519}\n"), &p).unwrap();
        assert_eq!(n, 1);
        let after = std::fs::read_to_string(&p).unwrap();
        assert!(after.contains("alpha.example"));
    }

    #[test]
    fn merge_entries_dedups_same_entry_keeps_different_keys() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        write_known_hosts(&p, &[&format!("alpha.example {SAMPLE_ED25519}")]);
        // 完全重复 → 不加；同主机不同端口 → 加；注释/坏行 → 跳过
        let incoming = format!(
            "alpha.example {SAMPLE_ED25519}\n[alpha.example]:2222 {SAMPLE_ED25519}\n# note\nbroken line\n"
        );
        let n = merge_entries(&incoming, &p).unwrap();
        assert_eq!(n, 1);
        let after = std::fs::read_to_string(&p).unwrap();
        assert_eq!(after.matches("ssh-ed25519").count(), 2);
        assert!(after.contains("[alpha.example]:2222"));
    }

    #[test]
    fn merge_entries_normalizes_host_field_and_appends_newline() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        // 既有文件结尾无换行，合并后不能把两行黏在一起
        std::fs::write(&p, format!("keep.example {SAMPLE_ED25519}")).unwrap();
        let n = merge_entries(&format!("bare.example:2200 {SAMPLE_ED25519}\n"), &p)
            .unwrap();
        assert_eq!(n, 1);
        let after = std::fs::read_to_string(&p).unwrap();
        // 裸 host:port 规范化为 [host]:port；结尾换行补齐，两行不黏连
        assert!(after.contains("[bare.example]:2200 ssh-ed25519"));
        assert!(after.contains("keep.example"));
        assert!(!after.contains("ssh-ed25519bare"));
    }

    #[test]
    fn merge_entries_hashed_lines_dedup_by_exact_line() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        let hashed = format!("|1|abcsalt|defhash {SAMPLE_ED25519}");
        write_known_hosts(&p, &[&hashed]);
        let n = merge_entries(&format!("{hashed}\n|1|othersalt|otherhash {SAMPLE_ED25519}\n"), &p)
            .unwrap();
        assert_eq!(n, 1);
        let after = std::fs::read_to_string(&p).unwrap();
        assert_eq!(after.matches("|1|").count(), 2);
    }

    #[test]
    fn merge_entries_all_duplicates_returns_zero_and_keeps_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("known_hosts");
        write_known_hosts(&p, &[&format!("alpha.example {SAMPLE_ED25519}")]);
        let before = std::fs::read_to_string(&p).unwrap();
        let n = merge_entries(&format!("alpha.example {SAMPLE_ED25519}\n"), &p).unwrap();
        assert_eq!(n, 0);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), before);
    }

    #[test]
    fn path_for_returns_some_path_under_home_or_fallback() {
        // path_for 在 desktop 下走 home_dir() 或 fallback_dir。
        // 不验证具体路径（CI 环境 HOME 不一定存在），只保证返回值以
        // `known_hosts` 结尾且非空。
        let dir = tempfile::tempdir().unwrap();
        let p = path_for(dir.path());
        assert!(p.ends_with("known_hosts"), "got {}", p.display());
    }
}
