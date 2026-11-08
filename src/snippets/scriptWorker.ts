// 脚本执行 Worker：只注入 `nct`，其余宿主能力通过 postMessage RPC 回主线程。
//
// 与 Netcatty `scriptExecutionWorker.cjs` 的差异：浏览器 Worker 没有
// `Atomics/SharedArrayBuffer` 心跳，改为 100ms 定时 postMessage；看门狗在主线程。
// 沙箱全局屏蔽由 `scriptSandbox.ts` 在编译用户源码时完成。

import { compileScriptRunner } from "./scriptSandbox";
import type {
  NctScriptSessionSnapshot,
  SerializedScriptError,
} from "./nctRuntime";

interface StartConfig {
  source: string;
  filename: string;
  snapshot: NctScriptSessionSnapshot;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const HEARTBEAT_INTERVAL_MS = 100;

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data?: unknown }) => void): void;
};

const pending = new Map<number, PendingRequest>();
let nextRequestId = 1;
let started = false;
let finished = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let snapshot: NctScriptSessionSnapshot = {
  connected: false,
  name: "",
  hostname: "",
  username: "",
};

function post(message: unknown): void {
  scope.postMessage(message);
}

function beat(): void {
  if (!finished) post({ type: "heartbeat" });
}

function reviveError(value: SerializedScriptError | undefined): Error {
  const error = new Error(value?.message || "Script API request failed");
  error.name = value?.name || "Error";
  if (typeof value?.stack === "string") error.stack = value.stack;
  return error;
}

function callHost(method: string, args: unknown[] = []): Promise<unknown> {
  if (finished) return Promise.reject(new Error("Script execution finished"));
  const requestId = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    post({ type: "rpc", requestId, method, args });
  });
}

function notifyHost(method: string, args: unknown[] = []): void {
  if (finished) return;
  post({ type: "notify", method, args });
}

const nct = {
  screen: {
    send: (text: unknown) => callHost("screen.send", [String(text ?? "")]),
    sendLine: (text: unknown) => callHost("screen.sendLine", [String(text ?? "")]),
    clear: () => callHost("screen.clear", []),
    getText: (startRow?: number, endRow?: number) =>
      callHost("screen.getText", [startRow, endRow]),
    waitForText: (text: unknown, timeoutMs?: number) =>
      callHost("screen.waitForText", [String(text ?? ""), timeoutMs]),
    waitForRegex: (pattern: unknown, timeoutMs?: number) =>
      callHost("screen.waitForRegex", [String(pattern ?? ""), timeoutMs]),
    waitForPrompt: (timeoutMs?: number) => callHost("screen.waitForPrompt", [timeoutMs]),
    waitForAny: (patterns: unknown, timeoutMs?: number) =>
      callHost("screen.waitForAny", [
        Array.isArray(patterns) ? patterns.map(String) : [],
        timeoutMs,
      ]),
  },
  session: {
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
    sleep: (ms: number) => callHost("session.sleep", [Number(ms) || 0]),
  },
  log(message: unknown) {
    notifyHost("log", [String(message ?? "")]);
  },
};

async function run(config: StartConfig): Promise<void> {
  snapshot = {
    connected: Boolean(config.snapshot?.connected),
    name: String(config.snapshot?.name ?? ""),
    hostname: String(config.snapshot?.hostname ?? ""),
    username: String(config.snapshot?.username ?? ""),
  };
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  beat();
  try {
    const runner = compileScriptRunner(config.source);
    await runner(nct);
    finished = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    post({ type: "completed" });
  } catch (error) {
    finished = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    post({
      type: "failed",
      error: {
        name: (error as { name?: string })?.name || "Error",
        message: (error as { message?: string })?.message || String(error),
        stack: (error as { stack?: string })?.stack,
      } satisfies SerializedScriptError,
    });
  }
}

scope.addEventListener("message", (event) => {
  const message = event.data as
    | { type: "start"; config: StartConfig }
    | {
        type: "rpc-result";
        requestId: number;
        ok: boolean;
        value?: unknown;
        error?: SerializedScriptError;
      }
    | undefined;
  if (!message) return;
  if (message.type === "start") {
    if (started) return;
    started = true;
    void run(message.config);
    return;
  }
  if (message.type === "rpc-result") {
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(reviveError(message.error));
  }
});

post({ type: "ready" });
