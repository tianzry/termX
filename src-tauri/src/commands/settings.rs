use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{HighlightRule, Snippet};
use crate::state::AppState;

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, AppError> {
    if crate::secret::is_secret_setting(&key) {
        return state.secret_store.get(&crate::secret::setting_key(&key));
    }
    crate::db::settings::get(&state.db, &key)
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), AppError> {
    if crate::secret::is_secret_setting(&key) {
        return if value.is_empty() {
            state.secret_store.delete(&crate::secret::setting_key(&key))
        } else {
            state
                .secret_store
                .set(&crate::secret::setting_key(&key), &value)
        };
    }
    crate::db::settings::set(&state.db, &key, &value)
}

#[tauri::command]
pub fn list_highlights(state: State<AppState>) -> Result<Vec<HighlightRule>, AppError> {
    crate::db::highlight::list(&state.db)
}

#[tauri::command]
pub fn add_highlight(state: State<AppState>, rule: HighlightRule) -> Result<(), AppError> {
    crate::db::highlight::insert(&state.db, &rule)
}

#[tauri::command]
pub fn remove_highlight(state: State<AppState>, keyword: String) -> Result<(), AppError> {
    crate::db::highlight::delete_by_keyword(&state.db, &keyword)
}

#[tauri::command]
pub fn update_highlight(
    state: State<AppState>,
    old_keyword: String,
    rule: HighlightRule,
) -> Result<(), AppError> {
    crate::db::highlight::update(&state.db, &old_keyword, &rule)
}

#[tauri::command]
pub fn load_snippets(state: State<AppState>) -> Result<Vec<Snippet>, AppError> {
    crate::db::snippet::load(&state.data_dir)
}

#[tauri::command]
pub fn save_snippets(state: State<AppState>, snippets: Vec<Snippet>) -> Result<(), AppError> {
    crate::db::snippet::save(&state.data_dir, &snippets)
}

#[tauri::command]
pub fn reset_highlights(state: State<AppState>) -> Result<(), AppError> {
    crate::db::highlight::reset_defaults(&state.db)
}

/// 当前 secret 存储后端的名字（"macos-keychain" / "ios-keychain" / "windows-credential-manager" /
/// "linux-secret-service" / "db"）。前端用来显示"凭证存哪儿"。
#[tauri::command]
pub fn secret_backend(state: State<AppState>) -> String {
    state.secret_store.backend_name().to_string()
}

/// 当前数据目录 / DB 路径（设置页系统 tab 用）。
#[derive(serde::Serialize)]
pub struct StorageInfo {
    pub data_dir: String,
    pub db_path: String,
}

#[tauri::command]
pub fn storage_info(state: State<AppState>) -> StorageInfo {
    StorageInfo {
        data_dir: state.data_dir.display().to_string(),
        db_path: crate::db::db_path(&state.data_dir).display().to_string(),
    }
}

/// One installed font family + whether it is monospaced. The frontend uses
/// `monospaced` as a client-side filter (the "monospace only" toggle) and
/// prepends the chosen family to the terminal's base font stack.
#[derive(serde::Serialize)]
pub struct FontInfo {
    pub family: String,
    pub monospaced: bool,
}

/// List installed font families for the terminal-font picker. Collapses faces
/// to families; a family counts as monospaced if any of its faces reports the
/// fixed-pitch flag. Sorted + deduped via BTreeMap. Pure system query — no
/// state, no persistence. WKWebView has no Local Font Access API, so font
/// enumeration must happen here in Rust rather than in the webview.
#[tauri::command]
pub async fn list_fonts() -> Vec<FontInfo> {
    // Enumeration scans the system font dirs and parses face headers — blocking
    // work, so run it off the async runtime's worker threads (keeps other
    // commands responsive). Sync Tauri commands already run off the UI thread,
    // so this is correctness/tidiness, not a UI-freeze fix.
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut families: std::collections::BTreeMap<String, bool> =
            std::collections::BTreeMap::new();
        for face in db.faces() {
            if let Some((name, _)) = face.families.first() {
                *families.entry(name.clone()).or_insert(false) |= face.monospaced;
            }
        }
        families
            .into_iter()
            .map(|(family, monospaced)| FontInfo { family, monospaced })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn list_recordings(state: State<AppState>) -> AppResult<Vec<String>> {
    list_recordings_impl(&state)
}

/// Transport-agnostic body shared by the Tauri command and the headless server.
pub fn list_recordings_impl(state: &AppState) -> AppResult<Vec<String>> {
    let dir = recording_dir(state);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files: Vec<String> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "cast").unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    files.sort_by(|a, b| b.cmp(a)); // newest first
    Ok(files)
}

