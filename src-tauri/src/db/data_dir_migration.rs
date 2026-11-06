//! `~/.rssh` → `~/.termX` 数据目录迁移。
//!
//! 设计目标（见 docs/rename-rssh-termx.md）：
//! - 幂等：新目录一旦存在就不再迁移；重复启动只做存在性检查。
//! - 可重入 / 崩溃可恢复：同卷先 `rename` 到 `.termX.tmp-<ts>-<pid>`，改 DB 文件名，
//!   再原子 `rename` 到 `.termX`；跨卷先复制到 staging，校验后 rename、删旧目录。
//!   任何时刻都有完整的一份数据（staging 就是完整副本），不会出现空库/两半。
//! - 失败回滚：校验失败时把 staging 还原成旧目录（同卷）或删除副本（跨卷），
//!   继续使用旧目录并告警。
//! - 一次性通知：迁移报告写到 `.rename-migration.json`，设置页读取后删除。
//!
//! SQLite 的 `rssh.db` / `-wal` / `-shm`（以及 `.bak-*`）随目录一起搬运，迁移后在
//! 目录内统一改名为 `termx.db*`；校验方式是只读打开目标 DB，比较 `sqlite_master`
//! 里的表数量与总行数。

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

const LEGACY_DIR: &str = ".rssh";
const DATA_DIR: &str = ".termX";
const STAGING_PREFIX: &str = ".termX.tmp-";
const LOCK_FILE: &str = ".termX.migration.lock";
const NOTICE_FILE: &str = ".rename-migration.json";
const LOCK_STALE: Duration = Duration::from_secs(120);
const LOCK_WAIT: Duration = Duration::from_secs(5);

/// 迁移报告。字段用 snake_case 直接给前端/取证脚本消费。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DataDirMigrationReport {
    /// `migrated` / `recovered_staging` / `fallback_*` / `already_migrated`
    pub status: String,
    pub old_dir: String,
    pub new_dir: String,
    /// `rename`（同卷）或 `copy`（跨卷）
    pub mode: Option<String>,
    pub tables_before: Option<i64>,
    pub tables_after: Option<i64>,
    pub rows_before: Option<i64>,
    pub rows_after: Option<i64>,
    pub recordings_before: Option<usize>,
    pub recordings_after: Option<usize>,
    pub old_dir_removed: bool,
    pub error: Option<String>,
    pub occurred_at: String,
}

struct Resolved {
    path: PathBuf,
    report: Option<DataDirMigrationReport>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Rename,
    Copy,
}

/// 解析桌面数据目录：首次启动有旧目录时执行迁移；任何失败都回退旧目录。
pub fn resolve(home: &Path) -> PathBuf {
    let Resolved { path, report } = resolve_inner(home, false);
    if let Some(report) = report {
        log::info!(
            "data dir resolved to {} (migration status: {})",
            path.display(),
            report.status
        );
    }
    path
}

/// 读取并消费一次性迁移通知（设置页用）。读取后删除，避免每次启动重复提示。
pub fn consume_notice(data_dir: &Path) -> Option<DataDirMigrationReport> {
    let path = data_dir.join(NOTICE_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return None,
    };
    let report: DataDirMigrationReport = match serde_json::from_str(&text) {
        Ok(report) => report,
        Err(e) => {
            log::warn!("data dir migration notice unreadable ({}): {e}", path.display());
            return None;
        }
    };
    if let Err(e) = fs::remove_file(&path) {
        log::warn!("data dir migration notice not removed: {e}");
    }
    log::info!(
        "data dir migration notice: status={} {} -> {} tables={:?}->{:?}",
        report.status,
        report.old_dir,
        report.new_dir,
        report.tables_before,
        report.tables_after
    );
    Some(report)
}

