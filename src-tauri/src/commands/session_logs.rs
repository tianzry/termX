use std::io::BufRead;
use std::path::Path;
use std::time::UNIX_EPOCH;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{SessionLog, SessionLogDetail};
use crate::state::AppState;

// ── 会话日志索引（阶段 A）────────────────────────────────────────
//
// `.cast` 文件是唯一事实源；这里只负责扫描 recordings 目录、把元数据落库，
// 列表 / 详情都从 DB 索引读。Tauri command 与 headless server 共用 `*_impl`，
// 避免两条适配器各自解析一次导致行为分叉（R4 / INV-4）。

const TIMESTAMP_SUFFIX_LEN: usize = 16; // "_YYYYmmdd_HHMMSS"

fn is_timestamp_suffix(suffix: &str) -> bool {
    let bytes = suffix.as_bytes();
    bytes.len() == TIMESTAMP_SUFFIX_LEN
        && bytes[0] == b'_'
        && bytes[1..9].iter().all(u8::is_ascii_digit)
        && bytes[9] == b'_'
        && bytes[10..16].iter().all(u8::is_ascii_digit)
}

/// 文件名 stem 去掉末尾 `_YYYYmmdd_HHMMSS` 后，把 `_` 换成空格作为标题 / 主机名。
/// 只认严格时间戳后缀：用户手工放进来的文件不会被误切。
fn title_from_stem(stem: &str, file_name: &str) -> String {
    let base = stem
        .len()
        .checked_sub(TIMESTAMP_SUFFIX_LEN)
        .filter(|idx| stem.is_char_boundary(*idx))
        .filter(|idx| is_timestamp_suffix(&stem[*idx..]))
        .map(|idx| &stem[..idx])
        .filter(|head| !head.is_empty())
        .unwrap_or(stem);
    let title = base.replace('_', " ").trim().to_string();
    if title.is_empty() {
        file_name.to_string()
    } else {
        title
    }
}

#[derive(Default)]
struct CastStats {
    header_timestamp: Option<i64>,
    event_count: i64,
    last_elapsed: f64,
}

/// 逐行读取 asciicast v2。坏行 / 非 UTF-8 行直接跳过——一个损坏的 cast 不该
/// 让整个「日志」页打不开。文件打不开时返回空统计，调用方继续处理下一个文件。
fn read_cast_stats(path: &Path) -> CastStats {
    let Ok(file) = std::fs::File::open(path) else {
        return CastStats::default();
    };
    let lines = std::io::BufReader::new(file).lines();

    let mut stats = CastStats::default();
    let mut first_content_line = true;
    for line in lines {
        let Ok(line) = line else {
            // 非 UTF-8 行（比如被其它工具写坏）同样跳过。
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if first_content_line {
            first_content_line = false;
            // header 是 JSON object；即便解析失败也不影响事件统计。
            stats.header_timestamp = value.get("timestamp").and_then(|v| v.as_i64());
            continue;
        }
        let Some(event) = value.as_array() else {
            continue;
        };
        if event.len() < 3 {
            continue;
        }
        if let Some(elapsed) = event[0].as_f64() {
            stats.last_elapsed = elapsed;
        }
        if event[1].as_str() == Some("o") {
            stats.event_count += 1;
        }
    }
    stats
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 扫描 recordings 目录并 upsert 索引。目录不存在返回空列表（首次使用即空态）。
pub fn scan_recordings(state: &AppState) -> AppResult<Vec<SessionLog>> {
    let dir = crate::commands::settings::recording_dir(state);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut logs = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path
            .extension()
            .map(|ext| ext == "cast")
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(file_name) = entry.file_name().into_string() else {
            continue;
        };
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(file_name.as_str());
        let title = title_from_stem(stem, &file_name);
        let size_bytes = entry
            .metadata()
            .map(|meta| meta.len() as i64)
            .unwrap_or(0);
        let stats = read_cast_stats(&path);
        let started_at = stats
            .header_timestamp
            .map(|timestamp| timestamp.saturating_mul(1000))
            .unwrap_or_else(|| mtime_ms(&path));
        let duration_ms = (stats.last_elapsed.max(0.0) * 1000.0) as i64;

        let log = SessionLog {
            id: format!("cast:{file_name}"),
            session_id: String::new(),
            host_id: None,
            host_name: title.clone(),
            title,
            format: "asciicast".into(),
            path: file_name,
            started_at,
            ended_at: Some(started_at + duration_ms),
            duration_ms,
            size_bytes,
            event_count: stats.event_count,
            status: "completed".into(),
        };
        crate::db::session_logs::upsert(&state.db, &log)?;
        logs.push(log);
    }
    Ok(logs)
}

/// 把 asciicast 中所有 `"o"` 事件的 chunk 拼成纯文本；ANSI 原样保留，
/// 是否清洗由调用方决定（阶段 A 明确不清洗）。
fn cast_to_text(content: &str) -> String {
    let mut text = String::new();
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(event) = value.as_array() else {
            continue;
        };
        if event.len() < 3 || event[1].as_str() != Some("o") {
            continue;
        }
        if let Some(chunk) = event[2].as_str() {
            text.push_str(chunk);
        }
    }
    text
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn cast_to_html(content: &str) -> String {
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"></head><body><pre>{}</pre></body></html>",
        escape_html(&cast_to_text(content))
    )
}

