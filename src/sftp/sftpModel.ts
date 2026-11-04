/**
 * SFTP 双栏视图的纯逻辑模型（路径拼接 / 主机选择器分区 / 连接流分支）。
 *
 * 与 Netcatty 的行为对齐点：
 * - 主机选择器三分区：本地（固定一行）→ 已连接（复用 SSH 会话）→ 主机
 *   （保存的 SSH 主机，排除 protocol=local；与已连接同 profile 的去重）；
 *   搜索无匹配且已连接也为空时显示「没有匹配的主机」。
 * - 连接流三分支：本地 / 复用已有 SSH 会话 / 独立连接。
 *
 * 本文件不做任何 I/O，全部可在 Vitest 里直接断言。
 */

import type { Profile } from "../backend/client";

export type SftpSide = "left" | "right";

// ── 主机 OS 判定（SFTP 标签 / 选择器图标用）────────────────

/** 主机操作系统。 */
export type HostOs = "windows" | "macos" | "linux" | "unknown";

/** 本机 OS 判定（Tauri webview 的 userAgent 含真实平台信息）。 */
export function detectLocalOs(): HostOs {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  return "unknown";
}

/** `uname -s` 输出 → OS；BSD 近似归 linux（最接近的通用映射）。 */
export function osFromUname(output: string): HostOs {
  const s = output.trim().toLowerCase();
  if (s.startsWith("linux")) return "linux";
  if (s.startsWith("darwin")) return "macos";
  if (s.includes("windows")) return "windows";
  if (s.includes("bsd")) return "linux";
  return "unknown";
}

/** OS → 图标名（icons.tsx 的 os-* 系列）；unknown 返回 null 走通用图标。 */
export function osIconName(
  os: HostOs,
): "os-windows" | "os-macos" | "os-linux" | null {
  switch (os) {
    case "windows":
      return "os-windows";
    case "macos":
      return "os-macos";
    case "linux":
      return "os-linux";
    default:
      return null;
  }
}

// ── 路径拼接 ─────────────────────────────────────────────

/** 远端（POSIX）路径拼接：根目录 "/" 特殊处理，去掉目录末尾多余 "/"。 */
export function joinRemotePath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** 远端父目录；已在根则返回自身（对齐 Netcatty「父路径与当前相同则不动作」）。 */
export function remoteParent(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/**
 * 本地（Windows 优先）路径拼接：兼容正反斜杠目录。
 * 盘符根 "C:\" → "C:\name"；普通目录追加 "\"。
 */
export function joinLocalPath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  return `${trimmed}\\${name}`;
}

/** 本地父目录：退到上一级；盘符根（"C:\"）返回自身。 */
export function localParent(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (idx < 0) return path;
  const parent = normalized.slice(0, idx);
  // 盘符根："C:" 形式补回斜杠，保持 "C:\"
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || path;
}

// ── 连接与标签 ───────────────────────────────────────────

/** 本地侧连接（无后端会话，直接走 local_* 命令）。 */
export interface LocalConnection {
  kind: "local";
  /** 标签名，固定「本地」。 */
  label: string;
  /** 当前路径（初始为主目录）。 */
  path: string;
  /** 本机 OS（标签图标用）。 */
  os: HostOs;
}

/** 远端侧连接（持有一个 sftp 会话 id）。 */
export interface RemoteConnection {
  kind: "remote";
  sftpId: string;
  /**
   * 是否持有可复用的 SSH exec 通道（由终端会话派生 = true，独立 SFTP 连接 = false）。
   * 远端原地解压等需要 exec 的功能据此隐藏入口，而不是点了才报错。
   */
  canExec: boolean;
  /** 标签名（主机名 / 会话名）。 */
  label: string;
  /** 右侧灰字说明（如 user@host）。 */
  meta: string;
  /** 当前路径（初始为主目录）。 */
  path: string;
  /** 远端 OS；未探测成功为 unknown（标签回落服务器图标）。 */
  os: HostOs;
}

export type PaneConnection = LocalConnection | RemoteConnection;

