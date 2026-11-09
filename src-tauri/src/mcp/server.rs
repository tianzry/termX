//! 对外 MCP 宿主：进程内 Streamable HTTP（JSON 响应）server。
//!
//! Netcatty 的链路是 Electron 主进程 TCP bridge + `netcatty-external-mcp-server.cjs`
//! stdio launcher + 可选 HTTP。termX 是单进程 Tauri，本阶段只做 **HTTP 传输**：
//! 外部客户端（Claude Code / Codex / Cursor）用 `http://host:port/mcp` + Bearer token
//! 直连，不需要再分发一个 Node launcher。stdio 传输在方案文档里列为未实现。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

use crate::state::AppState;
use super::approval::{self, ApprovalRegistry, ApprovalRequestPayload, TakenApproval};
use super::config::{self, McpClient, McpConfig};
use super::runtime_state;
use super::tools;

const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const SUPPORTED_PROTOCOL: &str = "2025-06-18";

struct Inner {
    config: McpConfig,
    token: Option<String>,
    bound_port: Option<u16>,
    listening: bool,
    error: Option<(String, String)>,
    shutdown: Option<Arc<Notify>>,
}

impl Inner {
    fn new() -> Self {
        Self {
            config: McpConfig::default(),
            token: None,
            bound_port: None,
            listening: false,
            error: None,
            shutdown: None,
        }
    }
}

pub struct McpRuntime {
    inner: Mutex<Inner>,
    generation: AtomicU64,
    approvals: ApprovalRegistry,
}

pub struct McpState(pub Arc<McpRuntime>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub url: Option<String>,
    pub bearer_token: Option<String>,
    pub permission_mode: String,
    pub error: Option<String>,
    pub error_code: Option<String>,
    pub allow_custom_bind: bool,
    pub listen_address: String,
    pub client_host: String,
    pub tool_count: usize,
    /// confirm 档位下的放行规则（持久化在设置 KV，形状见 `mcp::grants`）。
    pub grants: Vec<super::grants::PermissionGrant>,
}