fn validate_export_format(format: &str) -> AppResult<()> {
    if matches!(format, "cast" | "txt" | "html") {
        return Ok(());
    }
    Err(AppError::config(
        "session_log_format_invalid",
        serde_json::json!({ "format": format }),
    ))
}

pub fn list_session_logs_impl(state: &AppState) -> AppResult<Vec<SessionLog>> {
    scan_recordings(state)?;
    crate::db::session_logs::list(&state.db)
}

pub fn get_session_log_impl(state: &AppState, id: &str) -> AppResult<SessionLogDetail> {
    let log = crate::db::session_logs::get(&state.db, id)?;
    // path 必须仍是裸文件名——DB 内容可能被旧版本 / 手工编辑污染，
    // 读文件前用同一套安全校验挡住目录穿越（与 read_recording 一致）。
    if !crate::commands::settings::is_safe_recording_name(&log.path) {
        return Err(AppError::config(
            "invalid_recording_name",
            serde_json::json!({ "name": &log.path }),
        ));
    }
    let full = crate::commands::settings::recording_dir(state).join(&log.path);
    let content = std::fs::read_to_string(&full).map_err(|e| {
        AppError::other(
            "session_log_read_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })?;
    Ok(SessionLogDetail { log, content })
}

pub fn export_session_log_impl(state: &AppState, id: &str, format: &str) -> AppResult<String> {
    validate_export_format(format)?;
    let detail = get_session_log_impl(state, id)?;
    match format {
        "cast" => Ok(detail.content),
        "txt" => Ok(cast_to_text(&detail.content)),
        // 校验已限定集合，剩余分支只可能是 html。
        _ => Ok(cast_to_html(&detail.content)),
    }
}

pub fn delete_session_log_impl(state: &AppState, id: &str) -> AppResult<()> {
    let log = crate::db::session_logs::get(&state.db, id)?;
    if !crate::commands::settings::is_safe_recording_name(&log.path) {
        return Err(AppError::config(
            "invalid_recording_name",
            serde_json::json!({ "name": &log.path }),
        ));
    }
    let full = crate::commands::settings::recording_dir(state).join(&log.path);
    match std::fs::remove_file(&full) {
        Ok(()) => {}
        // 文件已经不在了（用户手工删过）不算失败；索引仍要清掉。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(AppError::other(
                "session_log_delete_failed",
                serde_json::json!({ "err": e.to_string() }),
            ))
        }
    }
    crate::db::session_logs::delete(&state.db, id)
}

// ── Tauri commands（薄包装，headless 直接调上面的 `*_impl`）─────────

#[tauri::command]
pub fn list_session_logs(state: State<'_, AppState>) -> AppResult<Vec<SessionLog>> {
    list_session_logs_impl(&state)
}

#[tauri::command]
pub fn get_session_log(state: State<'_, AppState>, id: String) -> AppResult<SessionLogDetail> {
    get_session_log_impl(&state, &id)
}

#[tauri::command]
pub fn export_session_log(
    state: State<'_, AppState>,
    id: String,
    format: String,
) -> AppResult<String> {
    export_session_log_impl(&state, &id, &format)
}

