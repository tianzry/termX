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
        serial_port: row.get(30)?,
        serial_baud: row.get(31)?,
        serial_data_bits: row.get(32)?,
        serial_parity: row.get(33)?,
        serial_stop_bits: row.get(34)?,
        serial_flow: row.get(35)?,
        serial_local_echo: row.get(36)?,
        serial_line_mode: row.get(37)?,
        serial_backspace: row.get(38)?,
        serial_byte_backspace: row.get(39)?,
        serial_charset: row.get(40)?,
        distro: row.get(41)?,
        host_key_policy: row.get(42)?,
        telnet_username: row.get(43)?,
        telnet_charset: row.get(44)?,
        keyword_highlight_enabled: row.get(45)?,
        keyword_highlight_rules: parse_keyword_rules(row.get(46)?),
        auto_session_log: row.get(47)?,
        serial_term_opts: parse_serial_term_opts(row.get(48)?),
    })
}

/// 主机级高亮规则以 JSON 文本入库；NULL / 空 / 坏 JSON 一律落回 None
/// （= 没有主机规则，只用全局规则），与 local_shell_args 同款容错。
fn parse_keyword_rules(raw: Option<String>) -> Option<Vec<crate::models::KeywordHighlightRule>> {
    let raw = raw.filter(|s| !s.trim().is_empty())?;
    match serde_json::from_str::<Vec<crate::models::KeywordHighlightRule>>(&raw) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!(
                "failed to parse profile.keyword_highlight_rules JSON ({} bytes), ignoring: {e}",
                raw.len()
            );
            None
        }
    }
}

fn keyword_rules_json(
    rules: &Option<Vec<crate::models::KeywordHighlightRule>>,
) -> Option<String> {
    rules
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".into()))
}

/// `#RRGGBB`（允许小写）；与前端 normalize 的校验口径一致。
fn is_hex_color(s: &str) -> bool {
    s.len() == 7
        && s.starts_with('#')
        && s[1..].chars().all(|c| c.is_ascii_hexdigit())
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

/// 串口「终端」分组选项以 JSON 文本入库；NULL / 空 / 坏 JSON 一律落回 None
///（= 前端回落默认值），与 keyword_highlight_rules 同款容错。
fn parse_serial_term_opts(raw: Option<String>) -> Option<crate::models::SerialTermOpts> {
    let raw = raw.filter(|s| !s.trim().is_empty())?;
    match serde_json::from_str::<crate::models::SerialTermOpts>(&raw) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!(
                "failed to parse profile.serial_term_opts JSON ({} bytes), ignoring: {e}",
                raw.len()
            );
            None
        }
    }
}

fn serial_term_opts_json(opts: &Option<crate::models::SerialTermOpts>) -> Option<String> {
    opts.as_ref().map(|v| {
        serde_json::to_string(v)
            .unwrap_or_else(|_| serde_json::to_string(&crate::models::SerialTermOpts::default())
                .expect("SerialTermOpts 只含字符串与布尔，序列化不会失败"))
    })
}

fn algorithms_json(p: &Profile) -> AppResult<String> {
    serde_json::to_string(&p.algorithms)
        .map_err(|e| AppError::other("serde_failed", json!({ "err": e.to_string() })))
}

