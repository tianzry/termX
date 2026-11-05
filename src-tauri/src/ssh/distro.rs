//! SSH 主机发行版自动探测（移植 Netcatty `terminalDistroDetection.ts` /
//! `domain/host.ts` / `sshServerVendor.mjs` 的规则）。
//!
//! 探测顺序：
//! 1. SSH 服务端 identification string（banner，握手时由
//!    [`BannerCaptureStream`] 免费截获，不额外开通道）：
//!    - `OpenSSH_for_Windows` → `windows`
//!    - Cisco / Juniper / Huawei / H3C / HPE / MikroTik / Fortinet /
//!      Palo Alto / ZyXEL / Ruijie → 对应厂商 ID
//!    - 单通道 banner（BHostSSH / TERM-SSHD / CLOUDBILITY / CLOUDLINKER /
//!      russh）→ 跳过后续 exec 探测（多开通道会踢掉交互会话）
//! 2. 否则在**已建立**的连接上开 exec channel 跑
//!    `cat /etc/os-release 2>/dev/null || uname -a`（严格 5s 超时）：
//!    - `ID="?([\w-]+)"?` → normalize
//!    - 失败再取 uname 的 Linux / Darwin / FreeBSD
//! 3. 只有探测成功才写库；写入采用「已有值不覆盖」（本轮无手动设置 UI，
//!    避免后续自动探测改写用户认可的结果）。失败保持 NULL，前端回落 Server。
//!
//! 所有探测都在后台异步执行（`tauri::async_runtime::spawn` +
//! `run_blocking_ssh`），任何错误只记日志，绝不影响 SSH 会话本身。

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use regex::Regex;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::db::Db;
use crate::emitter::Host;
use crate::ssh::client::{self, SshHandle};

/// os-release / uname 探测命令（与 Netcatty `getSessionDistroInfo` 一致）。
pub const DISTRO_PROBE_COMMAND: &str = "cat /etc/os-release 2>/dev/null || uname -a";
/// 探测超时（严格 5s，需求硬约束）。
pub const DISTRO_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// banner 截获缓冲上限：超限仍没看到 `SSH-` 行就放弃（避免无限累积）。
const BANNER_BUFFER_CAP: usize = 8 * 1024;

/// 共享的 banner 截获槽：`None` = 尚未看到 identification string。
pub type BannerSink = Arc<Mutex<Option<String>>>;

pub fn new_banner_sink() -> BannerSink {
    Arc::new(Mutex::new(None))
}

/// 记录 SSH 服务端 identification string 的流包装器。
///
/// russh 0.62 不公开 server ident（`Handle` 上没有对应字段），因此在
/// AsyncRead 层旁路观察握手前那几行明文：服务器 ident 是 TCP 建立后
/// 服务端先发的第一段明文（`SSH-<2.0|1.99>-<software>\r\n`，前面可能还有
/// 少量预行）。这里只读观察，不改变交给 russh 的字节流。
pub struct BannerCaptureStream<S> {
    inner: S,
    sink: Option<BannerSink>,
    pending: Vec<u8>,
    done: bool,
}

impl<S> BannerCaptureStream<S> {
    pub fn new(inner: S, sink: Option<BannerSink>) -> Self {
        let done = sink.is_none();
        Self {
            inner,
            sink,
            pending: Vec::new(),
            done,
        }
    }

