use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use russh::client;
use russh::ChannelMsg;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

use crate::error::{locked, AppError, AppResult};
use crate::models::{Credential, Profile};

use super::prompt::prompt_host_key;

/// 全局主机密钥校验开关（设置中心 → 终端 → 主机密钥校验策略）。
///
/// 设置是应用级全局值，连接入口（ssh_connect / 后台 SFTP / 端口转发）在
/// 建立连接前读取一次即可；握手处理器不持有 AppState，故用进程级原子量。
static VERIFY_HOST_KEYS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// 由连接入口按设置写入；默认开启校验。
pub fn set_verify_host_keys(enabled: bool) {
    VERIFY_HOST_KEYS.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

fn verify_host_keys_enabled() -> bool {
    VERIFY_HOST_KEYS.load(std::sync::atomic::Ordering::Relaxed)
}

/// 主机级 `host_key_policy` → 是否校验主机密钥。
/// `None` = 跟随全局；`verify` / `skip` 为单机覆盖（大小写不敏感）。
pub fn host_key_policy_verifies(policy: Option<&str>) -> Option<bool> {
    match policy.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("verify") | Some("enforce") | Some("on") => Some(true),
        Some("skip") | Some("off") | Some("none") => Some(false),
        _ => None,
    }
}

/// 终端 TERM 类型（设置中心 → 终端 → 字体区「终端标识」）。
static TERM_TYPE: OnceLock<StdMutex<String>> = OnceLock::new();

pub fn set_terminal_emulation_type(value: &str) {
    let cell = TERM_TYPE.get_or_init(|| StdMutex::new("xterm-256color".into()));
    if let Ok(mut guard) = cell.lock() {
        *guard = value.to_string();
    }
}

fn terminal_emulation_type() -> String {
    let cell = TERM_TYPE.get_or_init(|| StdMutex::new("xterm-256color".into()));
    match cell.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => "xterm-256color".into(),
    }
}

/// Re-export 旧 path：实现已迁移到 `ssh::auth` / `ssh::prompt`，调用点
/// （forward / sftp / commands / state）仍可写 `ssh::client::AuthCtx`、
/// `ssh::client::authenticate`，无需扩散改动。
pub use super::auth::authenticate;
pub use super::prompt::AuthCtx;

pub const DEFAULT_CONNECT_TIMEOUT: u64 = 10;

/// Job sent to the dedicated SSH worker thread. The closure runs on the
/// worker thread inside the LocalSet — it is responsible for spawning its
/// own local future. The closure itself is `Send` (we ship it across the
/// mpsc channel), but the future it produces does NOT need to be `Send`,
/// which is the whole point.
type SshJob = Box<dyn FnOnce() + Send + 'static>;

/// Submit a job to the SSH worker thread. Lazy-spawns the worker on first
/// use: a single OS thread driving a `current_thread` tokio runtime + a
/// `LocalSet`. The worker thread (and runtime) lives for the process
/// lifetime — no drop-the-runtime-and-kill-everything regression.
///
/// **Why this layout**: the only way to dodge the HRTB-Send elaboration
/// failure on russh's internal `&Sender<Msg>` borrows (rust-lang#96865) is
/// to spawn russh futures on a runtime that doesn't require `Send` on its
/// tasks. `LocalSet::spawn_local` is exactly that. But LocalSet pins to one
/// thread — so we dedicate one. `#[tauri::command]` futures only ever
/// await `oneshot::Receiver`, which carries no russh-derived types, so the
/// HRTB-Send check on the command never sees the russh internals.
fn ssh_dispatcher() -> &'static tokio::sync::mpsc::UnboundedSender<SshJob> {
    static TX: OnceLock<tokio::sync::mpsc::UnboundedSender<SshJob>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SshJob>();
        std::thread::Builder::new()
            .name("termx-ssh".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("ssh worker runtime");
                let local = tokio::task::LocalSet::new();
                rt.block_on(local.run_until(async move {
                    while let Some(job) = rx.recv().await {
                        job();
                    }
                }));
            })
            .expect("spawn ssh worker thread");
        tx
    })
}

/// Spawn an SSH-touching future on the dedicated SSH worker. Returns a
/// `oneshot::Receiver` for the result.
///
/// `work` must be `Send + 'static` (it crosses thread boundaries via mpsc),
/// but the future it returns does NOT need to be `Send` — it runs on the
/// LocalSet, single-threaded.
pub fn spawn_ssh<F, Fut, T>(work: F) -> tokio::sync::oneshot::Receiver<AppResult<T>>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = AppResult<T>> + 'static,
    T: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    let job: SshJob = Box::new(move || {
        let fut = work();
        tokio::task::spawn_local(async move {
            let _ = tx.send(fut.await);
        });
    });
    let _ = ssh_dispatcher().send(job);
    rx
}

/// Convenience: spawn + await + flatten. Call from async ctx.
pub async fn run_blocking_ssh<F, Fut, T>(work: F) -> AppResult<T>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = AppResult<T>> + 'static,
    T: Send + 'static,
{
    spawn_ssh(work)
        .await
        .map_err(|_| AppError::ssh("ssh_task_cancelled", json!({})))?
}

/// Owned, type-erased progress logger that consumes `String`.
///
/// Why `String` and not `&str`: a `Fn(&str)` trait object is `for<'a> Fn(&'a str)`,
/// a higher-ranked bound. When that trait object is captured in a future and
/// awaited under `#[tauri::command]`, the compiler can't elaborate
/// `for<'a>` Send through the russh internal state (rust-lang#96865 cluster).
/// `Fn(String)` carries no HRTB — caller hands over an owned String per call.
/// Cost is one allocation per log line; we log a handful per connection.
pub type LogFn = Arc<dyn Fn(String) + Send + Sync>;

pub(crate) fn null_logger() -> LogFn {
    Arc::new(|_: String| ())
}

/// 连接进度事件 `ssh:progress:<sessionId>` 的发送器。
///
/// 对标 netcatty 的 `onChainProgress`：每次拨号 / 认证 / 开 shell 都向
/// 连接弹窗推送一条结构化状态，前端据此渲染三段进度条与日志。
/// 后台连接（SFTP / forward）没有弹窗，传 `None` 即可。
#[derive(Clone)]
pub struct ProgressEmitter {
    app: crate::emitter::Host,
    session_id: String,
    hop: u32,
    total: u32,
    label: String,
}

impl ProgressEmitter {
    pub fn root(app: crate::emitter::Host, session_id: String, label: String) -> Self {
        Self {
            app,
            session_id,
            hop: 1,
            total: 1,
            label,
        }
    }

    /// 派生出某一跳的发送器（hop 从 1 开始，total >= 1）。
    pub fn hop(&self, hop: u32, total: u32, label: String) -> Self {
        Self {
            app: self.app.clone(),
            session_id: self.session_id.clone(),
            hop,
            total,
            label,
        }
    }

    pub fn emit(&self, status: &str, error: Option<String>) {
        let payload = json!({
            "hop": self.hop,
            "total": self.total,
            "label": self.label,
            "status": status,
            "error": error,
        });
        let _ = self
            .app
            .emit(&format!("ssh:progress:{}", self.session_id), payload);
    }
}

/// 默认 SSH 客户端配置：开启 keepalive，远端死了 90 秒内能断开。
/// Standalone bulk connections (SFTP's own connection, sftp.rs). Keep the
/// russh default window (2MB): a small window would cap transfer throughput
/// at ~window/RTT on high-latency links.
pub fn default_client_config() -> Arc<client::Config> {
    client_config_for_algorithms(&crate::models::SshAlgorithms::default(), 2 * 1024 * 1024)
}

/// Interactive shell sessions. Uses a reduced flow-control window.
pub fn client_config_for_profile(profile: &Profile) -> Arc<client::Config> {
    client_config_for_algorithms(&profile.algorithms, 256 * 1024)
}

/// The channel window bounds how far the remote (sshd + its TCP send buffer)
/// may run ahead of our consumption. russh's 2MB default lets a slow link bank
/// several MB of output — after Ctrl+C kills the producer, that banked data
/// keeps streaming for tens of seconds. 256KB collapses the queue: sshd
/// blocks, the remote pty fills, the producer blocks in write(). Channels
/// opened on the interactive connection (SFTP-from-shell-tab, forwarding)
/// inherit it; standalone SFTP keeps the 2MB default.
fn client_config_for_algorithms(
    algorithms: &crate::models::SshAlgorithms,
    window_size: u32,
) -> Arc<client::Config> {
    let mut cfg = client::Config::default();
    crate::ssh::algorithms::apply_to_config(&mut cfg, algorithms);
    cfg.keepalive_interval = Some(Duration::from_secs(30));
    cfg.keepalive_max = 3;
    cfg.window_size = window_size;
    Arc::new(cfg)
}

/// Shared SSH connection handle for opening new channels (SFTP, forwarding).
pub type SshHandle = Arc<tokio::sync::Mutex<client::Handle<SshHandler>>>;

// ---------------------------------------------------------------------------
// SSH handler — known_hosts 验证（OpenSSH 标准格式）
// ---------------------------------------------------------------------------

