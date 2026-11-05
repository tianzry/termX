import { describe, expect, it } from "vitest";

import {
  resolveConnectionDotClass,
  resolveTabConnectionStatus,
} from "./connectionStatus";

describe("connectionStatus", () => {
  it("状态 → 标签圆点样式类：仅 connected/connecting 单独区分，其余归为断开（rose）", () => {
    expect(resolveConnectionDotClass("connected")).toBe("connected");
    expect(resolveConnectionDotClass("connecting")).toBe("connecting");
    expect(resolveConnectionDotClass("disconnected")).toBe("disconnected");
    // 尚未上报状态时与 Netcatty 一致落到 rose。
    expect(resolveConnectionDotClass(undefined)).toBe("disconnected");
  });

  it("标签状态优先活动窗格，活动窗格不属于该标签时回落到首个窗格", () => {
    const paneStatuses = {
      p1: "connected" as const,
      p2: "connecting" as const,
      p3: "disconnected" as const,
    };
    expect(
      resolveTabConnectionStatus({
        paneStatuses,
        paneIds: ["p1", "p2"],
        activePaneId: "p2",
      }),
    ).toBe("connecting");
    // 活动窗格属于别的标签 → 用本标签首个窗格。
    expect(
      resolveTabConnectionStatus({
        paneStatuses,
        paneIds: ["p1", "p2"],
        activePaneId: "p3",
      }),
    ).toBe("connected");
    expect(
      resolveTabConnectionStatus({
        paneStatuses,
        paneIds: ["p1", "p2"],
        activePaneId: null,
      }),
    ).toBe("connected");
  });

  it("无窗格或无状态时返回 connecting", () => {
    expect(
      resolveTabConnectionStatus({
        paneStatuses: {},
        paneIds: [],
        activePaneId: null,
      }),
    ).toBe("connecting");
    expect(
      resolveTabConnectionStatus({
        paneStatuses: {},
        paneIds: ["p1"],
        activePaneId: "p1",
      }),
    ).toBe("connecting");
  });
});