    fn observe(&mut self, chunk: &[u8]) {
        if self.done {
            return;
        }
        self.pending.extend_from_slice(chunk);
        if let Some(line) = find_ssh_banner_line(&self.pending) {
            if let Some(sink) = &self.sink {
                if let Ok(mut slot) = sink.lock() {
                    if slot.is_none() {
                        *slot = Some(line);
                    }
                }
            }
            self.done = true;
            self.pending.clear();
            return;
        }
        if self.pending.len() >= BANNER_BUFFER_CAP {
            // 看不到 SSH- 行（例如服务端根本不发标准 ident）：停止观察。
            self.done = true;
            self.pending.clear();
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for BannerCaptureStream<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        // banner 已截获（或明确放弃）：后续会话读不再做整块拷贝。
        if this.done {
            return Pin::new(&mut this.inner).poll_read(cx, buf);
        }
        let before = buf.filled().len();
        let poll = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &poll {
            let filled: Vec<u8> = buf.filled()[before..].to_vec();
            if !filled.is_empty() {
                this.observe(&filled);
            }
        }
        poll
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for BannerCaptureStream<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// 从截获的字节中找第一行 `SSH-...` identification string。
fn find_ssh_banner_line(data: &[u8]) -> Option<String> {
    for raw in data.split(|b| *b == b'\n') {
        let text = String::from_utf8_lossy(raw);
        let text = text.trim();
        if text.starts_with("SSH-") {
            return Some(text.to_string());
        }
    }
    None
}

/// Netcatty `NETWORK_DEVICE_OPTIONS`（含 ruijie）。
pub const NETWORK_DEVICE_OPTIONS: &[&str] = &[
    "cisco",
    "juniper",
    "huawei",
    "h3c",
    "hpe",
    "mikrotik",
    "fortinet",
    "paloalto",
    "zyxel",
    "ruijie",
];

/// 单通道 banner 关键字（Netcatty `SINGLE_CHANNEL_SOFTWARE_TOKENS`）。
const SINGLE_CHANNEL_TOKENS: &[&str] = &[
    "BHostSSH",
    "TERM-SSHD",
    "CLOUDBILITY",
    "CLOUDLINKER",
    "russh",
];

/// 把 os-release ID / uname 平台名归一成 Netcatty 的标准发行版 ID。
/// 关键字表与顺序照抄 `Netcatty/domain/host.ts` L98-138。
pub fn normalize_distro_id(value: Option<&str>) -> Option<&'static str> {
    let v = value.unwrap_or("").trim().to_lowercase();
    if v.is_empty() {
        return None;
    }
    if v == "darwin"
        || v == "macos"
        || v == "mac os"
        || v == "mac os x"
        || v.contains("darwin kernel")
        || v.contains("macos")
        || v.contains("mac os")
    {
        return Some("macos");
    }
    if v == "windows" || v == "win32" || v.starts_with("openssh_for_windows") {
        return Some("windows");
    }
    if v.contains("freebsd") {
        return Some("freebsd");
    }
    if v.contains("ubuntu") {
        return Some("ubuntu");
    }
    if v.contains("debian") {
        return Some("debian");
    }
    if v.contains("centos") {
        return Some("centos");
    }
    if v.contains("rocky") {
        return Some("rocky");
    }
    if v.contains("fedora") {
        return Some("fedora");
    }
    if v.contains("arch") || v.contains("manjaro") {
        return Some("arch");
    }
    if v.contains("alpine") {
        return Some("alpine");
    }
    if v.contains("amzn") || v.contains("amazon") || v.contains("aws") {
        return Some("amazon");
    }
    if v.contains("opensuse") || v.contains("suse") || v.contains("sles") {
        return Some("opensuse");
    }
    if v.contains("red hat") || v.contains("redhat") || v.contains("rhel") {
        return Some("redhat");
    }
    if v.contains("almalinux") {
        return Some("almalinux");
    }
    if v.contains("oracle") {
        return Some("oracle");
    }
    if v.contains("kali") {
        return Some("kali");
    }
    if v.contains("openeuler") || v.contains("open euler") {
        return Some("openeuler");
    }
    // Alibaba Cloud Linux：必须在通用 linux 兜底之前（alinux 含 linux）。
    if v.contains("alinux") || v.contains("aliyun") || v.contains("alibaba cloud") {
        return Some("alinux");
    }
    // 网络设备厂商 ID 可能从探测结果回流，保留原值。
    for id in NETWORK_DEVICE_OPTIONS {
        if *id == v.as_str() {
            return Some(*id);
        }
    }
    if v == "linux" || v.contains("linux") {
        return Some("linux");
    }
    None
}

/// 从 SSH identification string 识别网络设备厂商（照抄
/// `Netcatty/domain/sshServerVendor.mjs`）。
pub fn detect_vendor_from_ssh_version(version: Option<&str>) -> Option<&'static str> {
    let raw = version.unwrap_or("").trim();
    let stripped = Regex::new(r"(?i)^SSH-(?:2\.0|1\.99)-")
        .ok()
        .map(|re| re.replace(raw, "").into_owned())
        .unwrap_or_else(|| raw.to_string());
    let s = stripped.as_str();
    if s.is_empty() {
        return None;
    }
    if regex_is_match(r"(?i)^Cisco[-_]", s)
        || regex_is_match(r"(?i)^CiscoIOS_", s)
        || regex_is_match(r"^CISCO_WLC\b", s)
    {
        return Some("cisco");
    }
    if regex_is_match(r"^NetScreen\b", s) {
        return Some("juniper");
    }
    if s == "-" || regex_is_match(r"(?i)^HUAWEI[-_]", s) || regex_is_match(r"(?i)^VRP-", s) {
        return Some("huawei");
    }
    if regex_is_match(r"(?i)^H3C[-_\s]", s)
        || regex_is_match(r"(?i)^Comware-", s)
        || regex_is_match(r"(?i)^3Com\s*OS", s)
    {
        return Some("h3c");
    }
    if regex_is_match(r"(?i)^mpSSH_", s) {
        return Some("hpe");
    }
    if regex_is_match(r"^ROSSSH\b", s) {
        return Some("mikrotik");
    }
    if regex_is_match(r"(?i)^FortiSSH_", s) {
        return Some("fortinet");
    }
    if regex_is_match(r"(?i)^PaloAltoNetworks[_-]", s) {
        return Some("paloalto");
    }
    if regex_is_match(r"(?i)^Zyxel\s*SSH", s) {
        return Some("zyxel");
    }
    if regex_is_match(r"(?i)^RGOS_SSH\b", s) {
        return Some("ruijie");
    }
    None
}

/// 是否为 Windows OpenSSH（Netcatty 直接判成 windows，不再跑 POSIX 探测）。
pub fn is_openssh_for_windows(banner: &str) -> bool {
    regex_is_match(
        r"(?i)^(?:SSH-(?:2\.0|1\.99)-)?OpenSSH_for_Windows(?:_|$)",
        banner,
    )
}

/// banner 是否声明「单 TCP 只能有一个 session channel」（照抄 Netcatty
/// `singleChannelSshBanner.shared.mjs` 的 token 边界匹配规则）。
pub fn requires_single_channel(banner: &str) -> bool {
    SINGLE_CHANNEL_TOKENS
        .iter()
        .any(|token| software_token_matches(banner, token))
}

fn software_token_matches(software: &str, token: &str) -> bool {
    let software = software.trim();
    if software.is_empty() {
        return false;
    }
    let pattern = format!(
        "(?i)(?:^|[^A-Za-z0-9]){}(?:[^A-Za-z0-9]|$)",
        regex::escape(token)
    );
    Regex::new(&pattern)
        .map(|re| re.is_match(software))
        .unwrap_or(false)
}

fn regex_is_match(pattern: &str, value: &str) -> bool {
    Regex::new(pattern)
        .map(|re| re.is_match(value))
        .unwrap_or(false)
}

/// 解析 os-release / uname 输出（与 Netcatty `terminalDistroDetection.ts` 一致）：
/// `ID="?([\w-]+)"?` 优先；否则 uname 的 Linux / Darwin / FreeBSD。
pub fn parse_os_release_output(output: &str) -> Option<String> {
    let data = output.trim();
    if data.is_empty() {
        return None;
    }
    let id_re = Regex::new(r#"(?im)^ID="?([\w-]+)"?$"#).ok()?;
    if let Some(caps) = id_re.captures(data) {
        let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        // os-release 的 ID 已经证明是 Linux：即使是未收录的发行版也回落 linux。
        return normalize_distro_id(Some(raw))
            .map(str::to_string)
            .or_else(|| Some("linux".to_string()));
    }
    let uname_re = Regex::new(r"(?im)^(Linux|Darwin|FreeBSD)\b").ok()?;
    uname_re
        .captures(data)
        .and_then(|caps| caps.get(1))
        .and_then(|m| normalize_distro_id(Some(m.as_str())))
        .map(str::to_string)
}

/// 在一条已认证的 SSH 连接上执行探测（不写库）。
///
/// - `known_distro` 非空 → 直接跳过（「已有值不覆盖」策略下无需再探测）。
/// - banner 命中厂商 / Windows / 单通道 → 按 banner 结果或跳过。
/// - 其余 → exec 探测，失败只记日志并返回 None。
pub async fn detect_distro(
    ssh_handle: &SshHandle,
    banner: Option<String>,
    known_distro: Option<String>,
    agent_forwarding: bool,
) -> Option<String> {
    if known_distro
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        return None;
    }

    let banner = banner
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());

