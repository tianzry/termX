/**
 * 终端态左侧主机树（对照 netcatty `TerminalHostTreeSidebar`）。
 *
 * 结构：36px 工具条（新建 / 搜索 / 标签 / 本地终端 / 更多 / 收起）+
 * 可展开搜索行 + 28px 紧凑树行（分组可折叠）。默认宽度 220px，
 * 与 netcatty `TERMINAL_HOST_TREE_DEFAULT_WIDTH` 一致。
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { Group, Profile } from "./backend/client";
import { Icon } from "./ui/icons";
import {
  collectHostTags,
  matchesHostTags,
  readHostTags,
} from "./vault/vaultTags";

interface Props {
  profiles: Profile[];
  groups: Group[];
  onConnect: (profile: Profile) => void;
  onLocal: () => void;
  onOpenManager: () => void;
  onClose?: () => void;
  /** 「更多 → 刷新列表」：由 App 传入 loadData。 */
  onRefresh?: () => void;
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
  onRefresh,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [tagMenu, setTagMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => {
    if (!tagMenu && !moreMenu) return;
    const close = () => {
      setTagMenu(false);
      setMoreMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [tagMenu, moreMenu]);

  // 与 Vault 主机页共用同一份 localStorage 标签表。
  const hostTags = readHostTags();
  const availableTags = collectHostTags(
    hostTags,
    profiles.map((p) => p.id),
  );

  const keyword = query.trim().toLowerCase();
  const filtered = profiles.filter((p) => {
    if (!matchesHostTags(hostTags, p.id, selectedTags)) return false;
    if (!keyword) return true;
    return (
      p.name.toLowerCase().includes(keyword) ||
      p.host.toLowerCase().includes(keyword) ||
      String(p.port).includes(keyword)
    );
  });

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
        <div className="nc-tree-tool-wrap">
          <button
            className={`nc-tree-tool${selectedTags.length > 0 ? " active" : ""}`}
            title="标签筛选"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setMoreMenu(false);
              setTagMenu((v) => !v);
            }}
          >
            <Icon name="tag" size={14} />
          </button>
          {tagMenu && (
            <div
              className="vault-view-menu vault-tag-menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {availableTags.length === 0 ? (
                <div className="vault-tag-empty">当前主机还没有标签</div>
              ) : (
                availableTags.map((tag) => (
                  <div className="vault-tag-row" key={tag}>
                    <label className="vault-tag-check">
                      <input
                        type="checkbox"
                        checked={selectedTags.includes(tag)}
                        onChange={() =>
                          setSelectedTags((prev) =>
                            prev.includes(tag)
                              ? prev.filter((t) => t !== tag)
                              : [...prev, tag],
                          )
                        }
                      />
                      <span>{tag}</span>
                    </label>
                  </div>
                ))
              )}
              {selectedTags.length > 0 && (
                <button
                  className="vault-tag-clear"
                  onClick={() => setSelectedTags([])}
                >
                  <Icon name="x" size={12} />
                  清空筛选
                </button>
              )}
            </div>
          )}
        </div>
        <button className="nc-tree-tool" title="本地终端" onClick={onLocal}>
          <Icon name="terminal" size={14} />
        </button>
        <div className="nc-tree-tool-wrap">
          <button
            className={`nc-tree-tool${moreMenu ? " active" : ""}`}
            title="更多"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              setTagMenu(false);
              setMoreMenu((v) => !v);
            }}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          {moreMenu && (
            <div
              className="vault-view-menu nc-tree-more-menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setMoreMenu(false);
                  onOpenManager();
                }}
              >
                <Icon name="server" size={14} />
                管理主机
              </button>
              <button
                onClick={() => {
                  setMoreMenu(false);
                  onRefresh?.();
                }}
              >
                <Icon name="refresh" size={14} />
                刷新列表
              </button>
              {onClose && (
                <button
                  onClick={() => {
                    setMoreMenu(false);
                    onClose();
                  }}
                >
                  <Icon name="x" size={14} />
                  收起侧栏
                </button>
              )}
            </div>
          )}
        </div>
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
                    title={`${p.name} · ${
                      p.protocol === "serial"
                        ? p.serial_port ?? p.host
                        : `${p.host}:${p.port}`
                    }`}
                    onClick={() => onConnect(p)}
                  >
                    {p.protocol === "local" ? (
                      <span className="nc-tree-avatar local">
                        <Icon name="terminal" size={11} />
                      </span>
                    ) : p.protocol === "serial" ? (
                      <span className="nc-tree-avatar serial" title="串口主机">
                        <Icon name="usb" size={11} />
                      </span>
                    ) : (
                      <span
                        className="nc-tree-avatar"
                        style={{ "--nc-avatar-hue": avatarHue(p) } as CSSProperties}
                      >
                        {avatarText(p)}
                      </span>
                    )}
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
