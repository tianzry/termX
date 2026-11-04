//! 主机级连接代理（HTTP CONNECT / SOCKS5）。
//!
//! 对齐 Netcatty 的 `NetcattyProxyConfig`（`type: 'http' | 'socks5'`，host/port/
//! username/password）。russh 自带的 `client::connect` 只接受 `(host, port)`，
//! 因此这里先自己完成代理握手拿到一条已连通的 `TcpStream`，再交给
//! `client::connect_stream` 跑 SSH 握手——两条路径的 SSH 行为完全一致。
//!
//! 认证、超时、IPv6、no_proxy 都在这一层收敛；错误一律带 code 交给前端 i18n。

use std::pin::Pin;
use std::process::Stdio;
use std::task::{Context, Poll};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

use crate::error::{AppError, AppResult};

/// 代理类型。`https://` 与 `socks5h://` 是常见别名，解析时一并接受。
/// `Command` 不对应网络握手：它是 OpenSSH ProxyCommand 语义的本地子进程。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyKind {
    Http,
    Socks5,
    Command,
}

impl ProxyKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "http" | "https" => Some(Self::Http),
            "socks5" | "socks5h" => Some(Self::Socks5),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Socks5 => "socks5",
            Self::Command => "command",
        }
    }
}

/// 运行期代理配置（密码在连接前从 SecretStore 解析，不落 DB 明文）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    /// 逗号 / 空白分隔的绕过列表；空表示全部走代理。
    pub no_proxy: Vec<String>,
    /// ProxyCommand 命令行（`kind == Command` 时生效），支持 `%h`/`%p`/`%%`。
    pub command: Option<String>,
}

impl ProxyConfig {
    /// 从档案字段构造。空用户名归一成 None；host 必须是裸主机名 / IP
    /// （不接收 `http://` 前缀和路径，避免把 URL 误当 host 去连接）。
    pub fn from_parts(
        kind_raw: &str,
        host: &str,
        port: u16,
        username: Option<&str>,
        password: Option<&str>,
        no_proxy: &str,
    ) -> AppResult<Self> {
        let kind = ProxyKind::parse(kind_raw).ok_or_else(|| {
            AppError::config("proxy_type_invalid", json!({ "value": kind_raw }))
        })?;
        Self::validate_host_port(host, port)?;
        Ok(Self {
            kind,
            host: host.trim().to_string(),
            port,
            username: username
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            password: password.filter(|s| !s.is_empty()).map(str::to_string),
            no_proxy: split_no_proxy(no_proxy),
            command: None,
        })
    }

    /// ProxyCommand 配置：命令为空/纯空白直接拒绝；host/port 不参与校验。
    pub fn from_command(command: &str) -> AppResult<Self> {
        let command = command.trim();
        if command.is_empty() {
            return Err(AppError::config("proxy_command_required", json!({})));
        }
        Ok(Self {
            kind: ProxyKind::Command,
            host: String::new(),
            port: 0,
            username: None,
            password: None,
            no_proxy: Vec::new(),
            command: Some(command.to_string()),
        })
    }

    /// 解析系统代理 URL（`http://host:port` / `socks5://host:port`）。
    /// 设置中心文案明确不支持 URL 内账号密码，所以 userinfo 直接判非法。
    pub fn from_url(url: &str, no_proxy: &str) -> AppResult<Self> {
        let raw = url.trim();
        let (scheme, rest) = raw.split_once("://").ok_or_else(|| {
            AppError::config("proxy_url_invalid", json!({ "url": raw }))
        })?;
        if rest.contains('@') {
            return Err(AppError::config(
                "proxy_url_invalid",
                json!({ "url": raw }),
            ));
        }
        let rest = rest.trim_end_matches('/');
        if rest.contains('/') {
            return Err(AppError::config(
                "proxy_url_invalid",
                json!({ "url": raw }),
            ));
        }
        let kind = ProxyKind::parse(scheme)
            .ok_or_else(|| AppError::config("proxy_url_invalid", json!({ "url": raw })))?;
        let (host, port) = if rest.starts_with('[') {
            // [::1]:8080
            let end = rest.find(']').ok_or_else(|| {
                AppError::config("proxy_url_invalid", json!({ "url": raw }))
            })?;
            let host = &rest[1..end];
            let port = rest[end + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(default_port(kind));
            (host.to_string(), port)
        } else if let Some((h, p)) = rest.rsplit_once(':') {
            if h.contains(':') {
                // 不带方括号的 IPv6 无法区分端口，按整个串当 host。
                (rest.to_string(), default_port(kind))
            } else {
                let port = p
                    .parse::<u16>()
                    .map_err(|_| AppError::config("proxy_url_invalid", json!({ "url": raw })))?;
                (h.to_string(), port)
            }
        } else {
            (rest.to_string(), default_port(kind))
        };
        Self::validate_host_port(&host, port)?;
        Ok(Self {
            kind,
            host,
            port,
            username: None,
            password: None,
            no_proxy: split_no_proxy(no_proxy),
            command: None,
        })
    }

    fn validate_host_port(host: &str, port: u16) -> AppResult<()> {
        let host = host.trim();
        if host.is_empty() {
            return Err(AppError::config("proxy_host_required", json!({})));
        }
        if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(AppError::config(
                "proxy_host_invalid",
                json!({ "host": host }),
            ));
        }
        if port == 0 {
            return Err(AppError::config("proxy_port_invalid", json!({ "port": port })));
        }
        Ok(())
    }

