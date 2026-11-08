//! confirm 档位的写操作审批表。
//!
//! 模型对齐 Netcatty `electron/bridges/mcpServerBridge.cjs` 的 approval gate：
//! - 写操作生成待审批项（工具名 / 参数摘要 / 目标会话），广播给渲染层；
//! - 110 秒硬超时（外部客户端常见的 120 秒工具调用上限之前）；
//! - 客户端断开、MCP 停止 / 重启时，挂起项一律按拒绝结算；
//! - 「一律许可」沉淀成 `PermissionGrant`（见 `mcp::grants`），下次同类操作直接放行。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use super::grants::PermissionGrant;

pub const EVENT_REQUEST: &str = "mcp:approval-request";
pub const EVENT_CLEARED: &str = "mcp:approval-cleared";
pub const APPROVAL_TIMEOUT_MS: u64 = 110_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    Once,
    Always,
    Reject,
}

impl ApprovalDecision {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "once" => Some(Self::Once),
            "always" => Some(Self::Always),
            "reject" => Some(Self::Reject),
            _ => None,
        }
    }

    pub fn allows(self) -> bool {
        !matches!(self, Self::Reject)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestPayload {
    pub approval_id: String,
    pub tool_name: String,
    pub args_summary: String,
    pub session_id: Option<String>,
    pub target_label: Option<String>,
    pub timeout_ms: u64,
    /// 请求创建时的 epoch 毫秒，渲染层据此显示倒计时。
    pub created_at_ms: u64,
}

struct Pending {
    payload: ApprovalRequestPayload,
    args: Value,
    tx: Option<oneshot::Sender<bool>>,
}

/// 被 UI / 调用方取走的待审批项。`tx` 送出 `true`（允许）或 `false`（拒绝）。
pub struct TakenApproval {
    pub tool: String,
    pub args: Value,
    /// 审批浮层上的参数摘要，顺手作为放行规则的备注。
    pub note: Option<String>,
    pub tx: oneshot::Sender<bool>,
}

pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, Pending>>,
    /// 放行规则缓存（与 `mcp.permission_grants` 持久化同步）。
    grants: Mutex<Vec<PermissionGrant>>,
    next_id: AtomicU64,
}

impl Default for ApprovalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalRegistry {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            grants: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn set_grants(&self, grants: Vec<PermissionGrant>) {
        let mut guard = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        *guard = grants;
    }

    pub fn grants(&self) -> Vec<PermissionGrant> {
        self.grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 命中任一放行规则即免审批（命令模式规则优先，语义见 `mcp::grants::match_grant`）。
    pub fn match_grant(&self, tool: &str, args: &Value) -> Option<PermissionGrant> {
        let guard = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        super::grants::match_grant(&guard, tool, args)
    }

    pub fn remove_grant(&self, grant_id: &str) {
        let mut guard = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|grant| grant.id != grant_id);
    }

    pub fn register(
        &self,
        tool: &str,
        args_summary: String,
        session_id: Option<String>,
        target_label: Option<String>,
        args: Value,
    ) -> (ApprovalRequestPayload, oneshot::Receiver<bool>) {
        let seq = self.next_id.fetch_add(1, Ordering::SeqCst);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let approval_id = format!("mcp_approval_{seq}_{stamp}");
        let payload = ApprovalRequestPayload {
            approval_id: approval_id.clone(),
            tool_name: tool.to_string(),
            args_summary,
            session_id: session_id.clone(),
            target_label,
            timeout_ms: APPROVAL_TIMEOUT_MS,
            created_at_ms: stamp as u64,
        };
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                approval_id,
                Pending {
                    payload: payload.clone(),
                    args,
                    tx: Some(tx),
                },
            );
        (payload, rx)
    }

    /// 原子取走待审批项；已结算 / 已超时则返回 `None`。
    pub fn take(&self, approval_id: &str) -> Option<TakenApproval> {
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let entry = guard.remove(approval_id)?;
        Some(TakenApproval {
            tool: entry.payload.tool_name,
            args: entry.args,
            note: Some(entry.payload.args_summary),
            tx: entry.tx?,
        })
    }

    /// 移除并拒绝单项；返回是否确实移除了。
    pub fn deny(&self, approval_id: &str) -> bool {
        let removed = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(approval_id);
        if let Some(entry) = removed {
            if let Some(tx) = entry.tx {
                let _ = tx.send(false);
            }
            true
        } else {
            false
        }
    }

    /// 拒绝全部挂起项（服务停止 / 重启 / 客户端断开时调用）。
    pub fn deny_all(&self) -> Vec<ApprovalRequestPayload> {
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let entries: Vec<(String, Pending)> = guard.drain().collect();
        let mut payloads = Vec::with_capacity(entries.len());
        for (_, entry) in entries {
            if let Some(tx) = entry.tx {
                let _ = tx.send(false);
            }
            payloads.push(entry.payload);
        }
        payloads
    }

    pub fn pending_list(&self) -> Vec<ApprovalRequestPayload> {
        let guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let mut list: Vec<ApprovalRequestPayload> =
            guard.values().map(|p| p.payload.clone()).collect();
        list.sort_by(|a, b| a.approval_id.cmp(&b.approval_id));
        list
    }

    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }
}

