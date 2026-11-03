use rusqlite::params;

use super::Db;
use crate::error::{AppError, AppResult};
use crate::models::Note;

const COLS: &str = "id, title, content, group_name, tags, linked_host_ids, created_at, updated_at, \
     order_index, is_pinned";

fn json_list(raw: &str) -> Vec<String> {
    // 单行数据损坏不应该让整个笔记列表打不开：坏 JSON 按空列表处理，
    // 下次保存时会被正常写回。
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    let tags: String = row.get(4)?;
    let linked_host_ids: String = row.get(5)?;
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        group: row.get(3)?,
        tags: json_list(&tags),
        linked_host_ids: json_list(&linked_host_ids),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        order: row.get(8)?,
        is_pinned: row.get::<_, i64>(9)? != 0,
    })
}

fn clean_strings(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|item| item == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

fn clean_group(group: &Option<String>) -> Option<String> {
    group
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn validate(note: &Note) -> AppResult<()> {
    if note.id.trim().is_empty() {
        return Err(AppError::other("note_id_required", serde_json::json!({})));
    }
    Ok(())
}

pub fn list(db: &Db) -> AppResult<Vec<Note>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM notes ORDER BY is_pinned DESC, updated_at DESC, id ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get(db: &Db, id: &str) -> AppResult<Note> {
    let conn = db.lock()?;
    conn.query_row(
        &format!("SELECT {COLS} FROM notes WHERE id = ?1"),
        params![id],
        from_row,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            AppError::not_found("note_not_found", serde_json::json!({ "id": id }))
        }
        other => other.into(),
    })
}

pub fn save_tx(conn: &rusqlite::Connection, note: &Note) -> AppResult<()> {
    validate(note)?;
    let tags = serde_json::to_string(&clean_strings(&note.tags))
        .map_err(|e| AppError::other("serde_failed", serde_json::json!({ "err": e.to_string() })))?;
    let linked = serde_json::to_string(&clean_strings(&note.linked_host_ids))
        .map_err(|e| AppError::other("serde_failed", serde_json::json!({ "err": e.to_string() })))?;
    let group = clean_group(&note.group);
    conn.execute(
        "INSERT INTO notes \
         (id, title, content, group_name, tags, linked_host_ids, created_at, updated_at, order_index, is_pinned) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, \
          group_name=excluded.group_name, tags=excluded.tags, linked_host_ids=excluded.linked_host_ids, \
          created_at=excluded.created_at, updated_at=excluded.updated_at, \
          order_index=excluded.order_index, is_pinned=excluded.is_pinned",
        params![
            note.id,
            note.title,
            note.content,
            group,
            tags,
            linked,
            note.created_at,
            note.updated_at,
            note.order,
            if note.is_pinned { 1i64 } else { 0i64 },
        ],
    )?;
    Ok(())
}

pub fn save(db: &Db, note: &Note) -> AppResult<()> {
    let conn = db.lock()?;
    save_tx(&conn, note)
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    let conn = db.lock()?;
    let changed = conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(AppError::not_found(
            "note_not_found",
            serde_json::json!({ "id": id }),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, title: &str) -> Note {
        Note {
            id: id.into(),
            title: title.into(),
            content: format!("body of {title}"),
            group: Some("ops".into()),
            tags: vec!["ssh".into(), "ops".into()],
            linked_host_ids: vec!["h1".into()],
            created_at: 100,
            updated_at: 100,
            order: None,
            is_pinned: false,
        }
    }

    #[test]
    fn save_then_get_roundtrips_all_fields() {
        let db = Db::open_in_memory().unwrap();
        save(&db, &mk("n1", "first")).unwrap();
        let got = get(&db, "n1").unwrap();
        assert_eq!(got.title, "first");
        assert_eq!(got.content, "body of first");
        assert_eq!(got.group.as_deref(), Some("ops"));
        assert_eq!(got.tags, vec!["ssh", "ops"]);
        assert_eq!(got.linked_host_ids, vec!["h1"]);
        assert_eq!(got.created_at, 100);
        assert!(!got.is_pinned);
    }

    #[test]
    fn upsert_overwrites_and_cleans_tags() {
        let db = Db::open_in_memory().unwrap();
        save(&db, &mk("n1", "first")).unwrap();
        let mut updated = mk("n1", "renamed");
        updated.tags = vec![" ssh ".into(), "".into(), "ssh".into(), "db".into()];
        updated.group = Some("   ".into());
        updated.is_pinned = true;
        updated.updated_at = 200;
        save(&db, &updated).unwrap();
        let got = get(&db, "n1").unwrap();
        assert_eq!(got.title, "renamed");
        assert_eq!(got.tags, vec!["ssh", "db"]);
        assert_eq!(got.group, None);
        assert!(got.is_pinned);
        assert_eq!(got.updated_at, 200);
    }

    #[test]
    fn list_pins_first_then_newest() {
        let db = Db::open_in_memory().unwrap();
        let mut a = mk("a", "A");
        a.updated_at = 300;
        let mut b = mk("b", "B");
        b.updated_at = 100;
        b.is_pinned = true;
        let mut c = mk("c", "C");
        c.updated_at = 200;
        save(&db, &a).unwrap();
        save(&db, &b).unwrap();
        save(&db, &c).unwrap();
        let ids: Vec<String> = list(&db).unwrap().into_iter().map(|n| n.id).collect();
        assert_eq!(ids, vec!["b", "a", "c"]);
    }

    #[test]
    fn delete_removes_row_and_reports_missing() {
        let db = Db::open_in_memory().unwrap();
        save(&db, &mk("n1", "first")).unwrap();
        delete(&db, "n1").unwrap();
        assert_eq!(get(&db, "n1").unwrap_err().code(), "note_not_found");
        assert_eq!(delete(&db, "n1").unwrap_err().code(), "note_not_found");
    }

    #[test]
    fn save_rejects_empty_id() {
        let db = Db::open_in_memory().unwrap();
        let mut note = mk("", "x");
        note.id = "   ".into();
        assert_eq!(save(&db, &note).unwrap_err().code(), "note_id_required");
    }

    #[test]
    fn malformed_tags_column_reads_as_empty_list() {
        let db = Db::open_in_memory().unwrap();
        save(&db, &mk("n1", "first")).unwrap();
        {
            let conn = db.lock().unwrap();
            conn.execute("UPDATE notes SET tags = 'not-json' WHERE id = 'n1'", [])
                .unwrap();
        }
        assert!(get(&db, "n1").unwrap().tags.is_empty());
    }
}
