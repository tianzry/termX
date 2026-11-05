/**
 * 脚本录制（对齐 Netcatty 的 `netcatty:script:recording:*`）。
 *
 * 与「会话日志」是两套独立能力：
 * - 会话日志：后端把终端输出写进用户选的文本文件（`.log/.txt/.html`）；
 * - 脚本录制：记录用户**输入**的命令与间隔，停止后生成一条可运行的脚本
 *   片段（termX 没有 Netcatty 的 nct.* JS 运行时，产物是 shell 命令序列）。
 *
 * 全局互斥：同一时刻只允许一个会话在录制；其它会话点击「开始录制」时
 * 报「已有其他终端正在录制」，与 Netcatty `scripts.recording.alreadyActive`
 * 的提示语义一致。
 */

export interface RecordedStep {
  command: string;
  /** 距离上一条命令提交的毫秒数；第一条为 0。 */
  delayMs: number;
}

export interface ScriptRecordingBuffer {
  line: string;
  steps: RecordedStep[];
  lastSubmittedAt: number;
  /**
   * bracketed paste（`\x1b[200~…\x1b[201~`）内容累积区；null 表示当前不在粘贴中。
   * 粘贴内容里的换行不是提交，整段按一条命令记入历史。
   */
  paste: string | null;
  /** 上一 chunk 末尾未完成的 ESC 序列，与下一 chunk 拼接后再解析。 */
  pendingEscape: string;
}

export function createScriptRecordingBuffer(now = 0): ScriptRecordingBuffer {
  return { line: "", steps: [], lastSubmittedAt: now, paste: null, pendingEscape: "" };
}

/** 粘贴内容里的 CRLF / 孤立 CR 统一成 LF，保留内部多行结构。 */
export function normalizePastedText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 按一个输入 chunk 更新录制缓冲；返回提交的命令（未提交为 null）。 */
export function appendKeystrokes(
  buffer: ScriptRecordingBuffer,
  data: string,
  now: number,
): RecordedStep | null {
  let line = buffer.line;
  let submitted: RecordedStep | null = null;
  let input = data;
  if (buffer.pendingEscape) {
    // 上一 chunk 末尾只有一个 ESC（vi 模式切换等）：下一 chunk 是普通输入时丢弃它，
    // 不能把下一 chunk 的首字符当成 Alt 组合键吞掉。
    const loneEscape =
      buffer.pendingEscape === "\u001b" &&
      data.length > 0 &&
      data[0] !== "[" &&
      data[0] !== "]";
    input = loneEscape ? data : `${buffer.pendingEscape}${data}`;
    buffer.pendingEscape = "";
  }

  const submit = (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    const delayMs = buffer.steps.length
      ? Math.max(0, now - buffer.lastSubmittedAt)
      : 0;
    submitted = { command: trimmed, delayMs };
    buffer.steps.push(submitted);
    buffer.lastSubmittedAt = now;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    // ESC 序列：方向键 / 功能键跳过；bracketed paste 的 200~/201~ 切换粘贴态。
    if (ch === "\u001b") {
      const next = input[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < input.length && !/[@-~]/.test(input[j])) j += 1;
        if (j >= input.length) {
          buffer.pendingEscape = input.slice(i);
          break;
        }
        const params = input.slice(i + 2, j);
        const final = input[j];
        if (final === "~" && params === "200") {
          buffer.paste = "";
        } else if (final === "~" && params === "201") {
          if (buffer.paste !== null) {
            line += normalizePastedText(buffer.paste);
            buffer.paste = null;
          }
        }
        i = j;
      } else if (next === "]") {
        let j = i + 2;
        while (j < input.length && input[j] !== "\u0007") j += 1;
        if (j >= input.length) {
          buffer.pendingEscape = input.slice(i);
          break;
        }
        i = j;
      } else if (next === undefined) {
        buffer.pendingEscape = "\u001b";
        break;
      } else {
        i += 1;
      }
      continue;
    }

    // 粘贴中：换行/回车都是内容而不是提交（整段粘贴在 Enter 时算一条命令）。
    if (buffer.paste !== null) {
      buffer.paste += ch;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      submit(line);
      line = "";
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      line = line.slice(0, -1);
      continue;
    }
    // Ctrl+C：丢弃当前行（与 shell 行为一致），也不记录被取消的命令。
    if (ch === "\u0003" || ch === "\u0015") {
      line = "";
      continue;
    }
    if (ch >= " ") line += ch;
  }

  buffer.line = line;
  return submitted;
}

/** 生成脚本正文：>1s 的间隔写成 `sleep`，便于回放节奏与 Netcatty 一致。 */
export function buildScriptCommand(steps: readonly RecordedStep[]): string {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.delayMs > 1000) {
      lines.push(`sleep ${(step.delayMs / 1000).toFixed(1)}`);
    }
    lines.push(step.command);
  }
  return lines.join("\n");
}

// ── 全局录制槽（模块级，跨窗格互斥）──────────────────────────────

let activeSessionId: string | null = null;

export function activeScriptRecordingSession(): string | null {
  return activeSessionId;
}

/** 开始录制；已有其它会话在录时返回 false（调用方提示「已有其他终端正在录制」）。 */
export function beginScriptRecording(sessionId: string): boolean {
  if (activeSessionId && activeSessionId !== sessionId) return false;
  activeSessionId = sessionId;
  return true;
}

export function endScriptRecording(sessionId: string): void {
  if (activeSessionId === sessionId) activeSessionId = null;
}
