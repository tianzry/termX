use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

// ── 设置中心 · 外观：原生窗口外观 ──────────────────────────
//
// Netcatty（Electron）用 BrowserWindow.setOpacity 做整窗透明度、macOS
// vibrancy 做毛玻璃、app.dock/app icon 切换图标。termX 是 Tauri，等价实现：
// - 透明度：Windows 走 WS_EX_LAYERED + SetLayeredWindowAttributes（与
//   Electron 同一套 Win32 机制；不是 CSS 近似），其余平台 no-op；
// - 毛玻璃：仅 macOS 用原生 HudWindow vibrancy，Windows/Linux 不渲染该行
//   （与 Netcatty 的 `isMac &&` 条件一致）；
// - 图标：把对应变体 PNG 通过 Tauri `set_icon` 应用到所有窗口（任务栏生效）。

const APP_ICON_VARIANTS: [(&str, &[u8]); 12] = [
    ("original", include_bytes!("../../icons/variants/original.png")),
    ("bright", include_bytes!("../../icons/variants/bright.png")),
    ("dark", include_bytes!("../../icons/variants/dark.png")),
    ("colorful", include_bytes!("../../icons/variants/colorful.png")),
    ("high-contrast", include_bytes!("../../icons/variants/high-contrast.png")),
    ("white-navy", include_bytes!("../../icons/variants/white-navy.png")),
    ("white-sky", include_bytes!("../../icons/variants/white-sky.png")),
    ("white-rose", include_bytes!("../../icons/variants/white-rose.png")),
    ("white-emerald", include_bytes!("../../icons/variants/white-emerald.png")),
    ("white-amber", include_bytes!("../../icons/variants/white-amber.png")),
    ("white-violet", include_bytes!("../../icons/variants/white-violet.png")),
    ("rainbow", include_bytes!("../../icons/variants/rainbow.png")),
];

/// 整窗不透明度（0.5~1，与 Netcatty clampWindowOpacity 同范围）。
#[tauri::command]
pub fn set_window_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    let clamped = opacity.clamp(0.5, 1.0);
    #[cfg(windows)]
    {
        let alpha = (clamped * 255.0).round() as u8;
        for (_, win) in app.webview_windows() {
            if let Err(e) = apply_windows_layered_alpha(&win, alpha) {
                return Err(e);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, clamped);
    }
    Ok(())
}

#[cfg(windows)]
fn apply_windows_layered_alpha(win: &tauri::WebviewWindow, alpha: u8) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetLayeredWindowAttributes, SetWindowLongW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };

    let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as isize as HWND;
    // SAFETY: hwnd 来自当前进程存活的 Tauri 窗口；调用的是 Win32 已知 API。
    unsafe {
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if ex_style & (WS_EX_LAYERED as i32) == 0 {
            SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED as i32);
        }
        SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
    }
    Ok(())
}

/// 毛玻璃背景（macOS 原生 vibrancy；其它平台 no-op，设置行也不渲染）。
#[tauri::command]
pub fn set_window_background_blur(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::utils::config::{WindowEffect, WindowEffectsConfig};
        let effects = if enabled {
            Some(WindowEffectsConfig {
                effects: vec![WindowEffect::HudWindow],
                state: None,
                radius: None,
                color: None,
            })
        } else {
            Some(WindowEffectsConfig {
                effects: vec![],
                state: None,
                radius: None,
                color: None,
            })
        };
        for (_, win) in app.webview_windows() {
            win.set_effects(effects.clone()).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, enabled);
    }
    Ok(())
}

