# termX 脚本运行时（JavaScript + nct API）设计与实施

> 版本：阶段 1（MVP）
> 背景与差异清单见 [script-runtime-diff.md](./script-runtime-diff.md)。
> 范围已收敛：本文只落地**阶段 1**；阶段 2 / 阶段 3 明确标注“本期不做，仅记录”。阶段 0 的 spike 作为阶段 1 的前置验证。

---

## 1. 目标与非目标

### 1.1 阶段 1 目标（MVP）

1. 用户可在 `kind=script` 且 `language=javascript` 的脚本中编写 JavaScript，并**真正执行**。
2. 在**当前活动会话**内执行（不跨会话、不自动连接主机）。
3. 提供最小 `nct` API：
   - `screen.send / sendLine / clear / getText`
   - `screen.waitForText / waitForRegex / waitForPrompt / waitForAny`
   - `session.sleep / connected / name / hostname / username`
   - `log`
4. 运行 / 停止；运行状态与脚本日志面板。
5. CodeMirror 6 编辑器（语法高亮、行号、撤销、`Ctrl/Cmd+Enter` 运行）。
6. `{{var}}` 在**执行前**替换（脚本编辑区也显示变量提示）。
7. 兼容：`language !== 'javascript'` 继续走旧 `#@` 文本路径；**新建脚本默认 `javascript`**。
8. 超时 / 取消 / 防同步死循环：每次等待有超时，脚本可停止，死循环能被强制终止。

### 1.2 非目标（本期不做）

- 多主机 / 并行 / 串行运行、自动连接目标主机。
- `onConnect` / `onOutput` 改为执行 JS（本期仍维持旧 `#@` 子集）。
- `nct.dialog.*`、`nct.progress.*`、暂停/恢复、等待超时“重试/跳过/中止”弹窗。
- 录制生成 JS、`session.startLog/stopLog/disconnect`。
- `targetGroups`、主机级连接脚本队列、权限模式（Observer/确认/自动）、运行历史持久化。

---

## 2. termX 现状（摘要）

