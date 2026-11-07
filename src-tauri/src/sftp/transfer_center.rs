//! SFTP 传输队列中心（阶段 A：仅后端）。
//!
//! 对标 Netcatty 契约（`globalTransferScheduler` / `TransferTask` /
//! `SftpConflictDialog`，见 `../Netcatty`）：
//! - **队列中心**：持久化排队项（`sftp_transfer_queue` 表，schema v35）、
//!   全局并发上限（settings key `sftp_transfer_concurrency`，默认 6、上限 16）、
//!   暂停 / 恢复、优先级重排、取消；
//! - **进度事件**：复用既有 `sftp:progress:<transfer_id>`（upload/download_streaming
//!   已按 transfer_id 发出）；状态变化另发 `sftp:transfer_updated:<id>`；
//! - **冲突检测**：传输启动前检测目标存在（上传查远端 stat、下载查本地），
//!   命中且无"应用到全部"策略时置 Conflict 等待用户答复；
//!   [`resolve_conflict`] 支持 replace / skip / rename，"应用到全部"按批次生效
//!   （对齐 Netcatty `pruneTransferConflictDefaults` 的批次作用域）。
//!
//! 与 Netcatty 的简化差异（changelogs 有记）：
//! - 运行中"暂停" = 置 cancel flag 让 worker 收尾，并把 `checkpoint`（连续已写
//!   偏移）落库；恢复时从该偏移续传（上传写远端 `.part`、下载续写本地 `.part`）。
//!   源文件（大小 / mtime）在恢复前变化 → 清零断点并报 `sftp_resume_source_changed`，
//!   绝不静默续错；
//! - 应用重启后旧会话（`session_live=false`）不支持续传：恢复会明确报
//!   `sftp_resume_session_offline`，UI 行内标注而不是假装继续；
//! - 冲突选项为 replace / skip / rename，无 merge（目录合并）/ stop；
//! - 重启恢复：Running 还原为 Queued（会话已随进程消失，阶段 B 前端重连后重绑）。
//!
//! 调度模型：无独立调度线程。`pump` 在命令上下文（入队 / 恢复 / 解决冲突 /
//! 完成回调）触发；worker 完成后再 `pump_cached` 续跑。worker 是 'static
//! tokio 任务，不能借用 AppState —— 所需 SftpHandle 在 pump 时从
//! `state.sftp_sessions` 快照进 `Inner::handles`，worker 侧只用快照。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::sftp_transfer as persist;
use crate::db::Db;
use crate::emitter::Host;
use crate::error::{locked, AppError, AppResult};
use crate::ssh::sftp::{SftpHandle, CANCELLED_CODE};
use crate::state::AppState;

/// 默认全局并发（Netcatty `netcatty_sftp_transfer_concurrency_v1` 的对位）。
pub const DEFAULT_CONCURRENCY: usize = 6;
pub const MAX_CONCURRENCY: usize = 16;
const CONCURRENCY_KEY: &str = "sftp_transfer_concurrency";
/// 自动重命名尝试上限（对齐 Netcatty `getDuplicateTarget`：1..999）。
const MAX_RENAME_ATTEMPTS: u32 = 999;

// ── 数据模型 ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Paused,
    Conflict,
    Completed,
    Failed,
    Cancelled,
    Skipped,
}

impl Status {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Status::Completed | Status::Failed | Status::Cancelled | Status::Skipped
        )
    }
}

/// 变体声明序即 Ord 序（Low < Normal < High），pick 按降序取。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictAction {
    Replace,
    Skip,
    Rename,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferItem {
    pub id: String,
    pub sftp_id: String,
    /// 一次 enqueue 调用产生一个批次；"应用到全部"按批次生效。
    pub batch_id: String,
    pub direction: Direction,
    pub local_path: String,
    pub remote_path: String,
    /// 0 = 未知（进度条不定长）。
    pub size: u64,
    pub status: Status,
    pub priority: Priority,
    /// 入队序号，同优先级内 FIFO 的 tiebreak。
    pub seq: i64,
    /// 冲突决策 = 替换（或自动重命名完成）后置位：跳过冲突检测直接覆盖。
    pub overwrite: bool,
    /// 失败时的 i18n code（R5）。
    pub error: Option<String>,
    pub created_at: i64,
    /// 已连续写入的字节偏移；暂停后从这里续传（0 = 从头）。
    #[serde(default)]
    pub checkpoint: u64,
    /// 首次开始时的源文件修改时间（秒）。恢复前与当前值比较，变化则不静默续传。
    #[serde(default)]
    pub source_mtime: Option<i64>,
    /// 对应 SFTP 会话是否仍然存活（false = 应用重启后旧会话，不能续传）。
    #[serde(default)]
    pub session_live: bool,
    /// 来源 SSH 会话 id（同一会话可开多条 SFTP 通道；「打开目标目录」按会话匹配）。
    #[serde(default)]
    pub session_id: Option<String>,
}

/// 入队请求。嵌套 struct 字段走 serde 原样（R3：嵌套 snake_case）。
#[derive(Debug, Clone, Deserialize)]
pub struct NewTransfer {
    pub sftp_id: String,
    pub direction: Direction,
    pub local_path: String,
    pub remote_path: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub priority: Priority,
}

// ── 队列中心 ────────────────────────────────────────────────

struct Inner {
    items: Vec<TransferItem>,
    running: usize,
    concurrency: usize,
    seq_counter: i64,
    /// 用户勾过"应用到全部"的冲突策略：batch_id → action。
    /// 批次无活跃项时回收（Netcatty pruneTransferConflictDefaults 语义）。
    conflict_policy: HashMap<String, ConflictAction>,
    /// 运行中项被请求暂停：cancel 命中时落 Paused 而非 Cancelled。
    pause_requested: HashSet<String>,
    /// sftp_id → handle 快照。命令侧每次 pump 刷新；worker 侧只用快照。
    handles: HashMap<String, Arc<SftpHandle>>,
}

