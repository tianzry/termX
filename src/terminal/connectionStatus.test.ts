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
    // 未上报 ≠ 已断开，与 resolveTabConnectionStatus 的默认值保持一致。
    expect(resolveConnectionDotClass(undefined)).toBe("connecting");
  });

  it("单窗格标签直接反映该窗格状态", () => {
    for (const status of ["connected", "connecting", "disconnected"] as const) {
      expect(
        resolveTabConnectionStatus({
          paneStatuses: { p1: status },
          paneIds: ["p1"],
        }),
      ).toBe(status);
    }
  });

  it("分屏标签按窗格聚合：任一断开即断开，不被活动窗格掩盖", () => {
    const paneStatuses = {
      p1: "connected" as const,
      p2: "disconnected" as const,
    };
    expect(
      resolveTabConnectionStatus({ paneStatuses, paneIds: ["p1", "p2"] }),
    ).toBe("disconnected");
    // 窗格顺序不影响结果。
    expect(
      resolveTabConnectionStatus({ paneStatuses, paneIds: ["p2", "p1"] }),
    ).toBe("disconnected");
  });

  it("两窗格都连上才是 connected；任一在连接中则是 connecting", () => {
    expect(
      resolveTabConnectionStatus({
        paneStatuses: { p1: "connected", p2: "connected" },
        paneIds: ["p1", "p2"],
      }),
    ).toBe("connected");
    expect(
      resolveTabConnectionStatus({
        paneStatuses: { p1: "connected", p2: "connecting" },
        paneIds: ["p1", "p2"],
      }),
    ).toBe("connecting");
  });

  it("无窗格或未上报时返回 connecting", () => {
    expect(
      resolveTabConnectionStatus({ paneStatuses: {}, paneIds: [] }),
    ).toBe("connecting");
    expect(
      resolveTabConnectionStatus({ paneStatuses: {}, paneIds: ["p1"] }),
    ).toBe("connecting");
    // 只有一个窗格上报、另一个缺失 → 未知视为连接中，不误报断开。
    expect(
      resolveTabConnectionStatus({
        paneStatuses: { p1: "connected" },
        paneIds: ["p1", "p2"],
      }),
    ).toBe("connecting");
  });
});
