use rusqlite::params;

use super::Db;
use crate::error::{AppError, AppResult};
use crate::models::SessionLog;

const COLS: &str = "id, session_id, host_id, host_name, title, format, path, started_at, \
     ended_at, duration_ms, size_bytes, event_count, status";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<SessionLog> {
    Ok(SessionLog {
        id: row.get(0)?,
        session_id: row.get(1)?,
        host_id: row.get(2)?,
        host_name: row.get(3)?,
        title: row.get(4)?,
        format: row.get(5)?,
        path: row.get(6)?,
        started_at: row.get(7)?,
        ended_at: row.get(8)?,
        duration_ms: row.get(9)?,
        size_bytes: row.get(10)?,
        event_count: row.get(11)?,
        status: row.get(12)?,
    })
}

pub fn list(db: &Db) -> AppResult<Vec<SessionLog>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM session_logs ORDER BY started_at DESC, id ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(db: &Db, id: &str) -> AppResult<SessionLog> {
    let conn = db.lock()?;
    conn.query_row(
        &format!("SELECT {COLS} FROM session_logs WHERE id = ?1"),
        params![id],
        from_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            AppError::not_found("session_log_not_found", serde_json::json!({ "id": id }))
        }
        other => other.into(),
    })
}

pub fn upsert(db: &Db, log: &SessionLog) -> AppResult<()> {
    let conn = db.lock()?;
    conn.execute(
        "INSERT INTO session_logs \
         (id, session_id, host_id, host_name, title, format, path, started_at, ended_at, \
          duration_ms, size_bytes, event_count, status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) \
         ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, host_id=excluded.host_id, \
          host_name=excluded.host_name, title=excluded.title, format=excluded.format, \
          path=excluded.path, started_at=excluded.started_at, ended_at=excluded.ended_at, \
          duration_ms=excluded.duration_ms, size_bytes=excluded.size_bytes, \
          event_count=excluded.event_count, status=excluded.status",
        params![
            log.id,
            log.session_id,
            log.host_id,
            log.host_name,
            log.title,
            log.format,
            log.path,
            log.started_at,
            log.ended_at,
            log.duration_ms,
            log.size_bytes,
            log.event_count,
            log.status,
        ],
    )?;
    Ok(())
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    let conn = db.lock()?;
    let changed = conn.execute("DELETE FROM session_logs WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::not_found(
            "session_log_not_found",
            serde_json::json!({ "id": id }),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(file: &str, started_at: i64) -> SessionLog {
        SessionLog {
            id: format!("cast:{file}"),
            session_id: "s1".into(),
            host_id: Some("h1".into()),
            host_name: "prod".into(),
            title: "prod session".into(),
            format: "asciicast".into(),
            path: file.into(),
            started_at,
            ended_at: Some(started_at + 1000),
            duration_ms: 1000,
            size_bytes: 2048,
            event_count: 2,
            status: "completed".into(),
        }
    }

    #[test]
    fn upsert_then_get_roundtrips_all_fields() {
        let db = Db::open_in_memory().unwrap();
        upsert(&db, &mk("a.cast", 100)).unwrap();
        let got = get(&db, "cast:a.cast").unwrap();
        assert_eq!(got.session_id, "s1");
        assert_eq!(got.host_id.as_deref(), Some("h1"));
        assert_eq!(got.host_name, "prod");
        assert_eq!(got.title, "prod session");
        assert_eq!(got.format, "asciicast");
        assert_eq!(got.path, "a.cast");
        assert_eq!(got.started_at, 100);
        assert_eq!(got.ended_at, Some(1100));
        assert_eq!(got.duration_ms, 1000);
        assert_eq!(got.size_bytes, 2048);
        assert_eq!(got.event_count, 2);
        assert_eq!(got.status, "completed");
    }

    #[test]
    fn list_orders_by_started_at_desc_then_id_asc() {
        let db = Db::open_in_memory().unwrap();
        upsert(&db, &mk("a.cast", 100)).unwrap();
        upsert(&db, &mk("b.cast", 300)).unwrap();
        upsert(&db, &mk("c.cast", 200)).unwrap();
        upsert(&db, &mk("a2.cast", 200)).unwrap();
        let ids: Vec<String> = list(&db).unwrap().into_iter().map(|l| l.id).collect();
        assert_eq!(
            ids,
            vec!["cast:b.cast", "cast:a2.cast", "cast:c.cast", "cast:a.cast"]
        );
    }

    #[test]
    fn delete_reports_missing_id() {
        let db = Db::open_in_memory().unwrap();
        upsert(&db, &mk("a.cast", 100)).unwrap();
        delete(&db, "cast:a.cast").unwrap();
        assert_eq!(get(&db, "cast:a.cast").unwrap_err().code(), "session_log_not_found");
        assert_eq!(delete(&db, "cast:a.cast").unwrap_err().code(), "session_log_not_found");
    }

    #[test]
    fn upsert_overwrites_statistics() {
        let db = Db::open_in_memory().unwrap();
        upsert(&db, &mk("a.cast", 100)).unwrap();
        let mut updated = mk("a.cast", 100);
        updated.title = "renamed".into();
        updated.duration_ms = 5000;
        updated.ended_at = Some(5100);
        updated.size_bytes = 999;
        updated.event_count = 7;
        updated.status = "truncated".into();
        upsert(&db, &updated).unwrap();
        let got = get(&db, "cast:a.cast").unwrap();
        assert_eq!(got.title, "renamed");
        assert_eq!(got.duration_ms, 5000);
        assert_eq!(got.ended_at, Some(5100));
        assert_eq!(got.size_bytes, 999);
        assert_eq!(got.event_count, 7);
        assert_eq!(got.status, "truncated");
    }
}
