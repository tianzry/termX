/**
 * 应用锁纯逻辑单测（#23）：失焦/切回判定。不依赖真实 Tauri 运行时。
 */

import { describe, expect, it } from "vitest";
import { shouldLockAfterReturn } from "./appLockState";

describe("shouldLockAfterReturn", () => {
  it("未启用时不锁", () => {
    expect(shouldLockAfterReturn(1000, 9_999_999, 0, false)).toBe(false);
  });

  it("没有离开记录时不锁", () => {
    expect(shouldLockAfterReturn(null, 9_999_999, 0, true)).toBe(false);
  });

  it("超时 0 表示每次切回都验证", () => {
    expect(shouldLockAfterReturn(1000, 1001, 0, true)).toBe(true);
  });

  it("未达到超时阈值时不锁", () => {
    // 15 分钟 = 900_000ms；离开 60s 就回来
    expect(shouldLockAfterReturn(1000, 1000 + 60_000, 15, true)).toBe(false);
  });

  it("达到/超过超时阈值时锁", () => {
    expect(shouldLockAfterReturn(1000, 1000 + 900_000, 15, true)).toBe(true);
    expect(shouldLockAfterReturn(1000, 1000 + 3_600_000, 15, true)).toBe(true);
  });

  it("1 分钟档位按分钟换算", () => {
    expect(shouldLockAfterReturn(0, 59_999, 1, true)).toBe(false);
    expect(shouldLockAfterReturn(0, 60_000, 1, true)).toBe(true);
  });
});