pub struct SshHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    key_mismatch: Arc<StdMutex<bool>>,
    /// Remote listening port -> consumer for forwarded channels on that port.
    forwarded_channels: ForwardedChannelRouter,
    /// Surface TOFU fingerprints / known_hosts write errors back to the user.
    log: LogFn,
    /// 终端可达性上下文：有则未知主机走 xterm 内 yes/no/指纹确认；
    /// 无（SFTP / Forward 后台连接）则未知主机直接拒绝。
    prompt_ctx: Option<AuthCtx>,
    /// 本连接是否允许服务端打开 agent 转发通道（取自档案 agent_forwarding）。
    /// 安全边界：false 时一律 reject，服务端即便请求也拿不到本机 agent。
    agent_forwarding: bool,
    /// 主机级 known-host 校验策略（档案 host_key_policy）；None = 跟随全局。
    host_key_policy: Option<String>,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        let delivered = self
            .forwarded_channels
            .lock()
            .ok()
            .and_then(|router| {
                router
                    .routes
                    .get(&connected_port)
                    .or(router.pending.as_ref())
                    .cloned()
            })
            .is_some_and(|tx| tx.send(channel).is_ok());
        async move {
            if delivered {
                reply.accept().await;
            } else {
                log::warn!("no forward route for remote port {connected_port}; rejecting channel");
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
            Ok(())
        }
    }

    fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        // 安全边界：档案未开启 agent_forwarding 的连接一律拒绝——服务端
        // （或被打穿的远端进程）不能反向借用本机身份。开启时先连本机
        // agent，连得上才 accept；连不上直接 reject，避免挂起通道。
        let allowed = self.agent_forwarding;
        let log = self.log.clone();
        async move {
            if !allowed {
                log("Agent forwarding channel rejected (disabled for this profile).".to_owned());
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
                return Ok(());
            }
            match connect_local_agent().await {
                Some(mut agent) => {
                    reply.accept().await;
                    log("Agent forwarding channel accepted; bridging to local SSH agent.".to_owned());
                    tauri::async_runtime::spawn(async move {
                        let mut stream = channel.into_stream();
                        if let Err(e) =
                            tokio::io::copy_bidirectional(&mut stream, &mut agent).await
                        {
                            log::warn!("agent forward bridge ended: {e}");
                        }
                    });
                }
                None => {
                    log("Agent forwarding channel rejected (no local SSH agent reachable).".to_owned());
                    reply
                        .reject(russh::ChannelOpenFailure::ConnectFailed)
                        .await;
                }
            }
            Ok(())
        }
    }

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        use russh::keys::known_hosts;
        use russh::keys::HashAlg;

        // 主机级策略优先；未设置时回落到全局设置（Netcatty verifyHostKeys）。
        let skip_verify = match host_key_policy_verifies(self.host_key_policy.as_deref()) {
            Some(verify) => !verify,
            None => !verify_host_keys_enabled(),
        };

        // 同步部分先做完：known_hosts 查询 + 指纹计算。
        // pubkey 跨 await 边界要 Clone（learn 需要它）。
        let check = known_hosts::check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        );
        let host = self.host.clone();
        let port = self.port;
        let path = self.known_hosts_path.clone();
        let alg = server_public_key.algorithm().as_str().to_string();
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let pubkey = server_public_key.clone();
        let log = self.log.clone();
        let ctx = self.prompt_ctx.clone();
        let mismatch = self.key_mismatch.clone();

        async move {
            if skip_verify {
                return Ok(true);
            }
            match check {
                Ok(true) => Ok(true),
                // 未知主机：有 ctx 走 xterm 确认，无 ctx（SFTP/Forward 后台连接）直接拒绝。
                Ok(false) => match ctx {
                    Some(c) => handle_unknown_host(c, host, port, alg, fp, pubkey, path, log).await,
                    None => {
                        log(format!(
                            "Unknown host {host}:{port} ({alg} fingerprint {fp}). \
                             No terminal context for confirmation; \
                             connect via SSH terminal first to establish trust."
                        ));
                        Ok(false)
                    }
                },
                // 已知主机但密钥变更：有 ctx 给一次"replace"机会；无 ctx 直接拒绝。
                Err(_) => match ctx {
                    Some(c) => {
                        handle_key_mismatch(c, host, port, alg, fp, pubkey, path, log, mismatch)
                            .await
                    }
                    None => {
                        if let Ok(mut m) = mismatch.lock() {
                            *m = true;
                        }
                        Ok(false)
                    }
                },
            }
        }
    }

    fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        if let Ok(mut router) = self.forwarded_channels.lock() {
            router.routes.clear();
            router.pending = None;
        }
        async move {
            match reason {
                client::DisconnectReason::ReceivedDisconnect(info) => {
                    log::warn!(
                        "SSH server disconnected: {:?}: {}",
                        info.reason_code,
                        info.message
                    );
                    Ok(())
                }
                client::DisconnectReason::Error(e) => {
                    log::warn!("SSH session error: {e:?}");
                    Err(e)
                }
            }
        }
    }
}

/// TOFU 第一次连：弹 banner → 用户输 yes / 指纹 / 其它 → learn 到 known_hosts。
/// 失败（取消 / 拒绝）一律返回 Ok(false) 让 russh 终止握手，不抛错——是用户主动选的。
async fn handle_unknown_host(
    ctx: AuthCtx,
    host: String,
    port: u16,
    alg: String,
    fp: String,
    pubkey: russh::keys::ssh_key::PublicKey,
    path: PathBuf,
    log: LogFn,
) -> Result<bool, russh::Error> {
    use russh::keys::known_hosts;

    let banner = format!(
        "\r\nThe authenticity of host '{host}' can't be established.\r\n\
         {alg} key fingerprint is {fp}.\r\n\
         This key is not known by any other names.\r\n\
         Are you sure you want to continue connecting (yes/no/[fingerprint])? "
    );
    let payload = json!({
        "banner": banner,
        "host": host,
        "port": port,
        "key_type": alg,
        "fingerprint": fp,
        "status": "unknown",
    });
    let answer = match prompt_host_key(&ctx, payload).await {
        Ok(a) => a,
        Err(_) => {
            log(format!(
                "Host key confirmation cancelled for {host}:{port}."
            ));
            return Ok(false);
        }
    };
    let trimmed = answer.trim();
    // `continue` = 仅本次信任、不写入 known_hosts（netcatty Continue 按钮）。
    if trimmed.eq_ignore_ascii_case("continue") {
        log(format!(
            "Host key for {host}:{port} accepted for this session only."
        ));
        return Ok(true);
    }
    if !(trimmed.eq_ignore_ascii_case("yes") || trimmed == fp) {
        log(format!("Host key rejected by user for {host}:{port}."));
        return Ok(false);
    }
    match known_hosts::learn_known_hosts_path(&host, port, &pubkey, &path) {
        Ok(()) => log(format!("Permanently added {host}:{port} to known_hosts.")),
        Err(e) => log(format!("known_hosts write failed: {e}")),
    }
    Ok(true)
}

/// 已知 host 但密钥变了：MITM 警告 → 用户输 'replace' 才删旧加新。
/// 字面 'replace'（不是 'yes'）是设计上加大手滑成本——这是潜在中间人攻击场景。
/// 任何路径下 mismatch flag 都要置位（取消 / 拒绝 / 删除失败），让上层把错误码翻成
/// `ssh_host_key_changed` 而不是泛泛的 connect 失败。
async fn handle_key_mismatch(
    ctx: AuthCtx,
    host: String,
    port: u16,
    alg: String,
    fp: String,
    pubkey: russh::keys::ssh_key::PublicKey,
    path: PathBuf,
    log: LogFn,
    mismatch: Arc<StdMutex<bool>>,
) -> Result<bool, russh::Error> {
    use russh::keys::known_hosts;
    use russh::keys::HashAlg;

    let set_mismatch = || {
        if let Ok(mut m) = mismatch.lock() {
            *m = true;
        }
    };

    let old_fps: Vec<String> = known_hosts::known_host_keys_path(&host, port, &path)
        .ok()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, k)| k.fingerprint(HashAlg::Sha256).to_string())
        .collect();
    let old_fps_str = if old_fps.is_empty() {
        "(unknown)".to_string()
    } else {
        old_fps.join("\r\n  ")
    };
    let banner = format!(
        "\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n\
         @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n\
         @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n\
         IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\r\n\
         Someone could be eavesdropping on you right now (man-in-the-middle attack)!\r\n\
         \r\n\
         Host: {host}:{port}\r\n\
         Old key fingerprint:\r\n  {old_fps_str}\r\n\
         New key fingerprint:\r\n  {fp} ({alg})\r\n\
         \r\n\
         If the server was legitimately reinstalled, type 'replace' to remove\r\n\
         the old key and trust the new one. Anything else aborts.\r\n\
         > "
    );
    let payload = json!({
        "banner": banner,
        "host": host,
        "port": port,
        "key_type": alg,
        "fingerprint": fp,
        "status": "changed",
        "known_fingerprint": old_fps_str,
    });
    let answer = match prompt_host_key(&ctx, payload).await {
        Ok(a) => a,
        Err(_) => {
            set_mismatch();
            log(format!(
                "Host key change confirmation cancelled for {host}:{port}."
            ));
            return Ok(false);
        }
    };
    let trimmed = answer.trim();
    // `continue` = 仅本次信任、保留旧 known_hosts 条目（netcatty Continue 按钮）。
    if trimmed.eq_ignore_ascii_case("continue") {
        log(format!(
            "Host key change for {host}:{port} accepted for this session only."
        ));
        return Ok(true);
    }
    if trimmed != "replace" {
        set_mismatch();
        log(format!(
            "Host key change rejected by user for {host}:{port}."
        ));
        return Ok(false);
    }
    match crate::ssh::known_hosts::remove_host(&host, port, &path) {
        Ok(n) => log(format!(
            "Removed {n} stale entry/entries for {host}:{port}."
        )),
        Err(e) => {
            log(format!("Failed to remove old known_hosts entry: {e}"));
            set_mismatch();
            return Ok(false);
        }
    }
    match known_hosts::learn_known_hosts_path(&host, port, &pubkey, &path) {
        Ok(()) => log(format!(
            "New host key for {host}:{port} added to known_hosts."
        )),
        Err(e) => log(format!("known_hosts write failed: {e}")),
    }
    Ok(true)
}

#[derive(Default)]
pub struct ForwardedChannelRoutes {
    pub routes: HashMap<u32, mpsc::UnboundedSender<russh::Channel<client::Msg>>>,
    pub pending: Option<mpsc::UnboundedSender<russh::Channel<client::Msg>>>,
}

pub type ForwardedChannelRouter = Arc<StdMutex<ForwardedChannelRoutes>>;