fn resolve_inner(home: &Path, force_copy: bool) -> Resolved {
    let old = home.join(LEGACY_DIR);
    let new = home.join(DATA_DIR);

    if new.exists() {
        return settle_existing(&old, &new);
    }

    let Some(_lock) = MigrationLock::acquire(home) else {
        // 另一个进程正在迁移（或锁不可写）：本轮不动，避免并发写两份。
        let path = if old.exists() { old.clone() } else { new.clone() };
        let report = fallback_report(
            &old,
            &new,
            &path,
            "fallback_lock_busy",
            "another process holds the data-dir migration lock",
        );
        write_notice(&path, &report);
        log::warn!("data dir migration skipped: lock busy; using {}", path.display());
        return Resolved {
            path,
            report: Some(report),
        };
    };

    // 拿到锁后复核：可能有进程在我们等待期间完成了迁移。
    if new.exists() {
        return settle_existing(&old, &new);
    }

    if let Some(staging) = find_staging(home) {
        return recover_staging(&old, &new, &staging);
    }

    if !old.exists() {
        return Resolved { path: new, report: None };
    }

    migrate_legacy(home, &old, &new, force_copy)
}

/// 新目录已存在：不覆盖、不再迁移。只有新目录没有 DB 而旧目录有 DB 时回退旧目录。
fn settle_existing(old: &Path, new: &Path) -> Resolved {
    let new_db = new.join("termx.db");
    let old_db = old.join("rssh.db");
    if !new_db.exists() && old_db.exists() {
        let report = fallback_report(
            old,
            new,
            old,
            "fallback_new_dir_without_db",
            "existing ~/.termX has no database; keeping ~/.rssh untouched",
        );
        write_notice(old, &report);
        log::warn!(
            "~/.termX exists but has no termx.db; using legacy {}",
            old.display()
        );
        return Resolved {
            path: old.to_owned(),
            report: Some(report),
        };
    }
    log::debug!("data dir settled: {}", new.display());
    Resolved {
        path: new.to_owned(),
        report: None,
    }
}

/// 崩溃在「已 rename 到 staging、尚未 rename 到 .termX」之间时，从这里收尾。
fn recover_staging(old: &Path, new: &Path, staging: &Path) -> Resolved {
    let mut report = DataDirMigrationReport {
        status: "recovered_staging".into(),
        old_dir: old.display().to_string(),
        new_dir: new.display().to_string(),
        mode: Some("rename".into()),
        occurred_at: now(),
        ..Default::default()
    };
    if let Err(e) = rename_db_files(staging) {
        report.status = "fallback_staging_unusable".into();
        report.error = Some(e.to_string());
        // 没有旧的完整目录时，staging 本身仍是最完整的数据副本，继续用它。
        let path = if old.exists() { old.to_owned() } else { staging.to_owned() };
        write_notice(&path, &report);
        log::error!("staging recovery failed ({}): {e}", staging.display());
        return Resolved {
            path,
            report: Some(report),
        };
    }
    let stats = db_stats(&staging.join("termx.db"));
    report.tables_after = stats.as_ref().map(|s| s.tables);
    report.rows_after = stats.as_ref().map(|s| s.rows);
    report.recordings_after = Some(count_recordings(staging));
    write_notice(staging, &report);
    match fs::rename(staging, new) {
        Ok(()) => {
            log::info!(
                "recovered interrupted data-dir migration: {} -> {}",
                staging.display(),
                new.display()
            );
            Resolved {
                path: new.to_owned(),
                report: Some(report),
            }
        }
        Err(e) => {
            report.status = "fallback_staging_rename_failed".into();
            report.error = Some(e.to_string());
            let path = if old.exists() { old.to_owned() } else { staging.to_owned() };
            write_notice(&path, &report);
            log::error!(
                "staging rename failed, using {}: {e}",
                path.display()
            );
            Resolved {
                path,
                report: Some(report),
            }
        }
    }
}

