/**
 * 顶部标签栏（对照 netcatty `components/TopTabs.tsx`）。
 *
 * 结构：固定根标签（Vaults / SFTP）→ 主机树开关 → 会话标签 → 新建 →
 * 右侧工具按钮（AI / 同步 / 锁屏 / 快捷控制 / 设置）。
 *
 * 未实现的功能保留入口并禁用；会话标签状态由 Workspace 持有，
 * 这里只展示快照并回调。
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Cloud,
  Folder,
  FolderLock,
  Lock,
  Plus,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Usb,
} from "lucide-react";
import { useSettings } from "./settings/settingsStore";
import type { Tab } from "./workspaceModel";
import { Icon } from "./ui/icons";
import type { DiscoveredShell, Group, Profile } from "./backend/client";
import { isMonochromeShellIcon, shellIconSrc } from "./ui/shellIcons";
import { DistroAvatar } from "./ui/DistroAvatar";
import { QuickSwitcher } from "./QuickSwitcher";

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
  /** 快速切换器的数据源与动作。 */
  profiles: Profile[];
  groups: Group[];
  shells: DiscoveredShell[];
  onConnect: (profile: Profile) => void;
  onLocalShell: (shell: DiscoveredShell) => void;
  onOpenVault: () => void;
  onOpenSftp: () => void;
  onToggleHostTree: () => void;
  onOpenSettings: () => void;
  /** 右侧快捷入口：云端同步跳 Vault「同步」页。 */
  onOpenSync: () => void;
  /** 右侧快捷入口：应用锁（设置中心「系统」tab）。 */
  onOpenLock: () => void;
  /** 右侧快捷入口：外观与窗口（设置中心「外观」tab）。 */
  onOpenAppearance: () => void;
  /** 标签右键菜单：重命名 / 复制标签 / 重连 / 批量关闭 / 拖拽排序（对齐 Netcatty 会话标签菜单）。 */
  onRenameTab: (id: string, title: string) => void;
  /** 用同连接参数在独立窗口打开（后端 `open_tab_in_new_window`）。 */
  onOpenInNewWindow: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseLeft: (id: string) => void;
  onCloseRight: (id: string) => void;
  onCloseAll: () => void;
  onReconnectTab: (id: string) => void;
  onMoveTab: (id: string, toIndex: number) => void;
}

/** 会话标签 16px 图标容器：accent 15% 底 + accent 前景（Netcatty TOP_TAB 图标）。 */
const TAB_GLYPH_BOX: CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: 4,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "color-mix(in srgb, hsl(var(--accent)) 15%, transparent)",
  color: "hsl(var(--accent))",
};

/** 串口标签：琥珀底色（与 DistroAvatar 串口头像一致）。 */
const TAB_GLYPH_SERIAL: CSSProperties = {
  ...TAB_GLYPH_BOX,
  backgroundColor: "#D97706",
  color: "#fff",
};

/** 会话标签图标：SSH → 对应档案的 distro 头像（16px）/ serial → USB / 本地 → shell 图标或终端。 */
function TabGlyph({ tab, profiles }: { tab: Tab; profiles: Profile[] }) {
  const connector = tab.connector;
  if (connector.kind === "serial") {
    return (
      <div style={TAB_GLYPH_SERIAL}>
        <Usb size={10} />
      </div>
    );
  }
  if (connector.kind === "pty") {
    // termX 的 pty 连接器暂未携带 shell 图标快照，缺失时回退终端图标。
    const icon = (connector as { icon?: string }).icon;
    if (icon) {
      return (
        <img
          src={shellIconSrc(icon)}
          alt={tab.title}
          className={`nc-shell-icon${isMonochromeShellIcon(icon) ? " mono" : ""}`}
        />
      );
    }
    return (
      <div style={TAB_GLYPH_BOX}>
        <Terminal size={10} />
      </div>
    );
  }
  // SSH：能找到 tab 对应档案就用 16px distro 头像（含 Server 回退），
  // 找不到档案（例如会话恢复数据不完整）保留原来的 Server 图标。
  if (connector.kind === "ssh") {
    const profile = profiles.find((p) => p.id === connector.profileId);
    if (profile) return <DistroAvatar profile={profile} size="xs" />;
  }
  return (
    <div style={TAB_GLYPH_BOX}>
      <Server size={10} />
    </div>
  );
}

/** 后端能力尚未移植：入口保留，禁用点击。 */
const notPortedUtilities: Array<{
  id: string;
  label: string;
  icon: "sparkles";
}> = [{ id: "ai", label: "AI 助手（未移植）", icon: "sparkles" }];

