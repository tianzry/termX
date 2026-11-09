//! 串口 / Telnet 的「写入 + 采集」执行模型。
//!
//! 这两类传输没有命令边界，也没有退出码：只能把字节写到线路，再从会话输出
//! 流里把响应读回来。采集复用 `SerialHandle` / `TelnetHandle` 已有的读线程
//! （同一条 `Data` 再广播一份），**不**另开读取，也不会抢前端终端的 sink。
//!
//! 终止条件（先到先算）：
//! - 静默空闲：连续 `idleMs` 没有新数据；
//! - 等待正则：累计输出命中 `waitRegex`；
//! - 总超时：从写入时刻起超过 `timeoutMs`；
//! - 会话关闭：读线程报错退出（返回已采集内容，`exitCode` 仍为 null）。
//!
//! 采集上限 `MAX_CAPTURE_BYTES`：超出后继续计数但不再追加，`truncated=true`。

use std::time::Duration;

use regex::Regex;
use tokio::sync::broadcast;

/// 静默判定默认值：串口设备回显通常 <100ms，500ms 足够覆盖慢速波特率。
pub const DEFAULT_IDLE_MS: u64 = 500;
pub const MIN_IDLE_MS: u64 = 50;
pub const MAX_IDLE_MS: u64 = 5_000;

/// 总超时默认值，与 SSH / 本地终端共用同一组上下限。
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MIN_TIMEOUT_MS: u64 = 1_000;
pub const MAX_TIMEOUT_MS: u64 = 60_000;

/// 单次采集最多保留的字节数；`bytesRead` 仍按实际收到的字节累计。
pub const MAX_CAPTURE_BYTES: usize = 64 * 1024;

/// 终止原因，序列化为工具返回里的 `terminatedBy`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminatedBy {
    Idle,
    Pattern,
    Timeout,
    Closed,
}

impl TerminatedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Pattern => "pattern",
            Self::Timeout => "timeout",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug)]
pub struct CollectOutcome {
    pub output: Vec<u8>,
    pub bytes_read: usize,
    pub truncated: bool,
    pub terminated_by: TerminatedBy,
}

/// 采集源：`Some` = 一段新数据，`None` = 会话已关闭。
///
/// 生产实现是 `broadcast::Receiver<Vec<u8>>`；测试用脚本源注入三条终止路径。
pub trait ChunkSource {
    fn next_chunk(&mut self) -> impl std::future::Future<Output = Option<Vec<u8>>> + Send;
}

