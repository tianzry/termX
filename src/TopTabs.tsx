/**
 * 顶部标签栏（对照 netcatty `components/TopTabs.tsx`）。
 *
 * 结构：固定根标签（Vaults / SFTP）→ 主机树开关 → 会话标签 → 新建 →
 * 右侧工具按钮（AI / 同步 / 锁屏 / 快捷控制 / 设置）。
 *
 * 未实现的功能保留入口并禁用；会话标签状态由 Workspace 持有，
 * 这里只展示快照并回调。
 */

import { useSettings } from "./settings/settingsStore";
import type { Tab } from "./workspaceModel";
import { Icon } from "./ui/icons";

export type RootSurface = "vault" | "sftp" | null;

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  surface: RootSurface;
  hostTreeOpen: boolean;
  status: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 双击标签行为「复制会话 / 复制标签页」：新建一个同连接标签。 */
  onDuplicateTab: (id: string) => void;
  onNewTab: () => void;
  onOpenVault: () => void;
  onOpenSftp: () => void;
  onToggleHostTree: () => void;
  onOpenSettings: () => void;
}

/** 尚未实现的后端能力：入口保留，禁用点击。 */
const disabledUtilities: Array<{
  id: string;
  label: string;
  icon: "sparkles" | "cloud" | "lock" | "sliders" | "gear";
}> = [
  { id: "ai", label: "AI 助手（尚未实现）", icon: "sparkles" },
  { id: "sync", label: "云端同步（尚未实现）", icon: "cloud" },
  { id: "lock", label: "应用锁（尚未实现）", icon: "lock" },
  { id: "quick", label: "外观与窗口（尚未实现）", icon: "sliders" },
];

export function TopTabs({
  tabs,
  activeTabId,
  surface,
  hostTreeOpen,
  status,
  onActivate,
  onClose,
  onDuplicateTab,
  onNewTab,
  onOpenVault,
  onOpenSftp,
  onToggleHostTree,
  onOpenSettings,
}: Props) {
  // 设置中心「外观 · 主机库」两个显示开关（对照 Netcatty showSftpTab /
  // showHostTreeSidebar）。
  const settings = useSettings();

  return (
    <header className="nc-topbar" data-section="top-tabs">
      <div className="nc-topbar-row">
        <div className="nc-root-tabs">
          <button
            className={`nc-root-tab${surface === "vault" ? " active flat" : ""}`}
            onClick={onOpenVault}
          >
            <Icon name="folder" size={14} />
            <span>Vaults</span>
          </button>
          {settings.showSftpTab && (
            <button
              className={`nc-root-tab${surface === "sftp" ? " active" : ""}`}
              onClick={onOpenSftp}
            >
              <Icon name="folder" size={14} />
              <span>SFTP</span>
            </button>
          )}
        </div>

        {/* 主机树开关（netcatty 放在标签区内、会话标签之前） */}
        {tabs.length > 0 && settings.showHostTreeSidebar && (
          <button
            className={`nc-icon-btn nc-hosttree-toggle${hostTreeOpen ? " active" : ""}`}
            title={hostTreeOpen ? "收起主机侧栏" : "展开主机侧栏"}
            onClick={onToggleHostTree}
          >
            <Icon name="menu" size={14} />
          </button>
        )}

        <div className="nc-tabs" role="tablist">
          {tabs.map((tab) => {
            const active = surface === null && tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                title={tab.title}
                className={`nc-session-tab${active ? " active" : ""}`}
                onMouseDown={() => onActivate(tab.id)}
                onDoubleClick={() => {
                  // 行为区「标签页双击行为」（Netcatty tabDoubleClickBehavior）：
                  // duplicate / copy 都新建同连接标签（termX 尚无会话复用通道）。
                  if (settings.terminal.tabDoubleClickBehavior === "disabled") return;
                  onDuplicateTab(tab.id);
                }}
              >
                <Icon
                  name={tab.connector.kind === "ssh" ? "server" : "terminal"}
                  size={14}
                  className="nc-session-tab-icon"
                />
                <span className="nc-session-tab-title">{tab.title}</span>
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
            <Icon name="plus" size={14} />
          </button>
        </div>

        <div className="nc-chrome">
          {disabledUtilities.map((u) => (
            <button
              key={u.id}
              className="nc-icon-btn nc-utility-btn"
              title={u.id === "sync" ? `${u.label} · ${status}` : u.label}
              disabled
            >
              <Icon name={u.icon} size={16} />
            </button>
          ))}
          <button
            className="nc-icon-btn nc-utility-btn"
            title="设置中心"
            onClick={onOpenSettings}
          >
            <Icon name="gear" size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