    /// 目标是否命中 no_proxy（命中 = 直连，不走代理）。
    pub fn should_bypass(&self, host: &str, port: u16) -> bool {
        no_proxy_matches(&self.no_proxy, host, port)
    }
}

fn default_port(kind: ProxyKind) -> u16 {
    match kind {
        ProxyKind::Http => 8080,
        ProxyKind::Socks5 => 1080,
        ProxyKind::Command => 0,
    }
}

fn split_no_proxy(raw: &str) -> Vec<String> {
    raw.split([',', ';', ' ', '\t', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect()
}

/// no_proxy 语义（对齐 curl / OpenSSH 的常见约定）：
/// - `*` 全绕过；
/// - `.example.com` 与 `example.com` 都匹配自身及子域；
/// - 可带端口（`example.com:22`），带端口时端口必须一致；
/// - IP 精确匹配，支持 IPv4 / IPv6 CIDR；
/// - `<local>` 匹配 localhost / 回环 / 无点主机名（系统代理专用）。
pub fn no_proxy_matches(entries: &[String], host: &str, port: u16) -> bool {
    if entries.is_empty() {
        return false;
    }
    let host = host.trim().trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    entries.iter().any(|entry| entry_matches(entry, &host, port))
}

fn entry_matches(entry: &str, host: &str, port: u16) -> bool {
    if entry == "*" {
        return true;
    }
    if entry == "<local>" {
        return host == "localhost"
            || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
            || !host.contains('.');
    }
    let (pattern, pattern_port) = split_host_port(entry);
    if let Some(p) = pattern_port {
        if p != port {
            return false;
        }
    }
    let pattern = pattern.trim_start_matches('.');
    if pattern.is_empty() {
        return false;
    }
    // CIDR（仅当两边都能解析成 IP 时才有意义）。
    if let Some((net, prefix)) = pattern.split_once('/') {
        if let (Ok(net), Ok(ip), Ok(prefix)) = (
            net.parse::<std::net::IpAddr>(),
            host.parse::<std::net::IpAddr>(),
            prefix.parse::<u8>(),
        ) {
            return cidr_contains(net, prefix, ip);
        }
        return false;
    }
    if let Ok(pattern_ip) = pattern.parse::<std::net::IpAddr>() {
        return host.parse::<std::net::IpAddr>().map(|ip| ip == pattern_ip).unwrap_or(false);
    }
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

/// 拆 `host:port`，但要放过 IPv6 字面量（`::1`、`[::1]`）与 CIDR。
fn split_host_port(entry: &str) -> (&str, Option<u16>) {
    if entry.starts_with('[') {
        if let Some(end) = entry.find(']') {
            let port = entry[end + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok());
            return (&entry[1..end], port);
        }
    }
    if entry.parse::<std::net::Ipv6Addr>().is_ok() {
        return (entry, None);
    }
    match entry.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => match port.parse::<u16>() {
            Ok(p) => (host, Some(p)),
            Err(_) => (entry, None),
        },
        _ => (entry, None),
    }
}

fn cidr_contains(net: std::net::IpAddr, prefix: u8, ip: std::net::IpAddr) -> bool {
    match (net, ip) {
        (std::net::IpAddr::V4(net), std::net::IpAddr::V4(ip)) => {
            let prefix = prefix.min(32);
            let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
            (u32::from(net) & mask) == (u32::from(ip) & mask)
        }
        (std::net::IpAddr::V6(net), std::net::IpAddr::V6(ip)) => {
            let prefix = prefix.min(128);
            let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
            (u128::from(net) & mask) == (u128::from(ip) & mask)
        }
        _ => false,
    }
}

/// 已建立的代理通道：HTTP / SOCKS5 是 TcpStream，ProxyCommand 是子进程
/// stdin/stdout 的组合流。两者都能直接交给 `client::connect_stream`
/// （`dyn AsyncRead + AsyncWrite` 不是合法 trait object，因此用枚举分发）。
pub(crate) enum ProxyStream {
    Tcp(TcpStream),
    Command(PipeStream),
}

impl std::fmt::Debug for ProxyStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Tcp(_) => f.write_str("ProxyStream::Tcp"),
            Self::Command(_) => f.write_str("ProxyStream::Command"),
        }
    }
}

