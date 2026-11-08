// 会话文本缓冲：脚本运行时读取终端输出的唯一数据源。
//
// 移植自 Netcatty `electron/scripts/sessionOutputBuffer.cjs` 的“绝对偏移游标 +
// 尾部保留”模型，阶段 1 简化了屏幕快照 / seeded viewport 相关逻辑：
// - 终端输出按块追加，保留最近 `maxChars` 个字符；
// - 游标是绝对偏移，裁剪时同步回退；
// - 每次 wait* 只扫描游标之后的“新文本”，命中后游标推进到命中末尾（不吞掉
//   同一包里命中之后的输出，后续等待可继续匹配）；
// - 等待命中 / 超时 / 中止通过短轮询检查，不依赖 xterm 渲染回调。

export type WaitKind = "text" | "regex" | "prompt" | "any";

export interface SessionTextBufferOptions {
  /** 尾部保留的最大字符数，默认 20 万。 */
  maxChars?: number;
  /** 等待轮询间隔（毫秒），默认 50。 */
  pollMs?: number;
}

const DEFAULT_MAX_CHARS = 200_000;
/** 超限时多裁一些，避免每追加一小块就触发一次裁剪。 */
const TRIM_SLACK_CHARS = 50_000;
const DEFAULT_POLL_MS = 50;

/** 阶段 1 的简化提示符规则；阶段 2 再对齐 Netcatty 的多 shell 规则。 */
const PROMPT_PATTERN = /[#$%]\s*$/;

const WAIT_LABELS: Record<WaitKind, string> = {
  text: "waitForText",
  regex: "waitForRegex",
  prompt: "waitForPrompt",
  any: "waitForAny",
};

interface Waiter {
  kind: WaitKind;
  patterns: string[];
  timeoutMs: number;
  deadline: number;
  resolve: (value: string | number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setInterval>;
}

interface MatchResult {
  /** waitForAny 里命中的模式下标；其它类型固定为 0。 */
  index: number;
  /** 命中文本（text 为原字符串，regex / prompt 为匹配到的子串）。 */
  value: string;
  /** 命中在“新文本”中的起始偏移。 */
  start: number;
}

function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "m");
  } catch {
    // 非法正则视为不匹配（与文档 §4 一致）。
    return null;
  }
}

function findMatch(kind: WaitKind, patterns: string[], fresh: string): MatchResult | null {
  if (kind === "text") {
    const value = patterns[0] ?? "";
    const start = fresh.indexOf(value);
    return start < 0 ? null : { index: 0, value, start };
  }
  if (kind === "prompt") {
    const hit = PROMPT_PATTERN.exec(fresh);
    return hit ? { index: 0, value: hit[0], start: hit.index } : null;
  }
  // regex / any 均按正则处理；any 按模式顺序返回第一个命中的下标。
  for (let index = 0; index < patterns.length; index += 1) {
    const regex = compileRegex(patterns[index]);
    if (!regex) continue;
    const hit = regex.exec(fresh);
    if (hit) return { index, value: hit[0], start: hit.index };
  }
  return null;
}

export class SessionTextBuffer {
  private text = "";
  private cursor = 0;
  private readonly maxChars: number;
  private readonly pollMs: number;
  private waiters = new Set<Waiter>();

  constructor(options: SessionTextBufferOptions = {}) {
    this.maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
    this.pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  }

  /** 追加终端输出（xterm `onData` 的同一份文本）。 */
  append(chunk: string): void {
    if (!chunk) return;
    this.text += chunk;
    this.trim();
    this.flush();
  }

  /** 当前保留的完整文本。 */
  getText(): string {
    return this.text;
  }

  /** 当前文本长度（绝对偏移上界）。 */
  getLength(): number {
    return this.text.length;
  }

  /** 当前游标（已消费到的绝对偏移）。 */
  getCursor(): number {
    return this.cursor;
  }

  /** 记录发送起点：返回此刻的绝对长度，供 `consumeThrough` 使用。 */
  markSendStart(): number {
    return this.text.length;
  }

  /** 把绝对长度 `absoluteLength` 之前的输出标记为已消费（只前进不后退）。 */
  consumeThrough(absoluteLength: number): void {
    const capped = Number.isFinite(absoluteLength)
      ? Math.max(0, Math.min(this.text.length, absoluteLength))
      : 0;
    this.cursor = Math.max(this.cursor, capped);
  }

  /** 把当前全部输出视为已消费。 */
  consumeAll(): void {
    this.cursor = this.text.length;
  }

  /** 清空缓冲与游标。 */
  clear(): void {
    this.text = "";
    this.cursor = 0;
    this.flush();
  }

