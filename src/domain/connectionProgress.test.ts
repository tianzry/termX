import { describe, expect, it } from "vitest";
import {
  advanceIndeterminateConnectionProgress,
  advanceMonotonicConnectionProgress,
  CONNECTION_PROGRESS_CAP,
  CONNECTION_PROGRESS_START,
  resolveHopConnectionProgress,
} from "./connectionProgress";

describe("advanceIndeterminateConnectionProgress", () => {
  it("从起始值推进，步长至少为 1", () => {
    const next = advanceIndeterminateConnectionProgress(CONNECTION_PROGRESS_START);
    expect(next).toBeGreaterThan(CONNECTION_PROGRESS_START);
  });

  it("越接近封顶步长越小，最终精确停在封顶值", () => {
    let value = CONNECTION_PROGRESS_START;
    for (let i = 0; i < 200; i++) value = advanceIndeterminateConnectionProgress(value);
    expect(value).toBe(CONNECTION_PROGRESS_CAP);
  });

  it("到达封顶后保持不变", () => {
    expect(advanceIndeterminateConnectionProgress(CONNECTION_PROGRESS_CAP)).toBe(
      CONNECTION_PROGRESS_CAP,
    );
  });
});

describe("resolveHopConnectionProgress", () => {
  it("多跳链路映射到 10%~90% 区间", () => {
    expect(resolveHopConnectionProgress(0, 2)).toBe(10);
    expect(resolveHopConnectionProgress(1, 2)).toBe(50);
    expect(resolveHopConnectionProgress(2, 2)).toBe(90);
  });

  it("total 为 0 与负 hop 都兜底到起点", () => {
    expect(resolveHopConnectionProgress(0, 0)).toBe(10);
    expect(resolveHopConnectionProgress(-3, 2)).toBe(10);
  });
});

describe("advanceMonotonicConnectionProgress", () => {
  it("进度只增不减", () => {
    expect(advanceMonotonicConnectionProgress(60, 40)).toBe(60);
    expect(advanceMonotonicConnectionProgress(40, 60)).toBe(60);
  });
});