/// The constant context for dialing one SSH endpoint: everything that stays the
/// same across every hop of a bastion chain. Only `host`/`port` (and the relayed
/// `stream` for tunneled hops) vary per call, so those stay separate parameters.
/// `ssh_connect` / `ssh_connect_with_forward` / `ssh_connect_stream` each carried
/// these five identically before.
#[derive(Clone)]
pub struct DialCtx {
    pub config: Arc<client::Config>,
    pub known_hosts_path: PathBuf,
    pub timeout_secs: u64,
    pub log: LogFn,
    pub prompt_ctx: Option<AuthCtx>,
    /// 连接弹窗进度（后台连接为 None）。
    pub progress: Option<ProgressEmitter>,
    /// 该端点是否接受 agent 转发通道（按档案逐跳设置；堡垒跳默认各自档案决定）。
    pub agent_forwarding: bool,
    /// 主机级 known-host 校验策略（`verify` / `skip`）；None = 跟随全局。
    pub host_key_policy: Option<String>,
    /// 主机级连接代理（已解析密码）。None = 直连；目标在 no_proxy 内也会直连。
    pub proxy: Option<crate::ssh::proxy::ProxyConfig>,
    /// 服务端 SSH identification string 截获槽。仅对「目标」跳设置，
    /// 堡垒跳为 None（避免把堡垒的 banner 当成目标主机的发行版）。
    pub banner: Option<crate::ssh::distro::BannerSink>,
}

fn new_handler(
    host: &str,
    port: u16,
    known_hosts_path: PathBuf,
    log: LogFn,
    prompt_ctx: Option<AuthCtx>,
    agent_forwarding: bool,
    host_key_policy: Option<String>,
) -> (SshHandler, Arc<StdMutex<bool>>, ForwardedChannelRouter) {
    let mismatch = Arc::new(StdMutex::new(false));
    let fwd_channels: ForwardedChannelRouter = Arc::new(StdMutex::new(Default::default()));
    let handler = SshHandler {
        host: host.to_string(),
        port,
        known_hosts_path,
        key_mismatch: mismatch.clone(),
        forwarded_channels: fwd_channels.clone(),
        log,
        prompt_ctx,
        agent_forwarding,
        host_key_policy,
    };
    (handler, mismatch, fwd_channels)
}

/// 本机 SSH agent 的原始字节流（agent 转发泵用）。
/// - Windows：OpenSSH Authentication Agent 的 named pipe；Pageant 走
///   WM_COPYDATA 请求/应答，不是字节流，无法透明桥接（留档，与 auth.rs
///   的认证路径差异：认证可经 AgentClient 抽象用 Pageant，转发不行）。
/// - Unix：$SSH_AUTH_SOCK 的 unix socket。
#[cfg(windows)]
async fn connect_local_agent(
) -> Option<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin> {
    tokio::net::windows::named_pipe::ClientOptions::new()
        .open(r"\\.\pipe\openssh-ssh-agent")
        .ok()
}

#[cfg(not(windows))]
async fn connect_local_agent(
) -> Option<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin> {
    let path = std::env::var("SSH_AUTH_SOCK").ok()?;
    tokio::net::UnixStream::connect(&path).await.ok()
}

fn map_connect_error(
    e: russh::Error,
    host: &str,
    port: u16,
    mismatch: &StdMutex<bool>,
) -> AppError {
    // Mismatch flag 只是一个 bool；中毒理论不会发生，但仍走 locked() 让 panic 路径
    // 转成 AppError::Lock 而不是直接 unwrap panic。
    let changed = locked(mismatch).map(|g| *g).unwrap_or(false);
    if changed {
        AppError::ssh(
            "ssh_host_key_changed",
            json!({ "host": host, "port": port }),
        )
    } else {
        AppError::ssh("ssh_connect_failed", json!({ "err": e.to_string() }))
    }
}

/// 建立 SSH 连接并验证主机密钥（带超时）。
/// host: String (owned) — every `&str` parameter that survives an await
/// risks tripping the HRTB-Send elaboration bug downstream.
pub async fn ssh_connect(
    ctx: DialCtx,
    host: String,
    port: u16,
) -> AppResult<client::Handle<SshHandler>> {
    let (handle, _fwd) = establish_connection(ctx, host, port).await?;
    Ok(handle)
}

/// SSH connect that also returns the forwarded channel sender (for remote forwarding).
pub async fn ssh_connect_with_forward(
    ctx: DialCtx,
    host: String,
    port: u16,
) -> AppResult<(client::Handle<SshHandler>, ForwardedChannelRouter)> {
    establish_connection(ctx, host, port).await
}

/// 统一拨号：主机配了代理且目标不在 no_proxy 内 → 先完成代理握手，再在
/// 已连通的流上跑 SSH 握手；否则保持原来的直连路径（行为零变化）。
async fn establish_connection(
    ctx: DialCtx,
    host: String,
    port: u16,
) -> AppResult<(client::Handle<SshHandler>, ForwardedChannelRouter)> {
    let DialCtx {
        config,
        known_hosts_path,
        timeout_secs,
        log,
        prompt_ctx,
        progress,
        agent_forwarding,
        proxy,
        banner,
        host_key_policy,
    } = ctx;
    let connect_timeout = Duration::from_secs(timeout_secs);
    if let Some(p) = &progress {
        p.emit("connecting", None);
    }
    let (handler, mismatch, fwd) = new_handler(
        &host,
        port,
        known_hosts_path,
        log,
        prompt_ctx,
        agent_forwarding,
        host_key_policy,
    );

    let result = match proxy.filter(|p| !p.should_bypass(&host, port)) {
        Some(proxy) => {
            let stream = match crate::ssh::proxy::connect_via_proxy(&proxy, &host, port, connect_timeout)
                .await
            {
                Ok(stream) => stream,
                Err(e) => {
                    if let Some(p) = &progress {
                        p.emit("error", Some(e.to_string()));
                    }
                    return Err(e);
                }
            };
            let stream = crate::ssh::distro::BannerCaptureStream::new(stream, banner);
            match timeout(connect_timeout, client::connect_stream(config, stream, handler)).await {
                Ok(Ok(handle)) => Ok(handle),
                Ok(Err(e)) => Err(map_connect_error(e, &host, port, &mismatch)),
                Err(_) => Err(AppError::ssh(
                    "ssh_handshake_timeout",
                    json!({ "host": &host, "port": port }),
                )),
            }
        }
        None => {
            if let Some(sink) = banner {
                // 直连也自行建 TCP，以便在握手前截获服务端 banner；
                // 与 russh `client::connect` 内部的 TcpStream 连接等价。
                // TCP 与握手共享同一个连接超时预算（对齐原先单次 timeout 语义）。
                let started = std::time::Instant::now();
                match timeout(
                    connect_timeout,
                    tokio::net::TcpStream::connect((host.clone(), port)),
                )
                .await
                {
                    Ok(Ok(stream)) => {
                        let stream =
                            crate::ssh::distro::BannerCaptureStream::new(stream, Some(sink));
                        let remaining = connect_timeout.saturating_sub(started.elapsed());
                        match timeout(
                            remaining,
                            client::connect_stream(config, stream, handler),
                        )
                        .await
                        {
                            Ok(Ok(handle)) => Ok(handle),
                            Ok(Err(e)) => Err(map_connect_error(e, &host, port, &mismatch)),
                            Err(_) => Err(AppError::ssh(
                                "ssh_handshake_timeout",
                                json!({ "host": &host, "port": port }),
                            )),
                        }
                    }
                    Ok(Err(e)) => Err(AppError::ssh(
                        "ssh_connect_failed",
                        json!({ "err": e.to_string() }),
                    )),
                    Err(_) => Err(AppError::ssh(
                        "ssh_connect_timeout",
                        json!({ "host": &host, "port": port, "secs": timeout_secs }),
                    )),
                }
            } else {
                match timeout(connect_timeout, client::connect(config, (host.as_str(), port), handler))
                    .await
                {
                    Ok(result) => result.map_err(|e| map_connect_error(e, &host, port, &mismatch)),
                    Err(_) => Err(AppError::ssh(
                        "ssh_connect_timeout",
                        json!({ "host": &host, "port": port, "secs": timeout_secs }),
                    )),
                }
            }
        }
    };
    match &result {
        Ok(_) => {
            if let Some(p) = &progress {
                p.emit("tcp-connected", None);
            }
        }
        Err(e) => {
            if let Some(p) = &progress {
                p.emit("error", Some(e.to_string()));
            }
        }
    }
    result.map(|handle| (handle, fwd))
}

/// 在已有 stream 上建立 SSH 连接（用于堡垒机隧道）。同时返回 forward channel sender，
/// 让远程转发能注册到末跳 handler。普通调用方丢 `_` 即可。
pub async fn ssh_connect_stream<S>(
    ctx: DialCtx,
    stream: S,
    host: String,
    port: u16,
) -> AppResult<(client::Handle<SshHandler>, ForwardedChannelRouter)>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let DialCtx {
        config,
        known_hosts_path,
        timeout_secs,
        log,
        prompt_ctx,
        progress,
        agent_forwarding,
        proxy: _,
        banner,
        host_key_policy,
    } = ctx;
    let connect_timeout = Duration::from_secs(timeout_secs);
    if let Some(p) = &progress {
        p.emit("connecting", None);
    }
    let (handler, mismatch, fwd) = new_handler(
        &host,
        port,
        known_hosts_path,
        log,
        prompt_ctx,
        agent_forwarding,
        host_key_policy,
    );
    let stream = crate::ssh::distro::BannerCaptureStream::new(stream, banner);
    let handle = match timeout(
        connect_timeout,
        client::connect_stream(config, stream, handler),
    )
    .await
    {
        Ok(Ok(handle)) => handle,
        Ok(Err(e)) => {
            let err = map_connect_error(e, &host, port, &mismatch);
            if let Some(p) = &progress {
                p.emit("error", Some(err.to_string()));
            }
            return Err(err);
        }
        Err(_) => {
            let err = AppError::ssh(
                "ssh_handshake_timeout",
                json!({ "host": host, "port": port }),
            );
            if let Some(p) = &progress {
                p.emit("error", Some(err.to_string()));
            }
            return Err(err);
        }
    };
    if let Some(p) = &progress {
        p.emit("tcp-connected", None);
    }
    Ok((handle, fwd))
}