impl AsyncRead for ProxyStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Command(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for ProxyStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Command(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_flush(cx),
            Self::Command(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Tcp(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Command(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

/// 连到代理并完成握手，返回一条已到达目标的流（或 ProxyCommand 子进程）。
/// `timeout` 覆盖 TCP 连接 + 代理握手全过程，避免代理挂死拖住 SSH 连接。
pub(crate) async fn connect_via_proxy(
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
    timeout: Duration,
) -> AppResult<ProxyStream> {
    let connect = async {
        // ProxyCommand：本地起子进程，命令里的 %h/%p 先替换成目标地址。
        if let Some(command) = &proxy.command {
            let expanded = expand_proxy_command(command, target_host, target_port);
            if expanded.trim().is_empty() {
                return Err(AppError::config("proxy_command_required", json!({})));
            }
            return spawn_command(&expanded);
        }
        let stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
            .await
            .map_err(|e| {
                AppError::ssh(
                    "proxy_connect_failed",
                    json!({
                        "host": &proxy.host,
                        "port": proxy.port,
                        "err": e.to_string(),
                    }),
                )
            })?;
        let _ = stream.set_nodelay(true);
        match proxy.kind {
            ProxyKind::Http => http_connect(stream, proxy, target_host, target_port)
                .await
                .map(ProxyStream::Tcp),
            ProxyKind::Socks5 => socks5_connect(stream, proxy, target_host, target_port)
                .await
                .map(ProxyStream::Tcp),
            ProxyKind::Command => Err(AppError::config(
                "proxy_command_required",
                json!({ "err": "command proxy without command" }),
            )),
        }
    };
    match tokio::time::timeout(timeout, connect).await {
        Ok(result) => result,
        Err(_) => Err(AppError::ssh(
            "proxy_connect_timeout",
            json!({
                "host": &proxy.host,
                "port": proxy.port,
                "secs": timeout.as_secs(),
            }),
        )),
    }
}

/// OpenSSH ProxyCommand 替换：`%h` 目标主机、`%p` 目标端口、`%%` 字面 `%`。
/// 单次扫描，避免替换结果里的 `%` 被二次展开；未知 `%x` 原样保留。
pub(crate) fn expand_proxy_command(command: &str, host: &str, port: u16) -> String {
    let mut out = String::with_capacity(command.len());
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('h') => {
                chars.next();
                out.push_str(host);
            }
            Some('p') => {
                chars.next();
                out.push_str(&port.to_string());
            }
            Some('%') => {
                chars.next();
                out.push('%');
            }
            _ => out.push('%'),
        }
    }
    out
}

/// 子进程 stdin（写）+ stdout（读）+ Child。stdout EOF 即通道断开。
pub(crate) struct PipeStream {
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    child: tokio::process::Child,
}

impl AsyncRead for PipeStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for PipeStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

impl Drop for PipeStream {
    fn drop(&mut self) {
        // SSH 会话结束时回收子进程，避免 ProxyCommand 残留。
        let _ = self.child.start_kill();
    }
}

fn spawn_command(command: &str) -> AppResult<ProxyStream> {
    let mut cmd = command_shell(command);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| {
        AppError::ssh(
            "proxy_command_spawn_failed",
            json!({ "command": command, "err": e.to_string() }),
        )
    })?;
    let stdin = child.stdin.take().ok_or_else(|| {
        AppError::ssh(
            "proxy_command_spawn_failed",
            json!({ "command": command, "err": "stdin unavailable" }),
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppError::ssh(
            "proxy_command_spawn_failed",
            json!({ "command": command, "err": "stdout unavailable" }),
        )
    })?;
    Ok(ProxyStream::Command(PipeStream {
        stdin,
        stdout,
        child,
    }))
}

/// Windows 走 `cmd /C` 并隐藏窗口；其它平台走 `sh -c`。
#[cfg(windows)]
fn command_shell(command: &str) -> tokio::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("cmd");
    // cmd /C 对「以引号开头的整串命令」有剥引号规则：命令本身常以
    // `"C:/.../node.exe" ...` 开头，再包一层引号才能保留内层引号。
    // raw_arg 走原始命令行，避免 Rust 的 MSVC 引号转义再破坏一层引号。
    cmd.arg("/C").raw_arg(format!("\"{command}\""));
    // CREATE_NO_WINDOW：ProxyCommand 不应弹出控制台窗口。
    cmd.creation_flags(0x0800_0000);
    tokio::process::Command::from(cmd)
}

#[cfg(not(windows))]
fn command_shell(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd
}

/// CONNECT 的 authority：IPv6 必须加方括号，否则 `host:port` 会歧义。
fn authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

async fn http_connect(
    mut stream: TcpStream,
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    let auth = proxy
        .username
        .as_deref()
        .map(|user| {
            let raw = format!("{}:{}", user, proxy.password.as_deref().unwrap_or(""));
            format!("Proxy-Authorization: Basic {}\r\n", STANDARD.encode(raw))
        })
        .unwrap_or_default();
    let request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{auth}\r\n",
        authority = authority(target_host, target_port),
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| proxy_io("proxy_handshake_failed", e))?;

    // 只读到第一个空行；响应头恶意超长时直接失败，避免无限读。
    let mut buf = Vec::with_capacity(1024);
    loop {
        let mut byte = [0u8; 1];
        stream
            .read_exact(&mut byte)
            .await
            .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
        buf.push(byte[0]);
        if buf.len() >= 4 && buf[buf.len() - 4..] == *b"\r\n\r\n" {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err(AppError::ssh(
                "proxy_handshake_failed",
                json!({ "err": "response headers too large" }),
            ));
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    match status {
        200..=299 => Ok(stream),
        407 => Err(AppError::ssh("proxy_auth_required", json!({ "status": status }))),
        _ => Err(AppError::ssh(
            "proxy_http_status",
            json!({ "status": status }),
        )),
    }
}

async fn socks5_connect(
    mut stream: TcpStream,
    proxy: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> AppResult<TcpStream> {
    let want_auth = proxy.username.is_some();
    let (method, mut greeting) = if want_auth {
        (0x02u8, vec![0x05u8, 0x02, 0x00, 0x02])
    } else {
        (0x00u8, vec![0x05u8, 0x01, 0x00])
    };
    stream
        .write_all(&greeting)
        .await
        .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
    greeting.clear();

    let mut reply = [0u8; 2];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
    if reply[0] != 0x05 {
        return Err(AppError::ssh(
            "proxy_socks5_failed",
            json!({ "err": "not a SOCKS5 proxy" }),
        ));
    }
    let chosen = reply[1];
    if chosen == 0xFF || (chosen == 0x02 && !want_auth) || (chosen != method && chosen != 0x00) {
        return Err(AppError::ssh("proxy_auth_required", json!({})));
    }
    if chosen == 0x02 {
        let user = proxy.username.as_deref().unwrap_or("");
        let pass = proxy.password.as_deref().unwrap_or("");
        let mut auth = vec![0x01u8, user.len() as u8];
        auth.extend_from_slice(user.as_bytes());
        auth.push(pass.len() as u8);
        auth.extend_from_slice(pass.as_bytes());
        stream
            .write_all(&auth)
            .await
            .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
        let mut status = [0u8; 2];
        stream
            .read_exact(&mut status)
            .await
            .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
        if status[1] != 0x00 {
            return Err(AppError::ssh(
                "proxy_auth_failed",
                json!({ "status": status[1] }),
            ));
        }
    }

    let mut request = vec![0x05u8, 0x01, 0x00];
    match target_host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            request.push(0x01);
            request.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            request.push(0x04);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            // 域名交给代理侧解析（socks5h 语义）；长度上限 255 由协议约束。
            if target_host.len() > 255 {
                return Err(AppError::ssh(
                    "proxy_socks5_failed",
                    json!({ "err": "target hostname too long" }),
                ));
            }
            request.push(0x03);
            request.push(target_host.len() as u8);
            request.extend_from_slice(target_host.as_bytes());
        }
    }
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|e| proxy_io("proxy_handshake_failed", e))?;

    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
    if head[0] != 0x05 {
        return Err(AppError::ssh(
            "proxy_socks5_failed",
            json!({ "err": "bad SOCKS5 reply version" }),
        ));
    }
    if head[1] != 0x00 {
        return Err(AppError::ssh(
            "proxy_socks5_failed",
            json!({ "rep": head[1] }),
        ));
    }
    // 消费 BND.ADDR / BND.PORT：不读会把它们当成 SSH 握手字节。
    let addr_len = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
            len[0] as usize
        }
        _ => {
            return Err(AppError::ssh(
                "proxy_socks5_failed",
                json!({ "err": "unknown address type" }),
            ))
        }
    };
    let mut rest = vec![0u8; addr_len + 2];
    stream
        .read_exact(&mut rest)
        .await
        .map_err(|e| proxy_io("proxy_handshake_failed", e))?;
    Ok(stream)
}

