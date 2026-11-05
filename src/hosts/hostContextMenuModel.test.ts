import { describe, expect, it } from "vitest";
import {
  deriveHostContextMenuItems,
  HOST_CONTEXT_MENU_ICON,
  resolveHostKind,
} from "./hostContextMenuModel";

describe("hostContextMenuModel", () => {
  it("归一协议：缺省/未知按 SSH，其余原样", () => {
    expect(resolveHostKind(undefined)).toBe("ssh");
    expect(resolveHostKind(null)).toBe("ssh");
    expect(resolveHostKind("")).toBe("ssh");
    expect(resolveHostKind("unknown")).toBe("ssh");
    expect(resolveHostKind("local")).toBe("local");
    expect(resolveHostKind("serial")).toBe("serial");
    expect(resolveHostKind("telnet")).toBe("telnet");
  });

  it("SSH：连接 / SFTP / 编辑 / 复制 / 地址 / 账密 / 置顶 / 删除", () => {
    const ids = deriveHostContextMenuItems({
      protocol: "ssh",
      host: "10.0.0.1",
    }).map((item) => item.id);
    expect(ids).toEqual([
      "connect",
      "sftp",
      "edit",
      "duplicate",
      "copy-hostname",
      "copy-credentials",
      "pin",
      "delete",
    ]);
  });

  it("本地终端：无 SFTP、无复制地址/账密", () => {
    const ids = deriveHostContextMenuItems({ protocol: "local", host: "" })
      .map((item) => item.id);
    expect(ids).toEqual(["connect", "edit", "duplicate", "pin", "delete"]);
  });

  it("串口 / Telnet：保留复制地址，但不出现 SFTP", () => {
    for (const protocol of ["serial", "telnet"]) {
      const ids = deriveHostContextMenuItems({
        protocol,
        host: protocol === "serial" ? "COM3" : "127.0.0.1",
      }).map((item) => item.id);
      expect(ids).toEqual([
        "connect",
        "edit",
        "duplicate",
        "copy-hostname",
        "copy-credentials",
        "pin",
        "delete",
      ]);
    }
  });

  it("置顶文案随状态切换，删除标记为危险操作", () => {
    const pinned = deriveHostContextMenuItems({ protocol: "ssh", pinned: true });
    expect(pinned.find((item) => item.id === "pin")?.label).toBe("取消置顶");
    const normal = deriveHostContextMenuItems({ protocol: "ssh", pinned: false });
    expect(normal.find((item) => item.id === "pin")?.label).toBe("置顶");
    expect(normal.find((item) => item.id === "delete")?.danger).toBe(true);
  });

  it("每个条目都有图标映射", () => {
    for (const item of deriveHostContextMenuItems({ protocol: "ssh", host: "h" })) {
      expect(HOST_CONTEXT_MENU_ICON[item.id]).toBeTruthy();
    }
  });
});
