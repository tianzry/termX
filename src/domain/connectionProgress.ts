/**
 * 连接进度算法（逐字移植自 netcatty/components/terminal/connectionProgress.ts）。
 *
 * - 拨号阶段按固定比例缓慢推进，封顶 95%；
 * - 多跳链路按 hop/total 映射到 10%~90%；
 * - 所有进度只增不减，避免重连时进度条回退。
 */

export const CONNECTION_PROGRESS_START = 5;
export const CONNECTION_PROGRESS_CAP = 95;

export const advanceIndeterminateConnectionProgress = (prev: number): number => {
  if (prev >= CONNECTION_PROGRESS_CAP) return prev;
  const remaining = CONNECTION_PROGRESS_CAP - prev;
  const increment = Math.max(1, remaining * 0.15);
  return Math.min(CONNECTION_PROGRESS_CAP, prev + increment);
};

export const resolveHopConnectionProgress = (hop: number, total: number): number => {
  const safeTotal = Math.max(1, total);
  const safeHop = Math.max(0, hop);
  return Math.min(CONNECTION_PROGRESS_CAP, (safeHop / safeTotal) * 80 + 10);
};

export const advanceMonotonicConnectionProgress = (prev: number, next: number): number =>
  Math.max(prev, next);
