/**
 * 空闲态起始页（对照 netcatty 的 `VaultView` 主机页）。
 *
 * 没有活动终端时占据主区域：标题 + 搜索 + 分组过滤 + 网格 / 列表视图。
 * 点击主机即新建 SSH 标签；本地终端始终排在最前。
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

function hueOf(name: string): number {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

export function VaultHome({ profiles, groups, onConnect, onLocal, onOpenManager }: Props) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [groupFilter, setGroupFilter] = useState<string>("all");

  const keyword = query.trim().toLowerCase();
  const visible = profiles.filter((p) => {
    if (groupFilter !== "all" && p.group_id !== groupFilter) return false;
    if (!keyword) return true;
    return (
      p.name.toLowerCase().includes(keyword) ||
      p.host.toLowerCase().includes(keyword) ||
      String(p.port).includes(keyword)
    );
  });

  return (
    <section className="nc-vault">
      <header className="nc-vault-head">
        <div>
          <h1>主机</h1>
          <p>{profiles.length} 台主机 · 点击即可建立连接</p>
        </div>
        <div className="nc-vault-actions">
          <span className="nc-seg">
            <button
              className={view === "grid" ? "active" : ""}
              title="网格视图"
              onClick={() => setView("grid")}
            >
              <Icon name="grid" size={15} />
            </button>
            <button
              className={view === "list" ? "active" : ""}
              title="列表视图"
              onClick={() => setView("list")}
            >
              <Icon name="list" size={15} />
            </button>
          </span>
          <button className="nc-btn primary" onClick={onOpenManager}>
            <Icon name="plus" size={14} />
            新建连接
          </button>
        </div>
      </header>

      <div className="nc-vault-toolbar">
        <div className="nc-search nc-search-wide">
          <Icon name="search" size={15} className="nc-search-icon" />
          <input
            value={query}
            placeholder="搜索主机名、地址或端口"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="nc-chips">
          <button
            className={`nc-chip${groupFilter === "all" ? " active" : ""}`}
            onClick={() => setGroupFilter("all")}
          >
            全部
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              className={`nc-chip${groupFilter === g.id ? " active" : ""}`}
              onClick={() => setGroupFilter(g.id)}
            >
              <span className="nc-chip-dot" style={{ background: g.color || "#3b82f6" }} />
              {g.name}
            </button>
          ))}
        </div>
      </div>

      <div className="nc-vault-scroll">
        <button className="nc-vault-local" onClick={onLocal}>
          <span className="nc-avatar nc-avatar-local">
            <Icon name="monitor" size={16} />
          </span>
          <span className="nc-vault-local-text">
            <strong>本地终端</strong>
            <span>在当前系统打开一个 PTY 会话</span>
          </span>
          <span className="nc-vault-local-go">打开</span>
        </button>

        {visible.length === 0 ? (
          <div className="nc-vault-empty">
            <span className="nc-vault-empty-icon">
              <Icon name="server" size={28} />
            </span>
            {profiles.length === 0 ? (
              <>
                <h2>还没有保存的主机</h2>
                <p>在连接管理里新建主机与凭据，之后会出现在这里。</p>
                <button className="nc-btn primary" onClick={onOpenManager}>
                  新建连接
                </button>
              </>
            ) : (
              <>
                <h2>没有匹配的主机</h2>
                <p>换个关键词或清除分组筛选。</p>
              </>
            )}
          </div>
        ) : view === "grid" ? (
          <div className="nc-host-grid">
            {visible.map((p) => (
              <button
                className="nc-host-card"
                key={p.id}
                onClick={() => onConnect(p)}
                title={`连接 ${p.name}`}
              >
                <span
                  className="nc-avatar lg"
                  style={{ "--nc-avatar-hue": hueOf(p.name) } as CSSProperties}
                >
                  {(p.name.trim()[0] ?? "?").toUpperCase()}
                </span>
                <span className="nc-host-card-main">
                  <strong>{p.name}</strong>
                  <span className="nc-host-card-sub">
                    {p.host}:{p.port}
                  </span>
                </span>
                <span className="nc-host-card-connect">
                  <Icon name="terminal" size={14} />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="nc-host-list">
            {visible.map((p) => (
              <button className="nc-host-row" key={p.id} onClick={() => onConnect(p)}>
                <span
                  className="nc-avatar"
                  style={{ "--nc-avatar-hue": hueOf(p.name) } as CSSProperties}
                >
                  {(p.name.trim()[0] ?? "?").toUpperCase()}
                </span>
                <span className="nc-host-main">
                  <span className="nc-host-name">{p.name}</span>
                  <span className="nc-host-sub">
                    {p.host}:{p.port}
                  </span>
                </span>
                <span className="nc-host-row-go">
                  <Icon name="terminal" size={13} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