#[tauri::command]
pub fn read_recording(state: State<AppState>, name: String) -> AppResult<String> {
    read_recording_impl(&state, name)
}

/// 前端「手动会话日志」保存对话框的默认目录（与自动录制同源的 recordings 目录）。
#[tauri::command]
pub fn recordings_dir(state: State<AppState>) -> String {
    recordings_dir_impl(&state)
}

/// Transport-agnostic body shared by the Tauri command and the headless server.
/// 只读：不创建目录，调用方仍可自行选择其它路径。
pub fn recordings_dir_impl(state: &AppState) -> String {
    recording_dir(state).to_string_lossy().into_owned()
}

/// A valid recording name is exactly what `list_recordings_impl` hands back: a
/// bare filename living directly in the recordings dir. Anything carrying path
/// separators, `..`, or an absolute prefix differs from its own `file_name()`,
/// so this one comparison rejects every traversal/escape shape with no special
/// cases.
pub(crate) fn is_safe_recording_name(name: &str) -> bool {
    std::path::Path::new(name).file_name() == Some(std::ffi::OsStr::new(name))
}

/// Transport-agnostic body shared by the Tauri command and the headless server.
pub fn read_recording_impl(state: &AppState, name: String) -> AppResult<String> {
    // Confine reads to the recordings dir. The headless server routes client
    // requests here verbatim, so an unchecked `name` ("../../etc/passwd", an
    // absolute path, …) would read arbitrary files the process can reach.
    if !is_safe_recording_name(&name) {
        return Err(AppError::config(
            "invalid_recording_name",
            serde_json::json!({ "name": name }),
        ));
    }
    let path = recording_dir(state).join(&name);
    std::fs::read_to_string(&path).map_err(|e| {
        AppError::other(
            "settings_read_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })
}

/// Fixed recordings directory: `<data_dir>/recordings` (`~/.termX/recordings` on
/// desktop, the app data dir on Android). Not user-configurable — writes go
/// through `recording_path_for` and reads (`list_recordings`, `read_recording`)
/// resolve here, so they can never disagree on where a `.cast` file lives.
pub fn recording_dir(state: &AppState) -> std::path::PathBuf {
    state.data_dir.join("recordings")
}

/// Reduce a user-controlled profile name to a safe filename component:
/// neutralize separators and dots so it can't inject `..` or extra path
/// segments and escape the recordings dir. The write-side mirror of
/// `is_safe_recording_name`.
fn safe_recording_stem(profile_name: &str) -> String {
    // 含 Windows 保留字符（`: * ? " < > |`）：Telnet 标题形如 `host:port`，
    // 不替换会导致 create 失败、自动录制静默丢失（见 changelogs 踩坑 159）。
    profile_name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '.' | ' ' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect()
}

/// Best-effort: ensure the recordings dir exists and is owner-only on Unix.
/// Recordings can hold sensitive terminal output; a 0755 dir (default umask
/// 022) under a 0755 home would leave them readable by other local users. We
/// reapply 0700 each call (matching `secure_key_tmpdir`) in case it was
/// loosened. Errors are swallowed — recording is best-effort end to end
/// (`Recorder::new(...).ok()`), so a dir hiccup must never abort a connection.
fn ensure_recordings_dir(dir: &std::path::Path) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

/// 用固定 recordings 目录 + 安全文件名 + 本地时间戳生成一次新录制路径，
/// 并确保目录存在（Unix 上为 0700）。自动录制与手动录制共用这一处逻辑，
/// 两条入口不会把 `.cast` 生在不同位置。
pub fn build_recording_path(state: &AppState, name: &str) -> std::path::PathBuf {
    let dir = recording_dir(state);
    ensure_recordings_dir(&dir);
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let stem = safe_recording_stem(name);
    let mut path = dir.join(format!("{stem}_{stamp}.cast"));
    // 同一秒内同名档案可能开多个会话（自动 + 手动）。Recorder 以 truncate
    // 打开文件，重名会静默覆盖上一段日志，因此先探测再在后面加序号。
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}_{stamp}.cast"));
        n += 1;
    }
    path
}

/// 自动会话日志默认命名模板：主机名 + 日期 + 时间。
pub const SESSION_LOG_NAMING_DEFAULT: &str = "{host}_{date}_{time}";

/// 从 设置 → 终端 的 `settings.center.v1` 读取日志目录与命名模板。
/// 目录留空 = `<data_dir>/logs`；模板留空 = `SESSION_LOG_NAMING_DEFAULT`。
/// 读取失败一律回落默认值（记录是 best-effort，不能阻断连接）。
fn session_log_config(state: &AppState) -> (Option<std::path::PathBuf>, String) {
    const SETTINGS_KEY: &str = "settings.center.v1";
    let fallback = (None, SESSION_LOG_NAMING_DEFAULT.to_string());
    let Ok(Some(raw)) = crate::db::settings::get(&state.db, SETTINGS_KEY) else {
        return fallback;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return fallback;
    };
    let logs = &value["sessionLogs"];
    let dir = logs["directory"].as_str().unwrap_or("").trim();
    let template = logs["nameTemplate"].as_str().unwrap_or("").trim();
    (
        if dir.is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(dir))
        },
        if template.is_empty() {
            SESSION_LOG_NAMING_DEFAULT.to_string()
        } else {
            template.to_string()
        },
    )
}

