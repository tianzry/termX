/**
 * 串口输入变换（纯逻辑，无 DOM / Tauri 依赖）。
 * 语义对齐 Netcatty：
 * - `lineMode`：缓冲输入，回车后整行发送（末尾 `\r`）；Ctrl+U 清行；Ctrl+C 立即发送。
 * - `localEcho`：本地回显输入；退格用 `\b \b` 擦除显示宽度。
 * - `backspaceBehavior`：DEL(0x7F) → Ctrl+H(0x08) 可选。
 * - `byteOrientedBackspace`：按末字符的 UTF-8 字节数发送多个 DEL。
 * 参考 `components/terminal/runtime/serialLineInput.ts` / `serialLocalEcho.ts`。
 */

import type { SerialBackspaceBehavior } from "./serialFormConfig";

export interface SerialInputOptions {
  lineMode: boolean;
  localEcho: boolean;
  backspaceBehavior: SerialBackspaceBehavior;
  byteOrientedBackspace: boolean;
}

/** 一次输入的处理结果：wire 写串口，echo 写本地终端（可为空串）。 */
export interface SerialInputChunk {
  wire: string;
  echo: string;
}

export interface SerialInputController {
  feed: (text: string) => SerialInputChunk;
  /** 行模式下尚未提交的缓冲区。 */
  pending: () => string;
  reset: () => void;
}

const ZWJ = "\u200d";

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

/** 按字形簇粗分（覆盖代理对、组合符、ZWJ 序列），不依赖 Intl.Segmenter。 */
function graphemes(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      (isCombining(code) || (code === 0xfe0f) || prev.endsWith(ZWJ) || ch === ZWJ)
    ) {
      out[out.length - 1] = prev + ch;
    } else {
      out.push(ch);
    }
  }
  return out;
}

export function lastGrapheme(text: string): string {
  const parts = graphemes(text);
  return parts[parts.length - 1] ?? "";
}

export function removeLastGrapheme(text: string): string {
  const parts = graphemes(text);
  if (parts.length === 0) return "";
  return parts.slice(0, -1).join("");
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 终端显示宽度（宽字符 2 格，其余 1 格）。 */
export function cellWidth(text: string): number {
  let width = 0;
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCombining(code)) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

/** UTF-8 字节数（用于按字节退格）。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code > 0xffff ? 4 : code >= 0x800 ? 3 : code >= 0x80 ? 2 : 1;
  }
  return bytes;
}

function eraseEcho(cells: number): string {
  return "\b \b".repeat(Math.max(cells, 1));
}

/** 本地回显的换行归一：`\n` → `\r\n`，单独的 `\r` 原样保留。 */
function normalizeEchoLineEndings(text: string): string {
  if (text === "\r") return text;
  return text.replace(/\r?\n/g, "\r\n");
}

export function createSerialInput(options: SerialInputOptions): SerialInputController {
  let buffer = "";
  let lastChar = "";

  const reset = () => {
    buffer = "";
    lastChar = "";
  };

  function feedLineMode(data: string): SerialInputChunk {
    if (data === "\r" || data === "\n") {
      const wire = `${buffer}\r`;
      buffer = "";
      lastChar = "";
      return { wire, echo: options.localEcho ? "\r\n" : "" };
    }
    if (data === "\x7f" || data === "\b") {
      if (buffer === "") return { wire: "", echo: "" };
      const removed = lastGrapheme(buffer);
      const cells = cellWidth(removed);
      buffer = removeLastGrapheme(buffer);
      lastChar = "";
      return { wire: "", echo: options.localEcho ? eraseEcho(cells) : "" };
    }
    if (data === "\x03") {
      buffer = "";
      lastChar = "";
      return { wire: data, echo: options.localEcho ? "^C\r\n" : "" };
    }
    if (data === "\x15") {
      const cells = cellWidth(buffer);
      buffer = "";
      lastChar = "";
      return { wire: "", echo: options.localEcho ? eraseEcho(cells) : "" };
    }

    const normalized = data.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
    if (normalized.includes("\r")) {
      let wire = "";
      let echo = "";
      const parts = normalized.split("\r");
      parts.forEach((part, index) => {
        if (part) {
          buffer += part;
          if (options.localEcho) echo += part;
        }
        if (index < parts.length - 1) {
          wire += `${buffer}\r`;
          buffer = "";
          if (options.localEcho) echo += "\r\n";
        }
      });
      lastChar = "";
      return { wire, echo };
    }

    if (data.charCodeAt(0) >= 32 || data.length > 1) {
      buffer += data;
      return { wire: "", echo: options.localEcho ? data : "" };
    }
    return { wire: "", echo: "" };
  }

  function feedCharMode(data: string): SerialInputChunk {
    const isBackspace = data === "\x7f" || data === "\b";
    if (isBackspace) {
      const repeat =
        options.byteOrientedBackspace && lastChar !== "" ? utf8ByteLength(lastChar) : 1;
      const unit = options.backspaceBehavior === "ctrl-h" ? "\x08" : "\x7f";
      const cells = lastChar === "" ? 1 : cellWidth(lastChar);
      lastChar = "";
      return { wire: unit.repeat(repeat), echo: options.localEcho ? eraseEcho(cells) : "" };
    }
    if (data === "\x03") {
      lastChar = "";
      return { wire: data, echo: options.localEcho ? "^C" : "" };
    }
    if (data === "\r" || data === "\n") {
      lastChar = "";
      return {
        wire: data,
        echo: options.localEcho ? normalizeEchoLineEndings(data) : "",
      };
    }
    if (data.charCodeAt(0) >= 32 || data.length > 1) {
      lastChar = lastGrapheme(data);
      return {
        wire: data,
        echo: options.localEcho ? normalizeEchoLineEndings(data) : "",
      };
    }
    return { wire: data, echo: "" };
  }

  return {
    feed(text: string): SerialInputChunk {
      if (!text) return { wire: "", echo: "" };
      return options.lineMode ? feedLineMode(text) : feedCharMode(text);
    },
    pending: () => buffer,
    reset,
  };
}
