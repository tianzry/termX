//! Update / release-tag check.
//!
//! Cross-platform: only uses `reqwest`, no system integration. About-screen
//! and any future "new version available" UI lives here. Kept separate from
//! `commands::window` (desktop-only system-window plumbing).
//!
//! Two sources:
//! - `fetch_latest_release_tag`: GitHub HTML redirect (legacy, tag only).
//! - `check_update`: Tauri-updater-compatible `latest.json` (version + notes +
//!   per-platform artifact url/signature). The download/install half stays
//!   disabled until the app ships a signing pubkey + release pipeline; see
//!   `docs` in changelogs. The endpoint may be overridden with
//!   `TERMX_UPDATE_ENDPOINT` for a local/self-hosted release feed.

use std::collections::HashMap;

use crate::error::{error_chain, AppError, AppResult};

/// Production feed: the GitHub release asset `latest.json` published by CI.
const DEFAULT_ENDPOINT: &str =
    "https://github.com/tianzry/termX/releases/latest/download/latest.json";

/// 当前构建对应的 Tauri `platforms` 键（与 updater 约定一致）。
fn platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "windows-x86_64";
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return "windows-aarch64";
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "darwin-aarch64";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "darwin-x86_64";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "linux-x86_64";
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return "linux-aarch64";
    }
    #[allow(unreachable_code)]
    "unknown"
}

/// Strip a leading `v` / `V` so `v1.2.3` and `1.2.3` compare equal.
fn strip_v(version: &str) -> &str {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
}

/// Compare two dotted versions. A version with a pre-release suffix is older
/// than the same core version without one (`1.0.0-beta` < `1.0.0`).
fn version_gt(latest: &str, current: &str) -> bool {
    let (latest_core, latest_pre) = match strip_v(latest).split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (strip_v(latest), None),
    };
    let (current_core, current_pre) = match strip_v(current).split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (strip_v(current), None),
    };
    let parse = |core: &str| -> Vec<u64> {
        core.split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let l = parse(latest_core);
    let c = parse(current_core);
    for i in 0..l.len().max(c.len()) {
        let lv = l.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if lv != cv {
            return lv > cv;
        }
    }
    match (latest_pre, current_pre) {
        (None, Some(_)) => true,  // release > pre-release
        (Some(_), None) => false, // pre-release < release
        _ => false,               // identical core + both pre / both release
    }
}

#[derive(Debug, serde::Deserialize)]
struct LatestManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    #[serde(default)]
    platforms: HashMap<String, PlatformArtifact>,
}

#[derive(Debug, serde::Deserialize)]
struct PlatformArtifact {
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// Result surfaced to the settings update section.
#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct UpdateCheckResult {
    current_version: String,
    latest_version: String,
    available: bool,
    /// 当前构建平台在 feed 里有对应产物（缺失时只能手动下载）。
    platform_supported: bool,
    platform: String,
    notes: Option<String>,
    pub_date: Option<String>,
    url: Option<String>,
    signature: Option<String>,
    endpoint: String,
}

/// Fetch a Tauri-updater `latest.json` and compare against `current_version`.
/// Read-only: never downloads or installs. `endpoint` is optional so callers
/// can point at a local/self-hosted feed; otherwise the env override and the
/// production GitHub asset are used in that order.
#[tauri::command]
pub async fn check_update(
    endpoint: Option<String>,
    current_version: String,
) -> AppResult<UpdateCheckResult> {
    let endpoint = endpoint
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("TERMX_UPDATE_ENDPOINT")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
    let parsed = reqwest::Url::parse(&endpoint).map_err(|e| {
        AppError::config(
            "update_invalid_endpoint",
            serde_json::json!({ "endpoint": endpoint, "err": e.to_string() }),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::config(
            "update_invalid_endpoint",
            serde_json::json!({ "endpoint": endpoint, "err": "scheme must be http(s)" }),
        ));
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("rssh/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| {
            AppError::other(
                "update_http_failed",
                serde_json::json!({ "op": "client", "err": error_chain(&e) }),
            )
        })?;

    let resp = client.get(parsed).send().await.map_err(|e| {
        AppError::other(
            "update_http_failed",
            serde_json::json!({ "op": "request", "err": error_chain(&e) }),
        )
    })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::other(
            "update_http_status",
            serde_json::json!({ "status": status.to_string(), "endpoint": endpoint }),
        ));
    }
    let manifest: LatestManifest = resp.json().await.map_err(|e| {
        AppError::other(
            "update_invalid_json",
            serde_json::json!({ "endpoint": endpoint, "err": error_chain(&e) }),
        )
    })?;
    if strip_v(&manifest.version).is_empty() {
        return Err(AppError::other(
            "update_missing_version",
            serde_json::json!({ "endpoint": endpoint }),
        ));
    }

    let platform = platform_key().to_string();
    let artifact = manifest.platforms.get(&platform);
    let latest_version = strip_v(&manifest.version).to_string();
    Ok(UpdateCheckResult {
        current_version: current_version.clone(),
        latest_version: latest_version.clone(),
        available: version_gt(&latest_version, &current_version),
        platform_supported: artifact.is_some(),
        platform,
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        url: artifact.and_then(|a| a.url.clone()),
        signature: artifact.and_then(|a| a.signature.clone()),
        endpoint,
    })
}