export function TopTabs({
  tabs,
  activeTabId,
  surface,
  hostTreeOpen,
  status,
  onActivate,
  onClose,
  onDuplicateTab,
  profiles,
  groups,
  shells,
  onConnect,
  onLocalShell,
  onOpenVault,
  onOpenSftp,
  onToggleHostTree,
  onOpenSettings,
  onOpenSync,
  onOpenLock,
  onOpenAppearance,
  onRenameTab,
  onOpenInNewWindow,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onCloseAll,
  onReconnectTab,
  onMoveTab,
}: Props) {
  // 设置中心「外观 · 主机库」两个显示开关（对照 Netcatty showSftpTab /
  // showHostTreeSidebar）。
  const settings = useSettings();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [rename, setRename] = useState<{ id: string; value: string } | null>(null);
  /** 顶部「+」/ Ctrl+J 打开的快速切换器（对齐 Netcatty QuickSwitcher）。 */
  const [quickOpen, setQuickOpen] = useState(false);
  const dragId = useRef<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setQuickOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // 批量关闭项按「右键锚点」的位置判定可用性（对齐 Netcatty renderBulkCloseItems）。
  const menuIndex = menu ? tabs.findIndex((t) => t.id === menu.id) : -1;

  return (
    <>
    <header className="nc-topbar" data-section="top-tabs">
      <div className="nc-topbar-row">
        <div className="nc-root-tabs">
          <button
            className={`nc-root-tab${surface === "vault" ? " active flat" : ""}`}
            onClick={onOpenVault}
          >
            <FolderLock size={14} />
            <span>Vaults</span>
          </button>
          {settings.showSftpTab && (
            <button
              className={`nc-root-tab${surface === "sftp" ? " active" : ""}`}
              onClick={onOpenSftp}
            >
              <Folder size={14} />
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
          {tabs.map((tab, index) => {
            const active = surface === null && tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                title={tab.title}
                className={`nc-session-tab${active ? " active" : ""}`}
                draggable
                onDragStart={() => {
                  dragId.current = tab.id;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId.current && dragId.current !== tab.id) {
                    onMoveTab(dragId.current, index);
                  }
                  dragId.current = null;
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  onActivate(tab.id);
                }}
                onAuxClick={(e) => {
                  // 对齐 Netcatty：中键点击关闭会话标签。
                  if (e.button === 1) onClose(tab.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ id: tab.id, x: e.clientX, y: e.clientY });
                }}
                onDoubleClick={() => {
                  // 行为区「标签页双击行为」（Netcatty tabDoubleClickBehavior）：
                  // duplicate / copy 都新建同连接标签（termX 尚无会话复用通道）。
                  if (settings.terminal.tabDoubleClickBehavior === "disabled") return;
                  onDuplicateTab(tab.id);
                }}
              >
                <TabGlyph tab={tab} profiles={profiles} />
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
          <button
            className="nc-icon-btn nc-tab-new"
            title="打开快速切换器 (Ctrl+J)"
            onClick={() => setQuickOpen(true)}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="nc-chrome">
          {notPortedUtilities.map((u) => (
            <button
              key={u.id}
              className="nc-icon-btn nc-utility-btn"
              title={u.label}
              disabled
            >
              <Sparkles size={16} />
            </button>
          ))}
          <button
            className="nc-icon-btn nc-utility-btn"
            title={`云端同步 · ${status}`}
            onClick={onOpenSync}
          >
            <Cloud size={16} />
          </button>
          <button
            className="nc-icon-btn nc-utility-btn"
            title="应用锁"
            onClick={onOpenLock}
          >
            <Lock size={16} />
          </button>
          <button
            className="nc-icon-btn nc-utility-btn"
            title="外观与窗口"
            onClick={onOpenAppearance}
          >
            <SlidersHorizontal size={16} />
          </button>
          <button
            className="nc-icon-btn nc-utility-btn"
            title="设置中心"
            onClick={onOpenSettings}
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {menu && (
        <div
          className="term-context-menu vault-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onDuplicateTab(menu.id);
              setMenu(null);
            }}
          >
            复制标签页
          </button>
          <button
            onClick={() => {
              onOpenInNewWindow(menu.id);
              setMenu(null);
            }}
          >
            在新窗口中打开
          </button>
          <button
            onClick={() => {
              const tab = tabs.find((t) => t.id === menu.id);
              setRename({ id: menu.id, value: tab?.title ?? "" });
              setMenu(null);
            }}
          >
            重命名
          </button>
          <button
            onClick={() => {
              onReconnectTab(menu.id);
              setMenu(null);
            }}
          >
            重新连接
          </button>
          <button
            className="danger"
            onClick={() => {
              onClose(menu.id);
              setMenu(null);
            }}
          >
            关闭
          </button>
          <div className="term-menu-sep" />
          <button
            disabled={tabs.length <= 1}
            onClick={() => {
              onCloseOthers(menu.id);
              setMenu(null);
            }}
          >
            关闭其他标签
          </button>
          <button
            disabled={menuIndex <= 0}
            onClick={() => {
              onCloseLeft(menu.id);
              setMenu(null);
            }}
          >
            关闭左侧标签
          </button>
          <button
            disabled={menuIndex < 0 || menuIndex >= tabs.length - 1}
            onClick={() => {
              onCloseRight(menu.id);
              setMenu(null);
            }}
          >
            关闭右侧标签
          </button>
          <button
            className="danger"
            onClick={() => {
              onCloseAll();
              setMenu(null);
            }}
          >
            关闭所有标签
          </button>
        </div>
      )}

      {rename && (
        <div className="modal-mask" onMouseDown={() => setRename(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>重命名标签</h3>
            <label>
              名称
              <input
                autoFocus
                value={rename.value}
                onChange={(e) => setRename({ id: rename.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRename(null);
                  if (e.key === "Enter" && rename.value.trim()) {
                    onRenameTab(rename.id, rename.value.trim());
                    setRename(null);
                  }
                }}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setRename(null)}>取消</button>
              <button
                disabled={!rename.value.trim()}
                onClick={() => {
                  onRenameTab(rename.id, rename.value.trim());
                  setRename(null);
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
    <QuickSwitcher
      open={quickOpen}
      profiles={profiles}
      groups={groups}
      tabs={tabs}
      shells={shells}
      showSftpTab={settings.showSftpTab}
      onClose={() => setQuickOpen(false)}
      onOpenVault={onOpenVault}
      onOpenSftp={onOpenSftp}
      onActivateTab={onActivate}
      onConnect={onConnect}
      onLocalShell={onLocalShell}
    />
    </>
  );
}
