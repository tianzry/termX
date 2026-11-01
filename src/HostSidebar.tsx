/**
 * 终端态左侧主机树（对照 netcatty `TerminalHostTreeSidebar`）。
 *
 * 结构：36px 工具条（新建 / 搜索 / 标签 / 本地终端 / 更多 / 收起）+
 * 可展开搜索行 + 28px 紧凑树行（分组可折叠）。默认宽度 220px，
 * 与 netcatty `TERMINAL_HOST_TREE_DEFAULT_WIDTH` 一致。
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
  onClose?: () => void;
}

function avatarText(profile: Profile): string {
  return (profile.name.trim()[0] ?? "?").toUpperCase();
}

function avatarHue(profile: Profile): number {
  let n = 0;
  for (const ch of profile.name) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

export function HostSidebar({
  profiles,
  groups,
  onConnect,
  onLocal,
  onOpenManager,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
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
    <aside className="nc-sidebar" data-section="terminal-host-tree">
      <div className="nc-sidebar-toolbar" data-section="terminal-host-tree-toolbar">
        <button className="nc-tree-tool" title="新建主机" onClick={onOpenManager}>
          <Icon name="plus" size={14} />
        </button>
        <button
          className={`nc-tree-tool${searchOpen || query ? " active" : ""}`}
          title="搜索主机"
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon name="search" size={14} />
        </button>
        <button className="nc-tree-tool" title="标签筛选（尚未实现）" disabled>
          <Icon name="tag" size={14} />
        </button>
        <button className="nc-tree-tool" title="本地终端" onClick={onLocal}>
          <Icon name="terminal" size={14} />
        </button>
        <button className="nc-tree-tool" title="更多（尚未实现）" disabled>
          <Icon name="chevron-down" size={14} />
        </button>
        <span className="nc-tree-tool-spacer" />
        {onClose && (
          <button className="nc-tree-tool" title="收起主机侧栏" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>

      {searchOpen && (
        <div className="nc-sidebar-search-panel">
          <div className="nc-sidebar-search">
            <Icon name="search" size={12} className="nc-search-icon" />
            <input
              autoFocus
              value={query}
              placeholder="搜索主机"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="nc-tree-tool" title="清空" onClick={() => setQuery("")}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="nc-sidebar-scroll">
        <button className="nc-tree-row" onClick={onLocal}>
          <span className="nc-tree-avatar local">
            <Icon name="terminal" size={11} />
          </span>
          <span className="nc-tree-label">本地终端</span>
        </button>

        {sections.map((section) => {
          const isCollapsed = collapsed[section.id] ?? false;
          return (
            <div className="nc-tree-group" key={section.id}>
              <button
                className="nc-tree-row nc-tree-group-head"
                onClick={() =>
                  setCollapsed((m) => ({ ...m, [section.id]: !isCollapsed }))
                }
              >
                <Icon
                  name={isCollapsed ? "chevron-right" : "chevron-down"}
                  size={12}
                />
                <Icon name="folder" size={12} />
                <span className="nc-tree-label">{section.name}</span>
                <span className="nc-tree-count">{section.hosts.length}</span>
              </button>
              {!isCollapsed &&
                section.hosts.map((p) => (
                  <button
                    className="nc-tree-row nc-tree-host"
                    key={p.id}
                    title={`${p.name} · ${p.host}:${p.port}`}
                    onClick={() => onConnect(p)}
                  >
                    <span
                      className="nc-tree-avatar"
                      style={{ "--nc-avatar-hue": avatarHue(p) } as CSSProperties}
                    >
                      {avatarText(p)}
                    </span>
                    <span className="nc-tree-label">{p.name}</span>
                  </button>
                ))}
            </div>
          );
        })}

        {profiles.length === 0 && (
          <div className="nc-sidebar-empty">
            <span>还没有主机</span>
            <button onClick={onOpenManager}>新建主机</button>
          </div>
        )}
        {profiles.length > 0 && filtered.length === 0 && (
          <div className="nc-sidebar-empty">没有匹配的主机</div>
        )}
      </div>
    </aside>
  );
}
