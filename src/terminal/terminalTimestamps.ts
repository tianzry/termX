/**
 * 终端输出行时间戳的纯逻辑（对齐 Netcatty
 * `components/terminal/runtime/terminalLineTimestamps.ts` +
 * `components/terminal/TerminalTimestampGutter.tsx`）。
 *
 * Netcatty 的关键机制：
 * - 打点发生在**写入时**（`writeTerminalDataWithSecondLedger`），不是写完后按行号
 *   差值扫描：字符分段器在「行首出现可打印字符」时打一个时间戳。因此提示符、
 *   命令回显、多行输出的每一行都会在行首拿到打点机会；
 * - 同一秒最多一个打点（`tryBeginSecondStamp`），其余行由 gutter **填充式绘制**
 *   （fill-forward：每个可见行取 ≤ 该行的最新打点）覆盖，所以看起来“每行都有”；
 * - 只对正常缓冲区生效，alternate screen（vim/top）整列隐藏；
 * - 打点行使 xterm marker 锚定，marker.line 随 reflow / scrollback 裁剪自动更新；
 * - 状态按 xterm 实例隔离（Netcatty 用 WeakMap），分屏两侧互不共享；
 * - gutter 右缘用 `box-shadow: inset -0.5px 0 0 color-mix(... 8% ...)` 画细分隔线。
 */

export const TERMINAL_TIMESTAMP_GUTTER_MIN_WIDTH = 56;
export const TERMINAL_TIMESTAMP_GUTTER_HORIZONTAL_PADDING = 16;
export const TERMINAL_TIMESTAMP_DIVIDER_WIDTH = 0.5;
export const TERMINAL_TIMESTAMP_SAMPLE_LABEL = "88:88:88";
/** 与 Netcatty 上界一致：避免长会话中 marker 数量无界增长。 */
export const TERMINAL_TIMESTAMP_MAX_STAMPS = 4096;
/**
 * 跨 chunk 缓存的未完成控制串上限（对齐 Netcatty
 * `MAX_INCOMPLETE_TERMINAL_CONTROL_SEQUENCE_CHARS`）：收到永不终止的
 * OSC / DCS 时不能每次写入都把整段前缀重新拼接重扫，超限即放弃缓存。
 */
export const TERMINAL_TIMESTAMP_MAX_PENDING_ESCAPE = 64 * 1024;

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

/**
 * gutter 右缘细分隔线：Netcatty 用 foreground 8% 的 0.5px inset shadow，
 * 贯穿 gutter 全高（含空白区），随滚动一起移动。
 */
