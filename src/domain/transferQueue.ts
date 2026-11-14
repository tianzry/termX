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

/** 行尾「移除」：仅终态（已完成 / 失败 / 已取消 / 已跳过）。 */
export function canDismiss(status: TransferStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  );
}

/** 行尾「重试」：仅失败项（对齐 Netcatty failed → RefreshCw）。 */
export function canRetry(status: TransferStatus): boolean {
  return status === "failed";
}

/**
 * 终态里「无需再动作」的三态：完成 / 取消 / 跳过。
 * 会话存活与否对它们没有意义：切终端 tab 会关掉浏览用 SFTP 通道，队列中心
 * 随即回收 handle（只保留未终态项引用的），这三态行若仍渲染「会话已断开」
 * 红字就是误报（对齐后端 Status::is_terminal 中排除 failed 的子集——failed
 * 还要靠离线标注禁用重试）。
 */
export function isSettledStatus(status: TransferStatus): boolean {
  return (
    status === "completed" || status === "cancelled" || status === "skipped"
  );
}

/** 传输的「目标文件」绝对路径（上传=远端、下载=本地）。 */
export function transferTargetPath(item: TransferItem): string {
  return item.direction === "upload" ? item.remote_path : item.local_path;
}

/** 传输的「源文件」绝对路径。 */
export function transferSourcePath(item: TransferItem): string {
  return item.direction === "upload" ? item.local_path : item.remote_path;
}

/** 目录部分（同时兼容远端 "/" 与 Windows "\\"）。 */
export function parentPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return path;
  return norm.slice(0, i) || "/";
}

/** 目标目录（「打开目标目录」的落点，对齐 Netcatty getTransferTargetDirectory）。 */
export function transferTargetDir(item: TransferItem): string {
  return parentPath(transferTargetPath(item));
}

/** 传输显示用字节格式（对齐 Netcatty `formatTransferBytes`：1 位小数、无 TB）。 */
export function formatTransferBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 速率格式（对齐 Netcatty `formatSpeed`）。 */
export function formatTransferSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}

/**
 * 剩余时间估算（对齐 Netcatty）：剩余字节 <= 0 或速率 < 1KB/s 时返回 null，
 * 超过 48h 的离谱值也隐藏（避免速率抖动时闪出一个巨大数字）。
 */
export function estimateTransferEtaSeconds(
  remainingBytes: number,
  speedBytesPerSec: number,
): number | null {
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return null;
  if (!Number.isFinite(speedBytesPerSec) || speedBytesPerSec < 1024) return null;
  const seconds = Math.ceil(remainingBytes / speedBytesPerSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds > 48 * 3600) return null;
  return seconds;
}

/** 剩余时间文案（对齐 Netcatty `formatTransferEta`）。 */
export function formatTransferEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface SpeedSample {
  /** 采样时刻（毫秒，任意单调时钟，例如 performance.now()）。 */
  at: number;
  /** 累计已传字节。 */
  bytes: number;
}

/**
 * 滑动窗口平均速率（bytes/s）：窗口默认 3s，取窗口内最早样本的差分，
 * 至少需要 0.5s 跨度才给出结果（否则返回 0），避免前几帧速率乱跳。
 * 字节回退（续传偏移重排）视为无效样本返回 0。
 */
export function averageSpeed(samples: SpeedSample[], windowMs = 3000): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const cutoff = last.at - windowMs;
  let first = samples[samples.length - 2];
  for (const s of samples) {
    if (s.at >= cutoff) {
      first = s;
      break;
    }
  }
  const dt = (last.at - first.at) / 1000;
  if (dt < 0.5) return 0;
  const delta = last.bytes - first.bytes;
  if (delta <= 0) return 0;
  return delta / dt;
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
