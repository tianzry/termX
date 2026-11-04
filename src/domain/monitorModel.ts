/**
 * 主机监控纯逻辑：点历史、趋势几何与格式化。
 * 所有"缺数据"一律返回 null / "--"，不补零、不臆造。
 */

import type { MonitorSample } from "../backend/client";

export interface MonitorPoint {
  at: number;
  cpu: number | null;
  memory: number | null;
  rx: number | null;
  tx: number | null;
}

export type TrendField = "cpu" | "memory" | "rx" | "tx";

export interface TrendSegment {
  path: string;
  x: number;
  y: number;
  firstX: number;
}

export interface TrendGeometry {
  segments: TrendSegment[];
  max: number;
  start: number;
  end: number;
}

/** 从一次采样追加一个点；按时间范围裁剪，最多保留 300 个点。 */
export function appendPoint(
  points: MonitorPoint[],
  sample: MonitorSample,
  rangeSecs: number,
  at?: number,
): MonitorPoint[] {
  const time = at ?? sample.sampled_at_ms ?? Date.now();
  const memory =
    sample.mem_total_mb && sample.mem_total_mb > 0 && sample.mem_used_mb != null
      ? (sample.mem_used_mb / sample.mem_total_mb) * 100
      : null;
  const next = [
    ...points,
    {
      at: time,
      cpu: sample.supported ? sample.cpu : null,
      memory: sample.supported ? memory : null,
      rx: sample.supported ? sample.net_rx_speed : null,
      tx: sample.supported ? sample.net_tx_speed : null,
    },
  ].filter((p) => p.at >= time - rangeSecs * 1000);
  return next.slice(-300);
}

/**
 * 构造趋势折线。缺口（null 或超过 3 个采样间隔）断开成多段，
 * 与 Netcatty "不要跨缺失采样连线"的规则一致。
 */
export function buildTrendGeometry(
  points: MonitorPoint[],
  field: TrendField,
  rangeSecs: number,
  nowMs: number,
  intervalSec: number,
  width = 300,
  height = 64,
): TrendGeometry {
  const end = nowMs;
  const start = end - rangeSecs * 1000;
  const visible = points
    .filter((p) => p.at >= start && p.at <= end && p[field] != null)
    .sort((a, b) => a.at - b.at);
  const max =
    field === "cpu" || field === "memory"
      ? 100
      : Math.max(1, ...visible.map((p) => p[field] as number)) * 1.1;
  const gapLimit = Math.max(1, intervalSec) * 3000;
  const segments: TrendSegment[] = [];
  let path = "";
  let firstX = 0;
  let lastAt = 0;
  let lastX = 0;
  let lastY = 0;
  for (const point of visible) {
    const value = point[field] as number;
    const x = ((point.at - start) / Math.max(1, end - start)) * width;
    const y = height - 6 - (Math.min(max, Math.max(0, value)) / max) * (height - 12);
    if (path && point.at - lastAt > gapLimit) {
      segments.push({ path, x: lastX, y: lastY, firstX });
      path = "";
    }
    if (!path) {
      path = `M ${x.toFixed(2)} ${y.toFixed(2)}`;
      firstX = x;
    } else {
      path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    lastAt = point.at;
    lastX = x;
    lastY = y;
  }
  if (path) segments.push({ path, x: lastX, y: lastY, firstX });
  return { segments, max, start, end };
}

export function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : `${value.toFixed(1)}%`;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "--";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = Math.max(0, bytesPerSec);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** 累计流量（输入字节），不带 /s。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** 内存 / 容量（输入 MiB）。 */
export function formatCapacity(mib: number | null | undefined): string {
  if (mib == null || !Number.isFinite(mib)) return "--";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${mib.toFixed(0)} MiB`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "--";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

export function formatClock(ms: number | null | undefined): string {
  if (!ms) return "--";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}