export function resolveTerminalTimestampDividerShadow(foreground: string): string {
  return `inset -${TERMINAL_TIMESTAMP_DIVIDER_WIDTH}px 0 0 color-mix(in srgb, ${foreground} 8%, transparent)`;
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

/**
 * 字符分段器状态（Netcatty `createTerminalLineTimestampSegmenter` 的精简版）：
 * `atLineStart` 表示光标在行首，`currentLineStamped` 保证同一物理行只打一次，
 * 回车重绘（`\r`）不会重复打点；`alternateActive` 在 vim/top 等全屏程序中
 * 暂停打点（进入/离开由数据流里的 CSI ?1049h/l 检测）。
 */
export interface TerminalTimestampSegmenterState {
  atLineStart: boolean;
  currentLineStamped: boolean;
  pendingEscape: string;
  alternateActive: boolean;
}

export function createTerminalTimestampSegmenterState(): TerminalTimestampSegmenterState {
  return {
    atLineStart: true,
    currentLineStamped: false,
    pendingEscape: "",
    alternateActive: false,
  };
}

const STRING_TERMINATOR = "\u009c";
const isCsiFinalByte = (char: string): boolean => char >= "@" && char <= "~";

/** 读取从 `startIndex` 起的 ESC 序列；不完整时由调用方缓存到下一 chunk。 */
function readEscapeSequence(
  data: string,
  startIndex: number,
): { sequence: string; endIndex: number; complete: boolean } | null {
  if (data[startIndex] !== "\u001b") return null;
  const next = data[startIndex + 1];
  if (!next) {
    return { sequence: "\u001b", endIndex: startIndex, complete: false };
  }
  if (next === "[") {
    for (let index = startIndex + 2; index < data.length; index += 1) {
      if (isCsiFinalByte(data[index])) {
        return { sequence: data.slice(startIndex, index + 1), endIndex: index, complete: true };
      }
    }
    return { sequence: data.slice(startIndex), endIndex: data.length - 1, complete: false };
  }
  if (next === "]" || next === "P" || next === "^" || next === "_" || next === "X") {
    // OSC / DCS / PM / APC / SOS：BEL 或 ST（ESC \ / U+009C）结束。
    for (let index = startIndex + 2; index < data.length; index += 1) {
      const ch = data[index];
      if (ch === "\u0007" || ch === STRING_TERMINATOR) {
        return { sequence: data.slice(startIndex, index + 1), endIndex: index, complete: true };
      }
      if (ch === "\u001b" && data[index + 1] === "\\") {
        return { sequence: data.slice(startIndex, index + 2), endIndex: index + 1, complete: true };
      }
    }
    return { sequence: data.slice(startIndex), endIndex: data.length - 1, complete: false };
  }
  return { sequence: data.slice(startIndex, startIndex + 2), endIndex: startIndex + 1, complete: true };
}

/** CSI ?47/1047/1049 h/l：进入 / 离开备用屏幕。 */
function getAlternateScreenAction(sequence: string): "enter" | "leave" | null {
  if (!sequence.startsWith("\u001b[")) return null;
  const final = sequence[sequence.length - 1];
  if (final !== "h" && final !== "l") return null;
  const params = sequence.slice(2, -1);
  if (!params.startsWith("?")) return null;
  const modes = params
    .slice(1)
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter((mode) => Number.isFinite(mode));
  if (!modes.some((mode) => mode === 47 || mode === 1047 || mode === 1049)) return null;
  return final === "h" ? "enter" : "leave";
}

const isPrintableOutput = (char: string): boolean => {
  if (char === "\t") return true;
  const code = char.codePointAt(0);
  return (
    code !== undefined &&
    code >= 0x20 &&
    code !== 0x7f &&
    (code < 0x80 || code > 0x9f)
  );
};

/** 近似 wcwidth：CJK / emoji 占两列（Netcatty 用 xterm unicodeService，拿不到时降级）。 */
const isWideCodePoint = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe10 && code <= 0xfe19) ||
  (code >= 0xfe30 && code <= 0xfe6f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x1f300 && code <= 0x1faff) ||
  (code >= 0x20000 && code <= 0x3fffd);

/**
 * 组合符 / 变体选择符 / ZWJ 等零宽码点：宽度按 0 计，避免含重音或 emoji 组合的
 * 长行被多算一列、软换行行号偏一行（Netcatty 用 unicodeService.wcwidth）。
 */
const isZeroWidthCodePoint = (code: number): boolean =>
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x1ab0 && code <= 0x1aff) ||
  (code >= 0x1dc0 && code <= 0x1dff) ||
  (code >= 0x20d0 && code <= 0x20ff) ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xfe20 && code <= 0xfe2f) ||
  code === 0x200b ||
  code === 0x200c ||
  code === 0x200d ||
  code === 0x2060;

/**
 * 推进一列的列号 / 行号（软换行感知，对齐 Netcatty `advanceMeasuredColumns`）。
 * 行号增量用于把打点位置换算成绝对行，避免长行换行后打点串行。
 */
function advanceColumn(
  column: number,
  rowOffset: number,
  width: number,
  columns: number,
  wraparoundMode: boolean,
): { column: number; rowOffset: number } {
  if (!Number.isFinite(columns) || columns <= 0) return { column, rowOffset };
  if (!wraparoundMode) return { column: Math.min(columns, column + width), rowOffset };
  let row = rowOffset;
  let nextColumn = column;
  if (nextColumn + width > columns) {
    row += 1;
    nextColumn = 0;
  }
  nextColumn += width;
  while (nextColumn > columns) {
    row += 1;
    nextColumn -= columns;
  }
  return { column: nextColumn, rowOffset: row };
}

