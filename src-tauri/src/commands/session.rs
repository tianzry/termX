use serde_json::json;
use tauri::{AppHandle, State};

use crate::error::{locked, AppError, AppResult};
use crate::models::{AuthOverride, Credential, CredentialType, PluginExecResult, Profile};
use crate::secret::cred_secret_key;
use crate::ssh::client;
use crate::state::{AppState, SessionKind, SessionOwner};

/// 把 SecretStore 里的 secret 灌到 Credential 上。
fn load_secrets(state: &State<'_, AppState>, c: &mut Credential) -> AppResult<()> {
    c.secret = state.secret_store.get(&cred_secret_key(&c.id))?;
    Ok(())
}

/// 应用连接弹窗的一次性认证覆盖（不写回 DB）。
///
/// `credential_id` 换用另一条已保存凭据；`username` / `password` 依次覆盖
/// 登录名与密码认证。密码覆盖最后生效，因为它是用户在弹窗里刚输入的原文。
fn apply_auth_override(
    state: &State<'_, AppState>,
    credential: &mut Credential,
    override_input: Option<AuthOverride>,
) -> AppResult<()> {
    let Some(override_input) = override_input else {
        return Ok(());
    };
    if let Some(credential_id) = override_input.credential_id {
        let mut replacement =
            crate::db::credential::get(&state.db, &credential_id).map_err(|e| match e {
                AppError::NotFound(_) => AppError::not_found("profile_cred_not_found", json!({})),
                other => other,
            })?;
        load_secrets(state, &mut replacement)?;
        *credential = replacement;
    }
    if let Some(username) = override_input.username {
        if !username.is_empty() {
            credential.username = username;
        }
    }
    if let Some(password) = override_input.password {
        credential.credential_type = CredentialType::Password;
        credential.secret = Some(password);
    }
    if let Some(passphrase) = override_input.passphrase {
        if matches!(credential.credential_type, CredentialType::Key) && !passphrase.is_empty() {
            // 与 ssh/auth.rs 的 `decode_key_with_prompt` 使用同一缓存键，
            // 让本次连接直接命中弹窗里输入的 passphrase（不写回 DB）。
            let cache_key = format!("cred:{}", credential.id);
            if let Ok(mut cache) = locked(&state.passphrase_cache) {
                cache.insert(cache_key, zeroize::Zeroizing::new(passphrase));
            }
        }
    }
    Ok(())
}

