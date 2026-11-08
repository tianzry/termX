/**
 * termX 脚本执行器 · 阶段 B
 *
 * 只做「发往活动 shell 的文本 + 屏幕等待」这一可移植子集：
 * - 普通行按顺序发送（每行一个回车）；
 * - `#@wait-prompt [ms]` 等待 shell 提示符；
 * - `#@wait-text <文本> [ms]` 等待输出中出现该文本；
 * - `#@wait-regex <正则> [ms]` 等待输出匹配该正则。
 *
 * Netcatty 的 JS 运行时 / dialog / progress / startLog 不在这里实现（新运行时见 tmxRuntime.ts）。
 */

export type ScriptBlock =
  | { kind: "command"; text: string }
  | { kind: "wait-prompt"; timeoutMs: number }
  | { kind: "wait-text"; text: string; timeoutMs: number }
  | { kind: "wait-regex"; pattern: string; timeoutMs: number };

export const SCRIPT_WAIT_DEFAULT_MS = 30000;

function directive(line: string): { name: string; arg: string } | null {
  if (!line.startsWith("#@")) return null;
  const body = line.slice(2).trim();
  const idx = body.indexOf(" ");
  if (idx < 0) return { name: body.toLowerCase(), arg: "" };
  return { name: body.slice(0, idx).toLowerCase(), arg: body.slice(idx + 1).trim() };
}

/** 解析尾部可选超时（纯数字毫秒，最小 1s）。 */
function timeoutOf(arg: string): { arg: string; timeoutMs: number } {
  const m = arg.match(/^(.*?)\s*(\d{4,})\s*$/);
  if (m && m[2]) return { arg: m[1].trim(), timeoutMs: Math.max(1000, Number(m[2])) };
  return { arg: arg.trim(), timeoutMs: SCRIPT_WAIT_DEFAULT_MS };
}

export function parseScriptBlocks(source: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  let commands: string[] = [];
  const flush = () => {
    const text = commands.join("\n").replace(/\s+$/, "");
    if (text) blocks.push({ kind: "command", text });
    commands = [];
  };
  for (const raw of String(source ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const d = directive(line.trim());
    if (!d) {
      commands.push(line);
      continue;
    }
    flush();
    if (d.name === "wait-prompt") {
      blocks.push({ kind: "wait-prompt", timeoutMs: timeoutOf(d.arg).timeoutMs });
    } else if (d.name === "wait-text") {
      const t = timeoutOf(d.arg);
      if (t.arg) blocks.push({ kind: "wait-text", text: t.arg, timeoutMs: t.timeoutMs });
    } else if (d.name === "wait-regex") {
      const t = timeoutOf(d.arg);
      if (t.arg) blocks.push({ kind: "wait-regex", pattern: t.arg, timeoutMs: t.timeoutMs });
    } else {
      // 未知指令保持原文，避免静默丢行。
      commands.push(line);
    }
  }
  flush();
  return blocks;
}

export interface ScriptRunContext {
  /** 向活动会话写入原始按键。 */
  write: (text: string) => void;
  /** 当前终端缓冲全文（xterm buffer translateToString）。 */
  readBuffer: () => string;
  /** 轮询间隔，默认 100ms。 */
  pollMs?: number;
}

export interface ScriptRunHandle {
  done: Promise<void>;
  cancel: () => void;
}

/** 最新一行是否以 shell 提示符结尾（# / $ / %）。 */
export function looksLikePrompt(text: string): boolean {
  const lines = String(text ?? "").split(/\r?\n/).reverse();
  const last = lines.find((l) => l.trim().length > 0);
  return last ? /[#$%]\s*$/.test(last) : false;
}

export function runScriptBlocks(
  blocks: ScriptBlock[],
  ctx: ScriptRunContext,
): ScriptRunHandle {
  let cancelled = false;
  const pollMs = ctx.pollMs ?? 100;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const run = async () => {
    for (const block of blocks) {
      if (cancelled) return;
      if (block.kind === "command") {
        ctx.write(block.text.split("\n").map((l) => `${l}\r`).join(""));
        continue;
      }
      // 等待类指令以「进入等待时的缓冲长度」为基线，避免旧输出误命中。
      const baseline = ctx.readBuffer().length;
      const deadline = Date.now() + block.timeoutMs;
      let matched = false;
      let re: RegExp | null = null;
      if (block.kind === "wait-regex") {
        try {
          re = new RegExp(block.pattern, "m");
        } catch {
          throw new Error(`等待正则无效：${block.pattern}`);
        }
      }
      while (!cancelled) {
        const full = ctx.readBuffer();
        const segment = full.slice(Math.max(0, baseline));
        if (block.kind === "wait-prompt") {
          matched = looksLikePrompt(segment);
        } else if (block.kind === "wait-text") {
          matched = segment.includes(block.text);
        } else {
          matched = !!re && re.test(segment);
        }
        if (matched) break;
        if (Date.now() >= deadline) {
          const what =
            block.kind === "wait-prompt"
              ? "shell 提示符"
              : block.kind === "wait-text"
                ? `文本「${block.text}」`
                : `正则 /${block.pattern}/`;
          throw new Error(`等待超时（${block.timeoutMs}ms）：${what}`);
        }
        await sleep(pollMs);
      }
    }
  };

  return {
    done: run(),
    cancel: () => {
      cancelled = true;
    },
  };
}