/// 通过堡垒机链建立到 target 的 SSH 连接。链空则直连 target。
/// 链中每一跳直接 authenticate；target 的 authenticate 由调用方负责。
/// 返回 `(target_handle, target_fwd_sender)` —— remote 转发用 fwd_sender，其余可丢弃。
///
/// All inputs are owned: chain by value, target profile by value, log as Arc<dyn>.
/// Owned-everywhere is correct here, not just convenient — these data flow
/// in one direction (DB → connect → live session), there's no other party
/// holding references. Borrowed parameters in async fns hand-cuff us with
/// HRTB-Send headaches when awaited under #[tauri::command].
pub async fn establish_via_chain(
    bastion_chain: Vec<(Profile, Credential)>,
    target_profile: Profile,
    proxy_configs: std::collections::HashMap<String, crate::ssh::proxy::ProxyConfig>,
    known_hosts_path: PathBuf,
    timeout_secs: u64,
    log: LogFn,
    ctx: Option<&AuthCtx>,
    progress: Option<&ProgressEmitter>,
    banner: Option<crate::ssh::distro::BannerSink>,
) -> AppResult<(client::Handle<SshHandler>, ForwardedChannelRouter)> {
    let total = (bastion_chain.len() + 1) as u32;
    let target_label = profile_label(&target_profile);
    let target_host = target_profile.host.clone();
    let target_port = target_profile.port;

    if bastion_chain.is_empty() {
        log(format!(
            "TCP connecting to {}:{} ...",
            target_host, target_port
        ));
        let hop_progress = progress.map(|p| p.hop(1, total, target_label.clone()));
        let mut target_ctx = dial_ctx_for_profile(
            &target_profile,
            &known_hosts_path,
            timeout_secs,
            &log,
            ctx,
            hop_progress,
            proxy_configs.get(&target_profile.id).cloned(),
        );
        target_ctx.banner = banner;
        let (h, fwd) = ssh_connect_with_forward(target_ctx, target_host, target_port).await?;
        log("TCP connected. SSH handshake OK.".to_owned());
        return Ok((h, fwd));
    }

    let mut current: Option<client::Handle<SshHandler>> = None;
    let mut prev_label = String::new();
    let mut hop_index = 0u32;

    for (next_p, next_c) in bastion_chain {
        hop_index += 1;
        let next_label = profile_label(&next_p);
        let next_host = next_p.host.clone();
        let next_port = next_p.port;
        let hop_progress = progress.map(|p| p.hop(hop_index, total, next_label.clone()));

        let (mut new_hop, _) = if let Some(prev) = current.as_ref() {
            log(format!(
                "Opening tunnel through {} to bastion {} ({}:{}) ...",
                prev_label, next_label, next_host, next_port
            ));
            if let Some(p) = &hop_progress {
                p.emit("forwarding", None);
            }
            let tunnel = open_tunnel_with_timeout(
                prev,
                next_host.clone(),
                next_port,
                timeout_secs,
                format!("{} → {}", prev_label, next_label),
            )
            .await?;
            ssh_connect_stream(
                dial_ctx_for_profile(
                    &next_p,
                    &known_hosts_path,
                    timeout_secs,
                    &log,
                    ctx,
                    hop_progress.clone(),
                    proxy_configs.get(&next_p.id).cloned(),
                ),
                tunnel.into_stream(),
                next_host,
                next_port,
            )
            .await?
        } else {
            log(format!(
                "Connecting to bastion {} ({}:{}) ...",
                next_label, next_host, next_port
            ));
            let (h, fwd) = ssh_connect_with_forward(
                dial_ctx_for_profile(
                    &next_p,
                    &known_hosts_path,
                    timeout_secs,
                    &log,
                    ctx,
                    hop_progress.clone(),
                    proxy_configs.get(&next_p.id).cloned(),
                ),
                next_host,
                next_port,
            )
            .await?;
            (h, fwd)
        };

        log(format!(
            "Bastion {} connected. Authenticating as {} ({}) ...",
            next_label,
            next_c.username,
            next_c.credential_type.as_str()
        ));
        if let Some(p) = &hop_progress {
            p.emit("authenticating", None);
        }
        authenticate(&mut new_hop, next_c, ctx).await?;
        if let Some(p) = &hop_progress {
            p.emit("authenticated", None);
        }
        log(format!("Bastion {} authenticated.", next_label));
        current = Some(new_hop);
        prev_label = next_label;
    }

    log(format!(
        "Opening tunnel through {} to target {}:{} ...",
        prev_label, target_host, target_port
    ));
    let target_progress = progress.map(|p| p.hop(total, total, target_label));
    if let Some(p) = &target_progress {
        p.emit("forwarding", None);
    }
    let prev = current.expect("bastion chain is non-empty");
    let tunnel = open_tunnel_with_timeout(
        &prev,
        target_host.clone(),
        target_port,
        timeout_secs,
        format!("{} → target", prev_label),
    )
    .await?;
    log("Tunnel established. SSH handshake with target ...".to_owned());
    let mut target_ctx = dial_ctx_for_profile(
        &target_profile,
        &known_hosts_path,
        timeout_secs,
        &log,
        ctx,
        target_progress,
        proxy_configs.get(&target_profile.id).cloned(),
    );
    target_ctx.banner = banner;
    ssh_connect_stream(
        target_ctx,
        tunnel.into_stream(),
        target_host,
        target_port,
    )
    .await
}

fn profile_label(profile: &Profile) -> String {
    if profile.name.is_empty() {
        profile.host.clone()
    } else {
        profile.name.clone()
    }
}

fn dial_ctx_for_profile(
    profile: &Profile,
    known_hosts_path: &Path,
    timeout_secs: u64,
    log: &LogFn,
    ctx: Option<&AuthCtx>,
    progress: Option<ProgressEmitter>,
    proxy: Option<crate::ssh::proxy::ProxyConfig>,
) -> DialCtx {
    DialCtx {
        config: client_config_for_profile(profile),
        known_hosts_path: known_hosts_path.to_path_buf(),
        timeout_secs,
        log: log.clone(),
        prompt_ctx: ctx.cloned(),
        progress,
        agent_forwarding: profile.agent_forwarding,
        host_key_policy: profile.host_key_policy.clone(),
        proxy,
        banner: None,
    }
}