pub struct TransferCenter {
    inner: Mutex<Inner>,
    /// 队列传输的 cancel flag：transfer_id → flag。与 `state.transfer_cancels`
    /// （服务非队列的直接传输）分离；`sftp_transfer_cancel` 查这张表。
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    db: Arc<Db>,
}

impl TransferCenter {
    /// 从 DB 恢复未终态项；并发上限读 settings（缺省 2）。
    pub fn new(db: Arc<Db>) -> Self {
        let mut items = Vec::new();
        let mut seq_counter: i64 = 0;
        match persist::load_unfinished(&db) {
            Ok(rows) => {
                for row in rows {
                    seq_counter = seq_counter.max(row.seq + 1);
                    items.push(item_from_row(row));
                }
            }
            Err(e) => log::warn!("failed to load persisted transfer queue: {e}"),
        }
        let concurrency = crate::db::settings::get(&db, CONCURRENCY_KEY)
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_CONCURRENCY)
            .clamp(1, MAX_CONCURRENCY);
        Self {
            inner: Mutex::new(Inner {
                items,
                running: 0,
                concurrency,
                seq_counter,
                conflict_policy: HashMap::new(),
                pause_requested: HashSet::new(),
                handles: HashMap::new(),
            }),
            cancels: Mutex::new(HashMap::new()),
            db,
        }
    }

    pub fn snapshot(&self) -> AppResult<Vec<TransferItem>> {
        let g = locked(&self.inner)?;
        let live: HashSet<String> = g.handles.keys().cloned().collect();
        let mut items = g.items.clone();
        for it in &mut items {
            it.session_live = live.contains(&it.sftp_id);
        }
        Ok(items)
    }

    /// worker 侧调度：只用 Inner::handles 快照（无 AppState 访问）。
    /// 命令侧请用 [`pump`]（先刷新 handle 快照）。
    pub fn pump_cached(self: &Arc<Self>, host: &Host) -> AppResult<()> {
        loop {
            let (item, handle) = {
                let mut g = locked(&self.inner)?;
                if g.running >= g.concurrency {
                    return Ok(());
                }
                let live: HashSet<String> = g.handles.keys().cloned().collect();
                let Some(idx) = pick_next_index(&g.items, g.running, g.concurrency, &live) else {
                    return Ok(());
                };
                let mut item = g.items[idx].clone();
                let handle = g
                    .handles
                    .get(&item.sftp_id)
                    .cloned()
                    .expect("pick_next_index 只挑 live 会话");
                item.status = Status::Running;
                item.error = None;
                // 清理上一轮遗留的暂停请求（防 resume 后误判为暂停）。
                g.pause_requested.remove(&item.id);
                g.items[idx] = item.clone();
                g.running += 1;
                (item, handle)
            };
            if let Err(e) = persist::update(&self.db, &row_from_item(&item)) {
                log::warn!("failed to persist transfer {}: {e}", item.id);
            }
            let flag = Arc::new(AtomicBool::new(false));
            locked(&self.cancels)?.insert(item.id.clone(), flag.clone());
            let _ = host.emit(&format!("sftp:transfer_updated:{}", item.id), item.clone());
            let center = self.clone();
            let host2 = host.clone();
            let item2 = item.clone();
            tokio::spawn(async move {
                run_transfer(center, item2, handle, host2, flag).await;
            });
        }
    }
}

/// 命令侧调度：先刷新 handle 快照再跑 [`TransferCenter::pump_cached`]。
pub fn pump(state: &AppState, host: &Host) -> AppResult<()> {
    let center = &state.transfer_center;
    {
        let mut g = locked(&center.inner)?;
        refresh_handles(&mut g, state);
    }
    center.pump_cached(host)
}

fn refresh_handles(g: &mut Inner, state: &AppState) {
    if let Ok(map) = locked(&state.sftp_sessions) {
        g.handles = map.clone();
    }
}

// ── 引擎函数（Tauri command 与 headless dispatcher 共用，R4/INV-4） ──

pub async fn enqueue(
    state: &AppState,
    host: &Host,
    reqs: Vec<NewTransfer>,
) -> AppResult<Vec<TransferItem>> {
    let center = &state.transfer_center;
    let batch_id = uuid::Uuid::new_v4().to_string();
    let now = now_secs();
    let mut created = Vec::new();
    {
        let mut g = locked(&center.inner)?;
        refresh_handles(&mut g, state);
        for req in reqs {
            let seq = g.seq_counter;
            g.seq_counter += 1;
            let session_id = g
                .handles
                .get(&req.sftp_id)
                .and_then(|h| h.parent_ssh_id().map(str::to_owned));
            let item = TransferItem {
                id: uuid::Uuid::new_v4().to_string(),
                sftp_id: req.sftp_id,
                batch_id: batch_id.clone(),
                direction: req.direction,
                local_path: req.local_path,
                remote_path: req.remote_path,
                size: req.size,
                status: Status::Queued,
                priority: req.priority,
                seq,
                overwrite: false,
                error: None,
                created_at: now,
                checkpoint: 0,
                source_mtime: None,
                session_live: true,
                session_id,
            };
            persist::insert(&center.db, &row_from_item(&item))?;
            created.push(item.clone());
            g.items.push(item);
        }
    }
    let _ = host.emit("sftp:queue_changed", center.snapshot()?);
    pump(state, host)?;
    Ok(created)
}

pub async fn list(state: &AppState) -> AppResult<Vec<TransferItem>> {
    refreshed_snapshot(state)
}

