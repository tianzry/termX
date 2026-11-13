/**
 * 串口「终端」分组选项的纯逻辑（无 DOM / Tauri 依赖），对齐 Netcatty
 * SerialConnectModal 终端区：发送换行符 / 接收换行 / 输入模式 / 输出模式 /
 * 慢速发送。XANY 是后端 termios 标志，这里只承载取值与默认值。
 *
 * 收发都是流式字节块，换行归一与 hex dump 必须跨块保持状态：
 * `\r\n` 可能被拆在两个块边界上，无状态替换会把一个换行显示成两行。
 */

export type SerialInputNewline = "cr" | "lf" | "crlf";
export type SerialOutputNewline = "raw" | "cr" | "lf" | "crlf";
export type SerialInputMode = "normal" | "line" | "hex";
export type SerialOutputMode = "text" | "hex";

/** 与后端 `SerialTermOpts`（models.rs）同形状：wire 上 snake_case。 */
export interface SerialTermOpts {
  xany: boolean;
  input_newline: SerialInputNewline;
  output_newline: SerialOutputNewline;
  slow_send: boolean;
  input_mode: SerialInputMode;
  output_mode: SerialOutputMode;
}

export const SERIAL_TERM_OPTS_DEFAULT: SerialTermOpts = {
  xany: false,
  input_newline: "cr",
  output_newline: "raw",
  slow_send: false,
  input_mode: "normal",
  output_mode: "text",
};

export const SERIAL_INPUT_NEWLINE_OPTIONS: Array<{
  value: SerialInputNewline;
  label: string;
}> = [
  { value: "cr", label: "CR (\\r)" },
  { value: "lf", label: "LF (\\n)" },
  { value: "crlf", label: "CRLF (\\r\\n)" },
];

export const SERIAL_OUTPUT_NEWLINE_OPTIONS: Array<{
  value: SerialOutputNewline;
  label: string;
}> = [
  { value: "raw", label: "原样（不转换）" },
  { value: "crlf", label: "统一为 CRLF (\\r\\n)" },
  { value: "lf", label: "统一为 LF (\\n)" },
  { value: "cr", label: "统一为 CR (\\r)" },
];

export const SERIAL_INPUT_MODE_OPTIONS: Array<{
  value: SerialInputMode;
  label: string;
}> = [
  { value: "normal", label: "普通" },
  { value: "line", label: "行模式" },
  { value: "hex", label: "十六进制输入" },
];

export const SERIAL_OUTPUT_MODE_OPTIONS: Array<{
  value: SerialOutputMode;
  label: string;
}> = [
  { value: "text", label: "文本" },
  { value: "hex", label: "十六进制" },
];

/** 界面文案（逐字对齐 Netcatty zh-CN）。 */
export const SERIAL_TERMINAL_TEXT = {
  section: "终端",
  xany: "XANY（任意字符恢复暂停的输出）",
  xanyUnsupported: "本机不支持 Xany。已有配置会保留，请手动关闭后保存。",
  sendNewline: "发送换行符（回车 / 粘贴）",
  receiveNewline: "接收换行",
  backspaceSend: "退格键发送",
  inputMode: "输入模式",
  outputMode: "输出模式",
  localEcho: "本地回显（显示输入的字符）",
  slowSend: "慢速发送（逐字节）",
  slowSendDesc: "逐字节写入串口，供慢速设备 / bootloader 消化。",
  inputModeHexDesc: "输入空格分隔的十六进制字节（如 41 42），发送时解码为原始字节。",
  hexInputInvalid: "十六进制输入非法：只接受 1~2 位 hex 字节（空格或逗号分隔）。",
} as const;

/** 缺字段 / 非法枚举一律回落默认值（与后端 serde(default) 同语义）。 */
export function resolveSerialTermOpts(
  saved?: Partial<SerialTermOpts> | null,
): SerialTermOpts {
  const merged: SerialTermOpts = { ...SERIAL_TERM_OPTS_DEFAULT, ...(saved ?? {}) };
  if (!SERIAL_INPUT_NEWLINE_OPTIONS.some((o) => o.value === merged.input_newline)) {
    merged.input_newline = SERIAL_TERM_OPTS_DEFAULT.input_newline;
  }
  if (!SERIAL_OUTPUT_NEWLINE_OPTIONS.some((o) => o.value === merged.output_newline)) {
    merged.output_newline = SERIAL_TERM_OPTS_DEFAULT.output_newline;
  }
  if (!SERIAL_INPUT_MODE_OPTIONS.some((o) => o.value === merged.input_mode)) {
    merged.input_mode = SERIAL_TERM_OPTS_DEFAULT.input_mode;
  }
  if (!SERIAL_OUTPUT_MODE_OPTIONS.some((o) => o.value === merged.output_mode)) {
    merged.output_mode = SERIAL_TERM_OPTS_DEFAULT.output_mode;
  }
  merged.xany = merged.xany === true;
  merged.slow_send = merged.slow_send === true;
  return merged;
}