/** 一栏里的一个会话标签（骨架阶段每个 tab 必带连接）。 */
export interface SftpPaneTab {
  id: string;
  connection: PaneConnection;
}

// ── 主机选择器 ───────────────────────────────────────────

/** 已连接、可复用建 SFTP 的 SSH 会话。 */
export interface ConnectedHostEntry {
  sessionId: string;
  /** 显示名（终端标签名 / 主机名）。 */
  label: string;
  /** 右侧灰字（user@host 或会话说明）。 */
  meta: string;
  /** 若由保存主机连出，为其 profile id（用于「主机」分区去重）。 */
  profileId?: string;
  /** 已知的主机 OS（未知则缺省，行内回落到绿点）。 */
  os?: HostOs;
}

export type PickerItem =
  | { type: "local"; id: "local" }
  | { type: "connected"; id: string; entry: ConnectedHostEntry }
  | { type: "host"; id: string; profile: Profile };

export interface PickerSection {
  key: "local" | "connected" | "hosts";
  label: string;
  items: PickerItem[];
  /** hosts 分区无匹配时的占位提示（「没有匹配的主机」）。 */
  emptyHint?: string;
}

export const PICKER_LABELS = {
  local: "本地",
  connected: "已连接",
  hosts: "主机",
  localTitle: "本地文件系统",
  localDesc: "浏览本地文件",
  noMatch: "没有匹配的主机",
} as const;

function matches(term: string, ...fields: string[]): boolean {
  if (!term) return true;
  return fields.some((f) => f.toLowerCase().includes(term));
}

/**
 * 构建主机选择器分区（对齐 Netcatty SftpHostPicker 的取舍规则）：
 * - 「本地」恒显一行，不受搜索影响；
 * - 「已连接」仅在有匹配时显示；
 * - 「主机」排除 protocol=local 与已连接同 profile 的主机，按名称排序；
 * - 搜索词下已连接与主机都为空时，「主机」分区显示 noMatch 提示。
 */
export function buildPickerSections(opts: {
  term: string;
  connected: ConnectedHostEntry[];
  profiles: Profile[];
}): PickerSection[] {
  const term = opts.term.trim().toLowerCase();

  const sections: PickerSection[] = [
    {
      key: "local",
      label: PICKER_LABELS.local,
      items: [{ type: "local", id: "local" }],
    },
  ];

  const filteredConnected = opts.connected.filter((entry) =>
    matches(term, entry.label, entry.meta),
  );
  if (filteredConnected.length > 0) {
    sections.push({
      key: "connected",
      label: PICKER_LABELS.connected,
      items: filteredConnected.map((entry) => ({
        type: "connected",
        id: `connected:${entry.sessionId}`,
        entry,
      })),
    });
  }

  const connectedProfileIds = new Set(
    filteredConnected
      .map((entry) => entry.profileId)
      .filter((x): x is string => Boolean(x)),
  );
  const filteredHosts = opts.profiles
    .filter((p) => p.protocol !== "local")
    .filter((p) => !connectedProfileIds.has(p.id))
    .filter((p) => matches(term, p.name, p.host))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (filteredHosts.length > 0) {
    sections.push({
      key: "hosts",
      label: PICKER_LABELS.hosts,
      items: filteredHosts.map((profile) => ({
        type: "host",
        id: profile.id,
        profile,
      })),
    });
  } else if (filteredConnected.length === 0) {
    sections.push({
      key: "hosts",
      label: PICKER_LABELS.hosts,
      items: [],
      emptyHint: PICKER_LABELS.noMatch,
    });
  }

  return sections;
}

/** 键盘导航用的扁平条目序列（分区标题不入列）。 */
export function flattenPickerItems(sections: PickerSection[]): PickerItem[] {
  return sections.flatMap((s) => s.items);
}

// ── 连接流分支 ───────────────────────────────────────────

export type SftpConnectTarget =
  | { kind: "local" }
  | { kind: "session"; entry: ConnectedHostEntry }
  | { kind: "profile"; profile: Profile };