/// 经 profile_id 建立 SSH 连接（自动带堡垒机链）。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Flat fields preserve the existing invoke wire contract.
pub async fn ssh_connect(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    profile_id: String,
    // 前端 tab ID，用于发送连接日志
    log_session_id: Option<String>,
    cols: u32,
    rows: u32,
    session_id: Option<String>,
    auth_override: Option<AuthOverride>,
) -> AppResult<String> {
    let requested_session_id = session_id.clone();
    let session_id = crate::commands::lifecycle::resolve_session_id(session_id)?;
    let owner = SessionOwner::Window(window.label().to_owned());
    let reservation = crate::commands::lifecycle::reserve_resource(
        &state,
        &session_id,
        SessionKind::Ssh,
        owner.clone(),
    )?;
    let profile = crate::db::profile::get(&state.db, &profile_id)?;
    let mut credential =
        crate::db::credential::get(&state.db, &profile.credential_id).map_err(|e| match e {
            AppError::NotFound(_) => AppError::not_found("profile_cred_not_found", json!({})),
            other => other,
        })?;
    load_secrets(&state, &mut credential)?;
    apply_auth_override(&state, &mut credential, auth_override)?;

    // 解析整条堡垒机链 + 给每一跳加载凭证（含 secret）
    let chain_profiles = crate::ssh::bastion::resolve_chain(&state.db, &profile)?;
    let mut chain: Vec<(Profile, Credential)> = Vec::with_capacity(chain_profiles.len());
    for hop in chain_profiles {
        let mut bc =
            crate::db::credential::get(&state.db, &hop.credential_id).map_err(|e| match e {
                AppError::NotFound(_) => AppError::not_found(
                    "bastion_cred_not_found",
                    json!({ "name": hop.name.clone() }),
                ),
                other => other,
            })?;
        load_secrets(&state, &mut bc)?;
        chain.push((hop, bc));
    }

    // 检查 verbose log + 录制设置 + 连接超时
    let verbose_log = crate::db::settings::get(&state.db, "verbose_log")?
        .map(|v| v == "true")
        .unwrap_or(true);
    let timeout_secs: u64 = crate::db::settings::get(&state.db, "connect_timeout")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(crate::ssh::client::DEFAULT_CONNECT_TIMEOUT);
    let recording_path = crate::commands::settings::recording_path_for(&state, &profile.name)?;

    // Only pass log_session_id if verbose logging is enabled
    let prompt_session_id = requested_session_id
        .map(|_| session_id.clone())
        .or_else(|| log_session_id.clone());
    let effective_log_id = if verbose_log {
        prompt_session_id.clone()
    } else {
        None
    };

    let known_hosts_path = crate::ssh::known_hosts::path_for(&state.data_dir);
    let init_command = profile.init_command.clone();
    let result = client::run_blocking_ssh(move || async move {
        client::connect(client::ConnectParams {
            session_id,
            profile,
            credential,
            bastion_chain: chain,
            cols,
            rows,
            app: crate::emitter::Host::Tauri(app),
            owner,
            recording_path,
            log_session_id: effective_log_id,
            prompt_session_id,
            known_hosts_path,
            timeout_secs,
        })
        .await
    })
    .await?;

    // 执行初始命令（shell 已就绪，直接写入）
    if let Some(ref cmd) = init_command {
        if !cmd.is_empty() {
            result.handle.write(format!("{}\n", cmd).as_bytes())?;
        }
    }

    let session_id = result.session_id;
    reservation.activate_returned(
        &session_id,
        crate::commands::lifecycle::ReadySession::Ssh(result.handle),
    )?;

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> AppResult<()> {
    get_session(&state, &session_id)?.write(&data)
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    get_session(&state, &session_id)?.resize(cols, rows)
}

/// 在已建立的 SSH 会话上跑一次性远程命令（`client::exec_once`），返回
/// stdout/stderr/exit_code。命令对即用即弃——不保留任何状态，插件轮询停止
/// 时无需清理。`timeout_ms` 缺省 10s，clamp 到 [1s, 60s]。
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> AppResult<PluginExecResult> {
    let session = get_session(&state, &session_id)?;
    let ssh = session.ssh_handle().clone();
    let timeout = std::time::Duration::from_millis(
        timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000),
    );
    client::run_blocking_ssh(move || async move { client::exec_once(&ssh, &command, timeout).await })
        .await
}

/// `tab_id` 只为未预留 session id 的旧客户端保留；新客户端的 prompt waiter
/// 直接以 `session_id` 为 key。
#[tauri::command]
pub async fn ssh_disconnect(
    window: tauri::Window,
    state: State<'_, AppState>,
    session_id: String,
    tab_id: Option<String>,
) -> AppResult<()> {
    let owner = SessionOwner::Window(window.label().to_owned());
    crate::commands::lifecycle::close_resource(&state, &session_id, SessionKind::Ssh, &owner)?;

    // New callers were cleaned with the resource above. `tab_id` is only a
    // compatibility fallback for clients that connected without pre-reserving.
    if let Some(tid) = tab_id.as_deref() {
        if tid != session_id {
            let _ = remove_owned_waiter(&state.auth_waiters, tid, &owner);
            let _ = remove_owned_waiter(&state.passphrase_waiters, tid, &owner);
            let _ = remove_owned_waiter(&state.host_key_waiters, tid, &owner);
        }
    }
    Ok(())
}