function newlineSequence(mode: SerialInputNewline | SerialOutputNewline): string {
  if (mode === "lf") return "\n";
  if (mode === "cr") return "\r";
  if (mode === "crlf") return "\r\n";
  return "";
}

/** 回车 / 粘贴发送：把输入文本里的任意行结束替换为配置的换行序列。 */
export function mapSendNewline(text: string, mode: SerialInputNewline): string {
  return text.replace(/\r\n|\n|\r/g, newlineSequence(mode));
}

/**
 * 接收换行归一的流式变换器：`raw` 直通；其余模式把 CR / LF / CRLF 统一成
 * 目标序列，且跨块记住块尾的孤立 CR，避免 `\r\n` 被拆块后变成两个换行。
 */
export interface ReceiveNewlineTransformer {
  push: (text: string) => string;
  flush: () => string;
}

export function createReceiveNewlineTransformer(
  mode: SerialOutputNewline,
): ReceiveNewlineTransformer {
  let pendingCr = false;
  const seq = newlineSequence(mode);
  return {
    push(text: string): string {
      if (mode === "raw") return text;
      let input = text;
      let out = "";
      if (pendingCr) {
        // 上一块以 CR 结尾：本块以 LF 开头才算一个 CRLF，否则补一个换行。
        if (input.startsWith("\n")) {
          out += seq;
          input = input.slice(1);
        } else {
          out += seq;
        }
        pendingCr = false;
      }
      if (input.endsWith("\r")) {
        pendingCr = true;
        input = input.slice(0, -1);
      }
      out += input.replace(/\r\n|\n|\r/g, seq);
      return out;
    },
    flush(): string {
      if (mode === "raw" || !pendingCr) return "";
      pendingCr = false;
      return seq;
    },
  };
}

const HEX_BYTE = /^[0-9a-f]{1,2}$/i;

/**
 * 十六进制输入解析：接受空格 / 逗号 / 制表符分隔的 1~2 位 hex 字节。
 * 任一 token 非法即整体返回 null（调用方报错，不静默丢弃半截输入）。
 */
export function parseHexInput(text: string): Uint8Array | null {
  const tokens = text.split(/[\s,]+/).filter((t) => t !== "");
  if (tokens.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(tokens.length);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!HEX_BYTE.test(token)) return null;
    bytes[i] = parseInt(token, 16);
  }
  return bytes;
}

/**
 * 十六进制输出的流式格式化：经典 `偏移  字节×16  ASCII` 三列 dump，
 * 满 16 字节成行；`flush` 补出最后不满行的部分。
 */
export interface HexDumpFormatter {
  push: (bytes: Uint8Array) => string;
  flush: () => string;
}

function asciiColumn(line: Uint8Array): string {
  let out = "";
  for (const b of line) out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  return out;
}

function hexLine(offset: number, line: Uint8Array): string {
  const hex: string[] = [];
  for (const b of line) hex.push(b.toString(16).padStart(2, "0").toUpperCase());
  const pad = "   ".repeat(Math.max(16 - line.length, 0));
  const offsetText = offset.toString(16).padStart(8, "0").toUpperCase();
  return `${offsetText}  ${hex.join(" ")}${pad}  |${asciiColumn(line)}|`;
}

export function createHexDumpFormatter(): HexDumpFormatter {
  let offset = 0;
  let pending: number[] = [];
  return {
    push(bytes: Uint8Array): string {
      let out = "";
      for (const b of bytes) {
        pending.push(b);
        if (pending.length === 16) {
          out += `${hexLine(offset, Uint8Array.from(pending))}\r\n`;
          offset += 16;
          pending = [];
        }
      }
      return out;
    },
    flush(): string {
      if (pending.length === 0) return "";
      const line = Uint8Array.from(pending);
      pending = [];
      const out = `${hexLine(offset, line)}\r\n`;
      offset += line.length;
      return out;
    },
  };
}
