//! 许可记忆表（Confirm 模式放行规则）。
//!
//! 模型与匹配语义对齐 Netcatty `infrastructure/ai/harness/permissionGrants.ts`：
//! - `PermissionGrant { id, capabilityId, sessionPattern, commandPattern?, argsPattern?, createdAt, note? }`；
//! - 命令模式规则优先：把命令按 shell 分段，**每段都要命中**才算免审批；
//! - 非命令规则按工具（capabilityId）+ 会话范围（sessionPattern）匹配；
//! - 审批里的「一律许可」落全局 `sessionPattern: "*"`，命令类工具按
//!   OpenCode 式 arity 前缀生成 `"<prefix> *"` 规则（`bashArity.ts` 表原样移植）。
//!
//! 旧的按工具粒度 `mcp.allowed_tools` 会在首次读取时迁移成 capability 规则并删除，
//! 之后只保留这一套逻辑。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{settings, Db};
use crate::error::AppResult;

pub const KEY_GRANTS: &str = "mcp.permission_grants";

/// 允许「命令模式」规则的工具（对齐 Netcatty `COMMAND_GRANT_CAPABILITIES`）。
const COMMAND_GRANT_CAPABILITIES: &[&str] = &["terminal_execute"];

/// 生成规则时忽略的目录切换命令（对齐 Netcatty `CWD_COMMANDS`）。
const CWD_COMMANDS: &[&str] = &[
    "cd", "chdir", "popd", "pushd", "push-location", "set-location",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionGrant {
    #[serde(default)]
    pub id: String,
    pub capability_id: String,
    #[serde(default = "default_session_pattern")]
    pub session_pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args_pattern: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

fn default_session_pattern() -> String {
    "*".to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn create_id() -> String {
    let seq = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    format!("grant_{}_{}", now_ms(), seq)
}

/// 读取规则；首次读取时把旧的 `mcp.allowed_tools` 迁移成 capability 规则。
pub fn load(db: &Db) -> Vec<PermissionGrant> {
    if let Some(raw) = settings::get(db, KEY_GRANTS).ok().flatten() {
        if let Ok(list) = serde_json::from_str::<Vec<PermissionGrant>>(&raw) {
            return sanitize_stored(list);
        }
    }
    migrate_legacy(db)
}

fn migrate_legacy(db: &Db) -> Vec<PermissionGrant> {
    let legacy = crate::mcp::config::load_allowed_tools(db);
    if legacy.is_empty() {
        return Vec::new();
    }
    let migrated: Vec<PermissionGrant> = legacy
        .into_iter()
        .map(|tool| PermissionGrant {
            id: create_id(),
            capability_id: tool,
            session_pattern: "*".to_string(),
            command_pattern: None,
            args_pattern: None,
            created_at: now_ms(),
            note: Some("从旧的「始终允许」设置迁移".to_string()),
        })
        .collect();
    let _ = save(db, &migrated);
    let _ = settings::delete(db, crate::mcp::config::KEY_ALLOWED_TOOLS);
    migrated
}

fn sanitize_stored(list: Vec<PermissionGrant>) -> Vec<PermissionGrant> {
    list.into_iter()
        .filter_map(|mut g| {
            g.capability_id = g.capability_id.trim().to_string();
            if g.capability_id.is_empty() {
                return None;
            }
            if g.session_pattern.trim().is_empty() {
                g.session_pattern = "*".to_string();
            }
            if g.id.trim().is_empty() {
                g.id = create_id();
            }
            if g.created_at == 0 {
                g.created_at = now_ms();
            }
            Some(g)
        })
        .collect()
}

pub fn save(db: &Db, grants: &[PermissionGrant]) -> AppResult<()> {
    let raw = serde_json::to_string(grants).unwrap_or_else(|_| "[]".to_string());
    settings::set(db, KEY_GRANTS, &raw)
}

/// 导出 JSON（规则数组，不含 token / 凭据等敏感信息）。
pub fn export_json(db: &Db) -> AppResult<String> {
    let grants = load(db);
    Ok(serde_json::to_string_pretty(&grants).unwrap_or_else(|_| "[]".to_string()))
}

/// 导入 JSON：替换现有规则（对齐 Netcatty `PermissionGrantsSettings` 的 replace 语义）。
/// 非法 JSON / 字段不合法返回带序号的中文错误，交由前端直接展示。
pub fn import_json(db: &Db, raw: &str) -> Result<Vec<PermissionGrant>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("导入内容为空".to_string());
    }
    let parsed: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let array = parsed
        .as_array()
        .ok_or_else(|| "导入内容必须是规则数组（JSON array）".to_string())?;
    let mut out: Vec<PermissionGrant> = Vec::with_capacity(array.len());
    for (index, entry) in array.iter().enumerate() {
        let number = index + 1;
        let obj = entry
            .as_object()
            .ok_or_else(|| format!("第 {number} 条不是对象"))?;
        let capability_id = obj
            .get("capabilityId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("第 {number} 条缺少 capabilityId（工具名）"))?
            .to_string();
        let session_pattern = match obj.get("sessionPattern") {
            None | Some(Value::Null) => "*".to_string(),
            Some(Value::String(v)) if !v.trim().is_empty() => v.trim().to_string(),
            Some(_) => return Err(format!("第 {number} 条 sessionPattern 必须是非空字符串")),
        };
        let id = match obj.get("id") {
            None | Some(Value::Null) => create_id(),
            Some(Value::String(v)) if !v.trim().is_empty() => v.trim().to_string(),
            Some(_) => return Err(format!("第 {number} 条 id 必须是非空字符串")),
        };
        let command_pattern = match obj.get("commandPattern") {
            None | Some(Value::Null) => None,
            Some(Value::String(v)) if !v.trim().is_empty() => Some(v.trim().to_string()),
            Some(_) => return Err(format!("第 {number} 条 commandPattern 必须是非空字符串")),
        };
        let args_pattern = match obj.get("argsPattern") {
            None | Some(Value::Null) => None,
            Some(Value::Object(map)) => {
                let mut out_map = BTreeMap::new();
                for (key, value) in map {
                    let text = value.as_str().ok_or_else(|| {
                        format!("第 {number} 条 argsPattern 的 {key} 必须是字符串")
                    })?;
                    out_map.insert(key.clone(), text.to_string());
                }
                if out_map.is_empty() {
                    None
                } else {
                    Some(out_map)
                }
            }
            Some(_) => return Err(format!("第 {number} 条 argsPattern 必须是对象")),
        };
        let created_at = match obj.get("createdAt") {
            None | Some(Value::Null) => now_ms(),
            Some(Value::Number(n)) => n.as_u64().unwrap_or_else(now_ms),
            Some(_) => return Err(format!("第 {number} 条 createdAt 必须是数字")),
        };
        let note = match obj.get("note") {
            None | Some(Value::Null) => None,
            Some(Value::String(v)) if !v.trim().is_empty() => Some(v.trim().to_string()),
            Some(_) => return Err(format!("第 {number} 条 note 必须是字符串")),
        };
        if out.iter().any(|existing| existing.id == id) {
            return Err(format!("第 {number} 条 id 与已有规则重复：{id}"));
        }
        out.push(PermissionGrant {
            id,
            capability_id,
            session_pattern,
            command_pattern,
            args_pattern,
            created_at,
            note,
        });
    }
    save(db, &out).map_err(|e| e.to_string())?;
    Ok(out)
}

// ── 匹配 ──────────────────────────────────────────────────────────────────

fn rule_matches_target(rule: &PermissionGrant) -> bool {
    // termX 的 MCP 审批没有主机维度；主机作用域规则在这里不生效。
    if rule.session_pattern.starts_with("host:") {
        return false;
    }
    rule.capability_id != "*" && rule.session_pattern != "host:"
}

fn rule_matches_capability(rule: &PermissionGrant, capability_id: &str) -> bool {
    (rule.capability_id == capability_id || rule.capability_id == "*")
        && rule_matches_target(rule)
}

fn glob_or_regex_match(pattern: &str, value: &str) -> bool {
    if pattern.starts_with('/') {
        if let Some(last_slash) = pattern.rfind('/') {
            if last_slash > 0 {
                let body = &pattern[1..last_slash];
                let flags = &pattern[last_slash + 1..];
                let mut inline = String::new();
                if flags.contains('i') {
                    inline.push('i');
                }
                if flags.contains('m') {
                    inline.push('m');
                }
                if flags.contains('s') {
                    inline.push('s');
                }
                let source = if inline.is_empty() {
                    body.to_string()
                } else {
                    format!("(?{inline}){body}")
                };
                return fancy_regex::Regex::new(&source)
                    .map(|re| re.is_match(value).unwrap_or(false))
                    .unwrap_or(false);
            }
        }
    }

    if !pattern.contains('*') && !pattern.contains('?') {
        return value == pattern;
    }

    let mut escaped = String::with_capacity(pattern.len() * 2);
    for ch in pattern.chars() {
        match ch {
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            '*' => escaped.push_str(".*"),
            '?' => escaped.push('.'),
            _ => escaped.push(ch),
        }
    }
    // OpenCode Wildcard.match：末尾 " *" 允许省略参数。
    if escaped.ends_with(" .*") {
        escaped.truncate(escaped.len() - 3);
        escaped.push_str("( .*)?");
    }
    regex::RegexBuilder::new(&format!("^{escaped}$"))
        .dot_matches_new_line(true)
        .build()
        .map(|re| re.is_match(value))
        .unwrap_or(false)
}

pub fn pattern_matches(pattern: &str, value: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    if let Some(rest) = pattern.strip_prefix("host:") {
        return glob_or_regex_match(rest, value);
    }
    glob_or_regex_match(pattern, value)
}

fn args_pattern_matches(
    args_pattern: Option<&BTreeMap<String, String>>,
    args: &Value,
) -> bool {
    let Some(patterns) = args_pattern else {
        return true;
    };
    let Some(obj) = args.as_object() else {
        return false;
    };
    for (key, pattern) in patterns {
        let Some(value) = obj.get(key) else {
            return false;
        };
        let text = match value {
            Value::String(v) => v.clone(),
            Value::Null => "null".to_string(),
            other => other.to_string(),
        };
        if !pattern_matches(pattern, &text) {
            return false;
        }
    }
    true
}

/// 首个命中的规则；命令模式规则优先，其次是非命令规则（对齐 `matchPermissionGrant`）。
pub fn match_grant(
    grants: &[PermissionGrant],
    capability_id: &str,
    args: &Value,
) -> Option<PermissionGrant> {
    if grants.is_empty() {
        return None;
    }
    let command = args.get("command").and_then(Value::as_str).unwrap_or("");
    if !command.is_empty() {
        if let Some(grant) = match_command_pattern_grants(grants, capability_id, command, args) {
            return Some(grant);
        }
    }
    for rule in grants {
        if !rule_matches_capability(rule, capability_id) {
            continue;
        }
        if rule.command_pattern.is_some() {
            continue;
        }
        if !args_pattern_matches(rule.args_pattern.as_ref(), args) {
            continue;
        }
        return Some(rule.clone());
    }
    None
}

fn match_command_pattern_grants(
    grants: &[PermissionGrant],
    capability_id: &str,
    command: &str,
    args: &Value,
) -> Option<PermissionGrant> {
    let segments = extract_grantable_segments(command);
    if segments.is_empty() {
        return None;
    }
    let eligible: Vec<&PermissionGrant> = grants
        .iter()
        .filter(|rule| {
            rule_matches_capability(rule, capability_id)
                && rule.command_pattern.is_some()
                && args_pattern_matches(rule.args_pattern.as_ref(), args)
        })
        .collect();
    if eligible.is_empty() {
        return None;
    }
    let mut first: Option<PermissionGrant> = None;
    for segment in &segments {
        let matched = eligible
            .iter()
            .find(|rule| pattern_matches(rule.command_pattern.as_deref().unwrap_or(""), segment));
        let Some(rule) = matched else {
            return None;
        };
        if first.is_none() {
            first = Some((*rule).clone());
        }
    }
    first
}

// ── 审批 → 规则 ────────────────────────────────────────────────────────────

/// 「一律许可」生成规则：命令类工具按 shell 分段 + arity 前缀生成多条命令模式规则；
/// 其余工具生成一条 capability 规则。全部落全局 `*`（对齐 Netcatty）。
pub fn build_grants_from_approval(capability_id: &str, args: &Value, note: Option<String>) -> Vec<PermissionGrant> {
    let command = args.get("command").and_then(Value::as_str).unwrap_or("");
    let patterns = if COMMAND_GRANT_CAPABILITIES.contains(&capability_id) {
        build_always_allow_command_patterns(command)
    } else {
        Vec::new()
    };
    let created_at = now_ms();

    if patterns.is_empty() {
        return vec![PermissionGrant {
            id: create_id(),
            capability_id: capability_id.to_string(),
            session_pattern: "*".to_string(),
            command_pattern: None,
            args_pattern: None,
            created_at,
            note,
        }];
    }

    patterns
        .into_iter()
        .map(|command_pattern| PermissionGrant {
            id: create_id(),
            capability_id: capability_id.to_string(),
            session_pattern: "*".to_string(),
            command_pattern: Some(command_pattern),
            args_pattern: None,
            created_at,
            note: note.clone(),
        })
        .collect()
}

/// 追加规则并去重（同一工具 + 会话范围 + 命令模式 + 参数模式只保留一条）。
pub fn merge_grants(existing: &mut Vec<PermissionGrant>, incoming: Vec<PermissionGrant>) {
    for rule in incoming {
        let duplicate = existing.iter().any(|item| {
            item.capability_id == rule.capability_id
                && item.session_pattern == rule.session_pattern
                && item.command_pattern == rule.command_pattern
                && item.args_pattern == rule.args_pattern
        });
        if !duplicate {
            existing.push(rule);
        }
    }
}

// ── shell 分段 / token / arity（移植 Netcatty shellCommandGrant.ts + bashArity.ts）──

fn flush_segment(segments: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        segments.push(trimmed);
    }
    current.clear();
}

/// 按 shell 运算符分段（引号内的 `;` `|` `&&` 不切分）。
pub fn split_shell_command_segments(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();

        if let Some(q) = quote {
            current.push(ch);
            if ch == '\\' && q != '\'' {
                if let Some(n) = next {
                    current.push(n);
                    index += 2;
                    continue;
                }
            }
            if ch == q {
                quote = None;
            }
            index += 1;
            continue;
        }

        if ch == '\\' && next == Some('\n') {
            index += 2;
            continue;
        }
        if ch == '\\' {
            if let Some(n) = next {
                current.push(ch);
                current.push(n);
                index += 2;
                continue;
            }
        }
        if ch == '"' || ch == '\'' || ch == '`' {
            quote = Some(ch);
            current.push(ch);
            index += 1;
            continue;
        }
        if ch == '#' {
            let previous = current.chars().last();
            if previous.map(|p| p.is_whitespace()).unwrap_or(true) {
                // 注释：跳过到行尾；若行尾存在则在该处切分。
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
                flush_segment(&mut segments, &mut current);
                index += 1;
                continue;
            }
        }

        match ch {
            '\n' | ';' => {
                flush_segment(&mut segments, &mut current);
                index += 1;
            }
            '&' if next == Some('&') => {
                flush_segment(&mut segments, &mut current);
                index += 2;
            }
            '|' if next == Some('|') => {
                flush_segment(&mut segments, &mut current);
                index += 2;
            }
            '|' => {
                flush_segment(&mut segments, &mut current);
                index += 1;
            }
            '&' => {
                let previous = current.chars().rev().find(|c| !c.is_whitespace());
                if next == Some('>') || previous == Some('>') || previous == Some('<') {
                    current.push(ch);
                } else {
                    flush_segment(&mut segments, &mut current);
                }
                index += 1;
            }
            _ => {
                current.push(ch);
                index += 1;
            }
        }
    }

    flush_segment(&mut segments, &mut current);
    segments
}

