/**
 * Vault 首页（对照 netcatty `components/vault/VaultViewLayout.tsx` 与
 * `vault/VaultHostListSection.tsx`）。
 *
 * 结构：
 * - 左侧导航栏：Logo + 主机 / 监控 / 密钥串 / 代理 / 端口转发 / 脚本 /
 *   笔记 / 已知主机 / 日志；未实现项保留入口但禁用；导航可拖拽调宽。
 * - 顶部 56px 工具栏：搜索（支持快速连接）/ 连接 / 视图 / 标签 / 排序 /
 *   多选 / 新建主机（分体按钮）/ 终端 / 串口。
 * - 内容区：「全部主机」面包屑（树视图隐藏）→ 已置顶 → 最近连接 →
 *   分组 → 主机（带条数与真实在线数）。
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as api from "./backend/client";
import type { Credential, Group, Profile } from "./backend/client";
import { newId } from "./workspaceModel";
import { Icon, type IconName } from "./ui/icons";

export interface HostPrefill {
  name: string;
  host: string;
  port: number;
}

interface Props {
  profiles: Profile[];
  groups: Group[];
  credentials: Credential[];
  /** 最近连接过的条目 id（SSH 档案 id 或 "__local"）。 */
  recentIds: string[];
  /** 当前打开的终端会话数，用于「N 个在线」。 */
  activeSessionCount: number;
  onConnect: (profile: Profile) => void;
  onLocal: () => void;
  onSerial: () => void;
  onOpenManager: () => void;
  onEditProfile: (profile: Profile) => void;
  /** 快速连接：带预填信息打开连接管理器。 */
  onQuickConnect: (prefill: HostPrefill) => void;
  /** 新建 / 删除后刷新 App 侧列表。 */
  onDataChanged: () => void;
}

type ViewMode = "grid" | "list" | "tree";
type SortMode = "name-asc" | "name-desc" | "host-asc" | "host-desc";

const VIEW_KEY = "termx.vault.view.v1";
const SORT_KEY = "termx.vault.sort.v1";
const PINNED_KEY = "termx.pinned.v1";
const SIDEBAR_W_KEY = "termx.vault.sidebar.v1";
const SIDEBAR_MIN = 208;
const SIDEBAR_MAX = 320;

type GroupTile = { id: string; name: string; count: number };

type ComposerDraft = {
  name: string;
  host: string;
  port: string;
  credential_id: string;
  group_id: string;
};

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
  { id: "known-hosts", label: "已知主机", icon: "shield" },
  { id: "logs", label: "日志", icon: "history" },
];

/** 新建主机下拉里的未实现项：保留入口、禁用点击。 */
const newHostMenu: Array<{ label: string; icon: IconName; enabled?: boolean }> = [
  { label: "新建本地终端主机", icon: "terminal-square", enabled: true },
  { label: "新建分组", icon: "folder" },
  { label: "导入主机", icon: "transfer" },
  { label: "导出主机", icon: "server" },
];

const SORT_LABEL: Record<SortMode, string> = {
  "name-asc": "名称 A → Z",
  "name-desc": "名称 Z → A",
  "host-asc": "主机 A → Z",
  "host-desc": "主机 Z → A",
};

function clampWidth(n: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_W_KEY));
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : SIDEBAR_MIN;
  } catch {
    return SIDEBAR_MIN;
  }
}

function readView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "tree" ? v : "grid";
  } catch {
    return "grid";
  }
}

function readSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v && v in SORT_LABEL ? (v as SortMode) : "name-asc";
  } catch {
    return "name-asc";
  }
}

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略持久化失败 */
  }
}

/**
 * 快速连接语法：
 * - `user@host`
 * - `ssh user@host`
 * - `ssh -p 2222 user@host`
 * 返回 null 时按普通搜索处理。
 */
