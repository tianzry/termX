//! `rssh sftp` —— Agent / 脚本用的直连 SFTP 传输。
//!
//! 复用 lib 的 `SftpHandle::connect`：凭据从 SecretStore 读取，密码与私钥都能
//! 非交互认证，不需要本机 OpenSSH 客户端。局限（见 `sftp` 子命令文档）：
//! 只走直连 + 档案内联代理字段，不解析跳板链 / 代理库条目。

use std::path::PathBuf;

use rssh_lib::error::AppResult;
use rssh_lib::models::{Credential, Profile};
use rssh_lib::ssh::proxy::ProxyConfig;
use rssh_lib::ssh::sftp::SftpHandle;

use crate::ctx::CliCtx;
use crate::helpers::cred::{find_id_by_name, load_cred_secrets};

const CONNECT_TIMEOUT_SECS: u64 = 60;

struct Target {
    profile: Profile,
    cred: Credential,
    known_hosts: PathBuf,
    proxy: Option<ProxyConfig>,
}

fn resolve(conn: &CliCtx, name: &str) -> AppResult<Target> {
    let profiles = rssh_lib::db::profile::list(conn)?;
    let id = find_id_by_name(&profiles, name, "Profile")?;
    let profile = rssh_lib::db::profile::get(conn, &id)?;
    let cred = load_cred_secrets(
        conn,
        rssh_lib::db::credential::get(conn, &profile.credential_id)?,
    )?;
    let known_hosts = rssh_lib::ssh::known_hosts::path_for(&conn.data_dir);
    // 档案里的内联代理字段（库条目 `proxy_profile_id` 需要额外的 SecretStore
    // 查询，本轮不接；连接层会按直连处理）。
    let proxy = match (
        profile.proxy_type.as_deref(),
        profile.proxy_host.as_deref(),
        profile.proxy_port,
    ) {
        (Some(kind), Some(host), Some(port)) => Some(ProxyConfig::from_parts(
            kind,
            host,
            port,
            profile.proxy_username.as_deref(),
            None,
            profile.proxy_no_proxy.as_deref().unwrap_or(""),
        )?),
        _ => None,
    };
    Ok(Target {
        profile,
        cred,
        known_hosts,
        proxy,
    })
}

/// CLI 主线程是同步的；用一个 current-thread runtime 驱动 SFTP 会话的整个生命周期。
fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime")
        .block_on(fut)
}

pub fn cmd_ls(conn: &CliCtx, profile: &str, remote_path: Option<&str>) -> AppResult<()> {
    let t = resolve(conn, profile)?;
    let path = remote_path.unwrap_or(".").to_owned();
    let entries = block_on(async move {
        let h = SftpHandle::connect(
            t.profile.host,
            t.profile.port,
            t.cred,
            t.known_hosts,
            CONNECT_TIMEOUT_SECS,
            t.proxy,
        )
        .await?;
        h.list_dir(&path).await
    })?;
    if entries.is_empty() {
        println!("(empty)");
        return Ok(());
    }
    for e in &entries {
        let kind = if e.is_dir {
            'd'
        } else if e.is_symlink {
            'l'
        } else {
            '-'
        };
        println!("{} {:>12}  {}", kind, e.size, e.name);
    }
    Ok(())
}

pub fn cmd_get(conn: &CliCtx, profile: &str, remote: &str, local: &str) -> AppResult<()> {
    let t = resolve(conn, profile)?;
    let remote = remote.to_owned();
    let local_path = PathBuf::from(local);
    let out = local_path.clone();
    let written = block_on(async move {
        let h = SftpHandle::connect(
            t.profile.host,
            t.profile.port,
            t.cred,
            t.known_hosts,
            CONNECT_TIMEOUT_SECS,
            t.proxy,
        )
        .await?;
        h.download_to_path(&remote, &local_path, u64::MAX).await
    })?;
    println!("{} bytes → {}", written, out.display());
    Ok(())
}

pub fn cmd_put(conn: &CliCtx, profile: &str, local: &str, remote: &str) -> AppResult<()> {
    let data = std::fs::read(local)?;
    let t = resolve(conn, profile)?;
    let remote = remote.to_owned();
    let size = data.len();
    let shown = remote.clone();
    block_on(async move {
        let h = SftpHandle::connect(
            t.profile.host,
            t.profile.port,
            t.cred,
            t.known_hosts,
            CONNECT_TIMEOUT_SECS,
            t.proxy,
        )
        .await?;
        h.upload(&remote, &data).await
    })?;
    println!("{} bytes → {}:{}", size, profile, shown);
    Ok(())
}