/// 会话集合变化（SFTP / 所属 SSH 断开）后刷新 handle 快照再取全量快照。
/// `snapshot` 只用 `Inner::handles` 的缓存副本（worker 侧无 AppState），
/// 因此断开后必须由调用方主动刷新，否则运行期断线仍显示 `session_live=true`
/// （离线标注与「恢复/重试」禁用全靠这个字段）。
pub fn refreshed_snapshot(state: &AppState) -> AppResult<Vec<TransferItem>> {
    let center = &state.transfer_center;
    {
        let mut g = locked(&center.inner)?;
        refresh_handles(&mut g, state);
    }
    center.snapshot()
}

pub async fn pause(state: &AppState, host: &Host, transfer_id: String) -> AppResult<()> {
    let center = &state.transfer_center;
    let updated = {
        let mut g = locked(&center.inner)?;
        let Some(idx) = g.items.iter().position(|i| i.id == transfer_id) else {
            return Err(not_found(&transfer_id));
        };
        // 索引访问：MutexGuard 经 Deref 借用整个 Inner，不支持跨字段分裂借用，
        // 不能同时持有 items 迭代器再碰 pause_requested。
        match g.items[idx].status {
            Status::Queued => {
                g.items[idx].status = Status::Paused;
                Some(g.items[idx].clone())
            }
            Status::Running => {
                g.pause_requested.insert(transfer_id.clone());
                None
            }
            _ => return Err(state_invalid(&transfer_id)),
        }
    };
    match updated {
        Some(item) => {
            persist::update(&center.db, &row_from_item(&item))?;
            let _ = host.emit(&format!("sftp:transfer_updated:{transfer_id}"), item);
        }
        None => {
            // 运行中：置 cancel flag，worker 落地时按 pause_requested 记 Paused。
            if let Some(flag) = locked(&center.cancels)?.get(&transfer_id).cloned() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
    Ok(())
}

pub async fn resume(state: &AppState, host: &Host, transfer_id: String) -> AppResult<()> {
    let center = &state.transfer_center;
    // 会话已随进程消失（应用重启）→ 明确拒绝，避免 UI 假装续传后永远排队。
    {
        let g = locked(&center.inner)?;
        let Some(item) = g.items.iter().find(|i| i.id == transfer_id) else {
            return Err(not_found(&transfer_id));
        };
        if !g.handles.contains_key(&item.sftp_id) {
            return Err(AppError::sftp(
                "sftp_resume_session_offline",
                json!({ "id": item.sftp_id }),
            ));
        }
    }
    let item = {
        let mut g = locked(&center.inner)?;
        let Some(slot) = g.items.iter_mut().find(|i| i.id == transfer_id) else {
            return Err(not_found(&transfer_id));
        };
        if slot.status != Status::Paused {
            return Err(state_invalid(&transfer_id));
        }
        slot.status = Status::Queued;
        slot.error = None;
        slot.clone()
    };
    persist::update(&center.db, &row_from_item(&item))?;
    let _ = host.emit(&format!("sftp:transfer_updated:{transfer_id}"), item);
    pump(state, host)?;
    Ok(())
}

/// 失败项重试（对齐 Netcatty 行尾 RefreshCw）：清空错误与断点，重新排队。
pub async fn retry(state: &AppState, host: &Host, transfer_id: String) -> AppResult<()> {
    let center = &state.transfer_center;
    let item = {
        let mut g = locked(&center.inner)?;
        let Some(idx) = g.items.iter().position(|i| i.id == transfer_id) else {
            return Err(not_found(&transfer_id));
        };
        if g.items[idx].status != Status::Failed {
            return Err(state_invalid(&transfer_id));
        }
        let sftp_id = g.items[idx].sftp_id.clone();
        if !g.handles.contains_key(&sftp_id) {
            return Err(AppError::sftp(
                "sftp_resume_session_offline",
                json!({ "id": sftp_id }),
            ));
        }
        let slot = &mut g.items[idx];
        slot.status = Status::Queued;
        slot.error = None;
        slot.checkpoint = 0;
        slot.source_mtime = None;
        slot.overwrite = false;
        slot.clone()
    };
    persist::update(&center.db, &row_from_item(&item))?;
    let _ = host.emit(&format!("sftp:transfer_updated:{transfer_id}"), item);
    pump(state, host)?;
    Ok(())
}

pub async fn cancel(state: &AppState, host: &Host, transfer_id: String) -> AppResult<()> {
    let center = &state.transfer_center;
    enum Act {
        Terminal(TransferItem),
        RunningFlag,
    }
    let act = {
        let mut g = locked(&center.inner)?;
        let Some(idx) = g.items.iter().position(|i| i.id == transfer_id) else {
            return Err(not_found(&transfer_id));
        };
        match g.items[idx].status {
            Status::Queued | Status::Paused | Status::Conflict => {
                g.items[idx].status = Status::Cancelled;
                Act::Terminal(g.items[idx].clone())
            }
            Status::Running => {
                g.pause_requested.remove(&transfer_id);
                Act::RunningFlag
            }
            _ => return Err(state_invalid(&transfer_id)),
        }
    };
    match act {
        Act::Terminal(item) => {
            persist::update(&center.db, &row_from_item(&item))?;
            let _ = host.emit(&format!("sftp:transfer_updated:{transfer_id}"), item);
        }
        Act::RunningFlag => {
            if let Some(flag) = locked(&center.cancels)?.get(&transfer_id).cloned() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
    Ok(())
}

pub async fn set_priority(
    state: &AppState,
    host: &Host,
    transfer_id: String,
    priority: Priority,
) -> AppResult<()> {
    let center = &state.transfer_center;
    let item = {
        let mut g = locked(&center.inner)?;
        let Some(slot) = g.items.iter_mut().find(|i| i.id == transfer_id) else {
            return Err(not_found(&transfer_id));
        };
        if slot.status.is_terminal() {
            return Err(state_invalid(&transfer_id));
        }
        slot.priority = priority;
        slot.clone()
    };
    persist::update(&center.db, &row_from_item(&item))?;
    let _ = host.emit("sftp:queue_changed", center.snapshot()?);
    pump(state, host)?;
    Ok(())
}

pub async fn set_concurrency(state: &AppState, host: &Host, concurrency: u32) -> AppResult<()> {
    let center = &state.transfer_center;
    let n = (concurrency as usize).clamp(1, MAX_CONCURRENCY);
    {
        locked(&center.inner)?.concurrency = n;
    }
    crate::db::settings::set(&center.db, CONCURRENCY_KEY, &n.to_string())?;
    pump(state, host)?;
    Ok(())
}

/// 冲突答复。`apply_to_all` 时策略按批次记忆：
/// - 同批**尚未启动**的项后续命中冲突时自动套用（[`execute`] 内查 `conflict_policy`）；
/// - 同批**已处于 Conflict** 的项立即回溯套用（并发 > 1 时常见多冲突并存）。
pub async fn resolve_conflict(
    state: &AppState,
    host: &Host,
    transfer_id: String,
    action: ConflictAction,
    apply_to_all: bool,
) -> AppResult<()> {
    let center = &state.transfer_center;
    // 阶段 1：校验 + 快照（锁内不 await）。
    let (item, others, handle) = {
        let mut g = locked(&center.inner)?;
        let item = {
            let Some(it) = g.items.iter().find(|i| i.id == transfer_id) else {
                return Err(not_found(&transfer_id));
            };
            it.clone()
        };
        if item.status != Status::Conflict {
            return Err(state_invalid(&transfer_id));
        }
        if apply_to_all {
            g.conflict_policy.insert(item.batch_id.clone(), action);
        }
        // "应用到全部"：快照同批已冲突项（含各自会话 handle），随后回溯同策略。
        let others: Vec<(TransferItem, Option<Arc<SftpHandle>>)> = if apply_to_all {
            g.items
                .iter()
                .filter(|i| {
                    i.batch_id == item.batch_id && i.id != item.id && i.status == Status::Conflict
                })
                .map(|i| (i.clone(), g.handles.get(&i.sftp_id).cloned()))
                .collect()
        } else {
            Vec::new()
        };
        let handle = g.handles.get(&item.sftp_id).cloned();
        (item, others, handle)
    };
    // 阶段 2：逐项应用决策（rename 需存在性探测，异步；任一失败则整批不落状态）。
    let mut resolutions = Vec::with_capacity(others.len() + 1);
    resolutions.push(apply_conflict_action(&item, action, handle.as_ref()).await?);
    for (other, other_handle) in &others {
        resolutions.push(apply_conflict_action(other, action, other_handle.as_ref()).await?);
    }
    // 阶段 3：锁内落状态（复检仍为 Conflict，防止探测期间被取消/已处理）。
    let mut committed = Vec::with_capacity(resolutions.len());
    {
        let mut g = locked(&center.inner)?;
        let sources = std::iter::once(item).chain(others.into_iter().map(|(it, _)| it));
        for (src, (new_local, new_remote, new_status)) in sources.zip(resolutions) {
            let Some(slot) = g.items.iter_mut().find(|i| i.id == src.id) else {
                continue;
            };
            if slot.status != Status::Conflict {
                continue;
            }
            slot.local_path = new_local;
            slot.remote_path = new_remote;
            slot.overwrite = true;
            slot.status = new_status;
            slot.checkpoint = 0;
            slot.source_mtime = None;
            slot.error = None;
            committed.push(slot.clone());
        }
    }
    for it in &committed {
        persist::update(&center.db, &row_from_item(it))?;
        let _ = host.emit(&format!("sftp:transfer_updated:{}", it.id), it.clone());
    }
    pump(state, host)?;
    Ok(())
}

/// 对单项应用冲突决策，返回（新本地路径, 新远端路径, 新状态）。
/// replace/skip 不改路径；rename 探测 `file (copy)` 系可用名（需要会话 handle）。
async fn apply_conflict_action(
    item: &TransferItem,
    action: ConflictAction,
    handle: Option<&Arc<SftpHandle>>,
) -> AppResult<(String, String, Status)> {
    match action {
        ConflictAction::Skip => Ok((
            item.local_path.clone(),
            item.remote_path.clone(),
            Status::Skipped,
        )),
        ConflictAction::Replace => Ok((
            item.local_path.clone(),
            item.remote_path.clone(),
            Status::Queued,
        )),
        ConflictAction::Rename => {
            let Some(handle) = handle else {
                return Err(AppError::not_found(
                    "sftp_session_not_found",
                    json!({ "id": item.sftp_id }),
                ));
            };
            let (l, r) = find_renamed_target(item, handle).await?;
            Ok((l, r, Status::Queued))
        }
    }
}

pub async fn clear_finished(state: &AppState, host: &Host) -> AppResult<()> {
    let center = &state.transfer_center;
    let removed = {
        let mut g = locked(&center.inner)?;
        let before = g.items.len();
        g.items.retain(|i| !i.status.is_terminal());
        before - g.items.len()
    };
    if removed > 0 {
        persist::delete_by_statuses(&center.db, &["completed", "failed", "cancelled", "skipped"])?;
        let _ = host.emit("sftp:queue_changed", center.snapshot()?);
    }
    Ok(())
}

/// 移除单条终态任务（Netcatty 行尾 dismiss 按钮）。运行中/暂停中的任务不可移除。
pub async fn dismiss(state: &AppState, host: &Host, id: &str) -> AppResult<()> {
    let center = &state.transfer_center;
    {
        let mut g = locked(&center.inner)?;
        let Some(idx) = g.items.iter().position(|i| i.id == id) else {
            return Ok(());
        };
        if !g.items[idx].status.is_terminal() {
            return Err(AppError::sftp(
                "sftp_transfer_not_dismissable",
                json!({ "id": id, "status": status_str(g.items[idx].status) }),
            ));
        }
        g.items.remove(idx);
    }
    persist::delete_by_id(&center.db, id)?;
    let _ = host.emit("sftp:queue_changed", center.snapshot()?);
    Ok(())
}

// ── worker ──────────────────────────────────────────────────

enum Outcome {
    Done,
    Conflict,
    Skipped,
    Failed(AppError),
}

async fn run_transfer(
    center: Arc<TransferCenter>,
    mut item: TransferItem,
    handle: Arc<SftpHandle>,
    host: Host,
    flag: Arc<AtomicBool>,
) {
    let outcome = execute(&center, &mut item, &handle, &host, flag).await;
    if let Ok(mut m) = locked(&center.cancels) {
        m.remove(&item.id);
    }
    let pause_requested = locked(&center.inner)
        .map(|mut g| g.pause_requested.remove(&item.id))
        .unwrap_or(false);
    let (status, error) = match outcome {
        Outcome::Done => (Status::Completed, None),
        Outcome::Conflict => (Status::Conflict, None),
        Outcome::Skipped => (Status::Skipped, None),
        Outcome::Failed(e) => {
            let code = err_code(&e);
            if code == CANCELLED_CODE {
                if pause_requested {
                    (Status::Paused, None)
                } else {
                    (Status::Cancelled, None)
                }
            } else {
                (Status::Failed, Some(code))
            }
        }
    };
    match status {
        Status::Completed => {
            if item.size > 0 {
                item.checkpoint = item.size;
            }
        }
        Status::Cancelled | Status::Failed => {
            cleanup_partial_after_failure(&handle, &mut item).await;
        }
        _ => {}
    }
    finish_transfer(&center, item, status, error, &host);
}

async fn execute(
    center: &TransferCenter,
    item: &mut TransferItem,
    handle: &SftpHandle,
    host: &Host,
    flag: Arc<AtomicBool>,
) -> Outcome {
    // 冲突检测（overwrite 置位 = 用户已决策，跳过）。
    if !item.overwrite {
        let exists = match item.direction {
            Direction::Upload => match remote_exists(handle, &item.remote_path).await {
                Ok(b) => b,
                Err(e) => return Outcome::Failed(e),
            },
            Direction::Download => tokio::fs::try_exists(&item.local_path).await.unwrap_or(false),
        };
        if exists {
            let policy = locked(&center.inner)
                .ok()
                .and_then(|g| g.conflict_policy.get(&item.batch_id).copied());
            match policy {
                None => return Outcome::Conflict,
                Some(ConflictAction::Replace) => {} // 继续即覆盖
                Some(ConflictAction::Skip) => return Outcome::Skipped,
                Some(ConflictAction::Rename) => {
                    match find_renamed_target(item, handle).await {
                        Ok((l, r)) => {
                            item.local_path = l;
                            item.remote_path = r;
                            item.overwrite = true;
                        }
                        Err(e) => return Outcome::Failed(e),
                    }
                }
            }
        }
    }
    match item.direction {
        Direction::Upload => {
            let mut reader = match tokio::fs::File::open(&item.local_path).await {
                Ok(f) => f,
                Err(e) => return Outcome::Failed(AppError::from(e)),
            };
            // content:// 等场景 metadata 可能失败 → 退回入队时的 size（可为 0）。
            let meta = reader.metadata().await.ok();
            let total = meta.as_ref().map(|m| m.len()).unwrap_or(item.size);
            if item.size == 0 && total > 0 {
                item.size = total;
            }
            let current_mtime = meta.as_ref().and_then(|m| m.modified().ok()).and_then(epoch_secs);
            if item.checkpoint > 0 {
                // 源文件变化 → 明确提示并从头重传，绝不静默续错。
                let changed = total != item.size
                    || item
                        .source_mtime
                        .map_or(false, |t| current_mtime != Some(t));
                if changed {
                    item.checkpoint = 0;
                    item.error = Some("sftp_resume_source_changed".into());
                    handle.remove_remote_partial(&item.remote_path).await;
                }
            } else if item.source_mtime.is_none() {
                item.source_mtime = current_mtime;
            }
            let checkpoint = Arc::new(AtomicU64::new(item.checkpoint));
            let res = handle
                .upload_streaming_resumable(
                    &mut reader,
                    total,
                    &item.remote_path,
                    host,
                    &item.id,
                    flag,
                    item.checkpoint,
                    checkpoint.clone(),
                )
                .await;
            item.checkpoint = checkpoint.load(Ordering::SeqCst);
            match res {
                Ok(off) => {
                    item.checkpoint = off;
                    Outcome::Done
                }
                Err(e) => Outcome::Failed(e),
            }
        }
        Direction::Download => {
            let local = PathBuf::from(&item.local_path);
            let part = PathBuf::from(format!("{}.part", item.local_path));
            let (remote_size, remote_mtime) =
                match handle.remote_file_fingerprint(&item.remote_path).await {
                    Ok(v) => v,
                    Err(e) => return Outcome::Failed(e),
                };
            if item.size == 0 {
                item.size = remote_size;
            }
            if item.checkpoint > 0 {
                let changed = remote_size != item.size
                    || item
                        .source_mtime
                        .map_or(false, |t| remote_mtime != Some(t));
                if changed {
                    item.checkpoint = 0;
                    item.error = Some("sftp_resume_source_changed".into());
                    let _ = tokio::fs::remove_file(&part).await;
                }
            } else if item.source_mtime.is_none() {
                item.source_mtime = remote_mtime;
            }
            if let Some(parent) = local.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let mut dst = match tokio::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .open(&part)
                .await
            {
                Ok(f) => f,
                Err(e) => return Outcome::Failed(AppError::from(e)),
            };
            let checkpoint = Arc::new(AtomicU64::new(item.checkpoint));
            let res = handle
                .download_streaming_resumable(
                    &item.remote_path,
                    &mut dst,
                    remote_size,
                    host,
                    &item.id,
                    flag,
                    item.checkpoint,
                    checkpoint.clone(),
                )
                .await;
            item.checkpoint = checkpoint.load(Ordering::SeqCst);
            // 流内已 flush；这里只需关闭本地句柄再 rename。
            drop(dst);
            match res {
                Ok(_) => {
                    let _ = tokio::fs::remove_file(&local).await;
                    match tokio::fs::rename(&part, &local).await {
                        Ok(()) => Outcome::Done,
                        Err(e) => Outcome::Failed(AppError::from(e)),
                    }
                }
                Err(e) => Outcome::Failed(e),
            }
        }
    }
}

/// 取消/失败时清理断点文件并重置偏移；暂停时保留以便续传。
async fn cleanup_partial_after_failure(handle: &SftpHandle, item: &mut TransferItem) {
    match item.direction {
        Direction::Upload => handle.remove_remote_partial(&item.remote_path).await,
        Direction::Download => {
            let part = format!("{}.part", item.local_path);
            let _ = tokio::fs::remove_file(part).await;
        }
    }
    item.checkpoint = 0;
}

fn epoch_secs(t: std::time::SystemTime) -> Option<i64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn finish_transfer(
    center: &Arc<TransferCenter>,
    mut item: TransferItem,
    status: Status,
    error: Option<String>,
    host: &Host,
) {
    item.status = status;
    item.error = error;
    {
        let Ok(mut g) = locked(&center.inner) else {
            return;
        };
        if g.running > 0 {
            g.running -= 1;
        }
        g.pause_requested.remove(&item.id);
        if let Some(slot) = g.items.iter_mut().find(|i| i.id == item.id) {
            *slot = item.clone();
        }
        // Netcatty pruneTransferConflictDefaults 对位：批次无活跃项即回收策略。
        if !g
            .items
            .iter()
            .any(|i| i.batch_id == item.batch_id && !i.status.is_terminal())
        {
            g.conflict_policy.remove(&item.batch_id);
        }
    }
    if let Err(e) = persist::update(&center.db, &row_from_item(&item)) {
        log::warn!("failed to persist transfer {}: {e}", item.id);
    }
    let _ = host.emit(&format!("sftp:transfer_updated:{}", item.id), item.clone());
    let _ = center.pump_cached(host);
}

// ── 冲突工具 ────────────────────────────────────────────────

/// 远端存在性探测。坑：依赖 russh_sftp 把 SSH_FX_NO_SUCH_FILE 的文案
/// 透传进错误串（阶段 C 的 129 live 验证覆盖）；其它错误原样上抛。
async fn remote_exists(handle: &SftpHandle, path: &str) -> AppResult<bool> {
    match handle.stat(path).await {
        Ok(_) => Ok(true),
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            if msg.contains("no such file") || msg.contains("not found") || msg.contains("does not exist") {
                Ok(false)
            } else {
                Err(e)
            }
        }
    }
}

/// 自动重命名目标探测（Netcatty getDuplicateTarget 规则）。
/// 返回 (新本地路径, 新远端路径)，只改与方向相关的一侧。
async fn find_renamed_target(
    item: &TransferItem,
    handle: &SftpHandle,
) -> AppResult<(String, String)> {
    for attempt in 1..=MAX_RENAME_ATTEMPTS {
        match item.direction {
            Direction::Upload => {
                let (dir, name) = split_remote(&item.remote_path);
                let candidate = join_remote_path(&dir, &duplicate_name(&name, attempt));
                if !remote_exists(handle, &candidate).await? {
                    return Ok((item.local_path.clone(), candidate));
                }
            }
            Direction::Download => {
                let path = PathBuf::from(&item.local_path);
                let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let candidate = parent.join(duplicate_name(&name, attempt));
                if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
                    return Ok((candidate.display().to_string(), item.remote_path.clone()));
                }
            }
        }
    }
    // Netcatty 兜底：`file (copy <时间戳>)`，避免极端同名场景直接失败。
    let suffix = format!(" (copy {})", now_secs());
    match item.direction {
        Direction::Upload => {
            let (dir, name) = split_remote(&item.remote_path);
            Ok((
                item.local_path.clone(),
                join_remote_path(&dir, &duplicate_name_with_suffix(&name, &suffix)),
            ))
        }
        Direction::Download => {
            let path = PathBuf::from(&item.local_path);
            let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok((
                parent
                    .join(duplicate_name_with_suffix(&name, &suffix))
                    .display()
                    .to_string(),
                item.remote_path.clone(),
            ))
        }
    }
}

/// Netcatty getDuplicateTarget 兼容：`report.txt` → `report (copy).txt` →
/// `report (copy 2).txt` …；无扩展名 `archive` → `archive (copy)`。
/// 前导点文件按无扩展名处理（`.bashrc` → `.bashrc (copy)`）。
fn duplicate_name(name: &str, attempt: u32) -> String {
    let suffix = if attempt <= 1 {
        " (copy)".to_string()
    } else {
        format!(" (copy {attempt})")
    };
    duplicate_name_with_suffix(name, &suffix)
}

fn duplicate_name_with_suffix(name: &str, suffix: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}{suffix}.{ext}"),
        _ => format!("{name}{suffix}"),
    }
}

