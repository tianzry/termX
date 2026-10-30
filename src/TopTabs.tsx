/**
 * 顶部标签栏（对照 netcatty `components/TopTabs.tsx` 的信息结构）。
 *
 * 左侧品牌标识，中间会话标签（激活态 / 关闭 / 双击重命名），
 * 右侧 chrome 工具（侧栏开关、分屏、SFTP / 串口 / Telnet / 转发、
 * 连接管理、状态指示）。标签状态由 `Workspace` 持有，本组件只负责展示
 * 与回调，不直接管理会话。
 */

import { useEffect, useState } from "react";
import type { Tab } from "./workspaceModel";
import { Icon } from "./ui/icons";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  status: string;
  sideOpen: boolean;
  tool: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNewTab: () => void;
  onToggleSidebar: () => void;
  onOpenManager: () => void;
  onToggleTool: (name: "sftp" | "serial" | "telnet" | "forward") => void;
  onSplit: (dir: "horizontal" | "vertical") => void;
  onClosePane: () => void;
  onRefresh: () => void;
}

const tools: Array<{
  id: "sftp" | "serial" | "telnet" | "forward";
  label: string;
  icon: "transfer" | "radio" | "network" | "server";
}> = [
  { id: "sftp", label: "文件传输 (SFTP)", icon: "transfer" },
  { id: "serial", label: "串口", icon: "radio" },
  { id: "telnet", label: "Telnet", icon: "network" },
  { id: "forward", label: "端口转发", icon: "server" },
];

export function TopTabs({
  tabs,
  activeTabId,
  status,
  sideOpen,
  tool,
  onActivate,
  onClose,
  onRename,
  onNewTab,
  onToggleSidebar,
  onOpenManager,
  onToggleTool,
  onSplit,
  onClosePane,
  onRefresh,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // 标签被关闭 / 切换后结束重命名，避免输入框停留在已消失的标签上
  useEffect(() => {
    if (editingId && !tabs.some((t) => t.id === editingId)) setEditingId(null);
  }, [tabs, editingId]);

  function commit() {
    const id = editingId;
    const text = draft.trim();
    setEditingId(null);
    if (id && text) onRename(id, text);
  }

  const hasActive = tabs.some((t) => t.id === activeTabId);

  return (
    <header className="nc-topbar">
      <div className="nc-brand" title="termX">
        <span className="nc-brand-mark">
          <Icon name="terminal" size={17} />
        </span>
      </div>

      <button
        className={`nc-icon-btn nc-topbar-btn${sideOpen ? " active" : ""}`}
        title={sideOpen ? "收起主机侧栏" : "展开主机侧栏"}
        onClick={onToggleSidebar}
      >
        <Icon name="panel-left" size={16} />
      </button>

      <div className="nc-tabs" role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              title={tab.title}
              className={`nc-tab${active ? " active" : ""}`}
              onMouseDown={() => onActivate(tab.id)}
              onDoubleClick={() => {
                setDraft(tab.title);
                setEditingId(tab.id);
              }}
            >
              <Icon
                name={tab.connector.kind === "ssh" ? "server" : "terminal"}
                size={13}
                className="nc-tab-icon"
              />
              {editingId === tab.id ? (
                <input
                  className="nc-tab-input"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="nc-tab-title">{tab.title}</span>
              )}
              <button
                className="nc-tab-close"
                title="关闭标签"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onClose(tab.id)}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        <button className="nc-icon-btn nc-tab-new" title="新建本地终端" onClick={onNewTab}>
          <Icon name="plus" size={15} />
        </button>
      </div>

      <div className="nc-chrome">
        <button
          className="nc-icon-btn"
          title="左右分屏"
          disabled={!hasActive}
          onClick={() => onSplit("horizontal")}
        >
          <Icon name="columns" size={15} />
        </button>
        <button
          className="nc-icon-btn"
          title="上下分屏"
          disabled={!hasActive}
          onClick={() => onSplit("vertical")}
        >
          <Icon name="rows" size={15} />
        </button>
        <button
          className="nc-icon-btn"
          title="关闭当前窗格"
          disabled={!hasActive}
          onClick={onClosePane}
        >
          <Icon name="x" size={15} />
        </button>

        <span className="nc-chrome-divider" />

        {tools.map((t) => (
          <button
            key={t.id}
            className={`nc-icon-btn${tool === t.id ? " active" : ""}`}
            title={t.label}
            onClick={() => onToggleTool(t.id)}
          >
            <Icon name={t.icon} size={15} />
          </button>
        ))}

        <span className="nc-chrome-divider" />

        <button className="nc-icon-btn" title="刷新主机列表" onClick={onRefresh}>
          <Icon name="refresh" size={15} />
        </button>
        <button className="nc-icon-btn" title="连接管理" onClick={onOpenManager}>
          <Icon name="sliders" size={15} />
        </button>

        <span className="nc-status" title={status}>
          <span className="nc-status-dot" />
          <span className="nc-status-text">{status}</span>
        </span>
      </div>
    </header>
  );
}
