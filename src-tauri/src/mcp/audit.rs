//! MCP 变更审计：进程内环形缓冲。
//!
//! 首期不建表（见 `docs/mcp-refactor.md` §11）：所有写/删/传/构建操作记录
//! `{ts, tool, sessionId, path, size, sha256, decision}`，最多保留最近
//! [`AUDIT_CAPACITY`] 条，供排查与后续 `mcp.audit_list` 工具读取。

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

pub const AUDIT_CAPACITY: usize = 500;

#[derive(Default)]
pub struct AuditLog {
    entries: Mutex<VecDeque<Value>>,
}

impl AuditLog {
    pub fn record(&self, entry: Value) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if entries.len() >= AUDIT_CAPACITY {
            entries.pop_front();
        }
        entries.push_back(entry);
    }

    /// 最近 `limit` 条，新的在前。
    pub fn snapshot(&self, limit: usize) -> Vec<Value> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.iter().rev().take(limit).cloned().collect()
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 构造一条变更审计记录。`decision` 取 `allowed` / `denied` / `dry_run` / `applied`。
pub fn change_entry(
    tool: &str,
    session_id: Option<&str>,
    path: Option<&str>,
    size: Option<u64>,
    sha256: Option<&str>,
    decision: &str,
) -> Value {
    json!({
        "ts": now_millis(),
        "tool": tool,
        "sessionId": session_id,
        "path": path,
        "size": size,
        "sha256": sha256,
        "decision": decision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_latest_entries() {
        let log = AuditLog::default();
        for i in 0..(AUDIT_CAPACITY + 5) {
            log.record(json!({ "i": i }));
        }
        let snap = log.snapshot(3);
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0]["i"], AUDIT_CAPACITY + 4);
        assert_eq!(snap[2]["i"], AUDIT_CAPACITY + 2);
        assert_eq!(log.snapshot(usize::MAX).len(), AUDIT_CAPACITY);
    }

    #[test]
    fn change_entry_has_stable_fields() {
        let entry = change_entry(
            "fs_write",
            Some("s1"),
            Some("/a/b"),
            Some(3),
            Some("abc"),
            "applied",
        );
        assert_eq!(entry["tool"], "fs_write");
        assert_eq!(entry["sessionId"], "s1");
        assert_eq!(entry["size"], 3);
        assert_eq!(entry["decision"], "applied");
        assert!(entry["ts"].as_u64().unwrap() > 0);
    }
}