/// 在已建好的 SSH 连接上开 direct-tcpip 隧道，带超时。
/// 没有这个超时，bastion 拨号 target 失败时（VPC 不通 / target 防火墙拒绝 / target 离线）
/// 客户端会一直等 server 返回 `CHANNEL_OPEN_FAILURE`，挂数十秒甚至更久。
///
/// `host` / `label` 都按值传，避免 `&str` 在 await 期间停留；`hop` 必须借用
/// 因为 channel_open_direct_tcpip 是 `&self` 方法。Handle 的内部
/// `Sender<Msg>` 借用是 russh API 决定，无可避免。
async fn open_tunnel_with_timeout(
    hop: &client::Handle<SshHandler>,
    target_host: String,
    target_port: u16,
    timeout_secs: u64,
    label: String,
) -> AppResult<russh::Channel<client::Msg>> {
    let fut =
        hop.channel_open_direct_tcpip(target_host.as_str(), target_port as u32, "127.0.0.1", 0);
    match timeout(Duration::from_secs(timeout_secs), fut).await {
        Ok(r) => r.map_err(|e| {
            AppError::ssh(
                "ssh_bastion_tunnel_failed",
                json!({ "label": &label, "err": e.to_string() }),
            )
        }),
        Err(_) => Err(AppError::ssh(
            "ssh_bastion_tunnel_timeout",
            json!({
                "label": &label,
                "target_host": target_host,
                "target_port": target_port,
                "secs": timeout_secs,
            }),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[tokio::test]
    async fn connection_log_uses_base64_stream_payload() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (app, mut events) = crate::ssh::test_support::headless_host();
        let session_id = uuid::Uuid::new_v4().to_string();
        let owner = crate::state::SessionOwner::Headless(uuid::Uuid::new_v4());
        let state = app.state();
        let _reservation = crate::commands::lifecycle::reserve_resource(
            &state,
            &session_id,
            crate::state::SessionKind::Ssh,
            owner.clone(),
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let params = ConnectParams {
            session_id: session_id.clone(),
            profile: Profile {
                id: "profile".into(),
                name: "test".into(),
                host: "127.0.0.1".into(),
                port,
                credential_id: "credential".into(),
                bastion_profile_id: None,
                init_command: None,
                group_id: None,
                algorithms: Default::default(),
                sftp_protocol: None,
                sftp_sudo: false,
                sftp_encoding: None,
                icon_source: None,
                icon_color: None,
                totp_auto_submit: true,
                totp_regex: None,
                protocol: "ssh".into(),
                local_shell: None,
                local_shell_args: None,
                local_shell_name: None,
                local_shell_icon: None,
                local_start_dir: None,
                agent_forwarding: false,
                proxy_type: None,
                proxy_host: None,
                proxy_port: None,
                proxy_username: None,
                proxy_no_proxy: None,
                proxy_profile_id: None,
                ssh_input_compatibility: None,
                serial_port: None,
                serial_baud: None,
                serial_data_bits: None,
                serial_parity: None,
                serial_stop_bits: None,
                serial_flow: None,
                serial_local_echo: None,
                serial_line_mode: None,
                serial_backspace: None,
                serial_byte_backspace: None,
                serial_charset: None,
                serial_term_opts: None,
                distro: None,
                host_key_policy: None,
                telnet_username: None,
                telnet_charset: None,
                keyword_highlight_enabled: None,
                keyword_highlight_rules: None,
                auto_session_log: None,
            },
            credential: Credential {
                id: "credential".into(),
                name: "test".into(),
                username: "test".into(),
                credential_type: crate::models::CredentialType::None,
                secret: None,
                save_to_remote: false,
            },
            bastion_chain: Vec::new(),
        proxy_configs: Default::default(),
            cols: 80,
            rows: 24,
            app: app.clone(),
            owner,
            auto_log_path: None,
            log_session_id: Some(session_id.clone()),
            prompt_session_id: Some(session_id.clone()),
            known_hosts_path: dir.path().join("known_hosts"),
            timeout_secs: 1,
            env_vars: Vec::new(),
        };

        // Close the peer before the SSH handshake: connect still emits its real
        // progress log, without requiring an SSH daemon or touching user files.
        let (result, ()) = timeout(Duration::from_secs(5), async {
            tokio::join!(connect(params), async {
                let (stream, _) = listener.accept().await.unwrap();
                drop(stream);
            })
        })
        .await
        .expect("connection should fail promptly");
        assert!(result.is_err());

        // Connection progress now emits `ssh:progress:<sid>` events alongside the
        // terminal log, so scan for the (exactly one) `ssh:data` payload instead
        // of assuming it arrives first.
        let data_event = format!("ssh:data:{session_id}");
        let mut payload = None;
        while let Ok((event, value)) = events.try_recv() {
            if event == data_event {
                assert!(payload.is_none(), "expected exactly one ssh:data event");
                payload = Some(value);
            }
        }
        let payload = payload.expect("connection log should emit terminal data");
        let encoded = payload.as_str().expect("terminal data must be base64 text");
        let expected = format!("\x1b[90m[ssh] TCP connecting to 127.0.0.1:{port} ...\x1b[0m\r\n");
        assert_eq!(STANDARD.decode(encoded).unwrap(), expected.as_bytes());
    }

    // ── map_connect_error ──────────────────────────────────────────

    #[test]
    fn map_connect_error_when_mismatch_flag_set() {
        let mismatch = StdMutex::new(true);
        let err = map_connect_error(russh::Error::Version, "h", 22, &mismatch);
        assert_eq!(err.code(), "ssh_host_key_changed");
    }

    #[test]
    fn map_connect_error_when_no_mismatch() {
        let mismatch = StdMutex::new(false);
        let err = map_connect_error(russh::Error::Version, "h", 22, &mismatch);
        assert_eq!(err.code(), "ssh_connect_failed");
    }

    /// `ssh_signal_name` 把 russh 的 `Sig` 还原成 close 事件要上报的短名。
    /// `Sig::name()` 是私有方法，这里手写映射，本测试锁死每个变体的回显。
    #[test]
    fn ssh_signal_name_maps_to_short_names() {
        assert_eq!(ssh_signal_name(&russh::Sig::ABRT), "ABRT");
        assert_eq!(ssh_signal_name(&russh::Sig::ALRM), "ALRM");
        assert_eq!(ssh_signal_name(&russh::Sig::FPE), "FPE");
        assert_eq!(ssh_signal_name(&russh::Sig::HUP), "HUP");
        assert_eq!(ssh_signal_name(&russh::Sig::ILL), "ILL");
        assert_eq!(ssh_signal_name(&russh::Sig::INT), "INT");
        assert_eq!(ssh_signal_name(&russh::Sig::KILL), "KILL");
        assert_eq!(ssh_signal_name(&russh::Sig::PIPE), "PIPE");
        assert_eq!(ssh_signal_name(&russh::Sig::QUIT), "QUIT");
        assert_eq!(ssh_signal_name(&russh::Sig::SEGV), "SEGV");
        assert_eq!(ssh_signal_name(&russh::Sig::TERM), "TERM");
        assert_eq!(ssh_signal_name(&russh::Sig::USR1), "USR1");
        assert_eq!(
            ssh_signal_name(&russh::Sig::Custom("SIGFOO".into())),
            "SIGFOO"
        );
    }

    /// 主机级策略解析：未知 / 空 → None（跟随全局）；verify / skip 生效。
    #[test]
    fn host_key_policy_maps_to_verify_override() {
        assert_eq!(host_key_policy_verifies(None), None);
        assert_eq!(host_key_policy_verifies(Some("")), None);
        assert_eq!(host_key_policy_verifies(Some("default")), None);
        assert_eq!(host_key_policy_verifies(Some("verify")), Some(true));
        assert_eq!(host_key_policy_verifies(Some(" SKIP ")), Some(false));
        assert_eq!(host_key_policy_verifies(Some("off")), Some(false));
    }

    /// 无 GUI 验证"SSH 连接"链路（russh connect → 私钥认证 → shell 写/读回显）。
    /// 依赖一个由外部脚本预先拉起的本地 sshd（环境变量注入地址 + 密钥）。
    /// 没有 sshd 时静默跳过，保证普通 `cargo test` 也能全绿。
    #[tokio::test]
    async fn ssh_connect_to_local_sshd_roundtrip() {
        let Ok(port) = std::env::var("TERMX_SSH_TEST_PORT") else {
            eprintln!("skip: TERMX_SSH_TEST_PORT 未设置（无本地 sshd）");
            return;
        };
        let port: u16 = port.parse().expect("TERMX_SSH_TEST_PORT must be u16");
        let user = std::env::var("TERMX_SSH_TEST_USER").unwrap_or_else(|_| "root".into());
        let key_path = std::env::var("TERMX_SSH_TEST_KEY").expect("TERMX_SSH_TEST_KEY");
        let known_hosts_path =
            std::env::var("TERMX_SSH_TEST_KNOWN_HOSTS").expect("TERMX_SSH_TEST_KNOWN_HOSTS");
        let private_key = std::fs::read_to_string(&key_path).expect("read test private key");

        let (app, mut events) = crate::ssh::test_support::headless_host();
        let session_id = uuid::Uuid::new_v4().to_string();
        let owner = crate::state::SessionOwner::Headless(uuid::Uuid::new_v4());
        let state = app.state();
        let _reservation = crate::commands::lifecycle::reserve_resource(
            &state,
            &session_id,
            crate::state::SessionKind::Ssh,
            owner.clone(),
        )
        .unwrap();

        let params = ConnectParams {
            session_id: session_id.clone(),
            profile: Profile {
                id: "smoke-profile".into(),
                name: "smoke".into(),
                host: "127.0.0.1".into(),
                port,
                credential_id: "smoke-credential".into(),
                bastion_profile_id: None,
                init_command: None,
                group_id: None,
                algorithms: Default::default(),
                sftp_protocol: None,
                sftp_sudo: false,
                sftp_encoding: None,
                icon_source: None,
                icon_color: None,
                totp_auto_submit: true,
                totp_regex: None,
                protocol: "ssh".into(),
                local_shell: None,
                local_shell_args: None,
                local_shell_name: None,
                local_shell_icon: None,
                local_start_dir: None,
                agent_forwarding: false,
                proxy_type: None,
                proxy_host: None,
                proxy_port: None,
                proxy_username: None,
                proxy_no_proxy: None,
                proxy_profile_id: None,
                ssh_input_compatibility: None,
                serial_port: None,
                serial_baud: None,
                serial_data_bits: None,
                serial_parity: None,
                serial_stop_bits: None,
                serial_flow: None,
                serial_local_echo: None,
                serial_line_mode: None,
                serial_backspace: None,
                serial_byte_backspace: None,
                serial_charset: None,
                serial_term_opts: None,
                distro: None,
                host_key_policy: None,
                telnet_username: None,
                telnet_charset: None,
                keyword_highlight_enabled: None,
                keyword_highlight_rules: None,
                auto_session_log: None,
            },
            credential: Credential {
                id: "smoke-credential".into(),
                name: "smoke".into(),
                username: user,
                credential_type: crate::models::CredentialType::Key,
                secret: Some(private_key),
                save_to_remote: false,
            },
            bastion_chain: Vec::new(),
        proxy_configs: Default::default(),
            cols: 80,
            rows: 24,
            app: app.clone(),
            owner,
            auto_log_path: None,
            log_session_id: None,
            prompt_session_id: None,
            known_hosts_path: PathBuf::from(known_hosts_path),
            timeout_secs: 10,
            env_vars: Vec::new(),
        };

        let result = timeout(Duration::from_secs(15), connect(params))
            .await
            .expect("SSH 连接超时")
            .expect("SSH 连接应成功");

        result
            .handle
            .write(b"printf '__SSH_OK__'\n")
            .expect("写 SSH shell 应成功");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let data_event = format!("ssh:data:{session_id}");
        let mut acc = Vec::new();
        let mut ok = false;
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(std::time::Duration::from_millis(200), events.recv()).await
            {
                Ok(Some((event, payload))) if event == data_event => {
                    if let Some(s) = payload.as_str() {
                        let bytes = STANDARD.decode(s).expect("ssh:data 必须是 base64");
                        acc.extend_from_slice(&bytes);
                        if acc
                            .windows(b"__SSH_OK__".len())
                            .any(|w| w == b"__SSH_OK__")
                        {
                            ok = true;
                            break;
                        }
                    }
                }
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(_) => break,
            }
        }

        let text = String::from_utf8_lossy(&acc).to_string();
        assert!(
            ok || text.contains("__SSH_OK__"),
            "未收到 SSH 回显，实际输出: {text}"
        );
    }

    // ── 端到端冒烟辅助（env 注入，无 sshd 时跳过） ──────────────

    /// pubkey sshd 的入参（TERMX_SSH_TEST_*）。缺任一环境变量返回 None。
    fn smoke_pubkey() -> Option<(u16, String, String, String)> {
        let port: u16 = std::env::var("TERMX_SSH_TEST_PORT").ok()?.parse().ok()?;
        let user = std::env::var("TERMX_SSH_TEST_USER").unwrap_or_else(|_| "root".into());
        let key_path = std::env::var("TERMX_SSH_TEST_KEY").ok()?;
        let known_hosts = std::env::var("TERMX_SSH_TEST_KNOWN_HOSTS").ok()?;
        let private_key = std::fs::read_to_string(&key_path).ok()?;
        Some((port, user, private_key, known_hosts))
    }

    /// password + keyboard-interactive sshd 的入参。缺任一环境变量返回 None。
    fn smoke_password() -> Option<(u16, String, String, String)> {
        let port: u16 = std::env::var("TERMX_SSH_TEST_PASSWORD_PORT")
            .ok()?
            .parse()
            .ok()?;
        let user = std::env::var("TERMX_SSH_TEST_USER").unwrap_or_else(|_| "root".into());
        let password = std::env::var("TERMX_SSH_TEST_PASSWORD").ok()?;
        let known_hosts = std::env::var("TERMX_SSH_TEST_KNOWN_HOSTS_PW").ok()?;
        Some((port, user, password, known_hosts))
    }

    /// 用 headless host 走完整 `connect`（含 reserve + 认证 + shell），返回会话柄。
    async fn smoke_connect(
        port: u16,
        credential: Credential,
        known_hosts_path: PathBuf,
    ) -> AppResult<ConnectResult> {
        let (app, _events) = crate::ssh::test_support::headless_host();
        let session_id = uuid::Uuid::new_v4().to_string();
        let owner = crate::state::SessionOwner::Headless(uuid::Uuid::new_v4());
        let state = app.state();
        let _reservation = crate::commands::lifecycle::reserve_resource(
            &state,
            &session_id,
            crate::state::SessionKind::Ssh,
            owner.clone(),
        )
        .unwrap();
        connect(ConnectParams {
            session_id: session_id.clone(),
            profile: Profile {
                id: "smoke-profile".into(),
                name: "smoke".into(),
                host: "127.0.0.1".into(),
                port,
                credential_id: "smoke-credential".into(),
                bastion_profile_id: None,
                init_command: None,
                group_id: None,
                algorithms: Default::default(),
                sftp_protocol: None,
                sftp_sudo: false,
                sftp_encoding: None,
                icon_source: None,
                icon_color: None,
                totp_auto_submit: true,
                totp_regex: None,
                protocol: "ssh".into(),
                local_shell: None,
                local_shell_args: None,
                local_shell_name: None,
                local_shell_icon: None,
                local_start_dir: None,
                agent_forwarding: false,
                proxy_type: None,
                proxy_host: None,
                proxy_port: None,
                proxy_username: None,
                proxy_no_proxy: None,
                proxy_profile_id: None,
                ssh_input_compatibility: None,
                serial_port: None,
                serial_baud: None,
                serial_data_bits: None,
                serial_parity: None,
                serial_stop_bits: None,
                serial_flow: None,
                serial_local_echo: None,
                serial_line_mode: None,
                serial_backspace: None,
                serial_byte_backspace: None,
                serial_charset: None,
                serial_term_opts: None,
                distro: None,
                host_key_policy: None,
                telnet_username: None,
                telnet_charset: None,
                keyword_highlight_enabled: None,
                keyword_highlight_rules: None,
                auto_session_log: None,
            },
            credential,
            bastion_chain: Vec::new(),
        proxy_configs: Default::default(),
            cols: 80,
            rows: 24,
            app: app.clone(),
            owner,
            auto_log_path: None,
            log_session_id: None,
            prompt_session_id: Some(session_id),
            known_hosts_path,
            timeout_secs: 10,
            env_vars: Vec::new(),
        })
        .await
    }

    // ── 三种认证 + exec + SFTP 端到端冒烟 ───────────────────────

    #[tokio::test]
    async fn ssh_password_connect_roundtrip() {
        let Some((port, user, password, known_hosts)) = smoke_password() else {
            eprintln!("skip: TERMX_SSH_TEST_PASSWORD_PORT 未设置");
            return;
        };
        let credential = Credential {
            id: "smoke-pw".into(),
            name: "smoke-pw".into(),
            username: user,
            credential_type: crate::models::CredentialType::Password,
            secret: Some(password),
            save_to_remote: false,
        };
        let result = timeout(
            Duration::from_secs(15),
            smoke_connect(port, credential, PathBuf::from(known_hosts)),
        )
        .await
        .expect("密码认证连接超时")
        .expect("密码认证应成功");
        assert_eq!(result.handle.profile_id(), "smoke-profile");
    }

    #[tokio::test]
    async fn ssh_keyboard_interactive_connect_roundtrip() {
        let Some((port, user, password, known_hosts)) = smoke_password() else {
            eprintln!("skip: TERMX_SSH_TEST_PASSWORD_PORT 未设置");
            return;
        };
        let (app, mut events) = crate::ssh::test_support::headless_host();
        let session_id = uuid::Uuid::new_v4().to_string();
        let owner = crate::state::SessionOwner::Headless(uuid::Uuid::new_v4());
        let state = app.state();
        let _reservation = crate::commands::lifecycle::reserve_resource(
            &state,
            &session_id,
            crate::state::SessionKind::Ssh,
            owner.clone(),
        )
        .unwrap();

        let credential = Credential {
            id: "smoke-kbi".into(),
            name: "smoke-kbi".into(),
            username: user,
            credential_type: crate::models::CredentialType::Interactive,
            secret: None,
            save_to_remote: false,
        };
        let mut connect_task = tokio::spawn(connect(ConnectParams {
            session_id: session_id.clone(),
            profile: Profile {
                id: "smoke-kbi-profile".into(),
                name: "smoke-kbi".into(),
                host: "127.0.0.1".into(),
                port,
                credential_id: "smoke-kbi-credential".into(),
                bastion_profile_id: None,
                init_command: None,
                group_id: None,
                algorithms: Default::default(),
                sftp_protocol: None,
                sftp_sudo: false,
                sftp_encoding: None,
                icon_source: None,
                icon_color: None,
                totp_auto_submit: true,
                totp_regex: None,
                protocol: "ssh".into(),
                local_shell: None,
                local_shell_args: None,
                local_shell_name: None,
                local_shell_icon: None,
                local_start_dir: None,
                agent_forwarding: false,
                proxy_type: None,
                proxy_host: None,
                proxy_port: None,
                proxy_username: None,
                proxy_no_proxy: None,
                proxy_profile_id: None,
                ssh_input_compatibility: None,
                serial_port: None,
                serial_baud: None,
                serial_data_bits: None,
                serial_parity: None,
                serial_stop_bits: None,
                serial_flow: None,
                serial_local_echo: None,
                serial_line_mode: None,
                serial_backspace: None,
                serial_byte_backspace: None,
                serial_charset: None,
                serial_term_opts: None,
                distro: None,
                host_key_policy: None,
                telnet_username: None,
                telnet_charset: None,
                keyword_highlight_enabled: None,
                keyword_highlight_rules: None,
                auto_session_log: None,
            },
            credential,
            bastion_chain: Vec::new(),
        proxy_configs: Default::default(),
            cols: 80,
            rows: 24,
            app: app.clone(),
            owner,
            auto_log_path: None,
            log_session_id: None,
            prompt_session_id: Some(session_id.clone()),
            known_hosts_path: PathBuf::from(known_hosts),
            timeout_secs: 10,
            env_vars: Vec::new(),
        }));

        // 循环回填 password，直到 connect 结束（PAM 可能多轮 InfoRequest）。
        let auth_event = format!("ssh:auth_prompt:{session_id}");
        tokio::time::timeout(
            Duration::from_secs(20),
            async {
                loop {
                    tokio::select! {
                        res = &mut connect_task => return res,
                        ev = events.recv() => {
                            match ev {
                                Some((event, payload)) if event == auth_event => {
                                    let n = payload
                                        .get("prompts")
                                        .and_then(|p| p.as_array())
                                        .map(|a| a.len())
                                        .unwrap_or(1);
                                    let waiter = locked(&state.auth_waiters)
                                        .expect("auth_waiters 锁应可用")
                                        .remove(&session_id)
                                        .expect("auth waiter 应已注册");
                                    let _ = waiter.sender.send(vec![password.clone(); n]);
                                }
                                Some(_) => {}
                                None => panic!("事件通道已关闭，connect 未完成"),
                            }
                        }
                    }
                }
            },
        )
        .await
        .expect("keyboard-interactive 连接超时")
        .expect("join connect task 失败")
        .expect("keyboard-interactive 认证应成功");
    }

    #[tokio::test]
    async fn ssh_exec_once_roundtrip() {
        let Some((port, user, key, known_hosts)) = smoke_pubkey() else {
            eprintln!("skip: TERMX_SSH_TEST_PORT 未设置");
            return;
        };
        let credential = Credential {
            id: "smoke-key".into(),
            name: "smoke-key".into(),
            username: user,
            credential_type: crate::models::CredentialType::Key,
            secret: Some(key),
            save_to_remote: false,
        };
        let result = timeout(
            Duration::from_secs(15),
            smoke_connect(port, credential, PathBuf::from(known_hosts)),
        )
        .await
        .expect("exec 连接超时")
        .expect("exec 连接应成功");

        let ssh = result.handle.ssh_handle().clone();
        let out = run_blocking_ssh(move || async move {
            exec_once(
                &ssh,
                "printf '__EXEC_OK__:%s' \"$(id -u)\"",
                Duration::from_secs(10),
                false,
            )
            .await
        })
        .await
        .expect("exec_once 应成功");

        assert!(
            out.stdout.contains("__EXEC_OK__"),
            "exec stdout 应含标记，实际: {}",
            out.stdout
        );
        assert_eq!(out.exit_code, Some(0), "exec 退出码应为 0");
    }

    #[tokio::test]
    async fn sftp_upload_download_chmod_roundtrip() {
        let Some((port, user, key, known_hosts)) = smoke_pubkey() else {
            eprintln!("skip: TERMX_SSH_TEST_PORT 未设置");
            return;
        };
        let credential = Credential {
            id: "smoke-key".into(),
            name: "smoke-key".into(),
            username: user,
            credential_type: crate::models::CredentialType::Key,
            secret: Some(key),
            save_to_remote: false,
        };
        let result = timeout(
            Duration::from_secs(15),
            smoke_connect(port, credential, PathBuf::from(known_hosts)),
        )
        .await
        .expect("SFTP 连接超时")
        .expect("SFTP 连接应成功");

        let ssh = result.handle.ssh_handle().clone();
        let sftp = crate::ssh::sftp::SftpHandle::from_handle(&ssh, "smoke-sftp".into())
            .await
            .expect("打开 SFTP 子系统应成功");

        let remote = format!("/tmp/termx_sftp_smoke_{}.bin", std::process::id());
        // 确定性 4KB，覆盖全部 256 个字节值，验证不带换行转换、不丢数据。
        let payload: Vec<u8> = (0u8..=255).cycle().take(4096).collect();

        // 走生产的 `upload_streaming`（先 create `.part` 再 rename），
        // 顺便覆盖进度事件链路。headless host 仅用于接收进度 emit。
        let (host, _rx) = crate::ssh::test_support::headless_host();
        let mut reader = &payload[..];
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let written = sftp
            .upload_streaming(
                &mut reader,
                payload.len() as u64,
                &remote,
                &host,
                "smoke-xfer",
                cancel,
            )
            .await
            .expect("SFTP 上传应成功");
        assert_eq!(written, payload.len() as u64);

        sftp.chmod(&remote, 0o640).await.expect("SFTP chmod 应成功");

        let stat = sftp.stat(&remote).await.expect("SFTP stat 应成功");
        let perms = stat.permissions.expect("stat 应返回权限位");
        assert_eq!(
            perms & 0o7777,
            0o640,
            "chmod 0640 后权限位应为 0640，实际 {perms:#o}"
        );

        let downloaded = sftp.download(&remote).await.expect("SFTP 下载应成功");
        assert_eq!(downloaded, payload, "下载字节应与上传一致");

        sftp.remove_file(&remote).await.expect("清理远端临时文件");
    }
}

// ---------------------------------------------------------------------------
// SessionCmd / SessionHandle
// ---------------------------------------------------------------------------

pub enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone)]
pub struct SessionHandle {
    tx: mpsc::UnboundedSender<SessionCmd>,
    ssh_handle: SshHandle,
    /// 本次连接对应的 Profile.id。AI 模块用它作 remote_shell_cache 的 key ——
    /// 同一 profile 多次重连共享一份探测结果，不重发 probe。
    profile_id: String,
    /// 会话级录制槽。session_task 只在此处短暂持锁写一帧，
    /// 命令层（开始 / 停止 / 状态查询）通过同一个 Arc 读写，
    /// 因此不会出现"session_task 独占 recorder、命令拿不到"的分叉。
    recorder_slot: Arc<StdMutex<Option<crate::terminal::recorder::ActiveRecording>>>,
    /// 手动文本会话日志槽（Netcatty `sessionLog`）。与 `recorder_slot` 独立，
    /// 因此 asciicast 自动录制与手动文本日志可同时进行、互不抢占。
    text_log_slot: Arc<StdMutex<Option<crate::terminal::recorder::ActiveTextLog>>>,
}

