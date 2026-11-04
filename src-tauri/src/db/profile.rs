use rusqlite::params;
use serde_json::json;

use super::Db;
use crate::error::{AppError, AppResult};
use crate::models::{validate_name, Profile, SshAlgorithms};

fn row_to_profile(row: &rusqlite::Row) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get::<_, u32>(3)? as u16,
        credential_id: row.get(4)?,
        bastion_profile_id: row.get(5)?,
        init_command: row.get(6)?,
        group_id: row.get(7)?,
        algorithms: parse_algorithms(row.get(8)?),
        sftp_protocol: row.get(9)?,
        sftp_sudo: row.get(10)?,
        sftp_encoding: row.get(11)?,
        icon_source: row.get(12)?,
        icon_color: row.get(13)?,
        totp_auto_submit: row.get(14)?,
        totp_regex: row.get(15)?,
        protocol: row.get(16)?,
        local_shell: row.get(17)?,
        local_shell_args: parse_local_shell_args(row.get(18)?),
        local_shell_name: row.get(19)?,
        local_shell_icon: row.get(20)?,
        local_start_dir: row.get(21)?,
        agent_forwarding: row.get(22)?,
        proxy_type: row.get(23)?,
        proxy_host: row.get(24)?,
        proxy_port: row.get::<_, Option<u32>>(25)?.map(|p| p as u16),
        proxy_username: row.get(26)?,
        proxy_no_proxy: row.get(27)?,
        proxy_profile_id: row.get(28)?,
        ssh_input_compatibility: row.get(29)?,
    })
}

/// local_shell_args 以 JSON 文本入库（`["-NoLogo"]` 之类）；NULL / 空 / 坏
/// JSON 一律落回 None（= 按 shell 默认行为启动），与 algorithms 同款容错。
fn parse_local_shell_args(raw: Option<String>) -> Option<Vec<String>> {
    let raw = raw.filter(|s| !s.trim().is_empty())?;
    match serde_json::from_str::<Vec<String>>(&raw) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!(
                "failed to parse profile.local_shell_args JSON ({} bytes), ignoring: {e}",
                raw.len()
            );
            None
        }
    }
}

fn local_shell_args_json(args: &Option<Vec<String>>) -> Option<String> {
    args.as_ref().map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".into()))
}

fn parse_algorithms(raw: Option<String>) -> SshAlgorithms {
    let Some(raw) = raw else {
        return SshAlgorithms::default();
    };
    if raw.trim().is_empty() {
        return SshAlgorithms::default();
    }
    match serde_json::from_str::<Option<SshAlgorithms>>(&raw) {
        Ok(v) => v.unwrap_or_default(),
        Err(e) => {
            log::warn!(
                "failed to parse profile.algorithms JSON ({} bytes), using defaults: {e}",
                raw.len()
            );
            SshAlgorithms::default()
        }
    }
}

fn algorithms_json(p: &Profile) -> AppResult<String> {
    serde_json::to_string(&p.algorithms)
        .map_err(|e| AppError::other("serde_failed", json!({ "err": e.to_string() })))
}

/// Profile 表全列清单（row_to_profile 按索引读，顺序是 single source of truth）。
const PROFILE_COLUMNS: &str = "id, name, host, port, credential_id, bastion_profile_id, init_command, group_id, algorithms, sftp_protocol, sftp_sudo, sftp_encoding, icon_source, icon_color, totp_auto_submit, totp_regex, protocol, local_shell, local_shell_args, local_shell_name, local_shell_icon, local_start_dir, agent_forwarding, proxy_type, proxy_host, proxy_port, proxy_username, proxy_no_proxy, proxy_profile_id, ssh_input_compatibility";

pub fn list(db: &Db) -> AppResult<Vec<Profile>> {
    let conn = db.lock()?;
    let sql = format!("SELECT {PROFILE_COLUMNS} FROM profiles ORDER BY name ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| row_to_profile(row))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(db: &Db, id: &str) -> AppResult<Profile> {
    let conn = db.lock()?;
    let sql = format!("SELECT {PROFILE_COLUMNS} FROM profiles WHERE id = ?1");
    conn.query_row(&sql, params![id], |row| row_to_profile(row)).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            AppError::not_found("profile_not_found", serde_json::json!({ "id": id }))
        }
        other => other.into(),
    })
}

