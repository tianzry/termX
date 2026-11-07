import { describe, expect, it } from "vitest";
import { placeAnchoredPopover } from "./popoverPosition";

// 侧栏工具条「更多」按钮的真实几何：贴窗口左缘、24px 宽。
const SIDEBAR_MORE = { top: 42, left: 110, right: 134, bottom: 66 };

describe("placeAnchoredPopover", () => {
  it("右对齐菜单向左溢出时收拢到视口左边距内", () => {
    const p = placeAnchoredPopover(
      SIDEBAR_MORE,
      { width: 148, height: 122 },
      { width: 1200, height: 800 },
    );
    expect(p.left).toBe(8);
    expect(p.top).toBe(70);
    expect(p.maxHeight).toBeNull();
  });

  it("标签菜单（236px）同样收拢，完整落在视口内", () => {
    const p = placeAnchoredPopover(
      SIDEBAR_MORE,
      { width: 236, height: 52 },
      { width: 1200, height: 800 },
    );
    expect(p.left).toBe(8);
    expect(p.left + 236).toBeLessThanOrEqual(1200 - 8);
  });

  it("右缘溢出时收拢到视口右边距内", () => {
    const p = placeAnchoredPopover(
      { top: 42, left: 1190, right: 1200, bottom: 66 },
      { width: 148, height: 122 },
      { width: 1200, height: 800 },
    );
    expect(p.left).toBe(1200 - 148 - 8);
  });

  it("align=start 时左对齐锚点左边", () => {
    const p = placeAnchoredPopover(
      { top: 42, left: 110, right: 134, bottom: 66 },
      { width: 148, height: 122 },
      { width: 1200, height: 800 },
      { align: "start" },
    );
    expect(p.left).toBe(110);
  });

  it("锚点靠近视口底部且上方更宽松时自动上翻", () => {
    const p = placeAnchoredPopover(
      { top: 220, left: 300, right: 324, bottom: 250 },
      { width: 148, height: 120 },
      { width: 1200, height: 300 },
    );
    expect(p.top).toBe(220 - 4 - 120);
    expect(p.maxHeight).toBeNull();
  });

  it("上下都放不下时选择空间更大的一侧并限高", () => {
    const p = placeAnchoredPopover(
      { top: 60, left: 300, right: 324, bottom: 80 },
      { width: 148, height: 180 },
      { width: 1200, height: 200 },
    );
    expect(p.top).toBe(84);
    expect(p.maxHeight).toBe(108);
  });

  it("菜单高于视口时贴顶并限制高度", () => {
    const p = placeAnchoredPopover(
      { top: 150, left: 300, right: 324, bottom: 170 },
      { width: 236, height: 300 },
      { width: 400, height: 200 },
    );
    expect(p.top).toBe(8);
    expect(p.maxHeight).toBe(184);
    expect(p.left).toBe(88);
  });

  it("浮层比视口还宽时至少保留左边距", () => {
    const p = placeAnchoredPopover(
      SIDEBAR_MORE,
      { width: 400, height: 100 },
      { width: 200, height: 800 },
    );
    expect(p.left).toBe(8);
  });
});