fn split_remote(path: &str) -> (String, String) {
    match path.rsplit_once('/') {
        Some(("", name)) => ("/".to_string(), name.to_string()),
        Some((dir, name)) => (dir.to_string(), name.to_string()),
        None => (String::new(), path.to_string()),
    }
}

fn join_remote_path(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", dir.trim_end_matches('/'))
    }
}

// ── 纯函数 / 工具 ───────────────────────────────────────────

/// 纯函数：按（优先级降序, seq 升序）挑下一个可启动项。
/// 会话缺失的排队项被跳过（不阻塞其它项）；`running >= concurrency` 返回 None。
fn pick_next_index(
    items: &[TransferItem],
    running: usize,
    concurrency: usize,
    live_sessions: &HashSet<String>,
) -> Option<usize> {
    if running >= concurrency {
        return None;
    }
    items
        .iter()
        .enumerate()
        .filter(|(_, it)| it.status == Status::Queued && live_sessions.contains(&it.sftp_id))
        .min_by(|(_, a), (_, b)| b.priority.cmp(&a.priority).then(a.seq.cmp(&b.seq)))
        .map(|(i, _)| i)
}

/// 从 AppError 的 Display（`__termx_err__|{...}`）解析 i18n code。
fn err_code(e: &AppError) -> String {
    e.to_string()
        .strip_prefix("__termx_err__|")
        .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_string))
        .unwrap_or_else(|| "sftp_io_failed".to_string())
}