/// Profile 写入的 single source of truth。`models.rs::Profile.credential_id`
/// 文档里写的"应用层不变量"在这里 enforce —— UI/CLI 层的校验是 UX 早期提示，
/// 任何路径（包括 Tauri `create_profile`/`update_profile` 命令、外部脚本 invoke、
/// 旧前端、未来新增的写入入口）最终都得过这道关。
fn validate_for_write(p: &Profile) -> AppResult<()> {
    validate_name(&p.name)?;
    // 本地 shell 主机（protocol == "local"）没有 SSH 凭证概念，豁免空
    // credential_id；SSH 主机维持"必须引用真实凭证"的既有不变量。
    if p.protocol != "local" && p.credential_id.is_empty() {
        return Err(AppError::config(
            "profile_credential_id_required",
            serde_json::json!({ "id": p.id, "name": p.name }),
        ));
    }
    if let Err(category) = crate::ssh::algorithms::validate_policy(&p.algorithms) {
        return Err(AppError::config(
            "profile_algorithms_invalid",
            serde_json::json!({ "category": category }),
        ));
    }
    // 代理字段：引用了代理库条目时由库侧校验，内联字段只作回退；
    // 否则只有填了类型才校验（旧数据 / 未用代理的主机保持空）。
    let library_ref = p
        .proxy_profile_id
        .as_deref()
        .filter(|s| !s.trim().is_empty());
    if library_ref.is_none() {
        if let Some(kind) = p.proxy_type.as_deref().filter(|s| !s.trim().is_empty()) {
            crate::ssh::proxy::ProxyConfig::from_parts(
                kind,
                p.proxy_host.as_deref().unwrap_or(""),
                p.proxy_port.unwrap_or(0),
                p.proxy_username.as_deref(),
                None,
                p.proxy_no_proxy.as_deref().unwrap_or(""),
            )?;
        }
    }
    Ok(())
}

pub fn insert_tx(conn: &rusqlite::Connection, p: &Profile) -> AppResult<()> {
    validate_for_write(p)?;
    let algorithms = algorithms_json(p)?;
    let local_shell_args = local_shell_args_json(&p.local_shell_args);
    conn.execute(
        "INSERT INTO profiles (id, name, host, port, credential_id, bastion_profile_id, init_command, group_id, algorithms, \
         sftp_protocol, sftp_sudo, sftp_encoding, icon_source, icon_color, totp_auto_submit, totp_regex, \
         protocol, local_shell, local_shell_args, local_shell_name, local_shell_icon, local_start_dir, agent_forwarding, \
         proxy_type, proxy_host, proxy_port, proxy_username, proxy_no_proxy, proxy_profile_id, \
         ssh_input_compatibility) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30) \
         ON CONFLICT(id) DO UPDATE SET \
         name=excluded.name, host=excluded.host, port=excluded.port, \
         credential_id=excluded.credential_id, bastion_profile_id=excluded.bastion_profile_id, \
         init_command=excluded.init_command, group_id=excluded.group_id, algorithms=excluded.algorithms, \
         sftp_protocol=excluded.sftp_protocol, sftp_sudo=excluded.sftp_sudo, sftp_encoding=excluded.sftp_encoding, \
         icon_source=excluded.icon_source, icon_color=excluded.icon_color, \
         totp_auto_submit=excluded.totp_auto_submit, totp_regex=excluded.totp_regex, \
         protocol=excluded.protocol, local_shell=excluded.local_shell, local_shell_args=excluded.local_shell_args, \
         local_shell_name=excluded.local_shell_name, local_shell_icon=excluded.local_shell_icon, \
         local_start_dir=excluded.local_start_dir, agent_forwarding=excluded.agent_forwarding, \
         proxy_type=excluded.proxy_type, proxy_host=excluded.proxy_host, proxy_port=excluded.proxy_port, \
         proxy_username=excluded.proxy_username, proxy_no_proxy=excluded.proxy_no_proxy, \
         proxy_profile_id=excluded.proxy_profile_id, \
         ssh_input_compatibility=excluded.ssh_input_compatibility",
        params![
            p.id,
            p.name,
            p.host,
            p.port as u32,
            p.credential_id,
            p.bastion_profile_id,
            p.init_command,
            p.group_id,
            algorithms,
            p.sftp_protocol,
            p.sftp_sudo,
            p.sftp_encoding,
            p.icon_source,
            p.icon_color,
            p.totp_auto_submit,
            p.totp_regex,
            p.protocol,
            p.local_shell,
            local_shell_args,
            p.local_shell_name,
            p.local_shell_icon,
            p.local_start_dir,
            p.agent_forwarding,
            p.proxy_type,
            p.proxy_host,
            p.proxy_port.map(|v| v as u32),
            p.proxy_username,
            p.proxy_no_proxy,
            p.proxy_profile_id,
            p.ssh_input_compatibility
        ],
    )?;
    Ok(())
}