#[tauri::command]
pub fn delete_session_log(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_session_log_impl(&state, &id)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::*;

    fn test_state(data_dir: PathBuf) -> AppState {
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let secret_store: Arc<dyn crate::secret::SecretStore> =
            Arc::new(crate::secret::DbStore::new(db.clone()));
        AppState {
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

    fn write_cast(dir: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    const CAST: &str = "{\"version\":2,\"width\":80,\"height\":24,\"timestamp\":1700000000}\n\
                         [0.5,\"o\",\"hello \\u001b[31mred\\u001b[0m <b>&\"]\n\
                         [2.0,\"o\",\" world\"]\n";

    #[test]
    fn scan_derives_title_duration_and_event_count() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().to_path_buf());
        write_cast(
            &crate::commands::settings::recording_dir(&state),
            "prod_web_20260603_120000.cast",
            CAST,
        );

        let logs = scan_recordings(&state).unwrap();
        assert_eq!(logs.len(), 1);
        let log = &logs[0];
        assert_eq!(log.id, "cast:prod_web_20260603_120000.cast");
        assert_eq!(log.path, "prod_web_20260603_120000.cast");
        assert_eq!(log.title, "prod web");
        assert_eq!(log.host_name, "prod web");
        assert_eq!(log.started_at, 1_700_000_000_000);
        assert_eq!(log.duration_ms, 2000);
        assert_eq!(log.ended_at, Some(1_700_000_002_000));
        assert_eq!(log.event_count, 2);
        assert_eq!(log.status, "completed");
    }

    #[test]
    fn scan_skips_bad_lines_instead_of_failing() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().to_path_buf());
        write_cast(
            &crate::commands::settings::recording_dir(&state),
            "broken_20260603_120000.cast",
            "{\"version\":2,\"width\":80,\"height\":24,\"timestamp\":1700000001}\nnot json\n[1.5,\"o\",\"ok\"]\n",
        );

        let logs = scan_recordings(&state).unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].event_count, 1);
        assert_eq!(logs[0].duration_ms, 1500);
    }

    #[test]
    fn export_txt_keeps_raw_ansi_and_html_escapes_markup() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().to_path_buf());
        write_cast(
            &crate::commands::settings::recording_dir(&state),
            "prod_web_20260603_120000.cast",
            CAST,
        );
        scan_recordings(&state).unwrap();
        let id = "cast:prod_web_20260603_120000.cast";

        let txt = export_session_log_impl(&state, id, "txt").unwrap();
        assert!(txt.contains("\u{1b}[31mred\u{1b}[0m"));
        assert!(txt.contains("hello "));
        assert!(txt.contains("<b>&"));

        let html = export_session_log_impl(&state, id, "html").unwrap();
        assert!(html.contains("<meta charset=\"utf-8\">"));
        assert!(html.contains("&lt;b&gt;&amp;"));
        assert!(!html.contains("<b>&"));
        assert!(html.contains("\u{1b}[31mred\u{1b}[0m"));
    }

    #[test]
    fn export_rejects_unsupported_format() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().to_path_buf());
        write_cast(
            &crate::commands::settings::recording_dir(&state),
            "prod_web_20260603_120000.cast",
            CAST,
        );
        scan_recordings(&state).unwrap();
        let id = "cast:prod_web_20260603_120000.cast";

        assert_eq!(
            export_session_log_impl(&state, id, "pdf")
                .unwrap_err()
                .code(),
            "session_log_format_invalid"
        );
    }

    #[test]
    fn delete_removes_file_and_index() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(temp.path().to_path_buf());
        let dir = crate::commands::settings::recording_dir(&state);
        write_cast(&dir, "prod_web_20260603_120000.cast", CAST);
        scan_recordings(&state).unwrap();

        let id = "cast:prod_web_20260603_120000.cast";
        delete_session_log_impl(&state, id).unwrap();
        assert!(!dir.join("prod_web_20260603_120000.cast").exists());
        assert_eq!(
            crate::db::session_logs::get(&state.db, id).unwrap_err().code(),
            "session_log_not_found"
        );
    }

    #[test]
    fn title_strips_only_exact_timestamp_suffix() {
        assert_eq!(
            title_from_stem("prod_web_20260603_120000", "prod_web_20260603_120000.cast"),
            "prod web"
        );
        assert_eq!(
            title_from_stem("prod_web_2026", "prod_web_2026.cast"),
            "prod web 2026"
        );
        assert_eq!(title_from_stem("", ".cast"), ".cast");
    }
}
