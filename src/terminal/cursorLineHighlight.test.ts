/** 光标行高亮纯函数（对照 Netcatty domain/cursorLineHighlight.test.ts）。 */

import { describe, expect, it } from "vitest";
import {
  CURSOR_LINE_HIGHLIGHT_BLEND,
  ensureCursorLineHighlightContrast,
  resolveCursorLineHighlightBackground,
} from "./cursorLineHighlight";

describe("resolveCursorLineHighlightBackground", () => {
  it("把选区色混进主题底色", () => {
    expect(
      resolveCursorLineHighlightBackground({
        background: "#0d1117",
        foreground: "#c9d1d9",
        selection: "#264f78",
      }),
    ).toBe("#1b334c");
  });

  it("选区色非法时回退到前景色", () => {
    const withSelection = resolveCursorLineHighlightBackground({
      background: "#000000",
      foreground: "#ffffff",
      selection: "#808080",
    });
    const withoutSelection = resolveCursorLineHighlightBackground({
      background: "#000000",
      foreground: "#ffffff",
      selection: "not-a-color",
    });
    expect(withSelection).toBe("#464646");
    expect(withoutSelection).toBe("#707070");
  });

  it("展开短 hex 并忽略 alpha", () => {
    expect(
      resolveCursorLineHighlightBackground({
        background: "#000",
        foreground: "#fff",
        selection: "#88888888",
      }),
    ).toBe("#4b4b4b");
  });

  it("支持 termX 主题里的 rgba 选区色", () => {
    const color = resolveCursorLineHighlightBackground({
      background: "#0d1117",
      foreground: "#e6edf3",
      selection: "rgba(106, 161, 255, 0.28)",
    });
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(color).not.toBe("#0d1117");
  });

  it("白色前景保持可读（对比度 ≥ 4.5）", () => {
    const color = resolveCursorLineHighlightBackground({
      background: "#0d1117",
      foreground: "#ffffff",
      selection: "#ffffff",
    });
    const channel = Number.parseInt(color.slice(1, 3), 16) / 255;
    const luminance =
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it("修复低对比度浅色主题", () => {
    expect(
      resolveCursorLineHighlightBackground({
        background: "#f0f0f0",
        foreground: "#888888",
        selection: "#ffffff",
      }),
    ).toBe("#000000");
  });

  it("浅色终端主题不与底色相同", () => {
    expect(
      resolveCursorLineHighlightBackground({
        background: "#ffffff",
        foreground: "#16202b",
        selection: "rgba(10, 132, 255, 0.22)",
      }),
    ).not.toBe("#ffffff");
  });

  it("Tokyo Night Light 仍然可见", () => {
    expect(
      resolveCursorLineHighlightBackground({
        background: "#e1e2e7",
        foreground: "#3760bf",
        selection: "#abc7d4",
      }),
    ).not.toBe("#e1e2e7");
  });

  it("混合比例保持可见", () => {
    expect(CURSOR_LINE_HIGHLIGHT_BLEND).toBeGreaterThan(0);
    expect(CURSOR_LINE_HIGHLIGHT_BLEND).toBeLessThan(1);
  });
});

describe("ensureCursorLineHighlightContrast", () => {
  it("关键字蓝前景下改用黑色底", () => {
    expect(ensureCursorLineHighlightContrast("#1b334c", ["#3b82f6"])).toBe("#000000");
  });

  it("无需调整时原样返回", () => {
    expect(ensureCursorLineHighlightContrast("#000000", ["#ffffff"])).toBe("#000000");
  });
});
