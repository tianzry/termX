/**
 * 命令历史的纯逻辑 + 本地持久化（对照 Netcatty
 * `application/state/commandHistoryStore.ts`、`domain/globalHistory.ts`、
 * `components/HistorySidePanel.tsx`）。
 *
 * Netcatty 取证要点：
 * - 来源：用户在终端里回车提交的命令（多行粘贴执行时按一条命令记录），
 *   串口 / Telnet 终端同样计入；
 * - 持久化：localStorage（非数据库），跨重启保留；本地全局历史按
 *   命令 + 主机去重（再次执行时更新时间并前移），默认最多 500 条；
 * - 面板：标题 + 搜索（命令 / 主机）+ 「本主机 / 全部」范围切换 + 清空；
 *   行内显示命令（11px 等宽、单行截断）与主机名（全局范围），点击展开
 *   完整命令 + 时间 + 主机；行内/详情提供「运行 / 插入 / 删除」；
 * - 点击行本身只展开，不执行；运行与插入是两个独立按钮。
 *
 * 本模块无 React、无副作用（localStorage 读写集中在文件底部）。
 */
export const COMMAND_HISTORY_STORAGE_KEY = "termx.commandHistory.v1";
export const COMMAND_HISTORY_CHANGED_EVENT = "termx:command-history-changed";
export const COMMAND_HISTORY_MAX = 500;

import type { Connector } from "../workspaceModel";

/**
 * 历史分桶用的稳定主机标识：只取连接参数，不取标签标题。
 * 非 SSH 终端重命名标签后仍落到同一个桶（标题只用于展示）。
 */
export function resolveCommandHistoryHostId(connector: Connector): string {
  switch (connector.kind) {
    case "ssh":
      return connector.profileId;
    case "pty":
      return [
        "local",
        connector.shell ?? "",
        (connector.args ?? []).join(" "),
        connector.startDir ?? "",
      ].join(":");
    case "serial":
      return `serial:${connector.session.port}`;
    case "telnet":
      return `telnet:${connector.session.host}:${connector.session.port}`;
  }
}

export interface CommandHistoryEntry {
  id: string;
  command: string;
  hostId: string;
  hostLabel: string;
  /** 最近一次执行时间（毫秒）。 */
  timestamp: number;
  /** 累计执行次数（去重后递增）。 */
  count: number;
}

export type CommandHistoryScope = "host" | "all";

/** 回车提交内容 → 历史命令：去掉行尾 CR/LF 与首尾空白，空命令不记录。 */
export function normalizeHistoryCommand(raw: string): string | null {
  const command = raw.replace(/[\r\n]+$/g, "").trim();
  return command.length > 0 ? command : null;
}

/**
 * 追加一条命令：同主机同命令去重（更新时间、次数 +1、移到最前），
 * 新命令插入最前；总数裁剪到 `max`。
 */
export function appendCommandHistory(
  entries: readonly CommandHistoryEntry[],
  input: {
    command: string;
    hostId: string;
    hostLabel: string;
    timestamp: number;
    id: string;
  },
  max = COMMAND_HISTORY_MAX,
): CommandHistoryEntry[] {
  const command = normalizeHistoryCommand(input.command);
  if (!command) return [...entries];
  const existing = entries.find(
    (entry) => entry.command === command && entry.hostId === input.hostId,
  );
  if (existing) {
    return [
      {
        ...existing,
        timestamp: input.timestamp,
        count: existing.count + 1,
      },
      ...entries.filter((entry) => entry.id !== existing.id),
    ].slice(0, Math.max(1, max));
  }
  return [
    {
      id: input.id,
      command,
      hostId: input.hostId,
      hostLabel: input.hostLabel,
      timestamp: input.timestamp,
      count: 1,
    },
    ...entries,
  ].slice(0, Math.max(1, max));
}

/** 按范围 + 搜索过滤（命令 / 主机名，大小写不敏感）。 */
export function filterCommandHistory(
  entries: readonly CommandHistoryEntry[],
  options: {
    query: string;
    scope: CommandHistoryScope;
    hostId: string;
  },
): CommandHistoryEntry[] {
  const q = options.query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (options.scope === "host" && entry.hostId !== options.hostId) {
      return false;
    }
    if (!q) return true;
    return (
      entry.command.toLowerCase().includes(q) ||
      entry.hostLabel.toLowerCase().includes(q)
    );
  });
}

/** 解析存储内容：容错非法 JSON / 字段缺失，按时间倒序。 */
export function parseCommandHistory(raw: string | null): CommandHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: CommandHistoryEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string") continue;
      if (typeof record.command !== "string" || !record.command.trim()) continue;
      if (typeof record.hostId !== "string") continue;
      entries.push({
        id: record.id,
        command: record.command,
        hostId: record.hostId,
        hostLabel:
          typeof record.hostLabel === "string" ? record.hostLabel : record.hostId,
        timestamp:
          typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
            ? record.timestamp
            : 0,
        count:
          typeof record.count === "number" && record.count > 0
            ? Math.floor(record.count)
            : 1,
      });
    }
    return entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, COMMAND_HISTORY_MAX);
  } catch {
    return [];
  }
}

/** 详情里的时间显示（对齐 Netcatty `toLocaleString()`）。 */
export function formatCommandHistoryTime(timestamp: number): string {
  if (!timestamp) return "";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

// ── localStorage 读写（仅浏览器环境；测试可通过参数注入）──

export function readCommandHistory(): CommandHistoryEntry[] {
  try {
    return parseCommandHistory(
      window.localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function writeCommandHistory(entries: readonly CommandHistoryEntry[]): void {
  try {
    window.localStorage.setItem(
      COMMAND_HISTORY_STORAGE_KEY,
      JSON.stringify(entries),
    );
  } catch {
    // 存储不可用时仅本次生效。
  }
}

/** 记录一条命令并派发变更事件（面板/其它窗格据此刷新）。 */
export function recordCommandHistory(input: {
  command: string;
  hostId: string;
  hostLabel: string;
  id: string;
}): void {
  const entries = appendCommandHistory(readCommandHistory(), {
    ...input,
    timestamp: Date.now(),
  });
  writeCommandHistory(entries);
  try {
    window.dispatchEvent(new CustomEvent(COMMAND_HISTORY_CHANGED_EVENT));
  } catch {
    // 非浏览器环境忽略。
  }
}

export function deleteCommandHistoryEntry(id: string): void {
  writeCommandHistory(readCommandHistory().filter((entry) => entry.id !== id));
  try {
    window.dispatchEvent(new CustomEvent(COMMAND_HISTORY_CHANGED_EVENT));
  } catch {
    // 忽略。
  }
}

export function clearCommandHistory(): void {
  writeCommandHistory([]);
  try {
    window.dispatchEvent(new CustomEvent(COMMAND_HISTORY_CHANGED_EVENT));
  } catch {
    // 忽略。
  }
}
