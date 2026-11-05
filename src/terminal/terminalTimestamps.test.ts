import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_TIMESTAMP_MAX_PENDING_ESCAPE,
  TERMINAL_TIMESTAMP_MAX_STAMPS,
  createTerminalTimestampSegmenterState,
  formatTerminalTimestamp,
  getTerminalTimestampState,
  isSimpleAsciiControlText,
  normalizeTerminalTimestampStamps,
  pruneTerminalTimestampStamps,
  resetTerminalTimestampState,
  resolveLastContentLine,
  resolveTerminalTimestampDividerShadow,
  resolveTerminalTimestampGutterWidth,
  resolveTerminalTimestampStampLine,
  resolveVisibleTerminalTimestampRows,
  scanTerminalTimestampOutput,
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

describe("resolveTerminalTimestampDividerShadow（Netcatty gutter 右缘细分隔线）", () => {
  it("0.5px inset shadow，前景色 8% 混色，随主题色变化", () => {
    expect(resolveTerminalTimestampDividerShadow("#dfe3ea")).toBe(
      "inset -0.5px 0 0 color-mix(in srgb, #dfe3ea 8%, transparent)",
    );
    expect(resolveTerminalTimestampDividerShadow("#16202b")).toBe(
      "inset -0.5px 0 0 color-mix(in srgb, #16202b 8%, transparent)",
    );
  });
});

describe("scanTerminalTimestampOutput（写入时打点范围）", () => {
  it("行首出现的提示符 / 命令回显行打点", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(state, "$ ls -la")).toEqual([0]);
  });

  it("多行输出每一行都获得打点机会", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(state, "line1\nline2\nline3")).toEqual([
      0, 1, 2,
    ]);
  });

  it("回车重绘同一物理行不重复打点", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(state, "$ ls")).toEqual([0]);
    // 提示符重绘（\r 回到行首）仍在同一物理行。
    expect(scanTerminalTimestampOutput(state, "\r$ ls2")).toEqual([]);
    // 换行后新行重新获得打点机会。
    expect(scanTerminalTimestampOutput(state, "\r\n$ pwd")).toEqual([1]);
  });

  it("跨 chunk 时维持行首状态（提示符与命令回显分两次到达）", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(state, "\r\n")).toEqual([]);
    expect(scanTerminalTimestampOutput(state, "$ echo hi")).toEqual([0]);
    expect(scanTerminalTimestampOutput(state, "\r\nhi\r\n")).toEqual([1]);
  });

  it("ANSI 颜色序列不吞掉行首打点", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(state, "\x1b[32m$ \x1b[0mls")).toEqual([0]);
  });

  it("OSC / DCS 控制串内容不产生伪打点", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(state, "\x1b]0;title\x07$ ")).toEqual([0]);
    const dcs = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(dcs, "\x1bPq#0;2;0;0;0#\x1b\\$ ")).toEqual([0]);
  });

  it("不完整的 CSI 跨 chunk 缓存，不误打点", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(scanTerminalTimestampOutput(state, "\x1b[3")).toEqual([]);
    expect(scanTerminalTimestampOutput(state, "2m$ ")).toEqual([0]);
  });

  it("软换行后行偏移按物理行计算（reflow / 长行输出）", () => {
    const state = createTerminalTimestampSegmenterState();
    // 11 个字符占 2 行（cols=10），随后换行 + 提示符应落在偏移 2。
    expect(
      scanTerminalTimestampOutput(state, "abcdefghijk\n$ ", {
        columns: 10,
        startColumn: 0,
      }),
    ).toEqual([0, 2]);
  });

  it("CJK / emoji 按两列宽度计算换行", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(
      scanTerminalTimestampOutput(state, "中文😀\n$ ", {
        columns: 4,
        startColumn: 0,
      }),
    ).toEqual([0, 2]);
  });

  it("备用屏幕（CSI ?1049h/l）内暂停打点，离开后恢复", () => {
    const state = createTerminalTimestampSegmenterState();
    expect(
      scanTerminalTimestampOutput(state, "\x1b[?1049h\x1b[H\x1b[2Jvim 内容"),
    ).toEqual([]);
    // 仍在备用屏幕：不传 alternate，靠数据流里的 CSI 维护的状态继续暂停。
    expect(scanTerminalTimestampOutput(state, "more")).toEqual([]);
    // 离开备用屏幕后提示符恢复打点。
    expect(scanTerminalTimestampOutput(state, "\x1b[?1049l$ ")).toEqual([0]);
  });

  it("纯 ASCII 洪水输出走快速通道，打点语义不变", () => {
    expect(isSimpleAsciiControlText("line1\nline2\thello\r\n")).toBe(true);
    expect(isSimpleAsciiControlText("中文输出")).toBe(false);
    expect(isSimpleAsciiControlText("\x1b[32mgreen\x1b[0m")).toBe(false);
    const state = createTerminalTimestampSegmenterState();
    expect(
      scanTerminalTimestampOutput(state, "alpha\nbeta\tgamma\n", {
        columns: 10,
        startColumn: 0,
      }),
    ).toEqual([0, 1]);
  });

  it("超长未完成控制串 fail open，不无限缓存前缀", () => {
    const state = createTerminalTimestampSegmenterState();
    // 第一段：超长且未终止的 OSC → 不缓存。
    const huge = `\x1b]0;${"x".repeat(TERMINAL_TIMESTAMP_MAX_PENDING_ESCAPE + 10)}`;
    expect(scanTerminalTimestampOutput(state, huge)).toEqual([]);
    expect(state.pendingEscape).toBe("");
    // 后续正常输出不受影响（仍处于行首，提示符照常打点）。
    expect(scanTerminalTimestampOutput(state, "$ ls")).toEqual([0]);
    expect(scanTerminalTimestampOutput(state, "\r\n$ pwd")).toEqual([1]);
  });

  it("零宽组合符不计列，软换行行号不漂移", () => {
    const state = createTerminalTimestampSegmenterState();
    // cols=4：abcd 占满第 0 行，组合符宽度 0；e 换行到第 1 行，fgh 占满，
    // 随后 \n + 提示符应落在偏移 2（若组合符误算 1 列会变成 3）。
    expect(
      scanTerminalTimestampOutput(state, "abcd\u0301efgh\n$ ", {
        columns: 4,
        startColumn: 0,
      }),
    ).toEqual([0, 2]);
  });
});

