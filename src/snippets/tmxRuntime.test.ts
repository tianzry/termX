import { describe, expect, it, vi } from "vitest";
import {
  SCRIPT_LIMITS,
  invokeApi,
  startTmxScript,
  type TmxScriptApi,
  type WorkerLike,
} from "./tmxRuntime";

class FakeWorker implements WorkerLike {
  posted: Array<Record<string, unknown>> = [];
  terminated = false;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(data: unknown): void {
    for (const listener of [...(this.listeners.get("message") ?? [])]) {
      listener({ data });
    }
  }

  emitError(message: string): void {
    for (const listener of [...(this.listeners.get("error") ?? [])]) {
      listener({ message });
    }
  }

  replies(): Array<Record<string, unknown>> {
    return this.posted.filter((message) => message.type === "rpc-result");
  }
}

function createApi(overrides: Partial<TmxScriptApi> = {}): TmxScriptApi {
  return {
    connected: true,
    name: "session-a",
    hostname: "host-a",
    username: "user-a",
    send: vi.fn(),
    sendLine: vi.fn(async () => {}),
    clear: vi.fn(),
    getText: vi.fn(() => ""),
    waitForText: vi.fn(async (text: string) => text),
    waitForRegex: vi.fn(async (pattern: string) => pattern),
    waitForPrompt: vi.fn(async () => "$ "),
    waitForAny: vi.fn(async () => 0),
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    abort: vi.fn(),
    ...overrides,
  };
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function startWith(worker: FakeWorker, api: TmxScriptApi, extra = {}) {
  return startTmxScript({
    source: "tmx.log('hi')",
    api,
    createWorker: () => worker,
    ...extra,
  });
}

describe("startTmxScript 生命周期", () => {
  it("ready 后下发 start 配置，completed 标记完成并终止 worker", async () => {
    const worker = new FakeWorker();
    const api = createApi();
    const statuses: string[] = [];
    const handle = startWith(worker, api, {
      onStatus: (status: string) => statuses.push(status),
    });

    worker.emit({ type: "ready" });
    expect(worker.posted[0]).toMatchObject({
      type: "start",
      config: {
        source: "tmx.log('hi')",
        snapshot: { connected: true, name: "session-a", hostname: "host-a", username: "user-a" },
      },
    });
    worker.emit({ type: "heartbeat" });
    worker.emit({ type: "completed" });

    await expect(handle.done).resolves.toEqual({ status: "completed" });
    expect(handle.status()).toBe("completed");
    expect(worker.terminated).toBe(true);
    expect(api.abort).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["running", "completed"]);
  });

  it("worker failed 消息带原始错误信息", async () => {
    const worker = new FakeWorker();
    const handle = startWith(worker, createApi());
    worker.emit({ type: "ready" });
    worker.emit({ type: "failed", error: { name: "Error", message: "boom" } });
    await expect(handle.done).resolves.toEqual({ status: "failed", error: "boom" });
  });

  it("worker error 事件标记失败", async () => {
    const worker = new FakeWorker();
    const handle = startWith(worker, createApi());
    worker.emit({ type: "ready" });
    worker.emitError("worker crashed");
    await expect(handle.done).resolves.toEqual({
      status: "failed",
      error: "worker crashed",
    });
  });

  it("stop 立即终止并返回 stopped", async () => {
    const worker = new FakeWorker();
    const api = createApi();
    const handle = startWith(worker, api);
    worker.emit({ type: "ready" });
    handle.stop();
    await expect(handle.done).resolves.toEqual({ status: "stopped" });
    expect(handle.status()).toBe("stopped");
    expect(worker.terminated).toBe(true);
    expect(api.abort).toHaveBeenCalledTimes(1);
  });

  it("空源码同步抛错", () => {
    expect(() => startTmxScript({ source: "  ", api: createApi() })).toThrow(
      "Script content is empty",
    );
  });
});