/// Profile 表全列清单（row_to_profile 按索引读，顺序是 single source of truth）。
const PROFILE_COLUMNS: &str = "id, name, host, port, credential_id, bastion_profile_id, init_command, group_id, algorithms, sftp_protocol, sftp_sudo, sftp_encoding, icon_source, icon_color, totp_auto_submit, totp_regex, protocol, local_shell, local_shell_args, local_shell_name, local_shell_icon, local_start_dir, agent_forwarding, proxy_type, proxy_host, proxy_port, proxy_username, proxy_no_proxy, proxy_profile_id, ssh_input_compatibility, serial_port, serial_baud, serial_data_bits, serial_parity, serial_stop_bits, serial_flow, serial_local_echo, serial_line_mode, serial_backspace, serial_byte_backspace, serial_charset, distro, host_key_policy, telnet_username, telnet_charset, keyword_highlight_enabled, keyword_highlight_rules, auto_session_log, serial_term_opts";





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
    // 协议白名单（schema v48 起含 telnet）：拒绝未知值，避免前端/同步
    // 写入拼写错误的 protocol 后连接层静默按 SSH 处理。
    if !matches!(p.protocol.as_str(), "ssh" | "local" | "serial" | "telnet") {
        return Err(AppError::config(
            "profile_protocol_invalid",
            serde_json::json!({ "id": p.id, "protocol": p.protocol }),
        ));
    }
    // 本地 shell / Telnet 主机没有 SSH 凭证概念，豁免空 credential_id；
    // SSH 主机维持"必须引用真实凭证"的既有不变量。
    if p.protocol != "local" && p.protocol != "telnet" && p.credential_id.is_empty() {
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
    // 主机级关键字高亮规则：上限与前端一致（30 条 / 16 正则 / 每条 2000 字符），
    // 拒绝非法颜色，避免同步导入或 CLI 写入把超大/坏数据塞进 DB。
    if let Some(rules) = &p.keyword_highlight_rules {
        if rules.len() > 30 {
            return Err(AppError::config(
                "profile_keyword_rules_too_many",
                serde_json::json!({ "id": p.id, "count": rules.len() }),
            ));
        }
        for rule in rules {
            if rule.id.trim().is_empty() || rule.label.trim().is_empty() {
                return Err(AppError::config(
                    "profile_keyword_rule_invalid",
                    serde_json::json!({ "id": p.id, "rule": rule.id }),
                ));
            }
            if !is_hex_color(&rule.color) {
                return Err(AppError::config(
                    "profile_keyword_rule_color_invalid",
                    serde_json::json!({ "id": p.id, "color": rule.color }),
                ));
            }
            if rule.patterns.len() > 16
                || rule.patterns.iter().any(|s| s.chars().count() > 2000)
            {
                return Err(AppError::config(
                    "profile_keyword_rule_patterns_invalid",
                    serde_json::json!({ "id": p.id, "rule": rule.id }),
                ));
            }
        }
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
    let keyword_rules = keyword_rules_json(&p.keyword_highlight_rules);
    conn.execute(
        "INSERT INTO profiles (id, name, host, port, credential_id, bastion_profile_id, init_command, group_id, algorithms, \
         sftp_protocol, sftp_sudo, sftp_encoding, icon_source, icon_color, totp_auto_submit, totp_regex, \
         protocol, local_shell, local_shell_args, local_shell_name, local_shell_icon, local_start_dir, agent_forwarding, \
         proxy_type, proxy_host, proxy_port, proxy_username, proxy_no_proxy, proxy_profile_id, \
         ssh_input_compatibility, serial_port, serial_baud, serial_data_bits, serial_parity, serial_stop_bits, serial_flow, serial_local_echo, serial_line_mode, serial_backspace, serial_byte_backspace, serial_charset, distro, host_key_policy, \
         telnet_username, telnet_charset, keyword_highlight_enabled, keyword_highlight_rules, auto_session_log, serial_term_opts) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, ?49) \
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
         ssh_input_compatibility=excluded.ssh_input_compatibility, \
         serial_port=excluded.serial_port, serial_baud=excluded.serial_baud, serial_data_bits=excluded.serial_data_bits, \
         serial_parity=excluded.serial_parity, serial_stop_bits=excluded.serial_stop_bits, serial_flow=excluded.serial_flow, \
         serial_local_echo=excluded.serial_local_echo, serial_line_mode=excluded.serial_line_mode, \
         serial_backspace=excluded.serial_backspace, serial_byte_backspace=excluded.serial_byte_backspace, \
         serial_charset=excluded.serial_charset, \
         distro=COALESCE(excluded.distro, distro), \
         host_key_policy=excluded.host_key_policy, \
         telnet_username=excluded.telnet_username, telnet_charset=excluded.telnet_charset, \
         keyword_highlight_enabled=excluded.keyword_highlight_enabled, \
         keyword_highlight_rules=excluded.keyword_highlight_rules, \
         auto_session_log=excluded.auto_session_log, serial_term_opts=excluded.serial_term_opts",
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
            p.ssh_input_compatibility,
            p.serial_port,
            p.serial_baud,
            p.serial_data_bits,
            p.serial_parity,
            p.serial_stop_bits,
            p.serial_flow,
            p.serial_local_echo,
            p.serial_line_mode,
            p.serial_backspace,
            p.serial_byte_backspace,
            p.serial_charset,
            p.distro,
            p.host_key_policy,
            p.telnet_username,
            p.telnet_charset,
            p.keyword_highlight_enabled,
            keyword_rules,
            p.auto_session_log,
            serial_term_opts_json(&p.serial_term_opts)
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
    let keyword_rules = keyword_rules_json(&p.keyword_highlight_rules);
    conn.execute(
        "UPDATE profiles SET name=?1, host=?2, port=?3, credential_id=?4, bastion_profile_id=?5, init_command=?6, group_id=?7, algorithms=?8, \
         sftp_protocol=?9, sftp_sudo=?10, sftp_encoding=?11, icon_source=?12, icon_color=?13, totp_auto_submit=?14, totp_regex=?15, \
         protocol=?16, local_shell=?17, local_shell_args=?18, local_shell_name=?19, local_shell_icon=?20, local_start_dir=?21, \
         agent_forwarding=?22, proxy_type=?23, proxy_host=?24, proxy_port=?25, proxy_username=?26, proxy_no_proxy=?27, \
         proxy_profile_id=?28, ssh_input_compatibility=?29, serial_port=?30, serial_baud=?31, serial_data_bits=?32, \
         serial_parity=?33, serial_stop_bits=?34, serial_flow=?35, serial_local_echo=?36, serial_line_mode=?37, \
         serial_backspace=?38, serial_byte_backspace=?39, serial_charset=?40, \
         distro=COALESCE(?41, distro), host_key_policy=?42, \
         telnet_username=?43, telnet_charset=?44, \
         keyword_highlight_enabled=?45, keyword_highlight_rules=?46, auto_session_log=?47, serial_term_opts=?48 WHERE id=?49",
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
            p.serial_port,
            p.serial_baud,
            p.serial_data_bits,
            p.serial_parity,
            p.serial_stop_bits,
            p.serial_flow,
            p.serial_local_echo,
            p.serial_line_mode,
            p.serial_backspace,
            p.serial_byte_backspace,
            p.serial_charset,
            p.distro,
            p.host_key_policy,
            p.telnet_username,
            p.telnet_charset,
            p.keyword_highlight_enabled,
            keyword_rules,
            p.auto_session_log,
            serial_term_opts_json(&p.serial_term_opts),
            p.id
        ],
    )?;
    Ok(())
}

/// 自动探测结果写入：仅在 `distro` 仍为 NULL / 空串时更新。
///
/// 策略说明（对齐任务要求）：本轮没有「手动设置发行版」UI，为避免后续自动
/// 探测覆盖用户心中认定的结果，采用「已有值不覆盖」——第一次成功探测写入
/// 后再连接同一主机不会改写。返回 true 表示本次确实写入了新值。
pub fn set_distro_if_unset(db: &Db, id: &str, distro: &str) -> AppResult<bool> {
    let conn = db.lock()?;
    let affected = conn.execute(
        "UPDATE profiles SET distro = ?1 WHERE id = ?2 AND (distro IS NULL OR trim(distro) = '')",
        params![distro, id],
    )?;
    Ok(affected > 0)
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
            keyword_highlight_enabled: None,
            keyword_highlight_rules: None,
            auto_session_log: None,
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
    fn auto_session_log_roundtrips_null_false_true() {
        let db = Db::open_in_memory().unwrap();
        // NULL（默认）读回 None。
        insert(&db, &mk("p1", "alpha")).unwrap();
        assert_eq!(get(&db, "p1").unwrap().auto_session_log, None);
        // 显式 true 持久化。
        let mut on = mk("p1", "alpha");
        on.auto_session_log = Some(true);
        update(&db, &on).unwrap();
        assert_eq!(get(&db, "p1").unwrap().auto_session_log, Some(true));
        // 显式 false 与 NULL 都表示关闭，但 true→None 必须清掉。
        let mut off = mk("p1", "alpha");
        off.auto_session_log = None;
        update(&db, &off).unwrap();
        assert_eq!(get(&db, "p1").unwrap().auto_session_log, None);
    }

    #[test]
    fn distro_persist_and_no_overwrite() {
        let db = Db::open_in_memory().unwrap();
        // 首次探测：NULL → 写入。
        insert(&db, &mk("p1", "alpha")).unwrap();
        assert!(set_distro_if_unset(&db, "p1", "ubuntu").unwrap());
        assert_eq!(get(&db, "p1").unwrap().distro.as_deref(), Some("ubuntu"));
        // 已有值不覆盖。
        assert!(!set_distro_if_unset(&db, "p1", "debian").unwrap());
        assert_eq!(get(&db, "p1").unwrap().distro.as_deref(), Some("ubuntu"));
        // 整档 update 未携带 distro 时（None）也不得清空已探测结果。
        let mut p = mk("p1", "alpha");
        p.distro = None;
        update(&db, &p).unwrap();
        assert_eq!(get(&db, "p1").unwrap().distro.as_deref(), Some("ubuntu"));
    }

    #[test]
    fn host_key_policy_roundtrip_and_clear() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("p1", "alpha");
        assert_eq!(p.host_key_policy, None);
        insert(&db, &p).unwrap();
        assert_eq!(get(&db, "p1").unwrap().host_key_policy, None);

        p.host_key_policy = Some("verify".into());
        update(&db, &p).unwrap();
        assert_eq!(
            get(&db, "p1").unwrap().host_key_policy.as_deref(),
            Some("verify")
        );

        // 切回「跟随全局」= null 必须能清空，而不是被 COALESCE 保留。
        p.host_key_policy = Some("skip".into());
        update(&db, &p).unwrap();
        assert_eq!(
            get(&db, "p1").unwrap().host_key_policy.as_deref(),
            Some("skip")
        );
        p.host_key_policy = None;
        update(&db, &p).unwrap();
        assert_eq!(get(&db, "p1").unwrap().host_key_policy, None);
    }

    #[test]
    fn host_keyword_highlight_roundtrip_and_clear() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("p1", "alpha");
        assert_eq!(p.keyword_highlight_enabled, None);
        assert_eq!(p.keyword_highlight_rules, None);
        insert(&db, &p).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.keyword_highlight_enabled, None);
        assert_eq!(got.keyword_highlight_rules, None);

        p.keyword_highlight_enabled = Some(true);
        p.keyword_highlight_rules = Some(vec![crate::models::KeywordHighlightRule {
            id: "cover".into(),
            label: "Cover".into(),
            patterns: vec!["COVERED".into()],
            color: "#FF00AA".into(),
            enabled: true,
        }]);
        update(&db, &p).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.keyword_highlight_enabled, Some(true));
        let rules = got.keyword_highlight_rules.unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "cover");
        assert_eq!(rules[0].color, "#FF00AA");
        assert_eq!(rules[0].patterns, vec!["COVERED".to_string()]);

        // 清回「仅全局」：两列都必须能回到 NULL。
        p.keyword_highlight_enabled = None;
        p.keyword_highlight_rules = None;
        update(&db, &p).unwrap();
        let got = get(&db, "p1").unwrap();
        assert_eq!(got.keyword_highlight_enabled, None);
        assert_eq!(got.keyword_highlight_rules, None);
    }

    #[test]
    fn host_keyword_highlight_rejects_invalid_rules() {
        let db = Db::open_in_memory().unwrap();
        let mut bad = mk("p1", "alpha");
        bad.keyword_highlight_rules = Some(vec![crate::models::KeywordHighlightRule {
            id: "bad".into(),
            label: "Bad".into(),
            patterns: vec!["x".into()],
            color: "red".into(),
            enabled: true,
        }]);
        assert_eq!(
            insert(&db, &bad).unwrap_err().code(),
            "profile_keyword_rule_color_invalid"
        );
    }

    #[test]
    fn telnet_profile_roundtrip_and_allows_empty_credential() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("t1", "交换机 A · Telnet");
        p.protocol = "telnet".into();
        p.host = "10.0.0.9".into();
        p.port = 23;
        p.credential_id = String::new();
        p.telnet_username = Some("admin".into());
        p.telnet_charset = Some("gb18030".into());

        insert(&db, &p).unwrap();
        let got = get(&db, "t1").unwrap();
        assert_eq!(got.protocol, "telnet");
        assert_eq!(got.port, 23);
        assert!(got.credential_id.is_empty());
        assert_eq!(got.telnet_username.as_deref(), Some("admin"));
        assert_eq!(got.telnet_charset.as_deref(), Some("gb18030"));

        // update 路径可把字段清回 NULL（跟随默认 utf-8 / 不自动登录）。
        p.telnet_username = None;
        p.telnet_charset = None;
        update(&db, &p).unwrap();
        let got = get(&db, "t1").unwrap();
        assert_eq!(got.telnet_username, None);
        assert_eq!(got.telnet_charset, None);
    }

    #[test]
    fn unknown_protocol_rejected() {
        let db = Db::open_in_memory().unwrap();
        let mut bad = mk("p1", "alpha");
        bad.protocol = "carrier-pigeon".into();
        assert_eq!(
            insert(&db, &bad).unwrap_err().code(),
            "profile_protocol_invalid"
        );
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

    /// v44 串口主机字段：insert / upsert / update 三条写入路径都要落库，
    /// 非串口主机保持 None（旧库读回不误伤）。
    #[test]
    fn serial_profile_fields_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let mut p = mk("s1", "串口 COM3");
        p.protocol = "serial".into();
        p.host = "COM3".into();
        p.port = 0;
        p.serial_port = Some("COM3".into());
        p.serial_baud = Some(115200);
        p.serial_data_bits = Some(8);
        p.serial_parity = Some("even".into());
        p.serial_stop_bits = Some(1.5);
        p.serial_flow = Some("hardware".into());
        p.serial_local_echo = Some(true);
        p.serial_line_mode = Some(true);
        p.serial_backspace = Some("ctrl-h".into());
        p.serial_byte_backspace = Some(true);
        p.serial_charset = Some("GBK".into());

        insert(&db, &p).unwrap();
        let got = get(&db, "s1").unwrap();
        assert_eq!(got.protocol, "serial");
        assert_eq!(got.host, "COM3");
        assert_eq!(got.port, 0);
        assert_eq!(got.serial_port.as_deref(), Some("COM3"));
        assert_eq!(got.serial_baud, Some(115200));
        assert_eq!(got.serial_data_bits, Some(8));
        assert_eq!(got.serial_parity.as_deref(), Some("even"));
        assert_eq!(got.serial_stop_bits, Some(1.5));
        assert_eq!(got.serial_flow.as_deref(), Some("hardware"));
        assert_eq!(got.serial_local_echo, Some(true));
        assert_eq!(got.serial_line_mode, Some(true));
        assert_eq!(got.serial_backspace.as_deref(), Some("ctrl-h"));
        assert_eq!(got.serial_byte_backspace, Some(true));
        assert_eq!(got.serial_charset.as_deref(), Some("GBK"));

        // upsert 覆盖：把串口帧设置改回 NULL，读回必须是 None 而不是旧值。
        p.serial_parity = None;
        p.serial_line_mode = None;
        insert(&db, &p).unwrap();
        let got = get(&db, "s1").unwrap();
        assert_eq!(got.serial_parity, None);
        assert_eq!(got.serial_line_mode, None);

        // update 路径同样带上全部串口列。
        p.serial_baud = Some(9600);
        update(&db, &p).unwrap();
        assert_eq!(get(&db, "s1").unwrap().serial_baud, Some(9600));
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
