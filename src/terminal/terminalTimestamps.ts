/**
 * 终端输出行时间戳的纯逻辑（对照 Netcatty
 * `components/terminal/TerminalTimestampGutter.tsx` +
 * `components/terminal/runtime/terminalLineTimestamps.ts`）。
 *
 * Netcatty 语义：
 * - 时间戳是左侧独立 gutter 列（不写入终端内容），宽 ≥56px、右对齐、
 *   等宽数字，颜色取主题 brightCyan；格式 `HH:mm:ss`（不含日期）；
 * - 每条新输出行在写入时打一个时间（同一行后续输出不重复更新）；
 * - 只对正常缓冲区显示，进入 alternate screen（vim/top）时整列隐藏；
 * - 软换行（wrapped）的续行不重复打时间；
 * - 行时间随开关打开后才开始记录，关闭立即清空、不残留。
 *
 * 行号重映射：字号 / 窗口尺寸变化会触发 xterm reflow，绝对 buffer 行号
 * 会被重排。因此每条时间戳同时持有一个 xterm marker，绘制时以 marker.line
 * 为准（xterm 在 scrollback 裁剪与 reflow 时会同步更新 marker.line）；
 * 没有 marker 的条目在列数变化后不可信，直接丢弃（与 Netcatty 一致）。
 */

export const TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH = 56;
export const TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING = 16;
export const TERMINAL_TIMESTAMP_SAMPLE_LABEL = "88:88:88";

const pad2 = (value: number): string => value.toString().padStart(2, "0");

/** `HH:mm:ss`（本地时间，24 小时制）。 */
export function formatTerminalTimestamp(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * gutter 宽度：按终端字号测量 `88:88:88` 的文本宽度 + 16px 内边距，
 * 但最小 56px；无测量值时按 0.62em 估算（Netcatty 同公式）。
 */
export function resolveTerminalTimestampGutterWidth({
  measuredTextWidth,
  fontSize = 12,
}: {
  measuredTextWidth?: number;
  fontSize?: number;
}): number {
  const safeFont = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 12;
  const textWidth =
    measuredTextWidth !== undefined && measuredTextWidth > 0
      ? measuredTextWidth
      : safeFont * TERMINAL_TIMESTAMP_SAMPLE_LABEL.length * 0.62;
  return Math.ceil(
    Math.max(
      TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH,
      textWidth + TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING,
    ),
  );
}

/** xterm marker 的结构化子集：`line` 随 scrollback 裁剪 / reflow 自动更新。 */
export interface TerminalTimestampMarker {
  line: number;
  isDisposed: boolean;
  dispose?: () => void;
}

export interface TerminalTimestampStamp {
  /** 打点时的绝对 buffer 行号；存在存活 marker 时以 marker.line 为准。 */
  line: number;
  label: string;
  marker?: TerminalTimestampMarker;
}

export interface TerminalTimestampRow {
  /** 相对 gutter 顶部的视觉行号。 */
  row: number;
  label: string;
}

/** 时间戳实际对应的行：优先存活 marker 的实时行号，否则退回打点行号。 */
export function resolveTerminalTimestampStampLine(
  stamp: TerminalTimestampStamp,
): number {
  const marker = stamp.marker;
  if (marker && !marker.isDisposed) {
    const line = marker.line;
    if (Number.isFinite(line) && line >= 0) return Math.floor(line);
  }
  return stamp.line;
}

/**
 * 每次 writeParsed 时要打时间的行（`(previousAbsolute, currentAbsolute]`，
 * 跳过软换行续行）。返回行号列表，由调用方负责创建 marker。
 */
export function collectTerminalTimestampLines(input: {
  previousAbsolute: number;
  currentAbsolute: number;
  isWrapped: (absoluteLine: number) => boolean;
}): number[] {
  const lines: number[] = [];
  for (
    let line = Math.max(0, input.previousAbsolute) + 1;
    line <= input.currentAbsolute;
    line += 1
  ) {
    if (!input.isWrapped(line)) lines.push(line);
  }
  return lines;
}

/**
 * 原地重映射 / 清理时间戳：
 * - marker 已随 scrollback 裁剪被销毁 → 丢弃；
 * - 存活 marker → 把 `line` 同步为 marker.line（reflow 后行号被 xterm 更新）；
 * - `dropUnanchored`（列数变化即 reflow 时）→ 没有 marker 的行号不再可信，丢弃。
 */
export function normalizeTerminalTimestampStamps(
  stamps: TerminalTimestampStamp[],
  options: { dropUnanchored?: boolean } = {},
): void {
  let write = 0;
  for (let read = 0; read < stamps.length; read += 1) {
    const stamp = stamps[read];
    const marker = stamp.marker;
    if (marker) {
      if (marker.isDisposed) continue;
      const line = resolveTerminalTimestampStampLine(stamp);
      if (line !== stamp.line) stamp.line = line;
    } else if (options.dropUnanchored) {
      continue;
    }
    stamps[write] = stamp;
    write += 1;
  }
  stamps.length = write;
}

/** 清理已滚出 scrollback 的时间戳，避免长会话无界增长（同时释放 marker）。 */
export function pruneTerminalTimestampStamps(
  stamps: TerminalTimestampStamp[],
  minimumLine: number,
): void {
  let write = 0;
  for (let read = 0; read < stamps.length; read += 1) {
    const stamp = stamps[read];
    const line = resolveTerminalTimestampStampLine(stamp);
    if (line < minimumLine) {
      if (stamp.marker && !stamp.marker.isDisposed) stamp.marker.dispose?.();
      continue;
    }
    stamps[write] = stamp;
    write += 1;
  }
  stamps.length = write;
}

/**
 * 当前视口内要显示的时间戳行。`viewportY` 是视口顶部所在的绝对 buffer 行
 * （xterm 语义），行号取自 marker 的实时值（reflow 安全）。
 */
export function resolveVisibleTerminalTimestampRows(input: {
  stamps: readonly TerminalTimestampStamp[];
  viewportY: number;
  rows: number;
  isWrapped: (absoluteLine: number) => boolean;
}): TerminalTimestampRow[] {
  if (input.stamps.length === 0 || input.rows <= 0) return [];
  const labelByLine = new Map<number, string>();
  for (const stamp of input.stamps) {
    const line = resolveTerminalTimestampStampLine(stamp);
    if (line >= 0) labelByLine.set(line, stamp.label);
  }

  const result: TerminalTimestampRow[] = [];
  for (let row = 0; row < input.rows; row += 1) {
    const line = input.viewportY + row;
    if (input.isWrapped(line)) continue;
    const label = labelByLine.get(line);
    if (label) result.push({ row, label });
  }
  return result;
}
