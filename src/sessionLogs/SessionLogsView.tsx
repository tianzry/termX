// Vault「日志」页：只列出「设置 → 终端 → 会话日志」默认目录下的 `.log` 纯文本
// 元信息（文件名 / 主机 / 开始 / 结束 / 时长 / 大小）。应用内不渲染正文：
// 打开走系统默认关联程序，定位走文件管理器，导出由后端直接写目标文件。
// 旧 `~/.termX/recordings` 里的 `.cast` 不再出现（不迁移、不删除文件）。
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import * as api from "../backend/client";
import type { SessionLog } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { getSettings } from "../settings/settingsStore";
import { Icon } from "../ui/icons";
import {
  collectLogHosts,
  filterSessionLogs,
  formatLogDuration,
  formatLogSize,
  sessionLogExportName,
  sortSessionLogsBy,
  type SessionLogSortDirection,
  type SessionLogSortKey,
} from "./sessionLogsModel";
import "./sessionLogs.css";

type ExportFormat = "txt" | "html";

/** 设置里的默认导出格式：html → html，其余（raw / txt）→ txt。 */
function defaultExportFormat(): "txt" | "html" {
  return getSettings().sessionLogs.format === "html" ? "html" : "txt";
}

/** 表格时间列：日期 + 时刻分两行（对齐 Netcatty 表格 date/time 两行）。 */
function formatLogDate(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function formatLogClock(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

/** 表头排序箭头：未激活时不占视觉重量。 */
function SortMark({
  active,
  dir,
}: {
  active: boolean;
  dir: SessionLogSortDirection;
}) {
  return (
    <span className={`session-logs-sort-mark${active ? " active" : ""}`}>
      {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );
}

export function SessionLogsView() {
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [query, setQuery] = useState("");
  const [host, setHost] = useState("");
  const [sortKey, setSortKey] = useState<SessionLogSortKey>("time");
  const [sortDir, setSortDir] = useState<SessionLogSortDirection>("desc");
  /** 行单击只做选中 / 聚焦，不触发打开。 */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionLog | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 正在执行的行级动作（打开 / 定位 / 导出），用于禁用对应行按钮。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 动作成功提示（错误走左侧 err 条）。 */
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.listSessionLogs();
      setLogs(items);
      setErr("");
      // 索引可能被别的入口（终端工具栏 / headless）改过：选中项不在了就清空。
      setSelectedId((current) =>
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
    setBusyId(log.id);
    setErr("");
    setNotice("");
    try {
      await api.openSessionLog(log.id);
      setNotice(`已用系统默认程序打开 ${log.path}`);
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusyId(null);
    }
  }, []);

  const revealLog = useCallback(async (log: SessionLog) => {
    setBusyId(log.id);
    setErr("");
    setNotice("");
    try {
      await api.revealSessionLog(log.id);
      setNotice(`已在文件管理器中定位 ${log.path}`);
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusyId(null);
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setErr("");
    setNotice("");
    try {
      await api.deleteSessionLog(deleteTarget.id);
      setSelectedId((current) =>
        current === deleteTarget.id ? null : current,
      );
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load]);

  /** 导出：只选目标文件，落盘由后端完成，正文不回传前端。 */
  const exportLog = useCallback(
    async (log: SessionLog, format: ExportFormat) => {
      setBusyId(log.id);
      setErr("");
      setNotice("");
      try {
        const name = sessionLogExportName(log, format);
        const path = await api.pickSessionLogExportFile(name, format);
        if (!path) return;
        await api.exportSessionLogToFile(log.id, format, path);
        setNotice(`已导出到 ${path}`);
      } catch (e) {
        setErr(userVisibleError(String(e)));
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const hosts = useMemo(() => collectLogHosts(logs), [logs]);
  const visible = useMemo(
    () =>
      sortSessionLogsBy(
        filterSessionLogs(logs, { query, host }),
        sortKey,
        sortDir,
      ),
    [logs, query, host, sortKey, sortDir],
  );

  function toggleSort(key: SessionLogSortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" ? "asc" : "desc");
  }

  return (
    <div
      className="session-logs-page"
      // 日志页不提供右键菜单：显式吞掉默认菜单（全局根容器已兜底，这里再
      // 收紧一次，避免列表项冒泡触发浏览器菜单）。
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className="session-logs-head">
        <div className="session-logs-head-title">
          <h2>会话日志</h2>
          <p>
            {visible.length} 条
            {visible.length !== logs.length ? ` / 共 ${logs.length} 条` : ""}
          </p>
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
        <button
          className="session-logs-refresh"
          title="刷新"
          disabled={loading}
          onClick={() => void load()}
        >
          <Icon name="refresh" size={14} />
        </button>
      </header>

      {err && <p className="session-logs-message error">{err}</p>}
      {notice && <p className="session-logs-notice">{notice}</p>}

      <div className="session-logs-table-wrap">
        {visible.length > 0 && (
          <div className="session-logs-thead">
            <button
              className="session-logs-th col-session"
              onClick={() => toggleSort("name")}
            >
              文件名
              <SortMark active={sortKey === "name"} dir={sortDir} />
            </button>
            <div className="session-logs-th col-host">主机</div>
            <button
              className="session-logs-th col-time"
              onClick={() => toggleSort("time")}
            >
              开始
              <SortMark active={sortKey === "time"} dir={sortDir} />
            </button>
            <div className="session-logs-th col-end">结束</div>
            <button
              className="session-logs-th col-duration"
              onClick={() => toggleSort("duration")}
            >
              时长
              <SortMark active={sortKey === "duration"} dir={sortDir} />
            </button>
            <button
              className="session-logs-th col-size"
              onClick={() => toggleSort("size")}
            >
              大小
              <SortMark active={sortKey === "size"} dir={sortDir} />
            </button>
            <div className="session-logs-th col-actions">操作</div>
          </div>
        )}

        <div className="session-logs-table-body">
          {visible.length === 0 ? (
            <div className="session-logs-table-empty">
              <div className="session-logs-empty-icon">
                <Icon name="history" size={28} />
              </div>
              <h3>
                {loading
                  ? "加载中…"
                  : logs.length
                    ? "没有匹配的会话日志"
                    : "暂无会话日志"}
              </h3>
              {!loading && !logs.length && (
                <p>
                  主机开启「自动记录会话日志」或工具栏手动开始后，新的
                  `.log` 会写入设置里的默认目录
                </p>
              )}
              {!loading && logs.length > 0 && (
                <p>试试换个关键词，或把主机筛选切回「全部主机」</p>
              )}
            </div>
          ) : (
            visible.map((log) => {
              const selected = selectedId === log.id;
              const busy = busyId === log.id;
              return (
                <div
                  key={log.id}
                  className={`session-logs-row${selected ? " selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    setSelectedId(log.id);
                    e.currentTarget.focus();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(log.id);
                    }
                  }}
                >
                  <div className="session-logs-cell col-session">
                    <div className="session-logs-avatar">
                      <Icon name="file" size={16} />
                    </div>
                    <div className="session-logs-cell-main">
                      <strong title={log.path}>{log.path || "未命名日志"}</strong>
                      <span>
                        {log.status === "recording" ? "记录中" : "纯文本日志"}
                      </span>
                    </div>
                  </div>
                  <div
                    className="session-logs-cell col-host session-logs-ellipsis"
                    title={log.host_name || ""}
                  >
                    {log.host_name || "—"}
                  </div>
                  <div className="session-logs-cell col-time session-logs-time">
                    <strong>{formatLogDate(log.started_at)}</strong>
                    <span>{formatLogClock(log.started_at)}</span>
                  </div>
                  <div className="session-logs-cell col-end session-logs-time">
                    {log.ended_at == null ? (
                      <span>进行中</span>
                    ) : (
                      <>
                        <strong>{formatLogDate(log.ended_at)}</strong>
                        <span>{formatLogClock(log.ended_at)}</span>
                      </>
                    )}
                  </div>
                  <div className="session-logs-cell col-duration">
                    {log.ended_at == null
                      ? "进行中"
                      : formatLogDuration(log.duration_ms)}
                  </div>
                  <div className="session-logs-cell col-size">
                    {formatLogSize(log.size_bytes)}
                  </div>
                  <div className="session-logs-cell col-actions">
                    <button
                      className="session-logs-row-action"
                      title="系统打开"
                      aria-label="系统打开"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void openLog(log);
                      }}
                    >
                      <Icon name="import" size={15} />
                    </button>
                    <button
                      className="session-logs-row-action"
                      title="打开所在文件夹"
                      aria-label="打开所在文件夹"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void revealLog(log);
                      }}
                    >
                      <Icon name="folder" size={15} />
                    </button>
                    <button
                      className="session-logs-row-action"
                      title={`导出（${defaultExportFormat().toUpperCase()}）`}
                      aria-label="导出"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void exportLog(log, defaultExportFormat());
                      }}
                    >
                      <Icon name="download" size={15} />
                    </button>
                    <button
                      className="session-logs-row-action danger"
                      title="删除"
                      aria-label="删除"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(log);
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

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
              <Icon name="trash" size={18} />
              删除“{deleteTarget.path || deleteTarget.title}”？
            </h3>
            <p className="session-logs-delete-desc">
              日志文件会从默认日志目录移除，此操作不可撤销。
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