pub fn emit_request(app: &AppHandle, payload: &ApprovalRequestPayload) {
    let _ = app.emit(EVENT_REQUEST, payload);
}

pub fn emit_cleared(app: &AppHandle, approval_ids: &[String], reason: &str) {
    if approval_ids.is_empty() {
        return;
    }
    let _ = app.emit(
        EVENT_CLEARED,
        json!({ "approvalIds": approval_ids, "reason": reason }),
    );
}

/// 有待审批项且窗口不在前台时闪任务栏；清空后取消提醒。
pub fn sync_attention(app: &AppHandle, pending: usize) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if pending == 0 {
        let _ = window.request_user_attention(None);
    } else if matches!(window.is_focused(), Ok(false)) {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_parsing_is_case_insensitive() {
        assert_eq!(ApprovalDecision::parse("once"), Some(ApprovalDecision::Once));
        assert_eq!(
            ApprovalDecision::parse(" Always "),
            Some(ApprovalDecision::Always)
        );
        assert_eq!(
            ApprovalDecision::parse("REJECT"),
            Some(ApprovalDecision::Reject)
        );
        assert_eq!(ApprovalDecision::parse("yes"), None);
    }

    #[test]
    fn register_take_and_deny_settle_pending() {
        let registry = ApprovalRegistry::new();
        let (payload, mut rx) = registry.register(
            "terminal_execute",
            "ls".into(),
            None,
            None,
            json!({ "command": "ls" }),
        );
        assert_eq!(registry.pending_count(), 1);
        assert!(payload.approval_id.starts_with("mcp_approval_"));

        let taken = registry.take(&payload.approval_id).expect("pending");
        assert_eq!(taken.tool, "terminal_execute");
        assert_eq!(taken.args["command"], "ls");
        assert!(rx.try_recv().is_err(), "尚未结算时 receiver 不应有值");
        let _ = taken.tx.send(true);
        assert_eq!(rx.try_recv(), Ok(true));
        assert_eq!(registry.pending_count(), 0);
        assert!(registry.take(&payload.approval_id).is_none());
    }

    #[test]
    fn deny_all_rejects_every_pending_item() {
        let registry = ApprovalRegistry::new();
        let (a, mut rx_a) = registry.register(
            "terminal_execute",
            "a".into(),
            None,
            None,
            json!({ "command": "a" }),
        );
        let (b, mut rx_b) =
            registry.register("session_close", "b".into(), None, None, json!({}));
        let cleared = registry.deny_all();
        assert_eq!(cleared.len(), 2);
        assert!(cleared.iter().any(|p| p.approval_id == a.approval_id));
        assert!(cleared.iter().any(|p| p.approval_id == b.approval_id));
        assert_eq!(rx_a.try_recv(), Ok(false));
        assert_eq!(rx_b.try_recv(), Ok(false));
        assert_eq!(registry.pending_count(), 0);
    }

    #[test]
    fn grants_allow_matching_operations_only() {
        let registry = ApprovalRegistry::new();
        registry.set_grants(vec![PermissionGrant {
            id: "grant_1".into(),
            capability_id: "terminal_execute".into(),
            session_pattern: "*".into(),
            command_pattern: Some("git status *".into()),
            args_pattern: None,
            created_at: 1,
            note: None,
        }]);
        assert!(registry
            .match_grant("terminal_execute", &json!({ "command": "git status" }))
            .is_some());
        assert!(registry
            .match_grant("terminal_execute", &json!({ "command": "rm -rf build" }))
            .is_none());
        assert!(registry
            .match_grant("session_close", &json!({}))
            .is_none());
        registry.remove_grant("grant_1");
        assert!(registry
            .match_grant("terminal_execute", &json!({ "command": "git status" }))
            .is_none());
    }
}
