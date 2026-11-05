import { describe, expect, it } from "vitest";
import {
  TERMINAL_INSETS,
  TERMINAL_PANE_PADDING,
  TERMINAL_VIEW_INSETS,
  terminalContentSize,
  terminalInsetsStyle,
} from "./terminalInsets";

describe("terminalInsets（对照 Netcatty 的 xterm 容器留白）", () => {
  it("视口边留白：左 10 / 右 4 / 上 4 / 下 4", () => {
    expect(TERMINAL_VIEW_INSETS).toEqual({
      top: 4,
      right: 4,
      bottom: 4,
      left: 10,
    });
  });

  it("pane 已提供 4px，终端侧只补左侧 6px", () => {
    expect(TERMINAL_PANE_PADDING).toBe(4);
    expect(TERMINAL_INSETS).toEqual({ top: 0, right: 0, bottom: 0, left: 6 });
  });

  it("样式使用 border-box，避免 100% 宽高被 padding 撑出滚动", () => {
    expect(terminalInsetsStyle()).toEqual({
      padding: "0px 0px 0px 6px",
      boxSizing: "border-box",
    });
  });

  it("可用内容尺寸扣除左右 14、上下 8", () => {
    expect(terminalContentSize(800, 600)).toEqual({ width: 786, height: 592 });
  });

  it("极小尺寸收敛为 0", () => {
    expect(terminalContentSize(5, 3)).toEqual({ width: 0, height: 0 });
  });
});