/** 回到行首 / 新行时重置分段器（Netcatty `resetLineState`）。 */
const resetSegmenterLineState = (state: TerminalTimestampSegmenterState): void => {
  state.atLineStart = true;
  state.currentLineStamped = false;
};

/**
 * 纯 ASCII + CR/LF/TAB/BS 的快速判定（对照 Netcatty `isSimpleAsciiControlText`）：
 * 命中时不走 ESC 解析与 Unicode 宽度估算，洪水输出（`seq` / `cat`）成本大幅降低。
 */
export function isSimpleAsciiControlText(data: string): boolean {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x08) continue;
    if (code >= 0x20 && code <= 0x7e) continue;
    return false;
  }
  return true;
}

/**
 * 扫描一个写入 chunk，返回「行首出现可打印字符」处的行偏移（相对 chunk 写入前
 * 的光标行）。同一 chunk 内可能有多个；调用方按「每秒一个」筛选。
 *
 * 与 Netcatty 一致：
 * - 软换行计入行偏移（长命令换行后，后续提示符仍落在正确物理行）；
 * - `\r` 只回到行首、不解除 `currentLineStamped`，因此重绘同物理行不重复打点；
 * - `\n` 解除 stamped，下一行重新获得打点机会；
 * - 备用屏幕（CSI ?1049h/l）暂停打点，离开后恢复。
 */
export function scanTerminalTimestampOutput(
  state: TerminalTimestampSegmenterState,
  data: string,
  options: {
    alternate?: boolean;
    columns?: number;
    startColumn?: number;
    wraparoundMode?: boolean;
  } = {},
): number[] {
  if (options.alternate !== undefined) {
    state.alternateActive = options.alternate;
    if (options.alternate) resetSegmenterLineState(state);
  }

  const input = state.pendingEscape ? `${state.pendingEscape}${data}` : data;
  state.pendingEscape = "";
  const offsets: number[] = [];
  let lineOffset = 0;
  let column = Math.max(0, options.startColumn ?? 0);
  const columns =
    options.columns !== undefined && options.columns > 0
      ? options.columns
      : Number.POSITIVE_INFINITY;
  const wraparoundMode = options.wraparoundMode ?? true;

  // 快速通道：备用屏之外、且整段只有 ASCII 与常见控制符时，不需要 ESC / 宽度解析。
  if (!state.alternateActive && isSimpleAsciiControlText(input)) {
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      if (code === 0x0d) {
        state.atLineStart = true;
        column = 0;
        continue;
      }
      if (code === 0x0a) {
        lineOffset += 1;
        if (Number.isFinite(columns) && column >= columns) column = columns - 1;
        resetSegmenterLineState(state);
        continue;
      }
      if (code === 0x08) {
        column = Math.max(0, column - 1);
        continue;
      }
      if (code === 0x09) {
        if (state.atLineStart && !state.currentLineStamped) {
          offsets.push(lineOffset);
          state.currentLineStamped = true;
        }
        state.atLineStart = false;
        if (Number.isFinite(columns) && column < columns) {
          column = Math.min(column + (8 - (column % 8)), columns - 1);
        }
        continue;
      }
      if (state.atLineStart && !state.currentLineStamped) {
        offsets.push(lineOffset);
        state.currentLineStamped = true;
      }
      state.atLineStart = false;
      const advanced = advanceColumn(column, lineOffset, 1, columns, wraparoundMode);
      column = advanced.column;
      lineOffset = advanced.rowOffset;
    }
    return offsets;
  }

  for (let i = 0; i < input.length; ) {
    const ch = input[i];

    if (ch === "\u001b") {
      const sequence = readEscapeSequence(input, i);
      if (sequence) {
        if (!sequence.complete) {
          if (sequence.sequence.length <= TERMINAL_TIMESTAMP_MAX_PENDING_ESCAPE) {
            state.pendingEscape = input.slice(i);
          } else {
            // Fail open（对照 Netcatty canRetainIncompleteTerminalControlSequence）：
            // xterm 仍收到原始数据，打点器丢弃这段畸形前缀，下一 chunk 重新开始，
            // 避免内存无界增长 + 每帧全量重扫。
            state.pendingEscape = "";
          }
          break;
        }
        const alternateAction = getAlternateScreenAction(sequence.sequence);
        if (alternateAction === "enter") {
          state.alternateActive = true;
          resetSegmenterLineState(state);
        } else if (alternateAction === "leave") {
          state.alternateActive = false;
          resetSegmenterLineState(state);
        }
        i = sequence.endIndex + 1;
        continue;
      }
    }

    if (state.alternateActive) {
      // 备用屏幕内只有 ESC 能改变状态，整段跳过。
      const nextEsc = input.indexOf("\u001b", i + 1);
      i = nextEsc === -1 ? input.length : nextEsc;
      continue;
    }

    if (ch === "\r") {
      // 回到行首：允许在行首打点，但同一物理行已打过就不再打（Netcatty 语义）。
      state.atLineStart = true;
      column = 0;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      lineOffset += 1;
      if (Number.isFinite(columns) && column >= columns) column = columns - 1;
      resetSegmenterLineState(state);
      i += 1;
      continue;
    }
    if (ch === "\b") {
      column = Math.max(0, column - 1);
      i += 1;
      continue;
    }
    if (ch === "\t") {
      if (state.atLineStart && !state.currentLineStamped) {
        offsets.push(lineOffset);
        state.currentLineStamped = true;
      }
      state.atLineStart = false;
      if (Number.isFinite(columns) && column < columns) {
        column = Math.min(column + (8 - (column % 8)), columns - 1);
      }
      i += 1;
      continue;
    }
    if (!isPrintableOutput(ch)) {
      i += 1;
      continue;
    }

    if (state.atLineStart && !state.currentLineStamped) {
      offsets.push(lineOffset);
      state.currentLineStamped = true;
    }
    state.atLineStart = false;
    const codePoint = input.codePointAt(i) ?? 0;
    const width = isZeroWidthCodePoint(codePoint)
      ? 0
      : isWideCodePoint(codePoint)
        ? 2
        : 1;
    const advanced = advanceColumn(
      column,
      lineOffset,
      width,
      columns,
      wraparoundMode,
    );
    column = advanced.column;
    lineOffset = advanced.rowOffset;
    i += codePoint > 0xffff ? 2 : 1;
  }

  return offsets;
}

