import { describe, expect, it } from "vitest";
import {
  clampSidePanelWidth,
  getSidePanelMaxShownTools,
  getSidePanelMaxWidth,
  parseStoredSidePanelWidth,
  resolveSidePanelToolTabs,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SIDE_PANEL_TOOLS,
} from "./terminalSidePanel";

describe("terminalSidePanel", () => {
  it("宽度上限给终端至少留 320px", () => {
    expect(getSidePanelMaxWidth(1600)).toBe(1200);
    expect(getSidePanelMaxWidth(1000)).toBe(680);
    expect(getSidePanelMaxWidth(500)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it("夹取宽度：最小 280 / 默认 420 / 越界收敛", () => {
    expect(clampSidePanelWidth(420, 1600)).toBe(420);
    expect(clampSidePanelWidth(200, 1600)).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(clampSidePanelWidth(9999, 1600)).toBe(1200);
    // 窗口很窄时上限可能低于 280，此时直接取上限且不溢出
    expect(clampSidePanelWidth(420, 500)).toBe(280);
    expect(clampSidePanelWidth(Number.NaN, 1600)).toBe(SIDE_PANEL_DEFAULT_WIDTH);
  });

  it("最大内联工具数按按钮 28 / 预留 200 计算", () => {
    expect(getSidePanelMaxShownTools(420)).toBe(7);
    expect(getSidePanelMaxShownTools(280)).toBe(2);
    expect(getSidePanelMaxShownTools(100)).toBe(1);
  });

  it("工具页按宽度分配内联 / 溢出", () => {
    expect(resolveSidePanelToolTabs(SIDE_PANEL_TOOLS, 420)).toEqual({
      shown: ["sftp", "scripts", "history", "notes"],
      hidden: [],
    });
    expect(resolveSidePanelToolTabs(SIDE_PANEL_TOOLS, 280)).toEqual({
      shown: ["sftp", "scripts"],
      hidden: ["history", "notes"],
    });
  });

  it("持久化宽度解析：空 / 非法回落默认，越界夹取", () => {
    expect(parseStoredSidePanelWidth(null, 1600)).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    expect(parseStoredSidePanelWidth("", 1600)).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    expect(parseStoredSidePanelWidth("abc", 1600)).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    expect(parseStoredSidePanelWidth("500", 1600)).toBe(500);
    expect(parseStoredSidePanelWidth("100", 1600)).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(parseStoredSidePanelWidth("2000", 1600)).toBe(1200);
  });
});