pub fn insert(db: &Db, p: &Profile) -> AppResult<()> {
    let conn = db.lock()?;
    insert_tx(&conn, p)
}

pub fn update(db: &Db, p: &Profile) -> AppResult<()> {
    validate_for_write(p)?;
    let conn = db.lock()?;
    let algorithms = algorithms_json(p)?;
    let local_shell_args = local_shell_args_json(&p.local_shell_args);
    conn.execute(
        "UPDATE profiles SET name=?1, host=?2, port=?3, credential_id=?4, bastion_profile_id=?5, init_command=?6, group_id=?7, algorithms=?8, \
         sftp_protocol=?9, sftp_sudo=?10, sftp_encoding=?11, icon_source=?12, icon_color=?13, totp_auto_submit=?14, totp_regex=?15, \
         protocol=?16, local_shell=?17, local_shell_args=?18, local_shell_name=?19, local_shell_icon=?20, local_start_dir=?21, \
         agent_forwarding=?22, proxy_type=?23, proxy_host=?24, proxy_port=?25, proxy_username=?26, proxy_no_proxy=?27, \
         proxy_profile_id=?28, ssh_input_compatibility=?29 WHERE id=?30",
        params![
            p.name,
            p.host,
            p.port as u32,
            p.credential_id,
            p.bastion_profile_id,
            p.init_command,
            p.group_id,
            algorithms,
            p.sftp_protocol,
            p.sftp_sudo,
            p.sftp_encoding,
            p.icon_source,
            p.icon_color,
            p.totp_auto_submit,
            p.totp_regex,
            p.protocol,
            p.local_shell,
            local_shell_args,
            p.local_shell_name,
            p.local_shell_icon,
            p.local_start_dir,
            p.agent_forwarding,
            p.proxy_type,
            p.proxy_host,
            p.proxy_port.map(|v| v as u32),
            p.proxy_username,
            p.proxy_no_proxy,
            p.proxy_profile_id,
            p.ssh_input_compatibility,
            p.id
        ],
    )?;
    Ok(())
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    // Deleting an SSH profile must also purge its AI conversations (keyed
    // "ssh:<id>", holding UNREDACTED terminal output). Once the profile is gone
    // the AI panel — which only opens per live target — can't reach them, so
    // they'd linger in the DB forever with no way to clear them. Atomic so a
    // crash can't leave the profile deleted but its transcripts behind.
    let convo_key = crate::db::ai_conversation::ssh_target_key(id);
    db.with_transaction(|tx| {
        tx.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM ai_conversations WHERE target_key = ?1",
            params![convo_key],
        )?;
        Ok(())
    })
}

pub fn clear_all_tx(conn: &rusqlite::Connection) -> AppResult<()> {
    conn.execute("DELETE FROM profiles", [])?;
    Ok(())
}