fn migrate_legacy(home: &Path, old: &Path, new: &Path, force_copy: bool) -> Resolved {
    let old_db = old.join("rssh.db");
    let before = if old_db.exists() {
        match db_stats(&old_db) {
            Some(stats) => stats,
            None => {
                let report = fallback_report(
                    old,
                    new,
                    old,
                    "fallback_source_db_unreadable",
                    "legacy rssh.db cannot be opened for validation",
                );
                write_notice(old, &report);
                log::error!("legacy DB unreadable; data-dir migration aborted");
                return Resolved {
                    path: old.to_owned(),
                    report: Some(report),
                };
            }
        }
    } else {
        DbStats::default()
    };
    let recordings_before = count_recordings(old);

    let staging = staging_path(home);
    let mode = if force_copy {
        Mode::Copy
    } else {
        match fs::rename(old, &staging) {
            Ok(()) => Mode::Rename,
            Err(e) if is_cross_device(&e) => {
                log::info!("legacy data dir is on another volume; switching to copy mode");
                Mode::Copy
            }
            Err(e) => {
                let report = fallback_report(
                    old,
                    new,
                    old,
                    "fallback_rename_failed",
                    &format!("cannot move legacy dir to staging: {e}"),
                );
                write_notice(old, &report);
                log::error!("data-dir migration failed before staging: {e}");
                return Resolved {
                    path: old.to_owned(),
                    report: Some(report),
                };
            }
        }
    };

    if mode == Mode::Copy {
        if let Err(e) = copy_dir(old, &staging) {
            let _ = fs::remove_dir_all(&staging);
            let report = fallback_report(
                old,
                new,
                old,
                "fallback_copy_failed",
                &format!("copy to staging failed: {e}"),
            );
            write_notice(old, &report);
            log::error!("data-dir copy failed: {e}");
            return Resolved {
                path: old.to_owned(),
                report: Some(report),
            };
        }
    }

    if let Err(e) = rename_db_files(&staging) {
        rollback(old, &staging, mode);
        let report = fallback_report(
            old,
            new,
            old,
            "fallback_db_rename_failed",
            &format!("staging DB rename failed: {e}"),
        );
        write_notice(old, &report);
        log::error!("data-dir DB rename failed: {e}");
        return Resolved {
            path: old.to_owned(),
            report: Some(report),
        };
    }

    let after = db_stats(&staging.join("termx.db"));
    let after_stats = after.clone().unwrap_or_default();
    if old_db.exists() && after.is_none() {
        rollback(old, &staging, mode);
        let report = fallback_report(
            old,
            new,
            old,
            "fallback_target_db_unreadable",
            "staged termx.db cannot be opened",
        );
        write_notice(old, &report);
        log::error!("staged DB unreadable; rolled back to {}", old.display());
        return Resolved {
            path: old.to_owned(),
            report: Some(report),
        };
    }
    if old_db.exists()
        && (after_stats.tables != before.tables || after_stats.rows != before.rows)
    {
        rollback(old, &staging, mode);
        let report = fallback_report(
            old,
            new,
            old,
            "fallback_db_mismatch",
            &format!(
                "table/row count mismatch: before tables={} rows={}, after tables={} rows={}",
                before.tables, before.rows, after_stats.tables, after_stats.rows
            ),
        );
        write_notice(old, &report);
        log::error!("staged DB validation mismatch; rolled back");
        return Resolved {
            path: old.to_owned(),
            report: Some(report),
        };
    }

    let report = DataDirMigrationReport {
        status: "migrated".into(),
        old_dir: old.display().to_string(),
        new_dir: new.display().to_string(),
        mode: Some(match mode {
            Mode::Rename => "rename".into(),
            Mode::Copy => "copy".into(),
        }),
        tables_before: Some(before.tables),
        tables_after: Some(after_stats.tables),
        rows_before: Some(before.rows),
        rows_after: Some(after_stats.rows),
        recordings_before: Some(recordings_before),
        recordings_after: Some(count_recordings(&staging)),
        old_dir_removed: mode == Mode::Rename,
        error: None,
        occurred_at: now(),
    };
    // 通知文件先写进 staging，再随最后一次 rename 原子落到 .termX。
    write_notice(&staging, &report);

    if let Err(e) = fs::rename(&staging, new) {
        rollback(old, &staging, mode);
        let report = fallback_report(
            old,
            new,
            old,
            "fallback_final_rename_failed",
            &format!("staging -> ~/.termX rename failed: {e}"),
        );
        write_notice(old, &report);
        log::error!("final data-dir rename failed: {e}");
        return Resolved {
            path: old.to_owned(),
            report: Some(report),
        };
    }

    let mut report = report;
    if mode == Mode::Copy {
        match fs::remove_dir_all(old) {
            Ok(()) => report.old_dir_removed = true,
            Err(e) => {
                // 新目录已完整可用；旧目录删不掉只告警，不回滚（回滚反而要删好数据）。
                log::warn!("legacy dir kept after copy migration: {e}");
            }
        }
    }

    log::info!(
        "data dir migrated: {} -> {} mode={} tables={} rows={} recordings={}",
        old.display(),
        new.display(),
        report.mode.as_deref().unwrap_or("?"),
        after_stats.tables,
        after_stats.rows,
        report.recordings_after.unwrap_or(0)
    );
    Resolved {
        path: new.to_owned(),
        report: Some(report),
    }
}