fn not_found(id: &str) -> AppError {
    AppError::not_found("sftp_transfer_not_found", json!({ "id": id }))
}

fn state_invalid(id: &str) -> AppError {
    AppError::other("sftp_transfer_state_invalid", json!({ "id": id }))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── 持久化映射 ──────────────────────────────────────────────

fn item_from_row(r: persist::Row) -> TransferItem {
    TransferItem {
        id: r.id,
        sftp_id: r.sftp_id,
        batch_id: r.batch_id,
        direction: match r.direction.as_str() {
            "download" => Direction::Download,
            _ => Direction::Upload,
        },
        local_path: r.local_path,
        remote_path: r.remote_path,
        size: r.size.max(0) as u64,
        // 重启恢复：Running 无法继续（会话已随进程消失）→ Queued；
        // Conflict 保持（重新弹决策）；Paused 保持（等用户恢复）。
        status: match r.status.as_str() {
            "paused" => Status::Paused,
            "conflict" => Status::Conflict,
            _ => Status::Queued,
        },
        priority: match r.priority {
            0 => Priority::Low,
            2 => Priority::High,
            _ => Priority::Normal,
        },
        seq: r.seq,
        overwrite: r.overwrite != 0,
        error: r.error,
        created_at: r.created_at,
        checkpoint: r.checkpoint.max(0) as u64,
        source_mtime: r.source_mtime,
        session_live: false,
        session_id: None,
    }
}

fn row_from_item(it: &TransferItem) -> persist::Row {
    persist::Row {
        id: it.id.clone(),
        sftp_id: it.sftp_id.clone(),
        batch_id: it.batch_id.clone(),
        direction: match it.direction {
            Direction::Upload => "upload",
            Direction::Download => "download",
        }
        .to_string(),
        local_path: it.local_path.clone(),
        remote_path: it.remote_path.clone(),
        size: it.size as i64,
        status: status_str(it.status).to_string(),
        priority: match it.priority {
            Priority::Low => 0,
            Priority::Normal => 1,
            Priority::High => 2,
        },
        seq: it.seq,
        overwrite: it.overwrite as i64,
        error: it.error.clone(),
        created_at: it.created_at,
        checkpoint: it.checkpoint as i64,
        source_mtime: it.source_mtime,
    }
}

fn status_str(s: Status) -> &'static str {
    match s {
        Status::Queued => "queued",
        Status::Running => "running",
        Status::Paused => "paused",
        Status::Conflict => "conflict",
        Status::Completed => "completed",
        Status::Failed => "failed",
        Status::Cancelled => "cancelled",
        Status::Skipped => "skipped",
    }
}