impl McpRuntime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::new()),
            generation: AtomicU64::new(0),
            approvals: ApprovalRegistry::new(),
        })
    }

    pub fn approvals(&self) -> &ApprovalRegistry {
        &self.approvals
    }

    pub fn pending_approvals(&self) -> Vec<ApprovalRequestPayload> {
        self.approvals.pending_list()
    }

    /// 取走一个待审批项（UI 结算用）。已超时 / 已结算则返回 `None`。
    pub fn take_approval(&self, approval_id: &str) -> Option<TakenApproval> {
        self.approvals.take(approval_id)
    }

    /// 写操作审批：confirm 档位下挂起等待 UI 决策。
    ///
    /// 返回 `true` 表示允许执行；拒绝 / 超时 / 连接断开 / 服务重启均返回 `false`。
    #[allow(clippy::too_many_arguments)]
    pub async fn request_approval(
        self: &Arc<Self>,
        app: &AppHandle,
        gen: u64,
        tool: &str,
        args_summary: String,
        args: Value,
        session_id: Option<String>,
        target_label: Option<String>,
        disconnected: Arc<AtomicBool>,
    ) -> bool {
        // 先看许可记忆表：命中的同类操作直接放行，不再弹审批。
        if self.approvals.match_grant(tool, &args).is_some() {
            return true;
        }
        if !self.is_current(gen) {
            return false;
        }
        // 主窗不存在时没有审批通路，直接拒绝（对齐 Netcatty 无 renderer 即拒绝）。
        if app.get_webview_window("main").is_none() {
            return false;
        }
        let (payload, mut rx) =
            self.approvals
                .register(tool, args_summary, session_id, target_label, args);
        let approval_id = payload.approval_id.clone();
        approval::emit_request(app, &payload);
        approval::sync_attention(app, self.approvals.pending_count());

        let deadline = Instant::now() + Duration::from_millis(approval::APPROVAL_TIMEOUT_MS);
        loop {
            tokio::select! {
                biased;
                resolved = &mut rx => {
                    return resolved.unwrap_or(false);
                }
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    let reason = if !self.is_current(gen) {
                        Some("restarted")
                    } else if disconnected.load(Ordering::SeqCst) {
                        Some("client_disconnected")
                    } else if Instant::now() >= deadline {
                        Some("timeout")
                    } else {
                        None
                    };
                    let Some(reason) = reason else { continue };
                    // 已被 UI 结算时 `deny` 返回 false，继续等 receiver 的最终值。
                    if self.approvals.deny(&approval_id) {
                        approval::emit_cleared(app, &[approval_id.clone()], reason);
                        approval::sync_attention(app, self.approvals.pending_count());
                        return false;
                    }
                }
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn config(&self) -> McpConfig {
        self.lock().config.clone()
    }

    pub fn status(&self) -> McpStatus {
        let inner = self.lock();
        let cfg = &inner.config;
        let running = inner.listening;
        let port = inner.bound_port.unwrap_or(cfg.port);
        let url = if running {
            Some(format!(
                "http://{}:{}/mcp",
                cfg.effective_client_host(),
                port
            ))
        } else {
            None
        };
        McpStatus {
            enabled: cfg.enabled,
            running,
            port,
            url,
            bearer_token: inner.token.clone(),
            permission_mode: cfg.permission_mode.as_str().to_string(),
            error: inner.error.as_ref().map(|(_, m)| m.clone()),
            error_code: inner.error.as_ref().map(|(c, _)| c.clone()),
            allow_custom_bind: cfg.allow_custom_bind,
            listen_address: cfg.listen_address.clone(),
            client_host: cfg.client_host.clone(),
            tool_count: tools::definitions().as_array().map(|a| a.len()).unwrap_or(0),
            grants: self.approvals.grants(),
        }
    }

    fn set_error(&self, code: &str, message: impl Into<String>) {
        let mut inner = self.lock();
        inner.listening = false;
        inner.bound_port = None;
        inner.error = Some((code.to_string(), message.into()));
    }

    /// 原地更新配置：权限档 / client_host 等纯设置项使用。
    ///
    /// 不重启监听、不换 token，已连接客户端与 Qoder/Claude 里配置的 token 继续有效。
    pub fn set_config(&self, cfg: McpConfig) {
        let mut inner = self.lock();
        inner.config = cfg;
    }

    /// 启动。已运行实例先停（generation++ 让旧 accept 循环退出）。
    pub fn start(self: &Arc<Self>, app: AppHandle, cfg: McpConfig) -> Result<(), (String, String)> {
        config::validate(&cfg)?;
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        // 重启后许可记忆表仍然生效；旧挂起项一律拒绝，避免悬空等待。
        {
            let state = app.state::<AppState>();
            self.approvals.set_grants(super::grants::load(&state.db));
        }
        // token 只在手动轮换时更换：内存中的 token 优先，其次用持久化的，最后才新生成。
        let token = {
            let current = self.lock().token.clone();
            let stored = current.or_else(|| {
                let state = app.state::<AppState>();
                config::load_token(&state.db)
            });
            stored.unwrap_or_else(|| {
                let token = new_token();
                let state = app.state::<AppState>();
                let _ = config::save_token(&state.db, &token);
                token
            })
        };
        let cleared = self.approvals.deny_all();
        let cleared_ids: Vec<String> = cleared
            .into_iter()
            .map(|p| p.approval_id)
            .collect();
        approval::emit_cleared(&app, &cleared_ids, "restarted");
        approval::sync_attention(&app, 0);
        let shutdown = Arc::new(Notify::new());
        {
            let mut inner = self.lock();
            if let Some(old) = inner.shutdown.take() {
                old.notify_waiters();
            }
            inner.config = cfg;
            inner.token = Some(token);
            inner.listening = false;
            inner.bound_port = None;
            inner.error = None;
            inner.shutdown = Some(shutdown.clone());
        }
        let rt = self.clone();
        tauri::async_runtime::spawn(async move {
            rt.run(app, gen, shutdown).await;
        });
        Ok(())
    }

    pub fn stop(&self, app: Option<&AppHandle>) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let cleared = self.approvals.deny_all();
        let cleared_ids: Vec<String> = cleared
            .into_iter()
            .map(|p| p.approval_id)
            .collect();
        if let Some(app) = app {
            approval::emit_cleared(app, &cleared_ids, "stopped");
            approval::sync_attention(app, 0);
        }
        let mut inner = self.lock();
        if let Some(n) = inner.shutdown.take() {
            n.notify_waiters();
        }
        inner.listening = false;
        inner.bound_port = None;
        inner.error = None;
        // token 不清空：关闭再启用沿用同一个 token，只有手动轮换才会更换。
    }

    pub fn rotate_token(&self, app: &AppHandle) -> Option<String> {
        let mut inner = self.lock();
        if !inner.listening {
            return None;
        }
        let token = new_token();
        let state = app.state::<AppState>();
        let _ = config::save_token(&state.db, &token);
        inner.token = Some(token.clone());
        Some(token)
    }

    fn is_current(&self, gen: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == gen
    }

    async fn run(self: Arc<Self>, app: AppHandle, gen: u64, shutdown: Arc<Notify>) {
        let (addr, port) = {
            let inner = self.lock();
            (inner.config.listen_address.clone(), inner.config.port)
        };
        let listener = match TcpListener::bind((addr.as_str(), port)).await {
            Ok(l) => l,
            Err(e) => {
                if self.is_current(gen) {
                    let code = match e.kind() {
                        std::io::ErrorKind::AddrInUse => "port_in_use",
                        std::io::ErrorKind::AddrNotAvailable => "invalid_address",
                        _ => "listen_failed",
                    };
                    self.set_error(code, format!("监听 {addr}:{port} 失败: {e}"));
                }
                return;
            }
        };
        if !self.is_current(gen) {
            return;
        }
        let bound = listener.local_addr().ok().map(|a| a.port()).unwrap_or(port);
        {
            let mut inner = self.lock();
            inner.listening = true;
            inner.bound_port = Some(bound);
            inner.error = None;
        }

        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((socket, _)) => {
                            if !self.is_current(gen) { break; }
                            let app2 = app.clone();
                            let rt2 = self.clone();
                            tokio::spawn(async move {
                                let _ = serve_connection(app2, rt2, gen, socket).await;
                            });
                        }
                        Err(e) => {
                            log::warn!("mcp accept failed: {e}");
                        }
                    }
                }
            }
        }

        if self.is_current(gen) {
            let mut inner = self.lock();
            inner.listening = false;
        }
    }
}