impl SessionHandle {
    pub fn write(&self, data: &[u8]) -> AppResult<()> {
        self.tx
            .send(SessionCmd::Write(data.to_vec()))
            .map_err(|_| AppError::ssh("ssh_session_closed", json!({})))
    }
    pub fn resize(&self, cols: u32, rows: u32) -> AppResult<()> {
        self.tx
            .send(SessionCmd::Resize { cols, rows })
            .map_err(|_| AppError::ssh("ssh_session_closed", json!({})))
    }
    pub fn ssh_handle(&self) -> &SshHandle {
        &self.ssh_handle
    }
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }
    /// 录制槽的共享句柄（clone 出 Arc，调用方离开 session map 锁后再使用）。
    pub fn recorder_slot(
        &self,
    ) -> Arc<StdMutex<Option<crate::terminal::recorder::ActiveRecording>>> {
        self.recorder_slot.clone()
    }

    /// 手动文本日志槽的共享句柄。
    pub fn text_log_slot(
        &self,
    ) -> Arc<StdMutex<Option<crate::terminal::recorder::ActiveTextLog>>> {
        self.text_log_slot.clone()
    }

    /// 强制断开整条 SSH 连接 —— 不只是 shell channel，连 TCP 一起切。
    ///
    /// 用途：用户关 tab / 关窗口时调用。所有挂在这条 SSH 上的子资源
    /// （SFTP transfer、forward listener 等）会因为底层 socket 被切，
    /// 下一次 read/write 立刻 IO error 退出。
    ///
    /// 跑在 SSH worker 线程里 —— `Handle::disconnect` 走 russh，
    /// 必须在原 runtime 上下文。所以 dispatch 出去。
    pub fn force_disconnect(&self) {
        // 先发 Close 让 session_task 优雅退出 shell channel
        let _ = self.tx.send(SessionCmd::Close);

        let ssh_handle = self.ssh_handle.clone();
        drop(spawn_ssh::<_, _, ()>(move || async move {
            let h = ssh_handle.lock().await;
            // ByApplication = 用户主动断；空 message + 空 lang 是合规的最小 payload
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "").await;
            Ok(())
        }));
    }
}

