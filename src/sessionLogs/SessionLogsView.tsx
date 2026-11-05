// Vault「日志」页（会话日志阶段 A + B）。
// 对照 Netcatty：日志本体是 recordings 目录里的 .cast 文件，反过来索引到本页列表；
// 本页做浏览 / 彩色查看 / 导出落盘（Asciicast · 纯文本 · HTML）/ 删除。
// 左栏 300px（刷新 / 搜索 / 主机 / 列表）+ 右侧详情，布局对齐 NotesView。
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import * as api from "../backend/client";
import type { SessionLog, SessionLogDetail } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { getSettings } from "../settings/settingsStore";
import { Icon } from "../ui/icons";
import {
  collectLogHosts,
  filterSessionLogs,
  formatLogDuration,
  formatLogSize,
  formatLogTime,
  parseAsciicast,
  sessionLogExportName,
  sessionLogItemTitle,
} from "./sessionLogsModel";
import { parseAnsi, type AnsiSpan } from "./ansi";
import "./sessionLogs.css";

type ExportFormat = "cast" | "txt" | "html";

/** 设置里的默认导出格式：raw / txt → txt，html → html。 */
function defaultExportFormat(): "txt" | "html" {
  return getSettings().sessionLogs.format === "html" ? "html" : "txt";
}

/** AnsiSpan → 内联样式；inverse 交换前景 / 背景（缺省时用主题色兜底）。 */
function ansiStyle(span: AnsiSpan): CSSProperties {
  const color = span.inverse
    ? span.bg ?? "hsl(var(--nc-bg))"
    : span.fg;
  const backgroundColor = span.inverse
    ? span.fg ?? "hsl(var(--nc-fg))"
    : span.bg;
  return {
    color,
    backgroundColor,
    fontWeight: span.bold ? 600 : undefined,
    fontStyle: span.italic ? "italic" : undefined,
    textDecoration: span.underline ? "underline" : undefined,
    opacity: span.dim ? 0.6 : undefined,
  };
}

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionLogDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [err, setErr] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionLog | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 彩色（默认）/ 原文视图切换。 */
  const [rawView, setRawView] = useState(false);
  /** 日志字号（对齐 Netcatty LogView 的字号定制，范围 9–22px）。 */
  const [fontSize, setFontSize] = useState(13);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 导出成功提示（错误走左侧 err 条）。 */
  const [notice, setNotice] = useState("");

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
    setNotice("");
    setExportMenuOpen(false);
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

  /**
   * 导出落盘：先选目标文件（取消即止），再让后端生成内容，
   * 最后写本地文件。格式菜单三项齐全；主按钮用设置里的默认格式。
   */
  const exportLog = useCallback(
    async (log: SessionLog, format: ExportFormat) => {
      setExportMenuOpen(false);
      setExporting(true);
      setNotice("");
      try {
        const name = sessionLogExportName(log, format);
        const path = await api.pickSessionLogExportFile(name, format);
        if (!path) return;
        const content = await api.exportSessionLog(log.id, format);
        await api.localWriteFile(path, new TextEncoder().encode(content));
        setErr("");
        setNotice(`已导出到 ${path}`);
      } catch (e) {
        setErr(userVisibleError(String(e)));
      } finally {
        setExporting(false);
      }
    },
    [],
  );

  const hosts = useMemo(() => collectLogHosts(logs), [logs]);
  const visible = useMemo(
    () => filterSessionLogs(logs, { query, host }),
    [logs, query, host],
  );
  const summary = useMemo(
    () => (detail ? parseAsciicast(detail.content) : null),
    [detail],
  );
  /** 彩色视图的 span 列表；解析成本只在详情变化时付一次。 */
  const colored = useMemo(
    () => (summary ? parseAnsi(summary.text) : []),
    [summary],
  );

  return (
    <div
      className="session-logs-page"
      // 日志页不提供右键菜单：显式吞掉默认菜单（全局根容器已兜底，这里再
      // 收紧一次，避免列表项冒泡触发浏览器菜单）。
      onContextMenu={(e) => e.preventDefault()}
    >
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
            visible.map((log) => {
              // 默认记录的 title 由文件名派生，通常与主机名相同；只有自定义标题才单独占一行。
              const itemTitle = sessionLogItemTitle(log);
              return (
                <button
                  key={log.id}
                  className={`session-logs-item${
                    activeId === log.id ? " active" : ""
                  }`}
                  onClick={() => void openLog(log)}
                >
                  {itemTitle && (
                    <div className="session-logs-item-title">
                      <span className="session-logs-item-name">{itemTitle}</span>
                    </div>
                  )}
                  <div className="session-logs-item-meta">
                    <span>{log.host_name || "—"}</span>
                    <span>{formatLogTime(log.started_at)}</span>
                  </div>
                  <div className="session-logs-item-meta">
                    <span>{formatLogDuration(log.duration_ms)}</span>
                    <span>{formatLogSize(log.size_bytes)}</span>
                  </div>
                </button>
              );
            })
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
              <div className="session-logs-view-toggle">
                <button
                  className={rawView ? "" : "active"}
                  onClick={() => setRawView(false)}
                >
                  彩色
                </button>
                <button
                  className={rawView ? "active" : ""}
                  onClick={() => setRawView(true)}
                >
                  原文
                </button>
              </div>
              <div className="session-logs-zoom">
                <button
                  title="减小字号"
                  disabled={fontSize <= 9}
                  onClick={() => setFontSize((v) => Math.max(9, v - 1))}
                >
                  A−
                </button>
                <span>{fontSize}px</span>
                <button
                  title="增大字号"
                  disabled={fontSize >= 22}
                  onClick={() => setFontSize((v) => Math.min(22, v + 1))}
                >
                  A+
                </button>
              </div>
              <div className="session-logs-export">
                <button
                  className="session-logs-action"
                  title={`导出（默认 ${defaultExportFormat().toUpperCase()}）`}
                  disabled={exporting}
                  onClick={() =>
                    void exportLog(detail.log, defaultExportFormat())
                  }
                >
                  <Icon name="download" size={14} />
                </button>
                <button
                  className="session-logs-action session-logs-export-toggle"
                  title="选择导出格式"
                  disabled={exporting}
                  onClick={() => setExportMenuOpen((v) => !v)}
                >
                  <Icon name="chevron-down" size={12} />
                </button>
                {exportMenuOpen && (
                  <div className="session-logs-export-menu">
                    <button onClick={() => void exportLog(detail.log, "cast")}>
                      Asciicast（.cast）
                    </button>
                    <button onClick={() => void exportLog(detail.log, "txt")}>
                      纯文本（.txt）
                    </button>
                    <button onClick={() => void exportLog(detail.log, "html")}>
                      HTML（.html）
                    </button>
                  </div>
                )}
              </div>
              <button
                className="session-logs-action session-logs-danger"
                title="删除"
                onClick={() => setDeleteTarget(detail.log)}
              >
                <Icon name="trash" size={14} />
              </button>
            </header>

            {notice && <p className="session-logs-notice">{notice}</p>}

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
              <pre className="session-logs-content" style={{ fontSize }}>
                {rawView
                  ? summary.text
                  : colored.map((span, index) => (
                      <span key={index} style={ansiStyle(span)}>
                        {span.text}
                      </span>
                    ))}
              </pre>
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