export type ConnectBranch = "local" | "reuse-session" | "standalone";

/** 选择目标 → 连接分支（本地 / 复用已有 SSH / 独立连接）。 */
export function connectBranch(target: SftpConnectTarget): ConnectBranch {
  switch (target.kind) {
    case "local":
      return "local";
    case "session":
      return "reuse-session";
    case "profile":
      return "standalone";
  }
}

/** 从选择器条目映射为连接目标。 */
export function pickerItemToTarget(item: PickerItem): SftpConnectTarget {
  switch (item.type) {
    case "local":
      return { kind: "local" };
    case "connected":
      return { kind: "session", entry: item.entry };
    case "host":
      return { kind: "profile", profile: item.profile };
  }
}

// ── 权限位（chmod 对话框）─────────────────────────────────

export interface PermGroup {
  read: boolean;
  write: boolean;
  execute: boolean;
}

/** 3×3 权限矩阵：owner/group/others × read/write/execute。 */
export interface PermMatrix {
  owner: PermGroup;
  group: PermGroup;
  others: PermGroup;
}

/** u32 权限位 → 3×3 矩阵（取低 9 位；P4：FileStat.permissions 是 u32）。 */
export function permsFromMode(mode: number): PermMatrix {
  const g = (shift: number): PermGroup => ({
    read: ((mode >> shift) & 0b100) !== 0,
    write: ((mode >> shift) & 0b010) !== 0,
    execute: ((mode >> shift) & 0b001) !== 0,
  });
  return { owner: g(6), group: g(3), others: g(0) };
}

const permBits = (g: PermGroup): number =>
  (g.read ? 4 : 0) | (g.write ? 2 : 0) | (g.execute ? 1 : 0);

/** 矩阵 → 八进制字符串（如 "640"，Netcatty 权限对话框的实时展示形态）。 */
export function permsToOctal(m: PermMatrix): string {
  return `${permBits(m.owner)}${permBits(m.group)}${permBits(m.others)}`;
}

/** 八进制字符串 → 供 sftpChmod 使用的 mode 数值；非法输入返回 null。 */
export function octalToMode(octal: string): number | null {
  if (!/^[0-7]{3,4}$/.test(octal)) return null;
  return Number.parseInt(octal, 8);
}

// ── 面包屑分段 / 根判定（对齐 Netcatty SftpBreadcrumb 语义）──

export interface BreadcrumbSegment {
  label: string;
  /** 点击该段应导航到的完整路径。 */
  path: string;
}

/**
 * Windows 风格路径：盘符（C:）或反斜杠 UNC（\\server\share）。
 * 纯 //host/share 按 POSIX 处理（远端约定；正斜杠在 POSIX 里是合法文件名字符，
 * 不能默认当 UNC）。
 */
export function isWindowsLikePath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}

/**
 * 路径的文件系统根（面包屑「回根」按钮用）：
 * POSIX → "/"；Windows → 盘符根（C:\）或 UNC 共享根（\\server\share）；
 * 无法导出根（如 Windows 相对路径）返回 null。
 */
