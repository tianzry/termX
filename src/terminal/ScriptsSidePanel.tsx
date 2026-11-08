/**
 * 终端侧栏「脚本」页：对齐 Netcatty ScriptsSidePanel 的侧栏形态
 * （搜索 + 分组树 + 运行到当前终端）。
 *
 * termX 的脚本编辑 / 录制在独立「脚本」页承载；侧栏只做浏览与运行，
 * 数据面复用 `load_snippets` 与 `SNIPPETS_CHANGED_EVENT`，运行复用
 * `PaneHandle.runSnippet`（与终端右键「运行片段」同一发送链路）。
 */

import { useEffect, useMemo, useState } from "react";
import * as api from "../backend/client";
import type { Snippet } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  SNIPPETS_CHANGED_EVENT,
  ensureSnippetIds,
  filterSnippets,
  groupSnippets,
} from "../snippets/snippetsModel";
import type { PaneHandle } from "../TerminalPane";
import { Icon } from "../ui/icons";

interface Props {
  /** 活动终端窗格句柄；null = 无可用会话（运行按钮禁用）。 */
  activeHandle: PaneHandle | null;
}

export function ScriptsSidePane({ activeHandle }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let disposed = false;
    const load = () => {
      void api
        .loadSnippets()
        .then((list) => {
          if (!disposed) {
            setSnippets(ensureSnippetIds(list));
            setError("");
          }
        })
        .catch((e) => {
          if (!disposed) setError(userVisibleError(String(e)));
        });
    };
    load();
    const onChange = () => load();
    window.addEventListener(SNIPPETS_CHANGED_EVENT, onChange);
    return () => {
      disposed = true;
      window.removeEventListener(SNIPPETS_CHANGED_EVENT, onChange);
    };
  }, []);

  const groups = useMemo(
    () => groupSnippets(filterSnippets(snippets, query)),
    [snippets, query],
  );

  const run = (snippet: Snippet) => {
    if (!activeHandle) {
      setNotice("当前没有已连接的终端窗格");
      return;
    }
    const ok = activeHandle.runSnippet(snippet);
    if (!ok) setNotice("运行失败：窗格未连接");
  };

  return (
    <div className="nc-scripts-pane">
      <div className="nc-sftp-toolbar nc-scripts-toolbar">
        <button
          className={
            showSearch ? "nc-sftp-toolbar-btn active" : "nc-sftp-toolbar-btn"
          }
          aria-label="搜索脚本"
          title="搜索脚本"
          onClick={() => {
            setShowSearch((v) => !v);
            if (showSearch) setQuery("");
          }}
        >
          <Icon name="search" size={13} />
        </button>
        <span className="nc-scripts-toolbar-title">脚本</span>
        <div className="nc-sftp-toolbar-spacer" />
        <span className="nc-scripts-count">{snippets.length}</span>
      </div>

      {showSearch && (
        <div className="nc-sftp-filter">
          <Icon name="search" size={12} />
          <input
            autoFocus
            value={query}
            placeholder="搜索脚本"
            aria-label="搜索脚本"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                setShowSearch(false);
              }
            }}
          />
        </div>
      )}

      <div className="nc-scripts-list">
        {error && <div className="nc-sftp-pane-error">{error}</div>}
        {!error && notice && (
          <div className="nc-sftp-pane-hint">{notice}</div>
        )}
        {!error && groups.length === 0 && (
          <div className="nc-sftp-pane-hint">暂无脚本</div>
        )}
        {!error &&
          groups.map((group) => {
            const key = group.pkg || "__ungrouped__";
            const isCollapsed = collapsed.has(key);
            return (
              <div key={key} className="nc-scripts-group">
                <button
                  className="nc-scripts-group-row"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                >
                  <Icon
                    name={isCollapsed ? "chevron-right" : "chevron-down"}
                    size={11}
                  />
                  <Icon name="folder" size={13} />
                  <span className="nc-scripts-group-name">
                    {group.pkg || "未分组"}
                  </span>
                  <span className="nc-scripts-count">{group.items.length}</span>
                </button>
                {!isCollapsed &&
                  group.items.map((snippet) => (
                    <div
                      key={snippet.id}
                      className="nc-scripts-row"
                      data-snippet-id={snippet.id}
                      title={snippet.command}
                      onDoubleClick={() => run(snippet)}
                    >
                      <Icon name="file-code" size={13} />
                      <span className="nc-scripts-row-name">{snippet.name}</span>
                      <button
                        className="nc-sftp-toolbar-btn nc-scripts-run"
                        aria-label={`运行 ${snippet.name}`}
                        title="运行到当前终端"
                        disabled={!activeHandle}
                        onClick={(e) => {
                          e.stopPropagation();
                          run(snippet);
                        }}
                      >
                        <Icon name="play" size={12} />
                      </button>
                    </div>
                  ))}
              </div>
            );
          })}
      </div>

      <div className="nc-sftp-statusbar">
        <span>双击运行到当前终端</span>
      </div>
    </div>
  );
}
