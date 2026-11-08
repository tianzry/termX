// 脚本运行时宿主（渲染层主线程）。
//
// 对应 Netcatty `electron/scripts/scriptRuntime.cjs`：负责 Worker 生命周期、
// RPC 转发、心跳看门狗、总超时与停止。真正的终端操作由注入的 `NctScriptApi`
// 完成（见 block 3 的 `createNctScriptApi`），本模块只处理协议与资源上限。
//
// 资源上限（超出即终止运行）：
// - 待处理 RPC 128、日志 200 条、总通知 20000 条；
// - 2 秒无心跳（同步死循环）、单次运行 30 分钟。

export interface NctScriptSessionSnapshot {
  connected: boolean;
  name: string;
  hostname: string;
  username: string;
}

/** 脚本可调用的宿主能力子集（阶段 1）。 */
export interface NctScriptApi extends NctScriptSessionSnapshot {
  send(text: string): void;
  sendLine(text: string): Promise<void>;
  clear(): void;
  getText(startRow?: number, endRow?: number): string;
  waitForText(text: string, timeoutMs?: number): Promise<string>;
  waitForRegex(pattern: string, timeoutMs?: number): Promise<string>;
  waitForPrompt(timeoutMs?: number): Promise<string>;
  waitForAny(patterns: string[], timeoutMs?: number): Promise<number>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /** 终止未完成的等待（停止 / 运行结束时由宿主调用）。 */
  abort?(): void;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export type NctScriptStatus = "running" | "completed" | "failed" | "stopped";

export type NctScriptRunResult =
  | { status: "completed" }
  | { status: "failed"; error: string }
  | { status: "stopped" };

export interface NctScriptRunHandle {
  runId: string;
  done: Promise<NctScriptRunResult>;
  status(): NctScriptStatus;
  stop(): void;
}

export interface StartNctScriptOptions {
  source: string;
  api: NctScriptApi;
  runId?: string;
  createWorker?: () => WorkerLike;
  heartbeatTimeoutMs?: number;
  maxRunMs?: number;
  startTimeoutMs?: number;
  maxPendingRequests?: number;
  maxLogNotifications?: number;
  maxTotalNotifications?: number;
  onLog?: (line: string) => void;
  onStatus?: (status: NctScriptStatus) => void;
}

export interface SerializedScriptError {
  name: string;
  message: string;
  stack?: string;
}

export const SCRIPT_LIMITS = {
  heartbeatTimeoutMs: 2_000,
  maxRunMs: 30 * 60 * 1_000,
  startTimeoutMs: 5_000,
  maxPendingRequests: 128,
  maxLogNotifications: 200,
  maxTotalNotifications: 20_000,
} as const;

const SERIALIZED_NOTIFY_METHODS = new Set(["log", "console.log"]);
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_PROMPT_WAIT_MS = 60_000;

type WorkerMessage =
  | { type: "ready" }
  | { type: "heartbeat" }
  | { type: "rpc"; requestId: number; method: string; args: unknown[] }
  | { type: "notify"; method: string; args: unknown[] }
  | { type: "completed" }
  | { type: "failed"; error: SerializedScriptError };

type HostMessage =
  | {
      type: "start";
      config: {
        source: string;
        filename: string;
        snapshot: NctScriptSessionSnapshot;
      };
    }
  | {
      type: "rpc-result";
      requestId: number;
      ok: boolean;
      value?: unknown;
      error?: SerializedScriptError;
    };

export function serializeScriptError(error: unknown): SerializedScriptError {
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "Error",
      message:
        typeof candidate.message === "string" ? candidate.message : String(error),
      stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
    };
  }
  return { name: "Error", message: String(error) };
}

