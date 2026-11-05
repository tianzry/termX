import { describe, expect, it } from "vitest";
import {
  rootHostsForDisplay,
  shouldHideRootHostsSection,
} from "./rootHostsModel";

type Host = { id: string; group_id?: string | null };

const hosts: Host[] = [{ id: "git-bash" }, { id: "129" }, { id: "cmd" }];

describe("rootHostsModel", () => {
  it("有剩余主机时只展示剩余（保持与最近连接去重）", () => {
    expect(rootHostsForDisplay(hosts, [hosts[0]])).toEqual([hosts[0]]);
  });

  it("剩余为空时回退展示全部主机（回归：连接并关闭标签后卡片不应整节消失）", () => {
    expect(rootHostsForDisplay(hosts, [])).toEqual(hosts);
  });

  it("回退时仍遵守「根目录仅显示未分组主机」设置", () => {
    const mixed: Host[] = [
      { id: "a" },
      { id: "b", group_id: "prod" },
      { id: "c", group_id: "dev" },
    ];
    expect(rootHostsForDisplay(mixed, [], true)).toEqual([{ id: "a" }]);
    expect(rootHostsForDisplay(mixed, [], false)).toEqual(mixed);
  });

  it("确实没有主机时返回空数组", () => {
    expect(rootHostsForDisplay([], [])).toEqual([]);
  });

  it("有主机时即使剩余为空也不隐藏「主机」节", () => {
    expect(
      shouldHideRootHostsSection({
        atRoot: true,
        view: "grid",
        keyword: "",
        hostCount: hosts.length,
      }),
    ).toBe(false);
  });

  it("没有主机时隐藏「主机」节", () => {
    expect(
      shouldHideRootHostsSection({
        atRoot: true,
        view: "grid",
        keyword: "",
        hostCount: 0,
      }),
    ).toBe(true);
  });

  it("搜索 / 树视图 / 非根层级不套用隐藏规则", () => {
    expect(
      shouldHideRootHostsSection({
        atRoot: true,
        view: "grid",
        keyword: "129",
        hostCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldHideRootHostsSection({
        atRoot: true,
        view: "tree",
        keyword: "",
        hostCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldHideRootHostsSection({
        atRoot: false,
        view: "grid",
        keyword: "",
        hostCount: 0,
      }),
    ).toBe(false);
  });
});
