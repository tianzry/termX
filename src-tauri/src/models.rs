use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{AppError, AppResult};

/// 用户可见 name 字段的字符校验。拒绝所有 C0 控制符（含 ESC `\x1b` 和 BEL `\x07`）
/// 以及 DEL `\x7f`。这些字符会破坏 OSC 7337 协议（CLI → GUI 的
/// `rssh <profile|forward> open <name>` 转义序列），让恶意 profile/forward 名能
/// 注入额外终端转义。
/// 普通可打印 ASCII、空格、UTF-8 多字节字符均允许。
pub fn validate_name(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::config("name_empty", serde_json::json!({})));
    }
    for ch in name.chars() {
        let c = ch as u32;
        // C0 controls: 0x00-0x1F；DEL: 0x7F。任一都能终止 / 注入终端转义。
        if c < 0x20 || c == 0x7f {
            return Err(AppError::config(
                "name_has_control_char",
                serde_json::json!({ "codepoint": c }),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    /// DB 列声明 `TEXT NOT NULL DEFAULT ''`，model 类型对齐成 String。
    /// **应用层不变量**：Profile.credential_id 永远是一个真实 Credential 的 id。
    /// - 写入入口（`add.rs`/`edit.rs`/`ProfileEditor.svelte`）
    ///   强制必填，从源头保证不变量。
    /// - 读取端（`open.rs`/`ssh_builder.rs`/`forward.rs`/`session.rs`）直接
    ///   `credential::get(&id)`，引用错就 fail-fast 报 `*_cred_not_found`，
    ///   不再 `is_empty()` 降级到"无凭证"。
    pub credential_id: String,
    pub bastion_profile_id: Option<String>,
    pub init_command: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_ssh_algorithms")]
    pub algorithms: SshAlgorithms,
    // ── Netcatty 1:1 对齐新增字段（schema v33）──
    // 全部 serde(default)：旧库 / 旧前端 / 旧配置 JSON 缺字段时落到默认值，
    // 保证升级不破坏既有数据（见 db/schema.rs version<33 迁移块）。
    /// SFTP 文件协议：`auto` / `sftp` / `scp`；None = auto。
    #[serde(default)]
    pub sftp_protocol: Option<String>,
    /// SFTP Sudo 提权模式（用保存的密码自动获取 Root 权限）。
    #[serde(default)]
    pub sftp_sudo: bool,
    /// SFTP 文件名编码：`auto` / `utf-8` / `gb18030`；None = auto。
    #[serde(default)]
    pub sftp_encoding: Option<String>,
    /// 主机图标来源：`auto`（自动探测）/ `custom`（自定义）；None = auto。
    #[serde(default)]
    pub icon_source: Option<String>,
    /// 主机图标颜色：`auto` 或 `#RRGGBB`；None = auto。
    #[serde(default)]
    pub icon_color: Option<String>,
    /// TOTP 在已知提示上自动提交（默认 true）。
    /// TOTP secret 本身是密钥材料，走 SecretStore（key `totp:<profile_id>`），不入表。
    #[serde(default = "default_totp_auto_submit")]
    pub totp_auto_submit: bool,
    /// TOTP 自定义提示正则（RE2）；None = 用内置 JumpServer / Google Authenticator PAM 模式。
    #[serde(default)]
    pub totp_regex: Option<String>,
    // ── 本地 shell 主机新增字段（schema v34，对齐 Netcatty localShellHost）──
    /// 协议类型：`ssh`（默认）/ `local`（本地终端主机，走 PTY 不走 SSH）。
    #[serde(default = "default_profile_protocol")]
    pub protocol: String,
    /// 本地主机：选中的 shell 命令；None = 跟随 设置 → 终端 的默认本地 Shell。
    #[serde(default)]
    pub local_shell: Option<String>,
    /// 本地主机：shell 启动参数快照（DB 存 JSON 文本）；None = 按 shell 默认行为。
    #[serde(default)]
    pub local_shell_args: Option<Vec<String>>,
    /// 本地主机：shell 显示名快照（保存时的发现列表元数据）。
    #[serde(default)]
    pub local_shell_name: Option<String>,
    /// 本地主机：shell 图标快照（保存时的发现列表元数据）。
    #[serde(default)]
    pub local_shell_icon: Option<String>,
    /// 本地主机：启动目录；`~` 在 spawn 时展开为主目录。None = 继承全局起始目录。
    #[serde(default)]
    pub local_start_dir: Option<String>,
    // ── 钥匙串阶段 B 新增字段（schema v36）──
    /// SSH Agent 转发（对齐 Netcatty agentForwarding）：连接时向服务端请求
    /// `auth-agent-req@openssh.com`，把本机 agent 借给远端用。默认关闭——
    /// 转发会让远端能借用本机所有已加载身份，属安全敏感开关。
    #[serde(default)]
    pub agent_forwarding: bool,
    // ── 代理阶段 A 新增字段（schema v39，对齐 Netcatty proxyConfig）──
    /// 主机级连接代理：`http` / `socks5`；None = 该主机不使用代理。
    /// 代理密码不在此结构里（走 SecretStore `proxy:<profile_id>`）。
    #[serde(default)]
    pub proxy_type: Option<String>,
    #[serde(default)]
    pub proxy_host: Option<String>,
    #[serde(default)]
    pub proxy_port: Option<u16>,
    #[serde(default)]
    pub proxy_username: Option<String>,
    /// 不走代理的主机列表（逗号分隔，语义见 `ssh::proxy::no_proxy_matches`）。
    #[serde(default)]
    pub proxy_no_proxy: Option<String>,
    // ── 代理库阶段 B 新增字段（schema v40）──
    /// 引用 `proxy_profiles` 表中的代理条目；Some 时连接层以库中配置为准，
    /// 上面的内联 proxy_* 字段仅作库条目被删除后的回退。
    #[serde(default)]
    pub proxy_profile_id: Option<String>,
}

/// 代理库条目（对齐 Netcatty `ProxyProfile` 的 label + config 扁平化）：
/// 一份可被多台主机复用的 HTTP / SOCKS5 代理配置。
/// 密码不入表，走 SecretStore（key `proxy_profile:<id>`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyProfile {
    pub id: String,
    pub label: String,
    /// `http` / `socks5`。
    pub proxy_type: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    /// 不走代理的主机列表（逗号分隔），可为空。
    #[serde(default)]
    pub no_proxy: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 手动排序位（None = 按 updated_at 排序）。
    #[serde(default)]
    pub order: Option<i64>,
}

/// `protocol` 的 serde 默认值：历史数据全是 SSH 主机。
fn default_profile_protocol() -> String {
    "ssh".to_string()
}

/// 本机发现的可用 shell（对齐 Netcatty shellDiscovery 的返回形状）。
/// `id` 稳定标识（发现列表匹配用）；`command` 是实际可执行命令 / 路径；
/// `is_default` = 系统默认 shell（Windows: pwsh > powershell > cmd；
/// Unix: $SHELL，否则首个）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredShell {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub icon: String,
    #[serde(default)]
    pub is_default: bool,
}

/// `totp_auto_submit` 的 serde 默认值：Netcatty 行为是默认开启自动提交。
fn default_totp_auto_submit() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshAlgorithms {
    #[serde(default = "default_kex_algorithms")]
    pub kex: Vec<String>,
    #[serde(default = "default_key_algorithms")]
    pub key: Vec<String>,
    #[serde(default = "default_cipher_algorithms")]
    pub cipher: Vec<String>,
    #[serde(default = "default_mac_algorithms")]
    pub mac: Vec<String>,
    #[serde(default = "default_compression_algorithms")]
    pub compression: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshAlgorithmCatalog {
    pub defaults: SshAlgorithms,
    pub supported: SshAlgorithms,
}

impl Default for SshAlgorithms {
    fn default() -> Self {
        Self {
            kex: default_kex_algorithms(),
            key: default_key_algorithms(),
            cipher: default_cipher_algorithms(),
            mac: default_mac_algorithms(),
            compression: default_compression_algorithms(),
        }
    }
}

fn deserialize_ssh_algorithms<'de, D>(deserializer: D) -> Result<SshAlgorithms, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(SshAlgorithms::default());
    }
    match serde_json::from_value(value) {
        Ok(algorithms) => Ok(algorithms),
        Err(e) => {
            log::warn!("failed to deserialize profile.algorithms, using defaults: {e}");
            Ok(SshAlgorithms::default())
        }
    }
}

