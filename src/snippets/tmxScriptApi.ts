// 阶段 1 的 tmx API 实现：把 Worker 的 RPC 调用落到当前会话。
//
// 语义对齐 Netcatty `scriptRuntime.cjs`：
// - `sendLine` 先写命令正文，等 30ms 再写 `\r`（跳板机可能吞掉 `line\r` 单包）；
//   只消费发送前的缓冲长度，正文与 `\r` 之间到达的输出仍可被下一次等待命中；
// - `getText` 阶段 1 用文本缓冲按行切分（没有屏幕快照，偏差见 docs §11）；
// - `waitForPrompt` 使用简化的 `[#$%]\s*$`，默认 60s；其它等待默认 30s。

import type { TmxScriptApi, TmxScriptSessionSnapshot } from "./tmxRuntime";
import type { SessionTextBuffer } from "./sessionTextBuffer";

export interface TmxScriptApiHost {
  /** 向当前会话写入输入（等价于用户键盘输入）。 */
  write(text: string): void;
  buffer: SessionTextBuffer;
  snapshot: TmxScriptSessionSnapshot;
  /** 脚本是否已被用户停止 / 宿主终止。 */
  isAborted?: () => boolean;
  /** 两包发送间隔，默认 30ms（测试可注入更短值）。 */
  lineDelayMs?: number;
  /** 等待中的可中断 sleep（默认 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 运行日志：发送行等（`tmx.log` 由宿主运行器单独转发）。 */
  onLog?: (line: string) => void;
}

const DEFAULT_LINE_DELAY_MS = 30;
const ABORT_POLL_MS = 50;

/** 把控制字符转成可读文本，避免日志里出现换行把面板拆散。 */
function formatForLog(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function createAbortableSleep(isAborted: () => boolean) {
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (isAborted()) {
        reject(new Error("Script stopped"));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const poll = setInterval(() => {
        if (!isAborted()) return;
        if (timer) clearTimeout(timer);
        clearInterval(poll);
        reject(new Error("Script stopped"));
      }, Math.min(ABORT_POLL_MS, Math.max(1, ms)));

      timer = setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, Math.max(0, ms));
    });
}

export function createTmxScriptApi(host: TmxScriptApiHost): TmxScriptApi {
  const isAborted = host.isAborted ?? (() => false);
  const lineDelayMs = host.lineDelayMs ?? DEFAULT_LINE_DELAY_MS;
  const sleep = host.sleep ?? createAbortableSleep(isAborted);

  const logSent = (label: string, text: string) => {
    host.onLog?.(`→ ${label}${formatForLog(text)}`);
  };

  return {
    connected: host.snapshot.connected,
    name: host.snapshot.name,
    hostname: host.snapshot.hostname,
    username: host.snapshot.username,

    send(text: string) {
      if (isAborted()) throw new Error("Script stopped");
      const payload = String(text ?? "");
      logSent("send: ", payload);
      host.write(payload);
    },

    async sendLine(text: string) {
      if (isAborted()) return;
      const line = String(text ?? "");
      logSent("sendLine: ", line);
      // 只消费发送前的长度：正文与 CR 之间到达的输出保持可等待。
      const lengthBeforeSend = host.buffer.markSendStart();
      if (line.length > 0) {
        host.write(line);
        await sleep(lineDelayMs);
        if (isAborted()) return;
      }
      host.write("\r");
      host.buffer.consumeThrough(lengthBeforeSend);
    },

    clear() {
      if (isAborted()) return;
      host.write("\x1b[2J\x1b[H");
    },

    getText(startRow?: number, endRow?: number) {
      const text = host.buffer.getText();
      if (startRow === undefined && endRow === undefined) return text;
      const lines = text.split(/\r?\n/);
      const start = typeof startRow === "number" ? Math.max(0, startRow) : 0;
      const end =
        typeof endRow === "number" ? Math.min(lines.length - 1, endRow) : lines.length - 1;
      if (end < start) return "";
      return lines.slice(start, end + 1).join("\n");
    },

    waitForText(text: string, timeoutMs = 30_000) {
      return host.buffer.waitForText(String(text ?? ""), timeoutMs, isAborted);
    },

    waitForRegex(pattern: string, timeoutMs = 30_000) {
      return host.buffer.waitForRegex(String(pattern ?? ""), timeoutMs, isAborted);
    },

    waitForPrompt(timeoutMs = 60_000) {
      return host.buffer.waitForPrompt(timeoutMs, isAborted);
    },

    waitForAny(patterns: string[], timeoutMs = 30_000) {
      return host.buffer.waitForAny(
        Array.isArray(patterns) ? patterns.map(String) : [],
        timeoutMs,
        isAborted,
      );
    },

    sleep,

    log() {
      // `tmx.log` 的落点由宿主运行器统一收集（api.log + onLog 回调）。
    },

    abort() {
      host.buffer.abortWaiters("Script stopped");
    },
  };
}
