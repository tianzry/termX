/**
 * 命令历史面板（终端右侧栏 history 视图，对照 Netcatty
 * `components/HistorySidePanel.tsx`）。
 *
 * 结构（逐项对齐 Netcatty）：
 * - 头部 h-8：搜索框（左，h-6）+ 右侧操作（主机范围 = 重新读取，全局范围 = 清空）；
 * - 范围行 min-h-28：主机（终端图标 + 主机名）/ 全局（地球图标）两个 tab，
 *   右侧显示条数；
 * - 列表行：主机范围 h-9（36px）只显示命令；全局范围 h-11（46px）加一行
 *   主机名；命令 11px 等宽单行截断；
 * - 行内操作默认 opacity 0，悬停 / 聚焦时显示（运行 / 粘贴到终端 / 删除）；
 * - 点击行展开内联详情（命令最多 3 行 + 主机名 / 时间 + 同一组操作）。
 *
 * 行为（对齐 Netcatty）：点击行只展开不执行；运行 = 写入终端并回车，
 * 粘贴 = 只写入不执行；全局范围的清空沿用「再点一次确认」的二次确认
 * （Netcatty 用 ConfirmDialog，termX 无通用确认框）。
 *
 * termX 差异（已在 changelogs 说明）：主机范围的历史来自本地全局记录按
 * 主机过滤（Netcatty 读远端 shell history），因此「刷新」只是重新读取本地
 * 记录；删除在两种范围都可用。
 */
import { useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  Globe,
  Play,
  RefreshCw,
  Search,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import {
  COMMAND_HISTORY_CHANGED_EVENT,
  clearCommandHistory,
  deleteCommandHistoryEntry,
  filterCommandHistory,
  formatCommandHistoryTime,
  readCommandHistory,
  type CommandHistoryEntry,
  type CommandHistoryScope,
} from "./commandHistoryModel";

interface Props {
  hostId: string;
  hostLabel: string;
  /** 运行：写入终端并回车。 */
  onRun: (command: string) => void;
  /** 粘贴：写入终端但不回车。 */
  onPaste: (command: string) => void;
}

export function CommandHistoryPanel({ hostId, hostLabel, onRun, onPaste }: Props) {
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

  // 范围切换时收起展开项（对齐 Netcatty 对 scope 的处理）。
  useEffect(() => {
    setExpandedId(null);
  }, [scope]);

  const sourceEntries = useMemo(
    () => filterCommandHistory(entries, { query: "", scope, hostId }),
    [entries, scope, hostId],
  );
  const visible = useMemo(
    () => filterCommandHistory(entries, { query, scope, hostId }),
    [entries, query, scope, hostId],
  );

  const toggleExpanded = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  };

  const actions = (entry: CommandHistoryEntry, size: number) => (
    <div className="term-history-row-actions" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        title="在终端执行"
        aria-label="在终端执行"
        onClick={() => onRun(entry.command)}
      >
        <Play size={size} />
      </button>
      <button
        type="button"
        title="粘贴到终端（不执行）"
        aria-label="粘贴到终端"
        onClick={() => onPaste(entry.command)}
      >
        <Clipboard size={size} />
      </button>
      <button
        type="button"
        title="从历史记录中删除"
        aria-label="从历史记录中删除"
        onClick={() => {
          deleteCommandHistoryEntry(entry.id);
          if (expandedId === entry.id) setExpandedId(null);
        }}
      >
        <Trash2 size={size} />
      </button>
    </div>
  );

  return (
    <div
      className="term-history-panel"
      aria-label="命令历史"
      data-section="command-history"
      data-history-scope={scope}
    >
      <div className="term-history-head">
        <div className="term-history-search">
          <Search size={12} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索历史命令..."
            aria-label="搜索命令历史"
          />
        </div>
        {scope === "host" ? (
          <button
            type="button"
            className="term-history-head-action"
            title="重新读取本主机历史"
            aria-label="重新读取本主机历史"
            onClick={() => {
              setEntries(readCommandHistory());
              setExpandedId(null);
            }}
          >
            <RefreshCw size={14} />
          </button>
        ) : (
          <button
            type="button"
            className={`term-history-head-action${clearArmed ? " armed" : ""}`}
            title={clearArmed ? "再点一次清空全部历史" : "清空全部历史"}
            aria-label="清空全部历史"
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
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="term-history-scope-row">
        <div className="term-history-scopes" role="tablist" aria-label="历史范围">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "host"}
            className={scope === "host" ? "active" : ""}
            title={`只显示 ${hostLabel} 的命令`}
            onClick={() => setScope("host")}
          >
            <TerminalIcon size={10} />
            <span className="term-history-scope-label">{hostLabel || "主机"}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "all"}
            className={scope === "all" ? "active" : ""}
            title="显示所有主机"
            onClick={() => setScope("all")}
          >
            <Globe size={10} />
            <span>全局</span>
          </button>
        </div>
        {sourceEntries.length > 0 && (
          <span className="term-history-meta">{sourceEntries.length} 条</span>
        )}
      </div>

      <div className="term-history-list" role="list">
        {sourceEntries.length === 0 ? (
          <div className="term-history-empty">
            <TerminalIcon size={24} />
            <span>
              {scope === "host"
                ? "该主机上未找到命令历史。"
                : "暂无全局命令历史。你执行的命令会记录在这里。"}
            </span>
          </div>
        ) : visible.length === 0 ? (
          <div className="term-history-no-results">未找到结果</div>
        ) : (
          visible.map((entry) => {
            const expanded = expandedId === entry.id;
            return (
              <div key={entry.id} className="term-history-item">
                <div
                  className={`term-history-row${expanded ? " expanded" : ""}${
                    scope === "all" && entry.hostLabel ? " with-host" : ""
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  title={expanded ? undefined : entry.command}
                  onClick={() => toggleExpanded(entry.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    toggleExpanded(entry.id);
                  }}
                >
                  <div className="term-history-row-main">
                    <div className="term-history-command">{entry.command}</div>
                    {scope === "all" && entry.hostLabel && (
                      <div className="term-history-host">{entry.hostLabel}</div>
                    )}
                  </div>
                  {actions(entry, 12)}
                </div>
                {expanded && (
                  <div className="term-history-detail">
                    <div className="term-history-detail-command">{entry.command}</div>
                    <div className="term-history-detail-foot">
                      <div className="term-history-detail-meta">
                        {entry.hostLabel && <span>{entry.hostLabel}</span>}
                        {entry.timestamp > 0 && (
                          <span>{formatCommandHistoryTime(entry.timestamp)}</span>
                        )}
                      </div>
                      {actions(entry, 12)}
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