pub fn default_ssh_algorithms() -> SshAlgorithms {
    SshAlgorithms::default()
}

fn default_kex_algorithms() -> Vec<String> {
    // ext-info-* and kex-strict-* are protocol markers, not selectable KEX.
    // ssh::algorithms adds the client-side markers to russh at runtime.
    [
        "mlkem768x25519-sha256",
        "curve25519-sha256",
        "curve25519-sha256@libssh.org",
        "diffie-hellman-group-exchange-sha256",
        "diffie-hellman-group18-sha512",
        "diffie-hellman-group17-sha512",
        "diffie-hellman-group16-sha512",
        "diffie-hellman-group15-sha512",
        "diffie-hellman-group14-sha256",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn default_key_algorithms() -> Vec<String> {
    [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn default_cipher_algorithms() -> Vec<String> {
    [
        "chacha20-poly1305@openssh.com",
        "aes256-gcm@openssh.com",
        "aes256-ctr",
        "aes192-ctr",
        "aes128-ctr",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn default_mac_algorithms() -> Vec<String> {
    [
        "hmac-sha2-512-etm@openssh.com",
        "hmac-sha2-256-etm@openssh.com",
        "hmac-sha2-512",
        "hmac-sha2-256",
        "hmac-sha1-etm@openssh.com",
        "hmac-sha1",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

fn default_compression_algorithms() -> Vec<String> {
    ["none", "zlib", "zlib@openssh.com"]
        .into_iter()
        .map(String::from)
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialType {
    Password,
    Key,
    Interactive,
    Agent,
    None,
}

impl CredentialType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
            Self::Interactive => "interactive",
            Self::Agent => "agent",
            Self::None => "none",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "password" => Self::Password,
            "key" => Self::Key,
            "interactive" => Self::Interactive,
            "agent" => Self::Agent,
            _ => Self::None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(rename = "type")]
    pub credential_type: CredentialType,
    pub secret: Option<String>,
    #[serde(default)]
    pub save_to_remote: bool,
}

/// 一次性认证覆盖（连接弹窗认证失败后重试）。
///
/// 只影响本次连接，绝不写回 DB：
/// - `username` 覆盖登录名；
/// - `password` 覆盖为密码认证并替换 secret；
/// - `credential_id` 改用另一条已保存凭据（密钥 / interactive / agent）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthOverride {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub credential_id: Option<String>,
    /// 私钥 passphrase（仅对 Key 类型凭据生效，写入本次进程的 passphrase 缓存）。
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardType {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForwardRule {
    #[serde(rename = "type")]
    pub forward_type: ForwardType,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// 监听地址（对齐 Netcatty `bindAddress`）。空 = 默认：local / dynamic 绑
    /// 127.0.0.1（并尽力绑 ::1），remote 交给 sshd 默认（"127.0.0.1"）。
    /// 非空时按给定地址单独监听。
    #[serde(default)]
    pub bind_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Forward {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    /// Optional group membership — shares the same `groups` table as profiles.
    pub group_id: Option<String>,
    pub rules: Vec<ForwardRule>,
    /// 应用启动后自动拉起（对齐 Netcatty `autoStart`）。
    #[serde(default)]
    pub auto_start: bool,
    /// 意外断开后自动重连（对齐 Netcatty `autoReconnect`，有上限）。
    /// `None` = 未显式设置，语义上跟随 `auto_start`。
    #[serde(default)]
    pub auto_reconnect: Option<bool>,
}

/// Saved serial console — a peer of `Profile`/`Forward`. No secret, no FK: just
/// a named port + line framing. snake_case fields match the profile/forward
/// convention and feed the runtime `serial_open` config 1:1 (no remapping).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialProfile {
    pub id: String,
    pub name: String,
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    /// 1 | 1.5 | 2。SQLite 数值亲和：1.0/2.0 存为 INTEGER、1.5 存为 REAL，
    /// 旧行（INTEGER 1/2）按 f64 读回无需迁移。
    pub stop_bits: f64,
    pub flow_control: String,
    // ── Tabby-style extras. All frontend-applied (TerminalPane transforms)
    //    EXCEPT `xany`, which is a termios wire flag set in `serial::open`.
    //    serde defaults keep older exported payloads (lacking these keys) importable.
    #[serde(default)]
    pub xany: bool,
    #[serde(default = "default_input_newline")]
    pub input_newline: String, // cr | lf | crlf — what Enter sends
    #[serde(default = "default_output_newline")]
    pub output_newline: String, // raw | cr | lf | crlf — incoming → CRLF normalization
    #[serde(default)]
    pub local_echo: bool,
    #[serde(default = "default_backspace")]
    pub backspace: String, // del | bs | csi3 — what Backspace/Delete sends
    #[serde(default)]
    pub slow_send: bool, // send one byte at a time (slow devices / bootloaders)
    #[serde(default = "default_input_mode")]
    pub input_mode: String, // normal | hex | line
    #[serde(default = "default_output_mode")]
    pub output_mode: String, // text | hex
    #[serde(default)]
    pub login_script: String, // expect/send lines, run on connect
    /// Optional group membership — same `groups` table as profiles/forwards.
    #[serde(default)]
    pub group_id: Option<String>,
}

/// How local echo is selected for a telnet session.
///
/// `Auto` follows RFC 854 ECHO negotiation, while `On` / `Off` are explicit
/// user overrides for broken peers. The old `local_echo` boolean remains in
/// `TelnetProfile` as a wire-compatibility field for pre-v0.2.12 clients.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TelnetEchoMode {
    #[default]
    Auto,
    On,
    Off,
}

impl TelnetEchoMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::On => "on",
            Self::Off => "off",
        }
    }
}

/// Saved telnet endpoint — a peer of `SerialProfile`, with its optional login
/// script stored separately in `SecretStore`. Only line-discipline knobs that
/// make sense for a telnet NVT live here — no baud/parity/hex/slow_send.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelnetProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_telnet_port")]
    pub port: u16,
    /// What Enter sends. Default crlf — RFC 854's NVT end-of-line.
    #[serde(default = "default_telnet_input_newline")]
    pub input_newline: String, // cr | lf | crlf
    #[serde(default = "default_output_newline")]
    pub output_newline: String, // raw | cr | lf | crlf — incoming → CRLF normalization
    #[serde(default)]
    pub local_echo: bool,
    /// Explicit three-state echo policy. `None` means a legacy payload: derive
    /// it from `local_echo` (`true` -> On, `false` -> Off).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub echo_mode: Option<TelnetEchoMode>,
    #[serde(default = "default_backspace")]
    pub backspace: String, // del | bs | csi3 — what Backspace/Delete sends
    #[serde(default)]
    pub login_script: String, // expect/send lines, run on connect
    /// Upload the script inside the already-encrypted remote sync payload.
    /// False scrubs it while preserving any receiving device's local script.
    #[serde(default)]
    pub save_script_to_remote: bool,
    /// Optional group membership — same `groups` table as profiles/forwards.
    #[serde(default)]
    pub group_id: Option<String>,
}

impl TelnetProfile {
    pub fn resolved_echo_mode(&self) -> TelnetEchoMode {
        self.echo_mode.unwrap_or(if self.local_echo {
            TelnetEchoMode::On
        } else {
            // Preserve the pre-echo_mode checkbox semantics for legacy data.
            TelnetEchoMode::Off
        })
    }
}

// --- Dynamic discovery ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DynamicDiscoveryPlatform {
    Docker,
    #[serde(rename = "k8s")]
    K8s,
}

fn default_container_shell() -> String {
    "sh".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "snake_case")]
pub enum DynamicDiscoveryConfig {
    Docker {
        context: String,
        #[serde(default = "default_container_shell")]
        shell: String,
    },
    #[serde(rename = "k8s")]
    K8s {
        context: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default = "default_container_shell")]
        shell: String,
    },
}

