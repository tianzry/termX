import { beforeEach, describe, expect, it, vi } from "vitest";

// 前端测试不接触真实 Tauri 运行时：invoke/listen 全部 mock，
// 只验证桥接层的参数形状与编解码（R1 的唯一 IO 边界）。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  bytesToText,
  decodeBase64,
  onAuthPrompt,
  onTerminalData,
  ptySpawn,
  sshConnect,
  sshDisconnect,
  sshWrite,
} from "./client";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;

/** 用 jsdom 自带的 btoa 构造 base64（先经 TextEncoder 转 UTF-8 字节）。 */
const b64Of = (text: string): string =>
  btoa(String.fromCharCode(...Array.from(new TextEncoder().encode(text))));

describe("字节编解码", () => {
  it("decodeBase64 + bytesToText 还原 UTF-8 多字节文本", () => {
    const bytes = decodeBase64(b64Of("你好 termX"));
    expect(bytesToText(Array.from(bytes))).toBe("你好 termX");
  });
});

describe("invoke 参数形状", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it("sshConnect 传入可注入的 sessionId（同时作为 prompt key 与 logSessionId）", async () => {
    mockedInvoke.mockResolvedValue("sid-1");
    const sid = await sshConnect("profile-1", 80, 24, "sid-1", { password: "pw" });
    expect(sid).toBe("sid-1");
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_connect", {
      profileId: "profile-1",
      logSessionId: "sid-1",
      cols: 80,
      rows: 24,
      sessionId: "sid-1",
      authOverride: { password: "pw" },
    });
  });

  it("sshConnect 不带 authOverride 时传 null 而非 undefined", async () => {
    mockedInvoke.mockResolvedValue("sid-2");
    await sshConnect("profile-1", 80, 24, "sid-2");
    const args = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(args.authOverride).toBeNull();
  });

  it("sshWrite 上行把文本转成 UTF-8 number 数组", async () => {
    await sshWrite("sid-1", "AB中");
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_write", {
      sessionId: "sid-1",
      data: [65, 66, 228, 184, 173],
    });
  });

  it("ptySpawn 显式传 sessionId: null（由后端分配）", async () => {
    await ptySpawn(120, 30);
    expect(mockedInvoke).toHaveBeenCalledWith("pty_spawn", {
      cols: 120,
      rows: 30,
      sessionId: null,
      shell: null,
      args: null,
      startDir: null,
    });
  });

  it("ptySpawn 本地主机透传 shell / args / startDir", async () => {
    await ptySpawn(80, 24, {
      shell: "wsl.exe",
      args: ["-d", "Ubuntu"],
      startDir: "~",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("pty_spawn", {
      cols: 80,
      rows: 24,
      sessionId: null,
      shell: "wsl.exe",
      args: ["-d", "Ubuntu"],
      startDir: "~",
    });
  });

  it("sshDisconnect 带 tabId: null 兜底", async () => {
    await sshDisconnect("sid-1");
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_disconnect", {
      sessionId: "sid-1",
      tabId: null,
    });
  });

  it("invoke 拒绝时原样抛出后端错误（供上层 decodeAppError 解析）", async () => {
    const raw = '__rssh_err__|{"code":"ssh_auth_failed"}';
    mockedInvoke.mockRejectedValue(new Error(raw));
    await expect(sshConnect("p", 80, 24, "sid-x")).rejects.toThrow(raw);
  });
});

describe("事件订阅", () => {
  beforeEach(() => mockedListen.mockReset());

  it("onTerminalData 监听 <domain>:data:<id> 并解码 base64 下行载荷", async () => {
    let event = "";
    let handler: (ev: { payload: string }) => void = () => {};
    mockedListen.mockImplementation((ev: string, h: unknown) => {
      event = ev;
      handler = h as (ev: { payload: string }) => void;
      return Promise.resolve(() => {});
    });
    const received: Uint8Array[] = [];
    await onTerminalData("ssh", "sid-9", (bytes) => received.push(bytes));
    expect(event).toBe("ssh:data:sid-9");
    handler({ payload: b64Of("hi") });
    expect(bytesToText(Array.from(received[0]))).toBe("hi");
  });

  it("onAuthPrompt 监听 ssh:auth_prompt:<id> 并透传载荷", async () => {
    let event = "";
    let handler: (ev: { payload: unknown }) => void = () => {};
    mockedListen.mockImplementation((ev: string, h: unknown) => {
      event = ev;
      handler = h as (ev: { payload: unknown }) => void;
      return Promise.resolve(() => {});
    });
    const prompts: unknown[] = [];
    await onAuthPrompt("sid-9", (p) => prompts.push(p));
    expect(event).toBe("ssh:auth_prompt:sid-9");
    const payload = {
      name: "kb",
      instructions: "",
      prompts: [{ prompt: "Password: ", echo: false }],
    };
    handler({ payload });
    expect(prompts).toEqual([payload]);
  });
});
