/**
 * 设置中心纯逻辑单测（R11）：normalize/默认值/clamp、快捷键合并与捕获、i18n 回落。
 * 不依赖真实 Tauri 运行时。
 */

import { describe, expect, it } from "vitest";
import { settingsT } from "./i18n";
import {
  DEFAULT_KEY_BINDINGS,
  captureBinding,
  effectiveBinding,
  normalizeKeyName,
} from "./keyBindings";
import {
  DEFAULT_SETTINGS,
  clampWindowOpacity,
  normalizeSettings,
} from "./settingsModel";

describe("normalizeSettings", () => {
  it("空 / 损坏输入回落默认值", () => {
    expect(normalizeSettings(null).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(normalizeSettings("garbage").language).toBe("zh-CN");
    expect(normalizeSettings({ theme: "neon" }).theme).toBe("system");
  });

  it("窗口透明度 clamp 到 [0.5, 1]", () => {
    expect(clampWindowOpacity(0.1)).toBe(0.5);
    expect(clampWindowOpacity(2)).toBe(1);
    expect(clampWindowOpacity("x")).toBe(1);
    expect(normalizeSettings({ windowOpacity: 0.2 }).windowOpacity).toBe(0.5);
    expect(normalizeSettings({ windowOpacity: 0.75 }).windowOpacity).toBe(0.75);
  });

  it("嵌套 terminal 设置合并且缺字段回落默认", () => {
    const s = normalizeSettings({ terminal: { scrollback: 500 } });
    expect(s.terminal.scrollback).toBe(500);
    expect(s.terminal.cursorShape).toBe("block");
    expect(s.terminal.disconnectPrompt).toBe(true);
  });

  it("终端字号 clamp 到 [8, 32]", () => {
    expect(normalizeSettings({ terminalFontSize: 99 }).terminalFontSize).toBe(32);
    expect(normalizeSettings({ terminalFontSize: 2 }).terminalFontSize).toBe(8);
  });

  it("过滤非法 customKeyBindings / disabledKeyBindings", () => {
    const s = normalizeSettings({
      customKeyBindings: { "new-tab": { pc: "Ctrl + N" }, bad: "x" },
      disabledKeyBindings: ["copy", 42],
    });
    expect(s.customKeyBindings["new-tab"]).toEqual({ pc: "Ctrl + N" });
    expect(s.customKeyBindings.bad).toBeUndefined();
    expect(s.disabledKeyBindings).toEqual(["copy"]);
  });

  it("networkProxy / sessionLogs 枚举值校验", () => {
    const s = normalizeSettings({
      networkProxy: { mode: "weird", url: "http://x" },
      sessionLogs: { format: "pdf" },
    });
    expect(s.networkProxy.mode).toBe("system");
    expect(s.networkProxy.url).toBe("http://x");
    expect(s.sessionLogs.format).toBe("txt");
  });
});

describe("keyBindings", () => {
  it("默认绑定 id 唯一且覆盖五个分类", () => {
    const ids = DEFAULT_KEY_BINDINGS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(DEFAULT_KEY_BINDINGS.map((b) => b.category));
    expect(cats).toEqual(new Set(["tabs", "terminal", "navigation", "app", "sftp"]));
  });

  it("effectiveBinding 优先自定义覆盖", () => {
    const b = DEFAULT_KEY_BINDINGS.find((x) => x.id === "new-tab")!;
    expect(effectiveBinding(b, { customKeyBindings: {} }, "pc")).toBe(b.pc);
    expect(
      effectiveBinding(b, { customKeyBindings: { "new-tab": { pc: "Ctrl + N" } } }, "pc"),
    ).toBe("Ctrl + N");
    // mac 方案不受 pc 覆盖影响
    expect(
      effectiveBinding(b, { customKeyBindings: { "new-tab": { pc: "Ctrl + N" } } }, "mac"),
    ).toBe(b.mac);
  });

  it("normalizeKeyName 映射方向键与特殊键", () => {
    expect(normalizeKeyName("ArrowUp")).toBe("↑");
    expect(normalizeKeyName("Escape")).toBe("Esc");
    expect(normalizeKeyName(" ")).toBe("Space");
    expect(normalizeKeyName("k")).toBe("k");
  });

  it("captureBinding 忽略纯修饰键并生成 pc 文本", () => {
    expect(captureBinding(new KeyboardEvent("keydown", { key: "Control" }), "pc")).toBeNull();
    expect(captureBinding(new KeyboardEvent("keydown", { key: "Shift" }), "pc")).toBeNull();
    const ev = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true });
    expect(captureBinding(ev, "pc")).toBe("Ctrl + Shift + k");
  });
});

describe("settingsT", () => {
  it("zh-CN 命中、en 缺键回落 zh-CN、未知键回落 key", () => {
    expect(settingsT("zh-CN", "settings.title")).toBe("设置");
    expect(settingsT("en", "settings.title")).toBe("Settings");
    expect(settingsT("en", "settings.vault.title")).toBe("主机库");
    expect(settingsT("zh-CN", "no.such.key")).toBe("no.such.key");
  });

  it("参数替换", () => {
    expect(settingsT("zh-CN", "no.such", { a: 1 })).toBe("no.such");
  });
});