/// Run one command on an existing SSH connection and collect its output.
///
/// Opens a fresh session channel per call — one-shot, no state kept between
/// calls, so there is nothing to clean up when a plugin stops polling (the
/// "lazy" in the plugin exec capability). The channel is opened under a short
/// handle lock and then driven without it, mirroring `SftpHandle::from_handle`.
pub async fn exec_once(
    ssh_handle: &SshHandle,
    command: &str,
    timeout: std::time::Duration,
    agent_forwarding: bool,
) -> AppResult<crate::models::PluginExecResult> {
    const OUTPUT_CAP: usize = 256 * 1024;

    let mut channel = {
        let h = ssh_handle.lock().await;
        h.channel_open_session().await.map_err(|e| {
            AppError::ssh(
                "plugin_exec_channel_failed",
                json!({ "err": e.to_string() }),
            )
        })?
    };
    // 每次请求：档案开启「转发 Agent」时，exec 会话也要发 auth-agent-req
    // （等价 `ssh -A host cmd`）。不请求的话，sshd 不会给该会话建 agent socket。
    if agent_forwarding {
        let _ = channel.agent_forward(false).await;
    }
    channel
        .exec(true, command)
        .await
        .map_err(|e| AppError::ssh("plugin_exec_failed", json!({ "err": e.to_string() })))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut exit_code: Option<i32> = None;

    let collect = async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    if stdout.len() < OUTPUT_CAP {
                        stdout
                            .extend_from_slice(&data[..data.len().min(OUTPUT_CAP - stdout.len())]);
                    }
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if stderr.len() < OUTPUT_CAP {
                        stderr
                            .extend_from_slice(&data[..data.len().min(OUTPUT_CAP - stderr.len())]);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status as i32);
                }
                // Eof arrives BEFORE ExitStatus — breaking on it would lose
                // the exit code. Only Close (or a dropped channel) ends it.
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(timeout, collect).await.map_err(|_| {
        AppError::ssh(
            "plugin_exec_timeout",
            json!({ "millis": timeout.as_millis() as u64 }),
        )
    })?;

    Ok(crate::models::PluginExecResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
    })
}

// ---------------------------------------------------------------------------
// connect — 支持可选堡垒机（ProxyJump）
// ---------------------------------------------------------------------------

pub struct ConnectResult {
    pub session_id: String,
    pub handle: SessionHandle,
    /// 握手阶段截获的服务端 SSH identification string（`SSH-2.0-...`）。
    /// 拿不到时为 None，发行版探测会跳过 banner 分支。
    pub server_banner: Option<String>,
}

/// Complete policy and ownership context for one interactive SSH connection.
/// Keeping it as one value prevents the GUI and headless adapters from
/// accidentally swapping one of the several identities or path arguments.
pub struct ConnectParams {
    pub session_id: String,
    pub profile: Profile,
    pub credential: Credential,
    pub bastion_chain: Vec<(Profile, Credential)>,
    /// profile_id → 已解析密码的连接代理；堡垒跳 / 目标各自查表。
    pub proxy_configs: std::collections::HashMap<String, crate::ssh::proxy::ProxyConfig>,
    pub cols: u32,
    pub rows: u32,
    pub app: crate::emitter::Host,
    pub owner: crate::state::SessionOwner,
    /// 主机档案开启自动日志时传入的 `.log` 路径；`None` = 不自动记录。
    pub auto_log_path: Option<std::path::PathBuf>,
    pub log_session_id: Option<String>,
    pub prompt_session_id: Option<String>,
    pub known_hosts_path: PathBuf,
    pub timeout_secs: u64,
    /// 主机级环境变量；在打开 shell 前按 SSH `SetEnv` 发送。
    pub env_vars: Vec<crate::db::profile_env::EnvVar>,
}

