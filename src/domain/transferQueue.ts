/**
 * 传输队列展示模型（纯逻辑，无 IO；对齐 Netcatty SftpTransferQueue 的
 * 展示子集）。排序 / 计数 / 按钮可用性 / 字节与进度格式化均可测（R11）。
 */

import type {
  TransferItem,
  TransferStatus,
} from "../backend/client";

/** 展示名：上传取本地文件名，下载取远端文件名（兼容正反斜杠）。 */
export function transferDisplayName(item: TransferItem): string {
  const p = item.direction === "upload" ? item.local_path : item.remote_path;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 展示分组序：进行中在前（running > conflict > paused > queued），终态在后。 */
const GROUP_ORDER: Record<TransferStatus, number> = {
  running: 0,
  conflict: 1,
  paused: 2,
  queued: 3,
  completed: 4,
  failed: 4,
  cancelled: 4,
  skipped: 4,
};

const PRIORITY_RANK: Record<TransferItem["priority"], number> = {
  low: 0,
  normal: 1,
  high: 2,
};

/**
 * 展示排序（不改变后端调度顺序）：
 * 活跃组内按优先级降序、seq 升序；终态组按 seq 升序（完成先后）。
 */
export function sortQueueForDisplay(items: TransferItem[]): TransferItem[] {
  return [...items].sort((a, b) => {
    const ga = GROUP_ORDER[a.status];
    const gb = GROUP_ORDER[b.status];
    if (ga !== gb) return ga - gb;
    if (ga < 4) {
      const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (byPriority !== 0) return byPriority;
    }
    return a.seq - b.seq;
  });
}

/**
 * 全局传输中心分类（对照 Netcatty `GlobalTransferBucket`）：
 * active=运行中，queued=排队中，paused=已暂停，attention=需要处理（冲突 /
 * 失败），completed=已完成（含取消 / 跳过等终态）。
 */
export type TransferBucket =
  | "all"
  | "active"
  | "queued"
  | "paused"
  | "attention"
  | "completed";

export function transferBucket(
  status: TransferStatus,
): Exclude<TransferBucket, "all"> {
  if (status === "running") return "active";
  if (status === "queued") return "queued";
  if (status === "paused") return "paused";
  if (status === "conflict" || status === "failed") return "attention";
  return "completed";
}

/** 按分类筛选；all 返回浅拷贝（不修改调用方数据）。 */
export function bucketTransferItems(
  items: TransferItem[],
  bucket: TransferBucket,
): TransferItem[] {
  if (bucket === "all") return [...items];
  return items.filter((item) => transferBucket(item.status) === bucket);
}

/**
 * 顶栏传输按钮徽标（对照 Netcatty `getGlobalTransferBadge`）：
 * - count = 未完成条数（排队 / 运行 / 暂停 / 待处理冲突）；
 * - hasAttention = 存在冲突或失败项（按钮显示红点）。
 * 已完成 / 已取消 / 已跳过只作为历史记录，不进徽标。
 */
export function transferBadge(items: TransferItem[]): {
  count: number;
  hasAttention: boolean;
} {
  let count = 0;
  let hasAttention = false;
  for (const item of items) {
    if (item.status === "conflict") {
      count += 1;
      hasAttention = true;
    } else if (item.status === "failed") {
      hasAttention = true;
    } else if (
      item.status === "running" ||
      item.status === "queued" ||
      item.status === "paused"
    ) {
      count += 1;
    }
  }
  return { count, hasAttention };
}

export function queueCounts(items: TransferItem[]): {
  active: number;
  finished: number;
} {
  let active = 0;
  let finished = 0;
  for (const item of items) {
    if (GROUP_ORDER[item.status] < 4) active += 1;
    else finished += 1;
  }
  return { active, finished };
}

/** 暂停按钮：排队中（直接置 Paused）或运行中（取消 + 记 Paused，恢复重传）。 */
export function canPause(status: TransferStatus): boolean {
  return status === "queued" || status === "running";
}

export function canResume(status: TransferStatus): boolean {
  return status === "paused";
}

export function canCancel(status: TransferStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "paused" ||
    status === "conflict"
  );
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 0 / 负数 = 未知大小 → 空串（不定长进度条不显示字节）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const text = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1);
  return `${text} ${BYTE_UNITS[i]}`;
}

/** 进度百分比；total <= 0 = 不定长返回 null。 */
export function progressPercent(
  transferred: number,
  total: number,
): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = (Math.max(0, transferred) / total) * 100;
  return Math.min(100, pct);
}

/**
 * 当前应弹框处理的冲突：取展示序第一个 conflict 项（阶段 C 对话框）。
 * `sameBatchCount` = 同批 conflict 总数（含当前项），供「应用到全部」计数，
 * 对位 Netcatty sameTypeConflictCount。
 */
export function pickActiveConflict(items: TransferItem[]): {
  conflict: TransferItem;
  sameBatchCount: number;
} | null {
  const conflicts = items.filter((i) => i.status === "conflict");
  if (conflicts.length === 0) return null;
  const conflict = sortQueueForDisplay(conflicts)[0];
  const sameBatchCount = conflicts.filter(
    (i) => i.batch_id === conflict.batch_id,
  ).length;
  return { conflict, sameBatchCount };
}