impl ChunkSource for broadcast::Receiver<Vec<u8>> {
    async fn next_chunk(&mut self) -> Option<Vec<u8>> {
        loop {
            match self.recv().await {
                Ok(chunk) => return Some(chunk),
                // 采集循环是唯一的消费者且始终在跑，Lag 只可能发生在极端调度
                // 抖动下；丢掉这段旧数据比报错更符合「看终端回显」的语义。
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

/// 从 `source` 采集直到命中终止条件。调用方负责在写入前订阅，避免漏掉首包回显。
pub async fn collect<S: ChunkSource>(
    source: &mut S,
    idle: Duration,
    timeout: Duration,
    pattern: Option<&Regex>,
) -> CollectOutcome {
    let started = tokio::time::Instant::now();
    let deadline = started + timeout;
    let mut last_data = started;
    let mut output = Vec::new();
    let mut bytes_read = 0usize;
    let mut truncated = false;

    loop {
        let wake_at = (last_data + idle).min(deadline);
        tokio::select! {
            biased;
            chunk = source.next_chunk() => match chunk {
                None => {
                    return CollectOutcome {
                        output,
                        bytes_read,
                        truncated,
                        terminated_by: TerminatedBy::Closed,
                    };
                }
                Some(chunk) => {
                    bytes_read += chunk.len();
                    let room = MAX_CAPTURE_BYTES.saturating_sub(output.len());
                    if chunk.len() > room {
                        output.extend_from_slice(&chunk[..room]);
                        truncated = true;
                    } else {
                        output.extend_from_slice(&chunk);
                    }
                    last_data = tokio::time::Instant::now();
                    if let Some(re) = pattern {
                        if re.is_match(&String::from_utf8_lossy(&output)) {
                            return CollectOutcome {
                                output,
                                bytes_read,
                                truncated,
                                terminated_by: TerminatedBy::Pattern,
                            };
                        }
                    }
                    if last_data >= deadline {
                        return CollectOutcome {
                            output,
                            bytes_read,
                            truncated,
                            terminated_by: TerminatedBy::Timeout,
                        };
                    }
                }
            },
            _ = tokio::time::sleep_until(wake_at) => {
                let now = tokio::time::Instant::now();
                return CollectOutcome {
                    output,
                    bytes_read,
                    truncated,
                    terminated_by: if now >= deadline {
                        TerminatedBy::Timeout
                    } else {
                        TerminatedBy::Idle
                    },
                };
            }
        }
    }
}

#[derive(Debug)]
pub struct ExecOutcome {
    pub bytes_written: usize,
    pub bytes_read: usize,
    pub output: Vec<u8>,
    pub truncated: bool,
    pub terminated_by: TerminatedBy,
    pub idle_ms: u64,
    pub timeout_ms: u64,
}

/// 写入一条命令（自动追加行结束符）并从已订阅的输出流采集响应。
///
/// `subscriber` 必须在调用前通过 `handle.subscribe()` 建好：广播不会补发历史，
/// 先写后订阅会漏掉对端的第一段回显。
pub async fn write_and_collect<W>(
    mut subscriber: broadcast::Receiver<Vec<u8>>,
    write: W,
    command: &str,
    line_ending: &str,
    idle: Duration,
    timeout: Duration,
    pattern: Option<&Regex>,
) -> crate::error::AppResult<ExecOutcome>
where
    W: FnOnce(&[u8]) -> crate::error::AppResult<usize>,
{
    let mut payload = Vec::with_capacity(command.len() + line_ending.len());
    payload.extend_from_slice(command.as_bytes());
    payload.extend_from_slice(line_ending.as_bytes());
    let bytes_written = write(&payload)?;
    let outcome = collect(&mut subscriber, idle, timeout, pattern).await;
    Ok(ExecOutcome {
        bytes_written,
        bytes_read: outcome.bytes_read,
        output: outcome.output,
        truncated: outcome.truncated,
        terminated_by: outcome.terminated_by,
        idle_ms: idle.as_millis() as u64,
        timeout_ms: timeout.as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// 脚本源：按队列吐数据，每次前摇 `gap`；队列空后按 `hangs` 选择永久挂起
    /// （模拟「设备不再说话」）或返回 None（模拟「会话关闭」）。
    struct FakeSource {
        queue: VecDeque<Vec<u8>>,
        gap: Duration,
        hangs: bool,
    }

    impl FakeSource {
        fn new(chunks: &[&str], gap_ms: u64, hangs: bool) -> Self {
            Self {
                queue: chunks.iter().map(|s| s.as_bytes().to_vec()).collect(),
                gap: Duration::from_millis(gap_ms),
                hangs,
            }
        }
    }

    impl ChunkSource for FakeSource {
        async fn next_chunk(&mut self) -> Option<Vec<u8>> {
            match self.queue.pop_front() {
                Some(chunk) => {
                    tokio::time::sleep(self.gap).await;
                    Some(chunk)
                }
                None if self.hangs => {
                    std::future::pending::<()>().await;
                    unreachable!("pending never resolves")
                }
                None => None,
            }
        }
    }

    const IDLE: Duration = Duration::from_millis(80);
    const TIMEOUT: Duration = Duration::from_secs(5);

    #[tokio::test]
    async fn stops_on_idle_after_last_chunk() {
        let mut source = FakeSource::new(&["hello"], 5, true);
        let out = collect(&mut source, IDLE, TIMEOUT, None).await;
        assert_eq!(out.terminated_by, TerminatedBy::Idle);
        assert_eq!(out.output, b"hello");
        assert_eq!(out.bytes_read, 5);
        assert!(!out.truncated);
    }

    #[tokio::test]
    async fn stops_on_wait_regex() {
        let mut source = FakeSource::new(&["hel", "lo ", "OK\n", "extra"], 5, true);
        let re = Regex::new("OK").unwrap();
        let out = collect(&mut source, IDLE, TIMEOUT, Some(&re)).await;
        assert_eq!(out.terminated_by, TerminatedBy::Pattern);
        assert_eq!(out.output, b"hello OK\n");
        assert!(out.bytes_read >= 9);
    }

    #[tokio::test]
    async fn stops_on_total_timeout_when_data_keeps_coming() {
        // 每 10ms 一段，idle 1s 永远等不到，只有 120ms 总超时能终止。
        let chunks: Vec<String> = (0..50).map(|i| format!("line-{i}\n")).collect();
        let refs: Vec<&str> = chunks.iter().map(String::as_str).collect();
        let mut source = FakeSource::new(&refs, 10, true);
        let out = collect(
            &mut source,
            Duration::from_millis(1_000),
            Duration::from_millis(120),
            None,
        )
        .await;
        assert_eq!(out.terminated_by, TerminatedBy::Timeout);
        assert!(out.bytes_read > 0);
        assert!(!out.output.is_empty());
    }

    #[tokio::test]
    async fn stops_when_session_closes() {
        let mut source = FakeSource::new(&["bye"], 5, false);
        let out = collect(&mut source, IDLE, TIMEOUT, None).await;
        assert_eq!(out.terminated_by, TerminatedBy::Closed);
        assert_eq!(out.output, b"bye");
    }

    #[tokio::test]
    async fn appends_line_ending_and_counts_written_bytes() {
        let (tx, rx) = broadcast::channel::<Vec<u8>>(8);
        let writes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = writes.clone();
        let worker = tokio::spawn(async move {
            write_and_collect(
                rx,
                move |payload: &[u8]| {
                    sink.lock().unwrap().extend_from_slice(payload);
                    Ok(payload.len())
                },
                "AT",
                "\r\n",
                IDLE,
                TIMEOUT,
                None,
            )
            .await
        });
        // 写入发生在任务启动后；先给对端一点时间，再回一段数据。
        tokio::time::sleep(Duration::from_millis(20)).await;
        tx.send(b"OK\r\n".to_vec()).unwrap();
        let out = worker.await.unwrap().unwrap();
        assert_eq!(writes.lock().unwrap().as_slice(), b"AT\r\n");
        assert_eq!(out.bytes_written, 4);
        assert_eq!(out.output, b"OK\r\n");
        assert_eq!(out.terminated_by, TerminatedBy::Idle);
        assert_eq!(out.idle_ms, IDLE.as_millis() as u64);
    }
}
