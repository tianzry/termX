import { describe, expect, it } from "vitest";
import { createTmxScriptApi, type TmxScriptApiHost } from "./tmxScriptApi";
import type { TmxScriptSessionSnapshot } from "./tmxRuntime";
import { SessionTextBuffer } from "./sessionTextBuffer";

const snapshot: TmxScriptSessionSnapshot = {
  connected: true,
  name: "term-a",
  hostname: "host-a",
  username: "user-a",
};

function setup(overrides: Partial<TmxScriptApiHost> = {}) {
  const buffer = new SessionTextBuffer({ pollMs: 10 });
  const writes: string[] = [];
  const logs: string[] = [];
  let aborted = false;
  const api = createTmxScriptApi({
    write: (text) => writes.push(text),
    buffer,
    snapshot,
    isAborted: () => aborted,
    onLog: (line) => logs.push(line),
    ...overrides,
  });
  return {
    buffer,
    writes,
    logs,
    api,
    setAborted: (value: boolean) => {
      aborted = value;
    },
  };
}

describe("tmx API screen 基础操作", () => {
  it("send 原样写入并记录日志", () => {
    const { api, writes, logs } = setup();
    api.send("echo hi\r");
    expect(writes).toEqual(["echo hi\r"]);
    expect(logs).toEqual(["→ send: echo hi\\r"]);
  });

  it("send 在已停止时不写入", () => {
    const { api, writes, setAborted } = setup();
    setAborted(true);
    expect(() => api.send("x")).toThrow("Script stopped");
    expect(writes).toEqual([]);
  });

  it("clear 写入清屏转义序列", () => {
    const { api, writes } = setup();
    api.clear();
    expect(writes).toEqual(["\x1b[2J\x1b[H"]);
  });

  it("getText 默认返回完整缓冲，按行范围返回切片", () => {
    const { api, buffer } = setup();
    buffer.append("line0\r\nline1\r\nline2");
    expect(api.getText()).toBe("line0\r\nline1\r\nline2");
    expect(api.getText(1, 2)).toBe("line1\nline2");
    expect(api.getText(2, 0)).toBe("");
  });

  it("session 元信息来自启动快照", () => {
    const { api } = setup();
    expect(api.connected).toBe(true);
    expect(api.name).toBe("term-a");
    expect(api.hostname).toBe("host-a");
    expect(api.username).toBe("user-a");
  });

  it("log 由宿主运行器收集，自身不写日志", () => {
    const { api, logs } = setup();
    api.log("hello");
    expect(logs).toEqual([]);
  });
});

describe("tmx API sendLine 两包时序", () => {
  it("先写正文、等间隔、再写 CR，且只消费发送前长度", async () => {
    const { api, buffer, writes, logs } = setup({
      sleep: async () => {
        buffer.append("echo body\r\n");
      },
    });
    buffer.append("prompt> ");

    await api.sendLine("echo body");

    expect(writes).toEqual(["echo body", "\r"]);
    expect(logs).toEqual(["→ sendLine: echo body"]);
    // 发送前的提示符被消费，正文与 CR 之间到达的 echo 仍可等待。
    expect(buffer.getCursor()).toBe("prompt> ".length);
    await expect(api.waitForText("echo body", 30)).resolves.toBe("echo body");
    await expect(api.waitForText("prompt>", 30)).rejects.toThrow("waitForText timed out");
  });

  it("空行不等待间隔，只写 CR", async () => {
    let slept = false;
    const { api, writes } = setup({
      sleep: async () => {
        slept = true;
      },
    });
    await api.sendLine("");
    expect(slept).toBe(false);
    expect(writes).toEqual(["\r"]);
  });

  it("正文与 CR 之间被停止时不再写 CR", async () => {
    const { api, writes, setAborted } = setup({
      sleep: async () => {
        setAborted(true);
      },
    });
    await api.sendLine("cmd");
    expect(writes).toEqual(["cmd"]);
    expect(api.getText()).toBe("");
  });

  it("默认间隔为 30ms（用真实定时器验证顺序）", async () => {
    const buffer = new SessionTextBuffer();
    const writes: Array<{ text: string; at: number }> = [];
    const api = createTmxScriptApi({
      write: (text) => writes.push({ text, at: Date.now() }),
      buffer,
      snapshot,
    });
    const startedAt = Date.now();
    await api.sendLine("cmd");
    expect(writes.map((entry) => entry.text)).toEqual(["cmd", "\r"]);
    expect(writes[1].at - startedAt).toBeGreaterThanOrEqual(25);
  });
});

describe("tmx API 等待与 sleep", () => {
  it("waitForText / waitForRegex / waitForAny 委托缓冲并响应停止", async () => {
    const { api, buffer, setAborted } = setup();
    buffer.append("READY\nline-42\n");
    await expect(api.waitForText("READY", 30)).resolves.toBe("READY");
    await expect(api.waitForRegex("^line-\\d+$", 30)).resolves.toBe("line-42");

    const pending = api.waitForAny(["NEVER", "READY"], 500);
    setAborted(true);
    await expect(pending).rejects.toThrow("Script stopped");
  });

  it("waitForPrompt 默认 60s 的提示符规则可用", async () => {
    const { api, buffer } = setup();
    buffer.append("done\nuser@host:~$ ");
    await expect(api.waitForPrompt(30)).resolves.toBe("$ ");
  });

  it("默认 sleep 可被停止打断", async () => {
    const { api, setAborted } = setup();
    const pending = api.sleep(1_000);
    setTimeout(() => setAborted(true), 20);
    await expect(pending).rejects.toThrow("Script stopped");
  });

  it("sleep 到点正常返回", async () => {
    const { api } = setup();
    await expect(api.sleep(10)).resolves.toBeUndefined();
  });
});