/// 失败回滚：同卷把 staging 的 DB 名改回并 rename 回旧目录；跨卷删除副本。
fn rollback(old: &Path, staging: &Path, mode: Mode) {
    if !staging.exists() {
        return;
    }
    if mode == Mode::Rename {
        let _ = undo_db_renames(staging);
        if let Err(e) = fs::rename(staging, old) {
            log::error!(
                "rollback rename failed; data remains at {}: {e}",
                staging.display()
            );
        }
    } else {
        let _ = fs::remove_dir_all(staging);
    }
}

fn fallback_report(old: &Path, new: &Path, path: &Path, status: &str, error: &str) -> DataDirMigrationReport {
    DataDirMigrationReport {
        status: status.into(),
        old_dir: old.display().to_string(),
        new_dir: new.display().to_string(),
        mode: None,
        tables_before: db_stats(&old.join("rssh.db")).map(|s| s.tables),
        rows_before: db_stats(&old.join("rssh.db")).map(|s| s.rows),
        tables_after: None,
        rows_after: None,
        recordings_before: Some(count_recordings(path)),
        recordings_after: None,
        old_dir_removed: false,
        error: Some(error.into()),
        occurred_at: now(),
    }
}

fn staging_path(home: &Path) -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    home.join(format!("{STAGING_PREFIX}{ts}-{}", std::process::id()))
}

fn find_staging(home: &Path) -> Option<PathBuf> {
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();
    let entries = fs::read_dir(home).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(STAGING_PREFIX) || !entry.path().is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        found.push((mtime, entry.path()));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().next().map(|(_, path)| path)
}

fn write_notice(dir: &Path, report: &DataDirMigrationReport) {
    match serde_json::to_vec_pretty(report) {
        Ok(json) => {
            if let Err(e) = fs::write(dir.join(NOTICE_FILE), json) {
                log::warn!("failed to write data-dir migration notice: {e}");
            }
        }
        Err(e) => log::warn!("failed to serialize data-dir migration notice: {e}"),
    }
}

/// 把目录内的 `rssh.db*` 改成 `termx.db*`（含 `-wal` / `-shm` / `.bak-*`）。
fn rename_db_files(dir: &Path) -> io::Result<()> {
    let renames: Vec<(PathBuf, PathBuf)> = [
        ("rssh.db", "termx.db"),
        ("rssh.db-wal", "termx.db-wal"),
        ("rssh.db-shm", "termx.db-shm"),
    ]
    .into_iter()
    .filter(|(from, _)| dir.join(from).exists())
    .map(|(from, to)| (dir.join(from), dir.join(to)))
    .collect();

    for (from, to) in &renames {
        if to.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("both {} and {} exist in staging", from.display(), to.display()),
            ));
        }
    }
    for (from, to) in &renames {
        fs::rename(from, to)?;
    }

    // 历史备份：rssh.db.bak-* -> termx.db.bak-*（不是运行时读取文件，但保持目录干净）。
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(rest) = name.strip_prefix("rssh.db.") {
            let target = dir.join(format!("termx.db.{rest}"));
            if target.exists() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("backup target exists: {}", target.display()),
                ));
            }
            fs::rename(entry.path(), target)?;
        }
    }
    Ok(())
}