fn new_token() -> String {
    // 两段 UUIDv4 拼接 = 244 位随机，避免为 token 引入额外 RNG 依赖。
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn parse_request(raw: &[u8]) -> Option<HttpRequest> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let body = raw[split + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_ascii_uppercase();
    let path = first.next()?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    Some(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn header_ok(req: &HttpRequest, cfg: &McpConfig) -> Result<(), (u16, String)> {
    let allowed = config::allowed_hosts(cfg);
    if let Some(host) = req.headers.get("host") {
        let bare = host.split(':').next().unwrap_or(host);
        if !allowed.iter().any(|a| a == bare) {
            return Err((403, "forbidden_host".to_string()));
        }
    }
    if let Some(origin) = req.headers.get("origin") {
        let ok = allowed.iter().any(|a| {
            origin.as_str() == format!("http://{a}")
                || origin.as_str() == format!("https://{a}")
                || origin.as_str() == format!("http://{a}:{}", cfg.port)
        });
        if !ok {
            return Err((403, "forbidden_origin".to_string()));
        }
    }
    Ok(())
}

#[cfg(test)]
fn auth_ok(req: &HttpRequest, token: Option<&str>) -> bool {
    let Some(expected) = token else {
        return false;
    };
    bearer_token(req)
        .map(|bearer| token_eq(&bearer, expected))
        .unwrap_or(false)
}

fn bearer_token(req: &HttpRequest) -> Option<String> {
    let raw = req.headers.get("authorization")?;
    raw.strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(|v| v.trim().to_string())
}

/// 定长比较，避免时序侧信道。
fn token_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 认证并解析出请求身份：单 Bearer token → 默认客户端（沿用全局权限档）。
fn authenticate(
    req: &HttpRequest,
    legacy_token: Option<&str>,
    cfg: &McpConfig,
) -> Option<McpClient> {
    let bearer = bearer_token(req)?;
    let legacy = legacy_token?;
    if token_eq(&bearer, legacy) {
        Some(config::default_client(cfg.permission_mode))
    } else {
        None
    }
}

/// MCP 会话表：`Mcp-Session-Id` → 建立时间。
///
/// 单 token 无法再靠 token 区分 agent，改用协议层会话 id：initialize 时下发，
/// 后续请求带回；不同会话自动建连的会话互不可见。不带会话头的调用回落到
/// 共享的 default 身份（兼容无状态客户端）。
static MCP_SESSIONS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

const MAX_SESSIONS: usize = 1024;

fn sessions() -> &'static Mutex<HashMap<String, Instant>> {
    MCP_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_session() -> String {
    let id = format!("mcp-{}", uuid::Uuid::new_v4().simple());
    let mut map = sessions().lock().unwrap_or_else(|e| e.into_inner());
    if map.len() >= MAX_SESSIONS {
        // 淘汰最老会话并回收 owner；其自动建连的会话随后不再对外可见。
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, created)| **created)
            .map(|(id, _)| id.clone())
        {
            map.remove(&oldest);
            runtime_state::forget_client_owner(&oldest);
        }
    }
    map.insert(id.clone(), Instant::now());
    id
}

fn session_known(id: &str) -> bool {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(id)
}

fn end_session(id: &str) {
    let removed = sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id)
        .is_some();
    if removed {
        runtime_state::forget_client_owner(id);
    }
}

