//! 对外 MCP（Settings → AI → 工具接入）的配置层。
//!
//! 对齐 Netcatty `infrastructure/config/storageKeys.ts` 的 `aiExternalMcp*` 语义：
//! 开关 / 端口 / 监听地址 / 客户端 host / 权限档位。termX 落到通用 settings 表，
//! 不新增表因此 **不需要提升 SCHEMA_VERSION**（这是与 Netcatty localStorage 的差异点）。

use serde::{Deserialize, Serialize};

use crate::db::{settings, Db};
use crate::error::AppResult;

pub const KEY_ENABLED: &str = "mcp.enabled";
pub const KEY_PORT: &str = "mcp.port";
pub const KEY_ALLOW_CUSTOM_BIND: &str = "mcp.allow_custom_bind";
pub const KEY_LISTEN_ADDRESS: &str = "mcp.listen_address";
pub const KEY_CLIENT_HOST: &str = "mcp.client_host";
pub const KEY_PERMISSION_MODE: &str = "mcp.permission_mode";

/// Netcatty 默认端口 47391（`ExternalMcpHttpSection` 默认值），保持同值便于用户迁移。
pub const DEFAULT_PORT: u16 = 47391;
pub const DEFAULT_LISTEN_ADDRESS: &str = "127.0.0.1";
pub const MIN_PORT: u16 = 1024;

/// 与 Netcatty `SafetySettings` 三档一致。差异：termX 本阶段没有审批卡片 UI，
/// `confirm` 对写操作按拒绝处理（详见 docs/mcp-port-plan.md「不做的部分」）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    Observer,
    Confirm,
    Auto,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionMode::Observer => "observer",
            PermissionMode::Confirm => "confirm",
            PermissionMode::Auto => "auto",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto" => PermissionMode::Auto,
            "observer" => PermissionMode::Observer,
            _ => PermissionMode::Confirm,
        }
    }

    /// 写工具是否直接放行。`confirm` 需要审批交互，本阶段没有该 UI → 视作拒绝。
    pub fn allows_write(self) -> bool {
        matches!(self, PermissionMode::Auto)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    pub allow_custom_bind: bool,
    pub listen_address: String,
    /// 生成对外连接信息时使用的客户端 host（默认取监听地址）。
    pub client_host: String,
    pub permission_mode: PermissionMode,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            allow_custom_bind: false,
            listen_address: DEFAULT_LISTEN_ADDRESS.to_string(),
            client_host: String::new(),
            permission_mode: PermissionMode::Confirm,
        }
    }
}

impl McpConfig {
    pub fn token_url(&self, token: Option<&str>) -> Option<String> {
        let host = if self.client_host.trim().is_empty() {
            self.listen_address.as_str()
        } else {
            self.client_host.trim()
        };
        let _ = token;
        Some(format!("http://{host}:{}/mcp", self.port))
    }

    pub fn effective_client_host(&self) -> &str {
        let host = self.client_host.trim();
        if host.is_empty() {
            self.listen_address.as_str()
        } else {
            host
        }
    }
}

fn bool_of(db: &Db, key: &str, fallback: bool) -> bool {
    match settings::get(db, key) {
        Ok(Some(v)) => matches!(v.trim(), "1" | "true" | "TRUE" | "True"),
        _ => fallback,
    }
}

pub fn load(db: &Db) -> McpConfig {
    let defaults = McpConfig::default();
    let port = settings::get(db, KEY_PORT)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p >= MIN_PORT)
        .unwrap_or(defaults.port);
    let listen_address = settings::get(db, KEY_LISTEN_ADDRESS)
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| defaults.listen_address.clone());
    let client_host = settings::get(db, KEY_CLIENT_HOST)
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let permission_mode = settings::get(db, KEY_PERMISSION_MODE)
        .ok()
        .flatten()
        .map(|v| PermissionMode::parse(&v))
        .unwrap_or(defaults.permission_mode);

    McpConfig {
        enabled: bool_of(db, KEY_ENABLED, defaults.enabled),
        port,
        allow_custom_bind: bool_of(db, KEY_ALLOW_CUSTOM_BIND, defaults.allow_custom_bind),
        listen_address,
        client_host,
        permission_mode,
    }
}

pub fn save(db: &Db, cfg: &McpConfig) -> AppResult<()> {
    settings::set(db, KEY_ENABLED, if cfg.enabled { "1" } else { "0" })?;
    settings::set(db, KEY_PORT, &cfg.port.to_string())?;
    settings::set(
        db,
        KEY_ALLOW_CUSTOM_BIND,
        if cfg.allow_custom_bind { "1" } else { "0" },
    )?;
    settings::set(db, KEY_LISTEN_ADDRESS, &cfg.listen_address)?;
    settings::set(db, KEY_CLIENT_HOST, &cfg.client_host)?;
    settings::set(db, KEY_PERMISSION_MODE, cfg.permission_mode.as_str())?;
    Ok(())
}

/// 返回 (error_code, message)。对齐 Netcatty `invalid_address / port_in_use` 的错误码风格。
pub fn validate(cfg: &McpConfig) -> Result<(), (String, String)> {
    if cfg.port < MIN_PORT {
        return Err((
            "invalid_port".to_string(),
            format!("端口必须大于等于 {MIN_PORT}"),
        ));
    }
    let addr = cfg.listen_address.trim();
    if addr.is_empty() {
        return Err((
            "invalid_address".to_string(),
            "监听地址不能为空".to_string(),
        ));
    }
    let loopback = matches!(addr, "127.0.0.1" | "localhost" | "::1");
    if !loopback && !cfg.allow_custom_bind {
        return Err((
            "custom_bind_disabled".to_string(),
            "绑定非回环地址需要先打开「允许自定义绑定」".to_string(),
        ));
    }
    Ok(())
}

/// 允许的 Host / Origin 白名单：本机回环 + 用户填写的 client host。
pub fn allowed_hosts(cfg: &McpConfig) -> Vec<String> {
    let mut hosts = vec![
        "127.0.0.1".to_string(),
        "localhost".to_string(),
        "::1".to_string(),
    ];
    let custom = cfg.effective_client_host().to_string();
    if !custom.is_empty() && !hosts.contains(&custom) {
        hosts.push(custom);
    }
    hosts
}
