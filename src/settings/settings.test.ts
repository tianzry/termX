/**
 * 设置中心纯逻辑单测（R11）：normalize/默认值/clamp、快捷键合并与捕获、i18n 回落。
 * 不依赖真实 Tauri 运行时。
 */

import { describe, expect, it } from "vitest";
import { settingsT } from "./i18n";
import { accentToHslTriplet, hexToHslTriplet, readableForeground } from "./settingsStore";
import { DEFAULT_UI_FONT_ID, UI_FONTS, withUiCjkFallback } from "./uiFonts";
import { DARK_UI_THEMES, LIGHT_UI_THEMES, getUiThemeById } from "./uiThemes";
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
    expect(s.terminal.disconnectedNoticeMode).toBe("terminal");
    expect(s.terminal.rightClickBehavior).toBe("context-menu");
    expect(s.terminal.middleClickBehavior).toBe("paste");
    expect(s.terminal.shiftEnterNewlineEnabled).toBe(true);
    expect(s.terminal.optionArrowWordJump).toBe(false);
    expect(normalizeSettings({ terminal: { optionArrowWordJump: true } }).terminal.optionArrowWordJump).toBe(
      true,
    );
  });

  it("旧版右键 / 中键 / 断开提示取值迁移到 Netcatty 枚举", () => {
    expect(normalizeSettings({ terminal: { rightClickBehavior: "menu" } }).terminal.rightClickBehavior).toBe(
      "context-menu",
    );
    expect(normalizeSettings({ terminal: { middleClickBehavior: "none" } }).terminal.middleClickBehavior).toBe(
      "disabled",
    );
    expect(normalizeSettings({ terminal: { middleClickBehavior: "copy" } }).terminal.middleClickBehavior).toBe(
      "paste",
    );
    expect(normalizeSettings({ terminal: { disconnectPrompt: true } }).terminal.disconnectedNoticeMode).toBe(
      "dialog",
    );
    expect(normalizeSettings({ terminal: { disconnectPrompt: false } }).terminal.disconnectedNoticeMode).toBe(
      "terminal",
    );
  });

  it("terminal.followAppTheme 默认 true 且可被输入覆盖", () => {
    expect(normalizeSettings(null).terminal.followAppTheme).toBe(true);
    expect(normalizeSettings({ terminal: { followAppTheme: false } }).terminal.followAppTheme).toBe(false);
  });

  it("终端字号 clamp 到 [10, 32]（对照 Netcatty MIN/MAX_FONT_SIZE）", () => {
    expect(normalizeSettings({ terminalFontSize: 99 }).terminalFontSize).toBe(32);
    expect(normalizeSettings({ terminalFontSize: 2 }).terminalFontSize).toBe(10);
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

  it("appIconVariant 白名单：未知值回落 original", () => {
    expect(normalizeSettings({ appIconVariant: "rainbow" }).appIconVariant).toBe("rainbow");
    expect(normalizeSettings({ appIconVariant: "highContrast" }).appIconVariant).toBe("original");
    expect(normalizeSettings({ appIconVariant: 42 }).appIconVariant).toBe("original");
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

describe("SFTP 设置", () => {
  it("双击行为 / 隐藏文件 / 并发数默认、枚举校验与 clamp（对照 Netcatty）", () => {
    expect(DEFAULT_SETTINGS.sftpDoubleClickBehavior).toBe("open");
    expect(DEFAULT_SETTINGS.sftpShowHiddenFiles).toBe(false);
    expect(DEFAULT_SETTINGS.sftpTransferConcurrency).toBe(6);
    expect(
      normalizeSettings({ sftpDoubleClickBehavior: "transfer" }).sftpDoubleClickBehavior,
    ).toBe("transfer");
    expect(
      normalizeSettings({ sftpDoubleClickBehavior: "nope" }).sftpDoubleClickBehavior,
    ).toBe("open");
    expect(normalizeSettings({ sftpShowHiddenFiles: true }).sftpShowHiddenFiles).toBe(true);
    expect(normalizeSettings({ sftpTransferConcurrency: 0 }).sftpTransferConcurrency).toBe(1);
    expect(normalizeSettings({ sftpTransferConcurrency: 99 }).sftpTransferConcurrency).toBe(16);
    expect(normalizeSettings({ sftpTransferConcurrency: "x" }).sftpTransferConcurrency).toBe(6);
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

describe("accentToHslTriplet", () => {
  it("hex 转 HSL 三元组（供 hsl(var(--primary)) 消费）", () => {
    expect(hexToHslTriplet("#ff0000")).toBe("0 100% 50%");
    expect(hexToHslTriplet("#000000")).toBe("0 0% 0%");
    expect(hexToHslTriplet("#ffffff")).toBe("0 0% 100%");
    expect(hexToHslTriplet("#3b82f6")).toBe("217.2 91.2% 59.8%");
    expect(hexToHslTriplet("nope")).toBeNull();
    expect(hexToHslTriplet("#12345")).toBeNull();
  });

  it("Netcatty 风格三元组原样通过，非法值拒绝", () => {
    expect(accentToHslTriplet("221.2 83.2% 53.3%")).toBe("221.2 83.2% 53.3%");
    expect(accentToHslTriplet(" #3b82f6 ")).toBe("217.2 91.2% 59.8%");
    expect(accentToHslTriplet("red")).toBeNull();
    expect(accentToHslTriplet("221.2 83.2 53.3")).toBeNull();
  });
});

describe("UI 主题预设库（1:1 移植 Netcatty）", () => {
  it("浅色 / 深色预设数量与调色值完整", () => {
    expect(LIGHT_UI_THEMES.length).toBeGreaterThanOrEqual(60);
    expect(DARK_UI_THEMES.length).toBeGreaterThanOrEqual(60);
    for (const preset of [...LIGHT_UI_THEMES, ...DARK_UI_THEMES]) {
      expect(preset.tokens.background).toMatch(/^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/);
      expect(preset.tokens.foreground).toBeTruthy();
    }
  });

  it("未知 id 回落该模式首个预设", () => {
    expect(getUiThemeById("dark", "no-such-theme")).toBe(DARK_UI_THEMES[0]);
    expect(getUiThemeById("light", "midnight").id).toBe("snow");
  });
});

describe("UI 字体预设（1:1 移植 Netcatty）", () => {
  it("预设数量、默认值与 CJK 回退链", () => {
    expect(UI_FONTS.length).toBe(22);
    expect(DEFAULT_UI_FONT_ID).toBe("mona-sans");
    expect(UI_FONTS[0].id).toBe(DEFAULT_UI_FONT_ID);
    for (const font of UI_FONTS) {
      expect(font.family).toContain("Microsoft YaHei");
      expect(withUiCjkFallback(font.family)).toBe(font.family);
    }
  });
});

describe("readableForeground（强调色前景对比度）", () => {
  it("深色强调色用白字，浅色强调色用黑字", () => {
    expect(readableForeground("0 0% 0%")).toBe("0 0% 100%");
    expect(readableForeground("0 0% 100%")).toBe("0 0% 0%");
    expect(readableForeground("bad-value", "1 2% 3%")).toBe("1 2% 3%");
  });
});

describe("settingsT", () => {
  it("zh-CN 命中、en 缺键回落 zh-CN、未知键回落 key", () => {
    expect(settingsT("zh-CN", "settings.title")).toBe("设置");
    expect(settingsT("en", "settings.title")).toBe("Settings");
    // en 词典目前只覆盖应用/外观等 tab，快捷键 tab 仍回落 zh-CN。
    expect(settingsT("en", "settings.shortcuts.section.scheme")).toBe("快捷键方案");
    expect(settingsT("zh-CN", "no.such.key")).toBe("no.such.key");
  });

  it("参数替换", () => {
    expect(settingsT("zh-CN", "no.such", { a: 1 })).toBe("no.such");
  });
});
