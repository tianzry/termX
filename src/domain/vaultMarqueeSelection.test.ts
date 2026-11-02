import { describe, expect, it } from "vitest";
import {
  clientPointToContent,
  exceedsMarqueeThreshold,
  hostIdsIntersectingMarquee,
  marqueeAutoScrollDelta,
  marqueeCommitSelection,
  marqueeRectFromPoints,
  marqueeSelectionMode,
  mergeMarqueeSelection,
  rectsIntersect,
  shouldStartVaultMarquee,
} from "./vaultMarqueeSelection";

describe("marqueeRectFromPoints", () => {
  it("任意拖拽方向都归一化为左上/右下矩形", () => {
    expect(marqueeRectFromPoints({ x: 90, y: 80 }, { x: 10, y: 20 })).toEqual({
      left: 10,
      top: 20,
      right: 90,
      bottom: 80,
    });
  });
});

describe("exceedsMarqueeThreshold", () => {
  it("微小移动不触发框选", () => {
    expect(exceedsMarqueeThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
  });

  it("达到阈值即触发", () => {
    expect(exceedsMarqueeThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(exceedsMarqueeThreshold({ x: 0, y: 0 }, { x: 0, y: -4 })).toBe(true);
  });
});

describe("marqueeSelectionMode", () => {
  it("Ctrl/Meta 切换、Shift 追加、裸拖替换", () => {
    expect(marqueeSelectionMode({ shiftKey: false, ctrlKey: true, metaKey: false })).toBe("toggle");
    expect(marqueeSelectionMode({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe("toggle");
    expect(marqueeSelectionMode({ shiftKey: true, ctrlKey: false, metaKey: false })).toBe("add");
    expect(marqueeSelectionMode({ shiftKey: false, ctrlKey: false, metaKey: false })).toBe("replace");
  });
});

describe("rectsIntersect", () => {
  it("相交为 true", () => {
    expect(
      rectsIntersect(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 5, top: 5, right: 15, bottom: 15 },
      ),
    ).toBe(true);
  });

  it("仅边缘相接不算相交", () => {
    expect(
      rectsIntersect(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 10, top: 0, right: 20, bottom: 10 },
      ),
    ).toBe(false);
  });
});

describe("mergeMarqueeSelection", () => {
  const baseline = new Set(["a", "b"]);
  const hits = new Set(["b", "c"]);

  it("replace 只保留命中项", () => {
    expect(mergeMarqueeSelection(baseline, hits, "replace")).toEqual(new Set(["b", "c"]));
  });

  it("add 并入已有选择", () => {
    expect(mergeMarqueeSelection(baseline, hits, "add")).toEqual(new Set(["a", "b", "c"]));
  });

  it("toggle 去掉已选中的命中项、加入新命中项", () => {
    expect(mergeMarqueeSelection(baseline, hits, "toggle")).toEqual(new Set(["a", "c"]));
  });
});

describe("hostIdsIntersectingMarquee", () => {
  it("收集被框选命中的主机 id", () => {
    const marquee = { left: 0, top: 0, right: 50, bottom: 50 };
    const placements = [
      { id: "in", rect: { left: 10, top: 10, right: 30, bottom: 30 } },
      { id: "out", rect: { left: 60, top: 60, right: 80, bottom: 80 } },
    ];
    expect(hostIdsIntersectingMarquee(marquee, placements)).toEqual(new Set(["in"]));
  });
});

describe("clientPointToContent", () => {
  it("视口坐标换算为含滚动量的内容坐标", () => {
    const point = clientPointToContent(
      { x: 120, y: 80 },
      { left: 20, top: 10, scrollLeft: 200, scrollTop: 100, clientLeft: 2, clientTop: 1 },
    );
    expect(point).toEqual({ x: 298, y: 169 });
  });
});

describe("marqueeAutoScrollDelta", () => {
  it("靠近起点边缘反向滚、靠近终点边缘正向滚、中间不动", () => {
    expect(marqueeAutoScrollDelta(10, 0, 400)).toBeLessThan(0);
    expect(marqueeAutoScrollDelta(395, 0, 400)).toBeGreaterThan(0);
    expect(marqueeAutoScrollDelta(200, 0, 400)).toBe(0);
  });
});

describe("shouldStartVaultMarquee", () => {
  const ok = { viewMode: "grid", button: 0, onScrollbar: false, blockedTarget: false };

  it("只允许 grid/list 视图的鼠标左键", () => {
    expect(shouldStartVaultMarquee(ok)).toBe(true);
    expect(shouldStartVaultMarquee({ ...ok, viewMode: "list" })).toBe(true);
    expect(shouldStartVaultMarquee({ ...ok, viewMode: "kanban" })).toBe(false);
    expect(shouldStartVaultMarquee({ ...ok, button: 2 })).toBe(false);
  });

  it("触摸、滚动条与被拦截目标不启动框选", () => {
    expect(shouldStartVaultMarquee({ ...ok, pointerType: "touch" })).toBe(false);
    expect(shouldStartVaultMarquee({ ...ok, onScrollbar: true })).toBe(false);
    expect(shouldStartVaultMarquee({ ...ok, blockedTarget: true })).toBe(false);
  });
});

describe("marqueeCommitSelection", () => {
  it("提交非空选择后进入多选模式", () => {
    const r = marqueeCommitSelection({ wasMultiSelectMode: false, nextIds: new Set(["a"]) });
    expect(r.isMultiSelectMode).toBe(true);
    expect(r.selectedHostIds).toEqual(new Set(["a"]));
  });

  it("多选模式下提交空选择仍保持多选模式", () => {
    const r = marqueeCommitSelection({ wasMultiSelectMode: true, nextIds: new Set() });
    expect(r.isMultiSelectMode).toBe(true);
    expect(r.selectedHostIds.size).toBe(0);
  });
});
