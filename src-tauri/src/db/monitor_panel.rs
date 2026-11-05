//! 监控面板持久化（#206）：名称 / 主机集合 / 布局列数 / 刷新间隔 / 排序。
//!
//! 「全部 SSH 主机」不是库里的行，而是前端固定的默认面板（id = `all`），
//! 自定义面板按 `sort_order ASC, name ASC` 排序返回。

use super::Db;
use crate::error::{AppError, AppResult};
use crate::models::MonitorPanel;

const COLS: &str = "id, name, host_ids, layout, columns, interval, sort_order";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<MonitorPanel> {
    let host_ids: String = row.get(2)?;
    Ok(MonitorPanel {
        id: row.get(0)?,
        name: row.get(1)?,
        host_ids: serde_json::from_str::<Vec<String>>(&host_ids).unwrap_or_default(),
        layout: row.get(3)?,
        columns: row.get::<_, i64>(4)?.max(0) as u32,
        interval: row.get::<_, i64>(5)?.max(1) as u32,
        sort_order: row.get::<_, i64>(6)?.max(0) as u32,
    })
}

fn normalize(mut panel: MonitorPanel) -> AppResult<MonitorPanel> {
    let name = panel.name.trim().to_owned();
    if name.is_empty() {
        return Err(AppError::config(
            "monitor_panel_name_required",
            serde_json::json!({}),
        ));
    }
    let mut host_ids: Vec<String> = Vec::new();
    for id in panel.host_ids.drain(..) {
        let trimmed = id.trim().to_owned();
        if !trimmed.is_empty() && !host_ids.iter().any(|item| item == &trimmed) {
            host_ids.push(trimmed);
        }
    }
    Ok(MonitorPanel {
        id: panel.id.trim().to_owned(),
        name,
        host_ids,
        layout: if panel.layout == "list" {
            "list".to_owned()
        } else {
            "charts".to_owned()
        },
        columns: panel.columns.min(8),
        interval: panel.interval.clamp(1, 60),
        sort_order: panel.sort_order,
    })
}

pub fn list(db: &Db) -> AppResult<Vec<MonitorPanel>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM monitor_panels ORDER BY sort_order ASC, name ASC"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn save(db: &Db, panel: &MonitorPanel) -> AppResult<MonitorPanel> {
    if panel.id.trim().is_empty() {
        return Err(AppError::config(
            "monitor_panel_id_required",
            serde_json::json!({}),
        ));
    }
    let panel = normalize(panel.clone())?;
    let host_ids = serde_json::to_string(&panel.host_ids).map_err(|e| {
        AppError::other("serde_failed", serde_json::json!({ "err": e.to_string() }))
    })?;
    let conn = db.lock()?;
    conn.execute(
        "INSERT INTO monitor_panels (id, name, host_ids, layout, columns, interval, sort_order) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, host_ids = excluded.host_ids, \
           layout = excluded.layout, columns = excluded.columns, \
           interval = excluded.interval, sort_order = excluded.sort_order",
        rusqlite::params![
            panel.id,
            panel.name,
            host_ids,
            panel.layout,
            panel.columns as i64,
            panel.interval as i64,
            panel.sort_order as i64,
        ],
    )?;
    Ok(panel)
}

pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    let conn = db.lock()?;
    conn.execute("DELETE FROM monitor_panels WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panel(id: &str, name: &str) -> MonitorPanel {
        MonitorPanel {
            id: id.to_owned(),
            name: name.to_owned(),
            host_ids: Vec::new(),
            layout: "charts".to_owned(),
            columns: 0,
            interval: 2,
            sort_order: 0,
        }
    }

    #[test]
    fn save_roundtrip_normalizes_fields() {
        let db = Db::open_in_memory().unwrap();
        let mut input = panel("p1", "  生产  ");
        input.host_ids = vec!["h1".into(), " h1 ".into(), "".into(), "h2".into()];
        input.layout = "weird".into();
        input.columns = 99;
        input.interval = 0;
        let saved = save(&db, &input).unwrap();
        assert_eq!(saved.name, "生产");
        assert_eq!(saved.host_ids, vec!["h1", "h2"]);
        assert_eq!(saved.layout, "charts");
        assert_eq!(saved.columns, 8);
        assert_eq!(saved.interval, 1);

        let listed = list(&db).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].host_ids, vec!["h1", "h2"]);
    }

    #[test]
    fn list_orders_by_sort_order_and_delete_works() {
        let db = Db::open_in_memory().unwrap();
        let mut a = panel("a", "A");
        a.sort_order = 2;
        let mut b = panel("b", "B");
        b.sort_order = 1;
        save(&db, &a).unwrap();
        save(&db, &b).unwrap();
        let listed = list(&db).unwrap();
        assert_eq!(
            listed.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        delete(&db, "b").unwrap();
        assert_eq!(list(&db).unwrap().len(), 1);
    }

    #[test]
    fn empty_name_and_id_rejected() {
        let db = Db::open_in_memory().unwrap();
        let mut blank = panel("x", "   ");
        blank.name = "   ".into();
        assert_eq!(
            save(&db, &blank).unwrap_err().code(),
            "monitor_panel_name_required"
        );
        let mut no_id = panel("", "X");
        no_id.id = "".into();
        assert_eq!(
            save(&db, &no_id).unwrap_err().code(),
            "monitor_panel_id_required"
        );
    }
}
