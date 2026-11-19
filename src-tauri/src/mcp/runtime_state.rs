//! MCP 进程级运行时状态。
//!
//! 这些状态天然是进程单例（MCP server 每个 app 只有一个），放在 `OnceLock`
//! 而不是 `AppState`：既避免给所有测试用的 `AppState` 字面量加字段，也保证
//! 自动建连 owner、单飞表、能力探测缓存在整个进程内稳定。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::audit::AuditLog;
use super::fs::caps::RemoteCaps;

/// `fs_delete` confirmToken 有效期。
pub const DELETE_TOKEN_TTL: Duration = Duration::from_secs(300);
/// 单会话 preamble 字节上限。
pub const MAX_PREAMBLE_BYTES: usize = 8 * 1024;
/// 未正常关闭的会话不会主动清理 preamble，这里按最旧淘汰封顶。
const MAX_PREAMBLES: usize = 512;

/// 一次删除计划的快照：token 只能用于同会话、同路径集合、同递归开关。
pub struct DeleteToken {
    pub session_id: String,
    pub paths: Vec<String>,
    pub recursive: bool,
    pub created: Instant,
}

/// 后台 job 结果保留期：agent 断线/放弃后也要能被清掉，避免无界增长。
const JOB_TTL: Duration = Duration::from_secs(1800);
/// job 注册表容量上限；超限先淘汰最旧的已完成项。
const MAX_JOBS: usize = 256;

/// `build_run` / `sftp_get` 超出 waitMs 窗口后转后台的任务记录。
/// 结果存序列化后的 ToolResult 文本，runtime_state 不依赖 tools 层类型。
pub struct McpJob {
    client_id: String,
    pub tool: String,
    started: Instant,
    finished: Option<Instant>,
    result: Option<(String, bool)>,
}

/// `job_wait` / 内联等待的观察结果。
#[derive(Debug)]
pub enum JobView {
    NotFound,
    Forbidden,
    Running { tool: String, elapsed_ms: u64 },
    Done { elapsed_ms: u64, text: String, is_error: bool },
}

struct PreambleEntry {
    text: String,
    created: Instant,
}

pub struct McpRuntimeState {
    /// 默认客户端（旧单 token）的会话 owner。
    pub owner: uuid::Uuid,
    /// 接入身份 id → 会话 owner（当前仅 default，复用 `owner`）。
    pub client_owners: Mutex<HashMap<String, uuid::Uuid>>,
    /// `client:hostId` → 建连闸门：并发请求共享同一次建连，且不同客户端不互相阻塞。
    pub connect_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// `profile_id` → 远端能力探测结果。
    pub caps: Mutex<HashMap<String, RemoteCaps>>,
    /// `fs_delete` 的待确认计划。
    pub delete_tokens: Mutex<HashMap<String, DeleteToken>>,
    /// `sessionId` → 会话级 preamble（每次 term_run / build_run 确定性前置）。
    preambles: Mutex<HashMap<String, PreambleEntry>>,
    /// jobId → 后台任务（build_run / sftp_get 超出 waitMs 窗口后转入）。
    jobs: Mutex<HashMap<String, McpJob>>,
    pub audit: AuditLog,
}

impl McpRuntimeState {
    fn new() -> Self {
        Self {
            owner: uuid::Uuid::new_v4(),
            client_owners: Mutex::new(HashMap::new()),
            connect_gates: Mutex::new(HashMap::new()),
            caps: Mutex::new(HashMap::new()),
            delete_tokens: Mutex::new(HashMap::new()),
            preambles: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
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

/// 接入身份的稳定 owner：default 沿用旧 owner，保证升级后旧会话仍可被同一身份识别。
pub fn owner_for_client(client_id: &str) -> uuid::Uuid {
    if client_id == "default" {
        return mcp_owner();
    }
    let mut owners = state()
        .client_owners
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *owners
        .entry(client_id.to_string())
        .or_insert_with(uuid::Uuid::new_v4)
}

/// 会话结束后回收其 owner，避免长期运行时映射无界增长。
pub fn forget_client_owner(client_id: &str) {
    state()
        .client_owners
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(client_id);
}

fn preamble_key(client_id: &str, session_id: &str) -> String {
    format!("{client_id}\u{0}{session_id}")
}

/// 设置会话 preamble；空串（或全空白）等价于清除。
///
/// key 带接入身份：即使用户窗口会话被多个客户端共享，各自的 preamble 也互不可见。
/// 只存文本、不改远端状态：每次 term_run / build_run 都重新前置一遍，
/// 因此不会出现「上次 source 过、这次却没加载」的泄漏式状态。
pub fn set_session_preamble(client_id: &str, session_id: &str, preamble: &str) {
    let key = preamble_key(client_id, session_id);
    let mut map = state()
        .preambles
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if preamble.trim().is_empty() {
        map.remove(&key);
        return;
    }
    if !map.contains_key(&key) && map.len() >= MAX_PREAMBLES {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(key, _)| key.clone())
        {
            map.remove(&oldest);
        }
    }
    map.insert(
        key,
        PreambleEntry {
            text: preamble.to_string(),
            created: Instant::now(),
        },
    );
}

pub fn session_preamble(client_id: &str, session_id: &str) -> Option<String> {
    state()
        .preambles
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&preamble_key(client_id, session_id))
        .map(|entry| entry.text.clone())
}

/// 会话关闭后立即回收，让重建的同名会话不会继承旧 preamble。
pub fn forget_session_preamble(client_id: &str, session_id: &str) {
    state()
        .preambles
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&preamble_key(client_id, session_id));
}