/// 默认日志目录：用户未配置时为 `<data_dir>/logs`（新目录；旧
/// `<data_dir>/recordings` 下的 `.cast` 保持原样，不迁移、不再写入）。
pub fn session_log_dir(state: &AppState) -> std::path::PathBuf {
    match session_log_config(state).0 {
        Some(dir) => dir,
        None => state.data_dir.join("logs"),
    }
}

/// 命名模板占位符 → 实际值，并按文件名规则清洗（去掉路径分隔符、
/// Windows 保留字符与控制字符），保证结果只落在目标目录内。
fn render_session_log_stem(
    template: &str,
    host: &str,
    title: &str,
    protocol: &str,
    now: chrono::DateTime<chrono::Local>,
) -> String {
    let rendered = template
        .replace("{host}", host)
        .replace("{title}", title)
        .replace("{protocol}", protocol)
        .replace("{datetime}", &now.format("%Y%m%d_%H%M%S").to_string())
        .replace("{date}", &now.format("%Y%m%d").to_string())
        .replace("{time}", &now.format("%H%M%S").to_string());
    let cleaned: String = rendered
        .chars()
        .map(|c| match c {
            '/' | '\\' | '.' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('_').trim();
    let mut stem: String = cleaned.chars().take(120).collect();
    // Windows 保留设备名（CON / PRN / AUX / NUL / COM1…）不能作为文件名。
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
    {
        stem = format!("session_{stem}");
    }
    if stem.is_empty() {
        "session".to_string()
    } else {
        stem
    }
}

/// 同名不覆盖：已存在时依次尝试 `<stem>-2.log`、`<stem>-3.log`…
fn unique_session_log_path(dir: &std::path::Path, stem: &str) -> std::path::PathBuf {
    let mut path = dir.join(format!("{stem}.log"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.log"));
        n += 1;
    }
    path
}

/// 按设置的目录 + 命名模板生成一个全新的 `.log` 路径（纯文本日志）。
pub fn build_session_log_path(
    state: &AppState,
    host: &str,
    title: &str,
    protocol: &str,
) -> std::path::PathBuf {
    let (configured_dir, template) = session_log_config(state);
    let dir = configured_dir.unwrap_or_else(|| session_log_dir(state));
    if std::fs::create_dir_all(&dir).is_err() {
        // 自定义目录不可写时退回默认目录，避免自动记录静默丢失。
        let fallback = session_log_dir(state);
        if std::fs::create_dir_all(&fallback).is_ok() {
            let stem = render_session_log_stem(&template, host, title, protocol, chrono::Local::now());
            return unique_session_log_path(&fallback, &stem);
        }
    }
    let stem = render_session_log_stem(&template, host, title, protocol, chrono::Local::now());
    unique_session_log_path(&dir, &stem)
}

/// 主机级自动日志入口：只有档案显式开启 `auto_session_log` 才返回路径。
/// SQLite 读取失败 / 路径构造异常都按「不记录」处理，连接照常建立。
pub fn auto_session_log_path(
    state: &AppState,
    profile: &crate::models::Profile,
) -> Option<std::path::PathBuf> {
    if profile.auto_session_log != Some(true) {
        return None;
    }
    Some(build_session_log_path(
        state,
        &profile.name,
        &profile.name,
        &profile.protocol,
    ))
}

/// 临时连接（无档案）：弹窗显式勾选时才自动记录日志。
pub fn auto_session_log_path_for_temp(
    state: &AppState,
    enabled: bool,
    name: &str,
    protocol: &str,
) -> Option<std::path::PathBuf> {
    if !enabled {
        return None;
    }
    Some(build_session_log_path(state, name, name, protocol))
}

/// 按档案 id 查询自动日志路径（串口 / Telnet 命令只知道 profileId）。
pub fn auto_session_log_path_for_profile_id(
    state: &AppState,
    profile_id: Option<&str>,
) -> Option<std::path::PathBuf> {
    let id = profile_id?.trim();
    if id.is_empty() {
        return None;
    }
    let profile = crate::db::profile::get(&state.db, id).ok()?;
    auto_session_log_path(state, &profile)
}

/// 手动录制的路径：用户点了「开始录制」就应当开始，不受自动记录配置影响。
pub fn recording_path_for_manual(state: &AppState, name: &str) -> AppResult<std::path::PathBuf> {
    Ok(build_recording_path(state, name))
}

/// 设置中心的系统代理（`settings.center.v1` 里的 `networkProxy`）。
///
/// 对齐 Netcatty：只作用于云同步 / AI 等 HTTP(S) 请求，不改变 SSH
/// （SSH 的代理来自主机档案）。`system` = 跟随操作系统 / 环境变量，
/// `direct` = 强制直连，`custom` = 指定 URL + 绕过列表。
fn network_proxy_setting(state: &AppState) -> (String, String, String) {
    const SETTINGS_KEY: &str = "settings.center.v1";
    let raw = match crate::db::settings::get(&state.db, SETTINGS_KEY) {
        Ok(Some(raw)) => raw,
        _ => return ("system".into(), String::new(), String::new()),
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return ("system".into(), String::new(), String::new()),
    };
    let proxy = &value["networkProxy"];
    (
        proxy["mode"].as_str().unwrap_or("system").to_string(),
        proxy["url"].as_str().unwrap_or("").trim().to_string(),
        proxy["bypass"].as_str().unwrap_or("").to_string(),
    )
}

/// 按设置中心的网络代理构造 reqwest 客户端（云同步 / AI 等 HTTP 请求用）。
pub fn http_client(
    state: &AppState,
    builder: reqwest::ClientBuilder,
) -> AppResult<reqwest::Client> {
    let (mode, url, bypass) = network_proxy_setting(state);
    let builder = match mode.as_str() {
        "direct" => builder.no_proxy(),
        "custom" if !url.is_empty() => {
            let mut proxy = reqwest::Proxy::all(&url)
                .map_err(|e| {
                    AppError::config("network_proxy_invalid", serde_json::json!({ "err": e.to_string() }))
                })?;
            if !bypass.trim().is_empty() {
                proxy = proxy.no_proxy(reqwest::NoProxy::from_string(&bypass));
            }
            builder.proxy(proxy)
        }
        // system 或 custom 但 URL 为空：沿用 reqwest 的系统 / 环境变量代理。
        _ => builder,
    };
    builder.build().map_err(|e| {
        AppError::other(
            "http_client_build_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })
}

// ── 开机自启动（设置中心 · 系统 tab）──────────────────────
//
// Windows：写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run（reg.exe，
// CREATE_NO_WINDOW，与 shell_discovery 同一做法，不引入新依赖）。
// 其他平台：supported=false，前端按 Netcatty 文案显示不支持。

#[derive(Debug, Clone, serde::Serialize)]
pub struct AutoLaunchStatus {
    pub supported: bool,
    pub enabled: bool,
}

const AUTO_LAUNCH_VALUE_NAME: &str = "termX";

#[cfg(windows)]
mod auto_launch_impl {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// headless 服务进程（termx-server.exe）不允许登记开机自启，
    /// 否则 Run 键会指向无界面的服务端二进制。
    pub fn is_headless() -> bool {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()))
            .is_some_and(|n| n.contains("-server"))
    }

    fn reg(args: &[&str]) -> Option<(bool, String)> {
        let out = Command::new("reg.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        Some((out.status.success(), stdout))
    }

    pub fn enabled() -> bool {
        let exe = match std::env::current_exe() {
            Ok(p) => p.display().to_string().to_lowercase(),
            Err(_) => return false,
        };
        let Some((_, out)) = reg(&["query", RUN_KEY, "/v", super::AUTO_LAUNCH_VALUE_NAME])
        else {
            return false;
        };
        let out = out.to_lowercase();
        // 值名与路径均按小写比较（注册表值名为 "termX"，直接 contains 会因大小写失配）。
        let value_name = super::AUTO_LAUNCH_VALUE_NAME.to_lowercase();
        // 值存在且指向当前可执行文件才算启用（路径变化时自动失效）。
        out.contains(&value_name) && out.contains(&exe)
    }

    pub fn set(enabled: bool) -> bool {
        if is_headless() {
            return false;
        }
        if enabled {
            let exe = match std::env::current_exe() {
                Ok(p) => format!("\"{}\"", p.display()),
                Err(_) => return false,
            };
            matches!(
                reg(&[
                    "add",
                    RUN_KEY,
                    "/v",
                    super::AUTO_LAUNCH_VALUE_NAME,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &exe,
                    "/f",
                ]),
                Some((true, _))
            )
        } else {
            // 值不存在时 delete 返回非零，也视为达成"关闭"。
            reg(&["delete", RUN_KEY, "/v", super::AUTO_LAUNCH_VALUE_NAME, "/f"]);
            true
        }
    }
}

#[tauri::command]
pub fn get_auto_launch() -> AutoLaunchStatus {
    #[cfg(windows)]
    {
        AutoLaunchStatus {
            supported: true,
            enabled: auto_launch_impl::enabled(),
        }
    }
    #[cfg(not(windows))]
    {
        AutoLaunchStatus {
            supported: false,
            enabled: false,
        }
    }
}

/// 写注册表失败返回 Err（前端据此回读真实状态），不再与"平台不支持"混为
/// supported=false；错误串是机器文案，不直接展示给用户（R5）。
#[tauri::command]
pub fn set_auto_launch(enabled: bool) -> Result<AutoLaunchStatus, String> {
    #[cfg(windows)]
    {
        if auto_launch_impl::is_headless() {
            return Err("auto_launch_unavailable_in_headless".into());
        }
        if !auto_launch_impl::set(enabled) {
            return Err("auto_launch_registry_write_failed".into());
        }
        Ok(AutoLaunchStatus {
            supported: true,
            enabled: auto_launch_impl::enabled(),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(AutoLaunchStatus {
            supported: false,
            enabled: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::{
        build_recording_path, build_session_log_path, is_safe_recording_name, recording_dir,
        render_session_log_stem, safe_recording_stem, session_log_dir,
    };

    #[test]
    fn session_log_naming_defaults_to_host_date_time() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().to_path_buf());
        assert_eq!(session_log_dir(&state), temp.path().join("logs"));
        let path = build_session_log_path(&state, "Prod Web", "Prod Web", "ssh");
        assert_eq!(path.parent(), Some(temp.path().join("logs").as_path()));
        let stem = path.file_stem().unwrap().to_str().unwrap();
        assert!(stem.starts_with("Prod Web_"), "default template: {stem}");
        assert_eq!(path.extension().unwrap(), "log");
    }

    #[test]
    fn session_log_template_placeholders_are_rendered() {
        let now = chrono::Local::now();
        let stem = render_session_log_stem(
            "{protocol}-{host}-{title}-{date}-{time}",
            "srv1",
            "生产库",
            "ssh",
            now,
        );
        assert_eq!(
            stem,
            format!(
                "ssh-srv1-生产库-{}-{}",
                now.format("%Y%m%d"),
                now.format("%H%M%S")
            )
        );
    }

    /// 非法字符清洗后仍必须只是单个文件名（不能借 `..` / 分隔符逃出目录）。
    #[test]
    fn session_log_template_illegal_chars_are_cleaned() {
        let now = chrono::Local::now();
        let stem = render_session_log_stem("../../etc:pass*?<>|", "h", "t", "ssh", now);
        assert!(!stem.contains('/') && !stem.contains('\\') && !stem.contains(':'));
        assert!(!stem.contains(".."));
        assert!(!stem.starts_with('.'));
        assert!(!stem.is_empty());
        let stem = render_session_log_stem("", "h", "t", "ssh", now);
        assert_eq!(stem, "session", "空模板回退 session");
        let stem = render_session_log_stem("CON", "h", "t", "ssh", now);
        assert_eq!(stem, "session_CON");
    }

    /// 同名文件必须加序号，第二段日志不能覆盖第一段。
    #[test]
    fn session_log_paths_never_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().join("fresh"));
        let first = build_session_log_path(&state, "same", "same", "ssh");
        std::fs::write(&first, b"line1\nline2\n").unwrap();
        let second = build_session_log_path(&state, "same", "same", "ssh");
        assert_ne!(first, second);
        assert!(!second.exists());
        assert!(second.file_name().unwrap().to_str().unwrap().ends_with("-2.log"));
    }

    #[test]
    fn session_log_uses_configured_directory_and_template() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().join("fresh"));
        let custom = temp.path().join("custom logs");
        crate::db::settings::set(
            &state.db,
            "settings.center.v1",
            &serde_json::json!({
                "sessionLogs": {
                    "directory": custom.to_string_lossy(),
                    "nameTemplate": "{host}_{protocol}_{date}"
                }
            })
            .to_string(),
        )
        .unwrap();
        let path = build_session_log_path(&state, "129", "129", "ssh");
        assert_eq!(path.parent(), Some(custom.as_path()));
        let stem = path.file_stem().unwrap().to_str().unwrap();
        assert_eq!(
            stem,
            format!("129_ssh_{}", chrono::Local::now().format("%Y%m%d"))
        );
    }

    /// 显式 NULL / false 都视为关闭，只有 Some(true) 才产生路径。
    #[test]
    fn auto_session_log_requires_explicit_true() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().to_path_buf());
        let mut profile: crate::models::Profile = serde_json::from_value(serde_json::json!({
            "id": "p1",
            "name": "alpha",
            "host": "h.example",
            "port": 22,
            "credential_id": "c1"
        }))
        .unwrap();
        assert_eq!(super::auto_session_log_path(&state, &profile), None);
        profile.auto_session_log = Some(false);
        assert_eq!(super::auto_session_log_path(&state, &profile), None);
        profile.auto_session_log = Some(true);
        let path = super::auto_session_log_path(&state, &profile).unwrap();
        assert_eq!(path.extension().unwrap(), "log");
        assert!(path.file_name().unwrap().to_str().unwrap().starts_with("alpha_"));
    }

    /// AppState without a real Tauri app: enough for path construction.
    fn test_state(data_dir: PathBuf) -> crate::state::AppState {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let secret_store: Arc<dyn crate::secret::SecretStore> =
            Arc::new(crate::secret::DbStore::new(db.clone()));
        crate::state::AppState {
            transfer_center: Arc::new(crate::sftp::transfer_center::TransferCenter::new(
                db.clone(),
            )),
            db,
            secret_store,
            lifecycle_sessions: Default::default(),
            sessions: Default::default(),
            #[cfg(desktop)]
            pty_sessions: Default::default(),
            #[cfg(desktop)]
            serial_sessions: Default::default(),
            telnet_sessions: Default::default(),
            sftp_sessions: Default::default(),
            transfer_cancels: Default::default(),
            active_forwards: Default::default(),
            auth_waiters: Default::default(),
            passphrase_waiters: Default::default(),
            host_key_waiters: Default::default(),
            passphrase_cache: Default::default(),
            ai_sessions: Default::default(),
            ai_session_owners: Default::default(),
            ai_remote_shell_cache: Default::default(),
            data_dir,
        }
    }

    #[test]
    fn build_recording_path_creates_missing_recordings_dir() {
        let temp = tempfile::tempdir().unwrap();
        // data_dir 本身也不存在：build 必须自己把 recordings 目录建出来。
        let state = test_state(temp.path().join("fresh"));
        let path = build_recording_path(&state, "prod web");

        let dir = recording_dir(&state);
        assert!(dir.is_dir(), "recordings dir should be created: {dir:?}");
        assert_eq!(path.parent(), Some(dir.as_path()));
        let file = path.file_name().unwrap().to_str().unwrap();
        assert!(
            file.starts_with("prod_web_"),
            "unsafe chars should be neutralized: {file}"
        );
        assert!(is_safe_recording_name(file), "unsafe filename: {file}");
        assert_eq!(path.extension().unwrap(), "cast");
    }

    #[test]
    fn build_recording_path_never_overwrites_existing_cast() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().join("fresh"));
        let first = build_recording_path(&state, "prod web");
        std::fs::write(&first, b"existing log").unwrap();

        let second = build_recording_path(&state, "prod web");
        assert_ne!(first, second, "second recording must not reuse a path");
        assert!(!second.exists(), "second path must be free: {second:?}");
        let file = second.file_name().unwrap().to_str().unwrap();
        assert!(file.starts_with("prod_web-"), "suffix expected: {file}");
        assert!(is_safe_recording_name(file), "unsafe filename: {file}");
    }

    #[test]
    fn accepts_bare_recording_filenames() {
        assert!(is_safe_recording_name("session_20260603_120000.cast"));
        assert!(is_safe_recording_name("my profile_1.cast"));
        assert!(is_safe_recording_name("会话.cast"));
    }

    #[test]
    fn rejects_traversal_and_escapes() {
        // `/`, `..`, and absolute paths escape on every platform. (Backslash is a
        // plain filename char on Unix, so it's intentionally not asserted here.)
        for bad in [
            "",
            ".",
            "..",
            "../secret.cast",
            "../../etc/passwd",
            "sub/dir.cast",
            "/etc/passwd",
            "/abs.cast",
        ] {
            assert!(!is_safe_recording_name(bad), "should reject {bad:?}");
        }
    }

    #[test]
    fn safe_recording_stem_stays_within_recordings_dir() {
        // Whatever a malicious profile name throws at it, the sanitized stem
        // must still pass the read-side guard — i.e. it never grows a path
        // separator or `..` that would escape the recordings dir.
        for evil in [
            "../../etc/passwd",
            "..",
            "sub/dir",
            "back\\slash",
            "with space",
            "normal-name",
            "host:port",
            "a*b?c\"d<e>f|g",
        ] {
            let name = format!("{}.cast", safe_recording_stem(evil));
            assert!(
                is_safe_recording_name(&name),
                "stem escaped for {evil:?}: {name:?}"
            );
            assert!(
                !name.chars().any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')),
                "unsafe filename char survived for {evil:?}: {name:?}"
            );
        }
    }
}