    if let Some(b) = banner.as_deref() {
        if is_openssh_for_windows(b) {
            return Some("windows".to_string());
        }
        if let Some(vendor) = detect_vendor_from_ssh_version(Some(b)) {
            return Some(vendor.to_string());
        }
        if requires_single_channel(b) {
            log::info!("发行版探测跳过：banner 限制单通道（{b}）");
            return None;
        }
    }

    // 外层再兜一层 5s：exec_once 的 timeout 只覆盖输出收集，
    // 这里保证「打开 channel + 执行 + 收集」整体也不超过 5s。
    let probe = client::exec_once(
        ssh_handle,
        DISTRO_PROBE_COMMAND,
        DISTRO_PROBE_TIMEOUT,
        agent_forwarding,
    );
    match tokio::time::timeout(DISTRO_PROBE_TIMEOUT, probe).await {
        Ok(Ok(res)) => {
            if res.exit_code != Some(0) {
                log::debug!(
                    "发行版探测命令退出码 {:?}（仍尝试解析 stdout）",
                    res.exit_code
                );
            }
            parse_os_release_output(&res.stdout)
        }
        Ok(Err(err)) => {
            // 探测失败绝不冒泡到 SSH 会话。
            log::info!("发行版探测失败（忽略）：{err}");
            None
        }
        Err(_) => {
            log::info!("发行版探测超时（5s，忽略）");
            None
        }
    }
}

