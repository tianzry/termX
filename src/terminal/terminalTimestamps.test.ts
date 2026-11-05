import { describe, expect, it, vi } from "vitest";
import {
  collectTerminalTimestampLines,
  formatTerminalTimestamp,
  normalizeTerminalTimestampStamps,
  pruneTerminalTimestampStamps,
  resolveTerminalTimestampGutterWidth,
  resolveVisibleTerminalTimestampRows,
  type TerminalTimestampStamp,
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

describe("collectTerminalTimestampLines", () => {
  it("从上次已知行之后逐行补时间", () => {
    expect(
      collectTerminalTimestampLines({
        previousAbsolute: 4,
        currentAbsolute: 7,
        isWrapped: () => false,
      }),
    ).toEqual([5, 6, 7]);
  });

  it("软换行续行不重复打时间", () => {
    expect(
      collectTerminalTimestampLines({
        previousAbsolute: 1,
        currentAbsolute: 4,
        isWrapped: (line) => line === 3,
      }),
    ).toEqual([2, 4]);
  });

  it("行号未前进时不产生新行", () => {
    expect(
      collectTerminalTimestampLines({
        previousAbsolute: 9,
        currentAbsolute: 9,
        isWrapped: () => false,
      }),
    ).toEqual([]);
  });
});

describe("时间戳行号重映射（reflow：字号 / 窗口缩放 / 分屏 resize）", () => {
  const stamp = (
    line: number,
    markerLine?: number,
    disposed = false,
  ): TerminalTimestampStamp => ({
    line,
    label: `t${line}`,
    marker:
      markerLine === undefined
        ? undefined
        : {
            line: markerLine,
            isDisposed: disposed,
            dispose: vi.fn(),
          },
  });

  it("marker 存活时以 xterm 更新后的 marker.line 为准", () => {
    // 字号变大 → 换行数减少 → 原第 10 行被 reflow 到第 8 行。
    const stamps = [stamp(10, 8), stamp(12, 10)];
    normalizeTerminalTimestampStamps(stamps);
    expect(stamps.map((entry) => entry.line)).toEqual([8, 10]);
  });

  it("scrollback 裁剪销毁 marker 的条目被丢弃", () => {
    const stamps = [stamp(3, 2, true), stamp(9, 8)];
    normalizeTerminalTimestampStamps(stamps);
    expect(stamps.map((entry) => entry.line)).toEqual([8]);
  });

  it("列数变化（reflow）后无 marker 的旧行号不可信，直接丢弃", () => {
    const stamps = [stamp(5), stamp(7, 7)];
    normalizeTerminalTimestampStamps(stamps, { dropUnanchored: true });
    expect(stamps.map((entry) => entry.line)).toEqual([7]);
  });

  it("未发生 reflow 时保留无 marker 的条目", () => {
    const stamps = [stamp(5), stamp(7, 7)];
    normalizeTerminalTimestampStamps(stamps, { dropUnanchored: false });
    expect(stamps.map((entry) => entry.line)).toEqual([5, 7]);
  });

  it("清理滚出 scrollback 的旧行并释放 marker", () => {
    const dispose = vi.fn();
    const stamps: TerminalTimestampStamp[] = [
      { line: 1, label: "a", marker: { line: 1, isDisposed: false, dispose } },
      { line: 2, label: "b" },
      { line: 10, label: "c", marker: { line: 10, isDisposed: false, dispose: vi.fn() } },
    ];
    pruneTerminalTimestampStamps(stamps, 5);
    expect(stamps.map((entry) => entry.line)).toEqual([10]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("resolveVisibleTerminalTimestampRows", () => {
  it("按视口绝对行映射，跳过软换行续行", () => {
    const stamps: TerminalTimestampStamp[] = [
      { line: 10, label: "10:00:00" },
      { line: 12, label: "10:00:01" },
    ];
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

  it("reflow 后按 marker 的实时行号映射到视口", () => {
    // 打点时在第 20 行，字号变化后 marker 指向第 25 行（视口顶部 24）。
    const stamps: TerminalTimestampStamp[] = [
      { line: 20, label: "09:00:00", marker: { line: 25, isDisposed: false } },
    ];
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps,
        viewportY: 24,
        rows: 3,
        isWrapped: () => false,
      }),
    ).toEqual([{ row: 1, label: "09:00:00" }]);
  });

  it("只显示视口内的行", () => {
    const stamps: TerminalTimestampStamp[] = [
      { line: 5, label: "old" },
      { line: 20, label: "new" },
    ];
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
