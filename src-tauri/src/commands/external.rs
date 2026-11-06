use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// Open an external http(s) URL in the user's default browser/app.
///
/// Goes through `tauri-plugin-opener` so the same call works on desktop,
/// Android and iOS — on mobile the old `Command::new("open" | "xdg-open" | "cmd")`
/// route had no implementation and the invoke silently failed for users.
///
/// Refuses non-http(s) schemes to prevent abuse (file://, javascript:, …).
/// 同一实现供 Tauri 命令与 headless dispatcher 复用（后者无 `AppHandle`，
/// 走插件的自由函数版本）。
pub fn open_external_url_impl(url: &str) -> AppResult<()> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::config(
            "window_non_https_url",
            serde_json::json!({ "url": url }),
        ));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| {
        AppError::other(
            "window_open_url_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })
}

#[tauri::command]
pub fn open_external_url(_app: AppHandle, url: String) -> AppResult<()> {
    open_external_url_impl(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        let err = open_external_url_impl("file:///etc/passwd").unwrap_err();
        assert_eq!(err.code(), "window_non_https_url");
    }
}
