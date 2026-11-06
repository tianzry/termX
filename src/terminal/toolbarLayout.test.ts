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
      // 与左侧栏开关成对：展开主机右侧栏（SSH 默认 SFTP，其余默认脚本）
      "panel",
    ]);
    expect((TERMINAL_TOOLBAR_ACTIONS as readonly string[]).includes("forward")).toBe(
      false,
    );
    expect((TERMINAL_TOOLBAR_ACTIONS as readonly string[]).includes("split")).toBe(
      false,
    );
  });

  it("SSH 内联显示 SFTP（紧随 highlight）与右侧栏开关", () => {
    expect(resolveTerminalToolbarActions("ssh")).toEqual([
      "highlight",
      "sftp",
      "compose",
      "search",
      "sessionLog",
      "scripts",
      "panel",
    ]);
  });

  it("本地 / 串口 / Telnet 无 SFTP，其余顺序不变（保留右侧栏开关）", () => {
    for (const kind of ["pty", "serial", "telnet"] as const) {
      expect(resolveTerminalToolbarActions(kind)).toEqual([
        "highlight",
        "compose",
        "search",
        "sessionLog",
        "scripts",
        "panel",
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
