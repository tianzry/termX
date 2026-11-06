//! `termx <profile|credential|forward> rm <name>` —— 带二次确认的删除。

use termx_lib::error::AppResult;
use termx_lib::secret::{
    cred_secret_key, proxy_secret_key, telnet_password_key, totp_secret_key,
};

use crate::ctx::CliCtx;
use crate::helpers::{confirm, find_id_by_name};

pub fn cmd_rm_profile(conn: &CliCtx, name: &str) -> AppResult<()> {
    let profiles = termx_lib::db::profile::list(conn)?;
    let id = find_id_by_name(&profiles, name, "Profile")?;
    if !confirm(&format!("Delete profile '{name}'?"), false) {
        return Ok(());
    }
    termx_lib::db::profile::delete(conn, &id)?;
    // 档案级 secret 与 metadata 同生命周期（与 GUI / headless 一致）。
    for key in [
        totp_secret_key(&id),
        proxy_secret_key(&id),
        telnet_password_key(&id),
    ] {
        if let Err(e) = conn.secret_store().delete(&key) {
            eprintln!(
                "warning: profile deleted, but secret cleanup failed ({}): {}",
                key,
                e.code()
            );
        }
    }
    println!("Deleted.");
    Ok(())
}

pub fn cmd_rm_credential(conn: &CliCtx, name: &str) -> AppResult<()> {
    let creds = termx_lib::db::credential::list(conn)?;
    let id = find_id_by_name(&creds, name, "Credential")?;
    if !confirm(&format!("Delete credential '{name}'?"), false) {
        return Ok(());
    }
    termx_lib::db::credential::delete(conn, &id)?;
    if let Err(e) = conn.secret_store().delete(&cred_secret_key(&id)) {
        eprintln!(
            "warning: credential deleted, but secret cleanup failed: {}",
            e.code()
        );
    }
    println!("Deleted.");
    Ok(())
}

pub fn cmd_rm_forward(conn: &CliCtx, name: &str) -> AppResult<()> {
    let forwards = termx_lib::db::forward::list(conn)?;
    let id = find_id_by_name(&forwards, name, "Forward")?;
    if !confirm(&format!("Delete forward '{name}'?"), false) {
        return Ok(());
    }
    termx_lib::db::forward::delete(conn, &id)?;
    println!("Deleted.");
    Ok(())
}
