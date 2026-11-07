/**
 * 快捷键运行时纯逻辑单测：匹配规则 / 平台修饰键 / [1...9] / arrows /
 * 冲突优先级 / 禁用 / 序号角标目标 / 分屏焦点。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settingsModel";
import {
  PINNED_SFTP_TAB_ID,
  PINNED_VAULT_TAB_ID,
  buildNumberShortcutTabTargets,
  buildTabShortcutNumberById,
  findBindingConflicts,
  findMatchingBinding,
  getShortcutModifierRequirements,
  isShortcutModifierHeld,
  keyStringToKeyboardEvent,
  matchesKeyBinding,
  resolveFocusTarget,
  tabShortcutDigitFromEvent,
  type HotkeyEventLike,
} from "./hotkeyRuntime";

const pcSettings = {
  ...DEFAULT_SETTINGS,
  hotkeyScheme: "pc" as const,
  customKeyBindings: {},
  disabledKeyBindings: [],
};

function keyEvent(
  key: string,
  modifiers: Partial<Pick<HotkeyEventLike, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
  code = "",
): HotkeyEventLike {
  return {
    key,
    code,
    metaKey: modifiers.metaKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  };
}

describe("matchesKeyBinding", () => {
  it("PC：Ctrl+T / Ctrl+Shift+W 精确匹配且不区分大小写", () => {
    expect(matchesKeyBinding(keyEvent("t", { ctrlKey: true }), "Ctrl + T", "pc")).toBe(true);
    expect(matchesKeyBinding(keyEvent("T", { ctrlKey: true }), "Ctrl + T", "pc")).toBe(true);
    expect(
      matchesKeyBinding(keyEvent("W", { ctrlKey: true, shiftKey: true }), "Ctrl + Shift + W", "pc"),
    ).toBe(true);
  });

  it("修饰键必须精确：多按 / 少按都不命中", () => {
    expect(
      matchesKeyBinding(keyEvent("t", { ctrlKey: true, shiftKey: true }), "Ctrl + T", "pc"),
    ).toBe(false);
    expect(matchesKeyBinding(keyEvent("t", { ctrlKey: true, altKey: true }), "Ctrl + T", "pc")).toBe(
      false,
    );
    expect(matchesKeyBinding(keyEvent("t", {}), "Ctrl + T", "pc")).toBe(false);
  });

  it("平台修饰键互斥：PC 方案不匹配 Mac 绑定，反之亦然", () => {
    expect(matchesKeyBinding(keyEvent("t", { ctrlKey: true }), "⌘ + T", "pc")).toBe(false);
    expect(matchesKeyBinding(keyEvent("t", { metaKey: true }), "Ctrl + T", "mac")).toBe(false);
    expect(matchesKeyBinding(keyEvent("t", { metaKey: true }), "⌘ + T", "mac")).toBe(true);
    expect(
      matchesKeyBinding(keyEvent("k", { metaKey: true, ctrlKey: true }), "⌘ + ⌃ + K", "mac"),
    ).toBe(true);
  });

  it("[1...9]：物理 Digit 码优先，Shift+1（e.key='!'）也能命中", () => {
    const range = "Ctrl + [1...9]";
    expect(matchesKeyBinding(keyEvent("1", { ctrlKey: true }, "Digit1"), range, "pc")).toBe(true);
    expect(matchesKeyBinding(keyEvent("!", { ctrlKey: true }, "Digit1"), range, "pc")).toBe(true);
    expect(matchesKeyBinding(keyEvent("0", { ctrlKey: true }, "Digit0"), range, "pc")).toBe(false);
    expect(matchesKeyBinding(keyEvent("1", {}, "Digit1"), range, "pc")).toBe(false);
  });

  it("arrows：方向键映射为 ↑↓←→", () => {
    expect(
      matchesKeyBinding(
        keyEvent("ArrowLeft", { ctrlKey: true, altKey: true }),
        "Ctrl + Alt + arrows",
        "pc",
      ),
    ).toBe(true);
    expect(
      matchesKeyBinding(keyEvent("ArrowUp", { ctrlKey: true }), "Ctrl + Alt + arrows", "pc"),
    ).toBe(false);
  });

  it("Disabled 绑定永远不命中", () => {
    expect(
      matchesKeyBinding(keyEvent("l", { metaKey: true }), "Disabled", "mac"),
    ).toBe(false);
  });
});

describe("tabShortcutDigitFromEvent", () => {
  it("优先物理 code；非数字键返回 null", () => {
    expect(tabShortcutDigitFromEvent({ key: "!", code: "Digit1" })).toBe(1);
    expect(tabShortcutDigitFromEvent({ key: "3", code: "Digit3" })).toBe(3);
    expect(tabShortcutDigitFromEvent({ key: "A", code: "KeyA" })).toBeNull();
  });
});

describe("findMatchingBinding / 冲突优先级", () => {
  it("同一组合键冲突时按 DEFAULT_KEY_BINDINGS 表格顺序取第一条", () => {
    const settings = {
      ...pcSettings,
      customKeyBindings: {
        "close-tab": { pc: "Ctrl + K" },
        "new-tab": { pc: "Ctrl + K" },
      },
    } as typeof pcSettings;
    const match = findMatchingBinding(keyEvent("k", { ctrlKey: true }), settings);
    expect(match?.binding.action).toBe("closeTab");
  });

  it("禁用条目跳过，不参与分发", () => {
    const settings = {
      ...pcSettings,
      disabledKeyBindings: ["switch-tab-1-9"],
    };
    expect(findMatchingBinding(keyEvent("1", { ctrlKey: true }, "Digit1"), settings)).toBeNull();
  });

  it("findBindingConflicts 找出同方案同组合的条目", () => {
    const conflicts = findBindingConflicts(
      [
        { id: "close-tab", keyStr: "Ctrl + K" },
        { id: "new-tab", keyStr: "Ctrl + K" },
        { id: "search", keyStr: "Ctrl + Shift + C" },
        { id: "copy", keyStr: "Ctrl + Shift + C" },
        { id: "other", keyStr: "Ctrl + L" },
      ],
      "pc",
    );
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].ids).toEqual(["close-tab", "new-tab"]);
    expect(conflicts[1].ids).toEqual(["search", "copy"]);
  });

  it("keyStringToKeyboardEvent 能重建冲突键事件", () => {
    const e = keyStringToKeyboardEvent("Ctrl + Shift + K");
    expect(e?.key).toBe("k");
    expect(e?.ctrlKey).toBe(true);
    expect(e?.shiftKey).toBe(true);
  });
});

describe("标签序号目标", () => {
  it("默认：Vault / SFTP / 会话标签依序编号", () => {
    const targets = buildNumberShortcutTabTargets({
      showSftpTab: true,
      shellOnlyTabNumberShortcuts: false,
      sessionTabIds: ["a", "b"],
    });
    expect(targets).toEqual([PINNED_VAULT_TAB_ID, PINNED_SFTP_TAB_ID, "a", "b"]);
    const map = buildTabShortcutNumberById({
      showSftpTab: true,
      shellOnlyTabNumberShortcuts: false,
      sessionTabIds: ["a", "b"],
    });
    expect(map.get(PINNED_VAULT_TAB_ID)).toBe(1);
    expect(map.get(PINNED_SFTP_TAB_ID)).toBe(2);
    expect(map.get("a")).toBe(3);
    expect(map.get("b")).toBe(4);
  });

  it("「仅固定标签」开关：只用会话标签编号", () => {
    const targets = buildNumberShortcutTabTargets({
      showSftpTab: true,
      shellOnlyTabNumberShortcuts: true,
      sessionTabIds: ["a", "b"],
    });
    expect(targets).toEqual(["a", "b"]);
    expect(
      buildTabShortcutNumberById({
        showSftpTab: true,
        shellOnlyTabNumberShortcuts: true,
        sessionTabIds: ["a", "b"],
      }).get("a"),
    ).toBe(1);
  });

  it("关闭 SFTP 标签页时不占序号", () => {
    expect(
      buildNumberShortcutTabTargets({
        showSftpTab: false,
        shellOnlyTabNumberShortcuts: false,
        sessionTabIds: ["a"],
      }),
    ).toEqual([PINNED_VAULT_TAB_ID, "a"]);
  });

  it("最多 9 个角标", () => {
    const map = buildTabShortcutNumberById({
      showSftpTab: true,
      shellOnlyTabNumberShortcuts: true,
      sessionTabIds: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    });
    expect(map.size).toBe(9);
    expect(map.has("10")).toBe(false);
  });
});

describe("修饰键按住检测", () => {
  const requirements = getShortcutModifierRequirements("Ctrl + [1...9]", "pc");
  expect(requirements).not.toBeNull();

  it("精确匹配：按住 Ctrl 显示，Ctrl+Shift 不显示", () => {
    expect(isShortcutModifierHeld(keyEvent("Control", { ctrlKey: true }), requirements)).toBe(true);
    expect(
      isShortcutModifierHeld(keyEvent("Control", { ctrlKey: true, shiftKey: true }), requirements),
    ).toBe(false);
    expect(isShortcutModifierHeld(keyEvent("Control", {}), requirements)).toBe(false);
  });

  it("非范围绑定 / 禁用不产生角标", () => {
    expect(getShortcutModifierRequirements("Ctrl + T", "pc")).toBeNull();
    expect(getShortcutModifierRequirements(null, "pc")).toBeNull();
    expect(getShortcutModifierRequirements("Disabled", "pc")).toBeNull();
  });

  it("Mac 方案使用 ⌘", () => {
    expect(
      isShortcutModifierHeld(
        keyEvent("Meta", { metaKey: true }),
        getShortcutModifierRequirements("⌘ + [1...9]", "mac"),
      ),
    ).toBe(true);
  });
});

describe("resolveFocusTarget", () => {
  const panes = [
    { paneId: "left", rect: { left: 0, top: 0, width: 0.5, height: 1 } },
    { paneId: "right", rect: { left: 0.5, top: 0, width: 0.5, height: 1 } },
    { paneId: "bottom", rect: { left: 0, top: 0.5, width: 1, height: 0.5 } },
  ];

  it("按方向找最近窗格", () => {
    expect(resolveFocusTarget(panes, "left", "right")).toBe("right");
    expect(resolveFocusTarget(panes, "right", "left")).toBe("left");
    expect(resolveFocusTarget(panes, "left", "down")).toBe("bottom");
  });

  it("无邻居 / 单窗格返回 null", () => {
    expect(resolveFocusTarget(panes, "right", "right")).toBeNull();
    expect(resolveFocusTarget([panes[0]], "left", "right")).toBeNull();
  });
});