/** 默认 Worker 工厂：Vite 会把 `scriptWorker.ts` 打包成独立 worker chunk。 */
export function createDefaultScriptWorker(): WorkerLike {
  return new Worker(new URL("./scriptWorker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

function describeStart(api: NctScriptApi): NctScriptSessionSnapshot {
  return {
    connected: api.connected,
    name: api.name,
    hostname: api.hostname,
    username: api.username,
  };
}

function makeRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 启动一次脚本运行。源码为空会同步抛错；其余失败通过 `done` 的
 * `failed` 结果返回，不 reject Promise。
 */
export function startNctScript(options: StartNctScriptOptions): NctScriptRunHandle {
  if (!String(options.source ?? "").trim()) throw new Error("Script content is empty");

  const runId = options.runId ?? makeRunId();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? SCRIPT_LIMITS.heartbeatTimeoutMs;
  const maxRunMs = options.maxRunMs ?? SCRIPT_LIMITS.maxRunMs;
  const startTimeoutMs = options.startTimeoutMs ?? SCRIPT_LIMITS.startTimeoutMs;
  const maxPendingRequests = options.maxPendingRequests ?? SCRIPT_LIMITS.maxPendingRequests;
  const maxLogNotifications = options.maxLogNotifications ?? SCRIPT_LIMITS.maxLogNotifications;
  const maxTotalNotifications = options.maxTotalNotifications ?? SCRIPT_LIMITS.maxTotalNotifications;

  const api = options.api;
  const worker = (options.createWorker ?? createDefaultScriptWorker)();

  let status: NctScriptStatus = "running";
  let settled = false;
  let lastHeartbeat = Date.now();
  let pendingCount = 0;
  let logCount = 0;
  let notifyCount = 0;

  let resolveDone!: (result: NctScriptRunResult) => void;
  const done = new Promise<NctScriptRunResult>((resolve) => {
    resolveDone = resolve;
  });

  const heartbeatWatchdog = setInterval(() => {
    if (settled) return;
    if (Date.now() - lastHeartbeat > heartbeatTimeoutMs) {
      finish({
        status: "failed",
        error: `Script execution timed out after ${heartbeatTimeoutMs}ms (no heartbeat)`,
      });
    }
  }, Math.max(20, Math.min(100, Math.floor(heartbeatTimeoutMs / 4))));

  const totalTimer = setTimeout(() => {
    finish({
      status: "failed",
      error: `Script execution timed out after ${maxRunMs}ms`,
    });
  }, maxRunMs);

  const startTimer = setTimeout(() => {
    finish({
      status: "failed",
      error: `Script worker failed to start after ${startTimeoutMs}ms`,
    });
  }, startTimeoutMs);

  function finish(result: NctScriptRunResult): void {
    if (settled) return;
    settled = true;
    status = result.status;
    clearInterval(heartbeatWatchdog);
    clearTimeout(totalTimer);
    clearTimeout(startTimer);
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    try {
      worker.terminate();
    } catch {
      // Worker 可能已经退出；忽略重复 terminate。
    }
    try {
      api.abort?.();
    } catch {
      // 等待者清理失败不应影响运行结果。
    }
    options.onStatus?.(result.status);
    resolveDone(result);
  }

  function respond(
    requestId: number,
    response: { ok: true; value: unknown } | { ok: false; error: SerializedScriptError },
  ): void {
    if (settled) return;
    const message: HostMessage =
      response.ok
        ? { type: "rpc-result", requestId, ok: true, value: response.value }
        : { type: "rpc-result", requestId, ok: false, error: response.error };
    try {
      worker.postMessage(message);
    } catch {
      // Worker 已终止：RPC 结果不再需要送达。
    }
  }

  function handleRpc(message: { requestId: number; method: string; args: unknown[] }): void {
    if (pendingCount >= maxPendingRequests) {
      finish({
        status: "failed",
        error: `Script exceeded the ${maxPendingRequests} pending host request limit`,
      });
      return;
    }
    pendingCount += 1;
    Promise.resolve()
      .then(() => invokeApi(api, message.method, message.args))
      .then(
        (value) => respond(message.requestId, { ok: true, value }),
        (error) => respond(message.requestId, { ok: false, error: serializeScriptError(error) }),
      )
      .finally(() => {
        pendingCount -= 1;
      });
  }

  function handleNotify(message: { method: string; args: unknown[] }): void {
    notifyCount += 1;
    if (notifyCount > maxTotalNotifications) {
      finish({
        status: "failed",
        error: `Script exceeded the ${maxTotalNotifications} notification limit`,
      });
      return;
    }
    if (!SERIALIZED_NOTIFY_METHODS.has(message.method)) return;
    logCount += 1;
    if (logCount > maxLogNotifications) {
      finish({
        status: "failed",
        error: `Script exceeded the ${maxLogNotifications} log notification limit`,
      });
      return;
    }
    const line = message.args.map((arg) => String(arg ?? "")).join(" ");
    api.log(line);
    options.onLog?.(line);
  }

  const onMessage = (event: unknown): void => {
    if (settled) return;
    const message = (event as { data?: WorkerMessage }).data;
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "ready": {
        clearTimeout(startTimer);
        lastHeartbeat = Date.now();
        const config: HostMessage = {
          type: "start",
          config: {
            source: options.source,
            filename: `script-${runId}.js`,
            snapshot: describeStart(api),
          },
        };
        try {
          worker.postMessage(config);
        } catch (error) {
          finish({ status: "failed", error: serializeScriptError(error).message });
        }
        return;
      }
      case "heartbeat":
        lastHeartbeat = Date.now();
        return;
      case "rpc":
        handleRpc(message as { requestId: number; method: string; args: unknown[] });
        return;
      case "notify":
        handleNotify(message as { method: string; args: unknown[] });
        return;
      case "completed":
        finish({ status: "completed" });
        return;
      case "failed":
        finish({
          status: "failed",
          error: message.error?.message || "Script failed",
        });
        return;
      default:
        return;
    }
  };

  const onError = (event: unknown): void => {
    const error = event as { message?: unknown } | string;
    const message =
      typeof error === "string"
        ? error
        : typeof error?.message === "string"
          ? error.message
          : "Script worker crashed";
    finish({ status: "failed", error: message });
  };

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);

  options.onStatus?.("running");

  return {
    runId,
    done,
    status: () => status,
    stop: () => finish({ status: "stopped" }),
  };
}

/** 把 Worker 发来的 RPC 方法分发到宿主 API。 */
export async function invokeApi(
  api: NctScriptApi,
  method: string,
  args: unknown[],
): Promise<unknown> {
  switch (method) {
    case "screen.send":
      return api.send(String(args[0] ?? ""));
    case "screen.sendLine":
      return api.sendLine(String(args[0] ?? ""));
    case "screen.clear":
      return api.clear();
    case "screen.getText":
      return api.getText(
        args[0] == null ? undefined : Number(args[0]),
        args[1] == null ? undefined : Number(args[1]),
      );
    case "screen.waitForText":
      return api.waitForText(
        String(args[0] ?? ""),
        args[1] == null ? DEFAULT_WAIT_MS : Number(args[1]),
      );
    case "screen.waitForRegex":
      return api.waitForRegex(
        String(args[0] ?? ""),
        args[1] == null ? DEFAULT_WAIT_MS : Number(args[1]),
      );
    case "screen.waitForPrompt":
      return api.waitForPrompt(args[0] == null ? DEFAULT_PROMPT_WAIT_MS : Number(args[0]));
    case "screen.waitForAny": {
      const patterns = Array.isArray(args[0]) ? args[0].map(String) : [];
      return api.waitForAny(
        patterns,
        args[1] == null ? DEFAULT_WAIT_MS : Number(args[1]),
      );
    }
    case "session.sleep":
      return api.sleep(Number(args[0]) || 0);
    default:
      throw new Error(`Unknown script API method: ${method}`);
  }
}
