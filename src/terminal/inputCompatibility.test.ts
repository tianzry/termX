import { describe, expect, it } from "vitest";

import {
  COMPATIBLE_WRITE_CODE_POINT_LIMIT,
  resolveInputCompatibility,
  splitCompatibleWrites,
} from "./inputCompatibility";

describe("resolveInputCompatibility", () => {
  it("null / undefined 视为老数据，SSH 主机默认开启", () => {
    expect(resolveInputCompatibility(null)).toBe(true);
    expect(resolveInputCompatibility(undefined)).toBe(true);
  });

  it("显式布尔值保持原样", () => {
    expect(resolveInputCompatibility(true)).toBe(true);
    expect(resolveInputCompatibility(false)).toBe(false);
  });
});

describe("splitCompatibleWrites", () => {
  it("空串不产生写入", () => {
    expect(splitCompatibleWrites("")).toEqual([]);
  });

  it("单个中文按一个码点一段", () => {
    expect(splitCompatibleWrites("中")).toEqual(["中"]);
  });

  it("多个中文逐字拆分", () => {
    expect(splitCompatibleWrites("中文输入")).toEqual([
      "中",
      "文",
      "输",
      "入",
    ]);
  });

  it("短 ASCII 串逐字符拆分", () => {
    expect(splitCompatibleWrites("abc")).toEqual(["a", "b", "c"]);
  });

  it("超过 32 个码点整段保留原传输行为", () => {
    const long = "x".repeat(COMPATIBLE_WRITE_CODE_POINT_LIMIT + 1);
    expect(splitCompatibleWrites(long)).toEqual([long]);
    // 边界：恰好 32 个码点仍然逐字拆分。
    const edge = "x".repeat(COMPATIBLE_WRITE_CODE_POINT_LIMIT);
    expect(splitCompatibleWrites(edge)).toHaveLength(
      COMPATIBLE_WRITE_CODE_POINT_LIMIT,
    );
  });

  it("bracketed paste 整段返回，不拆开协议边界", () => {
    const paste = "\x1b[200~中文\x1b[201~";
    expect(splitCompatibleWrites(paste)).toEqual([paste]);
  });

  it("CSI 方向键序列成组发送", () => {
    expect(splitCompatibleWrites("\x1b[A")).toEqual(["\x1b[A"]);
    expect(splitCompatibleWrites("中\x1b[A文")).toEqual([
      "中",
      "\x1b[A",
      "文",
    ]);
    // 带参数的 CSI（光标移动）同样是一段。
    expect(splitCompatibleWrites("\x1b[1;5A")).toEqual(["\x1b[1;5A"]);
  });

  it("SS3 序列成组发送", () => {
    expect(splitCompatibleWrites("\x1bOA")).toEqual(["\x1bOA"]);
  });

  it("OSC 序列成组发送（BEL 与 ST 两种终止符）", () => {
    expect(splitCompatibleWrites("\x1b]0;title\x07")).toEqual([
      "\x1b]0;title\x07",
    ]);
    expect(splitCompatibleWrites("\x1b]0;title\x1b\\")).toEqual([
      "\x1b]0;title\x1b\\",
    ]);
    expect(splitCompatibleWrites("a\x1b]0;t\x07b")).toEqual([
      "a",
      "\x1b]0;t\x07",
      "b",
    ]);
  });

  it("其余 ESC 序列按两码点成组", () => {
    expect(splitCompatibleWrites("\x1b7")).toEqual(["\x1b7"]);
  });

  it("emoji / 组合符按 Unicode 码点拆分", () => {
    // 带修饰符的 emoji：👩 + 肤色 + ZWJ + 💻 共 4 个码点。
    expect(splitCompatibleWrites("👩🏽‍💻")).toEqual(["👩", "🏽", "‍", "💻"]);
    // 组合符单独一段（码点顺序保留）。
    expect(splitCompatibleWrites("e\u0301")).toEqual(["e", "\u0301"]);
  });
});
