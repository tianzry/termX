//! 复用 SSH 会话的 SFTP 通道。
//!
//! 优先取 `state.sftp_sessions` 里同父会话的现成通道（用户在 SFTP 页已打开）；
//! 没有就在该 SSH 连接上新开一个 subsystem 通道，用完随 `Arc` 释放。

use std::sync::Arc;

use serde_json::json;

use crate::error::{locked, AppError, AppResult};
use crate::ssh::sftp::SftpHandle;
use crate::state::AppState;

pub async fn sftp_for(state: &AppState, session_id: &str) -> AppResult<Arc<SftpHandle>> {
    if let Some(existing) = {
        let guard = locked(&state.sftp_sessions)?;
        guard
            .values()
            .find(|handle| handle.parent_ssh_id() == Some(session_id))
            .cloned()
    } {
        return Ok(existing);
    }

    let ssh = {
        let sessions = locked(&state.sessions)?;
        sessions
            .get(session_id)
            .ok_or_else(|| {
                AppError::not_found("ssh_session_not_found_msg", json!({ "id": session_id }))
            })?
            .ssh_handle()
            .clone()
    };

    let parent = session_id.to_string();
    let handle = crate::ssh::client::run_blocking_ssh(move || async move {
        SftpHandle::from_handle(&ssh, parent).await
    })
    .await?;
    Ok(Arc::new(handle))
}
