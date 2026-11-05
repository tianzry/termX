import { describe, expect, it } from "vitest";
import type { MonitorPanel, Profile } from "../backend/client";
import {
  ALL_PANELS_ID,
  defaultMonitorPanel,
  nextSortOrder,
  normalizePanelDraft,
  panelsWithDefault,
  profilesForPanel,
  sortPanels,
} from "./monitorPanelsModel";

function ssh(id: string): Profile {
  return {
    id,
    name: `host-${id}`,
    host: `10.0.0.${id}`,
    port: 22,
    protocol: "ssh",
  } as Profile;
}

function telnet(id: string): Profile {
  return { ...ssh(id), protocol: "telnet" } as Profile;
}

function panel(id: string, hostIds: string[], patch: Partial<MonitorPanel> = {}): MonitorPanel {
  return {
    id,
    name: id,
    host_ids: hostIds,
    layout: "charts",
    columns: 0,
    interval: 2,
    sort_order: 0,
    ...patch,
  };
}

describe("monitorPanelsModel", () => {
  it("默认面板始终包含全部 SSH 主机且不接受非 SSH", () => {
    const profiles = [ssh("a"), ssh("b"), telnet("t"), ssh("c")];
    const def = defaultMonitorPanel(profiles.filter((p) => p.protocol === "ssh"));
    expect(def.id).toBe(ALL_PANELS_ID);
    expect(def.name).toBe("全部 SSH 主机");
    expect(def.host_ids).toEqual(["a", "b", "c"]);
  });

  it("panelsWithDefault 把默认面板排在最前并保持自定义面板排序", () => {
    const profiles = [ssh("a")];
    const list = panelsWithDefault(
      [panel("p2", []), panel("p1", [], { sort_order: 1 }), panel(ALL_PANELS_ID, ["a"])],
      profiles,
    );
    expect(list.map((p) => p.id)).toEqual([ALL_PANELS_ID, "p2", "p1"]);
  });

  it("profilesForPanel 只返回仍存在的面板主机", () => {
    const profiles = [ssh("a"), ssh("b"), telnet("t")];
    const custom = panel("p", ["a", "missing"]);
    expect(profilesForPanel(profiles, custom).map((p) => p.id)).toEqual(["a"]);
    expect(profilesForPanel(profiles, defaultMonitorPanel(profiles)).map((p) => p.id)).toEqual([
      "a",
      "b",
      "t",
    ]);
  });

  it("nextSortOrder / sortPanels 依据 sort_order 与名称", () => {
    expect(nextSortOrder([])).toBe(1);
    expect(nextSortOrder([panel("a", [], { sort_order: 3 }), panel("b", [], { sort_order: 1 })])).toBe(4);
    expect(
      sortPanels([
        panel("b", [], { sort_order: 1, name: "B" }),
        panel("a", [], { sort_order: 1, name: "A" }),
      ]).map((p) => p.id),
    ).toEqual(["a", "b"]);
  });

  it("normalizePanelDraft 去空白、去重、过滤非 SSH 并收敛数值", () => {
    const normalized = normalizePanelDraft(
      {
        id: "p",
        name: "  生产  ",
        host_ids: ["a", " a ", "", "t", "b"],
        layout: "weird" as MonitorPanel["layout"],
        columns: 99,
        interval: 7,
        sort_order: -3,
      },
      new Set(["a", "b"]),
    );
    expect(normalized.name).toBe("生产");
    expect(normalized.host_ids).toEqual(["a", "b"]);
    expect(normalized.layout).toBe("charts");
    expect(normalized.columns).toBe(4);
    expect(normalized.interval).toBe(2);
    expect(normalized.sort_order).toBe(0);
  });
});