fn undo_db_renames(dir: &Path) -> io::Result<()> {
    for (from, to) in [
        ("termx.db", "rssh.db"),
        ("termx.db-wal", "rssh.db-wal"),
        ("termx.db-shm", "rssh.db-shm"),
    ] {
        if dir.join(from).exists() {
            fs::rename(dir.join(from), dir.join(to))?;
        }
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(rest) = name.strip_prefix("termx.db.") {
            let target = dir.join(format!("rssh.db.{rest}"));
            if !target.exists() {
                fs::rename(entry.path(), target)?;
            }
        }
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &to)?;
        } else {
            log::warn!("skipping non-regular file during data-dir copy: {}", entry.path().display());
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Default)]
struct DbStats {
    tables: i64,
    rows: i64,
}

fn db_stats(path: &Path) -> Option<DbStats> {
    if !path.exists() {
        return Some(DbStats::default());
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .ok()?
        .query_map([], |row| row.get(0))
        .ok()?
        .collect::<Result<_, _>>()
        .ok()?;
    let mut stats = DbStats {
        tables: tables.len() as i64,
        rows: 0,
    };
    for table in tables {
        let escaped = table.replace('"', "\"\"");
        let count: i64 = conn
            .query_row(&format!("SELECT count(*) FROM \"{escaped}\""), [], |row| row.get(0))
            .ok()?;
        stats.rows += count;
    }
    Some(stats)
}

fn count_recordings(dir: &Path) -> usize {
    let recordings = dir.join("recordings");
    fn walk(dir: &Path, count: &mut usize) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, count);
            } else if path.extension().map(|e| e.eq_ignore_ascii_case("cast")).unwrap_or(false) {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    walk(&recordings, &mut count);
    count
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

fn is_cross_device(e: &io::Error) -> bool {
    #[cfg(windows)]
    {
        e.raw_os_error() == Some(17) // ERROR_NOT_SAME_DEVICE
    }
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(18) // EXDEV
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = e;
        false
    }
}

struct MigrationLock {
    path: PathBuf,
}

impl MigrationLock {
    fn acquire(home: &Path) -> Option<Self> {
        let path = home.join(LOCK_FILE);
        let deadline = Instant::now() + LOCK_WAIT;
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Some(Self { path }),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    if is_stale(&path) {
                        log::warn!("removing stale data-dir migration lock");
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    log::warn!("cannot create data-dir migration lock: {e}");
                    return None;
                }
            }
        }
    }
}

impl Drop for MigrationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age > LOCK_STALE)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_legacy_db(home: &Path, rows: usize, table: &str) -> PathBuf {
        let old = home.join(LEGACY_DIR);
        fs::create_dir_all(&old).unwrap();
        let db = old.join("rssh.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(&format!("CREATE TABLE {table} (value TEXT);"))
            .unwrap();
        for i in 0..rows {
            conn.execute(&format!("INSERT INTO {table} VALUES (?1)"), [format!("v{i}")])
                .unwrap();
        }
        drop(conn);
        fs::create_dir_all(old.join("recordings")).unwrap();
        fs::write(old.join("recordings").join("a.cast"), b"cast").unwrap();
        db
    }

    fn make_new_db(home: &Path, rows: usize) -> PathBuf {
        let new = home.join(DATA_DIR);
        fs::create_dir_all(&new).unwrap();
        let db = new.join("termx.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE marker (value TEXT);").unwrap();
        for i in 0..rows {
            conn.execute("INSERT INTO marker VALUES (?1)", [format!("n{i}")])
                .unwrap();
        }
        db
    }

    #[test]
    fn migrates_legacy_dir_and_renames_db_files() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        let old_db = make_legacy_db(home, 3, "profiles");
        assert!(old_db.exists());

