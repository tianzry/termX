import { describe, expect, it } from "vitest";
import {
  formatTerminalTimestamp,
  pruneTerminalTimestampLines,
  resolveTerminalTimestampGutterWidth,
  resolveVisibleTerminalTimestampRows,
  stampTerminalTimestampLines,
} from "./terminalTimestamps";

describe("formatTerminalTimestamp", () => {
  it("HH:mm:ss 24 小时制补零", () => {
    expect(formatTerminalTimestamp(new Date(2026, 10, 5, 9, 5, 7))).toBe(
      "09:05:07",
    );
    expect(formatTerminalTimestamp(new Date(2026, 10, 5, 23, 59, 0))).toBe(
      "23:59:00",
    );
  });
});

describe("resolveTerminalTimestampGutterWidth", () => {
  it("最小 56px（Netcatty 值）", () => {
    expect(resolveTerminalTimestampGutterWidth({ measuredTextWidth: 10 })).toBe(56);
  });

  it("大字号按测量宽度 + 16px 内边距", () => {
    expect(
      resolveTerminalTimestampGutterWidth({ measuredTextWidth: 70 }),
    ).toBe(86);
  });

  it("无测量值时按 0.62em 估算", () => {
    // 24 * 8 * 0.62 = 119.04 + 16 = 135.04 → 136
    expect(resolveTerminalTimestampGutterWidth({ fontSize: 24 })).toBe(136);
  });
});

describe("resolveVisibleTerminalTimestampRows", () => {
  it("按视口绝对行映射，跳过软换行续行", () => {
    const stamps = new Map<number, string>([
      [10, "10:00:00"],
      [12, "10:00:01"],
    ]);
    const wrapped = new Set([12]);
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps,
        viewportY: 9,
        rows: 5,
        isWrapped: (line) => wrapped.has(line),
      }),
    ).toEqual([{ row: 1, label: "10:00:00" }]);
  });

  it("只显示视口内的行", () => {
    const stamps = new Map<number, string>([[5, "old"], [20, "new"]]);
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps,
        viewportY: 18,
        rows: 3,
        isWrapped: () => false,
      }),
    ).toEqual([{ row: 2, label: "new" }]);
  });
});

describe("stampTerminalTimestampLines", () => {
  it("从上次已知行之后逐行补时间，已打过的行不覆盖", () => {
    const stamps = new Map<number, string>([[4, "09:00:00"]]);
    const next = stampTerminalTimestampLines({
      stamps,
      previousAbsolute: 4,
      currentAbsolute: 7,
      label: "09:00:05",
      isWrapped: () => false,
    });
    expect(next).toBe(7);
    expect(stamps.get(4)).toBe("09:00:00");
    expect(stamps.get(5)).toBe("09:00:05");
    expect(stamps.get(7)).toBe("09:00:05");
  });

  it("软换行续行不重复打时间", () => {
    const stamps = new Map<number, string>();
    stampTerminalTimestampLines({
      stamps,
      previousAbsolute: 1,
      currentAbsolute: 4,
      label: "09:00:00",
      isWrapped: (line) => line === 3,
    });
    expect([...stamps.keys()]).toEqual([2, 4]);
  });

  it("清理滚出 scrollback 的旧行", () => {
    const stamps = new Map<number, string>([
      [1, "a"],
      [2, "b"],
      [10, "c"],
    ]);
    pruneTerminalTimestampLines(stamps, 5);
    expect([...stamps.keys()]).toEqual([10]);
  });
});