fn is_initialize(item: &Value) -> bool {
    item.get("method").and_then(Value::as_str) == Some("initialize")
}

/// 不发 `Mcp-Session-Id` 的无状态客户端：按 User-Agent 区分 agent，
/// 至少保证不同客户端不串会话；同一 agent 的多个实例仍共享一个身份。
fn user_agent_client(req: &HttpRequest, cfg: &McpConfig) -> Option<McpClient> {
    let ua = req.headers.get("user-agent")?.trim();
    if ua.is_empty() {
        return None;
    }
    let short: String = ua.chars().take(120).collect();
    Some(config::session_client(format!("ua-{short}"), cfg.permission_mode))
}

async fn read_request(socket: &mut TcpStream) -> Result<HttpRequest, (u16, String)> {
    let mut buf: Vec<u8> = Vec::new();
    let mut header_done = false;
    loop {
        let mut chunk = [0u8; 1024];
        let n = socket
            .read(&mut chunk)
            .await
            .map_err(|e| (400, format!("read_failed: {e}")))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            header_done = true;
            break;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err((431, "headers_too_large".to_string()));
        }
    }
    if !header_done {
        return Err((400, "incomplete_request".to_string()));
    }
    let mut req = parse_request(&buf).ok_or((400, "malformed_request".to_string()))?;
    let want = req
        .headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if want > MAX_BODY_BYTES {
        return Err((413, "body_too_large".to_string()));
    }
    while req.body.len() < want {
        let mut chunk = [0u8; 4096];
        let n = socket
            .read(&mut chunk)
            .await
            .map_err(|e| (400, format!("read_failed: {e}")))?;
        if n == 0 {
            break;
        }
        req.body.extend_from_slice(&chunk[..n]);
    }
    if req.body.len() > MAX_BODY_BYTES {
        return Err((413, "body_too_large".to_string()));
    }
    Ok(req)
}