describe("per-pane 状态隔离（WeakMap keyed by xterm 实例）", () => {
  const paneA = {};
  const paneB = {};

  it("两个终端各自一份 marker 集合 / 上次打点 / 分段器", () => {
    const a = getTerminalTimestampState(paneA);
    const b = getTerminalTimestampState(paneB);
    expect(a).not.toBe(b);
    expect(a.segmenter).not.toBe(b.segmenter);
    a.stamps.push({ line: 5, label: "10:00:00" });
    a.lastSecondKey = "10:00:00";
    expect(b.stamps).toEqual([]);
    expect(b.lastSecondKey).toBe("");
    expect(getTerminalTimestampState(paneA)).toBe(a);
  });

  it("重置一侧不影响另一侧", () => {
    const b = getTerminalTimestampState(paneB);
    b.stamps.push({ line: 7, label: "10:00:01" });
    b.lastSecondKey = "10:00:01";
    resetTerminalTimestampState(paneA);
    expect(b.stamps.map((stamp) => stamp.label)).toEqual(["10:00:01"]);
    expect(b.lastSecondKey).toBe("10:00:01");
    expect(getTerminalTimestampState(paneB)).toBe(b);
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
    expect(resolveTerminalTimestampStampLine(stamps[0])).toBe(8);
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
});

describe("pruneTerminalTimestampStamps", () => {
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

  it("超过容量上界时从最旧一端丢弃", () => {
    const dispose = vi.fn();
    const stamps: TerminalTimestampStamp[] = [
      { line: 1, label: "a", marker: { line: 1, isDisposed: false, dispose } },
      { line: 2, label: "b" },
      { line: 3, label: "c" },
    ];
    pruneTerminalTimestampStamps(stamps, 0, 2);
    expect(stamps.map((entry) => entry.label)).toEqual(["b", "c"]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(TERMINAL_TIMESTAMP_MAX_STAMPS).toBe(4096);
  });
});

describe("resolveLastContentLine（Netcatty resolveLastPaintBufferLine）", () => {
  it("光标在空行时回退一行", () => {
    expect(
      resolveLastContentLine({
        cursorAbsolute: 9,
        cursorX: 0,
        isBlank: (line) => line === 9,
        bufferLength: 20,
      }),
    ).toBe(8);
  });

  it("光标有内容时以光标行为准", () => {
    expect(
      resolveLastContentLine({
        cursorAbsolute: 9,
        cursorX: 4,
        isBlank: () => false,
        bufferLength: 20,
      }),
    ).toBe(9);
  });

  it("保留最后一条打点行，避免光标上移后下方时间戳消失", () => {
    expect(
      resolveLastContentLine({
        cursorAbsolute: 6,
        cursorX: 0,
        isBlank: (line) => line === 6,
        lastStampLine: 9,
        bufferLength: 20,
      }),
    ).toBe(9);
  });

  it("按 buffer 长度截断", () => {
    expect(
      resolveLastContentLine({
        cursorAbsolute: 9,
        cursorX: 2,
        isBlank: () => false,
        lastStampLine: 12,
        bufferLength: 10,
      }),
    ).toBe(9);
  });
});

describe("resolveVisibleTerminalTimestampRows（填充式绘制）", () => {
  it("同一秒内的行沿用上一打点（提示符 / 命令回显不漏行）", () => {
    const stamps: TerminalTimestampStamp[] = [
      { line: 10, label: "10:00:00" },
      { line: 12, label: "10:00:01" },
    ];
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps,
        viewportY: 9,
        rows: 5,
        isWrapped: () => false,
        lastContentLine: 13,
      }),
    ).toEqual([
      { row: 1, label: "10:00:00" },
      { row: 2, label: "10:00:00" },
      { row: 3, label: "10:00:01" },
      { row: 4, label: "10:00:01" },
    ]);
  });

  it("lastContentLine 之后的空白区不画", () => {
    const stamps: TerminalTimestampStamp[] = [{ line: 10, label: "10:00:00" }];
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps,
        viewportY: 10,
        rows: 6,
        isWrapped: () => false,
        lastContentLine: 11,
      }),
    ).toEqual([
      { row: 0, label: "10:00:00" },
      { row: 1, label: "10:00:00" },
    ]);
  });

  it("软换行续行按源行取同一时间戳（reflow 后每行都有）", () => {
    const stamps: TerminalTimestampStamp[] = [
      { line: 10, label: "10:00:00" },
      { line: 13, label: "10:00:01" },
    ];
    const wrapped = new Set([11, 12]);
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps,
        viewportY: 10,
        rows: 4,
        isWrapped: (line) => wrapped.has(line),
        lastContentLine: 13,
      }),
    ).toEqual([
      { row: 0, label: "10:00:00" },
      { row: 1, label: "10:00:00" },
      { row: 2, label: "10:00:00" },
      { row: 3, label: "10:00:01" },
    ]);
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
    ).toEqual([
      { row: 1, label: "09:00:00" },
      { row: 2, label: "09:00:00" },
    ]);
  });

  it("视口之前的打点填充到视口行，视口内新打点覆盖后续行", () => {
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
    ).toEqual([
      { row: 0, label: "old" },
      { row: 1, label: "old" },
      { row: 2, label: "new" },
    ]);
  });

  it("视口为空或无打点时返回空", () => {
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps: [],
        viewportY: 0,
        rows: 5,
        isWrapped: () => false,
      }),
    ).toEqual([]);
    expect(
      resolveVisibleTerminalTimestampRows({
        stamps: [{ line: 0, label: "x" }],
        viewportY: 0,
        rows: 0,
        isWrapped: () => false,
      }),
    ).toEqual([]);
  });
});