impl DynamicDiscoveryConfig {
    pub fn platform(&self) -> DynamicDiscoveryPlatform {
        match self {
            Self::Docker { .. } => DynamicDiscoveryPlatform::Docker,
            Self::K8s { .. } => DynamicDiscoveryPlatform::K8s,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DynamicDiscoverySource {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(flatten)]
    pub config: DynamicDiscoveryConfig,
}

impl DynamicDiscoverySource {
    pub fn platform(&self) -> DynamicDiscoveryPlatform {
        self.config.platform()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DynamicDiscoveryContext {
    pub platform: DynamicDiscoveryPlatform,
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DynamicDiscoveryToolStatus {
    pub platform: DynamicDiscoveryPlatform,
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConnectorSpec {
    DockerExec {
        context: String,
        container_id: String,
        container_name: String,
        shell: String,
    },
    KubectlExec {
        context: String,
        namespace: String,
        pod: String,
        container: Option<String>,
        shell: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DynamicDiscoveredTarget {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    pub platform: DynamicDiscoveryPlatform,
    pub name: String,
    pub sub: String,
    pub connector_spec: ConnectorSpec,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DynamicDiscoveryError {
    pub source_id: String,
    pub source_name: String,
    pub platform: DynamicDiscoveryPlatform,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DynamicDiscoverySnapshot {
    pub targets: Vec<DynamicDiscoveredTarget>,
    pub errors: Vec<DynamicDiscoveryError>,
}

fn default_telnet_port() -> u16 {
    23
}
fn default_telnet_input_newline() -> String {
    "crlf".into()
}

fn default_input_newline() -> String {
    "cr".into()
}
fn default_output_newline() -> String {
    "raw".into()
}
fn default_backspace() -> String {
    "del".into()
}
fn default_input_mode() -> String {
    "normal".into()
}
fn default_output_mode() -> String {
    "text".into()
}

// --- Group ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i32,
    /// Enables terminal waves in the group's color.
    #[serde(default)]
    pub terminal_waves_enabled: bool,
}

// --- Highlight ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightRule {
    pub keyword: String,
    #[serde(default)]
    pub name: String,
    pub color: String,
    pub enabled: bool,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub is_case_sensitive: bool,
}

// --- Snippet ---

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snippet {
    /// 稳定 id（UUID）。旧数据文件可能没有，前端加载时补齐后回写。
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub description: String,
    /// 分组（package 路径，如 "ops/db"）；空 = 未分组。对应 Netcatty snippet.package。
    #[serde(default)]
    pub package: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 快捷键（如 "F1" / "Ctrl + Shift + F1"）；空 = 未绑定。
    #[serde(default)]
    pub shortkey: String,
    /// true = 仅插入、不追加回车执行（对应 Netcatty noAutoRun）。
    #[serde(default)]
    pub no_auto_run: bool,
    /// "snippet" | "script"（对应 Netcatty snippet.kind）；空 = 片段。
    #[serde(default)]
    pub kind: String,
    /// 多行发送方式："paste"（默认一次性）| "lineDelay"（逐行）；空 = paste。
    #[serde(default)]
    pub multi_line_run_mode: String,
    /// 脚本语言标签（对齐 Netcatty language）：空 / "shell" = 发送到会话 shell；
    /// "javascript" / "python" 仅为标签，termX 无对应运行时（UI 置灰说明）。
    #[serde(default)]
    pub language: String,
    /// 触发方式："manual"（空）/ "onConnect" / "onOutput"；阶段 A 只执行 manual。
    #[serde(default)]
    pub trigger: String,
    /// onOutput 的正则模式；阶段 A 只存不执行（输出匹配引擎未移植）。
    #[serde(default)]
    pub trigger_pattern: String,
}

// --- Note ---

/// Vault 笔记（对齐 Netcatty `VaultNote`）：Markdown 正文 + 分组 / 标签 /
/// 关联主机 / 置顶 / 时间戳。阶段 A 只用标题 / 正文 / 分组 / 标签 / 置顶；
/// linked_host_ids 与 order 先在 schema 里留位，阶段 B 接关联主机与排序。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    /// 分组（文件夹路径，如 "ops/db"）；None / 空 = 未分组。
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub linked_host_ids: Vec<String>,
    /// Unix 毫秒。写入时由前端 / 调用方维护。
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// 手动排序位；None = 按更新时间。
    #[serde(default)]
    pub order: Option<i64>,
    #[serde(default)]
    pub is_pinned: bool,
}

// --- Session Log ---

/// 会话日志索引（阶段 A）：`.cast` 文件是唯一事实源，DB 只存扫描出来的元数据。
/// `path` 是 recordings 目录内的裸文件名（不含目录），读取时再拼回目录，
/// 避免把绝对路径暴露给前端 / headless 客户端。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionLog {
    pub id: String,
    pub session_id: String,
    pub host_id: Option<String>,
    pub host_name: String,
    pub title: String,
    pub format: String,
    /// recordings 目录内的纯文件名（不含目录）。
    pub path: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub event_count: i64,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionLogDetail {
    pub log: SessionLog,
    /// asciicast 原始内容（详情页前端自行解析；保留 ANSI）。
    pub content: String,
}

/// 进行中的会话日志录制（阶段 B）。`path` 与 `SessionLog.path` 一样是
/// recordings 目录内的裸文件名，前端只用于状态提示。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionLogRecording {
    pub path: String,
    /// Unix 毫秒。
    pub started_at: i64,
    pub title: String,
}

/// 手动文本会话日志（Netcatty `sessionLog` 的对应能力）：用户选择目标路径，
/// 后端把终端输出写进该文件。与 `SessionLogRecording`（asciicast 录制）无关。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ManualSessionLogStatus {
    /// 用户选择的绝对路径。
    pub path: String,
    /// Unix 毫秒。
    pub started_at: i64,
    /// "raw" | "txt" | "html"。
    pub format: String,
}

// --- Plugin ---

/// A third-party plugin package installed on this machine. `id` doubles as the
/// directory name under `<data_dir>/plugins/`, so it must stay a slug.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// Which host region the plugin UI mounts in: "side" | "strip".
    pub area: String,
    /// Package-relative preview document ("" = none).
    #[serde(default)]
    pub preview: String,
    pub enabled: bool,
    pub installed_at: i64,
    /// Position within its area; the manager page rewrites this on reorder.
    #[serde(default)]
    pub sort_order: i64,
}

/// One-shot remote command result handed to a plugin iframe via the bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// SSH / 本地终端会话结束时经 `ssh:close:<id>` / `pty:close:<id>` 上报的退出信息。
/// `exit_code` 为进程退出码；`signal` 为被信号终止时的信号名（SSH 远端可给，
/// 本地 PTY 的 portable-pty 0.8 不暴露 signal 字段，恒为 None）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

// --- Session Recording ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastHeader {
    pub version: u8,
    pub width: u32,
    pub height: u32,
    pub timestamp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DB credentials.type 列存的就是这套小写字符串——CLI 直接读 DB（AGENT.md P5）。
    /// 改 as_str 字面值 = 数据库里存量 credential 全部解不出。
    #[test]
    fn credential_type_as_str_stable_literals() {
        assert_eq!(CredentialType::Password.as_str(), "password");
        assert_eq!(CredentialType::Key.as_str(), "key");
        assert_eq!(CredentialType::Interactive.as_str(), "interactive");
        assert_eq!(CredentialType::Agent.as_str(), "agent");
        assert_eq!(CredentialType::None.as_str(), "none");
    }

    #[test]
    fn credential_type_roundtrip_through_string() {
        for t in [
            CredentialType::Password,
            CredentialType::Key,
            CredentialType::Interactive,
            CredentialType::Agent,
            CredentialType::None,
        ] {
            assert_eq!(CredentialType::from_str(t.as_str()), t);
        }
    }

    #[test]
    fn credential_type_unknown_falls_back_to_none() {
        // 防御 schema 漂移：DB 里出现未知 type 时不该 panic，
        // 也不该错认成某个有效类型——退到 None 让上层显式处理。
        assert_eq!(CredentialType::from_str(""), CredentialType::None);
        assert_eq!(CredentialType::from_str("bogus"), CredentialType::None);
        assert_eq!(CredentialType::from_str("Password"), CredentialType::None);
        // 大小写敏感
        assert_eq!(CredentialType::from_str("PASSWORD"), CredentialType::None);
    }

    #[test]
    fn validate_name_accepts_normal() {
        assert!(validate_name("prod-web").is_ok());
        assert!(validate_name("生产 1 号").is_ok());
        assert!(validate_name("a:b@c.example").is_ok());
        assert!(validate_name("with spaces").is_ok());
        assert!(validate_name(";semicolons;").is_ok()); // ; 不是 OSC 终止符
    }

    #[test]
    fn validate_name_rejects_empty() {
        assert_eq!(validate_name("").unwrap_err().code(), "name_empty");
    }

    #[test]
    fn validate_name_rejects_esc_and_bel() {
        // ESC \x1b 和 BEL \x07 是 OSC 7337 的关键终止符 —— 注入主战场
        assert_eq!(
            validate_name("evil\x1b]52;c;...\x07").unwrap_err().code(),
            "name_has_control_char"
        );
        assert_eq!(
            validate_name("end\x07start").unwrap_err().code(),
            "name_has_control_char"
        );
    }

    #[test]
    fn validate_name_rejects_other_c0_and_del() {
        // 任何 C0 控制符都拦：NUL / TAB / LF / CR / DEL
        for c in ['\x00', '\t', '\n', '\r', '\x7f'] {
            let s = format!("a{c}b");
            assert_eq!(
                validate_name(&s).unwrap_err().code(),
                "name_has_control_char",
                "char {:?} should be rejected",
                c
            );
        }
    }

    #[test]
    fn credential_type_serde_matches_as_str() {
        // serde 的 rename_all = "lowercase" 必须和 as_str 完全一致——
        // 不一致会让 JSON 序列化和 DB 字符串对不上。
        for t in [
            CredentialType::Password,
            CredentialType::Key,
            CredentialType::Interactive,
            CredentialType::Agent,
            CredentialType::None,
        ] {
            let json = serde_json::to_string(&t).unwrap();
            assert_eq!(json, format!("\"{}\"", t.as_str()));
        }
    }

    #[test]
    fn profile_malformed_algorithms_deserializes_to_default() {
        let p: Profile = serde_json::from_value(serde_json::json!({
            "id": "p1",
            "name": "P1",
            "host": "h.example",
            "port": 22,
            "credential_id": "c1",
            "bastion_profile_id": null,
            "init_command": null,
            "group_id": null,
            "algorithms": { "kex": "not-a-list" }
        }))
        .unwrap();

        assert_eq!(p.algorithms, SshAlgorithms::default());
    }

    #[test]
    fn forward_uses_rules_only_json_contract() {
        let forward = Forward {
            id: "f1".into(),
            name: "database".into(),
            profile_id: "p1".into(),
            group_id: None,
            rules: vec![ForwardRule {
                forward_type: ForwardType::Local,
                local_port: 8080,
                remote_host: "db.internal".into(),
                remote_port: 5432,
                bind_address: String::new(),
            }],
            auto_start: false,
            auto_reconnect: None,
        };

        let json = serde_json::to_value(&forward).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "f1",
                "name": "database",
                "profile_id": "p1",
                "group_id": null,
                "rules": [{
                    "type": "local",
                    "local_port": 8080,
                    "remote_host": "db.internal",
                    "remote_port": 5432,
                    "bind_address": ""
                }],
                "auto_start": false,
                "auto_reconnect": null
            })
        );

        let legacy = serde_json::json!({
            "id": "f1",
            "name": "database",
            "profile_id": "p1",
            "type": "local",
            "local_port": 8080,
            "remote_host": "db.internal",
            "remote_port": 5432
        });
        assert!(serde_json::from_value::<Forward>(legacy).is_err());
    }
}