pub fn clear_all(db: &Db) -> AppResult<()> {
    let conn = db.lock()?;
    clear_all_tx(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, name: &str) -> Profile {
        Profile {
            id: id.into(),
            name: name.into(),
            host: "h.example".into(),
            port: 22,
            credential_id: "c1".into(),
            bastion_profile_id: None,
            init_command: None,
            group_id: None,
            algorithms: SshAlgorithms::default(),
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
            proxy_profile_id: None,
            ssh_input_compatibility: None,
        }
    }

    /// 本地 shell 主机：protocol == "local" 豁免空 credential_id
    /// （Netcatty createLocalShellHost 语义：host 固定 localhost、无凭证）。
    fn mk_local(id: &str, name: &str) -> Profile {
        Profile {
            id: id.into(),
            name: name.into(),
            host: "localhost".into(),
            port: 22,
            credential_id: String::new(),
            protocol: "local".into(),
            local_shell: Some("cmd.exe".into()),
            local_shell_args: Some(vec![]),
            local_shell_name: Some("CMD".into()),
            local_shell_icon: Some("cmd".into()),
            local_start_dir: Some("~".into()),
            ..mk(id, name)
        }
    }

    #[test]
    fn local_profile_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk_local("l1", "项目 A · CMD")).unwrap();
        let got = get(&db, "l1").unwrap();
        assert_eq!(got.protocol, "local");
        assert_eq!(got.host, "localhost");
        assert!(got.credential_id.is_empty());
        assert_eq!(got.local_shell.as_deref(), Some("cmd.exe"));
        assert_eq!(got.local_shell_args, Some(vec![]));
        assert_eq!(got.local_shell_name.as_deref(), Some("CMD"));
        assert_eq!(got.local_shell_icon.as_deref(), Some("cmd"));
        assert_eq!(got.local_start_dir.as_deref(), Some("~"));
    }

    #[test]
    fn local_profile_allows_empty_credential_id() {
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk_local("l1", "local-a")).unwrap();
        let mut updated = mk_local("l1", "local-a");
        updated.local_start_dir = None;
        update(&db, &updated).unwrap();
        assert!(get(&db, "l1").unwrap().local_start_dir.is_none());
    }

    #[test]
    fn legacy_profile_defaults_protocol_ssh() {
        // 旧行（无 protocol 列语义）经迁移后读出默认 "ssh"，
        // 本地主机分支不得误伤历史 SSH 主机。
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk("p1", "alpha")).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.protocol, "ssh");
        assert!(got.local_shell.is_none());
    }

    #[test]
    fn insert_then_get_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let p = mk("p1", "alpha");
        insert(&db, &p).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.name, "alpha");
        assert_eq!(got.host, "h.example");
        assert_eq!(got.port, 22);
        assert_eq!(got.algorithms, SshAlgorithms::default());
    }

    #[test]
    fn get_missing_returns_not_found() {
        let db = Db::open_in_memory().unwrap();
        let err = get(&db, "ghost").unwrap_err();
        assert_eq!(err.code(), "profile_not_found");
    }

    #[test]
    fn upsert_overwrites_fields() {
        // 同 id 第二次 insert = UPDATE。host 字段必须被新值覆盖，
        // 否则前端"编辑 profile"功能会留下脏数据。
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk("p1", "alpha")).unwrap();
        let mut updated = mk("p1", "alpha");
        updated.host = "new.example".into();
        updated.port = 2222;
        insert(&db, &updated).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.host, "new.example");
        assert_eq!(got.port, 2222);
    }

    /// v43 新列三态往返：NULL 必须区别于显式 false（NULL = 老数据默认开启）。
    #[test]
    fn ssh_input_compatibility_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("p1", "alpha");

        insert(&db, &p).unwrap();
        assert_eq!(get(&db, "p1").unwrap().ssh_input_compatibility, None);

        p.ssh_input_compatibility = Some(true);
        insert(&db, &p).unwrap();
        assert_eq!(get(&db, "p1").unwrap().ssh_input_compatibility, Some(true));

        p.ssh_input_compatibility = Some(false);
        insert(&db, &p).unwrap();
        assert_eq!(get(&db, "p1").unwrap().ssh_input_compatibility, Some(false));

        // update 路径同样要写这一列，且能把显式值改回 NULL。
        p.ssh_input_compatibility = None;
        update(&db, &p).unwrap();
        assert_eq!(get(&db, "p1").unwrap().ssh_input_compatibility, None);
    }

    #[test]
    fn algorithms_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("p1", "alpha");
        p.algorithms.kex.push("diffie-hellman-group1-sha1".into());
        p.algorithms.cipher = vec!["aes128-ctr".into()];
        insert(&db, &p).unwrap();
        let got = get(&db, "p1").unwrap();
        assert!(got
            .algorithms
            .kex
            .contains(&"diffie-hellman-group1-sha1".into()));
        assert_eq!(got.algorithms.cipher, vec!["aes128-ctr"]);
    }

    #[test]
    fn list_sorted_by_name_asc() {
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk("p3", "charlie")).unwrap();
        insert(&db, &mk("p1", "alpha")).unwrap();
        insert(&db, &mk("p2", "bravo")).unwrap();
        let names: Vec<String> = list(&db).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn delete_removes_row() {
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk("p1", "alpha")).unwrap();
        delete(&db, "p1").unwrap();
        assert_eq!(get(&db, "p1").unwrap_err().code(), "profile_not_found");
    }

    /// #2: an SSH profile's AI conversations (target_key "ssh:<id>", holding
    /// UNREDACTED terminal output) must die with the profile — otherwise they
    /// linger unreachable in the DB, since the AI panel only opens per live
    /// target. Scoped: other profiles' and non-ssh conversations stay untouched.
    #[test]
    fn delete_purges_profile_ai_conversations() {
        use crate::db::ai_conversation;
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk("p1", "web")).unwrap();
        insert(&db, &mk("p2", "db")).unwrap();
        ai_conversation::create(&db, "c1", &ai_conversation::ssh_target_key("p1")).unwrap();
        ai_conversation::create(&db, "c2", &ai_conversation::ssh_target_key("p2")).unwrap();
        ai_conversation::create(&db, "c3", "local").unwrap();

        delete(&db, "p1").unwrap();

        assert!(ai_conversation::get(&db, "c1").unwrap().is_none());
        assert!(ai_conversation::get(&db, "c2").unwrap().is_some());
        assert!(ai_conversation::get(&db, "c3").unwrap().is_some());
    }

    #[test]
    fn insert_rejects_name_with_control_char() {
        // validate_name 拦截 C0 控制符 — OSC 7337 注入防线
        let db = Db::open_in_memory().unwrap();
        let mut bad = mk("p1", "evil\x1b]52");
        bad.name = "evil\x1b]52".into();
        assert_eq!(
            insert(&db, &bad).unwrap_err().code(),
            "name_has_control_char"
        );
    }

    /// 应用层不变量：Profile.credential_id 永远非空。
    /// db layer 是 single source of truth —— UI/CLI 表层校验之外，任何路径
    /// （Tauri create_profile、外部脚本、未来新写入入口）走到这里都必须被拦下。
    #[test]
    fn insert_rejects_empty_credential_id() {
        let db = Db::open_in_memory().unwrap();
        let mut bad = mk("p1", "alpha");
        bad.credential_id = String::new();
        assert_eq!(
            insert(&db, &bad).unwrap_err().code(),
            "profile_credential_id_required"
        );
    }

    #[test]
    fn update_rejects_empty_credential_id() {
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk("p1", "alpha")).unwrap();
        let mut bad = mk("p1", "alpha");
        bad.credential_id = String::new();
        assert_eq!(
            update(&db, &bad).unwrap_err().code(),
            "profile_credential_id_required"
        );
    }

    #[test]
    fn update_rejects_name_with_control_char() {
        let db = Db::open_in_memory().unwrap();
        insert(&db, &mk("p1", "good")).unwrap();
        let mut bad = mk("p1", "good");
        bad.name = "bad\x07name".into();
        assert_eq!(
            update(&db, &bad).unwrap_err().code(),
            "name_has_control_char"
        );
    }

    #[test]
    fn insert_rejects_marker_only_kex_policy() {
        let db = Db::open_in_memory().unwrap();
        let mut bad = mk("p1", "alpha");
        bad.algorithms.kex = vec!["ext-info-c".into(), "kex-strict-c-v00@openssh.com".into()];

        assert_eq!(
            insert(&db, &bad).unwrap_err().code(),
            "profile_algorithms_invalid"
        );
    }
}