/// All inputs are owned, so the returned future carries no caller borrows and
/// remains Send across both the Tauri and headless adapters.
pub async fn connect(params: ConnectParams) -> AppResult<ConnectResult> {
    let ConnectParams {
        session_id,
        profile,
        credential,
        bastion_chain,
        proxy_configs,
        cols,
        rows,
        app,
        owner,
        auto_log_path,
        log_session_id,
        prompt_session_id,
        known_hosts_path,
        timeout_secs,
        env_vars,
    } = params;
    let log: LogFn = match log_session_id.clone() {
        Some(sid) => {
            let app2 = app.clone();
            Arc::new(move |msg: String| {
                let line = format!("\x1b[90m[ssh] {msg}\x1b[0m\r\n");
                let _ = app2.emit_bytes(&format!("ssh:data:{sid}"), line.as_bytes());
            })
        }
        None => null_logger(),
    };

    // 终端可达性上下文：只要有本次连接 attempt 的 prompt_id 就能弹提示。
    // 即使 verbose log 关闭、`log` 是 null_logger，passphrase 提示仍然能发。
    let ctx = prompt_session_id.clone().map(|prompt_id| AuthCtx {
        app: app.clone(),
        resource_id: session_id.clone(),
        prompt_id,
        owner: owner.clone(),
        totp: crate::totp::config_from_store(&app.state(), &profile),
    });

    let target_label = profile_label(&profile);
    let total_hops = (bastion_chain.len() + 1) as u32;
    let progress = ProgressEmitter::root(app.clone(), session_id.clone(), target_label.clone());
    let target_progress = progress.hop(total_hops, total_hops, target_label);

    // 握手期截获服务端 banner（仅目标跳；堡垒跳不设置），供发行版探测使用。
    let banner_sink = crate::ssh::distro::new_banner_sink();

    let (mut handle, _fwd) = establish_via_chain(
        bastion_chain,
        profile.clone(),
        proxy_configs,
        known_hosts_path,
        timeout_secs,
        log.clone(),
        ctx.as_ref(),
        Some(&progress),
        Some(banner_sink.clone()),
    )
    .await?;

    log(format!(
        "Authenticating as {} ({}) ...",
        credential.username,
        credential.credential_type.as_str()
    ));
    target_progress.emit("authenticating", None);
    authenticate(&mut handle, credential, ctx.as_ref()).await?;
    target_progress.emit("authenticated", None);
    log("Authenticated.".to_owned());

    // Open the shell channel BEFORE wrapping the handle in Arc<Mutex>.
    // Holding a MutexGuard across `.await` would force the resulting future
    // to hold `&Mutex<Handle>` for the inner await — fine for runtime, but
    // the compiler can't always prove that's `for<'a> Send`. Doing the
    // shell setup directly on the owned handle sidesteps the whole issue.
    target_progress.emit("shell", None);
    log("Requesting PTY + shell ...".to_owned());
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::ssh("ssh_open_channel_failed", json!({ "err": e.to_string() })))?;

    // 档案开启「转发 Agent」→ 向服务端请求 auth-agent-req@openssh.com。
    // want_reply=false（与 OpenSSH -A 一致）；服务端随后开 agent 通道时由
    // SshHandler::server_channel_open_agent_forward 桥到本机 agent。
    if profile.agent_forwarding {
        match channel.agent_forward(false).await {
            Ok(()) => log("Agent forwarding requested.".to_owned()),
            Err(e) => log(format!("Agent forwarding request failed: {e}")),
        }
    }

    // 主机级环境变量：SetEnv 必须在 shell 请求之前发。OpenSSH 默认只放行
    // AcceptEnv 白名单（通常是 LANG/LC_*），其余变量会被服务端静默丢弃；
    // 这里只负责发送，是否生效取决于远端 sshd 配置。
    for env in &env_vars {
        if env.name.trim().is_empty() {
            continue;
        }
        if let Err(err) = channel
            .set_env(false, env.name.clone(), env.value.clone())
            .await
        {
            log(format!("SetEnv {} failed: {err}", env.name));
        }
    }

    channel
        .request_pty(false, &terminal_emulation_type(), cols, rows, 0, 0, &[])
        .await
        .map_err(|e| AppError::ssh("ssh_pty_request_failed", json!({ "err": e.to_string() })))?;

    channel
        .request_shell(false)
        .await
        .map_err(|e| AppError::ssh("ssh_shell_request_failed", json!({ "err": e.to_string() })))?;

    log("Shell ready.\r\n".to_owned());
    target_progress.emit("connected", None);

    // Now wrap for downstream multiplexing (SFTP / forwarding share the conn).
    let ssh_handle: SshHandle = Arc::new(tokio::sync::Mutex::new(handle));

    let (tx, rx) = mpsc::unbounded_channel();

    // 录制槽：手动 asciicast 录制由命令层通过 handle.recorder_slot() 读写，
    // session_task 只负责把输出字节写进当前槽里的 recorder。
    // 自动记录改为纯文本 `.log`（去 ANSI），走独立的文本日志槽。
    let recorder_slot: Arc<StdMutex<Option<crate::terminal::recorder::ActiveRecording>>> =
        Arc::new(StdMutex::new(None));
    let text_log_slot: Arc<StdMutex<Option<crate::terminal::recorder::ActiveTextLog>>> =
        Arc::new(StdMutex::new(None));
    if let Some(path) = auto_log_path {
        // 记录是 best-effort：建文件失败不能阻断连接。
        if let Ok(active) = crate::terminal::recorder::ActiveTextLog::new(
            path,
            crate::terminal::recorder::TextLogFormat::Text,
            false,
        ) {
            if let Ok(mut guard) = text_log_slot.lock() {
                *guard = Some(active);
            }
        }
    }

    let data_event = format!("ssh:data:{session_id}");
    let close_event = format!("ssh:close:{session_id}");
    let task_slot = recorder_slot.clone();
    let task_text_log_slot = text_log_slot.clone();
    tauri::async_runtime::spawn(async move {
        session_task(
            data_event,
            close_event,
            channel,
            rx,
            app,
            task_slot,
            task_text_log_slot,
        )
        .await;
    });

    Ok(ConnectResult {
        session_id,
        handle: SessionHandle {
            tx,
            ssh_handle,
            profile_id: profile.id.clone(),
            recorder_slot,
            text_log_slot,
        },
        // 握手已完成：banner 一定已经读到（或明确截获失败）。
        server_banner: banner_sink.lock().ok().and_then(|slot| slot.clone()),
    })
}

// ---------------------------------------------------------------------------
// session_task
// ---------------------------------------------------------------------------

enum Event {
    Ssh(Option<ChannelMsg>),
    Cmd(Option<SessionCmd>),
}

/// russh 的 `Sig` 没有公开 `name()`，这里把信号枚举还原成短名（如 "TERM"），供 close 事件上报。
fn ssh_signal_name(sig: &russh::Sig) -> String {
    match sig {
        russh::Sig::ABRT => "ABRT".into(),
        russh::Sig::ALRM => "ALRM".into(),
        russh::Sig::FPE => "FPE".into(),
        russh::Sig::HUP => "HUP".into(),
        russh::Sig::ILL => "ILL".into(),
        russh::Sig::INT => "INT".into(),
        russh::Sig::KILL => "KILL".into(),
        russh::Sig::PIPE => "PIPE".into(),
        russh::Sig::QUIT => "QUIT".into(),
        russh::Sig::SEGV => "SEGV".into(),
        russh::Sig::TERM => "TERM".into(),
        russh::Sig::USR1 => "USR1".into(),
        russh::Sig::Custom(s) => s.clone(),
    }
}

async fn session_task(
    data_event: String,
    close_event: String,
    mut channel: russh::Channel<client::Msg>,
    mut rx: mpsc::UnboundedReceiver<SessionCmd>,
    app: crate::emitter::Host,
    recorder_slot: Arc<StdMutex<Option<crate::terminal::recorder::ActiveRecording>>>,
    text_log_slot: Arc<StdMutex<Option<crate::terminal::recorder::ActiveTextLog>>>,
) {
    /// 写一帧到当前录制槽；持锁范围只覆盖 `record`（同步 IO 缓冲写），
    /// 绝不跨 await，避免与命令层的 start/stop 互锁。
    fn record_output(
        slot: &StdMutex<Option<crate::terminal::recorder::ActiveRecording>>,
        data: &[u8],
    ) {
        if let Ok(mut guard) = slot.lock() {
            if let Some(active) = guard.as_mut() {
                let _ = active.recorder.record(data);
            }
        }
    }

    /// 手动文本日志与 asciicast 录制并行写，互不影响。
    fn record_text_log(
        slot: &StdMutex<Option<crate::terminal::recorder::ActiveTextLog>>,
        data: &[u8],
    ) {
        if let Ok(mut guard) = slot.lock() {
            if let Some(active) = guard.as_mut() {
                let _ = active.recorder.record(data);
            }
        }
    }

    let mut exit_code: Option<i32> = None;
    let mut signal: Option<String> = None;
    loop {
        let event = tokio::select! {
            msg = channel.wait() => Event::Ssh(msg),
            cmd = rx.recv() => Event::Cmd(cmd),
        };

        match event {
            Event::Ssh(Some(ChannelMsg::Data { data })) => {
                record_output(&recorder_slot, &data);
                record_text_log(&text_log_slot, &data);
                let _ = app.emit_bytes(&data_event, &data);
            }
            Event::Ssh(Some(ChannelMsg::ExtendedData { data, .. })) => {
                record_output(&recorder_slot, &data);
                record_text_log(&text_log_slot, &data);
                let _ = app.emit_bytes(&data_event, &data);
            }
            Event::Ssh(Some(ChannelMsg::ExitStatus { exit_status })) => {
                exit_code = Some(exit_status as i32);
            }
            Event::Ssh(Some(ChannelMsg::ExitSignal { signal_name, .. })) => {
                signal = Some(ssh_signal_name(&signal_name));
            }
            // Eof 只是远端半关闭输出，其后还会收到 ExitStatus / Close，
            // 不能在此 break，否则会丢掉退出码。
            Event::Ssh(Some(ChannelMsg::Eof)) => {}
            Event::Ssh(Some(ChannelMsg::Close)) | Event::Ssh(None) => {
                break;
            }
            Event::Cmd(Some(SessionCmd::Write(data))) => {
                let _ = channel.data(std::io::Cursor::new(data)).await;
            }
            Event::Cmd(Some(SessionCmd::Resize { cols, rows })) => {
                let _ = channel.window_change(cols, rows, 0, 0).await;
            }
            Event::Cmd(Some(SessionCmd::Close)) | Event::Cmd(None) => {
                let _ = channel.close().await;
                break;
            }
            _ => {}
        }
    }
    // 会话结束：取走并关闭录制器（无论是自动录制还是手动录制），
    // 之后命令层的 status 查询自然会看到 None。
    if let Ok(mut guard) = recorder_slot.lock() {
        if let Some(active) = guard.take() {
            let _ = active.recorder.finish();
        }
    }
    if let Ok(mut guard) = text_log_slot.lock() {
        if let Some(active) = guard.take() {
            let _ = active.recorder.finish();
        }
    }
    let _ = app.emit(
        &close_event,
        crate::models::CloseInfo { exit_code, signal },
    );
}