  /** 等待字面量文本出现，返回实际匹配到的文本。 */
  waitForText(
    text: string,
    timeoutMs = 30_000,
    isAborted: () => boolean = () => false,
  ): Promise<string> {
    return this.wait("text", [text], timeoutMs, isAborted) as Promise<string>;
  }

  /** 等待正则命中，返回匹配到的文本；非法正则视为不匹配。 */
  waitForRegex(
    pattern: string,
    timeoutMs = 30_000,
    isAborted: () => boolean = () => false,
  ): Promise<string> {
    return this.wait("regex", [pattern], timeoutMs, isAborted) as Promise<string>;
  }

  /** 等待命令提示符，返回匹配到的提示符文本。 */
  waitForPrompt(
    timeoutMs = 60_000,
    isAborted: () => boolean = () => false,
  ): Promise<string> {
    return this.wait("prompt", [], timeoutMs, isAborted) as Promise<string>;
  }

  /** 等待任意一个模式命中，返回命中的模式下标。 */
  waitForAny(
    patterns: string[],
    timeoutMs = 30_000,
    isAborted: () => boolean = () => false,
  ): Promise<number> {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return Promise.reject(new TypeError("waitForAny requires a non-empty patterns array"));
    }
    return this.wait("any", patterns, timeoutMs, isAborted) as Promise<number>;
  }

  /** 拒绝全部未完成的等待（脚本停止 / 运行结束时调用）。 */
  abortWaiters(reason = "Script stopped"): void {
    for (const waiter of [...this.waiters]) {
      this.settle(waiter);
      waiter.reject(new Error(reason));
    }
  }

  /** 释放缓冲：拒绝等待并清空数据。 */
  dispose(): void {
    this.abortWaiters("Session output buffer disposed");
    this.text = "";
    this.cursor = 0;
  }

  private wait(
    kind: WaitKind,
    patterns: string[],
    timeoutMs: number,
    isAborted: () => boolean,
  ): Promise<string | number> {
    const immediate = this.matchFresh(kind, patterns);
    if (immediate) return Promise.resolve(this.accept(kind, immediate));

    const timeout = Math.max(0, timeoutMs);
    return new Promise<string | number>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        patterns,
        timeoutMs: timeout,
        deadline: Date.now() + timeout,
        resolve,
        reject,
        timer: setInterval(() => this.poll(waiter, isAborted), this.pollMs),
      };
      this.waiters.add(waiter);
    });
  }

  private poll(waiter: Waiter, isAborted: () => boolean): void {
    if (isAborted()) {
      this.settle(waiter);
      waiter.reject(new Error("Script stopped"));
      return;
    }
    const matched = this.matchFresh(waiter.kind, waiter.patterns);
    if (matched) {
      this.settle(waiter);
      waiter.resolve(this.accept(waiter.kind, matched));
      return;
    }
    if (Date.now() >= waiter.deadline) {
      this.settle(waiter);
      waiter.reject(
        new Error(`${WAIT_LABELS[waiter.kind]} timed out after ${waiter.timeoutMs}ms`),
      );
    }
  }

  private settle(waiter: Waiter): void {
    clearInterval(waiter.timer);
    this.waiters.delete(waiter);
  }

  /** 扫描游标之后的新文本并返回结果（不做游标推进）。 */
  private matchFresh(kind: WaitKind, patterns: string[]): MatchResult | null {
    return findMatch(kind, patterns, this.text.slice(this.cursor));
  }

  /**
   * 命中：游标推进到命中末尾后返回对外结果。
   * `waitForAny` 返回模式下标，其余返回命中文本（与 Netcatty 语义一致）。
   */
  private accept(kind: WaitKind, matched: MatchResult): string | number {
    this.cursor = Math.min(
      this.text.length,
      this.cursor + matched.start + matched.value.length,
    );
    this.flush();
    return kind === "any" ? matched.index : matched.value;
  }

  /** 有新输出时立即唤醒所有等待，避免等到下一次轮询。 */
  private flush(): void {
    if (this.waiters.size === 0) return;
    for (const waiter of [...this.waiters]) {
      const matched = this.matchFresh(waiter.kind, waiter.patterns);
      if (!matched) continue;
      this.settle(waiter);
      waiter.resolve(this.accept(waiter.kind, matched));
    }
  }

  private trim(): void {
    if (this.text.length <= this.maxChars) return;
    // 超限时多裁一些，避免每追加一小块就再裁一次；同时保证至少留 75%。
    const keep = Math.min(
      this.maxChars,
      Math.max(this.maxChars - TRIM_SLACK_CHARS, Math.floor(this.maxChars * 0.75)),
    );
    const cut = this.text.length - keep;
    this.text = this.text.slice(cut);
    this.cursor = Math.max(0, this.cursor - cut);
  }
}
