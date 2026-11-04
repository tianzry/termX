//! 主机级环境变量（对齐 Netcatty `environmentVariables`）。
//!
//! 独立于 `profiles` 表：变量是有序列表、同名可多次出现（后写入者生效），
//! 塞进 Profile JSON 会改变对外 wire contract，也会让旧客户端丢字段。
//!
//! 连接时通过 SSH `SetEnv` 请求发送；OpenSSH 服务端需在 `sshd_config`
//! 的 `AcceptEnv` 里放行对应变量名，否则服务端会静默丢弃（不影响连接）。

use rusqlite::params;

use crate::db::Db;
use crate::error::AppResult;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EnvVar {
    pub name: String,
    #[serde(default)]
    pub value: String,
}

pub fn list(db: &Db, profile_id: &str) -> AppResult<Vec<EnvVar>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare(
        "SELECT name, value FROM profile_env_vars
         WHERE profile_id = ?1 ORDER BY sort_index, id",
    )?;
    let rows = stmt.query_map([profile_id], |row| {
        Ok(EnvVar {
            name: row.get(0)?,
            value: row.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn replace(db: &Db, profile_id: &str, vars: &[EnvVar]) -> AppResult<()> {
    db.with_transaction(|tx| {
        tx.execute(
            "DELETE FROM profile_env_vars WHERE profile_id = ?1",
            [profile_id],
        )?;
        for (index, var) in vars.iter().enumerate() {
            let name = var.name.trim();
            // 空名 / 非法名直接跳过：SSH SetEnv 的名称必须是服务端认识的标识符。
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
            tx.execute(
                "INSERT INTO profile_env_vars (profile_id, name, value, sort_index)
                 VALUES (?1, ?2, ?3, ?4)",
                params![profile_id, name, var.value, index as i64],
            )?;
        }
        Ok(())
    })
}

pub fn delete_for_profile(db: &Db, profile_id: &str) -> AppResult<()> {
    let conn = db.lock()?;
    conn.execute(
        "DELETE FROM profile_env_vars WHERE profile_id = ?1",
        [profile_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_keeps_order_and_skips_invalid_names() {
        let db = Db::open_in_memory().unwrap();
        replace(
            &db,
            "p1",
            &[
                EnvVar {
                    name: " LANG ".into(),
                    value: "en_US.UTF-8".into(),
                },
                EnvVar {
                    name: "".into(),
                    value: "ignored".into(),
                },
                EnvVar {
                    name: "BAD-NAME".into(),
                    value: "ignored".into(),
                },
                EnvVar {
                    name: "FOO".into(),
                    value: "bar".into(),
                },
            ],
        )
        .unwrap();

        let vars = list(&db, "p1").unwrap();
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].name, "LANG");
        assert_eq!(vars[1].value, "bar");

        // 全量替换语义：第二次只保留新值，且不影响其他主机。
        replace(&db, "p2", &[]).unwrap();
        replace(&db, "p1", &[EnvVar { name: "TERM".into(), value: "xterm-256color".into() }]).unwrap();
        assert_eq!(list(&db, "p1").unwrap().len(), 1);
        delete_for_profile(&db, "p1").unwrap();
        assert!(list(&db, "p1").unwrap().is_empty());
    }
}