/** 时间戳实际对应的行：优先存活 marker 的实时行号，否则退回打点行号。 */
export function resolveTerminalTimestampStampLine(stamp: TerminalTimestampStamp): number {
  const marker = stamp.marker;
  if (marker && !marker.isDisposed) {
    const line = marker.line;
    if (Number.isFinite(line) && line >= 0) return Math.floor(line);
  }
  return stamp.line;
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
  capacity: number = TERMINAL_TIMESTAMP_MAX_STAMPS,
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

  // 容量上界（Netcatty MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES）：从最旧一端丢弃。
  if (capacity > 0 && stamps.length > capacity) {
    const drop = stamps.length - capacity;
    for (let index = 0; index < drop; index += 1) {
      const stamp = stamps[index];
      if (stamp.marker && !stamp.marker.isDisposed) stamp.marker.dispose?.();
    }
    stamps.splice(0, drop);
  }
}

/**
 * 当前视口内要显示的时间戳行（Netcatty `resolveTerminalTimestampGutterRowsFromLedger`）：
 * 填充式绘制 —— 每个可见行取 ≤ 该行的最新打点，因此同一秒内的多行、提示符后的
 * 命令回显行都会沿用上一打点；软换行续行按「源行」取同一时间戳（Netcatty 会为
 * 每个物理行都画，reflow 后窄窗格的续行也不例外）；`lastContentLine` 之后的
 * 空白区不画（与 Netcatty 的 lastPaintLine 一致）。
 */