        let resolved = resolve_inner(home, false);
        let new = home.join(DATA_DIR);
        assert_eq!(resolved.path, new);
        assert!(new.join("termx.db").exists());
        assert!(!home.join(LEGACY_DIR).exists());
        assert!(new.join("recordings").join("a.cast").exists());
        let report = resolved.report.unwrap();
        assert_eq!(report.status, "migrated");
        assert_eq!(report.tables_before, Some(1));
        assert_eq!(report.tables_after, Some(1));
        assert_eq!(report.rows_before, Some(3));
        assert_eq!(report.rows_after, Some(3));
        assert_eq!(report.recordings_after, Some(1));
        assert!(new.join(NOTICE_FILE).exists());

        // 幂等：第二次解析不再迁移，也不产生新报告。
        let again = resolve_inner(home, false);
        assert_eq!(again.path, new);
        assert!(again.report.is_none());
    }

    #[test]
    fn does_not_overwrite_existing_new_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        make_legacy_db(home, 2, "profiles");
        let new_db = make_new_db(home, 1);

        let resolved = resolve_inner(home, false);
        assert_eq!(resolved.path, home.join(DATA_DIR));
        assert!(resolved.report.is_none());
        assert!(new_db.exists());
        assert!(home.join(LEGACY_DIR).join("rssh.db").exists(), "旧目录必须原样保留");
    }

    #[test]
    fn empty_new_dir_falls_back_to_legacy_without_overwriting() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        make_legacy_db(home, 1, "profiles");
        fs::create_dir_all(home.join(DATA_DIR)).unwrap();

        let resolved = resolve_inner(home, false);
        assert_eq!(resolved.path, home.join(LEGACY_DIR));
        assert!(!home.join(DATA_DIR).join("termx.db").exists());
        assert!(home.join(LEGACY_DIR).join("rssh.db").exists());
        assert_eq!(resolved.report.unwrap().status, "fallback_new_dir_without_db");
    }

    #[test]
    fn unreadable_source_db_rolls_back_to_legacy() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        let old = home.join(LEGACY_DIR);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("rssh.db"), b"not a sqlite database").unwrap();
        fs::create_dir_all(old.join("recordings")).unwrap();
        fs::write(old.join("recordings").join("a.cast"), b"cast").unwrap();

        let resolved = resolve_inner(home, false);
        assert_eq!(resolved.path, home.join(LEGACY_DIR));
        assert!(old.join("rssh.db").exists());
        assert!(!home.join(DATA_DIR).exists());
        assert!(resolved.report.unwrap().error.is_some());
        // 不留下 staging。
        assert!(find_staging(home).is_none());
    }

    #[test]
    fn recovers_interrupted_staging() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        let staging = home.join(format!("{STAGING_PREFIX}1700000000-42"));
        fs::create_dir_all(&staging).unwrap();
        let conn = Connection::open(staging.join("termx.db")).unwrap();
        conn.execute_batch("CREATE TABLE profiles (value TEXT);")
            .unwrap();
        drop(conn);

        let resolved = resolve_inner(home, false);
        assert_eq!(resolved.path, home.join(DATA_DIR));
        assert!(home.join(DATA_DIR).join("termx.db").exists());
        assert!(!staging.exists());
        assert_eq!(resolved.report.unwrap().status, "recovered_staging");
    }

    #[test]
    fn copy_mode_moves_data_and_removes_legacy_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        make_legacy_db(home, 2, "profiles");

        let resolved = resolve_inner(home, true);
        let new = home.join(DATA_DIR);
        assert_eq!(resolved.path, new);
        assert!(new.join("termx.db").exists());
        assert!(new.join("recordings").join("a.cast").exists());
        assert!(!home.join(LEGACY_DIR).exists());
        let report = resolved.report.unwrap();
        assert_eq!(report.mode.as_deref(), Some("copy"));
        assert!(report.old_dir_removed);
    }

    #[test]
    fn consume_notice_returns_report_once() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        make_legacy_db(home, 3, "profiles");
        let _ = resolve_inner(home, false);

        let new = home.join(DATA_DIR);
        let first = consume_notice(&new).expect("notice");
        assert_eq!(first.status, "migrated");
        assert!(consume_notice(&new).is_none());
    }
}
