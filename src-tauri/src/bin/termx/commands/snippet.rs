//! `termx snippet` —— 片段（snippets.json）的脚本友好 CRUD。
//!
//! Netcatty 的 `netcatty-tool-cli` 通过运行中应用的 RPC 提供 `snippet` 能力；
//! 片段本身是本地 JSON 文件，CLI 直接读写同一份文件即可，无需应用在线。

use termx_lib::error::{AppError, AppResult};
use termx_lib::models::Snippet;

use crate::ctx::CliCtx;

/// 名称 / 命令 / 分组 / 标签上的大小写不敏感过滤（纯函数，便于单测）。
pub fn filter_snippets<'a>(list: &'a [Snippet], query: Option<&str>) -> Vec<&'a Snippet> {
    match query {
        Some(q) => {
            let q = q.to_lowercase();
            list.iter()
                .filter(|s| {
                    s.name.to_lowercase().contains(&q)
                        || s.command.to_lowercase().contains(&q)
                        || s.package.to_lowercase().contains(&q)
                        || s.tags.iter().any(|t| t.to_lowercase().contains(&q))
                })
                .collect()
        }
        None => list.iter().collect(),
    }
}

pub fn cmd_list(conn: &CliCtx, query: Option<&str>) -> AppResult<()> {
    let list = termx_lib::db::snippet::load(&conn.data_dir)?;
    let filtered = filter_snippets(&list, query);
    if filtered.is_empty() {
        println!("No snippets.");
        return Ok(());
    }
    for s in filtered {
        let pkg = if s.package.is_empty() {
            String::new()
        } else {
            format!(" [{}]", s.package)
        };
        println!("{}{}  →  {}", s.name, pkg, s.command);
    }
    Ok(())
}

pub fn cmd_show(conn: &CliCtx, name: &str) -> AppResult<()> {
    let list = termx_lib::db::snippet::load(&conn.data_dir)?;
    let s = find_snippet(&list, name)?;
    println!("name:        {}", s.name);
    println!("command:     {}", s.command);
    println!("description: {}", s.description);
    println!("package:     {}", s.package);
    println!("tags:        {}", s.tags.join(", "));
    println!("shortkey:    {}", s.shortkey);
    println!("no_auto_run: {}", s.no_auto_run);
    println!("kind:        {}", s.kind);
    Ok(())
}

pub fn cmd_add(
    conn: &CliCtx,
    name: &str,
    command: &str,
    description: &str,
    package: &str,
) -> AppResult<()> {
    if name.trim().is_empty() || command.trim().is_empty() {
        return Err(AppError::other(
            "snippet_fields_required",
            serde_json::json!({ "hint": "name and command must be non-empty" }),
        ));
    }
    let mut list = termx_lib::db::snippet::load(&conn.data_dir)?;
    if list.iter().any(|s| s.name.eq_ignore_ascii_case(name)) {
        return Err(AppError::other(
            "snippet_exists",
            serde_json::json!({ "name": name }),
        ));
    }
    list.push(Snippet {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_owned(),
        command: command.to_owned(),
        description: description.to_owned(),
        package: package.to_owned(),
        ..Default::default()
    });
    termx_lib::db::snippet::save(&conn.data_dir, &list)?;
    println!("Added snippet '{}'.", name);
    Ok(())
}

pub fn cmd_rm(conn: &CliCtx, name: &str) -> AppResult<()> {
    let mut list = termx_lib::db::snippet::load(&conn.data_dir)?;
    let idx = list
        .iter()
        .position(|s| s.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| not_found(name))?;
    list.remove(idx);
    termx_lib::db::snippet::save(&conn.data_dir, &list)?;
    println!("Removed snippet '{}'.", name);
    Ok(())
}

fn find_snippet<'a>(list: &'a [Snippet], name: &str) -> AppResult<&'a Snippet> {
    list.iter()
        .find(|s| s.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| not_found(name))
}

fn not_found(name: &str) -> AppError {
    AppError::not_found("snippet_not_found", serde_json::json!({ "name": name }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snippet(name: &str, command: &str, package: &str) -> Snippet {
        Snippet {
            name: name.to_owned(),
            command: command.to_owned(),
            package: package.to_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn filter_matches_name_command_and_package() {
        let list = vec![
            snippet("Restart Nginx", "systemctl restart nginx", "ops/web"),
            snippet("Disk Usage", "df -h", "ops"),
            snippet("Tail Log", "tail -f /var/log/syslog", ""),
        ];
        assert_eq!(filter_snippets(&list, None).len(), 3);
        assert_eq!(filter_snippets(&list, Some("NGINX")).len(), 1);
        assert_eq!(filter_snippets(&list, Some("df -h")).len(), 1);
        assert_eq!(filter_snippets(&list, Some("ops/web")).len(), 1);
        assert_eq!(filter_snippets(&list, Some("ops")).len(), 2);
        assert_eq!(filter_snippets(&list, Some("nothing")).len(), 0);
    }
}
