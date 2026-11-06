mod ai;
mod app_lock;
mod commands;
#[cfg(desktop)]
pub use commands::cli::CLI_VERSION;
pub mod crypto;
pub mod db;
pub mod emitter;
pub mod error;
pub mod migration;
pub mod models;
mod redaction;
pub mod secret;
mod sftp;
// pub：`termx-cli`（`--features cli`）的 `sftp` 子命令直接复用 `SftpHandle` /
// `ProxyConfig` / known_hosts 路径，bin 是独立 crate，必须经 lib 公共面拿到它们。
pub mod ssh;
pub use ssh::bastion;
#[cfg(all(feature = "server", desktop))]
pub mod server;
mod state;
pub mod totp;
pub mod sync;
mod telnet_profile;
mod terminal;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::Manager;

use state::AppState;

#[cfg(target_os = "linux")]
fn apply_linux_wayland_compat() {
    // `RSSH_*` 旧名保留回退一个发布周期，便于既有脚本/桌面文件继续生效。
    if std::env::var_os("TERMX_DISABLE_WAYLAND_COMPAT").is_some()
        || std::env::var_os("RSSH_DISABLE_WAYLAND_COMPAT").is_some()
    {
        return;
    }

    let wayland_session = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);

    if !wayland_session {
        return;
    }

    // Wayland 兼容：部分 NVIDIA / wlroots 环境下，WebKitGTK 的 DMABUF renderer
    // 会在 Tauri 窗口创建前失败。Prefer reliable startup by default; users can
    // still override this variable explicitly.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // GBM 后端兼容：全局导出的 GBM_BACKEND，尤其是 nvidia-drm，可能导致
    // Hyprland 下 GTK / WebKitGTK 报 "Failed to create GBM buffer"。Keep an
    // explicit opt-out for users whose stack needs this variable.
    if std::env::var_os("TERMX_KEEP_GBM_BACKEND").is_none()
        && std::env::var_os("RSSH_KEEP_GBM_BACKEND").is_none()
    {
        std::env::remove_var("GBM_BACKEND");
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_wayland_compat() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    apply_linux_wayland_compat();

    // 默认 info；用 RUST_LOG=debug 等覆盖
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    // single-instance 必须是第一个注册的插件：第二个进程带着 `ssh://` 参数启动时，
    // 它负责把参数交给首实例（后续 deep-link 插件再把它转成 onOpenUrl 事件）。
    // 单独注册 deep-link 而不开 `deep-link` feature 的话，Windows/Linux 上事件
    // 只会在新进程里触发，首实例收不到。
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .on_window_event(|window, event| {
            match event {
                // Mobile (Android/iOS): Activity lifecycle changes can fire
                // WindowEvent::Destroyed when the app merely goes to background
                // (e.g. a fullscreen file picker opens). Closing sessions there
                // would silently disconnect every SSH tab. Desktop only.
                #[cfg(desktop)]
                tauri::WindowEvent::Destroyed => {
                    let state = window.state::<AppState>();
                    // Close only sessions belonging to this window.
                    commands::lifecycle::close_window_sessions(&state, window.label());
                }
                _ => {}
            }
        })
        .setup(|app| {
            #[cfg(mobile)]
            let data_dir = app.path().app_data_dir()?;
            #[cfg(desktop)]
            let data_dir = db::data_dir()?;

            // 启动时扫一次本机可用 shell，结果缓存到进程退出。
            // 用户在 Shell 设置页打开时直接读缓存，没冷启动开销。
            // PTY 模块本身就是桌面端独占（移动端没有 portable_pty）。
            #[cfg(desktop)]
            terminal::pty::init_available_shells();
            let db = Arc::new(db::Db::open(&data_dir)?);
            // secret::open 可能失败：sticky backend 标记 keyring 但 keychain 现在
            // 拿不到（系统 keychain 损坏 / D-Bus 挂等）→ 硬 fail 启动。silently
            // fallback file 会用新主密钥让旧密文全部解不开，比启动失败更危险。
            let secret_system = secret::open(db.clone(), &data_dir)?;

            // 启动迁移。失败不阻塞启动（log warn，下次启动重试），跟原
            // passphrase 清理逻辑的"软失败"风格一致。
            if let Err(e) = migration::run_migrations(
                &db,
                secret_system.raw_keyring.as_deref(),
                secret_system.store.as_ref(),
            ) {
                log::warn!("migration failed (will retry on next startup): {e}");
            }

            app.manage(AppState {
                transfer_center: Arc::new(crate::sftp::transfer_center::TransferCenter::new(db.clone())),
                db,
                secret_store: secret_system.store,
                lifecycle_sessions: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                #[cfg(desktop)]
                pty_sessions: Mutex::new(HashMap::new()),
                #[cfg(desktop)]
                serial_sessions: Mutex::new(HashMap::new()),
                telnet_sessions: Mutex::new(HashMap::new()),
                sftp_sessions: Mutex::new(HashMap::new()),
                transfer_cancels: Mutex::new(HashMap::new()),
                active_forwards: Mutex::new(HashMap::new()),
                auth_waiters: Mutex::new(HashMap::new()),
                passphrase_waiters: Mutex::new(HashMap::new()),
                host_key_waiters: Mutex::new(HashMap::new()),
                passphrase_cache: Mutex::new(HashMap::new()),
                ai_sessions: Mutex::new(HashMap::new()),
                ai_session_owners: Arc::new(Mutex::new(HashMap::new())),
                ai_remote_shell_cache: Mutex::new(HashMap::new()),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // profile & credential
            commands::profile::list_profiles,
            commands::profile::get_profile,
            commands::profile::create_profile,
            commands::profile::update_profile,
            commands::profile::delete_profile,
            commands::profile::profile_env_list,
            commands::profile::profile_env_save,
            commands::profile::ssh_algorithm_catalog,
            commands::profile::list_credentials,
            commands::profile::get_credential,
            commands::profile::create_credential,
            commands::profile::update_credential,
            commands::profile::delete_credential,
            commands::profile::read_default_key_file,
            commands::profile::list_ssh_key_files,
            commands::profile::known_hosts_list,
            commands::profile::known_hosts_remove,
            commands::profile::known_hosts_scan_system,
            commands::profile::known_hosts_import_file,
            commands::profile::profile_totp_get,
            commands::profile::profile_totp_set,
            commands::profile::profile_proxy_password_get,
            commands::profile::profile_proxy_password_set,
            commands::profile::profile_telnet_password_get,
            commands::profile::profile_telnet_password_set,
            commands::keychain::keychain_generate_key,
            commands::keychain::keychain_list_file_keys,
            commands::keychain::keychain_list_certificates,
            commands::keychain::keychain_import_certificate_credential,
            commands::keychain::ssh_agent_status,
            commands::keychain::keychain_generate_file_key,
            commands::keychain::keychain_import_file_key,
            commands::keychain::keychain_delete_file_key,
            commands::keychain::keychain_set_default_key,
            commands::keychain::keychain_get_default_key,
            commands::keychain::keychain_import_key,
            // groups
            commands::group::list_groups,
            commands::group::create_group,
            commands::group::update_group,
            commands::group::delete_group,
            // forward CRUD
            commands::forward::list_forwards,
            commands::forward::get_forward,
            commands::forward::create_forward,
            commands::forward::update_forward,
            commands::forward::delete_forward,
            // proxy library（Vault 代理库 CRUD + 密码走 SecretStore）
            commands::proxy::list_proxy_profiles,
            commands::proxy::save_proxy_profile,
            commands::proxy::proxy_profile_password_get,
            commands::proxy::delete_proxy_profile,
            commands::proxy::reorder_proxy_profiles,
            // forward active
            commands::forward::forward_start,
            commands::forward::forward_active_list,
            commands::forward::forward_stats,
            commands::forward::forward_rule_start,
            commands::forward::forward_rule_stop,
            commands::forward::forward_stop,
            // dynamic discovery
            commands::discovery::list_dynamic_discovery_sources,
            commands::discovery::save_dynamic_discovery_sources,
            commands::discovery::dynamic_discovery_tool_status,
            commands::discovery::list_dynamic_discovery_contexts,
            commands::discovery::discover_dynamic_targets,
            // settings & snippets & highlights
            commands::app_lock::app_lock_state,
            commands::app_lock::app_lock_set_password,
            commands::app_lock::app_lock_disable,
            commands::app_lock::app_lock_unlock,
            commands::app_lock::app_lock_set_enabled,
            commands::app_lock::app_lock_set_timeout,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::list_highlights,
            commands::settings::add_highlight,
            commands::settings::remove_highlight,
            commands::settings::update_highlight,
            commands::settings::load_snippets,
            commands::settings::save_snippets,
            // notes（Vault 笔记 CRUD）
            commands::notes::list_notes,
            commands::notes::get_note,
            commands::notes::save_note,
            commands::notes::delete_note,
            // session logs（Vault 日志页；扫描 recordings 目录 + 落库索引）
            commands::session_logs::list_session_logs,
            commands::session_logs::get_session_log,
            commands::session_logs::export_session_log,
            commands::session_logs::delete_session_log,
            commands::session_logs::start_session_log,
            commands::session_logs::stop_session_log,
            commands::session_logs::session_log_status,
            commands::session_logs::start_manual_session_log,
            commands::session_logs::stop_manual_session_log,
            commands::session_logs::manual_session_log_status,
            commands::settings::reset_highlights,
            commands::settings::list_recordings,
            commands::settings::read_recording,
            commands::settings::recordings_dir,
            commands::settings::secret_backend,
            commands::settings::storage_info,
            commands::settings::list_fonts,
            commands::settings::get_auto_launch,
            commands::settings::set_auto_launch,
            // plugins
            commands::plugin::plugins_root,
            commands::plugin::install_plugin,
            commands::plugin::list_plugins,
            commands::plugin::set_plugin_enabled,
            commands::plugin::set_plugin_order,
            commands::plugin::uninstall_plugin,
            commands::plugin::plugin_exec,
            commands::command_block::command_block_list_redact_rules,
            commands::command_block::command_block_save_redact_rule,
            commands::command_block::command_block_delete_redact_rule,
            // SSH session
            commands::session::ssh_connect,
            commands::session::ssh_write,
            commands::session::ssh_resize,
            commands::session::ssh_disconnect,
            commands::session::ssh_auth_respond,
            commands::session::ssh_auth_cancel,
            commands::session::ssh_passphrase_respond,
            commands::session::ssh_passphrase_cancel,
            commands::session::ssh_host_key_respond,
            commands::session::ssh_host_key_cancel,
            commands::session::ssh_exec,
            commands::monitor::monitor_sample,
            commands::monitor::list_monitor_panels,
            commands::monitor::save_monitor_panel,
            commands::monitor::delete_monitor_panel,
            // session lifecycle
            commands::lifecycle::reconcile_sessions,
            // PTY (desktop only)
            #[cfg(desktop)]
            commands::pty::list_shells,
            #[cfg(desktop)]
            commands::pty::default_shell,
            #[cfg(desktop)]
            commands::pty::refresh_shells,
            #[cfg(desktop)]
            commands::pty::discover_shells,
            #[cfg(desktop)]
            commands::pty::pty_spawn,
            #[cfg(desktop)]
            commands::pty::pty_spawn_connector,
            #[cfg(desktop)]
            commands::pty::pty_write,
            #[cfg(desktop)]
            commands::pty::pty_resize,
            #[cfg(desktop)]
            commands::pty::pty_close,
            // Serial (desktop only)
            #[cfg(desktop)]
            commands::serial::serial_list_ports,
            #[cfg(desktop)]
            commands::serial::serial_open,
            #[cfg(desktop)]
            commands::serial::serial_write,
            #[cfg(desktop)]
            commands::serial::serial_close,
            #[cfg(desktop)]
            commands::serial::serial_set_dtr,
            #[cfg(desktop)]
            commands::serial::serial_set_rts,
            #[cfg(desktop)]
            commands::serial::serial_send_break,
            #[cfg(desktop)]
            commands::serial::list_serial_profiles,
            #[cfg(desktop)]
            commands::serial::get_serial_profile,
            #[cfg(desktop)]
            commands::serial::create_serial_profile,
            #[cfg(desktop)]
            commands::serial::update_serial_profile,
            #[cfg(desktop)]
            commands::serial::delete_serial_profile,
            // Telnet (all platforms — plain TCP)
            commands::telnet::telnet_open,
            commands::telnet::telnet_write,
            commands::telnet::telnet_write_line,
            commands::telnet::telnet_resize,
            commands::telnet::telnet_close,
            commands::telnet::list_telnet_profiles,
            commands::telnet::get_telnet_profile,
            commands::telnet::create_telnet_profile,
            commands::telnet::update_telnet_profile,
            commands::telnet::delete_telnet_profile,
            // SFTP
            commands::sftp::sftp_connect,
            commands::sftp::sftp_connect_session,
            commands::sftp::sftp_home,
            commands::sftp::sftp_list,
            commands::sftp::sftp_walk_remote_dir,
            commands::sftp::walk_local_dir,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_write_file,
            commands::sftp::sftp_open_external,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_close,
            // Stream transfer to/from a path (desktop) or content:// URI (mobile).
            commands::sftp::sftp_download_to,
            commands::sftp::sftp_upload_from,
            // SFTP native file transfer (desktop only)
            #[cfg(desktop)]
            commands::sftp::sftp_save_file,
            #[cfg(desktop)]
            commands::sftp::sftp_pick_and_upload,
            #[cfg(desktop)]
            commands::sftp::sftp_pick_save_path,
            #[cfg(desktop)]
            commands::sftp::sftp_pick_open_path,
            #[cfg(desktop)]
            commands::sftp::sftp_pick_folder,
            #[cfg(desktop)]
            commands::sftp::sftp_pick_open_files,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_extract_archive,
            commands::sftp::sftp_copy,
            commands::sftp::sftp_stat,
            commands::sftp::sftp_lstat,
            commands::sftp::sftp_realpath,
            commands::sftp::sftp_chmod,
            // SFTP 传输队列（阶段 A：队列中心 / 并发 / 暂停恢复 / 优先级 / 冲突）
            crate::sftp::transfer_center::sftp_transfer_enqueue,
            crate::sftp::transfer_center::sftp_transfer_list,
            crate::sftp::transfer_center::sftp_transfer_pause,
            crate::sftp::transfer_center::sftp_transfer_resume,
            crate::sftp::transfer_center::sftp_transfer_cancel,
            crate::sftp::transfer_center::sftp_transfer_set_priority,
            crate::sftp::transfer_center::sftp_transfer_set_concurrency,
            crate::sftp::transfer_center::sftp_transfer_resolve_conflict,
            crate::sftp::transfer_center::sftp_transfer_clear_finished,
            // Local FS (SFTP dual-pane B1)
            commands::localfs::local_home,
            commands::localfs::local_list_drives,
            commands::localfs::local_list_dir,
            commands::localfs::local_stat,
            commands::localfs::local_realpath,
            commands::localfs::local_mkdir,
            commands::localfs::local_rename,
            commands::localfs::local_remove,
            commands::localfs::local_read_file,
            commands::localfs::local_write_file,
            commands::localfs::local_open_path,
            commands::localfs::local_extract_archive,
            // CLI install
            #[cfg(desktop)]
            commands::cli::cli_status,
            #[cfg(desktop)]
            commands::cli::cli_install,
            // multi-window (desktop only)
            #[cfg(desktop)]
            commands::window::open_tab_in_new_window,
            #[cfg(desktop)]
            commands::window::clipboard_read,
            #[cfg(desktop)]
            commands::window::clipboard_write,
            // 设置中心 · 外观：原生窗口透明度 / 毛玻璃 / 应用图标
            #[cfg(desktop)]
            commands::window::set_window_opacity,
            #[cfg(desktop)]
            commands::window::set_window_background_blur,
            #[cfg(desktop)]
            commands::window::set_app_icon_variant,
            // external URL opener — cross-platform via tauri-plugin-opener
            commands::external::open_external_url,
            // update check (cross-platform — separate mod from window)
            commands::update::fetch_latest_release_tag,
            commands::update::check_update,
            // sync
            commands::sync::export_config,
            commands::sync::import_config,
            commands::sync::github_push,
            commands::sync::github_pull,
            commands::sync::webdav_push,
            commands::sync::webdav_pull,
            commands::sync::sync_check,
            commands::sync::sync_refresh_local_metadata,
            commands::sync::sync_check_remotes,
            commands::sync::get_sync_auto_pull_status,
            commands::sync::set_sync_auto_pull,
            commands::sync::sync_backup_create,
            commands::sync::sync_backup_list,
            commands::sync::sync_backup_restore,
            commands::sync::sync_backup_delete,
            commands::sync::sync_backup_clear,
            // AI 排障
            ai::commands::ai_list_skills,
            ai::commands::ai_get_skill,
            ai::commands::ai_save_skill,
            ai::commands::ai_delete_skill,
            ai::commands::ai_list_redact_rules,
            ai::commands::ai_save_redact_rule,
            ai::commands::ai_delete_redact_rule,
            ai::commands::ai_list_command_blacklist,
            ai::commands::ai_replace_command_blacklist,
            ai::commands::ai_session_start,
            ai::commands::ai_session_prepare_stop,
            ai::commands::ai_session_stop,
            ai::commands::ai_session_clear_context,
            ai::commands::ai_session_rollback_context,
            ai::commands::ai_session_rebind_target,
            ai::commands::ai_remote_shell_probe_needed,
            ai::commands::ai_cache_remote_shell,
            ai::commands::ai_cancel_stream,
            ai::commands::ai_user_message,
            ai::commands::ai_command_result,
            ai::commands::ai_command_reject,
            ai::commands::ai_audit_save,
            ai::commands::ai_audit_log_text,
            ai::commands::ai_audit_get,
            ai::commands::ai_list_sessions,
            ai::commands::ai_conversations_list,
            ai::commands::ai_conversation_timeline,
            ai::commands::ai_conversation_save_timeline,
            ai::commands::ai_conversation_delete,
            ai::commands::ai_settings_get,
            ai::commands::ai_settings_set,
            ai::commands::ai_list_models,
            ai::commands::ai_provider_list,
            ai::commands::ai_provider_save,
            ai::commands::ai_provider_delete,
        ])
        .run(tauri::generate_context!())
        .expect("termX startup failed");
}
