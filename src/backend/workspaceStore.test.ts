import { beforeEach, describe, expect, it } from "vitest";
import { clearWorkspace, loadWorkspace, saveWorkspace, type SavedWorkspace } from "./workspaceStore";

const validWorkspace = (): SavedWorkspace => ({
  version: 1,
  tabs: [
    {
      id: "t1",
      title: "本地终端 1",
      layout: { type: "leaf", id: "l1" },
      connector: { kind: "pty" },
    },
    {
      id: "t2",
      title: "prod",
      layout: {
        type: "split",
        id: "s1",
        dir: "horizontal",
        ratio: 0.5,
        a: { type: "leaf", id: "l2" },
        b: { type: "leaf", id: "l3" },
      },
      connector: { kind: "ssh", profileId: "p1", name: "prod" },
    },
  ],
  activeTabId: "t2",
});

describe("workspaceStore", () => {
  beforeEach(() => localStorage.clear());

  it("save → load 往返一致", () => {
    const ws = validWorkspace();
    saveWorkspace(ws);
    expect(loadWorkspace()).toEqual(ws);
  });

  it("串口标签可持久化并恢复", () => {
    const ws = validWorkspace();
    ws.tabs.push({
      id: "t3",
      title: "串口 COM1",
      layout: { type: "leaf", id: "l4" },
      connector: {
        kind: "serial",
        session: {
          port: "COM1",
          config: {
            baud_rate: 115200,
            data_bits: 8,
            parity: "none",
            stop_bits: 1,
            flow_control: "none",
            charset: "UTF-8",
          },
          lineMode: true,
          localEcho: true,
          backspaceBehavior: "ctrl-h",
          byteOrientedBackspace: true,
        },
      },
    });
    saveWorkspace(ws);
    expect(loadWorkspace()).toEqual(ws);
  });

  it("Telnet 标签可持久化并恢复", () => {
    const ws = validWorkspace();
    ws.tabs.push({
      id: "t3",
      title: "Telnet 10.0.0.5",
      layout: { type: "leaf", id: "l4" },
      connector: {
        kind: "telnet",
        session: { host: "10.0.0.5", port: 23, inputNewline: "crlf" },
      },
    });
    saveWorkspace(ws);
    expect(loadWorkspace()).toEqual(ws);
  });

  it("无记录时返回 null", () => {
    expect(loadWorkspace()).toBeNull();
  });

  it("JSON 损坏时返回 null", () => {
    localStorage.setItem("termx.workspace.v1", "{oops");
    expect(loadWorkspace()).toBeNull();
  });

  it("版本不匹配时返回 null", () => {
    saveWorkspace({ ...validWorkspace(), version: 99 });
    expect(loadWorkspace()).toBeNull();
  });

  it("过滤结构损坏的 tab（layout / connector 非法）", () => {
    const raw = JSON.parse(JSON.stringify(validWorkspace()));
    raw.tabs.push({ id: "bad1", title: "x", layout: { type: "wat" }, connector: { kind: "pty" } });
    raw.tabs.push({
      id: "bad2",
      title: "x",
      layout: { type: "leaf", id: "l9" },
      connector: { kind: "telnet" },
    });
    localStorage.setItem("termx.workspace.v1", JSON.stringify(raw));
    expect(loadWorkspace()?.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("activeTabId 指向不存在的 tab 时回退第一个", () => {
    saveWorkspace({ ...validWorkspace(), activeTabId: "ghost" });
    expect(loadWorkspace()?.activeTabId).toBe("t1");
  });

  it("clearWorkspace 清空记录", () => {
    saveWorkspace(validWorkspace());
    clearWorkspace();
    expect(loadWorkspace()).toBeNull();
  });

  it("自定义 storageKey 与主窗口隔离（多窗口不覆盖主布局）", () => {
    saveWorkspace(validWorkspace());
    saveWorkspace(validWorkspace(), "termx.workspace.v1.rssh-a");
    expect(loadWorkspace("termx.workspace.v1.rssh-a")?.activeTabId).toBe("t2");
    expect(loadWorkspace()?.activeTabId).toBe("t2");
    clearWorkspace("termx.workspace.v1.rssh-a");
    expect(loadWorkspace("termx.workspace.v1.rssh-a")).toBeNull();
    expect(loadWorkspace()).not.toBeNull();
  });
});