/// Fetch the latest release tag from a GitHub repo.
///
/// Hits the HTML page `https://github.com/{repo}/releases/latest` rather than
/// the JSON API. GitHub responds with a 302 redirect whose Location is
/// `/{repo}/releases/tag/<tag>` — we parse the tag from there.
///
/// Why not the API: `api.github.com` enforces a 60 req/h per-IP limit for
/// unauthenticated calls. Behind shared NAT (offices, VPNs) the quota is
/// burned by other users and we get HTTP 403. The HTML redirect path has no
/// such limit and no auth requirement.
///
/// `repo` must be of the form "owner/name". Returns the raw tag (e.g. "v1.2.3").
#[tauri::command]
pub async fn fetch_latest_release_tag(repo: String) -> AppResult<String> {
    if repo.is_empty() || !repo.contains('/') || repo.contains(char::is_whitespace) {
        return Err(AppError::config(
            "update_invalid_repo",
            serde_json::json!({ "repo": repo }),
        ));
    }
    let url = format!("https://github.com/{repo}/releases/latest");
    let client = reqwest::Client::builder()
        .user_agent(concat!("rssh/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            AppError::other(
                "update_http_failed",
                serde_json::json!({ "op": "client", "err": error_chain(&e) }),
            )
        })?;

    let resp = client.get(&url).send().await.map_err(|e| {
        AppError::other(
            "update_http_failed",
            serde_json::json!({ "op": "request", "err": error_chain(&e) }),
        )
    })?;

    let status = resp.status();
    if !status.is_redirection() {
        return Err(AppError::other(
            "update_redirect_status",
            serde_json::json!({ "status": status.to_string(), "body": "expected redirect" }),
        ));
    }
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::other("update_redirect_no_location", serde_json::json!({})))?;

    // Location is like "/owner/repo/releases/tag/v1.2.3" or full URL.
    location
        .rsplit_once("/releases/tag/")
        .map(|(_, tag)| tag.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            AppError::other(
                "update_unexpected_redirect",
                serde_json::json!({ "location": location }),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_handles_v_prefix_and_prerelease() {
        assert!(version_gt("0.0.2", "0.0.1"));
        assert!(version_gt("v1.2.0", "1.1.9"));
        assert!(!version_gt("v1.2.0", "1.2.0"));
        assert!(!version_gt("1.2.0", "1.2.0"));
        assert!(version_gt("1.0.0", "1.0.0-beta"));
        assert!(!version_gt("1.0.0-beta", "1.0.0"));
        assert!(version_gt("2.0", "1.9.9"));
        assert!(!version_gt("1.2.0-beta.2", "1.2.0-beta.1"));
    }

    #[test]
    fn manifest_parses_tauri_updater_shape() {
        let raw = r#"{
          "version": "v0.0.2",
          "notes": "local feed test",
          "pub_date": "2026-11-05T00:00:00Z",
          "platforms": {
            "windows-x86_64": {
              "signature": "dW50cnVzdGVk",
              "url": "http://127.0.0.1:8081/termX_0.0.2_x64-setup.nsis.zip"
            }
          }
        }"#;
        let manifest: LatestManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(manifest.version, "v0.0.2");
        let entry = manifest.platforms.get("windows-x86_64").unwrap();
        assert_eq!(entry.signature.as_deref(), Some("dW50cnVzdGVk"));
        assert!(entry.url.is_some());
        assert!(manifest.platforms.get("linux-x86_64").is_none());
    }

    #[test]
    fn platform_key_matches_tauri_naming() {
        let key = platform_key();
        assert!(matches!(
            key,
            "windows-x86_64"
                | "windows-aarch64"
                | "darwin-aarch64"
                | "darwin-x86_64"
                | "linux-x86_64"
                | "linux-aarch64"
                | "unknown"
        ));
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        assert_eq!(key, "windows-x86_64");
    }
}
