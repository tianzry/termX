/**
 * Vault 首页（对照 netcatty `components/vault/VaultViewLayout.tsx` 与
 * `vault/VaultHostListSection.tsx`）。
 *
 * 结构：
 * - 左侧 208px 导航栏：Logo + 主机 / 监控 / 密钥串 / 代理 / 端口转发 /
 *   脚本 / 笔记 / 设置；未实现项保留入口但禁用。
 * - 顶部 56px 工具栏：搜索 / 连接 / 视图 / 标签 / 排序 / 多选 /
 *   新建主机（分体按钮）/ 终端 / 串口。
 * - 内容区：「全部主机」面包屑 → 最近连接 → 主机（带条数与在线数）。
 */

import { useState, type CSSProperties } from "react";
import type { Group, Profile } from "./backend/client";
import { Icon, type IconName } from "./ui/icons";

interface Props {
  profiles: Profile[];
  groups: Group[];
  /** 最近连接过的条目 id（SSH 档案 id 或 "__local"）。 */
  recentIds: string[];
  onConnect: (profile: Profile) => void;
  onLocal: () => void;
  onSerial: () => void;
  onOpenManager: () => void;
}

type ViewMode = "grid" | "list" | "tree";

const navItems: Array<{
  id: string;
  label: string;
  icon: IconName;
  enabled?: boolean;
}> = [
  { id: "hosts", label: "主机", icon: "grid", enabled: true },
  { id: "monitor", label: "监控", icon: "activity" },
  { id: "keys", label: "钥匙串", icon: "key" },
  { id: "proxies", label: "代理", icon: "network" },
  { id: "port", label: "端口转发", icon: "transfer" },
  { id: "snippets", label: "脚本", icon: "file-code" },
  { id: "notes", label: "笔记", icon: "file-text" },
];

/** 新建主机下拉里的未实现项：保留入口、禁用点击。 */
const newHostMenu: Array<{ label: string; icon: IconName; enabled?: boolean }> = [
  { label: "新建本地终端主机", icon: "terminal-square", enabled: true },
  { label: "新建分组", icon: "folder" },
  { label: "导入主机", icon: "transfer" },
  { label: "导出主机", icon: "server" },
];

