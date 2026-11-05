import { describe, expect, it } from "vitest";

import {
  TERMINAL_TITLEBAR_ACTIONS,
  TERMINAL_TOOLBAR_ACTIONS,
  resolveTerminalTitlebarActions,
  resolveTerminalToolbarActions,
} from "./toolbarLayout";

describe("toolbarLayout", () => {
  it("工具栏内联条目顺序与 Netcatty defaultLayout 一致，且不含端口转发", () => {
    expect([...TERMINAL_TOOLBAR_ACTIONS]).toEqual([
      "highlight",
      "sftp",
      "compose",
      "search",
      "sessionLog",
      "scripts",
      // termX 唯一新增：笔记面板入口（Netcatty 在侧栏工具 rail）
      "notes",
    ]);
    expect((TERMINAL_TOOLBAR_ACTIONS as readonly string[]).includes("forward")).toBe(
      false,
    );
    expect((TERMINAL_TOOLBAR_ACTIONS as readonly string[]).includes("split")).toBe(
      false,
    );
  });

  it("SSH 内联显示 SFTP（紧随 highlight）与笔记入口", () => {
    expect(resolveTerminalToolbarActions("ssh")).toEqual([
      "highlight",
      "sftp",
      "compose",
      "search",
      "sessionLog",
      "scripts",
      "notes",
    ]);
  });

  it("本地 / 串口 / Telnet 无 SFTP / 笔记，其余顺序不变", () => {
    for (const kind of ["pty", "serial", "telnet"] as const) {
      expect(resolveTerminalToolbarActions(kind)).toEqual([
        "highlight",
        "compose",
        "search",
        "sessionLog",
        "scripts",
      ]);
    }
  });

  it("标题行顺序：复制 → 时间戳 → 监控 → 断开 → 重连", () => {
    expect([...TERMINAL_TITLEBAR_ACTIONS]).toEqual([
      "copyHost",
      "timestamps",
      "monitor",
      "disconnect",
      "reconnect",
    ]);
    expect(resolveTerminalTitlebarActions("ssh")).toEqual([
      "copyHost",
      "timestamps",
      "monitor",
      "disconnect",
      "reconnect",
    ]);
    expect(resolveTerminalTitlebarActions("pty")).toEqual([
      "timestamps",
      "disconnect",
      "reconnect",
    ]);
    expect(resolveTerminalTitlebarActions("telnet")).toEqual([
      "copyHost",
      "timestamps",
      "disconnect",
      "reconnect",
    ]);
  });
});
