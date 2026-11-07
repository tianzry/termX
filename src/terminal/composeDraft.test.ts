import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector } from "../workspaceModel";
import {
  COMPOSE_DRAFT_STORAGE_PREFIX,
  loadComposeDraft,
  resolveComposeDraftKey,
  saveComposeDraft,
} from "./composeDraft";

const serialConnector = (profileId?: string): Connector => ({
  kind: "serial",
  name: "COM4",
  session: {
    port: "COM4",
    config: { baud_rate: 115200 },
    lineMode: false,
    localEcho: false,
    backspaceBehavior: "default",
    byteOrientedBackspace: false,
  },
  ...(profileId ? { profileId } : {}),
});

const telnetConnector = (profileId?: string): Connector => ({
  kind: "telnet",
  name: "router",
  session: {
    host: "10.0.0.1",
    port: 23,
    inputNewline: "crlf",
    ...(profileId ? { profileId } : {}),
  },
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("resolveComposeDraftKey", () => {
  it("SSH 主机按档案 id 记忆", () => {
    expect(resolveComposeDraftKey({ kind: "ssh", profileId: "h1", name: "a" })).toBe(
      "ssh:h1",
    );
  });

  it("本地 shell 一律不记忆", () => {
    expect(resolveComposeDraftKey({ kind: "pty" })).toBeNull();
    expect(resolveComposeDraftKey({ kind: "pty", name: "Git Bash" })).toBeNull();
  });

  it("只有来自已保存主机的串口 / Telnet 才记忆", () => {
    expect(resolveComposeDraftKey(serialConnector("p1"))).toBe("serial:p1");
    expect(resolveComposeDraftKey(serialConnector())).toBeNull();
    expect(resolveComposeDraftKey(telnetConnector("p2"))).toBe("telnet:p2");
    expect(resolveComposeDraftKey(telnetConnector())).toBeNull();
  });
});

describe("compose 草稿存取", () => {
  it("按键读写原文（含换行），不同主机互不影响", () => {
    saveComposeDraft("ssh:h1", "line1\nline2\n");
    saveComposeDraft("ssh:h2", "other");
    expect(loadComposeDraft("ssh:h1")).toBe("line1\nline2\n");
    expect(loadComposeDraft("ssh:h2")).toBe("other");
    expect(loadComposeDraft("ssh:h3")).toBe("");
  });

  it("空白内容视为删除（移除键）", () => {
    saveComposeDraft("ssh:h1", "draft");
    saveComposeDraft("ssh:h1", "   \n ");
    expect(loadComposeDraft("ssh:h1")).toBe("");
    expect(
      window.localStorage.getItem(`${COMPOSE_DRAFT_STORAGE_PREFIX}ssh%3Ah1`),
    ).toBeNull();
  });

  it("临时终端（key 为 null）不写也不读", () => {
    saveComposeDraft(null, "ephemeral");
    expect(window.localStorage.length).toBe(0);
    expect(loadComposeDraft(null)).toBe("");
  });

  it("localStorage 写入失败时静默降级", () => {
    const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveComposeDraft("ssh:h1", "x")).not.toThrow();
    spy.mockRestore();
  });
});
