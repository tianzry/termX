// 会话日志页的纯逻辑：asciicast 解析、时长 / 大小格式化、筛选 / 排序、
// 导出文件名。无 React、无 IO，方便单测（对齐 domain 层约定）。
import type { SessionLog } from "../backend/client";

export interface AsciicastSummary {
  text: string;
  eventCount: number;
  durationMs: number;
  width: number;
  height: number;
}

/**
 * 解析 asciicast v2：首行 header JSON，之后每行 `[elapsed, "o", chunk]`。
 * 坏行 / 非 UTF-8 已被后端读成字符串时同样跳过；ANSI 原样保留，不解释。
 */
export function parseAsciicast(content: string): AsciicastSummary {
  const summary: AsciicastSummary = {
    text: "",
    eventCount: 0,
    durationMs: 0,
    width: 0,
    height: 0,
  };
  let sawHeader = false;

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      !sawHeader &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      sawHeader = true;
      const header = value as Record<string, unknown>;
      summary.width = Number(header.width) || 0;
      summary.height = Number(header.height) || 0;
      continue;
    }
    if (!Array.isArray(value) || value.length < 3) continue;
    if (typeof value[0] === "number" && Number.isFinite(value[0])) {
      summary.durationMs = Math.round(value[0] * 1000);
    }
    if (value[1] === "o" && typeof value[2] === "string") {
      summary.text += value[2];
      summary.eventCount += 1;
    }
  }
  return summary;
}

/** 秒级时长：<1s → "0s"；<60s → "12s"；<1h → "3m 05s"；否则 "2h 14m"。 */
export function formatLogDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (totalSeconds < 1) return "0s";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** 文件大小：B / KiB / MiB，非 B 单位保留 1 位小数。 */
export function formatLogSize(bytes: number): string {
  const value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (value < 1024) return `${Math.floor(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export interface SessionLogFilter {
  query?: string;
  host?: string;
}

/** query 匹配 文件名 / title / host_name / status（大小写不敏感）；host 精确匹配。 */
export function filterSessionLogs(
  logs: SessionLog[],
  filter: SessionLogFilter,
): SessionLog[] {
  const query = (filter.query ?? "").trim().toLowerCase();
  const host = filter.host ?? "";
  return logs.filter((log) => {
    if (
      query &&
      ![log.path, log.title, log.host_name, log.status]
        .join(" ")
        .toLowerCase()
        .includes(query)
    ) {
      return false;
    }
    if (host && log.host_name !== host) return false;
    return true;
  });
}

/**
 * 列表首行标题：默认记录的 title 由文件名派生，与 host_name 相同，再显示一遍就是冗余；
 * 只有自定义标题（与主机名不同）才返回，空标题不显示。徽标已移除。
 */
export function sessionLogItemTitle(log: SessionLog): string | null {
  const title = log.title.trim();
  if (!title) return null;
  return title === log.host_name.trim() ? null : title;
}

/** 主机名去重（忽略空值）并排序。 */
export function collectLogHosts(logs: SessionLog[]): string[] {
  const hosts = new Set<string>();
  for (const log of logs) {
    const host = log.host_name.trim();
    if (host) hosts.add(host);
  }
  return Array.from(hosts).sort((a, b) => a.localeCompare(b));
}

/** 表格可排序列：时间 / 时长 / 大小 / 会话名。 */
export type SessionLogSortKey = "time" | "duration" | "size" | "name";
export type SessionLogSortDirection = "asc" | "desc";

function logLabel(log: SessionLog): string {
  return log.path.trim() || log.host_name.trim() || log.title.trim();
}

/** 按指定列排序；同值用 id 升序兜底，不修改入参。 */
export function sortSessionLogsBy(
  logs: SessionLog[],
  key: SessionLogSortKey,
  direction: SessionLogSortDirection,
): SessionLog[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...logs].sort((a, b) => {
    let cmp = 0;
    if (key === "duration") cmp = a.duration_ms - b.duration_ms;
    else if (key === "size") cmp = a.size_bytes - b.size_bytes;
    else if (key === "name") cmp = logLabel(a).localeCompare(logLabel(b));
    else cmp = a.started_at - b.started_at;
    return cmp ? cmp * dir : a.id.localeCompare(b.id);
  });
}

/** started_at 倒序，id 升序兜底；不修改入参。 */
export function sortSessionLogs(logs: SessionLog[]): SessionLog[] {
  return sortSessionLogsBy(logs, "time", "desc");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function timestampName(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 导出文件名：`<host或title>_<YYYYmmdd_HHMMSS>.<format>`；非法字符换 `_`。 */
export function sessionLogExportName(
  log: SessionLog,
  format: "cast" | "txt" | "html",
): string {
  const raw = log.host_name.trim() || log.title.trim() || "session";
  const safe =
    raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "session";
  return `${safe}_${timestampName(log.started_at || Date.now())}.${format}`;
}

/** 列表时间：今天 HH:mm，否则 MM-DD HH:mm。 */
export function formatLogTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