async fn respond<W>(
    socket: &mut W,
    status: u16,
    content_type: &str,
    body: &str,
    extra: &[(&str, &str)],
) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(body.as_bytes()).await?;
    socket.flush().await?;
    Ok(())
}

async fn serve_connection(
    app: AppHandle,
    rt: Arc<McpRuntime>,
    gen: u64,
    mut socket: TcpStream,
) -> std::io::Result<()> {
    let req = match read_request(&mut socket).await {
        Ok(r) => r,
        Err((status, msg)) => {
            return respond(&mut socket, status, "application/json", &json!({ "error": msg }).to_string(), &[]).await;
        }
    };
    if !rt.is_current(gen) {
        return respond(&mut socket, 503, "application/json", "{\"error\":\"mcp_restarted\"}", &[]).await;
    }
    let (cfg, token, running) = {
        let inner = rt.lock();
        (inner.config.clone(), inner.token.clone(), inner.listening)
    };
    if !running {
        return respond(&mut socket, 503, "application/json", "{\"error\":\"mcp_disabled\"}", &[]).await;
    }
    if let Err((status, msg)) = header_ok(&req, &cfg) {
        return respond(&mut socket, status, "application/json", &json!({ "error": msg }).to_string(), &[]).await;
    }
    if req.method != "POST" {
        if req.method == "GET" {
            return respond(
                &mut socket,
                405,
                "application/json",
                "{\"error\":\"sse_not_supported\"}",
                &[("Allow", "POST, DELETE")],
            )
            .await;
        }
        if req.method == "DELETE" {
            if authenticate(&req, token.as_deref(), &cfg).is_none() {
                return respond(&mut socket, 401, "application/json", "{\"error\":\"unauthorized\"}", &[("WWW-Authenticate", "Bearer")]).await;
            }
            if let Some(session_id) = req.headers.get("mcp-session-id") {
                if !session_known(session_id) {
                    return respond(&mut socket, 404, "application/json", "{\"error\":\"session_not_found\"}", &[]).await;
                }
                end_session(session_id);
            }
            return respond(&mut socket, 200, "application/json", "{}", &[]).await;
        }
        return respond(&mut socket, 404, "application/json", "{\"error\":\"not_found\"}", &[]).await;
    }
    if req.path != "/mcp" && req.path != "/mcp/" {
        return respond(&mut socket, 404, "application/json", "{\"error\":\"not_found\"}", &[]).await;
    }
    if authenticate(&req, token.as_deref(), &cfg).is_none() {
        return respond(&mut socket, 401, "application/json", "{\"error\":\"unauthorized\"}", &[("WWW-Authenticate", "Bearer")]).await;
    }
    let parsed: Result<Value, _> = serde_json::from_slice(&req.body);
    let Ok(payload) = parsed else {
        return respond(&mut socket, 400, "application/json", "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"parse_error\"}}", &[]).await;
    };

    // 单 token 下按 MCP 会话区分 agent：initialize 新建会话并下发 Mcp-Session-Id，
    // 后续请求带回已知 id；未知 id 回 404，让客户端重新 initialize。
    let wants_new_session = payload
        .as_array()
        .map(|items| items.iter().any(is_initialize))
        .unwrap_or_else(|| is_initialize(&payload));
    let (client, issued_session) = if wants_new_session {
        let session_id = register_session();
        (
            config::session_client(&session_id, cfg.permission_mode),
            Some(session_id),
        )
    } else if let Some(session_id) = req.headers.get("mcp-session-id") {
        if !session_known(session_id) {
            return respond(&mut socket, 404, "application/json", "{\"error\":\"session_not_found\"}", &[]).await;
        }
        (
            config::session_client(session_id.clone(), cfg.permission_mode),
            None,
        )
    } else if let Some(client) = user_agent_client(&req, &cfg) {
        (client, None)
    } else {
        (config::default_client(cfg.permission_mode), None)
    };

    // 拆分读写半连接：审批等待期间由后台任务监听客户端断开（EOF / 读错误）。
    let (mut read_half, mut write_half) = socket.into_split();
    let disconnected = Arc::new(AtomicBool::new(false));
    {
        let flag = disconnected.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            loop {
                match read_half.read(&mut buf).await {
                    Ok(0) => {
                        flag.store(true, Ordering::SeqCst);
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        });
    }

    let (body, status) = if payload.is_array() {
        let mut out = Vec::new();
        let mut only_notifications = true;
        for item in payload.as_array().cloned().unwrap_or_default() {
            if let Some(resp) = dispatch(&app, &rt, gen, &item, &disconnected, &client).await {
                only_notifications = false;
                out.push(resp);
            }
        }
        if only_notifications {
            (String::new(), 202)
        } else {
            (Value::Array(out).to_string(), 200)
        }
    } else {
        match dispatch(&app, &rt, gen, &payload, &disconnected, &client).await {
            Some(resp) => (resp.to_string(), 200),
            None => (String::new(), 202),
        }
    };
    let mut extra: Vec<(&str, &str)> = Vec::new();
    if let Some(session_id) = issued_session.as_deref() {
        extra.push(("Mcp-Session-Id", session_id));
    }
    respond(&mut write_half, status, "application/json", &body, &extra).await
}

async fn dispatch(
    app: &AppHandle,
    rt: &Arc<McpRuntime>,
    gen: u64,
    req: &Value,
    disconnected: &Arc<AtomicBool>,
    client: &McpClient,
) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    // 通知（无 id）一律不回包，HTTP 层返回 202。
    if id.is_none() {
        return None;
    }
    let id = id.unwrap();
    if !rt.is_current(gen) {
        return Some(json!({ "jsonrpc": "2.0", "id": id,
            "error": { "code": -32000, "message": "mcp_restarted" } }));
    }
    let state = app.state::<AppState>();

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(SUPPORTED_PROTOCOL);
            Ok(json!({
                "protocolVersion": requested,
                "capabilities": {
                    "tools": { "listChanged": false },
                    "resources": { "subscribe": false, "listChanged": false }
                },
                "serverInfo": { "name": "termX", "version": env!("CARGO_PKG_VERSION") },
                "instructions": super::guide::INSTRUCTIONS
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::definitions() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let out = tools::call_tool(
                &state,
                client,
                rt,
                app,
                gen,
                disconnected.clone(),
                name,
                &args,
            )
            .await;
            Ok(json!({
                "content": [{ "type": "text", "text": out.text }],
                "isError": out.is_error
            }))
        }
        "resources/list" => Ok(json!({ "resources": tools::resources() })),
        "resources/read" => {
            let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
            let out = tools::read_resource(&state, client, uri);
            if out.is_error {
                Err((-32602, out.text))
            } else {
                Ok(json!({
                    "contents": [{ "uri": uri, "mimeType": "application/json", "text": out.text }]
                }))
            }
        }
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "logging/setLevel" => Ok(json!({})),
        _ => Err((-32601, format!("method_not_found: {method}"))),
    };
    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id,
            "error": { "code": code, "message": message } }),
    })
}