/// 后台启动发行版探测：成功且首次写入后 emit `profiles:changed`，
/// 前端据此重新拉取 profiles（无需断开 / 重连终端）。
pub fn spawn_detection(
    ssh_handle: SshHandle,
    profile_id: String,
    banner: Option<String>,
    known_distro: Option<String>,
    db: Arc<Db>,
    host: Host,
    agent_forwarding: bool,
) {
    tauri::async_runtime::spawn(async move {
        // 探测必须在该 SSH 连接所属的 worker runtime 上驱动（exec_once
        // 打开 channel 依赖 russh Handle），因此走 run_blocking_ssh。
        let detected = client::run_blocking_ssh(move || async move {
            Ok(detect_distro(&ssh_handle, banner, known_distro, agent_forwarding).await)
        })
        .await;
        let Some(distro) = detected.ok().flatten() else {
            return;
        };
        match crate::db::profile::set_distro_if_unset(&db, &profile_id, &distro) {
            Ok(true) => {
                let _ = host.emit(
                    "profiles:changed",
                    serde_json::json!({ "id": profile_id, "distro": distro }),
                );
            }
            Ok(false) => {
                log::debug!("发行版 {distro} 未写入：该主机已有 distro（不覆盖）");
            }
            Err(err) => log::warn!("写回发行版失败（忽略）：{err}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_maps_linux_families() {
        assert_eq!(normalize_distro_id(Some("ubuntu")), Some("ubuntu"));
        assert_eq!(normalize_distro_id(Some("Ubuntu")), Some("ubuntu"));
        assert_eq!(normalize_distro_id(Some("rocky")), Some("rocky"));
        assert_eq!(
            normalize_distro_id(Some("Alibaba Cloud Linux")),
            Some("alinux")
        );
        assert_eq!(normalize_distro_id(Some("alinux")), Some("alinux"));
        assert_eq!(normalize_distro_id(Some("amzn")), Some("amazon"));
        assert_eq!(normalize_distro_id(Some("sles")), Some("opensuse"));
        assert_eq!(normalize_distro_id(Some("Red Hat Enterprise Linux")), Some("redhat"));
        assert_eq!(normalize_distro_id(Some("oracle linux")), Some("oracle"));
        assert_eq!(normalize_distro_id(Some("unknown linux")), Some("linux"));
        assert_eq!(normalize_distro_id(Some("")), None);
        assert_eq!(normalize_distro_id(None), None);
    }

    #[test]
    fn normalize_maps_posix_and_windows() {
        assert_eq!(normalize_distro_id(Some("Darwin")), Some("macos"));
        assert_eq!(normalize_distro_id(Some("macOS")), Some("macos"));
        assert_eq!(
            normalize_distro_id(Some("OpenSSH_for_Windows_9.5")),
            Some("windows")
        );
        assert_eq!(normalize_distro_id(Some("FreeBSD")), Some("freebsd"));
        assert_eq!(normalize_distro_id(Some("win32")), Some("windows"));
    }

    #[test]
    fn normalize_preserves_network_vendors() {
        for vendor in NETWORK_DEVICE_OPTIONS {
            assert_eq!(normalize_distro_id(Some(vendor)), Some(*vendor));
        }
    }

    #[test]
    fn parses_os_release_id() {
        let output = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\n";
        assert_eq!(parse_os_release_output(output).as_deref(), Some("ubuntu"));
    }

    #[test]
    fn parses_quoted_os_release_id() {
        let output = "NAME=\"Rocky Linux\"\nID=\"rocky\"\n";
        assert_eq!(parse_os_release_output(output).as_deref(), Some("rocky"));
    }

    #[test]
    fn unknown_os_release_id_falls_back_to_linux() {
        let output = "NAME=\"Some Distro\"\nID=some-cool-distro\n";
        assert_eq!(parse_os_release_output(output).as_deref(), Some("linux"));
    }

    #[test]
    fn parses_uname_fallback() {
        assert_eq!(
            parse_os_release_output(
                "Linux db 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux"
            )
            .as_deref(),
            Some("linux")
        );
        assert_eq!(
            parse_os_release_output("Darwin mac 23.6.0 Darwin Kernel Version 23.6.0")
                .as_deref(),
            Some("macos")
        );
        assert_eq!(
            parse_os_release_output("FreeBSD fw 14.1-RELEASE-p5 FreeBSD amd64")
                .as_deref(),
            Some("freebsd")
        );
        assert_eq!(parse_os_release_output(""), None);
    }

    #[test]
    fn extracts_ssh_banner_from_stream_chunks() {
        // 服务器 ident 可能分块到达，也可能前面有预行。
        let chunk = b"hello\r\nSSH-2.0-OpenSSH_9.6\r\n";
        assert_eq!(
            find_ssh_banner_line(chunk).as_deref(),
            Some("SSH-2.0-OpenSSH_9.6")
        );
        assert_eq!(find_ssh_banner_line(b"\r\n").as_deref(), None);
    }

    #[test]
    fn detects_windows_banner() {
        assert!(is_openssh_for_windows("SSH-2.0-OpenSSH_for_Windows_9.5"));
        assert!(is_openssh_for_windows("OpenSSH_for_Windows_8.1"));
        assert!(!is_openssh_for_windows("SSH-2.0-OpenSSH_9.6"));
    }

    #[test]
    fn detects_network_vendors_from_banner() {
        assert_eq!(
            detect_vendor_from_ssh_version(Some("SSH-2.0-Cisco-1.25")),
            Some("cisco")
        );
        assert_eq!(
            detect_vendor_from_ssh_version(Some("SSH-2.0-RGOS_SSH")),
            Some("ruijie")
        );
        assert_eq!(
            detect_vendor_from_ssh_version(Some("SSH-2.0-Comware-7.1.064")),
            Some("h3c")
        );
        assert_eq!(
            detect_vendor_from_ssh_version(Some("SSH-2.0-mpSSH_0.2.1")),
            Some("hpe")
        );
        assert_eq!(
            detect_vendor_from_ssh_version(Some("SSH-2.0-FortiSSH_7.0")),
            Some("fortinet")
        );
        assert_eq!(detect_vendor_from_ssh_version(Some("-")), Some("huawei"));
        assert_eq!(
            detect_vendor_from_ssh_version(Some("SSH-2.0-OpenSSH_9.6")),
            None
        );
    }

    #[test]
    fn detects_single_channel_banners() {
        for banner in [
            "SSH-2.0-BHostSSH_7.0",
            "SSH-2.0-TERM-SSHD",
            "SSH-2.0-CLOUDBILITY-4.14",
            "SSH-2.0-CLOUDLINKER",
            "SSH-2.0-russh_0.1",
        ] {
            assert!(requires_single_channel(banner), "{banner}");
        }
        assert!(!requires_single_channel("SSH-2.0-OpenSSH_9.6"));
        assert!(!requires_single_channel("JumpServer"));
        // token 边界是「非字母数字」：连字符也算边界（与 Netcatty 一致）。
        assert!(requires_single_channel("SSH-2.0-term-sshd-extra"));
    }
}
