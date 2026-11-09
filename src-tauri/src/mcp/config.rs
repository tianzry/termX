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
/// 旧模型「始终允许」工具名单：仅供 `grants::load` 一次性迁移使用。
pub const KEY_ALLOWED_TOOLS: &str = "mcp.allowed_tools";
/// Bearer token。持久化后只有手动「轮换」才会更换，改配置/重启 app 都不变。
pub const KEY_TOKEN: &str = "mcp.token";
/// 多客户端：每个 token 对应一个独立客户端（权限档 / 工具白名单）。
pub const KEY_CLIENTS: &str = "mcp.clients";

/// Netcatty 默认端口 47391（`ExternalMcpHttpSection` 默认值），保持同值便于用户迁移。
pub const DEFAULT_PORT: u16 = 47391;
pub const DEFAULT_LISTEN_ADDRESS: &str = "127.0.0.1";
pub const MIN_PORT: u16 = 1024;

/// 与 Netcatty `SafetySettings` 三档一致：
/// - observer：只读工具可用，写操作直接拒绝；
/// - confirm：写操作生成审批项，由渲染层选择允许一次 / 始终允许 / 拒绝；
/// - auto：写操作直接放行。
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

    /// 是否需要重建监听：只有绑定相关参数变化才要重启。
    ///
    /// 权限档位、`client_host`（只影响白名单与 URL 展示）、「始终允许」工具名单等
    /// 纯设置项可原地生效，不应导致监听重启（重启会踢掉已连接客户端）。
    pub fn bind_changed(&self, other: &McpConfig) -> bool {
        self.port != other.port || self.listen_address != other.listen_address
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

pub fn load_token(db: &Db) -> Option<String> {
    settings::get(db, KEY_TOKEN)
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn save_token(db: &Db, token: &str) -> AppResult<()> {
    settings::set(db, KEY_TOKEN, token)
}

/// 一个可接入的 MCP 客户端。`token` 与旧单 token 一样明文存放在本地 settings，
/// 只在 `mcp_status` 里回给本机设置页。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientConfig {
    pub id: String,
    pub label: String,
    pub token: String,
    /// `None` = 回退全局权限档。
    #[serde(default)]
    pub permission_mode: Option<PermissionMode>,
    /// 空 = 允许全部工具；非空时 `tools/list` 与 `tools/call` 都只放行这些名字。
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

/// 认证通过后的请求身份；贯穿 dispatch → tools → session owner。
#[derive(Clone, Debug)]
pub struct McpClient {
    pub id: String,
    pub label: String,
    pub permission_mode: PermissionMode,
    pub allowed_tools: Vec<String>,
}

impl McpClientConfig {
    pub fn normalized(mut self) -> Self {
        self.id = self.id.trim().to_string();
        self.label = self.label.trim().to_string();
        self.token = self.token.trim().to_string();
        self.allowed_tools = self
            .allowed_tools
            .into_iter()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect();
        self
    }

    pub fn resolve(&self, fallback_mode: PermissionMode) -> McpClient {
        McpClient {
            id: self.id.clone(),
            label: self.label.clone(),
            permission_mode: self.permission_mode.unwrap_or(fallback_mode),
            allowed_tools: self.allowed_tools.clone(),
        }
    }
}

pub fn load_clients(db: &Db) -> Vec<McpClientConfig> {
    settings::get(db, KEY_CLIENTS)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<McpClientConfig>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(McpClientConfig::normalized)
        .filter(|c| !c.id.is_empty() && !c.token.is_empty())
        .collect()
}

pub fn save_clients(db: &Db, clients: &[McpClientConfig]) -> AppResult<()> {
    let raw = serde_json::to_string(clients).unwrap_or_else(|_| "[]".to_string());
    settings::set(db, KEY_CLIENTS, &raw)
}

const MAX_CLIENTS: usize = 32;

fn new_client_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 保存前校验并补全：空 token 自动生成；id / token 必须唯一。
pub fn save_clients_checked(
    db: &Db,
    clients: Vec<McpClientConfig>,
) -> Result<Vec<McpClientConfig>, (String, String)> {
    if clients.len() > MAX_CLIENTS {
        return Err((
            "too_many_clients".to_string(),
            format!("最多配置 {MAX_CLIENTS} 个客户端"),
        ));
    }
    let mut out: Vec<McpClientConfig> = Vec::new();
    let legacy_token = load_token(db);
    for raw in clients {
        let mut client = raw.normalized();
        if client.id.is_empty() {
            return Err(("invalid_client_id".to_string(), "客户端 id 不能为空".to_string()));
        }
        if !client
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err((
                "invalid_client_id".to_string(),
                format!("客户端 id {} 只能包含字母、数字、- _ .", client.id),
            ));
        }
        if client.label.is_empty() {
            client.label = client.id.clone();
        }
        if client.token.is_empty() {
            client.token = new_client_token();
        } else if client.token.len() < 16 {
            return Err((
                "invalid_client_token".to_string(),
                format!("客户端 {} 的 token 至少 16 个字符", client.id),
            ));
        }
        if out.iter().any(|c| c.id == client.id) {
            return Err((
                "duplicate_client_id".to_string(),
                format!("客户端 id {} 重复", client.id),
            ));
        }
        if out.iter().any(|c| c.token == client.token) {
            return Err((
                "duplicate_client_token".to_string(),
                format!("客户端 {} 的 token 与其它客户端重复", client.id),
            ));
        }
        if legacy_token.as_deref() == Some(client.token.as_str()) {
            return Err((
                "duplicate_client_token".to_string(),
                format!(
                    "客户端 {} 的 token 与旧版 Bearer token 相同；请换一个或留空自动生成",
                    client.id
                ),
            ));
        }
        out.push(client);
    }
    save_clients(db, &out).map_err(|e| ("save_failed".to_string(), e.to_string()))?;
    Ok(out)
}

/// 未配置多客户端时的兼容身份：沿用旧单 token + 全局权限档。
pub fn default_client(permission_mode: PermissionMode) -> McpClient {
    McpClient {
        id: "default".to_string(),
        label: "默认".to_string(),
        permission_mode,
        allowed_tools: Vec::new(),
    }
}


#[allow(dead_code)]
pub fn load_allowed_tools(db: &Db) -> Vec<String> {
    settings::get(db, KEY_ALLOWED_TOOLS)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

#[allow(dead_code)]
pub fn save_allowed_tools(db: &Db, tools: &[String]) -> AppResult<()> {
    let raw = serde_json::to_string(tools).unwrap_or_else(|_| "[]".to_string());
    settings::set(db, KEY_ALLOWED_TOOLS, &raw)
}

#[allow(dead_code)]
pub fn add_allowed_tool(db: &Db, tool: &str) -> AppResult<()> {
    let mut tools = load_allowed_tools(db);
    if !tools.iter().any(|t| t == tool) {
        tools.push(tool.to_string());
        save_allowed_tools(db, &tools)?;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn remove_allowed_tool(db: &Db, tool: &str) -> AppResult<()> {
    let mut tools = load_allowed_tools(db);
    tools.retain(|t| t != tool);
    save_allowed_tools(db, &tools)
}
