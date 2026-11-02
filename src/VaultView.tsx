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
import { useVaultHostMarquee } from "./useVaultHostMarquee";

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
  /** 新建 / 删除后刷新 App 侧列表。 */
  onDataChanged: () => void;
}

type ViewMode = "grid" | "list" | "tree";
type SortMode =
  | "manual"
  | "az"
  | "za"
  | "newest"
  | "oldest"
  | "group"
  | "ip";
type ClickBehavior = "connect" | "select";

const VIEW_KEY = "termx.vault.view.v1";
const SORT_KEY = "termx.vault.sort.v1";
const PINNED_KEY = "termx.pinned.v1";
const SIDEBAR_W_KEY = "termx.vault.sidebar.v1";
const ORDER_KEY = "termx.vault.order.v1";
const TAGS_KEY = "termx.vault.tags.v1";
const CLICK_KEY = "termx.vault.click.v1";
const HOST_PANEL_W_KEY = "termx.vault.hostpanel.v1";
const SIDEBAR_MIN = 208;
const SIDEBAR_MAX = 320;
const HOST_PANEL_MIN = 320;
const HOST_PANEL_MAX = 520;

type GroupTile = { id: string; name: string; count: number };

type ComposerDraft = {
  /** 为空时是新建，有值时是编辑既有主机。 */
  id: string;
  name: string;
  host: string;
  port: string;
  credential_id: string;
  group_id: string;
  /** 逗号分隔，落 localStorage 的标签表。 */
  tags: string;
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

/** 新建主机下拉：本地终端、分组可用；导入 / 导出需后端支持，暂置灰。 */
const newHostMenu: Array<{ label: string; icon: IconName; enabled?: boolean }> = [
  { label: "本地终端（PTY）", icon: "terminal-square", enabled: true },
  { label: "新建分组", icon: "folder", enabled: true },
  { label: "导入主机", icon: "transfer" },
  { label: "导出主机", icon: "server" },
];

const SORT_LABEL: Record<SortMode, string> = {
  manual: "手动顺序",
  az: "名称 A → Z",
  za: "名称 Z → A",
  newest: "从新到旧",
  oldest: "从旧到新",
  group: "按分组",
  ip: "按 IP",
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
    if (v === "name-asc") return "az";
    if (v === "name-desc") return "za";
    if (v === "host-asc" || v === "host-desc") return "ip";
    return v && v in SORT_LABEL ? (v as SortMode) : "az";
  } catch {
    return "az";
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

function readOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

type TagMap = Record<string, string[]>;

function readTags(): TagMap {
  try {
    const raw = localStorage.getItem(TAGS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: TagMap = {};
    for (const [id, tags] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(tags)) {
        out[id] = tags.filter((t): t is string => typeof t === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

function readClickBehavior(): ClickBehavior {
  try {
    return localStorage.getItem(CLICK_KEY) === "select" ? "select" : "connect";
  } catch {
    return "connect";
  }
}

function clampPanelWidth(n: number): number {
  return Math.min(HOST_PANEL_MAX, Math.max(HOST_PANEL_MIN, n));
}

function readPanelWidth(): number {
  try {
    const n = Number(localStorage.getItem(HOST_PANEL_W_KEY));
    return Number.isFinite(n) && n > 0 ? clampPanelWidth(n) : 380;
  } catch {
    return 380;
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
  onDataChanged,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const [panelResizing, setPanelResizing] = useState(false);
  const panelResizeStart = useRef<{ x: number; width: number } | null>(null);

  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(readView);
  const [sort, setSort] = useState<SortMode>(readSort);
  const [viewMenu, setViewMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const [clickBehavior, setClickBehavior] =
    useState<ClickBehavior>(readClickBehavior);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [tagRename, setTagRename] = useState<{ from: string; value: string } | null>(
    null,
  );

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinned);
  const [order, setOrder] = useState<string[]>(readOrder);
  const [tags, setTags] = useState<TagMap>(readTags);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{
    profile: Profile;
    x: number;
    y: number;
  } | null>(null);
  const [groupCtx, setGroupCtx] = useState<{
    group: GroupTile;
    x: number;
    y: number;
  } | null>(null);
  const [tagEditor, setTagEditor] = useState<string | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupDialog, setGroupDialog] = useState<{
    id: string | null;
    name: string;
  } | null>(null);
  const [moveMenu, setMoveMenu] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);

  const {
    marqueeRect,
    onPointerDown: onMarqueePointerDown,
    onClickCapture: onMarqueeClickCapture,
  } = useVaultHostMarquee({
    containerRef: contentRef,
    viewMode: view,
    isMultiSelectMode: selectMode,
    selectedHostIds: selected,
    setIsMultiSelectMode: setSelectMode,
    setSelectedHostIds: setSelected,
  });

  const [composer, setComposer] = useState<ComposerDraft | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerErr, setComposerErr] = useState("");
  const [wizard, setWizard] = useState<{
    host: string;
    port: string;
    username: string;
    credential_id: string;
    name: string;
  } | null>(null);

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
    persist(ORDER_KEY, JSON.stringify(order));
  }, [order]);

  useEffect(() => {
    persist(TAGS_KEY, JSON.stringify(tags));
  }, [tags]);

  useEffect(() => {
    persist(CLICK_KEY, clickBehavior);
  }, [clickBehavior]);

  useEffect(() => {
    if (!collapsed) persist(SIDEBAR_W_KEY, String(sidebarWidth));
  }, [sidebarWidth, collapsed]);

  useEffect(() => {
    persist(HOST_PANEL_W_KEY, String(panelWidth));
  }, [panelWidth]);

  // 新出现的主机自动补进手动顺序表尾，保证「手动顺序 / 从新到旧」可用。
  useEffect(() => {
    setOrder((prev) => {
      const known = new Set(prev);
      const missing = profiles.map((p) => p.id).filter((id) => !known.has(id));
      return missing.length ? [...prev, ...missing] : prev;
    });
  }, [profiles]);

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

  // ── 右侧主机面板拖拽调宽 ────────────────────────────────

  useEffect(() => {
    if (!panelResizing) return;
    function onMove(e: PointerEvent) {
      const start = panelResizeStart.current;
      if (!start) return;
      setPanelWidth(clampPanelWidth(start.width - e.clientX + start.x));
    }
    function stop() {
      panelResizeStart.current = null;
      setPanelResizing(false);
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
  }, [panelResizing]);

  function startPanelResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    panelResizeStart.current = { x: e.clientX, width: panelWidth };
    setPanelResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // ── 弹出层关闭 ──────────────────────────────────────────

  const popupOpen =
    viewMenu ||
    sortMenu ||
    newMenu ||
    tagMenu ||
    moveMenu ||
    Boolean(ctxMenu) ||
    Boolean(groupCtx);

  useEffect(() => {
    if (!popupOpen) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (target?.closest(".vault-popmenu")) return;
      setViewMenu(false);
      setSortMenu(false);
      setNewMenu(false);
      setTagMenu(false);
      setMoveMenu(false);
      setCtxMenu(null);
      setGroupCtx(null);
      setTagRename(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setViewMenu(false);
      setSortMenu(false);
      setNewMenu(false);
      setTagMenu(false);
      setMoveMenu(false);
      setCtxMenu(null);
      setGroupCtx(null);
      setTagRename(null);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [popupOpen]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2200);
  }

  // ── 数据派生 ────────────────────────────────────────────

  const credById = new Map(credentials.map((c) => [c.id, c]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const keyword = query.trim().toLowerCase();
  const quick = parseQuickConnect(query);

  function subtitle(p: Profile): string {
    const username = credById.get(p.credential_id)?.username;
    return `${username ? `${username}@` : ""}${p.host}`;
  }

  function fullSubtitle(p: Profile): string {
    return `${subtitle(p)}:${p.port}`;
  }

  function orderRank(id: string): number {
    const i = order.indexOf(id);
    if (i >= 0) return i;
    return 100000 + profiles.findIndex((p) => p.id === id);
  }

  function ipRank(host: string): number {
    const parts = host.split(".");
    if (parts.length === 4 && parts.every((x) => /^\d{1,3}$/.test(x))) {
      return parts.reduce((acc, x) => acc * 256 + Number(x), 0);
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function sortHosts(list: Profile[]): Profile[] {
    const out = [...list];
    switch (sort) {
      case "za":
        return out.sort((a, b) => b.name.localeCompare(a.name, "zh-Hans-CN"));
      case "newest":
        return out.sort((a, b) => orderRank(b.id) - orderRank(a.id));
      case "oldest":
        return out.sort((a, b) => orderRank(a.id) - orderRank(b.id));
      case "group": {
        const groupName = (p: Profile) =>
          (p.group_id ? groupById.get(p.group_id)?.name : "") ?? "未分组";
        return out.sort(
          (a, b) =>
            groupName(a).localeCompare(groupName(b), "zh-Hans-CN") ||
            a.name.localeCompare(b.name, "zh-Hans-CN"),
        );
      }
      case "ip":
        return out.sort(
          (a, b) =>
            ipRank(a.host) - ipRank(b.host) || a.host.localeCompare(b.host),
        );
      case "manual":
        return out.sort((a, b) => orderRank(a.id) - orderRank(b.id));
      default:
        return out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    }
  }

  const allTagNames = Array.from(
    new Set(Object.values(tags).flatMap((list) => list)),
  ).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  // 识别为快速连接时，关键字不参与过滤：列表保持完整，另在顶部给出直连建议行。
  const filterKeyword = quick ? "" : keyword;
  const visible = profiles.filter((p) => {
    if (selectedTags.length) {
      const own = tags[p.id] ?? [];
      if (!selectedTags.every((t) => own.includes(t))) return false;
    }
    if (!filterKeyword) return true;
    const username = credById.get(p.credential_id)?.username?.toLowerCase() ?? "";
    return (
      p.name.toLowerCase().includes(filterKeyword) ||
      p.host.toLowerCase().includes(filterKeyword) ||
      String(p.port).includes(filterKeyword) ||
      username.includes(filterKeyword) ||
      (tags[p.id] ?? []).some((t) => t.toLowerCase().includes(filterKeyword))
    );
  });

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

  // 最近连接：按记录顺序，排除已置顶（避免与「已置顶」重复），最多 6 条。
  const recentProfiles = recentIds
    .filter((id) => id !== "__local" && !pinnedIds.includes(id))
    .map((id) => visible.find((p) => p.id === id))
    .filter((p): p is Profile => Boolean(p))
    .slice(0, 6);
  const showLocalRecently =
    recentIds.includes("__local") && (!keyword || "local".includes(keyword));

  const pinnedHosts = sortHosts(
    pinnedIds
      .map((id) => visible.find((p) => p.id === id))
      .filter((p): p is Profile => Boolean(p)),
  );

  const atRoot = activeGroupId === null;

  const switcherHosts = sortHosts(visible).filter((p) => {
    const q = switcherQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      (credById.get(p.credential_id)?.username ?? "").toLowerCase().includes(q)
    );
  });

  // ── 选择 / 置顶 / 删除 ──────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroupSelect(id: string) {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(scopedHosts.map((p) => p.id)));
    setSelectedGroups(
      new Set(
        atRoot && view !== "tree"
          ? groupTiles.filter((g) => g.id !== "__ungrouped").map((g) => g.id)
          : [],
      ),
    );
  }

  function clearSelection() {
    setSelected(new Set());
    setSelectedGroups(new Set());
  }

  function exitSelectMode() {
    setSelectMode(false);
    clearSelection();
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
    if (selected.size === 0 && selectedGroups.size === 0) return;
    const label = `删除选中的 ${selected.size} 台主机${
      selectedGroups.size ? `和 ${selectedGroups.size} 个分组` : ""
    }？`;
    if (!confirm(label)) return;
    try {
      for (const id of selected) await api.deleteProfile(id);
      for (const id of selectedGroups) await api.deleteGroup(id);
    } catch {
      /* 忽略单条失败，后续统一刷新 */
    }
    setPinnedIds((prev) => prev.filter((id) => !selected.has(id)));
    setTags((prev) => {
      const next = { ...prev };
      for (const id of selected) delete next[id];
      return next;
    });
    exitSelectMode();
    onDataChanged();
  }

  function duplicateHost(p: Profile) {
    const copy: Profile = {
      ...p,
      id: newId(),
      name: `${p.name} 副本`,
    };
    void api
      .createProfile(copy)
      .then(() => {
        setOrder((prev) => [...prev, copy.id]);
        onDataChanged();
        showToast("已创建主机副本");
      })
      .catch(() => showToast("复制失败"));
  }

  function copyHostname(p: Profile) {
    void navigator.clipboard?.writeText(p.host).catch(() => undefined);
    showToast("主机名已复制");
  }

  async function copyCredentials(p: Profile) {
    const cred = credById.get(p.credential_id);
    if (!cred) {
      showToast("该主机没有绑定凭据");
      return;
    }
    const username = cred.username || "(未设置用户名)";
    const secret =
      cred.type === "password" && cred.secret ? `\n密码：${cred.secret}` : "";
    try {
      await navigator.clipboard.writeText(
        `${username}@${p.host}:${p.port}${secret}`,
      );
      showToast("账密信息已复制");
    } catch {
      showToast("复制失败");
    }
  }

  function handleCardClick(p: Profile) {
    if (selectMode) {
      toggleSelect(p.id);
      return;
    }
    if (clickBehavior === "select" && focusId !== p.id) {
      setFocusId(p.id);
      return;
    }
    onConnect(p);
  }

  function handleCardKey(e: ReactKeyboardEvent<HTMLDivElement>, p: Profile) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (selectMode) toggleSelect(p.id);
    else onConnect(p);
  }

  function openContextMenu(e: ReactMouseEvent<HTMLDivElement>, p: Profile) {
    e.preventDefault();
    setCtxMenu({
      profile: p,
      x: Math.min(e.clientX, window.innerWidth - 216),
      y: Math.min(e.clientY, window.innerHeight - 380),
    });
  }

  function openGroupMenu(e: ReactMouseEvent<HTMLDivElement>, g: GroupTile) {
    e.preventDefault();
    if (g.id === "__ungrouped") return;
    setGroupCtx({
      group: g,
      x: Math.min(e.clientX, window.innerWidth - 216),
      y: Math.min(e.clientY, window.innerHeight - 200),
    });
  }

  async function moveHostsTo(ids: string[], groupId: string | null) {
    const targets = profiles.filter((p) => ids.includes(p.id));
    try {
      for (const p of targets) {
        await api.updateProfile({ ...p, group_id: groupId });
      }
      showToast(
        groupId
          ? `已移动 ${targets.length} 台主机到「${
              groupById.get(groupId)?.name ?? "分组"
            }」`
          : `已将 ${targets.length} 台主机移出分组`,
      );
    } catch {
      showToast("移动失败");
    }
    onDataChanged();
  }

  async function saveGroupDialog() {
    const d = groupDialog;
    if (!d) return;
    const name = d.name.trim();
    if (!name) return;
    try {
      if (d.id) {
        const target = groups.find((g) => g.id === d.id);
        if (target) await api.updateGroup({ ...target, name });
      } else {
        await api.createGroup({
          id: newId(),
          name,
          color: "#6ea8fe",
          sort_order: groups.length,
        });
      }
      setGroupDialog(null);
      onDataChanged();
    } catch {
      showToast("保存分组失败");
    }
  }

  async function deleteGroupById(id: string, name: string) {
    const count = profiles.filter((p) => p.group_id === id).length;
    const label = count
      ? `删除分组「${name}」？组内 ${count} 台主机将变为未分组。`
      : `删除分组「${name}」？`;
    if (!confirm(label)) return;
    try {
      await api.deleteGroup(id);
      if (activeGroupId === id) setActiveGroupId(null);
      setSelectedGroups((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      onDataChanged();
    } catch {
      showToast("删除分组失败");
    }
  }

  function setHostTags(id: string, next: string[]) {
    setTags((prev) => {
      const copy = { ...prev };
      if (next.length) copy[id] = next;
      else delete copy[id];
      return copy;
    });
  }

  function renameTag(from: string, to: string) {
    const name = to.trim();
    if (!name || name === from) {
      setTagRename(null);
      return;
    }
    setTags((prev) => {
      const next: TagMap = {};
      for (const [id, list] of Object.entries(prev)) {
        const replaced = list.map((t) => (t === from ? name : t));
        next[id] = Array.from(new Set(replaced));
      }
      return next;
    });
    setSelectedTags((prev) =>
      prev.map((t) => (t === from ? name : t)),
    );
    setTagRename(null);
  }

  function removeTag(tag: string) {
    setTags((prev) => {
      const next: TagMap = {};
      for (const [id, list] of Object.entries(prev)) {
        const rest = list.filter((t) => t !== tag);
        if (rest.length) next[id] = rest;
      }
      return next;
    });
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  }

  // ── 快速切换器 / 快速连接向导 ────────────────────────────

  function openQuickSwitcher() {
    setSwitcherQuery("");
    setSwitcher(true);
  }

  function connectFromSwitcher(p: Profile) {
    setSwitcher(false);
    onConnect(p);
  }

  function runQuickConnect() {
    if (!quick) {
      openQuickSwitcher();
      return;
    }
    const matched = credentials.find(
      (c) => c.username === quick.username,
    );
    setWizard({
      host: quick.host,
      port: String(quick.port),
      username: quick.username ?? (matched?.username ?? ""),
      credential_id: matched?.id ?? credentials[0]?.id ?? "",
      name: quick.username ? `${quick.username}@${quick.host}` : quick.host,
    });
  }

  async function saveWizard(andConnect: boolean) {
    const w = wizard;
    if (!w) return;
    if (!w.credential_id) {
      showToast("请先选择凭据，或到连接管理器创建");
      return;
    }
    const profile: Profile = {
      id: newId(),
      name: w.name.trim() || `${w.username || "user"}@${w.host}`,
      host: w.host,
      port: Number(w.port) || 22,
      credential_id: w.credential_id,
      bastion_profile_id: null,
      init_command: null,
      group_id:
        activeGroupId && activeGroupId !== "__ungrouped" ? activeGroupId : null,
    };
    try {
      await api.createProfile(profile);
      setOrder((prev) => [...prev, profile.id]);
      setWizard(null);
      setQuery("");
      onDataChanged();
      if (andConnect) onConnect(profile);
      else showToast("主机已保存");
    } catch {
      showToast("保存失败");
    }
  }

  // ── 拖拽归组 / 框选 / 键盘导航 ───────────────────────────

  function startHostDrag(
    e: React.DragEvent<HTMLElement>,
    p: Profile,
  ) {
    if (selectMode) {
      e.preventDefault();
      return;
    }
    const ids = selected.has(p.id) ? Array.from(selected) : [p.id];
    setDragIds(ids);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ids.join(","));
  }

  function endHostDrag() {
    setDragIds([]);
    setDropGroupId(null);
  }

  function allowDrop(e: React.DragEvent<HTMLElement>, groupId: string | null) {
    if (dragIds.length === 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropGroupId(groupId ?? "__root");
  }

  function dropOnGroup(e: React.DragEvent<HTMLElement>, groupId: string | null) {
    e.preventDefault();
    if (dragIds.length === 0) return;
    const ids = dragIds;
    endHostDrag();
    void moveHostsTo(ids, groupId);
  }

  function handleContentKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && selectMode) {
      exitSelectMode();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") {
      return;
    }
    const content = contentRef.current;
    if (!content) return;
    const cards = Array.from(
      content.querySelectorAll<HTMLElement>(".vault-host-card"),
    );
    if (cards.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const index = active ? cards.indexOf(active) : -1;
    e.preventDefault();
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const next = cards[Math.max(0, Math.min(cards.length - 1, index + step))] ?? cards[0];
    next.focus();
  }


  function openComposer() {
    setComposerErr("");
    setComposer({
      id: "",
      name: "",
      host: "",
      port: "22",
      credential_id: credentials[0]?.id ?? "",
      group_id: activeGroupId && activeGroupId !== "__ungrouped" ? activeGroupId : "",
      tags: "",
    });
    setNewMenu(false);
  }

  function openComposerForEdit(p: Profile) {
    setComposerErr("");
    setComposer({
      id: p.id,
      name: p.name,
      host: p.host,
      port: String(p.port),
      credential_id: p.credential_id,
      group_id: p.group_id ?? "",
      tags: (tags[p.id] ?? []).join(", "),
    });
    setCtxMenu(null);
  }

  function parseTags(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ).slice(0, 12);
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
    const parsedTags = parseTags(d.tags);
    const base: Profile = {
      id: d.id || newId(),
      name: d.name.trim(),
      host: d.host.trim(),
      port: Number(d.port) || 22,
      credential_id: d.credential_id,
      bastion_profile_id: null,
      init_command: null,
      group_id: d.group_id || null,
    };
    try {
      if (d.id) {
        const existing = profiles.find((p) => p.id === d.id);
        await api.updateProfile({
          ...base,
          bastion_profile_id: existing?.bastion_profile_id ?? null,
          init_command: existing?.init_command ?? null,
          algorithms: existing?.algorithms,
        });
      } else {
        await api.createProfile(base);
        setOrder((prev) => [...prev, base.id]);
      }
      setHostTags(base.id, parsedTags);
      setComposer(null);
      onDataChanged();
      if (andConnect) onConnect(base);
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
    const ownTags = tags[p.id] ?? [];
    return (
      <div
        key={p.id}
        data-nav-id={p.id}
        data-host-id={p.id}
        className={`vault-host-card${compact ? " list" : ""}${
          isSelected ? " selected" : ""
        }${focusId === p.id ? " focused" : ""}`}
        role={selectMode ? "checkbox" : "button"}
        aria-checked={selectMode ? isSelected : undefined}
        tabIndex={0}
        draggable={!selectMode}
        onDragStart={(e) => startHostDrag(e, p)}
        onDragEnd={endHostDrag}
        onFocus={() => setFocusId(p.id)}
        onClick={() => handleCardClick(p)}
        onKeyDown={(e) => handleCardKey(e, p)}
        onContextMenu={(e) => openContextMenu(e, p)}
        title={`${p.name} · ${fullSubtitle(p)}${
          ownTags.length ? ` · 标签：${ownTags.join("、")}` : ""
        }`}
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
          {ownTags.length > 0 && (
            <span className="vault-host-tags">
              {ownTags.slice(0, 3).map((t) => (
                <span key={t} className="vault-host-tag">
                  {t}
                </span>
              ))}
            </span>
          )}
        </span>
        {!selectMode && (
          <button
            className="vault-host-edit"
            title="编辑主机"
            onClick={(e) => {
              e.stopPropagation();
              openComposerForEdit(p);
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
    const isSelected = selectedGroups.has(g.id);
    const isDropTarget = dropGroupId === g.id;
    const editable = g.id !== "__ungrouped";
    return (
      <div
        key={g.id}
        data-nav-id={`group:${g.id}`}
        data-group-path={g.id}
        className={`vault-host-card vault-group-card${compact ? " list" : ""}${
          isSelected ? " selected" : ""
        }${isDropTarget ? " drop-target" : ""}`}
        role={selectMode ? "checkbox" : "button"}
        aria-checked={selectMode ? isSelected : undefined}
        tabIndex={0}
        onDragOver={editable ? (e) => allowDrop(e, g.id) : undefined}
        onDragLeave={() => setDropGroupId(null)}
        onDrop={editable ? (e) => dropOnGroup(e, g.id) : undefined}
        onClick={() => {
          if (selectMode) {
            if (editable) toggleGroupSelect(g.id);
            return;
          }
          setActiveGroupId(g.id);
          clearSelection();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          if (selectMode) {
            if (editable) toggleGroupSelect(g.id);
            return;
          }
          setActiveGroupId(g.id);
          clearSelection();
        }}
        onContextMenu={(e) => openGroupMenu(e, g)}
        title={`进入分组 ${g.name}`}
      >
        {selectMode && editable && (
          <span className="vault-host-check">
            <Icon name={isSelected ? "check-square" : "square"} size={18} />
          </span>
        )}
        <span className="nc-avatar lg group">
          <Icon name="folder" size={20} />
        </span>
        <span className="vault-host-card-main">
          <strong>{g.name}</strong>
          <span className="vault-host-card-sub">{g.count} 台主机</span>
        </span>
        {!selectMode && editable && (
          <button
            className="vault-host-edit"
            title="重命名分组"
            onClick={(e) => {
              e.stopPropagation();
              setGroupDialog({ id: g.id, name: g.name });
            }}
          >
            <Icon name="pencil" size={13} />
          </button>
        )}
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
          {!collapsed && (
            <button
              className="vault-collapse-btn"
              title="收起导航"
              onClick={() => setCollapsed(true)}
            >
              <Icon name="chevron-right" size={14} />
            </button>
          )}
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
              title={
                quick
                  ? `快速连接 ${quick.host}:${quick.port}`
                  : "打开快速切换器，按名称 / 主机快速定位主机"
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
                          clearSelection();
                          setViewMenu(false);
                        }}
                      >
                        <Icon name={viewIcon(m)} size={14} />
                        {m === "grid" ? "网格" : m === "list" ? "列表" : "树形"}
                      </button>
                    ))}
                    <div className="term-menu-sep" />
                    <button
                      className={clickBehavior === "connect" ? "active" : ""}
                      onClick={() => {
                        setClickBehavior("connect");
                        setViewMenu(false);
                      }}
                    >
                      <Icon name="terminal" size={14} />
                      单击直接连接
                    </button>
                    <button
                      className={clickBehavior === "select" ? "active" : ""}
                      onClick={() => {
                        setClickBehavior("select");
                        setViewMenu(false);
                      }}
                    >
                      <Icon name="check-square" size={14} />
                      单击先选中
                    </button>
                  </div>
                )}
              </div>
              <div className="vault-view-wrap">
                <button
                  className={`vault-icon-btn${selectedTags.length ? " active" : ""}`}
                  title={
                    selectedTags.length
                      ? `标签筛选：${selectedTags.join("、")}`
                      : "标签筛选"
                  }
                  onClick={() => {
                    setTagMenu((v) => !v);
                    setViewMenu(false);
                    setSortMenu(false);
                  }}
                >
                  <Icon name="tag" size={16} />
                  <Icon name="chevron-down" size={10} />
                </button>
                {tagMenu && (
                  <div className="vault-view-menu vault-tag-menu vault-popmenu">
                    <div className="vault-tag-search">
                      <Icon name="search" size={13} />
                      <input
                        value={tagQuery}
                        placeholder="搜索标签…"
                        onChange={(e) => setTagQuery(e.target.value)}
                      />
                    </div>
                    {(() => {
                      const filtered = allTagNames.filter((t) =>
                        t.toLowerCase().includes(tagQuery.trim().toLowerCase()),
                      );
                      if (filtered.length === 0) {
                        return (
                          <div className="vault-tag-empty">
                            暂无标签；可在主机右键菜单「标签…」里添加
                          </div>
                        );
                      }
                      return filtered.map((t) => (
                        <div className="vault-tag-row" key={t}>
                          {tagRename?.from === t ? (
                            <input
                              className="vault-tag-rename"
                              autoFocus
                              value={tagRename.value}
                              onChange={(e) =>
                                setTagRename({ from: t, value: e.target.value })
                              }
                              onBlur={() => renameTag(t, tagRename.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") renameTag(t, tagRename.value);
                                if (e.key === "Escape") setTagRename(null);
                              }}
                            />
                          ) : (
                            <>
                              <label className="vault-tag-check">
                                <input
                                  type="checkbox"
                                  checked={selectedTags.includes(t)}
                                  onChange={() =>
                                    setSelectedTags((prev) =>
                                      prev.includes(t)
                                        ? prev.filter((x) => x !== t)
                                        : [...prev, t],
                                    )
                                  }
                                />
                                <span>{t}</span>
                              </label>
                              <button
                                className="vault-tag-act"
                                title="重命名标签"
                                onClick={() => setTagRename({ from: t, value: t })}
                              >
                                <Icon name="pencil" size={12} />
                              </button>
                              <button
                                className="vault-tag-act"
                                title="删除标签"
                                onClick={() => removeTag(t)}
                              >
                                <Icon name="trash" size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      ));
                    })()}
                    {selectedTags.length > 0 && (
                      <button
                        className="vault-tag-clear"
                        onClick={() => setSelectedTags([])}
                      >
                        清空筛选（{selectedTags.length}）
                      </button>
                    )}
                  </div>
                )}
              </div>
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
                  if (selectMode) exitSelectMode();
                  else {
                    setSelectMode(true);
                    clearSelection();
                  }
                }}
              >
                <Icon name="check-square" size={16} />
              </button>
            </div>

            {/* 新建主机：主按钮 + 下拉（分体）；打开右侧面板时这组操作折叠 */}
            <div
              className={`vault-header-actions${composer ? " collapsed" : ""}`}
            >
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
                          if (item.label === "新建分组") {
                            setGroupDialog({ id: null, name: "" });
                          } else {
                            onLocal();
                          }
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
            </div>
          </header>

          {selectMode && (
            <div className="vault-select-bar">
              <span className="vault-select-count">
                已选 {selected.size} 台主机
                {selectedGroups.size > 0 && `和 ${selectedGroups.size} 个分组`}
              </span>
              <span className="vault-select-spacer" />
              <button onClick={selectAllVisible}>全选</button>
              <button onClick={clearSelection}>取消全选</button>
              <button
                disabled={selected.size === 0}
                onClick={() => {
                  profiles
                    .filter((p) => selected.has(p.id))
                    .forEach((p) => onConnect(p));
                }}
              >
                连接（{selected.size}）
              </button>
              <div className="vault-view-wrap">
                <button
                  disabled={selected.size === 0}
                  onClick={() => setMoveMenu((v) => !v)}
                >
                  移动到分组（{selected.size}）
                </button>
                {moveMenu && (
                  <div className="vault-view-menu vault-move-menu vault-popmenu">
                    <button
                      onClick={() => {
                        const ids = Array.from(selected);
                        setMoveMenu(false);
                        void moveHostsTo(ids, null);
                      }}
                    >
                      未分组
                    </button>
                    {groups.map((g) => (
                      <button
                        key={g.id}
                        onClick={() => {
                          const ids = Array.from(selected);
                          setMoveMenu(false);
                          void moveHostsTo(ids, g.id);
                        }}
                      >
                        <Icon name="folder" size={14} />
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="danger"
                disabled={selected.size === 0 && selectedGroups.size === 0}
                onClick={() => void deleteSelected()}
              >
                删除（{selected.size + selectedGroups.size}）
              </button>
              <button className="vault-select-close" title="关闭" onClick={exitSelectMode}>
                <Icon name="x" size={14} />
              </button>
            </div>
          )}

          <div
            className={`vault-content${marqueeRect ? " selecting" : ""}`}
            ref={contentRef}
            onPointerDown={onMarqueePointerDown}
            onClickCapture={onMarqueeClickCapture}
            onKeyDown={handleContentKeyDown}
          >
            {marqueeRect && (
              <div
                data-vault-marquee="true"
                aria-hidden="true"
                className="vault-marquee"
                style={{
                  left: marqueeRect.left,
                  top: marqueeRect.top,
                  width: marqueeRect.right - marqueeRect.left,
                  height: marqueeRect.bottom - marqueeRect.top,
                }}
              />
            )}
            {/* 面包屑：树视图隐藏；根节点同时作为拖拽归组的投放点 */}
            {view !== "tree" && (
              <div className="vault-breadcrumb">
                <button
                  className={`vault-all-hosts${
                    dropGroupId === "__root" ? " drop-target" : ""
                  }`}
                  title="全部主机（可拖拽主机到此移出分组）"
                  onClick={() => {
                    setActiveGroupId(null);
                    clearSelection();
                  }}
                  onDragOver={(e) => allowDrop(e, null)}
                  onDragLeave={() => setDropGroupId(null)}
                  onDrop={(e) => dropOnGroup(e, null)}
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
                  {view === "tree" && atRoot && treeSections.length > 0 && (
                    <div className="vault-tree-tools">
                      <button
                        className="vault-tree-tool"
                        title="展开全部"
                        onClick={() => setCollapsedGroups(new Set())}
                      >
                        <Icon name="chevron-down" size={13} />
                      </button>
                      <button
                        className="vault-tree-tool"
                        title="折叠全部"
                        onClick={() =>
                          setCollapsedGroups(
                            new Set(treeSections.map((s) => s.id)),
                          )
                        }
                      >
                        <Icon name="chevron-right" size={13} />
                      </button>
                    </div>
                  )}
                  <span>{scopedHosts.length} 条</span>
                  <span className="vault-live-pill">
                    {activeSessionCount} 个在线
                  </span>
                </div>
              </div>

              {view === "tree" ? (
                atRoot ? (
                  <div className="vault-tree">
                    {treeSections.map((section) => {
                      const isFolded = collapsedGroups.has(section.id);
                      return (
                        <div className="vault-tree-group" key={section.id}>
                          <div
                            className={`vault-tree-head${
                              dropGroupId === section.id ? " drop-target" : ""
                            }${
                              isFolded ? " folded" : ""
                            }`}
                            onClick={() =>
                              setCollapsedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(section.id)) next.delete(section.id);
                                else next.add(section.id);
                                return next;
                              })
                            }
                            onDragOver={
                              section.id !== "__ungrouped"
                                ? (e) => allowDrop(e, section.id)
                                : undefined
                            }
                            onDragLeave={() => setDropGroupId(null)}
                            onDrop={
                              section.id !== "__ungrouped"
                                ? (e) => dropOnGroup(e, section.id)
                                : undefined
                            }
                          >
                            <Icon
                              name={isFolded ? "chevron-right" : "chevron-down"}
                              size={12}
                            />
                            <Icon name="folder" size={14} />
                            <span>{section.name}</span>
                            <span className="nc-count">{section.hosts.length}</span>
                          </div>
                          {!isFolded && section.hosts.map((p) => hostCard(p))}
                        </div>
                      );
                    })}
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
          <>
            <div
              className="vault-composer-resizer"
              role="separator"
              aria-orientation="vertical"
              title="拖拽调整面板宽度"
              style={{ right: panelWidth }}
              onPointerDown={startPanelResize}
            />
            <aside
              className={`vault-composer${panelResizing ? " resizing" : ""}`}
              data-section="vault-composer"
              style={{ width: panelWidth }}
            >
            <header className="vault-composer-head">
              <div className="vault-composer-heading">
                <span className="vault-composer-title">
                  {composer.id ? "编辑主机" : "新建主机"}
                </span>
                <span className="vault-composer-sub">
                  {composer.id ? "修改后立即生效" : "保存后可在首页快速连接"}
                </span>
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
              <label>
                标签
                <input
                  value={composer.tags}
                  placeholder="逗号分隔，例如 生产, 数据库"
                  onChange={(e) =>
                    setComposer({ ...composer, tags: e.target.value })
                  }
                />
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
          </>
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
              openComposerForEdit(p);
            }}
          >
            <Icon name="pencil" size={14} />
            编辑
          </button>
          <button
            onClick={() => {
              const p = ctxMenu.profile;
              setCtxMenu(null);
              duplicateHost(p);
            }}
          >
            <Icon name="copy" size={14} />
            复制副本
          </button>
          <button
            onClick={() => {
              copyHostname(ctxMenu.profile);
              setCtxMenu(null);
            }}
          >
            <Icon name="server" size={14} />
            复制主机名
          </button>
          <button
            onClick={() => {
              const p = ctxMenu.profile;
              setCtxMenu(null);
              void copyCredentials(p);
            }}
          >
            <Icon name="clipboard-paste" size={14} />
            复制账密信息
          </button>
          <button
            onClick={() => {
              const p = ctxMenu.profile;
              setCtxMenu(null);
              setTagEditor(p.id);
            }}
          >
            <Icon name="tag" size={14} />
            标签…
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

      {groupCtx && (
        <div
          className="term-context-menu vault-context-menu vault-popmenu"
          style={{ left: groupCtx.x, top: groupCtx.y }}
        >
          <button
            disabled
            title="termX 分组暂为单层，暂不支持子分组"
          >
            <Icon name="folder" size={14} />
            新建子分组
          </button>
          <button
            onClick={() => {
              const g = groupCtx.group;
              setGroupCtx(null);
              setGroupDialog({ id: g.id, name: g.name });
            }}
          >
            <Icon name="pencil" size={14} />
            分组设置
          </button>
          <div className="term-menu-sep" />
          <button
            className="danger"
            onClick={() => {
              const g = groupCtx.group;
              setGroupCtx(null);
              void deleteGroupById(g.id, g.name);
            }}
          >
            <Icon name="trash" size={14} />
            删除分组
          </button>
        </div>
      )}

      {tagEditor && (
        <div className="vault-tag-editor vault-popmenu" data-section="tag-editor">
          <div className="vault-tag-editor-head">
            <span>标签</span>
            <button
              className="nc-icon-btn"
              title="关闭"
              onClick={() => setTagEditor(null)}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
          {(() => {
            const id = tagEditor;
            const own = tags[id] ?? [];
            return (
              <>
                {allTagNames.length === 0 && (
                  <p className="vault-tag-editor-hint">
                    还没有标签，直接输入新标签后回车。
                  </p>
                )}
                <div className="vault-tag-editor-list">
                  {allTagNames.map((t) => (
                    <label key={t} className="vault-tag-check">
                      <input
                        type="checkbox"
                        checked={own.includes(t)}
                        onChange={() =>
                          setHostTags(
                            id,
                            own.includes(t)
                              ? own.filter((x) => x !== t)
                              : [...own, t],
                          )
                        }
                      />
                      <span>{t}</span>
                    </label>
                  ))}
                </div>
                <input
                  className="vault-tag-editor-input"
                  placeholder="新标签，回车添加"
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const value = e.currentTarget.value.trim();
                    if (!value) return;
                    if (!own.includes(value)) setHostTags(id, [...own, value]);
                    e.currentTarget.value = "";
                  }}
                />
              </>
            );
          })()}
        </div>
      )}

      {switcher && (
        <div className="vault-modal-mask" onClick={() => setSwitcher(false)}>
          <div
            className="vault-switcher"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="vault-switcher-head">
              <Icon name="search" size={14} />
              <input
                autoFocus
                value={switcherQuery}
                placeholder="快速切换主机…"
                onChange={(e) => setSwitcherQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSwitcher(false);
                  if (e.key === "Enter" && switcherHosts[0]) {
                    connectFromSwitcher(switcherHosts[0]);
                  }
                }}
              />
              <span className="vault-switcher-hint">Esc</span>
            </div>
            <div className="vault-switcher-list">
              {switcherHosts.length === 0 && (
                <div className="vault-switcher-empty">没有匹配的主机</div>
              )}
              {switcherHosts.slice(0, 40).map((p) => (
                <button
                  key={p.id}
                  onClick={() => connectFromSwitcher(p)}
                >
                  <span className="nc-avatar sm" style={avatarStyle(p.name)}>
                    {initial(p.name)}
                  </span>
                  <span className="vault-switcher-main">
                    <strong>{p.name}</strong>
                    <span>{fullSubtitle(p)}</span>
                  </span>
                  <Icon name="terminal" size={13} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {wizard && (
        <div className="vault-modal-mask" onClick={() => setWizard(null)}>
          <div
            className="vault-wizard"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="vault-wizard-head">
              <span>快速连接</span>
              <button
                className="nc-icon-btn"
                title="关闭"
                onClick={() => setWizard(null)}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="vault-wizard-body">
              <p className="vault-wizard-target">
                <Icon name="zap" size={14} />
                {wizard.host}:{wizard.port}
              </p>
              <label>
                保存名称
                <input
                  value={wizard.name}
                  onChange={(e) => setWizard({ ...wizard, name: e.target.value })}
                />
              </label>
              <label>
                用户名
                <input
                  value={wizard.username}
                  placeholder="root"
                  onChange={(e) =>
                    setWizard({ ...wizard, username: e.target.value })
                  }
                />
              </label>
              <label>
                端口
                <input
                  value={wizard.port}
                  inputMode="numeric"
                  onChange={(e) =>
                    setWizard({ ...wizard, port: e.target.value })
                  }
                />
              </label>
              <label>
                凭据
                <select
                  value={wizard.credential_id}
                  onChange={(e) =>
                    setWizard({ ...wizard, credential_id: e.target.value })
                  }
                >
                  <option value="">请选择…</option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.username}
                      {c.type === "password" ? " · 密码" : c.type === "key" ? " · 私钥" : ""})
                    </option>
                  ))}
                </select>
              </label>
              {credentials.length === 0 && (
                <button className="vault-composer-link" onClick={onOpenManager}>
                  还没有凭据，先到连接管理器创建
                </button>
              )}
            </div>
            <footer className="vault-wizard-foot">
              <button
                className="vault-secondary-btn"
                onClick={() => void saveWizard(false)}
              >
                保存为主机
              </button>
              <button className="vault-new-btn" onClick={() => void saveWizard(true)}>
                保存并连接
              </button>
            </footer>
          </div>
        </div>
      )}

      {groupDialog && (
        <div className="vault-modal-mask" onClick={() => setGroupDialog(null)}>
          <div
            className="vault-group-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span>{groupDialog.id ? "分组设置" : "新建分组"}</span>
              <button
                className="nc-icon-btn"
                title="关闭"
                onClick={() => setGroupDialog(null)}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <input
              autoFocus
              value={groupDialog.name}
              placeholder="分组名称"
              onChange={(e) =>
                setGroupDialog({ ...groupDialog, name: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveGroupDialog();
                if (e.key === "Escape") setGroupDialog(null);
              }}
            />
            <footer>
              <button
                className="vault-secondary-btn"
                onClick={() => setGroupDialog(null)}
              >
                取消
              </button>
              <button className="vault-new-btn" onClick={() => void saveGroupDialog()}>
                保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {toast && <div className="vault-toast">{toast}</div>}
    </section>
  );
}