/// 用户在 keyboard-interactive prompt 前关 tab 时调用，drop sender 让
/// authenticate_interactive 立即报错退出。与 ssh_passphrase_cancel /
/// ssh_host_key_cancel 对称。
#[tauri::command]
pub async fn ssh_auth_cancel(
    window: tauri::Window,
    state: State<'_, AppState>,
    tab_id: String,
) -> AppResult<()> {
    remove_owned_waiter(
        &state.auth_waiters,
        &tab_id,
        &SessionOwner::Window(window.label().to_owned()),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_auth_respond(
    window: tauri::Window,
    state: State<'_, AppState>,
    tab_id: String,
    responses: Vec<String>,
) -> AppResult<()> {
    let tx = take_owned_waiter(
        &state.auth_waiters,
        &tab_id,
        &SessionOwner::Window(window.label().to_owned()),
        "no_pending_auth",
    )?;
    tx.send(responses)
        .map_err(|_| AppError::other("auth_channel_closed", json!({})))?;
    Ok(())
}

/// 终端内输完私钥 passphrase 后调用，把结果回传给等待中的 decode_key_with_prompt。
#[tauri::command]
pub async fn ssh_passphrase_respond(
    window: tauri::Window,
    state: State<'_, AppState>,
    tab_id: String,
    passphrase: String,
) -> AppResult<()> {
    let tx = take_owned_waiter(
        &state.passphrase_waiters,
        &tab_id,
        &SessionOwner::Window(window.label().to_owned()),
        "no_pending_passphrase",
    )?;
    tx.send(passphrase)
        .map_err(|_| AppError::other("passphrase_channel_closed", json!({})))?;
    Ok(())
}

/// 用户在终端弹窗里点取消时调用，让 decode_key_with_prompt 立即报错退出。
#[tauri::command]
pub async fn ssh_passphrase_cancel(
    window: tauri::Window,
    state: State<'_, AppState>,
    tab_id: String,
) -> AppResult<()> {
    // 直接 drop sender 即可触发等待端的 RecvError
    remove_owned_waiter(
        &state.passphrase_waiters,
        &tab_id,
        &SessionOwner::Window(window.label().to_owned()),
    )?;
    Ok(())
}

/// 终端中输完 host key 确认（yes / no / 指纹）后调用，把字符串送回 check_server_key。
#[tauri::command]
pub async fn ssh_host_key_respond(
    window: tauri::Window,
    state: State<'_, AppState>,
    tab_id: String,
    answer: String,
) -> AppResult<()> {
    let tx = take_owned_waiter(
        &state.host_key_waiters,
        &tab_id,
        &SessionOwner::Window(window.label().to_owned()),
        "no_pending_hostkey",
    )?;
    tx.send(answer)
        .map_err(|_| AppError::other("hostkey_channel_closed", json!({})))?;
    Ok(())
}

/// 用户在终端取消（Ctrl-C / 关 tab）host key 确认时调用，让 check_server_key 立即拒绝。
#[tauri::command]
pub async fn ssh_host_key_cancel(
    window: tauri::Window,
    state: State<'_, AppState>,
    tab_id: String,
) -> AppResult<()> {
    remove_owned_waiter(
        &state.host_key_waiters,
        &tab_id,
        &SessionOwner::Window(window.label().to_owned()),
    )?;
    Ok(())
}

fn take_owned_waiter<T>(
    map: &std::sync::Mutex<std::collections::HashMap<String, crate::state::OwnedWaiter<T>>>,
    prompt_id: &str,
    owner: &SessionOwner,
    missing_code: &'static str,
) -> AppResult<tokio::sync::oneshot::Sender<T>> {
    let mut waiters = locked(map)?;
    if !waiters
        .get(prompt_id)
        .is_some_and(|waiter| &waiter.owner == owner)
    {
        return Err(AppError::other(missing_code, json!({})));
    }
    Ok(waiters
        .remove(prompt_id)
        .expect("waiter was validated")
        .sender)
}

fn remove_owned_waiter<T>(
    map: &std::sync::Mutex<std::collections::HashMap<String, crate::state::OwnedWaiter<T>>>,
    prompt_id: &str,
    owner: &SessionOwner,
) -> AppResult<()> {
    let mut waiters = locked(map)?;
    if waiters
        .get(prompt_id)
        .is_some_and(|waiter| &waiter.owner == owner)
    {
        waiters.remove(prompt_id);
    }
    Ok(())
}

/// 供其它命令模块（会话日志等）按 session_id 取 SSH 句柄。
/// 与 `get_session` 同源，只是接收 `&AppState` 以便 `*_impl`（headless 复用）。
pub(crate) fn session_handle(
    state: &AppState,
    session_id: &str,
) -> AppResult<client::SessionHandle> {
    locked(&state.sessions)?
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found("session_not_found", json!({})))
}

fn get_session(state: &State<'_, AppState>, session_id: &str) -> AppResult<client::SessionHandle> {
    session_handle(state, session_id)
}
