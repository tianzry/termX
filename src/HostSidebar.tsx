/**
 * 左侧主机树（对照 netcatty `AppHostTreeLayer` / host tree sidebar）。
 *
 * 结构：搜索框 + 「本地终端」入口 + 按分组折叠的主机列表。
 * 点击主机开新标签连接；分组标题可折叠；无分组主机归入「未分组」。
 */

import { useState, type CSSProperties } from "react";
import type { Group, Profile } from "./backend/client";
import { Icon } from "./ui/icons";

interface Props {
  profiles: Profile[];
  groups: Group[];
  onConnect: (profile: Profile) => void;
  onLocal: () => void;
  onOpenManager: () => void;
}

function avatarText(profile: Profile): string {
  return (profile.name.trim()[0] ?? "?").toUpperCase();
}

function avatarHue(profile: Profile): number {
  let n = 0;
  for (const ch of profile.name) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

export function HostSidebar({ profiles, groups, onConnect, onLocal, onOpenManager }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? profiles.filter(
        (p) =>
          p.name.toLowerCase().includes(keyword) ||
          p.host.toLowerCase().includes(keyword) ||
          String(p.port).includes(keyword),
      )
    : profiles;

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const sections: Array<{ id: string; name: string; hosts: Profile[] }> = [];

  for (const g of groups) {
    const hosts = filtered.filter((p) => p.group_id === g.id);
    if (hosts.length > 0) sections.push({ id: g.id, name: g.name, hosts });
  }
  const ungrouped = filtered.filter(
    (p) => !p.group_id || !groupById.has(p.group_id),
  );
  if (ungrouped.length > 0) {
    sections.push({ id: "__ungrouped", name: "未分组", hosts: ungrouped });
  }

  return (
    <aside className="nc-sidebar">
      <div className="nc-sidebar-head">
        <span className="nc-sidebar-title">主机</span>
        <span className="nc-count">{profiles.length}</span>
        <div className="nc-sidebar-actions">
          <button className="nc-icon-btn" title="新建连接" onClick={onOpenManager}>
            <Icon name="plus" size={15} />
          </button>
        </div>
      </div>

      <div className="nc-sidebar-search">
        <Icon name="search" size={14} className="nc-search-icon" />
        <input
          value={query}
          placeholder="搜索主机"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="nc-icon-btn" title="清空" onClick={() => setQuery("")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      <div className="nc-sidebar-scroll">
        <button className="nc-host-row nc-local-row" onClick={onLocal}>
          <span className="nc-avatar nc-avatar-local">
            <Icon name="monitor" size={14} />
          </span>
          <span className="nc-host-main">
            <span className="nc-host-name">本地终端</span>
            <span className="nc-host-sub">PTY · 当前系统</span>
          </span>
        </button>

        {sections.map((section) => {
          const isCollapsed = collapsed[section.id] ?? false;
          return (
            <div className="nc-host-group" key={section.id}>
              <button
                className="nc-group-head"
                onClick={() =>
                  setCollapsed((m) => ({ ...m, [section.id]: !isCollapsed }))
                }
              >
                <Icon
                  name={isCollapsed ? "chevron-right" : "chevron-down"}
                  size={12}
                />
                <Icon name="folder" size={13} />
                <span className="nc-group-name">{section.name}</span>
                <span className="nc-count">{section.hosts.length}</span>
              </button>
              {!isCollapsed &&
                section.hosts.map((p) => (
                  <button
                    className="nc-host-row"
                    key={p.id}
                    title={`${p.name} · ${p.host}:${p.port}`}
                    onClick={() => onConnect(p)}
                  >
                    <span
                      className="nc-avatar"
                      style={{ "--nc-avatar-hue": avatarHue(p) } as CSSProperties}
                    >
                      {avatarText(p)}
                    </span>
                    <span className="nc-host-main">
                      <span className="nc-host-name">{p.name}</span>
                      <span className="nc-host-sub">
                        {p.host}:{p.port}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          );
        })}

        {profiles.length === 0 && (
          <div className="nc-sidebar-empty">
            <span>还没有主机</span>
            <button onClick={onOpenManager}>新建连接</button>
          </div>
        )}
        {profiles.length > 0 && filtered.length === 0 && (
          <div className="nc-sidebar-empty">没有匹配的主机</div>
        )}
      </div>
    </aside>
  );
}