export function pathRoot(path: string): string | null {
  if (!isWindowsLikePath(path)) return "/";
  const unc = path.match(/^\\\\([^\\]+)\\([^\\]+)/);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`;
  const drive = path.match(/^[A-Za-z]:/);
  return drive ? `${drive[0]}\\` : null;
}

/** 已在文件系统根（禁用面包屑根按钮）。 */
export function isPathRoot(path: string): boolean {
  if (!isWindowsLikePath(path)) return path === "/";
  const root = pathRoot(path);
  if (root === null) return false;
  return path.replace(/[\\/]+$/, "") === root.replace(/[\\/]+$/, "");
}

/**
 * 当前路径 → 面包屑分段（每段可点击，path 为该段的完整路径）：
 * - POSIX：按 "/" 分段，前缀 "/"（//host/share 形态保留 "//" 前缀）；
 * - Windows 盘符：首段为盘符（"C:" 显示，路径补 "C:\"），其余按斜杠分段；
 * - UNC：\\server\share 合并为单一首段，避免点进半截共享根。
 */
export function breadcrumbSegments(path: string): {
  segments: BreadcrumbSegment[];
  isWindowsDrive: boolean;
} {
  if (!isWindowsLikePath(path)) {
    const parts = path.split("/").filter(Boolean);
    const prefix = /^\/\/(?!\/)/.test(path) ? "//" : "/";
    return {
      segments: parts.map((part, i) => ({
        label: part,
        path: `${prefix}${parts.slice(0, i + 1).join("/")}`,
      })),
      isWindowsDrive: false,
    };
  }
  const unc = path.match(/^\\\\([^\\]+)\\([^\\]+)/);
  if (unc) {
    const root = `\\\\${unc[1]}\\${unc[2]}`;
    const rest = path.slice(root.length).replace(/^[\\/]+/, "");
    const restParts = rest ? rest.split(/[\\/]+/).filter(Boolean) : [];
    return {
      segments: [
        { label: root, path: root },
        ...restParts.map((part, i) => ({
          label: part,
          path: `${root}\\${restParts.slice(0, i + 1).join("\\")}`,
        })),
      ],
      isWindowsDrive: false,
    };
  }
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return {
    segments: parts.map((part, i) => {
      const built = parts.slice(0, i + 1).join("\\");
      return {
        label: part,
        path: /^[A-Za-z]:$/.test(built) ? `${built}\\` : built,
      };
    }),
    isWindowsDrive: true,
  };
}

export interface BreadcrumbVisiblePart {
  segment: BreadcrumbSegment;
  originalIndex: number;
}

/** 截断预算钳制为正整数（非法 / 小数 → 向下取整，最小 1）。 */
export function normalizeBreadcrumbBudget(maxVisibleParts: number): number {
  if (!Number.isFinite(maxVisibleParts)) return 1;
  return Math.max(1, Math.floor(maxVisibleParts));
}

/**
 * 面包屑截断（对齐 Netcatty resolveSftpBreadcrumbVisibleParts）：
 * 超长时保留首段（根 / 盘符恒可点）+ 尾部 budget-1 段，中间折叠进省略号；
 * budget=1 只显示首段。不超长原样返回。
 */
export function resolveBreadcrumbVisibleParts(opts: {
  segments: BreadcrumbSegment[];
  maxVisibleParts: number;
}): {
  visibleParts: BreadcrumbVisiblePart[];
  hiddenParts: BreadcrumbVisiblePart[];
  needsTruncation: boolean;
} {
  const budget = normalizeBreadcrumbBudget(opts.maxVisibleParts);
  const { segments } = opts;
  if (segments.length <= budget) {
    return {
      visibleParts: segments.map((segment, i) => ({
        segment,
        originalIndex: i,
      })),
      hiddenParts: [],
      needsTruncation: false,
    };
  }
  if (budget === 1) {
    return {
      visibleParts: [{ segment: segments[0], originalIndex: 0 }],
      hiddenParts: segments.slice(1).map((segment, i) => ({
        segment,
        originalIndex: i + 1,
      })),
      needsTruncation: true,
    };
  }
  const tailCount = budget - 1;
  const tail = segments.slice(-tailCount).map((segment, i) => ({
    segment,
    originalIndex: segments.length - tailCount + i,
  }));
  const hidden = segments.slice(1, -tailCount).map((segment, i) => ({
    segment,
    originalIndex: i + 1,
  }));
  return {
    visibleParts: [{ segment: segments[0], originalIndex: 0 }, ...tail],
    hiddenParts: hidden,
    needsTruncation: true,
  };
}

// ── 排序 / 隐藏过滤 / 格式化（对齐 Netcatty sortSftpEntries / filterHiddenFiles）──

export type SftpSortField = "name" | "size" | "modified" | "type";
export type SftpSortOrder = "asc" | "desc";

export interface SortableRow {
  name: string;
  isDir: boolean;
  size?: number;
  /** unix 秒；0 = 服务端未提供。 */
  mtime?: number;
}

/**
 * 列表排序：目录恒置顶（降序也只反转字段比较，不打散分组）；
 * 名称用 localeCompare，大小 / 时间用数值比较。
 */
export function sortSftpRows<T extends SortableRow>(
  rows: T[],
  field: SftpSortField,
  order: SftpSortOrder,
): T[] {
  if (rows.length === 0) return rows;
  return [...rows].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    switch (field) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "size":
        cmp = (a.size ?? 0) - (b.size ?? 0);
        break;
      case "modified":
        cmp = (a.mtime ?? 0) - (b.mtime ?? 0);
        break;
      case "type":
        cmp = rowTypeLabel(a).localeCompare(rowTypeLabel(b));
        break;
    }
    return order === "asc" ? cmp : -cmp;
  });
}

/** 隐藏判定：".." 永不隐藏；Windows hidden 属性或 Unix 点前缀（远端约定）。 */
export function isHiddenEntry(entry: { name: string; hidden?: boolean }): boolean {
  if (entry.name === "..") return false;
  if (entry.hidden === true) return true;
  return entry.name.startsWith(".");
}

/** 按开关过滤隐藏条目；showHidden 时原样返回（不做无谓拷贝）。 */
export function filterHiddenEntries<T extends { name: string; hidden?: boolean }>(
  entries: T[],
  showHidden: boolean,
): T[] {
  if (showHidden) return entries;
  return entries.filter((e) => !isHiddenEntry(e));
}

/** 名称过滤（对齐 Netcatty filterSftpEntriesByName）：大小写不敏感子串；
 *  空词返回原数组，避免每次输入产生无谓拷贝。 */
export function filterEntriesByName<T extends { name: string }>(
  entries: T[],
  term: string,
): T[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}

/** 类型列文案（对齐 Netcatty SftpFileRow）：目录 = folder，文件 = 扩展名；
 *  无扩展名用 "--"，与大小列的空值约定一致。 */
export function rowTypeLabel(row: { name: string; isDir: boolean }): string {
  if (row.isDir) return "folder";
  const dot = row.name.lastIndexOf(".");
  if (dot <= 0 || dot === row.name.length - 1) return "--";
  return row.name.slice(dot + 1).toLowerCase();
}

/** 文件大小格式化：0 / 缺省 → "--"；Bytes 无小数，其余保留两位。 */
export function formatEntrySize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "--";
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** mtime（unix 秒）→ "YYYY-MM-DD HH:mm"；0 / 无效 → "--"。 */
export function formatEntryMtime(epochSeconds: number | undefined): string {
  if (!epochSeconds) return "--";
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "--";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 跨栏拖放（阶段 B：拖拽入队传输队列；落点语义对齐 Netcatty）──

/** 跨栏拖放载荷的自定义 MIME（避免与 text/plain 等混淆）。 */
export const SFTP_DRAG_MIME = "application/x-termx-sftp";

/**
 * 拖拽来源侧标记（dragstart 时作为独立 type 写入）。
 * dataTransfer.types 在 dragover 阶段可读（值不可读），
 * 目标栏据此拒绝同侧拖拽（不 preventDefault → 系统 no-drop → 等价取消）。
 */
export const sftpDragSideMime = (side: "local" | "remote"): string =>
  `application/x-termx-sftp-side-${side}`;

/** 跨栏拖放载荷：dragstart 写入 dataTransfer，对面栏 drop 时解析。 */
export interface SftpDragPayload {
  /** 来源侧：local = 本地文件系统；remote = SFTP 会话。 */
  side: "local" | "remote";
  /** side=remote 时的会话 id（下载入队的 sftp_id 来源）。 */
  sftpId?: string;
  /** 被拖条目所在目录。 */
  fromPath: string;
  /** 条目名（拒绝路径分隔符 / . / ..）。 */
  names: string[];
}

function isValidDragName(n: unknown): n is string {
  return (
    typeof n === "string" &&
    n.length > 0 &&
    n !== "." &&
    n !== ".." &&
    !n.includes("/") &&
    !n.includes("\\")
  );
}

/** 解析并校验拖放载荷；任何非法形状返回 null（drop 忽略）。 */
export function parseSftpDragPayload(raw: string): SftpDragPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.side !== "local" && o.side !== "remote") return null;
  if (typeof o.fromPath !== "string" || o.fromPath.length === 0) return null;
  if (!Array.isArray(o.names) || o.names.length === 0) return null;
  if (!o.names.every(isValidDragName)) return null;
  if (o.side === "remote") {
    if (typeof o.sftpId !== "string" || o.sftpId.length === 0) return null;
    return {
      side: "remote",
      sftpId: o.sftpId,
      fromPath: o.fromPath,
      names: o.names,
    };
  }
  return { side: "local", fromPath: o.fromPath, names: o.names };
}

/**
 * 落点目录（Netcatty 语义）：
 * - 悬停在目录行 → 放进该目录；
 * - 空白处 / 文件行 / ".." → 栏当前路径。
 */
export function dropTargetPath(
  currentPath: string,
  hoverRow: { name: string; isDir: boolean } | null,
  join: (dir: string, name: string) => string,
): string {
  if (hoverRow && hoverRow.isDir && hoverRow.name !== "..") {
    return join(currentPath, hoverRow.name);
  }
  return currentPath;
}

/** drop 构建出的传输项（形状与 client.ts 的 NewTransferRequest 一致）。 */
export interface DropTransferTask {
  sftp_id: string;
  direction: "upload" | "download";
  local_path: string;
  remote_path: string;
}

/**
 * drop → 传输批次（统一走既有队列，冲突策略沿用阶段 C）：
 * - remote → local 栏 = 下载（sftp_id 取来源会话）；
 * - local → remote 栏 = 上传（sftp_id 取落点栏会话）；
 * - 同侧拖拽或缺少必需会话 id → null（不入队）。
 * 注：队列仅支持单文件传输（transfer_center 无目录递归），
 * 调用方不得传入目录条目。
 */
export function buildDropTransferTasks(opts: {
  payload: SftpDragPayload;
  destKind: "local" | "remote";
  destSftpId?: string;
  targetDir: string;
}): DropTransferTask[] | null {
  const { payload, destKind, destSftpId, targetDir } = opts;
  if (payload.side === destKind) return null;
  if (payload.side === "remote") {
    if (!payload.sftpId) return null;
    const sftpId = payload.sftpId;
    return payload.names.map((name) => ({
      sftp_id: sftpId,
      direction: "download" as const,
      local_path: joinLocalPath(targetDir, name),
      remote_path: joinRemotePath(payload.fromPath, name),
    }));
  }
  if (!destSftpId) return null;
  return payload.names.map((name) => ({
    sftp_id: destSftpId,
    direction: "upload" as const,
    local_path: joinLocalPath(payload.fromPath, name),
    remote_path: joinRemotePath(targetDir, name),
  }));
}

// ── 归档解压（#24） ─────────────────────────────────────

/** 与 Rust `sftp::archive::detect` 保持同一份后缀表（长后缀优先）。 */
const ARCHIVE_SUFFIXES = [
  ".tar.gz",
  ".tgz",
  ".tar.bz2",
  ".tbz2",
  ".tar.bzip2",
  ".tar.xz",
  ".txz",
  ".tar.zst",
  ".tzst",
  ".tar",
  ".zip",
  ".gz",
  ".bz2",
  ".xz",
] as const;

/** 文件名是否可解压（仅按后缀判断，不影响是否显示菜单项以外的逻辑）。 */
export function isExtractableArchive(name: string): boolean {
  const base = name.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => base.endsWith(suffix) && base.length > suffix.length);
}

/**
 * 「解压到当前目录」菜单项是否可见：远端原地解压走 SSH exec，
 * 独立 SFTP 连接没有 exec 通道，双向条件都满足才显示。
 */
export function canExtractArchive(connection: PaneConnection, name: string): boolean {
  return connection.kind === "remote" && connection.canExec && isExtractableArchive(name);
}
