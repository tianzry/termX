//! confirm 档位的写操作审批表。
//!
//! 模型对齐 Netcatty `electron/bridges/mcpServerBridge.cjs` 的 approval gate：
//! - 写操作生成待审批项（工具名 / 参数摘要 / 目标会话），广播给渲染层；
//! - 110 秒硬超时（外部客户端常见的 120 秒工具调用上限之前）；
//! - 客户端断开、MCP 停止 / 重启时，挂起项一律按拒绝结算；
//! - `始终允许` 按工具粒度落到设置 KV（`mcp.allowed_tools`）。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

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
    tx: Option<oneshot::Sender<bool>>,
}

/// 被 UI / 调用方取走的待审批项。`tx` 送出 `true`（允许）或 `false`（拒绝）。
pub struct TakenApproval {
    pub tool: String,
    pub tx: oneshot::Sender<bool>,
}

pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, Pending>>,
    allowed_tools: Mutex<HashSet<String>>,
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
            allowed_tools: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn set_allowed_tools(&self, tools: Vec<String>) {
        let mut guard = self.allowed_tools.lock().unwrap_or_else(|e| e.into_inner());
        guard.clear();
        guard.extend(tools);
    }

    pub fn allowed_tools(&self) -> Vec<String> {
        let guard = self.allowed_tools.lock().unwrap_or_else(|e| e.into_inner());
        let mut list: Vec<String> = guard.iter().cloned().collect();
        list.sort();
        list
    }

    pub fn is_tool_allowed(&self, tool: &str) -> bool {
        self.allowed_tools
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(tool)
    }

    pub fn allow_tool(&self, tool: &str) {
        self.allowed_tools
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(tool.to_string());
    }

    pub fn register(
        &self,
        tool: &str,
        args_summary: String,
        session_id: Option<String>,
        target_label: Option<String>,
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
            session_id,
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
        let (payload, mut rx) =
            registry.register("terminal_execute", "ls".into(), None, None);
        assert_eq!(registry.pending_count(), 1);
        assert!(payload.approval_id.starts_with("mcp_approval_"));

        let taken = registry.take(&payload.approval_id).expect("pending");
        assert_eq!(taken.tool, "terminal_execute");
        assert!(rx.try_recv().is_err(), "尚未结算时 receiver 不应有值");
        let _ = taken.tx.send(true);
        assert_eq!(rx.try_recv(), Ok(true));
        assert_eq!(registry.pending_count(), 0);
        assert!(registry.take(&payload.approval_id).is_none());
    }

    #[test]
    fn deny_all_rejects_every_pending_item() {
        let registry = ApprovalRegistry::new();
        let (a, mut rx_a) = registry.register("terminal_execute", "a".into(), None, None);
        let (b, mut rx_b) = registry.register("session_close", "b".into(), None, None);
        let cleared = registry.deny_all();
        assert_eq!(cleared.len(), 2);
        assert!(cleared.iter().any(|p| p.approval_id == a.approval_id));
        assert!(cleared.iter().any(|p| p.approval_id == b.approval_id));
        assert_eq!(rx_a.try_recv(), Ok(false));
        assert_eq!(rx_b.try_recv(), Ok(false));
        assert_eq!(registry.pending_count(), 0);
    }

    #[test]
    fn allowed_tools_are_tracked_per_tool() {
        let registry = ApprovalRegistry::new();
        registry.set_allowed_tools(vec!["terminal_execute".into()]);
        assert!(registry.is_tool_allowed("terminal_execute"));
        assert!(!registry.is_tool_allowed("session_close"));
        registry.allow_tool("session_close");
        assert_eq!(
            registry.allowed_tools(),
            vec!["session_close".to_string(), "terminal_execute".to_string()]
        );
    }
}
