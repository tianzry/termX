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
}

/** 远端侧连接（持有一个 sftp 会话 id）。 */
export interface RemoteConnection {
  kind: "remote";
  sftpId: string;
  /** 标签名（主机名 / 会话名）。 */
  label: string;
  /** 右侧灰字说明（如 user@host）。 */
  meta: string;
  /** 当前路径（初始为主目录）。 */
  path: string;
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
