//! 代理库 CRUD（`proxy_profiles` 表，schema v40）。
//!
//! 一条记录 = 一份可复用的 HTTP / SOCKS5 代理配置（对齐 Netcatty
//! `ProxyProfile` 的 label + config）。密码不入表，走 SecretStore
//! （key `proxy_profile:<id>`，见 `secret::proxy_profile_secret_key`）。

use rusqlite::params;

use super::Db;
use crate::error::{AppError, AppResult};
use crate::models::ProxyProfile;

const COLS: &str = "id, label, proxy_type, host, port, username, no_proxy, created_at, \
     updated_at, order_index";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<ProxyProfile> {
    Ok(ProxyProfile {
        id: row.get(0)?,
        label: row.get(1)?,
        proxy_type: row.get(2)?,
        host: row.get(3)?,
        port: row.get::<_, u32>(4)? as u16,
        username: row.get(5)?,
        no_proxy: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        order: row.get(9)?,
    })
}

fn validate(profile: &ProxyProfile) -> AppResult<()> {
    if profile.id.trim().is_empty() {
        return Err(AppError::other(
            "proxy_profile_id_required",
            serde_json::json!({}),
        ));
    }
    if profile.label.trim().is_empty() {
        return Err(AppError::config(
            "proxy_profile_label_required",
            serde_json::json!({ "id": profile.id }),
        ));
    }
    crate::ssh::proxy::ProxyConfig::from_parts(
        &profile.proxy_type,
        &profile.host,
        profile.port,
        profile.username.as_deref(),
        None,
        profile.no_proxy.as_deref().unwrap_or(""),
    )?;
    Ok(())
}

pub fn list(db: &Db) -> AppResult<Vec<ProxyProfile>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM proxy_profiles \
         ORDER BY order_index IS NULL, order_index ASC, updated_at DESC, label ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(db: &Db, id: &str) -> AppResult<ProxyProfile> {
    let conn = db.lock()?;
    conn.query_row(
        &format!("SELECT {COLS} FROM proxy_profiles WHERE id = ?1"),
        params![id],
        from_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => AppError::not_found(
            "proxy_profile_not_found",
            serde_json::json!({ "id": id }),
        ),
        other => other.into(),
    })
}

/// upsert；label/host 去首尾空白，username / no_proxy 空串归一成 NULL。
pub fn save(db: &Db, profile: &ProxyProfile) -> AppResult<()> {
    validate(profile)?;
    let conn = db.lock()?;
    let username = profile
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let no_proxy = profile
        .no_proxy
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    conn.execute(
        "INSERT INTO proxy_profiles \
         (id, label, proxy_type, host, port, username, no_proxy, created_at, updated_at, order_index) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, proxy_type=excluded.proxy_type, \
          host=excluded.host, port=excluded.port, username=excluded.username, \
          no_proxy=excluded.no_proxy, created_at=excluded.created_at, \
          updated_at=excluded.updated_at, order_index=excluded.order_index",
        params![
            profile.id,
            profile.label.trim(),
            profile.proxy_type,
            profile.host.trim(),
            profile.port as u32,
            username,
            no_proxy,
            profile.created_at,
            profile.updated_at,
            profile.order,
        ],
    )?;
    Ok(())
}

/// 删除条目并清空所有引用它的主机（保留主机内联 proxy_* 作为回退）。
pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.with_transaction(|tx| {
        let changed = tx.execute("DELETE FROM proxy_profiles WHERE id = ?1", params![id])?;
        if changed == 0 {
            return Err(AppError::not_found(
                "proxy_profile_not_found",
                serde_json::json!({ "id": id }),
            ));
        }
        tx.execute(
            "UPDATE profiles SET proxy_profile_id = NULL WHERE proxy_profile_id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::credential::insert as insert_credential;
    use crate::db::profile::{get as get_profile, insert as insert_profile};
    use crate::models::{Credential, CredentialType};

    fn mk(id: &str, label: &str) -> ProxyProfile {
        ProxyProfile {
            id: id.into(),
            label: label.into(),
            proxy_type: "http".into(),
            host: "127.0.0.1".into(),
            port: 7897,
            username: None,
            no_proxy: None,
            created_at: 100,
            updated_at: 100,
            order: None,
        }
    }

    fn seed_host(db: &Db, host_id: &str, proxy_profile_id: Option<&str>) {
        insert_credential(
            db,
            &Credential {
                id: "c1".into(),
                name: "cred".into(),
                username: "u".into(),
                credential_type: CredentialType::Password,
                secret: None,
                save_to_remote: false,
            },
        )
        .unwrap();
        let p = crate::models::Profile {
            id: host_id.into(),
            name: "host".into(),
            host: "10.0.0.1".into(),
            port: 22,
            credential_id: "c1".into(),
            bastion_profile_id: None,
            init_command: None,
            group_id: None,
            algorithms: Default::default(),
            sftp_protocol: None,
            sftp_sudo: false,
            sftp_encoding: None,
            icon_source: None,
            icon_color: None,
            totp_auto_submit: true,
            totp_regex: None,
            protocol: "ssh".into(),
            local_shell: None,
            local_shell_args: None,
            local_shell_name: None,
            local_shell_icon: None,
            local_start_dir: None,
            agent_forwarding: false,
            proxy_type: None,
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            proxy_no_proxy: None,
            proxy_profile_id: proxy_profile_id.map(str::to_string),
        };
        insert_profile(db, &p).unwrap();
    }

    #[test]
    fn save_then_get_roundtrips_and_trims() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("p1", "  Office  ");
        p.username = Some("  user  ".into());
        p.no_proxy = Some("  localhost  ".into());
        save(&db, &p).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.label, "Office");
        assert_eq!(got.username.as_deref(), Some("user"));
        assert_eq!(got.no_proxy.as_deref(), Some("localhost"));
        assert_eq!(got.port, 7897);
    }

    #[test]
    fn save_rejects_bad_port_and_type() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("p1", "X");
        p.port = 0;
        assert_eq!(save(&db, &p).unwrap_err().code(), "proxy_port_invalid");
        p.port = 8080;
        p.proxy_type = "ftp".into();
        assert_eq!(save(&db, &p).unwrap_err().code(), "proxy_type_invalid");
        p.proxy_type = "http".into();
        p.label = "   ".into();
        assert_eq!(
            save(&db, &p).unwrap_err().code(),
            "proxy_profile_label_required"
        );
    }

    #[test]
    fn delete_clears_host_references() {
        let db = Db::open_in_memory().unwrap();
        save(&db, &mk("p1", "Office")).unwrap();
        seed_host(&db, "h1", Some("p1"));
        assert_eq!(get_profile(&db, "h1").unwrap().proxy_profile_id.as_deref(), Some("p1"));
        delete(&db, "p1").unwrap();
        assert_eq!(get_profile(&db, "h1").unwrap().proxy_profile_id, None);
        assert_eq!(delete(&db, "p1").unwrap_err().code(), "proxy_profile_not_found");
    }

    #[test]
    fn list_orders_manual_then_updated() {
        let db = Db::open_in_memory().unwrap();
        let mut a = mk("a", "A");
        a.order = Some(2);
        let mut b = mk("b", "B");
        b.order = Some(1);
        let mut c = mk("c", "C");
        c.order = None;
        c.updated_at = 500;
        save(&db, &a).unwrap();
        save(&db, &b).unwrap();
        save(&db, &c).unwrap();
        let ids: Vec<String> = list(&db).unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["b", "a", "c"]);
    }
}