// ── Tauri commands（generate_handler! + server.rs dispatcher 双注册，R4） ──

#[tauri::command]
pub async fn sftp_transfer_enqueue(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    items: Vec<NewTransfer>,
) -> AppResult<Vec<TransferItem>> {
    let host = Host::Tauri(app);
    enqueue(&state, &host, items).await
}

#[tauri::command]
pub async fn sftp_transfer_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<TransferItem>> {
    list(&state).await
}

#[tauri::command]
pub async fn sftp_transfer_pause(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    pause(&state, &Host::Tauri(app), transfer_id).await
}

#[tauri::command]
pub async fn sftp_transfer_resume(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    resume(&state, &Host::Tauri(app), transfer_id).await
}

#[tauri::command]
pub async fn sftp_transfer_cancel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    cancel(&state, &Host::Tauri(app), transfer_id).await
}

#[tauri::command]
pub async fn sftp_transfer_dismiss(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    dismiss(&state, &Host::Tauri(app), &transfer_id).await
}

#[tauri::command]
pub async fn sftp_transfer_retry(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    retry(&state, &Host::Tauri(app), transfer_id).await
}

#[tauri::command]
pub async fn sftp_transfer_set_priority(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    transfer_id: String,
    priority: Priority,
) -> AppResult<()> {
    set_priority(&state, &Host::Tauri(app), transfer_id, priority).await
}

