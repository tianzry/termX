// Vault「日志」页（会话日志阶段 A）。
// 对照 Netcatty：日志本体是 recordings 目录里的 .cast 文件，反过来索引到本页列表；
// 本页只做浏览 / 查看 / 删除，导出落盘属于阶段 B，因此详情头不放导出按钮。
// 左栏 300px（刷新 / 搜索 / 主机 / 格式 / 列表）+ 右侧详情，布局对齐 NotesView。
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../backend/client";
import type { SessionLog, SessionLogDetail } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { Icon } from "../ui/icons";
import {
  collectLogHosts,
  filterSessionLogs,
  formatLogDuration,
  formatLogSize,
  formatLogTime,
  parseAsciicast,
} from "./sessionLogsModel";
import "./sessionLogs.css";

function formatDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function SessionLogsView() {
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [query, setQuery] = useState("");
  const [host, setHost] = useState("");
  const [format, setFormat] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionLogDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [err, setErr] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionLog | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.listSessionLogs();
      setLogs(items);
      setErr("");
      // 索引可能被别的入口（终端工具栏 / headless）改过：当前详情不在了就清空。
      setActiveId((current) =>
        current && items.some((item) => item.id === current) ? current : null,
      );
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openLog = useCallback(async (log: SessionLog) => {
    setActiveId(log.id);
    setDetailLoading(true);
    setErr("");
    try {
      setDetail(await api.getSessionLog(log.id));
    } catch (e) {
      setDetail(null);
      setErr(userVisibleError(String(e)));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteSessionLog(deleteTarget.id);
      setDeleteTarget(null);
      setActiveId(null);
      setDetail(null);
      await load();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load]);

  const hosts = useMemo(() => collectLogHosts(logs), [logs]);
  const formats = useMemo(
    () => Array.from(new Set(logs.map((log) => log.format))).sort(),
    [logs],
  );
  const visible = useMemo(
    () => filterSessionLogs(logs, { query, host, format }),
    [logs, query, host, format],
  );
  const summary = useMemo(
    () => (detail ? parseAsciicast(detail.content) : null),
    [detail],
  );

  return (
    <div className="session-logs-page">
      <aside className="session-logs-tree">
        <div className="session-logs-tree-head">
          <span>会话日志</span>
          <button
            className="session-logs-refresh"
            title="刷新"
            disabled={loading}
            onClick={() => void load()}
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>

        <div className="session-logs-search">
          <Icon name="search" size={13} />
          <input
            value={query}
            placeholder="搜索标题 / 主机 / 状态…"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="session-logs-clear"
              title="清空搜索"
              onClick={() => setQuery("")}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="session-logs-filters">
          <select
            className="session-logs-select"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          >
            <option value="">全部主机</option>
            {hosts.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            className="session-logs-select"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="">全部格式</option>
            {formats.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>

        {err && <p className="session-logs-message error">{err}</p>}

        <div className="session-logs-list">
          {visible.length === 0 ? (
            <div className="session-logs-list-empty">
              <p>
                {loading
                  ? "加载中…"
                  : logs.length
                    ? "没有匹配的会话日志"
                    : "暂无会话日志"}
              </p>
              {!loading && !logs.length && (
                <p>在设置中开启自动保存后，新的会话会记录为 asciicast</p>
              )}
            </div>
          ) : (
            visible.map((log) => (
              <button
                key={log.id}
                className={`session-logs-item${
                  activeId === log.id ? " active" : ""
                }`}
                onClick={() => void openLog(log)}
              >
                <div className="session-logs-item-title">
                  <span className="session-logs-item-name">
                    {log.title || log.path}
                  </span>
                  <span className="session-logs-badge">{log.format}</span>
                </div>
                <div className="session-logs-item-meta">
                  <span>{log.host_name || "—"}</span>
                  <span>{formatLogTime(log.started_at)}</span>
                </div>
                <div className="session-logs-item-meta">
                  <span>{formatLogDuration(log.duration_ms)}</span>
                  <span>{formatLogSize(log.size_bytes)}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="session-logs-detail">
        {detailLoading ? (
          <div className="session-logs-empty">加载中…</div>
        ) : detail && summary ? (
          <>
            <header className="session-logs-detail-head">
              <div className="session-logs-detail-title">
                <h2>{detail.log.title || detail.log.path}</h2>
                <p>{detail.log.host_name || "—"}</p>
              </div>
              <button
                className="session-logs-action session-logs-danger"
                title="删除"
                onClick={() => setDeleteTarget(detail.log)}
              >
                <Icon name="trash" size={14} />
              </button>
            </header>

            <div className="session-logs-stats">
              <div className="session-logs-stat">
                <span>开始</span>
                <strong>{formatDateTime(detail.log.started_at)}</strong>
              </div>
              <div className="session-logs-stat">
                <span>结束</span>
                <strong>{formatDateTime(detail.log.ended_at)}</strong>
              </div>
              <div className="session-logs-stat">
                <span>时长</span>
                <strong>{formatLogDuration(detail.log.duration_ms)}</strong>
              </div>
              <div className="session-logs-stat">
                <span>事件数</span>
                <strong>{detail.log.event_count}</strong>
              </div>
              <div className="session-logs-stat">
                <span>大小</span>
                <strong>{formatLogSize(detail.log.size_bytes)}</strong>
              </div>
              <div className="session-logs-stat session-logs-path">
                <span>路径</span>
                <strong title={detail.log.path}>{detail.log.path}</strong>
              </div>
            </div>

            <div className="session-logs-content-wrap">
              <pre className="session-logs-content">{summary.text}</pre>
            </div>
          </>
        ) : (
          <div className="session-logs-empty">
            <Icon name="history" size={28} />
            <p>选择左侧日志查看会话内容</p>
            {err && <p className="session-logs-message error">{err}</p>}
          </div>
        )}
      </section>

      {deleteTarget && (
        <div
          className="modal-mask"
          onMouseDown={() => !deleting && setDeleteTarget(null)}
        >
          <div
            className="modal session-logs-delete-modal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="session-logs-delete-title">
              <Icon name="alert-triangle" size={18} />
              删除“{deleteTarget.title || deleteTarget.path}”？
            </h3>
            <p className="session-logs-delete-desc">
              日志文件会从 recordings 目录移除，此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="danger"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