| 能力 | 现状 | 证据 |
|---|---|---|
| 手动运行 | 粘贴文本 + 回车，`#@` 不解释 | [SnippetsView.tsx](../src/snippets/SnippetsView.tsx#L362-L391) |
| 自动触发 | 仅 SSH；`wait-prompt/text/regex`，默认 30s | [scriptRunner.ts](../src/snippets/scriptRunner.ts#L13-L60) |
| 编辑器 | `<textarea>` | [SnippetsView.tsx](../src/snippets/SnippetsView.tsx#L1011-L1031) |
| 变量 | `{{name}}` / `{{name:默认}}`，脚本区无提示 | [snippetsModel.ts](../src/snippets/snippetsModel.ts#L357-L378) |
| 存储 | `snippets.json`，无 DB 表 | [snippet.rs](../src-tauri/src/db/snippet.rs#L6-L31) |
| 语言字段 | 仅标签，无运行时 | [models.rs](../src-tauri/src/models.rs#L793-L796) |

---

## 3. 总体架构

### 3.1 推荐方案：渲染层 Web Worker 复刻 Netcatty 三层结构

```
React UI（SnippetsView / TerminalPane）
   │  runNctScript(snippet)
   ▼
TerminalPane 主线程（脚本宿主）
   ├─ SessionTextBuffer      ← writeTerminalText 每次追加
   ├─ 运行状态 / 日志面板     ← setScriptRun / appendLog
   └─ postMessage RPC  ◄────►  Web Worker（vm 等价沙箱）
                                ├─ new Function 包装用户源码
                                ├─ nct.screen/session/log 代理
                                └─ 心跳（100ms）
```

对应 Netcatty：

| Netcatty | termX 阶段 1 |
|---|---|
| Electron renderer | React 渲染层 |
| preload + IPC | `worker.postMessage` / `onmessage` |
| main `scriptBridge` | TerminalPane 内脚本宿主 |
| `worker_threads` + `vm` | Web Worker + `new Function` |
| 主进程 `SessionOutputBuffer` | `SessionTextBuffer`（xterm 输出 tap） |
| `nct` 宿主 RPC |  Worker `rpc` → 主线程 `dispatch` |

### 3.2 为什么不用另外两种方案

| 方案 | 不采用原因 |
|---|---|
| Rust 侧 `rquickjs` | 异步等待/双向 RPC 需自建，复杂度远高于收益；崩溃会拖累后端 |
| Node/Deno sidecar | 新增外部进程、打包与签名成本，违背 Tauri 体积目标 |
| 直接 `eval` 在主线程 | 可访问 DOM / Tauri IPC / 全局状态，风险与卡死成本不可接受 |

**关键安全属性**：Worker 里没有 `window`，因此**拿不到 `window.__TAURI_INTERNALS__`**，默认不能调用 Tauri 命令、不能读写文件、不能操作 DOM。

---

## 4. `nct` API 兼容矩阵

| 分组 | API | 阶段 1 | 阶段 2/3 | termX 实现要点 |
|---|---|---|---|---|
| screen | `send(text)` | ✅ | — | `host.write(String(text))` |
| screen | `sendLine(text)` | ✅ | — | 先写文本，等 30ms，再写 `\r`；先记录缓冲长度避免吃掉后续输出 |
| screen | `clear()` | ✅ | — | 写 `ESC[2J ESC[H` |
| screen | `getText(startRow?, endRow?)` | ✅ | — | 基于文本缓冲按行切分；与 Netcatty 屏幕快照存在语义差异（见 §11） |
| screen | `waitForText(text, ms=30000)` | ✅ | — | 轮询 50ms，从发送起点扫描 |
| screen | `waitForRegex(pattern, ms=30000)` | ✅ | — | `RegExp(pattern, 'm')`；非法正则视为不匹配 |
| screen | `waitForPrompt(ms=60000)` | ✅ | — | 简化提示符规则 `[#$%]\s*$`；阶段 2 再对齐 Netcatty 多 shell 规则 |
| screen | `waitForAny(patterns[], ms=30000)` | ✅ | — | 任一命中即返回 |
| screen | `rows / cols / currentRow` | ❌ | 阶段 2 记录 | 需要屏幕快照 API |
| session | `sleep(ms)` | ✅ | — | `setTimeout` |
| session | `connected / name / hostname / username` | ✅ | — | 启动时快照；运行中不刷新 |
| session | `startLog / stopLog / disconnect` | ❌ | 阶段 2 记录 | 与现有 DB 会话日志语义不同 |
| dialog | `alert / confirm / prompt / form` | ❌ | 阶段 2 记录 | 需要 Promise 弹窗宿主 |
| progress | `start / set / step / done` | ❌ | 阶段 2 记录 | 需要运行面板 |
| log | `log(message)` | ✅ | — | 写入内存运行日志（最多 200 条） |

**明确的阶段 1 API 集合**（与上文一致）：

```text
screen.send / screen.sendLine / screen.clear / screen.getText
screen.waitForText / screen.waitForRegex / screen.waitForPrompt / screen.waitForAny
session.sleep / session.connected / session.name / session.hostname / session.username
log
```

---

## 5. 执行语义

### 5.1 源码包装（与 Netcatty 对齐）

| 写法 | 处理 |
|---|---|
| 以 `(async () => {` 开头 | 原样返回并执行 |
| 含 `async function main()` / `function main()` | 包裹后 `await main()` |
| 其它 | `(async () => { ... })()` |

### 5.2 `sendLine` 时序

1. `markSendStart()` 记录当前缓冲绝对长度。
2. 写命令文本。
3. 等待 30ms。
4. 写 `\r`。
5. `consumeThrough(before)`：后续等待只扫描发送之后的新输出。

目的：兼容会吞掉 `line\r` 单包的老式设备 / 跳板机，同时避免把发送后的提示符提前消费。

### 5.3 等待与缓冲

- `SessionTextBuffer` 保留最近 20 万字符；超限裁剪时同步修正游标。
- 每次 `wait*` 从当前游标扫描新文本，命中后游标推进到缓冲末尾。
- 默认轮询 50ms；不使用 `xterm` 的渲染回调，避免与高频输出耦合。
- 阶段 1 不区分“屏幕可视区”和“scrollback”；`getText` 返回的是文本缓冲（见 §11 偏差）。

### 5.4 超时 / 取消

| 项 | 阶段 1 取值 | 行为 |
|---|---|---|
| `waitForPrompt` | 60s | 超时抛 `waitFor prompt timed out`，运行标记 failed |
| 其它 `waitFor*` | 30s | 同上 |
| 单次脚本总时长 | 30 分钟 | 主线程定时器触发强制终止 |
| 同步死循环 | 2 秒无心跳 | `worker.terminate()`，运行标记 failed |
| 用户停止 | 立即 | 置 `aborted`，终止 worker，拒绝未完成 RPC，标记 stopped |

> 阶段 1 **不做**“超时后重试/跳过/中止”弹窗（阶段 2）。超时一律按失败处理。

### 5.5 暂停 / 恢复（仅记录，本期不启用）

设计预留：主线程在每个 RPC 前检查 `paused`，为真则 50ms 轮询等待；暂停不终止 worker。
阶段 1 只暴露 `stop`，不渲染暂停按钮。

### 5.6 运行状态机

```
idle → running → completed
              ├→ failed（超时 / 异常 / 死循环）
              └→ stopped（用户停止）
```

同一会话同一时刻只允许一个脚本运行；运行中再次点击“运行”直接提示“当前会话已有脚本在运行”。

---

## 6. 数据模型与兼容策略

### 6.1 `language` 语义化（不新增 DB schema）

| `language` | 行为 |
|---|---|
| `""` / `"shell"` | 旧路径：`scriptRunner` 的 `#@wait-*` 文本子集 |
| `"javascript"` | 新路径：Web Worker + nct 运行时 |

- 新建脚本默认写 `"javascript"`。
- 已有脚本保持原值，不做自动改写；可在编辑器提示“升级为 JavaScript（需手动改写）”。
- 存储仍是 `snippets.json`，**不需要 DB schema 版本变更**（当前 schema 版本 52 与本模块无关）。

### 6.2 可选字段

- `script_api_version?: number`：未来 nct API 破坏性升级时使用；阶段 1 固定为 `1`，不写入也可按 1 处理。
- 运行历史不落库：与 Netcatty 一致只放内存（最多 200 条，每条最多 200 行日志）。

### 6.3 变量替换

- 阶段 1 在**执行前**完成 `{{name}}` / `{{name:默认值}}` 替换，再交给运行时编译。
- 脚本编辑区恢复变量提示（当前只在非脚本区显示，需要一并修正逻辑）。

---

## 7. 权限与沙箱边界

### 7.1 威胁模型

- 脚本可向当前会话发送任意命令（等价于用户手动输入），可读取屏幕文本，可写运行日志。
- 阶段 1 **只允许手动运行**，不把 JS 接到 onConnect / onOutput，避免自动执行放大风险。
- 脚本来源可能是用户自己编写，也可能是导入的第三方脚本包。

### 7.2 沙箱措施（与 Netcatty 同等定位：防呆，不防恶意）

1. Worker 中无 `window` / `document`，因此无法访问 Tauri IPC 与 DOM。
2. 包装函数时把以下全局以参数形式置空：
   `fetch`、`XMLHttpRequest`、`WebSocket`、`indexedDB`、`importScripts`、`Function`。
3. 源码使用 `"use strict"`。
4. 资源上限：日志 200 条、待处理 RPC 128 条、总通知 20000 条（超出终止）。
5. 2 秒无心跳强制终止；30 分钟总超时。
6. 所有 `screen.send/sendLine` 写入运行日志；后续可对敏感输入做掩码（阶段 2）。

> **必须写明的局限**：浏览器 Worker 不是安全边界，`eval` / 构造器链仍可能绕过全局屏蔽；这与 Netcatty 的 Node `vm` 定位一致（Node 官方也明确 `vm` 不是安全机制）。若需要真正隔离，应改用跨源 `sandbox="allow-scripts"` iframe 或 Rust `rquickjs`，而不是继续在 Worker 内加固。

### 7.3 提示与确认

- 编辑器与运行按钮旁标注“脚本会向当前会话发送命令”。
- 导入 `language=javascript` 的外部脚本包时标记“外部脚本”，首次运行建议二次确认（阶段 1 可先用提示文案，弹窗交互留到阶段 2）。
- 阶段 1 不提供 Observer/确认/自动三档权限；该能力记录在 §10。

---

## 8. 代码骨架

> 下列代码为目标形态骨架，用于后续实现参考；本轮文档不改动仓库代码。

### 8.1 新增文件

```text
src/snippets/sessionTextBuffer.ts   # 文本缓冲 + 等待
src/snippets/nctRuntime.ts          # 主线程宿主：worker 生命周期、RPC、超时、停止
src/snippets/scriptWorker.ts        # Worker 沙箱 + nct 代理
src/snippets/ScriptCodeEditor.tsx   # CodeMirror 6
src/snippets/ScriptRunPanel.tsx     # 运行状态 + 日志（阶段 1 最简版）
```

### 8.2 `sessionTextBuffer.ts`

```ts
export type WaitKind = "text" | "regex" | "prompt" | "any";

export class SessionTextBuffer {
  private text = "";
  private cursor = 0;
  private readonly maxChars = 200_000;

  append(chunk: string): void {
    if (!chunk) return;
    this.text += chunk;
    if (this.text.length > this.maxChars) {
      const cut = this.text.length - this.maxChars + 50_000;
      this.text = this.text.slice(cut);
      this.cursor = Math.max(0, this.cursor - cut);
    }
  }

  getText(): string {
    return this.text;
  }

  markSendStart(): number {
    return this.text.length;
  }

  consumeThrough(length: number): void {
    this.cursor = Math.min(this.text.length, Math.max(this.cursor, length));
  }

  async wait(kind: WaitKind, patterns: string[], timeoutMs: number, isAborted: () => boolean): Promise<boolean> {
    const startedAt = Date.now();
    while (true) {
      if (isAborted()) throw new Error("Script stopped");
      const fresh = this.text.slice(this.cursor);

      let hit = false;
      if (kind === "text") {
        hit = patterns.some((p) => fresh.includes(p));
      } else if (kind === "prompt") {
        // 阶段 1 简化；阶段 2 对齐 Netcatty 的多 shell 提示符规则
        hit = /[#$%]\s*$/.test(fresh);
      } else {
        hit = patterns.some((p) => {
          try {
            return new RegExp(p, "m").test(fresh);
          } catch {
            return false;
          }
        });
      }

      if (hit) {
        this.cursor = this.text.length;
        return true;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`waitFor ${kind} timed out after ${timeoutMs}ms`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}
```

### 8.3 `nctRuntime.ts`（主线程宿主）

```ts
import { SessionTextBuffer, type WaitKind } from "./sessionTextBuffer";

export interface NctScriptMeta {
  name: string;
  hostname: string;
  username: string;
}

export interface NctScriptHost {
  write(text: string): void;
  buffer: SessionTextBuffer;
  connected(): boolean;
  meta(): NctScriptMeta;
  onLog(line: string): void;
  onStatus(status: { waitingFor?: string }): void;
}

export interface ScriptRunHandle {
  runId: string;
  done: Promise<void>;
  stop(): void;
}

type WorkerOut =
  | { type: "rpc"; id: number; method: string; args: unknown[] }
  | { type: "notify"; method: string; args: unknown[] }
  | { type: "heartbeat" }
  | { type: "done"; ok: true }
  | { type: "done"; ok: false; error: string };

const HEARTBEAT_LIMIT_MS = 2_000;
const MAX_RUN_MS = 30 * 60 * 1_000;
const MAX_LOGS = 200;

export function startNctScript(source: string, host: NctScriptHost, runId = crypto.randomUUID()): ScriptRunHandle {
  const worker = new Worker(new URL("./scriptWorker.ts", import.meta.url), { type: "module" });

  let settled = false;
  let aborted = false;
  let lastBeat = Date.now();
  let logCount = 0;
  let resolveDone: () => void = () => {};
  let rejectDone: (error: Error) => void = () => {};

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearInterval(beatTimer);
    clearTimeout(maxTimer);
    worker.terminate();
    if (error) rejectDone(error);
    else resolveDone();
  };

  const beatTimer = window.setInterval(() => {
    if (!settled && Date.now() - lastBeat > HEARTBEAT_LIMIT_MS) {
      finish(new Error(`Script execution timed out after ${HEARTBEAT_LIMIT_MS}ms (blocking loop?)`));
    }
  }, 250);

  const maxTimer = window.setTimeout(() => {
    finish(new Error("Script exceeded max run time"));
  }, MAX_RUN_MS);

  const dispatch = async (method: string, args: unknown[]): Promise<unknown> => {
    if (aborted) throw new Error("Script stopped");
    switch (method) {
      case "screen.send":
        host.write(String(args[0] ?? ""));
        return undefined;

      case "screen.sendLine": {
        const before = host.buffer.markSendStart();
        const line = String(args[0] ?? "");
        if (line) {
          host.write(line);
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
        }
        host.write("\r");
        host.buffer.consumeThrough(before);
        return undefined;
      }

      case "screen.clear":
        host.write("\x1b[2J\x1b[H");
        return undefined;

      case "screen.getText": {
        const lines = host.buffer.getText().split("\n");
        const start = Number(args[0] ?? 0);
        const end = typeof args[1] === "number" ? Number(args[1]) : lines.length - 1;
        return lines.slice(Math.max(0, start), Math.min(lines.length - 1, end) + 1).join("\n");
      }

      case "screen.waitForText":
      case "screen.waitForRegex":
      case "screen.waitForPrompt":
      case "screen.waitForAny": {
        const kind: WaitKind =
          method === "screen.waitForText" ? "text"
            : method === "screen.waitForRegex" ? "regex"
            : method === "screen.waitForPrompt" ? "prompt"
            : "any";
        const patterns =
          kind === "any" ? (args[0] as string[])
            : kind === "prompt" ? ["prompt"]
            : [String(args[0] ?? "")];
        const timeoutMs =
          kind === "prompt" ? Number(args[0] ?? 60_000) : Number(args[1] ?? 30_000);

        host.onStatus({ waitingFor: kind === "prompt" ? "prompt" : patterns.join(" | ") });
        try {
          return await host.buffer.wait(kind, patterns, timeoutMs, () => aborted);
        } finally {
          host.onStatus({ waitingFor: undefined });
        }
      }

      case "log":
        return undefined;

      default:
        throw new Error(`nct method not supported in phase 1: ${method}`);
    }
  };

  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const message = event.data;
    if (settled) return;

    if (message.type === "heartbeat") {
      lastBeat = Date.now();
      return;
    }
    if (message.type === "notify") {
      if (message.method === "log" && logCount < MAX_LOGS) {
        logCount += 1;
        host.onLog(String(message.args[0] ?? ""));
      }
      return;
    }
    if (message.type === "rpc") {
      void dispatch(message.method, message.args).then(
        (value) => worker.postMessage({ type: "rpc-result", id: message.id, ok: true, value }),
        (error: unknown) =>
          worker.postMessage({
            type: "rpc-result",
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
      return;
    }
    if (message.type === "done") {
      finish(message.ok ? undefined : new Error(message.error));
    }
  };

  worker.postMessage({
    type: "start",
    source,
    snapshot: { ...host.meta(), connected: host.connected() },
  });

  return {
    runId,
    done,
    stop() {
      aborted = true;
      worker.postMessage({ type: "stop" });
      finish(new Error("Script stopped"));
    },
  };
}
```

### 8.4 `scriptWorker.ts`（沙箱 + nct 代理）

```ts
interface WorkerPort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

const port = self as unknown as WorkerPort;

interface Snapshot {
  connected: boolean;
  name: string;
  hostname: string;
  username: string;
}

let snapshot: Snapshot = { connected: false, name: "", hostname: "", username: "" };
let heartbeat = 0;
let nextRpcId = 1;

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function callHost(method: string, args: unknown[]): Promise<unknown> {
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ type: "rpc", id, method, args });
  });
}

function notifyHost(method: string, args: unknown[]): void {
  port.postMessage({ type: "notify", method, args });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const nct = {
  version: "1.0.0",
  sleep,
  log: (message: unknown) => notifyHost("log", [String(message ?? "")]),
  session: {
    sleep,
    get connected() {
      return snapshot.connected;
    },
    get name() {
      return snapshot.name;
    },
    get hostname() {
      return snapshot.hostname;
    },
    get username() {
      return snapshot.username;
    },
  },
  screen: {
    send: (text: unknown) => callHost("screen.send", [String(text ?? "")]),
    sendLine: (text: unknown) => callHost("screen.sendLine", [String(text ?? "")]),
    clear: () => callHost("screen.clear", []),
    getText: (startRow?: number, endRow?: number) => callHost("screen.getText", [startRow, endRow]),
    waitForText: (text: unknown, ms = 30_000) => callHost("screen.waitForText", [String(text), ms]),
    waitForRegex: (pattern: unknown, ms = 30_000) => callHost("screen.waitForRegex", [String(pattern), ms]),
    waitForPrompt: (ms = 60_000) => callHost("screen.waitForPrompt", [ms]),
    waitForAny: (patterns: unknown[], ms = 30_000) => callHost("screen.waitForAny", [patterns, ms]),
  },
};

function wrapSource(source: string): string {
  const trimmed = source.trim();
  if (/^\(\s*async\s*\(\s*\)\s*=>/m.test(trimmed)) {
    return `"use strict";\nreturn ${trimmed};`;
  }
  const hasMain = /\basync\s+function\s+main\s*\(/m.test(trimmed) || /\bfunction\s+main\s*\(/m.test(trimmed);
  if (hasMain) {
    return `"use strict";\n${trimmed}\nreturn await main();`;
  }
  return `"use strict";\nreturn (async () => {\n${trimmed}\n})();`;
}

async function run(source: string): Promise<void> {
  // 注意：eval 无法用参数名屏蔽（严格模式下会语法错误）；这里屏蔽常用网络/加载/动态代码入口
  const factory = new Function(
    "nct",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "indexedDB",
    "importScripts",
    "Function",
    wrapSource(source),
  );
  await factory(nct, undefined, undefined, undefined, undefined, undefined, undefined);
}

port.onmessage = (event: MessageEvent) => {
  const message = event.data as
    | { type: "start"; source: string; snapshot: Snapshot }
    | { type: "rpc-result"; id: number; ok: true; value: unknown }
    | { type: "rpc-result"; id: number; ok: false; error: string }
    | { type: "stop" };

  if (message.type === "start") {
    snapshot = message.snapshot;
    heartbeat = setInterval(() => port.postMessage({ type: "heartbeat" }), 100) as unknown as number;
    void run(message.source).then(
      () => {
        clearInterval(heartbeat);
        port.postMessage({ type: "done", ok: true });
      },
      (error: unknown) => {
        clearInterval(heartbeat);
        port.postMessage({
          type: "done",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return;
  }

  if (message.type === "rpc-result") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error));
    return;
  }

  if (message.type === "stop") {
    for (const entry of pending.values()) entry.reject(new Error("Script stopped"));
    pending.clear();
  }
};
```

### 8.5 `ScriptCodeEditor.tsx`（CodeMirror 6）

新增依赖（仅前端）：`codemirror`、`@codemirror/view`、`@codemirror/lang-javascript`。

```tsx
import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";

export interface ScriptCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  height?: number;
}

export function ScriptCodeEditor({ value, onChange, onRun, height = 360 }: ScriptCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const runRef = useRef(onRun);
  const changeRef = useRef(onChange);
  runRef.current = onRun;
  changeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        basicSetup,
        javascript(),
        EditorView.theme({
          "&": { height: `${height}px` },
          ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
        }),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              runRef.current?.();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changeRef.current(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="sn-cm-host" />;
}
```

### 8.6 接线点（伪补丁）

```ts
// TerminalPane：输出 tap + 句柄
const scriptBufferRef = useRef(new SessionTextBuffer());

// writeTerminalText 内，decode 之后：
scriptBufferRef.current.append(text);
writeFilteredText(text);

// PaneHandle 新增（阶段 1）
runNctScript: (snippet) => {
  if (!connected()) return false;
  activeScriptRef.current = startNctScript(snippet.command, {
    write: (text) => { if (aliveRef.current) writeToPane(text); },
    buffer: scriptBufferRef.current,
    connected,
    meta: () => ({ name: hostLabel, hostname, username }),
    onLog: (line) => appendScriptRunLog(paneId, line),
    onStatus: (status) => setScriptRunStatus(paneId, status),
  });
  return true;
},
scriptControl: (action) => {
  if (action !== "stop") return false;
  activeScriptRef.current?.stop();
  activeScriptRef.current = null;
  return true;
},
```

```ts
// SnippetsView：按 language 分流
const isNctScript = (snippet: Snippet) => snippet.kind === "script" && snippet.language === "javascript";

const sendSnippet = (snippet: Snippet, fromPanel = false) => {
  if (isNctScript(snippet)) {
    if (!activeHandle?.runNctScript(snippet)) {
      setNotice("脚本未能启动：终端未就绪。");
      return;
    }
  } else if (!activeHandle?.runSnippet(snippet)) {
    setNotice("脚本未能发送：终端未就绪。");
    return;
  }
  setRun({ name: snippet.name, paneId: activeHandle!.paneId });
  if (fromPanel) setIsNew(false);
};
```

---

## 9. 测试与验收

### 9.1 阶段 0 spike（阶段 1 的前置门槛）

必须先验证以下全部通过，否则暂停阶段 1 并记录失败原因：

1. WebView2 中 `new Worker(new URL(...), { type: "module" })` 可正常创建并双向通信。
2. Worker 内 `new Function` 可执行 `async` 代码，`await` 生效。
3. Worker 内 `typeof window === "undefined"`，`typeof (globalThis as any).__TAURI_INTERNALS__ === "undefined"`。
4. `nct.screen.sendLine('echo hi')` + `waitForText('hi')` 在本地终端与 SSH 129 上均成功。
5. `while(true){}` 能在 2 秒左右被 terminate，且主线程不卡顿。

### 9.2 单元测试

| 用例 | 期望 |
|---|---|
| 三种源码包装 | 分别命中 IIFE / `main()` / 默认包裹 |
| `SessionTextBuffer` 裁剪 | 裁剪后游标不越界、旧文本不再匹配 |
| `waitForText` 超时 | 抛错且错误文案含 API 名与毫秒数 |
| `sendLine` 时序 | 写入顺序为“文本 → 30ms → `\r`” |
| 停止 | 等待中的脚本立即 reject，`done` 为 stopped |
| 日志上限 | 超过 200 条后不再追加 |
| `language` 分流 | `javascript` 走新路径，空值 / `shell` 走旧路径 |
| 变量替换 | `{{name}}`、`{{name:默认}}` 均正确 |

### 9.3 集成 / 实机用例（129 SSH + 本地终端）

1. `echo` + `waitForText`，屏幕上能看到输出。
2. `uname -a` + `waitForRegex('Linux|Darwin')`。
3. `sudo` 类交互：`waitForPrompt` 命中后继续发送。
4. 超时脚本：等待不存在的文本 30s 后失败，UI 显示错误。
5. 停止：长等待中点击停止，立即结束且终端未断开。
6. 死循环：`while(true){}` 2 秒内被终止。
7. 非法代码（语法错误）：运行面板显示错误信息，终端不受影响。
8. 旧脚本回归：`language` 为空 / `shell` 的脚本仍按原方式运行。

### 9.4 安全测试

- Worker 内 `fetch` 为 `undefined`（调用报错）。
- Worker 内无法访问 `window.__TAURI_INTERNALS__`。
- 尝试 `importScripts` 报错。
- 停止后 worker 确实被销毁（连续 10 次运行不累积线程）。

### 9.5 门禁（实现阶段执行）

```bash
npm run test:run
npm run build
cargo check          # 含 server
cargo test --lib
```

---

## 10. 阶段 2 / 阶段 3（本期不做，仅记录）

### 10.1 阶段 2

- `nct.dialog.alert/confirm/prompt/form`（表单支持 select/radio/checkbox/textarea/number + `visibleWhen`）。
- `nct.progress.start/set/step/done`。
- 脚本级暂停 / 恢复（RPC 前挂起）。
- 等待超时“重试 / 跳过 / 中止”弹窗。
- `session.startLog / stopLog / disconnect`。
- 录制生成 JS（对齐 `stepsToJavaScript`）。
- 运行历史列表（状态、耗时、等待目标、日志弹窗）。

### 10.2 阶段 3

- 多目标运行：主机 / 组选择、自动连接、`sequential | parallel`、同会话串行队列。
- `onConnect` / `onOutput` 改为执行 JS；onOutput 改为流式分块扫描 + 重叠 + 可重复触发。
- `targetGroups` 动态组解析。
- 主机级连接脚本队列（`connectScriptIds` / `outputTriggers`）。
- 权限模式（Observer / 每次确认 / 自动）与审计增强。
- 脚本包分享对齐（导出不写具体 `targets`）。

---

## 11. 仍需实机确认的 5 点

1. **WebView2 对 module Worker + `new Function` 的真实行为**：必须在真实 termX 窗口跑通阶段 0 spike，不能只依赖开发服务器或单测环境。
2. **SSH 129 的 `sendLine` 两包时序**：30ms 是否足够；若某些设备吞包，需要按设备类型调整或改为可配置。
3. **`screen.getText` 的行号语义**：termX 基于 xterm 文本缓冲（含 scrollback），Netcatty 基于屏幕快照（仅可视区）。需确认用户期望并决定是否阶段 2 引入屏幕快照。
4. **会话日志语义**：`nct.session.startLog(path)` 与 termX 现有 DB 索引式会话日志不一致；阶段 2 需产品确认是“映射”还是“扩展命令”。
5. **多目标自动连接**（阶段 3）：需要确认是否复用现有“打开主机”流程、焦点切换与失败回滚策略。

---

## 12. 参考资料

- 差异清单：[script-runtime-diff.md](./script-runtime-diff.md)
- Netcatty API 参考：[scriptApiReference.ts](../../Netcatty/domain/scriptApiReference.ts)
- Netcatty 沙箱：[scriptExecutionWorker.cjs](../../Netcatty/electron/scripts/scriptExecutionWorker.cjs)
- Netcatty 宿主运行时：[scriptRuntime.cjs](../../Netcatty/electron/scripts/scriptRuntime.cjs)
- Netcatty 运行调度：[scriptBridge.cjs](../../Netcatty/electron/bridges/scriptBridge.cjs)
- termX 现有执行器：[scriptRunner.ts](../src/snippets/scriptRunner.ts)
- termX 脚本视图：[SnippetsView.tsx](../src/snippets/SnippetsView.tsx)