#[tauri::command]
pub async fn sftp_transfer_set_concurrency(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    concurrency: u32,
) -> AppResult<()> {
    set_concurrency(&state, &Host::Tauri(app), concurrency).await
}

#[tauri::command]
pub async fn sftp_transfer_resolve_conflict(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    transfer_id: String,
    action: ConflictAction,
    apply_to_all: bool,
) -> AppResult<()> {
    resolve_conflict(&state, &Host::Tauri(app), transfer_id, action, apply_to_all).await
}

#[tauri::command]
pub async fn sftp_transfer_clear_finished(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    clear_finished(&state, &Host::Tauri(app)).await
}

// ── 单测（纯逻辑：优先级排序 / 并发调度 / 冲突决策 / 映射） ──

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, status: Status, priority: Priority, seq: i64, sftp_id: &str) -> TransferItem {
        TransferItem {
            id: id.into(),
            sftp_id: sftp_id.into(),
            batch_id: "b".into(),
            direction: Direction::Upload,
            local_path: "l".into(),
            remote_path: "r".into(),
            size: 0,
            status,
            priority,
            seq,
            overwrite: false,
            error: None,
            created_at: 0,
            checkpoint: 0,
            source_mtime: None,
            session_live: true,
            session_id: None,
        }
    }

    fn live_of(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pick_priority_desc_then_fifo() {
        let items = vec![
            item("a", Status::Queued, Priority::Normal, 0, "s1"),
            item("b", Status::Queued, Priority::High, 1, "s1"),
            item("c", Status::Queued, Priority::High, 2, "s1"),
            item("d", Status::Queued, Priority::Low, 3, "s1"),
        ];
        let live = live_of(&["s1"]);
        // High 优先
        assert_eq!(pick_next_index(&items, 0, 2, &live), Some(1));
        // 同优先级按 seq 升序（FIFO）
        let two_highs = vec![items[2].clone(), items[1].clone()];
        assert_eq!(pick_next_index(&two_highs, 0, 1, &live), Some(1));
    }

    #[test]
    fn pick_respects_concurrency_cap() {
        let items = vec![item("a", Status::Queued, Priority::Normal, 0, "s1")];
        let live = live_of(&["s1"]);
        assert_eq!(pick_next_index(&items, 2, 2, &live), None);
        assert_eq!(pick_next_index(&items, 1, 2, &live), Some(0));
    }

    #[test]
    fn pick_skips_dead_sessions_without_blocking() {
        let items = vec![
            item("a", Status::Queued, Priority::High, 0, "dead"),
            item("b", Status::Queued, Priority::Normal, 1, "live"),
        ];
        let live = live_of(&["live"]);
        // 会话缺失的高优先级项不阻塞其它项
        assert_eq!(pick_next_index(&items, 0, 2, &live), Some(1));
    }

    #[test]
    fn pick_ignores_non_queued() {
        let items = vec![
            item("a", Status::Running, Priority::High, 0, "s1"),
            item("b", Status::Paused, Priority::High, 1, "s1"),
            item("c", Status::Conflict, Priority::High, 2, "s1"),
        ];
        let live = live_of(&["s1"]);
        assert_eq!(pick_next_index(&items, 0, 3, &live), None);
    }

    #[test]
    fn duplicate_name_rules() {
        assert_eq!(duplicate_name("report.txt", 1), "report (copy).txt");
        assert_eq!(duplicate_name("report.txt", 2), "report (copy 2).txt");
        assert_eq!(duplicate_name("archive", 1), "archive (copy)");
        assert_eq!(duplicate_name(".bashrc", 1), ".bashrc (copy)");
        assert_eq!(duplicate_name("a.b.tar.gz", 1), "a.b.tar (copy).gz");
    }

    #[test]
    fn err_code_parses_coded_display() {
        let e = AppError::sftp("sftp_io_failed", json!({ "op": "x", "err": "y" }));
        assert_eq!(err_code(&e), "sftp_io_failed");
        let c = AppError::other("transfer_cancelled", json!({}));
        assert_eq!(err_code(&c), "transfer_cancelled");
    }

    #[test]
    fn restore_maps_states() {
        let mut row = persist::Row {
            id: "t1".into(),
            sftp_id: "s".into(),
            batch_id: "b".into(),
            direction: "upload".into(),
            local_path: "l".into(),
            remote_path: "r".into(),
            size: 0,
            status: "running".into(),
            priority: 1,
            seq: 0,
            overwrite: 0,
            error: None,
            created_at: 0,
            checkpoint: 0,
            source_mtime: None,
        };
        assert_eq!(item_from_row(row.clone()).status, Status::Queued);
        row.status = "paused".into();
        assert_eq!(item_from_row(row.clone()).status, Status::Paused);
        row.status = "conflict".into();
        assert_eq!(item_from_row(row).status, Status::Conflict);
    }

    #[test]
    fn row_item_roundtrip() {
        let it = item("x", Status::Conflict, Priority::High, 7, "s9");
        let back = item_from_row(row_from_item(&it));
        assert_eq!(back.id, "x");
        assert_eq!(back.status, Status::Conflict);
        assert_eq!(back.priority, Priority::High);
        assert_eq!(back.seq, 7);
        assert_eq!(back.direction, Direction::Upload);
    }

    #[test]
    fn split_and_join_remote() {
        assert_eq!(split_remote("/tmp/a.txt"), ("/tmp".into(), "a.txt".into()));
        assert_eq!(split_remote("/a.txt"), ("/".into(), "a.txt".into()));
        assert_eq!(split_remote("bare"), ("".into(), "bare".into()));
        assert_eq!(join_remote_path("/tmp", "b.txt"), "/tmp/b.txt");
        assert_eq!(join_remote_path("/", "b.txt"), "/b.txt");
        assert_eq!(join_remote_path("/tmp/", "b.txt"), "/tmp/b.txt");
    }

    #[test]
    fn status_terminal_set() {
        assert!(Status::Completed.is_terminal());
        assert!(Status::Failed.is_terminal());
        assert!(Status::Cancelled.is_terminal());
        assert!(Status::Skipped.is_terminal());
        assert!(!Status::Queued.is_terminal());
        assert!(!Status::Running.is_terminal());
        assert!(!Status::Paused.is_terminal());
        assert!(!Status::Conflict.is_terminal());
    }

    #[test]
    fn conflict_policy_scoped_to_batch() {
        let mut policy: HashMap<String, ConflictAction> = HashMap::new();
        policy.insert("b1".into(), ConflictAction::Replace);
        assert_eq!(policy.get("b1").copied(), Some(ConflictAction::Replace));
        assert_eq!(policy.get("b2"), None);
    }
}
