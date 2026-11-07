/**
 * 终端撰写栏的纯逻辑（对照 Netcatty `components/terminal/TerminalComposeBar.tsx`、
 * `composeBarHelpers.ts`、`domain/composeBarHistory.ts`）。
 *
 * Netcatty 行为基线（本模块在按键语义上做了调整）：
 * - 固定在终端底部，高度默认 120、可拖拽 72–360，内容不撑高、textarea 内部滚动；
 * - termX：Enter 发送全部、Shift+Enter 只发送光标所在行、Ctrl+Enter 换行；
 *   Alt/Cmd+Enter 仍按发送（与 Netcatty 一致）；
 * - Escape 关闭；输入法组合态（composition / keyCode 229）不触发任何快捷键；
 * - ↑/↓ 在光标位于首/末行时翻阅本会话发送历史，回到草稿时恢复原文；
 * - 发送时换行统一为 LF，多行内容在 bracketed paste 模式下包裹后追加 `\r`。
 */

export const COMPOSE_BAR_MIN_HEIGHT = 72;
export const COMPOSE_BAR_MAX_HEIGHT = 360;
export const COMPOSE_BAR_DEFAULT_HEIGHT = 120;
export const COMPOSE_BAR_HISTORY_MAX = 100;

export function clampComposeBarHeight(height: number): number {
  if (!Number.isFinite(height)) return COMPOSE_BAR_DEFAULT_HEIGHT;
  return Math.max(
    COMPOSE_BAR_MIN_HEIGHT,
    Math.min(COMPOSE_BAR_MAX_HEIGHT, Math.round(height)),
  );
}

export type ComposeKeyAction =
  | "send"
  | "send-line"
  | "newline"
  | "close"
  | "history-up"
  | "history-down"
  | "default";

export interface ComposeKeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** 输入法组合态（React 的 nativeEvent.isComposing 或 keyCode === 229）。 */
  isComposing?: boolean;
  keyCode?: number;
  /** 当前草稿能否向上/向下翻阅历史（按光标位置判断）。 */
  canHistoryUp?: boolean;
  canHistoryDown?: boolean;
}

/**
 * 键盘映射：输入法组合态一律交还给输入法。
 * Enter = 发送全部；Shift+Enter = 只发送单行；Ctrl+Enter = 换行（不发送）；
 * Alt/Cmd+Enter 保持发送（与 Netcatty 一致）；↑/↓ 仅在无修饰键且允许翻阅历史时接管。
 */
export function resolveComposeKeyAction(input: ComposeKeyInput): ComposeKeyAction {
  if (input.isComposing || input.keyCode === 229) return "default";
  const plain =
    !input.shiftKey && !input.ctrlKey && !input.altKey && !input.metaKey;
  if (plain && input.key === "ArrowUp" && input.canHistoryUp) return "history-up";
  if (plain && input.key === "ArrowDown" && input.canHistoryDown) {
    return "history-down";
  }
  if (input.key === "Enter") {
    if (input.ctrlKey) return "newline";
    if (input.shiftKey) return "send-line";
    return "send";
  }
  if (input.key === "Escape") return "close";
  return "default";
}

export interface ComposeLineSlice {
  /** 光标所在行的原文（未 trim）。 */
  line: string;
  /** 移除该行后剩下的草稿（保留其余行顺序）。 */
  rest: string;
  /** 移除后光标应落到的位置。 */
  cursor: number;
}

/** Shift+Enter：取出光标所在单行；其余内容按原顺序保留。 */
export function sliceComposeLine(value: string, cursor: number): ComposeLineSlice {
  const lines = value.split("\n");
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const index = value.slice(0, safeCursor).split("\n").length - 1;
  const line = lines[index] ?? "";
  const before = lines.slice(0, index);
  const after = lines.slice(index + 1);
  const rest = [...before, ...after].join("\n");
  const beforeLength = before.join("\n").length;
  const nextCursor = before.length > 0 ? beforeLength + (after.length > 0 ? 1 : 0) : 0;
  return { line, rest, cursor: nextCursor };
}

/** 仅当光标/选区在首行（↑）或末行（↓）且没有选区时，↑/↓ 才翻阅历史。 */
export function canNavigateComposeHistory(
  value: string,
  selectionStart: number,
  direction: "up" | "down",
  selectionEnd = selectionStart,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  const cursor = Math.max(0, Math.min(selectionStart, value.length));
  if (direction === "up") return !value.slice(0, cursor).includes("\n");
  return !value.slice(cursor).includes("\n");
}

export interface ComposeHistoryState {
  /** `entries.length` 表示仍在草稿；0..length-1 表示已翻阅到的历史位置。 */
  index: number;
  draft: string;
}

export interface ComposeHistoryResult {
  index: number;
  value: string;
  draft: string;
}

/** 追加一条发送历史；跳过空命令与连续重复，并限制最大条数。 */
export function appendComposeHistory(
  entries: readonly string[],
  command: string,
  max = COMPOSE_BAR_HISTORY_MAX,
): string[] {
  if (!command.trim()) return [...entries];
  if (entries[entries.length - 1] === command) return [...entries];
  return [...entries, command].slice(-Math.max(1, max));
}

/**
 * 类似 shell 的历史游走：↑ 取更早的一条，↓ 取更新的一条，
 * 越过最新一条时恢复翻阅前的草稿。
 */
export function navigateComposeHistory(
  entries: readonly string[],
  state: ComposeHistoryState,
  currentValue: string,
  direction: "up" | "down",
): ComposeHistoryResult | null {
  if (entries.length === 0) return null;
  const liveIndex = entries.length;
  let index = Number.isFinite(state.index) ? state.index : liveIndex;
  index = Math.max(0, Math.min(liveIndex, index));

  if (direction === "up") {
    if (index <= 0) return null;
    const draft = index === liveIndex ? currentValue : state.draft;
    const nextIndex = index - 1;
    return { index: nextIndex, value: entries[nextIndex] ?? "", draft };
  }

  if (index >= liveIndex) return null;
  const nextIndex = index + 1;
  if (nextIndex >= liveIndex) {
    return { index: liveIndex, value: state.draft, draft: state.draft };
  }
  return { index: nextIndex, value: entries[nextIndex] ?? "", draft: state.draft };
}

/** 发送内容：换行归一为 LF；多行且 bracketed paste 开启时包裹内容后再附加回车。 */
export function buildComposePayload(text: string, bracketedPaste: boolean): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (bracketedPaste && normalized.includes("\n")) {
    return `\x1b[200~${normalized}\x1b[201~\r`;
  }
  return `${normalized}\r`;
}

/**
 * 粘贴内容（右键 / 快捷键）：只输入、不回车。
 *
 * 走 `term.paste()` 时 xterm 生成的 bracketed 序列会经过逐字兼容拆分，
 * ESC 被丢弃后远端会把 `[200~` 当普通字符回显。这里与撰写栏一致，
 * 直接构造整段字节交给 writeBulk。
 */
export function buildPastePayload(text: string, bracketedPaste: boolean): string {
  const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  if (bracketedPaste) {
    return `\x1b[200~${normalized}\x1b[201~`;
  }
  return normalized;
}
