//! `sftp_transfer_queue` 表 CRUD（schema v35）。
//!
//! 只被 `crate::sftp::transfer_center` 读写：传输队列持久化，重启后恢复未完成项。
//! 枚举 / 布尔以文本 / 整数存储，映射逻辑在 transfer_center（表示稳定，勿改字面量）。

use rusqlite::params;

use crate::db::Db;
use crate::error::AppResult;

/// 与 `sftp::transfer_center::TransferItem` 一一对应。
#[derive(Clone)]
pub struct Row {
    pub id: String,
    pub sftp_id: String,
    pub batch_id: String,
    /// "upload" | "download"
    pub direction: String,
    pub local_path: String,
    pub remote_path: String,
    pub size: i64,
    /// queued / running / paused / conflict / completed / failed / cancelled / skipped
    pub status: String,
    /// 0=low 1=normal 2=high
    pub priority: i64,
    pub seq: i64,
    pub overwrite: i64,
    pub error: Option<String>,
    pub created_at: i64,
    /// 已连续写入的字节偏移（断点续传起点）。
    pub checkpoint: i64,
    /// 首次开始时的源文件修改时间（秒），用于恢复前校验源是否变化。
    pub source_mtime: Option<i64>,
}

const COLS: &str = "id, sftp_id, batch_id, direction, local_path, remote_path, size, status, priority, seq, overwrite, error, created_at, checkpoint, source_mtime";

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        sftp_id: r.get(1)?,
        batch_id: r.get(2)?,
        direction: r.get(3)?,
        local_path: r.get(4)?,
        remote_path: r.get(5)?,
        size: r.get(6)?,
        status: r.get(7)?,
        priority: r.get(8)?,
        seq: r.get(9)?,
        overwrite: r.get(10)?,
        error: r.get(11)?,
        created_at: r.get(12)?,
        checkpoint: r.get(13)?,
        source_mtime: r.get(14)?,
    })
}

pub fn insert(db: &Db, r: &Row) -> AppResult<()> {
    let conn = db.lock()?;
    conn.execute(
        &format!("INSERT INTO sftp_transfer_queue ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"),
        params![
            r.id,
            r.sftp_id,
            r.batch_id,
            r.direction,
            r.local_path,
            r.remote_path,
            r.size,
            r.status,
            r.priority,
            r.seq,
            r.overwrite,
            r.error,
            r.created_at,
            r.checkpoint,
            r.source_mtime,
        ],
    )?;
    Ok(())
}

/// 全字段按 id 覆盖更新（状态 / 路径 / 优先级 / 错误都会变）。
pub fn update(db: &Db, r: &Row) -> AppResult<()> {
    let conn = db.lock()?;
    conn.execute(
        "UPDATE sftp_transfer_queue SET sftp_id = ?2, batch_id = ?3, direction = ?4, local_path = ?5, remote_path = ?6, size = ?7, status = ?8, priority = ?9, seq = ?10, overwrite = ?11, error = ?12, created_at = ?13, checkpoint = ?14, source_mtime = ?15 WHERE id = ?1",
        params![
            r.id,
            r.sftp_id,
            r.batch_id,
            r.direction,
            r.local_path,
            r.remote_path,
            r.size,
            r.status,
            r.priority,
            r.seq,
            r.overwrite,
            r.error,
            r.created_at,
            r.checkpoint,
            r.source_mtime,
        ],
    )?;
    Ok(())
}

/// 删除单行（终态行「移除」按钮）。
pub fn delete_by_id(db: &Db, id: &str) -> AppResult<usize> {
    let conn = db.lock()?;
    let n = conn.execute("DELETE FROM sftp_transfer_queue WHERE id = ?1", params![id])?;
    Ok(n)
}

/// 删除处于给定状态集合中的行；返回删除数量。
pub fn delete_by_statuses(db: &Db, statuses: &[&str]) -> AppResult<usize> {
    let conn = db.lock()?;
    let placeholders = vec!["?"; statuses.len()].join(",");
    let mut stmt = conn.prepare(&format!(
        "DELETE FROM sftp_transfer_queue WHERE status IN ({placeholders})"
    ))?;
    let n = stmt.execute(rusqlite::params_from_iter(statuses.iter().copied()))?;
    Ok(n)
}

/// 载入全部未终态行（重启恢复用），按 seq 排序。
pub fn load_unfinished(db: &Db) -> AppResult<Vec<Row>> {
    let conn = db.lock()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM sftp_transfer_queue \
         WHERE status NOT IN ('completed', 'failed', 'cancelled', 'skipped') \
         ORDER BY seq"
    ))?;
    let rows = stmt.query_map([], from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