describe("startTmxScript RPC 与通知", () => {
  it("rpc 请求分发到宿主 API 并回传结果", async () => {
    const worker = new FakeWorker();
    const api = createApi();
    const handle = startWith(worker, api);
    worker.emit({ type: "ready" });
    worker.emit({ type: "rpc", requestId: 7, method: "session.sleep", args: [100] });
    await flushPromises();

    expect(api.sleep).toHaveBeenCalledWith(100);
    expect(worker.replies()).toEqual([
      { type: "rpc-result", requestId: 7, ok: true, value: undefined },
    ]);
    handle.stop();
    await handle.done;
  });

  it("未知方法回传错误", async () => {
    const worker = new FakeWorker();
    const handle = startWith(worker, createApi());
    worker.emit({ type: "ready" });
    worker.emit({ type: "rpc", requestId: 2, method: "dialog.alert", args: ["hi"] });
    await flushPromises();

    const reply = worker.replies()[0];
    expect(reply.ok).toBe(false);
    expect((reply.error as { message: string }).message).toContain(
      "Unknown script API method: dialog.alert",
    );
    handle.stop();
    await handle.done;
  });

  it("RPC 抛错时回传 ok:false", async () => {
    const worker = new FakeWorker();
    const api = createApi({
      waitForText: vi.fn(async () => {
        throw new Error("waitForText timed out after 30ms");
      }),
    });
    const handle = startWith(worker, api);
    worker.emit({ type: "ready" });
    worker.emit({ type: "rpc", requestId: 3, method: "screen.waitForText", args: ["READY"] });
    await flushPromises();

    const reply = worker.replies()[0];
    expect(reply.ok).toBe(false);
    expect((reply.error as { message: string }).message).toBe(
      "waitForText timed out after 30ms",
    );
    handle.stop();
    await handle.done;
  });

  it("超过待处理 RPC 上限时终止运行", async () => {
    const worker = new FakeWorker();
    const api = createApi({
      sleep: vi.fn(() => new Promise<void>(() => {})),
    });
    const handle = startWith(worker, api, { maxPendingRequests: 2 });
    worker.emit({ type: "ready" });
    worker.emit({ type: "rpc", requestId: 1, method: "session.sleep", args: [1] });
    worker.emit({ type: "rpc", requestId: 2, method: "session.sleep", args: [1] });
    worker.emit({ type: "rpc", requestId: 3, method: "session.sleep", args: [1] });

    await expect(handle.done).resolves.toEqual({
      status: "failed",
      error: "Script exceeded the 2 pending host request limit",
    });
    expect(worker.terminated).toBe(true);
  });

  it("tmx.log 转发到 api.log 与 onLog，并限制条数", async () => {
    const worker = new FakeWorker();
    const api = createApi();
    const logs: string[] = [];
    const handle = startWith(worker, api, {
      maxLogNotifications: 2,
      onLog: (line: string) => logs.push(line),
    });
    worker.emit({ type: "ready" });
    worker.emit({ type: "notify", method: "log", args: ["one"] });
    worker.emit({ type: "notify", method: "log", args: ["two"] });
    expect(logs).toEqual(["one", "two"]);
    expect(api.log).toHaveBeenCalledTimes(2);

    worker.emit({ type: "notify", method: "log", args: ["three"] });
    await expect(handle.done).resolves.toEqual({
      status: "failed",
      error: "Script exceeded the 2 log notification limit",
    });
  });

  it("超过总通知上限时终止运行", async () => {
    const worker = new FakeWorker();
    const handle = startWith(worker, createApi(), { maxTotalNotifications: 1 });
    worker.emit({ type: "ready" });
    worker.emit({ type: "notify", method: "progress.step", args: [] });
    worker.emit({ type: "notify", method: "progress.step", args: [] });
    await expect(handle.done).resolves.toEqual({
      status: "failed",
      error: "Script exceeded the 1 notification limit",
    });
  });
});

describe("startTmxScript 超时与看门狗", () => {
  it("2 秒无心跳被看门狗终止", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const handle = startWith(worker, createApi(), { heartbeatTimeoutMs: 2_000 });
      worker.emit({ type: "ready" });
      await vi.advanceTimersByTimeAsync(2_100);
      await expect(handle.done).resolves.toEqual({
        status: "failed",
        error: "Script execution timed out after 2000ms (no heartbeat)",
      });
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("心跳正常时不会触发看门狗", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const handle = startWith(worker, createApi(), { heartbeatTimeoutMs: 2_000 });
      worker.emit({ type: "ready" });
      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(500);
        worker.emit({ type: "heartbeat" });
      }
      expect(handle.status()).toBe("running");
      handle.stop();
      await expect(handle.done).resolves.toEqual({ status: "stopped" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("总时长超时（30 分钟默认值可注入）", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const handle = startWith(worker, createApi(), {
        heartbeatTimeoutMs: 10_000,
        maxRunMs: 1_000,
      });
      worker.emit({ type: "ready" });
      await vi.advanceTimersByTimeAsync(1_100);
      await expect(handle.done).resolves.toEqual({
        status: "failed",
        error: "Script execution timed out after 1000ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("worker 迟迟不 ready 时按启动超时失败", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const handle = startWith(worker, createApi(), { startTimeoutMs: 200 });
      await vi.advanceTimersByTimeAsync(250);
      await expect(handle.done).resolves.toEqual({
        status: "failed",
        error: "Script worker failed to start after 200ms",
      });
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("invokeApi 方法映射", () => {
  it("按阶段 1 API 集合分发并补默认超时", async () => {
    const api = createApi();
    await invokeApi(api, "screen.send", ["hi"]);
    await invokeApi(api, "screen.sendLine", ["ls"]);
    await invokeApi(api, "screen.clear", []);
    await invokeApi(api, "screen.getText", [1, 3]);
    await invokeApi(api, "screen.waitForText", ["READY"]);
    await invokeApi(api, "screen.waitForRegex", ["^OK$", 100]);
    await invokeApi(api, "screen.waitForPrompt", []);
    await invokeApi(api, "screen.waitForAny", [["A", "B"], 50]);
    await invokeApi(api, "session.sleep", [10]);

    expect(api.send).toHaveBeenCalledWith("hi");
    expect(api.sendLine).toHaveBeenCalledWith("ls");
    expect(api.clear).toHaveBeenCalled();
    expect(api.getText).toHaveBeenCalledWith(1, 3);
    expect(api.waitForText).toHaveBeenCalledWith("READY", 30_000);
    expect(api.waitForRegex).toHaveBeenCalledWith("^OK$", 100);
    expect(api.waitForPrompt).toHaveBeenCalledWith(60_000);
    expect(api.waitForAny).toHaveBeenCalledWith(["A", "B"], 50);
    expect(api.sleep).toHaveBeenCalledWith(10);
  });

  it("默认上限与文档一致", () => {
    expect(SCRIPT_LIMITS).toMatchObject({
      heartbeatTimeoutMs: 2_000,
      maxRunMs: 1_800_000,
      maxPendingRequests: 128,
      maxLogNotifications: 200,
      maxTotalNotifications: 20_000,
    });
  });
});