export function resolveVisibleTerminalTimestampRows(input: {
  stamps: readonly TerminalTimestampStamp[];
  viewportY: number;
  rows: number;
  isWrapped: (absoluteLine: number) => boolean;
  lastContentLine?: number;
}): TerminalTimestampRow[] {
  if (input.rows <= 0 || input.stamps.length === 0) return [];

  const entries = input.stamps
    .map((stamp) => ({
      line: resolveTerminalTimestampStampLine(stamp),
      label: stamp.label,
    }))
    .filter((entry) => entry.line >= 0)
    .sort((a, b) => a.line - b.line);

  if (entries.length === 0) return [];
  const lastLine = Math.min(
    input.viewportY + input.rows - 1,
    input.lastContentLine ?? Number.POSITIVE_INFINITY,
  );

  // 软换行续行回退到它所属的源行（Netcatty `resolveSourceLine`）。
  const resolveSourceLine = (line: number): number => {
    if (!input.isWrapped(line)) return line;
    let source = line;
    while (source > 0 && input.isWrapped(source)) source -= 1;
    return source;
  };

  const result: TerminalTimestampRow[] = [];
  let cursor = 0;
  let currentLabel: string | undefined;
  for (let row = 0; row < input.rows; row += 1) {
    const line = input.viewportY + row;
    if (line > lastLine) break;
    const sourceLine = resolveSourceLine(line);
    while (cursor < entries.length && entries[cursor].line <= sourceLine) {
      currentLabel = entries[cursor].label;
      cursor += 1;
    }
    if (!currentLabel) continue;
    result.push({ row, label: currentLabel });
  }
  return result;
}

/**
 * 视口最后一条有内容的行（Netcatty `resolveLastPaintBufferLine` 的精简版）：
 * 取「最后一条打点行」与「光标所在内容行」的较大者，并按 buffer 长度截断，
 * 避免输出被擦除后光标上移导致下方仍有时间戳的行不画。
 */
export function resolveLastContentLine(input: {
  cursorAbsolute: number;
  cursorX?: number;
  isBlank: (absoluteLine: number) => boolean;
  lastStampLine?: number;
  bufferLength?: number;
}): number {
  const cursor = Math.max(0, input.cursorAbsolute);
  let contentEnd = cursor;
  // 行尾换行后光标停在空行，该行不应强制多画一格（Netcatty 同条件）。
  if ((input.cursorX ?? 0) === 0 && input.isBlank(cursor) && cursor > 0) {
    contentEnd = cursor - 1;
  }
  let lastPaint = Math.max(contentEnd, input.lastStampLine ?? -1);
  if (typeof input.bufferLength === "number" && input.bufferLength > 0) {
    lastPaint = Math.min(lastPaint, input.bufferLength - 1);
  }
  return Math.max(0, lastPaint);
}

/**
 * per-terminal 时间戳状态（WeakMap keyed by xterm 实例，和 Netcatty 一样保证
 * 分屏两侧各一份：marker 集合、上次打点秒、分段器状态互不共享）。
 */
export interface TerminalTimestampState {
  stamps: TerminalTimestampStamp[];
  segmenter: TerminalTimestampSegmenterState;
  /** `HH:mm:ss` 秒级去重 key。 */
  lastSecondKey: string;
  cols: number;
}

const terminalTimestampStates = new WeakMap<object, TerminalTimestampState>();

export function getTerminalTimestampState(terminal: object): TerminalTimestampState {
  let state = terminalTimestampStates.get(terminal);
  if (!state) {
    state = {
      stamps: [],
      segmenter: createTerminalTimestampSegmenterState(),
      lastSecondKey: "",
      cols: 0,
    };
    terminalTimestampStates.set(terminal, state);
  }
  return state;
}

/** 关闭时间戳 / 卸载时释放 marker 并丢弃该终端的状态。 */
export function resetTerminalTimestampState(terminal: object): void {
  const state = terminalTimestampStates.get(terminal);
  if (!state) return;
  for (const stamp of state.stamps) {
    if (stamp.marker && !stamp.marker.isDisposed) stamp.marker.dispose?.();
  }
  state.stamps.length = 0;
  state.segmenter = createTerminalTimestampSegmenterState();
  state.lastSecondKey = "";
  state.cols = 0;
  terminalTimestampStates.delete(terminal);
}
