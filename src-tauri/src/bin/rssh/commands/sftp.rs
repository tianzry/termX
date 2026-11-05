//! `rssh sftp` —— Agent / 脚本用的直连 SFTP 传输。
//!
//! 复用 lib 的 `SftpHandle::connect`：凭据从 SecretStore 读取，密码与私钥都能
//! 非交互认证，不需要本机 OpenSSH 客户端。局限（见 `sftp` 子命令文档）：
//! 只走直连 + 档案内联代理字段，不解析跳板链 / 代理库条目。

use std::path::PathBuf;

use rssh_lib::error::{AppError, AppResult};
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
            t.profile.host_key_policy.clone(),
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
            t.profile.host_key_policy.clone(),
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
            t.profile.host_key_policy.clone(),
        )
        .await?;
        h.upload(&remote, &data).await
    })?;
    println!("{} bytes → {}:{}", size, profile, shown);
    Ok(())
}

/// 新建一条已认证的 SFTP 会话（新命令共用，避免逐条重复 connect 参数）。
async fn open(t: Target) -> AppResult<SftpHandle> {
    SftpHandle::connect(
        t.profile.host,
        t.profile.port,
        t.cred,
        t.known_hosts,
        CONNECT_TIMEOUT_SECS,
        t.proxy,
        t.profile.host_key_policy.clone(),
    )
    .await
}

/// 解析八进制权限（接受 `644` / `0755` / `0o755`），拒绝非法字符与越界值。
pub fn parse_octal_mode(input: &str) -> AppResult<u32> {
    let s = input.trim();
    let s = s.strip_prefix("0o").unwrap_or(s);
    if s.is_empty()
        || s.len() > 4
        || !s.chars().all(|c| ('0'..='7').contains(&c))
    {
        return Err(AppError::other(
            "sftp_invalid_mode",
            serde_json::json!({ "mode": input }),
        ));
    }
    let mode = u32::from_str_radix(s, 8).map_err(|_| {
        AppError::other(
            "sftp_invalid_mode",
            serde_json::json!({ "mode": input }),
        )
    })?;
    Ok(mode)
}

pub fn cmd_home(conn: &CliCtx, profile: &str) -> AppResult<()> {
    let t = resolve(conn, profile)?;
    let home = block_on(async move { open(t).await?.home_dir().await })?;
    println!("{home}");
    Ok(())
}

pub fn cmd_mkdir(conn: &CliCtx, profile: &str, path: &str) -> AppResult<()> {
    let t = resolve(conn, profile)?;
    let path = path.to_owned();
    let shown = path.clone();
    block_on(async move { open(t).await?.mkdir(&path).await })?;
    println!("Created {shown}");
    Ok(())
}

pub fn cmd_rm(conn: &CliCtx, profile: &str, path: &str) -> AppResult<()> {
    let t = resolve(conn, profile)?;
    let path = path.to_owned();
    let shown = path.clone();
    block_on(async move { open(t).await?.remove(&path).await })?;
    println!("Removed {shown}");
    Ok(())
}

pub fn cmd_mv(conn: &CliCtx, profile: &str, old: &str, new: &str) -> AppResult<()> {
    let t = resolve(conn, profile)?;
    let (old, new) = (old.to_owned(), new.to_owned());
    let shown = format!("{old} → {new}");
    block_on(async move { open(t).await?.rename(&old, &new).await })?;
    println!("{shown}");
    Ok(())
}

pub fn cmd_stat(conn: &CliCtx, profile: &str, path: &str) -> AppResult<()> {
    let t = resolve(conn, profile)?;
    let path = path.to_owned();
    let st = block_on(async move { open(t).await?.stat(&path).await })?;
    let kind = if st.is_dir {
        "directory"
    } else if st.is_symlink {
        "symlink"
    } else {
        "file"
    };
    println!("name:        {}", st.name);
    println!("type:        {kind}");
    println!("size:        {}", st.size);
    println!("mtime:       {}", st.mtime);
    if let Some(perm) = st.permissions {
        println!("permissions: {:04o}", perm & 0o7777);
    }
    Ok(())
}

pub fn cmd_chmod(conn: &CliCtx, profile: &str, path: &str, mode: &str) -> AppResult<()> {
    let mode = parse_octal_mode(mode)?;
    let t = resolve(conn, profile)?;
    let path = path.to_owned();
    let shown = path.clone();
    block_on(async move { open(t).await?.chmod(&path, mode).await })?;
    println!("chmod {mode:04o} → {shown}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn octal_mode_accepts_common_forms() {
        assert_eq!(parse_octal_mode("644").unwrap(), 0o644);
        assert_eq!(parse_octal_mode("0755").unwrap(), 0o755);
        assert_eq!(parse_octal_mode("0o755").unwrap(), 0o755);
        assert_eq!(parse_octal_mode(" 7777 ").unwrap(), 0o7777);
        assert_eq!(parse_octal_mode("0").unwrap(), 0);
    }

    #[test]
    fn octal_mode_rejects_invalid() {
        assert!(parse_octal_mode("").is_err());
        assert!(parse_octal_mode("abc").is_err());
        assert!(parse_octal_mode("888").is_err());
        assert!(parse_octal_mode("10000").is_err());
        assert!(parse_octal_mode("u+rwx").is_err());
    }
}
