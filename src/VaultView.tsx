/**
 * Vault 首页（对照 netcatty `components/VaultView.tsx` + `vault/VaultViewLayout.tsx`）。
 *
 * 结构：
 * - 左侧 208px 导航栏：Logo + 主机 / 监控 / 密钥 / 代理 / 端口转发 /
 *   片段 / 已知主机 / 日志 / 设置；未实现项保留入口但禁用。
 * - 右侧圆角内容面板：56px 页头（搜索 / 连接 / 视图 / 标签 / 排序 / 多选 /
 *   新建主机）+ 主机网格、列表或分组树。
 */

import { useState, type CSSProperties } from "react";
import type { Group, Profile } from "./backend/client";
import { Icon, type IconName } from "./ui/icons";

interface Props {
  profiles: Profile[];
  groups: Group[];
  onConnect: (profile: Profile) => void;
  onLocal: () => void;
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
  { id: "keys", label: "密钥", icon: "key" },
  { id: "proxies", label: "代理", icon: "network" },
  { id: "port", label: "端口转发", icon: "transfer" },
  { id: "snippets", label: "片段", icon: "file-code" },
  { id: "known", label: "已知主机", icon: "shield" },
  { id: "logs", label: "日志", icon: "list" },
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

export function VaultView({ profiles, groups, onConnect, onLocal, onOpenManager }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const [viewMenu, setViewMenu] = useState(false);

  const keyword = query.trim().toLowerCase();
  const visible = profiles.filter(
    (p) =>
      !keyword ||
      p.name.toLowerCase().includes(keyword) ||
      p.host.toLowerCase().includes(keyword) ||
      String(p.port).includes(keyword),
  );

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

  function hostRow(p: Profile, compact = false) {
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
                placeholder="搜索主机，或输入 user@host 快速连接"
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
              </button>
              <button className="vault-icon-btn" disabled title="排序（尚未实现）">
                <Icon name="sort" size={16} />
              </button>
              <button className="vault-icon-btn" disabled title="多选（尚未实现）">
                <Icon name="check-square" size={16} />
              </button>
            </div>

            <button className="vault-new-btn" onClick={onOpenManager}>
              <Icon name="plus" size={14} />
              新建主机
            </button>
          </header>

          <div className="vault-content">
            {view === "grid" && (
              <div className="vault-grid">
                {localCard()}
                {visible.map((p) => hostRow(p))}
              </div>
            )}

            {view === "list" && (
              <div className="vault-list">
                {localCard(true)}
                {visible.map((p) => hostRow(p, true))}
              </div>
            )}

            {view === "tree" && (
              <div className="vault-tree">
                {localCard(true)}
                {sections.map((section) => (
                  <div className="vault-tree-group" key={section.id}>
                    <div className="vault-tree-head">
                      <Icon name="chevron-down" size={12} />
                      <Icon name="folder" size={14} />
                      <span>{section.name}</span>
                      <span className="nc-count">{section.hosts.length}</span>
                    </div>
                    {section.hosts.map((p) => hostRow(p, true))}
                  </div>
                ))}
              </div>
            )}

            {profiles.length === 0 && (
              <div className="vault-empty">
                <span className="vault-empty-icon">
                  <Icon name="server" size={26} />
                </span>
                <h2>还没有保存的主机</h2>
                <p>新建主机与凭据后，会出现在这里。</p>
                <button className="vault-new-btn" onClick={onOpenManager}>
                  <Icon name="plus" size={14} />
                  新建主机
                </button>
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
          </div>
        </div>
      </div>
    </section>
  );
}