/// 生成对外客户端连接片段（对齐 Netcatty `domain/externalMcpHttp.ts` 的四种形态）。
pub fn client_snippet(status: &McpStatus, kind: &str) -> String {
    let Some(url) = status.url.as_deref() else {
        return String::new();
    };
    let token = status.bearer_token.clone().unwrap_or_default();
    match kind {
        "codex" => format!(
            "[mcp_servers.termx]\nurl = \"{url}\"\nbearer_token_env_var = \"TERMX_MCP_TOKEN\"\n"
        ),
        "claude" => format!(
            "claude mcp add --transport http termx {url} --header \"Authorization: Bearer {token}\""
        ),
        "env" => format!("export TERMX_MCP_URL={url}\nexport TERMX_MCP_TOKEN={token}\n"),
        _ => json!({
            "mcpServers": {
                "termx": {
                    "type": "http",
                    "url": url,
                    "headers": { "Authorization": format!("Bearer {token}") }
                }
            }
        })
        .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_request() {
        let raw = b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:47391\r\nAuthorization: Bearer abc\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let req = parse_request(raw).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/mcp");
        assert_eq!(req.body, b"{}");
        assert_eq!(req.headers.get("host").unwrap(), "127.0.0.1:47391");
    }

    #[test]
    fn auth_is_constant_time_equal() {
        let req = parse_request(b"POST /mcp HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n").unwrap();
        assert!(auth_ok(&req, Some("tok")));
        assert!(!auth_ok(&req, Some("tok2")));
        assert!(!auth_ok(&req, None));
    }

    #[test]
    fn host_and_origin_are_checked() {
        let cfg = McpConfig::default();
        let good = parse_request(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:47391\r\n\r\n").unwrap();
        assert!(header_ok(&good, &cfg).is_ok());
        let bad = parse_request(b"POST /mcp HTTP/1.1\r\nHost: evil.example\r\n\r\n").unwrap();
        assert_eq!(header_ok(&bad, &cfg).unwrap_err().0, 403);
        let origin = parse_request(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\n\r\n").unwrap();
        assert_eq!(header_ok(&origin, &cfg).unwrap_err().0, 403);
    }

    #[test]
    fn validate_blocks_public_bind_without_opt_in() {
        let mut cfg = McpConfig::default();
        cfg.listen_address = "0.0.0.0".into();
        assert_eq!(config::validate(&cfg).unwrap_err().0, "custom_bind_disabled");
        cfg.allow_custom_bind = true;
        assert!(config::validate(&cfg).is_ok());
    }

    #[test]
    fn token_survives_set_config() {
        let rt = McpRuntime::new();
        {
            let mut inner = rt.lock();
            inner.token = Some("fixed-token".to_string());
            inner.listening = true;
        }
        let mut cfg = rt.config();
        cfg.permission_mode = config::PermissionMode::Auto;
        rt.set_config(cfg);
        let st = rt.status();
        assert_eq!(st.bearer_token.as_deref(), Some("fixed-token"));
        assert_eq!(st.permission_mode, "auto");
    }

    #[test]
    fn new_token_is_random_64_hex() {
        let a = new_token();
        let b = new_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn initialize_detection_covers_single_and_batch() {
        assert!(is_initialize(&json!({ "method": "initialize" })));
        assert!(!is_initialize(&json!({ "method": "tools/list" })));
        let batch = json!([{ "method": "notifications/initialized" }]);
        assert!(!batch.as_array().unwrap().iter().any(is_initialize));
    }

    #[test]
    fn user_agent_separates_stateless_clients() {
        let cfg = McpConfig::default();
        let a = parse_request(b"POST /mcp HTTP/1.1\r\nUser-Agent: Qoder/1.0\r\n\r\n").unwrap();
        let b = parse_request(b"POST /mcp HTTP/1.1\r\nUser-Agent: Cursor/0.45\r\n\r\n").unwrap();
        let ca = user_agent_client(&a, &cfg).unwrap();
        let cb = user_agent_client(&b, &cfg).unwrap();
        assert_ne!(ca.id, cb.id);
        assert_ne!(
            runtime_state::owner_for_client(&ca.id),
            runtime_state::owner_for_client(&cb.id)
        );
        let none = parse_request(b"POST /mcp HTTP/1.1\r\n\r\n").unwrap();
        assert!(user_agent_client(&none, &cfg).is_none());
    }

    #[test]
    fn mcp_sessions_map_to_isolated_owners() {
        let a = register_session();
        let b = register_session();
        assert_ne!(a, b);
        assert!(session_known(&a) && session_known(&b));
        // 不同 MCP 会话 → 不同 owner，自动建连的会话互不可见。
        assert_ne!(
            runtime_state::owner_for_client(&a),
            runtime_state::owner_for_client(&b)
        );
        end_session(&a);
        assert!(!session_known(&a));
        end_session(&b);
        assert!(!session_known(&b));
    }
}
