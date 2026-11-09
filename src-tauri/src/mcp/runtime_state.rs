//! MCP 进程级运行时状态。
//!
//! 这些状态天然是进程单例（MCP server 每个 app 只有一个），放在 `OnceLock`
//! 而不是 `AppState`：既避免给所有测试用的 `AppState` 字面量加字段，也保证
//! 自动建连 owner、单飞表、能力探测缓存在整个进程内稳定。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::audit::AuditLog;
use super::fs::caps::RemoteCaps;

pub struct McpRuntimeState {
    /// MCP 自动建连的会话 owner —— 与用户窗口会话区分，便于识别与清理。
    pub owner: uuid::Uuid,
    /// `hostId` → 建连闸门：并发请求共享同一次建连。
    pub connect_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// `profile_id` → 远端能力探测结果。
    pub caps: Mutex<HashMap<String, RemoteCaps>>,
    pub audit: AuditLog,
}

impl McpRuntimeState {
    fn new() -> Self {
        Self {
            owner: uuid::Uuid::new_v4(),
            connect_gates: Mutex::new(HashMap::new()),
            caps: Mutex::new(HashMap::new()),
            audit: AuditLog::default(),
        }
    }
}

fn state() -> &'static McpRuntimeState {
    static STATE: OnceLock<McpRuntimeState> = OnceLock::new();
    STATE.get_or_init(McpRuntimeState::new)
}

pub fn mcp_owner() -> uuid::Uuid {
    state().owner
}

/// 取（或创建）某主机的建连闸门。`std::sync::MutexGuard` 在函数返回前释放，
/// 因此可以在 `await` 前安全调用。
pub fn connect_gate(host_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut gates = state()
        .connect_gates
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    gates
        .entry(host_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

pub fn cached_caps(profile_id: &str) -> Option<RemoteCaps> {
    state()
        .caps
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(profile_id)
        .copied()
}

pub fn store_caps(profile_id: &str, caps: RemoteCaps) {
    state()
        .caps
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(profile_id.to_string(), caps);
}

pub fn record_audit(entry: serde_json::Value) {
    state().audit.record(entry);
}

pub fn audit_snapshot(limit: usize) -> Vec<serde_json::Value> {
    state().audit.snapshot(limit)
}
