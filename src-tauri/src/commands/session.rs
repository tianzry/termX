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

/// 应用「设置 → 终端」中的 SSH 运行期设置（主机密钥校验 / TERM 类型）。
///
/// 校验开关是进程级原子量，必须在每个顶层连接入口（终端 / 独立 SFTP /
/// 端口转发 / headless）连接前重新读取，否则会残留上一次连接时的取值。
pub fn apply_ssh_runtime_settings(state: &AppState) -> AppResult<()> {
    let parsed = crate::db::settings::get(&state.db, "settings.center.v1")?
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let verify_host_keys = parsed
        .as_ref()
        .and_then(|v| v.get("verifyHostKeys").and_then(|b| b.as_bool()))
        .unwrap_or(true);
    client::set_verify_host_keys(verify_host_keys);
    let terminal_type = parsed
        .as_ref()
        .and_then(|v| {
            v.get("terminal")
                .and_then(|t| t.get("terminalEmulationType"))
                .and_then(|s| s.as_str())
        })
        .unwrap_or("xterm-256color");
    client::set_terminal_emulation_type(terminal_type);
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
    // 目标 + 每一跳的代理配置（档案自带优先，系统代理兜底），连接层按 id 查表。
    let proxy_configs = {
        let mut all: Vec<&Profile> = vec![&profile];
        all.extend(chain_profiles.iter());
        resolve_proxy_configs(&state, &all)?
    };
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
    // 设置中心 → 终端 → 主机密钥校验策略 / 终端仿真类型。
    apply_ssh_runtime_settings(&state)?;
    // 主机档案显式开启「自动记录会话日志」时才落 `.log`；默认不录。
    let auto_log_path = crate::commands::settings::auto_session_log_path(&state, &profile);

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
    let env_vars = crate::db::profile_env::list(&state.db, &profile.id).unwrap_or_default();
    let init_command = profile.init_command.clone();
    // 发行版探测所需的上下文（profile 会 move 进 ConnectParams，提前取出）。
    let detect_profile_id = profile.id.clone();
    let known_distro = profile.distro.clone();
    let agent_forwarding = profile.agent_forwarding;
    let host = crate::emitter::Host::Tauri(app.clone());
    let result = client::run_blocking_ssh(move || async move {
        client::connect(client::ConnectParams {
            session_id,
            profile,
            credential,
            bastion_chain: chain,
            proxy_configs,
            cols,
            rows,
            app: host,
            owner,
            auto_log_path,
            log_session_id: effective_log_id,
            prompt_session_id,
            known_hosts_path,
            timeout_secs,
            env_vars,
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

    // 发行版自动探测：后台异步执行，失败只记日志，绝不影响会话建立。
    crate::ssh::distro::spawn_detection(
        result.handle.ssh_handle().clone(),
        detect_profile_id,
        result.server_banner.clone(),
        known_distro,
        state.db.clone(),
        crate::emitter::Host::Tauri(app),
        agent_forwarding,
    );

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
    encoding: Option<String>,
) -> AppResult<()> {
    let bytes = crate::terminal::encoding::encode_terminal_input(&data, encoding.as_deref());
    get_session(&state, &session_id)?.write(&bytes)
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
/// `ssh_exec` 的引擎实现：Tauri 命令与 headless dispatcher 共用同一逻辑。
pub async fn ssh_exec_impl(
    state: &AppState,
    session_id: &str,
    command: &str,
    timeout_ms: Option<u64>,
) -> AppResult<PluginExecResult> {
    let session = session_handle(state, session_id)?;
    let ssh = session.ssh_handle().clone();
    let command = command.to_string();
    // exec 会话沿用档案的「转发 Agent」开关（等价 `ssh -A host cmd`）。
    let agent_forwarding = crate::db::profile::get(&state.db, session.profile_id())
        .map(|p| p.agent_forwarding)
        .unwrap_or(false);
    let timeout = std::time::Duration::from_millis(
        timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000),
    );
    client::run_blocking_ssh(move || async move {
        client::exec_once(&ssh, &command, timeout, agent_forwarding).await
    })
    .await
}

#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> AppResult<PluginExecResult> {
    ssh_exec_impl(&state, &session_id, &command, timeout_ms).await
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
    // SSH 断开会级联关闭所属 SFTP 会话；同样立刻广播队列快照，让离线标注
    // 与「恢复/重试」禁用即时生效。
    if let Ok(snapshot) = crate::sftp::transfer_center::refreshed_snapshot(&state) {
        use tauri::{Emitter as _, Manager as _};
        let _ = window.app_handle().emit("sftp:queue_changed", snapshot);
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

/// 目标 + 堡垒每一跳的代理配置。只采用档案自带配置（type/host/port/username +
/// SecretStore 密码）；设置中心的系统代理只作用于云同步 / AI 的 HTTP 请求，
/// 不改变 SSH（对齐 Netcatty）。结果按 `profile_id` 建表，连接层逐跳查表，
/// 堡垒链不会和张贴的代理错位。
///
/// 解析顺序（对齐 Netcatty）：主机自身 `proxy_profile_id` → 分组默认
/// `groups.proxy_profile_id` → 主机内联 proxy_*；都没有则直连不插入表。
pub(crate) fn resolve_proxy_configs(
    state: &AppState,
    profiles: &[&Profile],
) -> AppResult<std::collections::HashMap<String, crate::ssh::proxy::ProxyConfig>> {
    let non_empty = |value: Option<&str>| -> Option<String> {
        value
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let mut map = std::collections::HashMap::new();
    for profile in profiles {
        let mut cfg: Option<crate::ssh::proxy::ProxyConfig> = None;

        // 1) 主机绑定的代理库条目；主机未绑定（或指向已删除条目）时继承分组默认。
        let library_id = non_empty(profile.proxy_profile_id.as_deref()).or_else(|| {
            let group_id = non_empty(profile.group_id.as_deref())?;
            let group = crate::db::group::get(&state.db, &group_id).ok()?;
            non_empty(group.proxy_profile_id.as_deref())
        });
        if let Some(pid) = library_id {
            if let Ok(pp) = crate::db::proxy_profile::get(&state.db, &pid) {
                if pp.proxy_type.trim().eq_ignore_ascii_case("command") {
                    cfg = Some(crate::ssh::proxy::ProxyConfig::from_command(
                        pp.command.as_deref().unwrap_or_default(),
                    )?);
                } else {
                    // 钥匙串身份优先于手填用户名与代理密码（对齐 Netcatty）。
                    let (username, password) =
                        match non_empty(pp.identity_id.as_deref()) {
                            Some(identity_id) => {
                                let cred = crate::db::credential::get(
                                    &state.db,
                                    &identity_id,
                                )
                                .map_err(|_| {
                                    AppError::config(
                                        "proxy_identity_missing",
                                        json!({ "id": &identity_id }),
                                    )
                                })?;
                                let secret = state
                                    .secret_store
                                    .get(&cred_secret_key(&identity_id))?;
                                (Some(cred.username), secret)
                            }
                            None => (
                                pp.username.clone(),
                                state
                                    .secret_store
                                    .get(&crate::secret::proxy_profile_secret_key(&pid))?,
                            ),
                        };
                    cfg = Some(crate::ssh::proxy::ProxyConfig::from_parts(
                        &pp.proxy_type,
                        &pp.host,
                        pp.port,
                        username.as_deref(),
                        password.as_deref(),
                        pp.no_proxy.as_deref().unwrap_or_default(),
                    )?);
                }
            }
            // 库条目已不存在时回退到主机内联字段（保持旧行为）。
        }

        // 2) 主机内联 proxy_*（比如库条目被删除后的回退）。
        if cfg.is_none() {
            let Some(kind) = non_empty(profile.proxy_type.as_deref()) else {
                continue;
            };
            let password =
                state.secret_store.get(&crate::secret::proxy_secret_key(&profile.id))?;
            cfg = Some(crate::ssh::proxy::ProxyConfig::from_parts(
                &kind,
                profile.proxy_host.as_deref().unwrap_or(""),
                profile.proxy_port.unwrap_or(0),
                profile.proxy_username.as_deref(),
                password.as_deref(),
                profile.proxy_no_proxy.as_deref().unwrap_or(""),
            )?);
        }

        if let Some(cfg) = cfg {
            map.insert(profile.id.clone(), cfg);
        }
    }
    Ok(map)
}