fn proxy_io(code: &'static str, e: std::io::Error) -> AppError {
    AppError::ssh(code, json!({ "err": e.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;

    fn cfg(kind: ProxyKind, auth: bool) -> ProxyConfig {
        ProxyConfig {
            kind,
            host: "127.0.0.1".into(),
            port: 1080,
            username: auth.then(|| "u".to_string()),
            password: auth.then(|| "p".to_string()),
            no_proxy: vec![],
            command: None,
        }
    }

    async fn mock<F, Fut>(handler: F) -> u16
    where
        F: FnOnce(TcpStream) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Vec<u8>> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            handler(stream).await;
        });
        port
    }

    #[tokio::test]
    async fn http_connect_sends_connect_and_auth_header() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(1);
        let port = mock(move |mut s| async move {
            let mut buf = [0u8; 512];
            let n = s.read(&mut buf).await.unwrap();
            tx.send(String::from_utf8_lossy(&buf[..n]).to_string())
                .await
                .unwrap();
            s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            Vec::new()
        })
        .await;
        let mut proxy = cfg(ProxyKind::Http, true);
        proxy.port = port;
        let stream = connect_via_proxy(&proxy, "example.com", 22, Duration::from_secs(5))
            .await
            .unwrap();
        drop(stream);
        let req = rx.recv().await.unwrap();
        assert!(req.starts_with("CONNECT example.com:22 HTTP/1.1\r\n"), "{req}");
        assert!(req.contains("Proxy-Authorization: Basic dTpw\r\n"), "{req}");
    }

    #[tokio::test]
    async fn http_proxy_rejects_non_200() {
        let port = mock(move |mut s| async move {
            // 先读掉 CONNECT 请求，避免「服务器先写后关」导致客户端写入侧报错。
            let mut buf = [0u8; 128];
            let _ = s.read(&mut buf).await;
            s.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await.unwrap();
            Vec::new()
        })
        .await;
        let mut proxy = cfg(ProxyKind::Http, false);
        proxy.port = port;
        let err = connect_via_proxy(&proxy, "example.com", 22, Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "proxy_http_status");
    }

    #[tokio::test]
    async fn socks5_domain_connect_and_auth() {
        let port = mock(move |mut s| async move {
            let mut greeting = [0u8; 4];
            s.read_exact(&mut greeting).await.unwrap();
            assert_eq!(&greeting[..2], &[0x05, 0x02]);
            s.write_all(&[0x05, 0x02]).await.unwrap();
            let mut auth = [0u8; 5];
            s.read_exact(&mut auth).await.unwrap();
            assert_eq!(auth, [0x01, 0x01, b'u', 0x01, b'p']);
            s.write_all(&[0x01, 0x00]).await.unwrap();
            let mut req = [0u8; 9];
            s.read_exact(&mut req).await.unwrap();
            assert_eq!(&req[..4], &[0x05, 0x01, 0x00, 0x03]);
            assert_eq!(req[4], 2); // "ab"
            assert_eq!(&req[5..7], b"ab");
            assert_eq!(&req[7..9], &22u16.to_be_bytes());
            s.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await.unwrap();
            Vec::new()
        })
        .await;
        let mut proxy = cfg(ProxyKind::Socks5, true);
        proxy.port = port;
        let stream = connect_via_proxy(&proxy, "ab", 22, Duration::from_secs(5)).await.unwrap();
        drop(stream);
    }

    #[tokio::test]
    async fn socks5_ipv6_target_uses_atyp4() {
        let port = mock(move |mut s| async move {
            let mut greeting = [0u8; 3];
            s.read_exact(&mut greeting).await.unwrap();
            s.write_all(&[0x05, 0x00]).await.unwrap();
            let mut req = [0u8; 4 + 16 + 2];
            s.read_exact(&mut req).await.unwrap();
            assert_eq!(req[3], 0x04);
            s.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await.unwrap();
            Vec::new()
        })
        .await;
        let mut proxy = cfg(ProxyKind::Socks5, false);
        proxy.port = port;
        let stream = connect_via_proxy(&proxy, "::1", 22, Duration::from_secs(5)).await.unwrap();
        drop(stream);
    }

    #[test]
    fn no_proxy_matching_rules() {
        let entries = split_no_proxy(".example.com, 10.0.0.0/8, 127.0.0.1, db.local:5432");
        assert!(no_proxy_matches(&entries, "example.com", 22));
        assert!(no_proxy_matches(&entries, "a.example.com", 22));
        assert!(no_proxy_matches(&entries, "10.1.2.3", 22));
        assert!(no_proxy_matches(&entries, "127.0.0.1", 22));
        assert!(no_proxy_matches(&entries, "db.local", 5432));
        assert!(!no_proxy_matches(&entries, "db.local", 22));
        assert!(!no_proxy_matches(&entries, "other.com", 22));
    }

    #[test]
    fn url_parsing_and_validation() {
        let p = ProxyConfig::from_url("http://127.0.0.1:7890", "").unwrap();
        assert_eq!((p.kind, p.host.as_str(), p.port), (ProxyKind::Http, "127.0.0.1", 7890));
        let p = ProxyConfig::from_url("socks5://[::1]:1080", "").unwrap();
        assert_eq!((p.host.as_str(), p.port), ("::1", 1080));
        assert!(ProxyConfig::from_url("ftp://1.2.3.4:21", "").is_err());
        assert!(ProxyConfig::from_url("http://u:p@1.2.3.4:8080", "").is_err());
        assert!(ProxyConfig::from_parts("wat", "1.2.3.4", 8080, None, None, "").is_err());
        assert!(ProxyConfig::from_parts("http", "", 8080, None, None, "").is_err());
    }

    #[test]
    fn proxy_command_expands_host_port_and_percent() {
        assert_eq!(
            expand_proxy_command("ssh -W %h:%p jumphost", "db.example.com", 22),
            "ssh -W db.example.com:22 jumphost"
        );
        assert_eq!(
            expand_proxy_command("nc %h %p 100%%%h", "10.0.0.1", 2222),
            "nc 10.0.0.1 2222 100%10.0.0.1"
        );
        // 未知占位符原样保留。
        assert_eq!(expand_proxy_command("echo %q %h", "h", 1), "echo %q h");
    }

    #[test]
    fn from_command_rejects_blank_command() {
        assert_eq!(
            ProxyConfig::from_command("   ").unwrap_err().code(),
            "proxy_command_required"
        );
        let cfg = ProxyConfig::from_command("  ssh -W %h:%p jump  ").unwrap();
        assert_eq!(cfg.kind, ProxyKind::Command);
        assert_eq!(cfg.command.as_deref(), Some("ssh -W %h:%p jump"));
        assert_eq!(cfg.host, "");
        assert_eq!(cfg.port, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pipe_stream_roundtrips_through_child_stdio() {
        let stream = connect_via_proxy(
            &ProxyConfig::from_command("cat").unwrap(),
            "ignored",
            0,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let mut stream = stream;
        stream.write_all(b"hello\n").await.unwrap();
        stream.flush().await.unwrap();
        let mut buf = vec![0u8; 6];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello\n");
    }
}
