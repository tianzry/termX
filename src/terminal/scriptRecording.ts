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
}

export function createScriptRecordingBuffer(now = 0): ScriptRecordingBuffer {
  return { line: "", steps: [], lastSubmittedAt: now };
}

/** 按一个输入 chunk 更新录制缓冲；返回提交的命令（未提交为 null）。 */
export function appendKeystrokes(
  buffer: ScriptRecordingBuffer,
  data: string,
  now: number,
): RecordedStep | null {
  let line = buffer.line;
  let submitted: RecordedStep | null = null;

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch === "\r" || ch === "\n") {
      const command = line.trim();
      if (command) {
        const delayMs = buffer.steps.length
          ? Math.max(0, now - buffer.lastSubmittedAt)
          : 0;
        submitted = { command, delayMs };
        buffer.steps.push(submitted);
        buffer.lastSubmittedAt = now;
      }
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
    // 方向键 / 功能键等 ESC 序列：跳过整个 CSI / OSC 序列。
    if (ch === "\u001b") {
      const next = data[i + 1];
      if (next === "[") {
        i += 2;
        while (i < data.length && !/[@-~]/.test(data[i])) i += 1;
      } else if (next === "]") {
        i += 2;
        while (i < data.length && data[i] !== "\u0007") i += 1;
      } else {
        i += 1;
      }
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
