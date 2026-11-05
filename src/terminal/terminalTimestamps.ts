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

export interface TerminalTimestampRow {
  /** 相对 gutter 顶部的视觉行号。 */
  row: number;
  label: string;
}

/**
 * 当前视口内要显示的时间戳行。`stamps` 以绝对 buffer 行号为 key，
 * `viewportY` 是视口顶部所在的绝对 buffer 行（xterm 语义）。
 */
export function resolveVisibleTerminalTimestampRows(input: {
  stamps: ReadonlyMap<number, string>;
  viewportY: number;
  rows: number;
  isWrapped: (absoluteLine: number) => boolean;
}): TerminalTimestampRow[] {
  const result: TerminalTimestampRow[] = [];
  for (let row = 0; row < input.rows; row += 1) {
    const line = input.viewportY + row;
    if (input.isWrapped(line)) continue;
    const label = input.stamps.get(line);
    if (label) result.push({ row, label });
  }
  return result;
}

/**
 * 每次 writeParsed 时把新产生的行打上当前时间，返回新的“最后已知行”。
 * `previousAbsolute` 初始应设为当前光标绝对行，保证打开开关后只记录新行。
 */
export function stampTerminalTimestampLines(input: {
  stamps: Map<number, string>;
  previousAbsolute: number;
  currentAbsolute: number;
  label: string;
  isWrapped: (absoluteLine: number) => boolean;
}): number {
  for (
    let line = input.previousAbsolute + 1;
    line <= input.currentAbsolute;
    line += 1
  ) {
    if (!input.isWrapped(line)) input.stamps.set(line, input.label);
  }
  return input.currentAbsolute;
}

/** 清理已滚出 scrollback 的时间戳，避免长会话无界增长。 */
export function pruneTerminalTimestampLines(
  stamps: Map<number, string>,
  minimumLine: number,
): void {
  for (const line of stamps.keys()) {
    if (line < minimumLine) stamps.delete(line);
  }
}