function hueOf(name: string): number {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

function avatarStyle(name: string) {
  return { "--nc-avatar-hue": hueOf(name) } as CSSProperties;
}

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export function VaultView({
  profiles,
  groups,
  recentIds,
  onConnect,
  onLocal,
  onSerial,
  onOpenManager,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const [viewMenu, setViewMenu] = useState(false);
  const [newMenu, setNewMenu] = useState(false);

  const keyword = query.trim().toLowerCase();
  const visible = profiles.filter(
    (p) =>
      !keyword ||
      p.name.toLowerCase().includes(keyword) ||
      p.host.toLowerCase().includes(keyword) ||
      String(p.port).includes(keyword),
  );

  // 最近连接：按记录顺序取前 8 个仍存在的条目。
  const recentProfiles = recentIds
    .map((id) => visible.find((p) => p.id === id))
    .filter((p): p is Profile => Boolean(p))
    .slice(0, 8);
  const showLocalRecently =
    recentIds.includes("__local") && (!keyword || "local".includes(keyword));

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const sections = [
    ...groups.map((g) => ({
      id: g.id,
      name: g.name,
      hosts: visible.filter((p) => p.group_id === g.id),
    })),
    {
      id: "__ungrouped",
      name: "未分组",
      hosts: visible.filter((p) => !p.group_id || !groupById.has(p.group_id)),
    },
  ].filter((s) => s.hosts.length > 0);

  function hostCard(p: Profile, compact = false) {
    return (
      <button
        key={p.id}
        className={`vault-host-card${compact ? " list" : ""}`}
        onClick={() => onConnect(p)}
        title={`连接 ${p.name}`}
      >
        <span className="nc-avatar lg" style={avatarStyle(p.name)}>
          {initial(p.name)}
        </span>
        <span className="vault-host-card-main">
          <strong>{p.name}</strong>
          <span className="vault-host-card-sub">
            {p.host}:{p.port}
          </span>
        </span>
        <span className="vault-host-card-go">
          <Icon name="terminal" size={14} />
        </span>
      </button>
    );
  }

  const localCard = (compact = false) => (
    <button
      key="__local"
      className={`vault-host-card${compact ? " list" : ""}`}
      onClick={onLocal}
      title="新建本地终端"
    >
      <span className="nc-avatar lg local">
        <Icon name="terminal" size={20} />
      </span>
      <span className="vault-host-card-main">
        <strong>本地终端</strong>
        <span className="vault-host-card-sub">PTY · 当前系统</span>
      </span>
      <span className="vault-host-card-go">
        <Icon name="terminal" size={14} />
      </span>
    </button>
  );

  const collection = (hosts: Profile[]) =>
    view === "tree" ? (
      <div className="vault-tree">
        {hosts.map((p) => hostCard(p, true))}
      </div>
    ) : view === "list" ? (
      <div className="vault-list">{hosts.map((p) => hostCard(p, true))}</div>
    ) : (
      <div className="vault-grid">{hosts.map((p) => hostCard(p))}</div>
    );

  return (
    <section className="vault-shell" data-section="vault-view">
      <aside
        className={`vault-sidebar${collapsed ? " collapsed" : ""}`}
        data-section="vault-sidebar"
      >
        <div className="vault-sidebar-brand">
          <button
            className="vault-logo"
            title={collapsed ? "展开导航" : "收起导航"}
            onClick={() => setCollapsed((v) => !v)}
          >
            <Icon name="terminal" size={19} />
          </button>
          {!collapsed && <span className="vault-wordmark">termX</span>}
        </div>

        <nav className="vault-nav">
          {navItems.map((item) => {
            const enabled = Boolean(item.enabled);
            return (
              <button
                key={item.id}
                className={`vault-nav-item${item.id === "hosts" ? " active" : ""}`}
                disabled={!enabled}
                title={enabled ? item.label : `${item.label}（尚未实现）`}
              >
                <Icon name={item.icon} size={16} />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="vault-sidebar-foot">
          <button
            className={`vault-nav-item${collapsed ? " collapsed" : ""}`}
            title="设置中心（尚未实现）"
            disabled
          >
            <Icon name="gear" size={16} />
            {!collapsed && <span>设置</span>}
          </button>
          {!collapsed && <span className="vault-version">termX 0.0.1</span>}
        </div>
      </aside>

      <div className="vault-stage" data-section="vault-stage">
        <div className="vault-surface" data-section="vault-surface">
          <header className="vault-header">
            <div className="vault-search">
              <Icon name="search" size={14} className="nc-search-icon" />
              <input
                value={query}
                placeholder="搜索主机，或输入 user@host / ssh -p 2222 user@hostname"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button
              className="vault-connect-btn"
              disabled
              title="多选连接（尚未实现）"
            >
              连接
            </button>

            <div className="vault-header-tools">
              <div className="vault-view-wrap">
                <button
                  className="vault-icon-btn"
                  title="切换视图"
                  onClick={() => setViewMenu((v) => !v)}
                >
                  <Icon
                    name={view === "grid" ? "grid" : view === "list" ? "list" : "network"}
                    size={16}
                  />
                  <Icon name="chevron-down" size={10} />
                </button>
                {viewMenu && (
                  <div className="vault-view-menu">
                    {(["grid", "list", "tree"] as ViewMode[]).map((m) => (
                      <button
                        key={m}
                        className={view === m ? "active" : ""}
                        onClick={() => {
                          setView(m);
                          setViewMenu(false);
                        }}
                      >
                        <Icon
                          name={m === "grid" ? "grid" : m === "list" ? "list" : "network"}
                          size={14}
                        />
                        {m === "grid" ? "网格" : m === "list" ? "列表" : "树"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button className="vault-icon-btn" disabled title="标签筛选（尚未实现）">
                <Icon name="tag" size={16} />
                <Icon name="chevron-down" size={10} />
              </button>
              <button className="vault-icon-btn" disabled title="排序（尚未实现）">
                <Icon name="sort" size={16} />
                <Icon name="chevron-down" size={10} />
              </button>
              <button className="vault-icon-btn" disabled title="多选（尚未实现）">
                <Icon name="check-square" size={16} />
              </button>
            </div>

            {/* 新建主机：主按钮 + 下拉（分体） */}
            <div className="vault-new-split">
              <button className="vault-new-btn" onClick={onOpenManager}>
                <Icon name="plus" size={14} />
                新建主机
              </button>
              <button
                className="vault-new-btn-caret"
                title="更多新建方式"
                onClick={() => setNewMenu((v) => !v)}
              >
                <Icon name="chevron-down" size={14} />
              </button>
              {newMenu && (
                <div className="vault-view-menu vault-new-menu">
                  {newHostMenu.map((item) => (
                    <button
                      key={item.label}
                      className={item.enabled ? "" : "disabled"}
                      disabled={!item.enabled}
                      onClick={() => {
                        if (!item.enabled) return;
                        setNewMenu(false);
                        onLocal();
                      }}
                      title={item.enabled ? item.label : `${item.label}（尚未实现）`}
                    >
                      <Icon name={item.icon} size={14} />
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button className="vault-secondary-btn" onClick={onLocal}>
              <Icon name="terminal-square" size={14} />
              终端
            </button>
            <button className="vault-secondary-btn" onClick={onSerial}>
              <Icon name="usb" size={14} />
              串口
            </button>
          </header>

          <div className="vault-content">
            {/* 面包屑：全部主机（当前即根层级） */}
            <div className="vault-breadcrumb">
              <button className="vault-all-hosts" title="全部主机">
                全部主机
              </button>
            </div>

            {(recentProfiles.length > 0 || showLocalRecently) && (
              <section className="vault-section">
                <h3 className="vault-section-title">
                  <Icon name="clock" size={14} />
                  最近连接
                </h3>
                <div className={view === "grid" ? "vault-grid" : "vault-list"}>
                  {showLocalRecently && localCard(view !== "grid")}
                  {recentProfiles.map((p) => hostCard(p, view !== "grid"))}
                </div>
              </section>
            )}

            <section className="vault-section">
              <div className="vault-section-head">
                <h3 className="vault-section-title">主机</h3>
                <div className="vault-section-meta">
                  <span>{visible.length} 条</span>
                  <span className="vault-live-pill">0 个在线</span>
                </div>
              </div>

              {view === "tree" ? (
                <div className="vault-tree">
                  {sections.map((section) => (
                    <div className="vault-tree-group" key={section.id}>
                      <div className="vault-tree-head">
                        <Icon name="chevron-down" size={12} />
                        <Icon name="folder" size={14} />
                        <span>{section.name}</span>
                        <span className="nc-count">{section.hosts.length}</span>
                      </div>
                      {section.hosts.map((p) => hostCard(p, true))}
                    </div>
                  ))}
                </div>
              ) : (
                collection(visible)
              )}

              {profiles.length === 0 && (
                <div className="vault-empty">
                  <span className="vault-empty-icon">
                    <Icon name="grid" size={26} />
                  </span>
                  <h2>设置你的主机</h2>
                  <p>保存主机以快速连接到你的服务器、虚拟机和容器。</p>
                </div>
              )}

              {profiles.length > 0 && visible.length === 0 && (
                <div className="vault-empty">
                  <span className="vault-empty-icon">
                    <Icon name="search" size={26} />
                  </span>
                  <h2>没有匹配的主机</h2>
                  <p>换个关键词试试。</p>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