function parseQuickConnect(raw: string): {
  host: string;
  port: number;
  username?: string;
} | null {
  let text = raw.trim();
  if (!text) return null;
  let port = 22;
  if (/^ssh(?:\s|$)/i.test(text)) {
    text = text.slice(3).trim();
    const portMatch = /^-p\s*(\d+)(?:\s+|$)/.exec(text);
    if (portMatch) {
      port = Number(portMatch[1]);
      text = text.slice(portMatch[0].length).trim();
    }
    if (!text) return null;
  } else if (!text.includes("@")) {
    return null;
  }
  const token = text.split(/\s+/)[0] ?? "";
  const at = token.lastIndexOf("@");
  const username = at >= 0 ? token.slice(0, at) : undefined;
  const host = at >= 0 ? token.slice(at + 1) : token;
  const hostPattern = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9][A-Za-z0-9._-]*)$/;
  if (!hostPattern.test(host)) return null;
  if (username !== undefined && !/^[A-Za-z0-9._-]+$/.test(username)) return null;
  if (port < 1 || port > 65535) return null;
  return { host, port, username };
}

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

function viewIcon(mode: ViewMode): IconName {
  return mode === "grid" ? "grid" : mode === "list" ? "list" : "network";
}

export function VaultView({
  profiles,
  groups,
  credentials,
  recentIds,
  activeSessionCount,
  onConnect,
  onLocal,
  onSerial,
  onOpenManager,
  onEditProfile,
  onQuickConnect,
  onDataChanged,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(readView);
  const [sort, setSort] = useState<SortMode>(readSort);
  const [viewMenu, setViewMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [newMenu, setNewMenu] = useState(false);

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinned);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{
    profile: Profile;
    x: number;
    y: number;
  } | null>(null);

  const [composer, setComposer] = useState<ComposerDraft | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerErr, setComposerErr] = useState("");

  // ── 持久化 ──────────────────────────────────────────────

  useEffect(() => {
    persist(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    persist(SORT_KEY, sort);
  }, [sort]);

  useEffect(() => {
    persist(PINNED_KEY, JSON.stringify(pinnedIds));
  }, [pinnedIds]);

  useEffect(() => {
    if (!collapsed) persist(SIDEBAR_W_KEY, String(sidebarWidth));
  }, [sidebarWidth, collapsed]);

  // ── 侧栏拖拽调宽 ────────────────────────────────────────

  useEffect(() => {
    if (!resizing) return;
    function onMove(e: PointerEvent) {
      const start = resizeStart.current;
      if (!start) return;
      setSidebarWidth(clampWidth(start.width + e.clientX - start.x));
    }
    function stop() {
      resizeStart.current = null;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    resizeStart.current = { x: e.clientX, width: sidebarWidth };
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // ── 弹出层关闭 ──────────────────────────────────────────

  const popupOpen = viewMenu || sortMenu || newMenu || Boolean(ctxMenu);
  useEffect(() => {
    if (!popupOpen) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (target?.closest(".vault-popmenu")) return;
      setViewMenu(false);
      setSortMenu(false);
      setNewMenu(false);
      setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setViewMenu(false);
      setSortMenu(false);
      setNewMenu(false);
      setCtxMenu(null);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [popupOpen]);

  // ── 数据派生 ────────────────────────────────────────────

  const credById = new Map(credentials.map((c) => [c.id, c]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const keyword = query.trim().toLowerCase();
  const quick = parseQuickConnect(query);

  function subtitle(p: Profile): string {
    const username = credById.get(p.credential_id)?.username;
    return `${username ? `${username}@` : ""}${p.host}:${p.port}`;
  }

  function sortHosts(list: Profile[]): Profile[] {
    const out = [...list];
    switch (sort) {
      case "name-desc":
        return out.sort((a, b) => b.name.localeCompare(a.name, "zh-Hans-CN"));
      case "host-asc":
        return out.sort((a, b) => a.host.localeCompare(b.host));
      case "host-desc":
        return out.sort((a, b) => b.host.localeCompare(a.host));
      default:
        return out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    }
  }

  // 识别为快速连接时，关键字不参与过滤：列表保持完整，另在顶部给出直连建议行。
  const filterKeyword = quick ? "" : keyword;
  const visible = profiles.filter(
    (p) =>
      !filterKeyword ||
      p.name.toLowerCase().includes(filterKeyword) ||
      p.host.toLowerCase().includes(filterKeyword) ||
      String(p.port).includes(filterKeyword),
  );

  const activeGroupName =
    activeGroupId === null
      ? ""
      : activeGroupId === "__ungrouped"
        ? "未分组"
        : (groupById.get(activeGroupId)?.name ?? "未分组");

  const scopedHosts =
    activeGroupId === null
      ? sortHosts(visible)
      : sortHosts(
          visible.filter((p) =>
            activeGroupId === "__ungrouped"
              ? !p.group_id || !groupById.has(p.group_id)
              : p.group_id === activeGroupId,
          ),
        );

  const groupTiles: GroupTile[] = groups
    .map((g) => ({
      id: g.id,
      name: g.name,
      count: visible.filter((p) => p.group_id === g.id).length,
    }))
    .filter((g) => g.count > 0);
  const ungroupedCount = visible.filter(
    (p) => !p.group_id || !groupById.has(p.group_id),
  ).length;
  if (ungroupedCount > 0) {
    groupTiles.push({ id: "__ungrouped", name: "未分组", count: ungroupedCount });
  }

  const treeSections = [
    ...groups.map((g) => ({
      id: g.id,
      name: g.name,
      hosts: sortHosts(visible.filter((p) => p.group_id === g.id)),
    })),
    {
      id: "__ungrouped",
      name: "未分组",
      hosts: sortHosts(
        visible.filter((p) => !p.group_id || !groupById.has(p.group_id)),
      ),
    },
  ].filter((s) => s.hosts.length > 0);

  // 最近连接：按记录顺序取前 8 个仍存在的条目。
  const recentProfiles = recentIds
    .map((id) => visible.find((p) => p.id === id))
    .filter((p): p is Profile => Boolean(p))
    .slice(0, 8);
  const showLocalRecently =
    recentIds.includes("__local") && (!keyword || "local".includes(keyword));

  const pinnedHosts = sortHosts(
    pinnedIds
      .map((id) => visible.find((p) => p.id === id))
      .filter((p): p is Profile => Boolean(p)),
  );

  const atRoot = activeGroupId === null;

  // ── 选择 / 置顶 / 删除 ──────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(scopedHosts.map((p) => p.id)));
  }

  function togglePin(id: string) {
    setPinnedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
    setCtxMenu(null);
  }

  async function deleteHost(p: Profile) {
    if (!confirm(`删除主机「${p.name}」？`)) return;
    try {
      await api.deleteProfile(p.id);
      setPinnedIds((prev) => prev.filter((x) => x !== p.id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
      onDataChanged();
    } catch {
      /* 删除失败时保持原状，等待后端错误提示 */
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`删除选中的 ${selected.size} 台主机？`)) return;
    try {
      for (const id of selected) await api.deleteProfile(id);
    } catch {
      /* 忽略单条失败，后续统一刷新 */
    }
    setPinnedIds((prev) => prev.filter((id) => !selected.has(id)));
    setSelected(new Set());
    setSelectMode(false);
    onDataChanged();
  }

  function copyHostname(p: Profile) {
    void navigator.clipboard?.writeText(p.host).catch(() => undefined);
  }

  function handleCardClick(p: Profile) {
    if (selectMode) toggleSelect(p.id);
    else onConnect(p);
  }

  function handleCardKey(e: ReactKeyboardEvent<HTMLDivElement>, p: Profile) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    handleCardClick(p);
  }

  function openContextMenu(e: ReactMouseEvent<HTMLDivElement>, p: Profile) {
    e.preventDefault();
    setCtxMenu({
      profile: p,
      x: Math.min(e.clientX, window.innerWidth - 216),
      y: Math.min(e.clientY, window.innerHeight - 330),
    });
  }

  // ── 快速连接 ────────────────────────────────────────────

  function runQuickConnect() {
    if (!quick) return;
    const name = quick.username ? `${quick.username}@${quick.host}` : quick.host;
    onQuickConnect({ name, host: quick.host, port: quick.port });
  }

  // ── 新建主机右侧面板 ────────────────────────────────────

  function openComposer() {
    setComposerErr("");
    setComposer({
      name: "",
      host: "",
      port: "22",
      credential_id: credentials[0]?.id ?? "",
      group_id: activeGroupId && activeGroupId !== "__ungrouped" ? activeGroupId : "",
    });
    setNewMenu(false);
  }

  async function saveComposer(andConnect: boolean) {
    const d = composer;
    if (!d) return;
    if (!d.name.trim() || !d.host.trim()) {
      setComposerErr("名称与主机为必填");
      return;
    }
    if (!d.credential_id) {
      setComposerErr("请选择凭据；没有凭据时先打开连接管理器创建");
      return;
    }
    setComposerBusy(true);
    setComposerErr("");
    const profile: Profile = {
      id: newId(),
      name: d.name.trim(),
      host: d.host.trim(),
      port: Number(d.port) || 22,
      credential_id: d.credential_id,
      bastion_profile_id: null,
      init_command: null,
      group_id: d.group_id || null,
    };
    try {
      await api.createProfile(profile);
      setComposer(null);
      onDataChanged();
      if (andConnect) onConnect(profile);
    } catch (e) {
      setComposerErr(String(e));
    } finally {
      setComposerBusy(false);
    }
  }

  // ── 卡片 ────────────────────────────────────────────────

  function hostCard(p: Profile) {
    const compact = view !== "grid";
    const isSelected = selected.has(p.id);
    const isPinned = pinnedIds.includes(p.id);
    return (
      <div
        key={p.id}
        className={`vault-host-card${compact ? " list" : ""}${
          isSelected ? " selected" : ""
        }`}
        role={selectMode ? "checkbox" : "button"}
        aria-checked={selectMode ? isSelected : undefined}
        tabIndex={0}
        onClick={() => handleCardClick(p)}
        onKeyDown={(e) => handleCardKey(e, p)}
        onContextMenu={(e) => openContextMenu(e, p)}
        title={`${p.name} · ${subtitle(p)}`}
      >
        {selectMode && (
          <span className="vault-host-check">
            <Icon name={isSelected ? "check-square" : "square"} size={18} />
          </span>
        )}
        {!selectMode && view === "grid" && isPinned && (
          <span className="vault-host-star" title="已置顶">
            <Icon name="pin" size={12} />
          </span>
        )}
        <span className="nc-avatar lg" style={avatarStyle(p.name)}>
          {initial(p.name)}
        </span>
        <span className="vault-host-card-main">
          <strong>{p.name}</strong>
          <span className="vault-host-card-sub">{subtitle(p)}</span>
        </span>
        {!selectMode && (
          <button
            className="vault-host-edit"
            title="编辑主机"
            onClick={(e) => {
              e.stopPropagation();
              onEditProfile(p);
            }}
          >
            <Icon name="pencil" size={13} />
          </button>
        )}
        <span className="vault-host-card-go">
          <Icon name="terminal" size={14} />
        </span>
      </div>
    );
  }

  const localCard = (compact = false) => (
    <div
      key="__local"
      className={`vault-host-card${compact ? " list" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onLocal}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onLocal();
      }}
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
    </div>
  );

  function groupCard(g: GroupTile) {
    const compact = view !== "grid";
    return (
      <div
        key={g.id}
        className={`vault-host-card vault-group-card${compact ? " list" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => {
          setActiveGroupId(g.id);
          setSelected(new Set());
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          setActiveGroupId(g.id);
          setSelected(new Set());
        }}
        title={`进入分组 ${g.name}`}
      >
        <span className="nc-avatar lg group">
          <Icon name="folder" size={20} />
        </span>
        <span className="vault-host-card-main">
          <strong>{g.name}</strong>
          <span className="vault-host-card-sub">{g.count} 台主机</span>
        </span>
        <span className="vault-host-card-go">
          <Icon name="chevron-right" size={14} />
        </span>
      </div>
    );
  }

  function hostCollection(hosts: Profile[]) {
    return (
      <div className={view === "grid" ? "vault-grid" : "vault-list"}>
        {hosts.map((p) => hostCard(p))}
      </div>
    );
  }

  return (
    <section className="vault-shell" data-section="vault-view">
      <aside
        className={`vault-sidebar${collapsed ? " collapsed" : ""}${
          resizing ? " resizing" : ""
        }`}
        data-section="vault-sidebar"
        style={collapsed ? undefined : { width: sidebarWidth }}
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
                className={`vault-nav-item${item.id === "hosts" ? " active" : ""}${
                  collapsed ? " collapsed" : ""
                }`}
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

      {!collapsed && (
        <div
          className="vault-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整导航宽度"
          onPointerDown={startResize}
        />
      )}

      <div className="vault-stage" data-section="vault-stage">
        <div className="vault-surface" data-section="vault-surface">
          <header className="vault-header">
            <div className={`vault-search${quick ? " quick" : ""}`}>
              <Icon name="search" size={14} className="nc-search-icon" />
              <input
                value={query}
                placeholder="查找主机或 ssh user@hostname / ssh -p 2222 user@hostname…"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && quick) runQuickConnect();
                }}
              />
              {quick && (
                <span className="vault-quick-tag" title="识别为快速连接">
                  <Icon name="zap" size={14} />
                </span>
              )}
            </div>
            <button
              className={`vault-connect-btn${quick ? " primary" : ""}`}
              disabled={!quick}
              title={
                quick
                  ? `快速连接 ${quick.host}:${quick.port}`
                  : "输入 user@host 或 ssh 命令后可快速连接"
              }
              onClick={runQuickConnect}
            >
              连接
            </button>

            <div className="vault-header-tools">
              <div className="vault-view-wrap">
                <button
                  className="vault-icon-btn"
                  title="切换视图"
                  onClick={() => {
                    setViewMenu((v) => !v);
                    setSortMenu(false);
                  }}
                >
                  <Icon name={viewIcon(view)} size={16} />
                  <Icon name="chevron-down" size={10} />
                </button>
                {viewMenu && (
                  <div className="vault-view-menu vault-popmenu">
                    {(["grid", "list", "tree"] as ViewMode[]).map((m) => (
                      <button
                        key={m}
                        className={view === m ? "active" : ""}
                        onClick={() => {
                          setView(m);
                          if (m === "tree") setActiveGroupId(null);
                          setSelected(new Set());
                          setViewMenu(false);
                        }}
                      >
                        <Icon name={viewIcon(m)} size={14} />
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
              <div className="vault-view-wrap">
                <button
                  className="vault-icon-btn"
                  title={`排序：${SORT_LABEL[sort]}`}
                  onClick={() => {
                    setSortMenu((v) => !v);
                    setViewMenu(false);
                  }}
                >
                  <Icon name="sort" size={16} />
                  <Icon name="chevron-down" size={10} />
                </button>
                {sortMenu && (
                  <div className="vault-view-menu vault-popmenu">
                    {(Object.keys(SORT_LABEL) as SortMode[]).map((m) => (
                      <button
                        key={m}
                        className={sort === m ? "active" : ""}
                        onClick={() => {
                          setSort(m);
                          setSortMenu(false);
                        }}
                      >
                        <Icon name="sort" size={14} />
                        {SORT_LABEL[m]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className={`vault-icon-btn${selectMode ? " active" : ""}`}
                title={selectMode ? "退出多选" : "多选"}
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelected(new Set());
                }}
              >
                <Icon name="check-square" size={16} />
              </button>
            </div>

            {/* 新建主机：主按钮 + 下拉（分体）；打开右侧面板时这组操作折叠 */}
            {!composer && (
              <>
                <div className="vault-new-split">
                  <button className="vault-new-btn" onClick={openComposer}>
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
                    <div className="vault-view-menu vault-new-menu vault-popmenu">
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
                          title={
                            item.enabled ? item.label : `${item.label}（尚未实现）`
                          }
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
              </>
            )}
          </header>

          {selectMode && (
            <div className="vault-select-bar">
              <span className="vault-select-count">已选 {selected.size} 台主机</span>
              <span className="vault-select-spacer" />
              <button onClick={selectAllVisible}>全选</button>
              <button onClick={() => setSelected(new Set())}>取消</button>
              <button
                className="danger"
                disabled={selected.size === 0}
                onClick={() => void deleteSelected()}
              >
                批量删除
              </button>
            </div>
          )}

          <div className="vault-content">
            {/* 面包屑：树视图隐藏 */}
            {view !== "tree" && (
              <div className="vault-breadcrumb">
                <button
                  className="vault-all-hosts"
                  title="全部主机"
                  onClick={() => {
                    setActiveGroupId(null);
                    setSelected(new Set());
                  }}
                >
                  全部主机
                </button>
                {activeGroupId !== null && (
                  <>
                    <span className="vault-crumb-sep">›</span>
                    <button className="vault-crumb-current" title={activeGroupName}>
                      {activeGroupName}
                    </button>
                  </>
                )}
              </div>
            )}

            {quick && (
              <button
                className="vault-quick-suggest"
                title="直接连接，不保存为新主机"
                onClick={runQuickConnect}
              >
                <span className="vault-quick-suggest-icon">
                  <Icon name="zap" size={16} />
                </span>
                <span className="vault-quick-suggest-text">
                  直接连接{" "}
                  <strong>
                    {quick.username ? `${quick.username}@` : ""}
                    {quick.host}:{quick.port}
                  </strong>
                </span>
                <span className="vault-quick-suggest-hint">Enter</span>
              </button>
            )}

            {atRoot && view !== "tree" && pinnedHosts.length > 0 && (
              <section className="vault-section">
                <h3 className="vault-section-title">
                  <Icon name="pin" size={14} />
                  已置顶
                </h3>
                {hostCollection(pinnedHosts)}
              </section>
            )}

            {atRoot &&
              view !== "tree" &&
              (recentProfiles.length > 0 || showLocalRecently) && (
                <section className="vault-section">
                  <h3 className="vault-section-title">
                    <Icon name="clock" size={14} />
                    最近连接
                  </h3>
                  {view === "grid" ? (
                    <div className="vault-grid">
                      {showLocalRecently && localCard()}
                      {recentProfiles.map((p) => hostCard(p))}
                    </div>
                  ) : (
                    <div className="vault-list">
                      {showLocalRecently && localCard(true)}
                      {recentProfiles.map((p) => hostCard(p))}
                    </div>
                  )}
                </section>
              )}

            {atRoot && view !== "tree" && groupTiles.length > 0 && (
              <section className="vault-section">
                <div className="vault-section-head">
                  <h3 className="vault-section-title">
                    <Icon name="folder" size={14} />
                    分组
                  </h3>
                  <div className="vault-section-meta">
                    <span>共 {groupTiles.length} 个</span>
                  </div>
                </div>
                {view === "grid" ? (
                  <div className="vault-grid">{groupTiles.map((g) => groupCard(g))}</div>
                ) : (
                  <div className="vault-list">{groupTiles.map((g) => groupCard(g))}</div>
                )}
              </section>
            )}

            <section className="vault-section">
              <div className="vault-section-head">
                <h3 className="vault-section-title">主机</h3>
                <div className="vault-section-meta">
                  <span>{scopedHosts.length} 条</span>
                  <span className="vault-live-pill">
                    {activeSessionCount} 个在线
                  </span>
                </div>
              </div>

              {view === "tree" ? (
                atRoot ? (
                  <div className="vault-tree">
                    {treeSections.map((section) => (
                      <div className="vault-tree-group" key={section.id}>
                        <div className="vault-tree-head">
                          <Icon name="chevron-down" size={12} />
                          <Icon name="folder" size={14} />
                          <span>{section.name}</span>
                          <span className="nc-count">{section.hosts.length}</span>
                        </div>
                        {section.hosts.map((p) => hostCard(p))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="vault-tree">
                    {scopedHosts.map((p) => hostCard(p))}
                  </div>
                )
              ) : (
                hostCollection(scopedHosts)
              )}

              {profiles.length === 0 && (
                <div className="vault-empty">
                  <span className="vault-empty-icon">
                    <Icon name="grid" size={26} />
                  </span>
                  <h2>设置你的主机</h2>
                  <p>保存主机以快速连接到你的服务器、虚拟机和容器。</p>
                  <button className="vault-new-btn" onClick={openComposer}>
                    <Icon name="plus" size={14} />
                    新建主机
                  </button>
                </div>
              )}

              {profiles.length > 0 && scopedHosts.length === 0 && !quick && (
                <div className="vault-empty">
                  <span className="vault-empty-icon">
                    <Icon name={keyword ? "search" : "folder"} size={26} />
                  </span>
                  <h2>{keyword ? "没有匹配的主机" : "这个分组还没有主机"}</h2>
                  <p>
                    {keyword ? "换个关键词试试。" : "可在连接管理器中把主机移入此分组。"}
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>

        {composer && (
          <aside className="vault-composer" data-section="vault-composer">
            <header className="vault-composer-head">
              <div className="vault-composer-heading">
                <span className="vault-composer-title">新建主机</span>
                <span className="vault-composer-sub">保存后可在首页快速连接</span>
              </div>
              <button
                className="nc-icon-btn"
                title="关闭面板"
                onClick={() => setComposer(null)}
              >
                <Icon name="x" size={15} />
              </button>
            </header>

            <div className="vault-composer-body">
              {composerErr && <div className="vault-composer-err">{composerErr}</div>}
              <label>
                名称
                <input
                  value={composer.name}
                  placeholder="例如 生产 Web"
                  onChange={(e) =>
                    setComposer({ ...composer, name: e.target.value })
                  }
                />
              </label>
              <label>
                主机
                <input
                  value={composer.host}
                  placeholder="hostname 或 IP"
                  onChange={(e) =>
                    setComposer({ ...composer, host: e.target.value })
                  }
                />
              </label>
              <label>
                端口
                <input
                  value={composer.port}
                  inputMode="numeric"
                  onChange={(e) =>
                    setComposer({ ...composer, port: e.target.value })
                  }
                />
              </label>
              <label>
                凭据
                <select
                  value={composer.credential_id}
                  onChange={(e) =>
                    setComposer({ ...composer, credential_id: e.target.value })
                  }
                >
                  <option value="">请选择…</option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.username}）
                    </option>
                  ))}
                </select>
              </label>
              {credentials.length === 0 && (
                <button className="vault-composer-link" onClick={onOpenManager}>
                  还没有凭据，打开连接管理器创建
                </button>
              )}
              <label>
                分组
                <select
                  value={composer.group_id}
                  onChange={(e) =>
                    setComposer({ ...composer, group_id: e.target.value })
                  }
                >
                  <option value="">未分组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <footer className="vault-composer-foot">
              <button
                className="vault-secondary-btn"
                disabled={composerBusy}
                onClick={() => void saveComposer(false)}
              >
                保存
              </button>
              <button
                className="vault-new-btn"
                disabled={composerBusy}
                onClick={() => void saveComposer(true)}
              >
                保存并连接
              </button>
            </footer>
          </aside>
        )}
      </div>

      {ctxMenu && (
        <div
          className="term-context-menu vault-context-menu vault-popmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            onClick={() => {
              const p = ctxMenu.profile;
              setCtxMenu(null);
              onConnect(p);
            }}
          >
            <Icon name="terminal" size={14} />
            连接
          </button>
          <button disabled title="尚未实现">
            <Icon name="columns" size={14} />
            双栏 SFTP
          </button>
          <button disabled title="尚未实现">
            <Icon name="globe" size={14} />
            主机浏览器
          </button>
          <div className="term-menu-sep" />
          <button
            onClick={() => {
              const p = ctxMenu.profile;
              setCtxMenu(null);
              onEditProfile(p);
            }}
          >
            <Icon name="pencil" size={14} />
            编辑
          </button>
          <button
            onClick={() => {
              copyHostname(ctxMenu.profile);
              setCtxMenu(null);
            }}
          >
            <Icon name="copy" size={14} />
            复制主机名
          </button>
          <button disabled title="尚未实现">
            <Icon name="clipboard-paste" size={14} />
            复制账密信息
          </button>
          <button onClick={() => togglePin(ctxMenu.profile.id)}>
            <Icon name="pin" size={14} />
            {pinnedIds.includes(ctxMenu.profile.id) ? "取消置顶" : "置顶"}
          </button>
          <div className="term-menu-sep" />
          <button
            className="danger"
            onClick={() => {
              const p = ctxMenu.profile;
              setCtxMenu(null);
              void deleteHost(p);
            }}
          >
            <Icon name="trash" size={14} />
            删除
          </button>
        </div>
      )}
    </section>
  );
}
