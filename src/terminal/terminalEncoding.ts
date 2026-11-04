/**
 * 终端编码偏好（对照 Netcatty `domain/terminalEncodingPreference.ts`）。
 *
 * 只保留两种值：`utf-8` / `gb18030`（GBK / GB2312 统一映射到超集 GB18030）。
 * 前端负责输出解码（`TextDecoder` 原生支持 gb18030），输入重新编码交给后端
 * （浏览器没有 gb18030 编码器），见 `src-tauri/src/terminal/encoding.rs`。
 */

export type TerminalEncoding = "utf-8" | "gb18030";

/** 每台主机记住上一次选择（Netcatty 同款：按 host id 分键）。 */
export const TERMINAL_ENCODING_STORAGE_PREFIX = "termx.terminalEncoding.";

export function isTerminalEncoding(value: unknown): value is TerminalEncoding {
  return value === "utf-8" || value === "gb18030";
}

export function terminalEncodingStorageKey(hostId: string | null): string | null {
  const id = (hostId ?? "").trim();
  return id ? `${TERMINAL_ENCODING_STORAGE_PREFIX}${encodeURIComponent(id)}` : null;
}

export function loadTerminalEncoding(hostId: string | null): TerminalEncoding {
  const key = terminalEncodingStorageKey(hostId);
  if (!key) return "utf-8";
  try {
    const raw = localStorage.getItem(key);
    return isTerminalEncoding(raw) ? raw : "utf-8";
  } catch {
    return "utf-8";
  }
}

export function saveTerminalEncoding(
  hostId: string | null,
  encoding: TerminalEncoding,
): void {
  const key = terminalEncodingStorageKey(hostId);
  if (!key) return;
  try {
    localStorage.setItem(key, encoding);
  } catch {
    /* 私密模式 / 配额满时忽略，按会话内存值继续工作 */
  }
}

export type EncodingTransportKind = "ssh" | "telnet" | "serial" | "pty";

/**
 * 编码切换的可用条件（对照 Netcatty `encodingSwitchSupported`）：
 * 只排除本地 PTY；termX 的串口编码在连接表单里固定配置，暂不支持中途切换，
 * 因此串口也置灰并在提示里说明原因。
 */
export function supportsEncodingSwitch(kind: EncodingTransportKind): boolean {
  return kind === "ssh" || kind === "telnet";
}

const ENCODING_LABELS: Record<TerminalEncoding, string> = {
  "utf-8": "UTF-8",
  gb18030: "GB18030（GBK / GB2312）",
};

export function terminalEncodingLabel(encoding: TerminalEncoding): string {
  return ENCODING_LABELS[encoding];
}

export interface TerminalDecoder {
  /** 把下行字节按当前编码解成文本（分块安全，跨块多字节字符不丢）。 */
  decode: (bytes: Uint8Array) => string;
  /** 切换编码 / 重连时重置流式状态。 */
  reset: () => void;
}

export function createTerminalDecoder(encoding: TerminalEncoding): TerminalDecoder {
  let decoder = new TextDecoder(encoding === "gb18030" ? "gb18030" : "utf-8", {
    fatal: false,
  });
  return {
    decode: (bytes) => decoder.decode(bytes, { stream: true }),
    reset: () => {
      try {
        decoder.decode();
      } catch {
        /* 已被关闭的流忽略 */
      }
      decoder = new TextDecoder(encoding === "gb18030" ? "gb18030" : "utf-8", {
        fatal: false,
      });
    },
  };
}
