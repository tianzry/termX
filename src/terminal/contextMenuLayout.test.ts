import { describe, expect, it } from "vitest";
import { resolveTerminalContextMenu } from "./contextMenuLayout";

const sshConnected = {
  connected: true,
  status: "connected" as const,
  hasSelection: false,
  showSftp: true,
  canSplit: true,
  canClosePane: true,
};

describe("resolveTerminalContextMenu", () => {
  it("SSH 已连接：顺序与 Netcatty 一致（复制/粘贴/全选 → SFTP → 分屏 → 清空 → 关闭）", () => {
    const items = resolveTerminalContextMenu(sshConnected);
    expect(items.map((i) => (i.kind === "item" ? i.action : "|"))).toEqual([
      "copy",
      "paste",
      "selectAll",
      "|",
      "openSftp",
      "|",
      "splitHorizontal",
      "splitVertical",
      "|",
      "clearBuffer",
      "|",
      "closeTerminal",
    ]);
  });

  it("复制按选区启用；SFTP 按连接态启用；关闭项为 destructive", () => {
    const items = resolveTerminalContextMenu(sshConnected);
    const byAction = (action: string) => {
      const hit = items.find((i) => i.kind === "item" && i.action === action);
      if (!hit || hit.kind !== "item") throw new Error(`missing ${action}`);
      return hit;
    };
    expect(byAction("copy").disabled).toBe(true);
    expect(byAction("paste").disabled).toBe(false);
    expect(byAction("openSftp").disabled).toBe(false);
    expect(byAction("closeTerminal").danger).toBe(true);
    expect(byAction("closeTerminal").icon).toBe("trash");
  });

  it("有选区时复制启用", () => {
    const items = resolveTerminalContextMenu({ ...sshConnected, hasSelection: true });
    const copy = items.find((i) => i.kind === "item" && i.action === "copy");
    expect(copy && copy.kind === "item" && copy.disabled).toBe(false);
  });

  it("本地 / 串口 / Telnet 无 SFTP 分组，且不留悬空分隔线", () => {
    const items = resolveTerminalContextMenu({ ...sshConnected, showSftp: false });
    expect(items.some((i) => i.kind === "item" && i.action === "openSftp")).toBe(false);
    expect(items.map((i) => (i.kind === "item" ? i.action : "|"))).toEqual([
      "copy",
      "paste",
      "selectAll",
      "|",
      "splitHorizontal",
      "splitVertical",
      "|",
      "clearBuffer",
      "|",
      "closeTerminal",
    ]);
    // 任何分隔线前后都必须是菜单项，不能出现连续两条。
    const kinds = items.map((i) => i.kind);
    expect(kinds.includes("separator")).toBe(true);
    for (let i = 0; i < kinds.length; i += 1) {
      if (kinds[i] === "separator") {
        expect(kinds[i - 1]).toBe("item");
        expect(kinds[i + 1]).toBe("item");
      }
    }
  });

  it("断线后追加「重新连接」，断线时 SFTP 置灰", () => {
    const items = resolveTerminalContextMenu({
      ...sshConnected,
      connected: false,
      status: "disconnected",
    });
    expect(items.map((i) => (i.kind === "item" ? i.action : "|"))).toEqual([
      "copy",
      "paste",
      "selectAll",
      "|",
      "openSftp",
      "|",
      "reconnect",
      "|",
      "splitHorizontal",
      "splitVertical",
      "|",
      "clearBuffer",
      "|",
      "closeTerminal",
    ]);
    const sftp = items.find((i) => i.kind === "item" && i.action === "openSftp");
    expect(sftp && sftp.kind === "item" && sftp.disabled).toBe(true);
  });

  it("单窗格（不可关闭）时没有尾部关闭分组", () => {
    const items = resolveTerminalContextMenu({ ...sshConnected, canClosePane: false });
    expect(items.some((i) => i.kind === "item" && i.action === "closeTerminal")).toBe(false);
    const last = items[items.length - 1];
    expect(last.kind).toBe("item");
  });

  it("无法分屏时两个分屏项置灰", () => {
    const items = resolveTerminalContextMenu({ ...sshConnected, canSplit: false });
    for (const action of ["splitHorizontal", "splitVertical"]) {
      const hit = items.find((i) => i.kind === "item" && i.action === action);
      expect(hit && hit.kind === "item" && hit.disabled).toBe(true);
    }
  });

  it("快捷键 action 对齐 keyBindings 的 action 名", () => {
    const items = resolveTerminalContextMenu(sshConnected);
    const shortcuts = items
      .filter((i): i is Extract<typeof i, { kind: "item" }> => i.kind === "item")
      .map((i) => i.shortcutAction);
    expect(shortcuts).toEqual([
      "copy",
      "paste",
      "selectAll",
      null,
      "splitHorizontal",
      "splitVertical",
      "clearBuffer",
      null,
    ]);
  });
});