fn has_executable_shell_expansion(segment: &str) -> bool {
    let chars: Vec<char> = segment.chars().collect();
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if let Some(q) = quote {
            if ch == '\\' && q == '"' && next.is_some() {
                index += 2;
                continue;
            }
            if ch == q {
                quote = None;
                index += 1;
                continue;
            }
            if q == '"' && ch == '$' && next == Some('(') {
                return true;
            }
            if q == '"' && ch == '`' {
                return true;
            }
            index += 1;
            continue;
        }
        if ch == '\\' && next.is_some() {
            index += 2;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            index += 1;
            continue;
        }
        if ch == '`' {
            return true;
        }
        if ch == '$' && next == Some('(') {
            return true;
        }
        if (ch == '<' || ch == '>') && next == Some('(') {
            return true;
        }
        index += 1;
    }
    false
}

pub fn tokenize_shell_command(command: &str) -> Vec<String> {
    let matcher = Regex::new(r#"(?:[^\s"']+|"[^"]*"|'[^']*')+"#).expect("token regex");
    matcher
        .find_iter(command)
        .map(|m| m.as_str())
        .map(unquote_shell_token)
        .collect()
}

fn unquote_shell_token(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() >= 2 {
        let first = chars[0];
        let last = chars[chars.len() - 1];
        if (first == '"' || first == '\'') && first == last {
            return chars[1..chars.len() - 1].iter().collect();
        }
    }
    token.to_string()
}

pub fn extract_grantable_segments(command: &str) -> Vec<String> {
    split_shell_command_segments(command)
        .into_iter()
        .filter(|segment| {
            let tokens = tokenize_shell_command(segment);
            let cmd = tokens.first().map(|t| t.to_lowercase());
            match cmd {
                Some(cmd) => {
                    !(CWD_COMMANDS.contains(&cmd.as_str())
                        && !has_executable_shell_expansion(segment))
                        && !tokens.is_empty()
                }
                None => false,
            }
        })
        .collect()
}

/// OpenCode 式 arity 前缀表（原样移植 Netcatty `bashArity.ts`，共 130 项）。
const ARITY: &[(&str, usize)] = &[
    ("cat", 1), ("cd", 1), ("chmod", 1), ("chown", 1), ("cp", 1), ("echo", 1),
    ("env", 1), ("export", 1), ("grep", 1), ("kill", 1), ("killall", 1), ("ln", 1),
    ("ls", 1), ("mkdir", 1), ("mv", 1), ("ps", 1), ("pwd", 1), ("rm", 1), ("rmdir", 1),
    ("sleep", 1), ("source", 1), ("tail", 1), ("touch", 1), ("unset", 1), ("which", 1),
    ("aws", 3), ("az", 3), ("bazel", 2), ("brew", 2), ("bun", 2),
    ("bun run", 3), ("bun x", 3), ("cargo", 2), ("cargo add", 3), ("cargo run", 3),
    ("cdk", 2), ("cf", 2), ("cmake", 2), ("composer", 2), ("consul", 2),
    ("consul kv", 3), ("crictl", 2), ("deno", 2), ("deno task", 3), ("doctl", 3),
    ("docker", 2), ("docker builder", 3), ("docker compose", 3), ("docker container", 3),
    ("docker image", 3), ("docker network", 3), ("docker volume", 3), ("eksctl", 2),
    ("eksctl create", 3), ("firebase", 2), ("flyctl", 2), ("gcloud", 3), ("gh", 3),
    ("git", 2), ("git config", 3), ("git remote", 3), ("git stash", 3), ("go", 2),
    ("gradle", 2), ("helm", 2), ("heroku", 2), ("hugo", 2), ("ip", 2), ("ip addr", 3),
    ("ip link", 3), ("ip netns", 3), ("ip route", 3), ("kind", 2), ("kind create", 3),
    ("kubectl", 2), ("kubectl kustomize", 3), ("kubectl rollout", 3), ("kustomize", 2),
    ("make", 2), ("mc", 2), ("mc admin", 3), ("minikube", 2), ("mongosh", 2),
    ("mysql", 2), ("mvn", 2), ("ng", 2), ("npm", 2), ("npm exec", 3), ("npm init", 3),
    ("npm run", 3), ("npm view", 3), ("nvm", 2), ("nx", 2), ("openssl", 2),
    ("openssl req", 3), ("openssl x509", 3), ("pip", 2), ("pipenv", 2), ("pnpm", 2),
    ("pnpm dlx", 3), ("pnpm exec", 3), ("pnpm run", 3), ("poetry", 2), ("podman", 2),
    ("podman container", 3), ("podman image", 3), ("psql", 2), ("pulumi", 2),
    ("pulumi stack", 3), ("pyenv", 2), ("python", 2), ("rake", 2), ("rbenv", 2),
    ("redis-cli", 2), ("rustup", 2), ("serverless", 2), ("sfdx", 3), ("skaffold", 2),
    ("sls", 2), ("sst", 2), ("swift", 2), ("systemctl", 2), ("terraform", 2),
    ("terraform workspace", 3), ("tmux", 2), ("turbo", 2), ("ufw", 2), ("vault", 2),
    ("vault auth", 3), ("vault kv", 3), ("vercel", 2), ("volta", 2), ("wp", 2),
    ("yarn", 2), ("yarn dlx", 3), ("yarn run", 3),
];

pub fn bash_arity_prefix(tokens: &[String]) -> Vec<String> {
    for len in (1..=tokens.len()).rev() {
        let prefix = tokens[..len].join(" ");
        if let Some((_, arity)) = ARITY.iter().find(|(key, _)| *key == prefix) {
            return tokens[..*arity].to_vec();
        }
    }
    tokens.first().map(|t| vec![t.clone()]).unwrap_or_default()
}

pub fn build_always_allow_command_patterns(command: &str) -> Vec<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut patterns: Vec<String> = Vec::new();
    for segment in extract_grantable_segments(trimmed) {
        let tokens = tokenize_shell_command(&segment);
        let prefix = bash_arity_prefix(&tokens);
        if prefix.is_empty() {
            continue;
        }
        let pattern = format!("{} *", prefix.join(" "));
        if !patterns.contains(&pattern) {
            patterns.push(pattern);
        }
    }
    patterns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn grant(capability: &str, pattern: Option<&str>) -> PermissionGrant {
        PermissionGrant {
            id: create_id(),
            capability_id: capability.to_string(),
            session_pattern: "*".to_string(),
            command_pattern: pattern.map(str::to_string),
            args_pattern: None,
            created_at: now_ms(),
            note: None,
        }
    }

    #[test]
    fn command_rules_require_every_segment_to_match() {
        let rules = vec![grant("terminal_execute", Some("git status *"))];
        let args = json!({ "command": "git status" });
        assert!(match_grant(&rules, "terminal_execute", &args).is_some());

        let chained = json!({ "command": "git status && rm -rf build" });
        assert!(
            match_grant(&rules, "terminal_execute", &chained).is_none(),
            "任一分段不命中就不能免审批"
        );
    }

    #[test]
    fn tool_rules_allow_same_tool_only() {
        let rules = vec![grant("session_close", None)];
        assert!(match_grant(&rules, "session_close", &json!({})).is_some());
        assert!(match_grant(&rules, "terminal_execute", &json!({})).is_none());
    }

    #[test]
    fn approval_builds_arity_patterns_for_commands() {
        let grants = build_grants_from_approval(
            "terminal_execute",
            &json!({ "command": "git status --short" }),
            None,
        );
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].command_pattern.as_deref(), Some("git status *"));
        assert_eq!(grants[0].session_pattern, "*");
    }

    #[test]
    fn approval_for_other_tools_builds_single_capability_rule() {
        let grants =
            build_grants_from_approval("session_close", &json!({ "sessionId": "s1" }), None);
        assert_eq!(grants.len(), 1);
        assert!(grants[0].command_pattern.is_none());
        assert_eq!(grants[0].capability_id, "session_close");
    }

    #[test]
    fn always_allow_patterns_split_chains_and_skip_cd() {
        let patterns = build_always_allow_command_patterns("cd /tmp && npm run dev");
        assert_eq!(patterns, vec!["npm run dev *".to_string()]);
    }

    #[test]
    fn glob_pattern_respects_optional_arguments() {
        assert!(pattern_matches("git status *", "git status"));
        assert!(pattern_matches("git status *", "git status --short"));
        assert!(!pattern_matches("git status *", "git push"));
    }

    #[test]
    fn merge_grants_deduplicates_same_rule() {
        let mut existing = vec![grant("terminal_execute", Some("ls *"))];
        merge_grants(
            &mut existing,
            vec![grant("terminal_execute", Some("ls *"))],
        );
        assert_eq!(existing.len(), 1);
    }
}