/// 取（或创建）某客户端 + 某主机的建连闸门。
pub fn connect_gate(client_id: &str, host_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let key = format!("{client_id}\u{0}{host_id}");
    let mut gates = state()
        .connect_gates
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    gates
        .entry(key)
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

pub fn store_delete_token(token: String, entry: DeleteToken) {
    let mut tokens = state()
        .delete_tokens
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 顺手清理过期项，避免只策划不确认的调用无限堆积。
    tokens.retain(|_, value| value.created.elapsed() < DELETE_TOKEN_TTL);
    tokens.insert(token, entry);
}

/// 取用即失效（无论后续校验是否通过），避免 token 被反复试探。
pub fn take_delete_token(token: &str) -> Option<DeleteToken> {
    let mut tokens = state()
        .delete_tokens
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = tokens.remove(token)?;
    if entry.created.elapsed() >= DELETE_TOKEN_TTL {
        return None;
    }
    Some(entry)
}

/// 注册一个后台 job，返回 jobId。顺带清扫过期项，保持注册表有界。
pub fn register_job(client_id: &str, tool: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let mut jobs = state()
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    jobs.retain(|_, job| match job.finished {
        Some(finished) => finished.elapsed() < JOB_TTL,
        None => true,
    });
    while jobs.len() >= MAX_JOBS {
        let Some(oldest) = jobs
            .iter()
            .filter(|(_, job)| job.finished.is_some())
            .min_by_key(|(_, job)| job.finished)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        jobs.remove(&oldest);
    }
    jobs.insert(
        id.clone(),
        McpJob {
            client_id: client_id.to_string(),
            tool: tool.to_string(),
            started: Instant::now(),
            finished: None,
            result: None,
        },
    );
    id
}

/// 后台任务收尾：写入序列化后的 ToolResult，之后 job_wait 可重复读取。
pub fn complete_job(job_id: &str, text: String, is_error: bool) {
    let mut jobs = state()
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(job) = jobs.get_mut(job_id) {
        job.finished = Some(Instant::now());
        job.result = Some((text, is_error));
    }
}

pub fn job_view(client_id: &str, job_id: &str) -> JobView {
    let jobs = state()
        .jobs
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(job) = jobs.get(job_id) else {
        return JobView::NotFound;
    };
    if job.client_id != client_id {
        return JobView::Forbidden;
    }
    let elapsed_ms = (job.finished.unwrap_or_else(Instant::now) - job.started).as_millis() as u64;
    match &job.result {
        Some((text, is_error)) => JobView::Done {
            elapsed_ms,
            text: text.clone(),
            is_error: *is_error,
        },
        None => JobView::Running {
            tool: job.tool.clone(),
            elapsed_ms,
        },
    }
}

/// 轮询等待 job 完成，直到 deadline；100ms 粒度对 MCP 场景足够，
/// 换来实现简单且没有 Notify 丢唤醒的竞态。
pub async fn wait_job(client_id: &str, job_id: &str, wait: Duration) -> JobView {
    let deadline = Instant::now() + wait;
    loop {
        let view = job_view(client_id, job_id);
        if !matches!(view, JobView::Running { .. }) || Instant::now() >= deadline {
            return view;
        }
        let step = Duration::from_millis(100).min(deadline - Instant::now());
        tokio::time::sleep(step).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_roundtrip_and_clear() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        assert_eq!(session_preamble("client-a", &id), None);
        set_session_preamble("client-a", &id, "source ~/zephyr-env.sh");
        assert_eq!(
            session_preamble("client-a", &id).as_deref(),
            Some("source ~/zephyr-env.sh")
        );
        // 同一会话被其它客户端共享时不继承 preamble。
        assert_eq!(session_preamble("client-b", &id), None);
        set_session_preamble("client-a", &id, "   ");
        assert_eq!(session_preamble("client-a", &id), None);
        forget_session_preamble("client-a", &id);
    }

    #[tokio::test]
    async fn job_register_complete_and_owner_isolation() {
        let client = format!("job-client-{}", uuid::Uuid::new_v4());
        let other = format!("job-client-{}", uuid::Uuid::new_v4());
        let id = register_job(&client, "build_run");
        assert!(matches!(job_view(&client, &id), JobView::Running { .. }));
        // 别的客户端查不到（不是 NotFound 就是 Forbidden，不能泄漏结果）。
        assert!(matches!(job_view(&other, &id), JobView::Forbidden));
        assert!(matches!(job_view(&client, "no-such-job"), JobView::NotFound));
        complete_job(&id, "{\"code\":\"ok\"}".to_string(), false);
        match job_view(&client, &id) {
            JobView::Done { text, is_error, .. } => {
                assert_eq!(text, "{\"code\":\"ok\"}");
                assert!(!is_error);
            }
            other_view => panic!("expected Done, got {other_view:?}"),
        }
        // waitMs=0 的 wait_job 对已完成任务立即返回结果。
        assert!(matches!(
            wait_job(&client, &id, Duration::from_millis(0)).await,
            JobView::Done { .. }
        ));
    }

    #[tokio::test]
    async fn job_wait_returns_running_on_timeout() {
        let client = format!("job-client-{}", uuid::Uuid::new_v4());
        let id = register_job(&client, "sftp_get");
        assert!(matches!(
            wait_job(&client, &id, Duration::from_millis(150)).await,
            JobView::Running { .. }
        ));
        complete_job(&id, "done".to_string(), false);
        assert!(matches!(
            wait_job(&client, &id, Duration::from_millis(0)).await,
            JobView::Done { .. }
        ));
    }
}
