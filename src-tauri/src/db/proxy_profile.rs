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
     updated_at, order_index, identity_id, command";

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
        identity_id: row.get(10)?,
        command: row.get(11)?,
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
    // command 类型走 OpenSSH ProxyCommand 语义：host/port 允许为空/0。
    if profile.proxy_type.trim().eq_ignore_ascii_case("command") {
        crate::ssh::proxy::ProxyConfig::from_command(
            profile.command.as_deref().unwrap_or_default(),
        )?;
    } else {
        crate::ssh::proxy::ProxyConfig::from_parts(
            &profile.proxy_type,
            &profile.host,
            profile.port,
            profile.username.as_deref(),
            None,
            profile.no_proxy.as_deref().unwrap_or(""),
        )?;
    }
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

/// upsert；label/host 去首尾空白，username / no_proxy / identity_id / command
/// 空串归一成 NULL。
pub fn save(db: &Db, profile: &ProxyProfile) -> AppResult<()> {
    validate(profile)?;
    let conn = db.lock()?;
    let normalize = |value: Option<&String>| -> Option<String> {
        value.map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string)
    };
    let username = normalize(profile.username.as_ref());
    let no_proxy = normalize(profile.no_proxy.as_ref());
    let identity_id = normalize(profile.identity_id.as_ref());
    let command = normalize(profile.command.as_ref());
    conn.execute(
        "INSERT INTO proxy_profiles \
         (id, label, proxy_type, host, port, username, no_proxy, created_at, updated_at, \
          order_index, identity_id, command) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, proxy_type=excluded.proxy_type, \
          host=excluded.host, port=excluded.port, username=excluded.username, \
          no_proxy=excluded.no_proxy, created_at=excluded.created_at, \
          updated_at=excluded.updated_at, order_index=excluded.order_index, \
          identity_id=excluded.identity_id, command=excluded.command",
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
            identity_id,
            command,
        ],
    )?;
    Ok(())
}

/// 手动排序：事务内按下标写 order_index（不存在的 id 忽略）。
pub fn reorder(db: &Db, ids: &[String]) -> AppResult<()> {
    db.with_transaction(|tx| {
        for (index, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE proxy_profiles SET order_index = ?1 WHERE id = ?2",
                params![index as i64, id],
            )?;
        }
        Ok(())
    })
}

/// 删除条目并清空所有引用它的主机与分组（主机保留内联 proxy_* 作为回退，
/// 分组则恢复为直连）。
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
        tx.execute(
            "UPDATE groups SET proxy_profile_id = NULL WHERE proxy_profile_id = ?1",
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
            identity_id: None,
            command: None,
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
            ssh_input_compatibility: None,
            serial_port: None,
            serial_baud: None,
            serial_data_bits: None,
            serial_parity: None,
            serial_stop_bits: None,
            serial_flow: None,
            serial_local_echo: None,
            serial_line_mode: None,
            serial_backspace: None,
            serial_byte_backspace: None,
            serial_charset: None,
            distro: None,
            host_key_policy: None,
            telnet_username: None,
            telnet_charset: None,
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

    #[test]
    fn reorder_writes_index_by_array_position() {
        let db = Db::open_in_memory().unwrap();
        for id in ["a", "b", "c"] {
            save(&db, &mk(id, id)).unwrap();
        }
        reorder(&db, &["c".into(), "ghost".into(), "a".into()]).unwrap();
        let ids: Vec<String> = list(&db).unwrap().into_iter().map(|p| p.id).collect();
        // c=0、a=2，不存在的 id 忽略；b 仍为 NULL 排在最后。
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    #[test]
    fn command_profile_validates_command_and_allows_zero_host_port() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("cmd", "Jump");
        p.proxy_type = "command".into();
        p.command = Some("  ssh -W %h:%p jumphost  ".into());
        p.host = String::new();
        p.port = 0;
        save(&db, &p).unwrap();
        let got = get(&db, "cmd").unwrap();
        assert_eq!(got.command.as_deref(), Some("ssh -W %h:%p jumphost"));
        assert!(got.host.is_empty());
        assert_eq!(got.port, 0);

        p.command = Some("   ".into());
        assert_eq!(
            save(&db, &p).unwrap_err().code(),
            "proxy_command_required"
        );
    }

    #[test]
    fn identity_and_command_normalize_empty_to_none() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("p1", "X");
        p.identity_id = Some("   ".into());
        p.command = Some("  ".into());
        save(&db, &p).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.identity_id, None);
        assert_eq!(got.command, None);
    }

    #[test]
    fn delete_clears_group_default_proxy_references() {
        let db = Db::open_in_memory().unwrap();
        save(&db, &mk("p1", "Office")).unwrap();
        crate::db::group::insert(
            &db,
            &crate::models::Group {
                id: "g1".into(),
                name: "prod".into(),
                color: "#FF0000".into(),
                sort_order: 0,
                terminal_waves_enabled: false,
                proxy_profile_id: Some("p1".into()),
            },
        )
        .unwrap();
        delete(&db, "p1").unwrap();
        assert_eq!(
            crate::db::group::get(&db, "g1")
                .unwrap()
                .proxy_profile_id,
            None
        );
    }
}
