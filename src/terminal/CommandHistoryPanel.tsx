/**
 * 命令历史面板（对照 Netcatty `components/HistorySidePanel.tsx` 的全局范围）。
 *
 * 结构：标题 + 搜索 + 「本主机 / 全部」范围切换 + 清空；
 * 列表行单行截断显示命令与主机名，hover 显示运行 / 插入 / 删除；
 * 点击行展开完整命令 + 时间 + 主机 + 同一组操作；空状态有提示。
 * 行为：点击行只展开不执行；运行 = 写入终端并回车，插入 = 只写入不执行。
 */
import { useEffect, useMemo, useState } from "react";
import {
  ClipboardPaste,
  History,
  Play,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  COMMAND_HISTORY_CHANGED_EVENT,
  deleteCommandHistoryEntry,
  formatCommandHistoryTime,
  filterCommandHistory,
  clearCommandHistory,
  readCommandHistory,
  type CommandHistoryEntry,
  type CommandHistoryScope,
} from "./commandHistoryModel";

interface Props {
  hostId: string;
  hostLabel: string;
  onClose: () => void;
  /** 运行：写入终端并回车。 */
  onRun: (command: string) => void;
  /** 插入：写入终端但不回车。 */
  onPaste: (command: string) => void;
}

export function CommandHistoryPanel({
  hostId,
  hostLabel,
  onClose,
  onRun,
  onPaste,
}: Props) {
  const [entries, setEntries] = useState<CommandHistoryEntry[]>(readCommandHistory);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<CommandHistoryScope>("host");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);

  useEffect(() => {
    const onChange = () => setEntries(readCommandHistory());
    window.addEventListener(COMMAND_HISTORY_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(COMMAND_HISTORY_CHANGED_EVENT, onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visible = useMemo(
    () => filterCommandHistory(entries, { query, scope, hostId }),
    [entries, query, scope, hostId],
  );
  const hostCount = entries.filter((entry) => entry.hostId === hostId).length;

  return (
    <div
      className="term-history-panel"
      role="dialog"
      aria-label="命令历史"
      data-section="command-history"
    >
      <div className="term-history-head">
        <div className="term-history-title">
          <History size={13} />
          命令历史
          <span className="term-history-count">{visible.length}</span>
        </div>
        <div className="term-history-head-actions">
          <button
            type="button"
            className={`term-history-clear${clearArmed ? " armed" : ""}`}
            disabled={entries.length === 0}
            onClick={() => {
              if (!clearArmed) {
                setClearArmed(true);
                return;
              }
              clearCommandHistory();
              setClearArmed(false);
              setExpandedId(null);
            }}
            onBlur={() => setClearArmed(false)}
          >
            {clearArmed ? "确认清空" : "清空"}
          </button>
          <button
            type="button"
            className="term-history-close"
            aria-label="关闭命令历史"
            onClick={onClose}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="term-history-toolbar">
        <div className="term-history-search">
          <Search size={11} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索命令或主机..."
            aria-label="搜索命令历史"
            autoFocus
          />
        </div>
        <div className="term-history-scopes" role="tablist" aria-label="历史范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "host"}
            className={scope === "host" ? "active" : ""}
            onClick={() => setScope("host")}
            title={`只显示 ${hostLabel} 的命令`}
          >
            本主机 <span>{hostCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "all"}
            className={scope === "all" ? "active" : ""}
            onClick={() => setScope("all")}
            title="显示所有主机"
          >
            全部 <span>{entries.length}</span>
          </button>
        </div>
      </div>

      <div className="term-history-list" role="list">
        {visible.length === 0 ? (
          <div className="term-history-empty">
            <History size={22} />
            <span>
              {entries.length === 0
                ? "还没有命令记录，在终端执行命令后会自动出现"
                : "没有匹配的命令"}
            </span>
          </div>
        ) : (
          visible.map((entry) => {
            const expanded = expandedId === entry.id;
            return (
              <div key={entry.id} className="term-history-item">
                <div
                  className={`term-history-row${expanded ? " expanded" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  title={entry.command}
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setExpandedId(expanded ? null : entry.id);
                    }
                  }}
                >
                  <div className="term-history-row-main">
                    <div className="term-history-command">{entry.command}</div>
                    {entry.hostLabel && (
                      <div className="term-history-host">
                        {entry.hostLabel}
                        {entry.count > 1 ? ` · ${entry.count} 次` : ""}
                      </div>
                    )}
                  </div>
                  <div
                    className="term-history-row-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      title="运行"
                      aria-label="运行"
                      onClick={() => onRun(entry.command)}
                    >
                      <Play size={12} />
                    </button>
                    <button
                      type="button"
                      title="插入到终端（不执行）"
                      aria-label="插入"
                      onClick={() => onPaste(entry.command)}
                    >
                      <ClipboardPaste size={12} />
                    </button>
                    <button
                      type="button"
                      title="删除"
                      aria-label="删除"
                      onClick={() => {
                        deleteCommandHistoryEntry(entry.id);
                        if (expanded) setExpandedId(null);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="term-history-detail">
                    <pre className="term-history-detail-command">
                      {entry.command}
                    </pre>
                    <div className="term-history-detail-meta">
                      <span>{entry.hostLabel}</span>
                      <span>{formatCommandHistoryTime(entry.timestamp)}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