/// 应用图标变体：每个窗口 set_icon（任务栏 / 窗口图标即时生效）。
#[tauri::command]
pub fn set_app_icon_variant(app: AppHandle, variant: String) -> Result<(), String> {
    let bytes = APP_ICON_VARIANTS
        .iter()
        .find(|(id, _)| *id == variant)
        .or_else(|| APP_ICON_VARIANTS.iter().find(|(id, _)| *id == "original"))
        .map(|(_, bytes)| *bytes)
        .ok_or_else(|| "app_icon_variant_missing".to_string())?;
    let icon = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    for (_, win) in app.webview_windows() {
        win.set_icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

use crate::error::{AppError, AppResult};

/// Encode the frontend clone payload as a JavaScript string literal.
///
/// The frontend reads `window.__rssh_clone` as a string and parses it once
/// during startup, so the JSON payload must remain quoted in the script.
fn clone_init_script(clone: &str) -> AppResult<String> {
    let json_literal = serde_json::to_string(clone).map_err(|e| {
        AppError::other(
            "window_clone_encode_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })?;
    Ok(format!("window.__rssh_clone = {};", json_literal))
}

/// Open a new in-process Tauri window with a clone payload.
///
/// The new window boots the same frontend; `AppShell` reads
/// `window.__rssh_clone` on mount and auto-creates the cloned tab. Windows
/// share `AppState` (sessions, DB, PTY registry) via `Arc<Mutex<..>>`, so
/// spawning a new window is cheap and does not fork the backend.
///
/// MUST stay `async`: on Windows, `WebviewWindowBuilder::build()` deadlocks
/// when called from a synchronous command because WebView2 needs the main
/// thread's message loop to create the webview controller. Async commands run
/// off the main event-loop thread, so the build completes.
#[tauri::command]
pub async fn open_tab_in_new_window(app: AppHandle, clone: String) -> AppResult<()> {
    let init_script = clone_init_script(&clone)?;
    let label = format!("rssh-{}", Uuid::new_v4().simple());
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("RSSH")
        .inner_size(1200.0, 800.0)
        .initialization_script(&init_script)
        .build()
        .map_err(|e| {
            AppError::other(
                "window_open_failed",
                serde_json::json!({ "err": e.to_string() }),
            )
        })?;
    Ok(())
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn clone_payload_becomes_quoted_init_script() {
        let clone = r#"{"type":"ssh","label":"prod"}"#;
        let script = clone_init_script(clone).unwrap();
        assert_eq!(
            script,
            r#"window.__rssh_clone = "{\"type\":\"ssh\",\"label\":\"prod\"}";"#
        );
    }

    #[test]
    fn clone_payload_escapes_script_sensitive_text() {
        let clone = "{\"label\":\"line\nquote \\\"\"}";
        let script = clone_init_script(clone).unwrap();
        let literal = script
            .strip_prefix("window.__rssh_clone = ")
            .and_then(|value| value.strip_suffix(';'))
            .unwrap();
        assert_eq!(serde_json::from_str::<String>(literal).unwrap(), clone);
    }
}

/// One `arboard::Clipboard` for the whole process, created lazily.
///
/// On X11 the clipboard is a *selection ownership* protocol, not a store: the
/// process that wrote the text must stay alive to serve other apps' (and our
/// own paste's) `SelectionRequest`s. arboard owns the CLIPBOARD selection only
/// while at least one `Clipboard` instance is alive; the last one to drop tears
/// down its X11 window and hands the data off to a clipboard manager on a
/// best-effort basis — a race it usually loses ("Clipboard was dropped very
/// quickly after writing"). Creating a fresh `Clipboard` per call therefore
/// relinquished the selection the instant the call returned, so the next paste
/// read an empty clipboard.
///
/// Keeping one instance alive for the process lifetime means we stay the
/// selection owner: reads short-circuit to local data and external pastes are
/// served, with no per-call teardown/handoff race. `Clipboard` is `Send + Sync`
/// on every desktop platform, so a `static` behind a `Mutex` is sound.
static CLIPBOARD: std::sync::OnceLock<std::sync::Mutex<Option<arboard::Clipboard>>> =
    std::sync::OnceLock::new();

/// Run `op` against the process-wide clipboard, creating it on first use.
fn with_clipboard<R>(
    op: &'static str,
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<R, arboard::Error>,
) -> AppResult<R> {
    let cell = CLIPBOARD.get_or_init(|| std::sync::Mutex::new(None));
    // A panic while holding the lock can't leave the clipboard in an unsafe
    // state, so recover from poisoning rather than failing the operation.
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(arboard::Clipboard::new().map_err(|e| {
            AppError::other(
                "window_clipboard_failed",
                serde_json::json!({ "op": "init", "err": e.to_string() }),
            )
        })?);
    }
    let cb = guard.as_mut().expect("clipboard initialized above");
    f(cb).map_err(|e| {
        AppError::other(
            "window_clipboard_failed",
            serde_json::json!({ "op": op, "err": e.to_string() }),
        )
    })
}

/// Read the system clipboard as text.
/// Goes through Rust (arboard) to bypass WebKit's permission prompt on
/// externally-sourced clipboard content — `navigator.clipboard.readText()`
/// pops a dialog every time on macOS unless the content was written by the
/// same page in this session.
#[tauri::command]
pub fn clipboard_read() -> AppResult<String> {
    with_clipboard("read", |cb| cb.get_text())
}

/// Write text to the system clipboard.
/// Mirrors `clipboard_read`: goes through Rust (arboard) because in the
/// WKWebView `navigator.clipboard.writeText` is unreliable from a right-click
/// (contextmenu) / unfocused context — it silently rejects.
#[tauri::command]
pub fn clipboard_write(text: String) -> AppResult<()> {
    with_clipboard("write", |cb| cb.set_text(text))
}
