import { describe, expect, it } from "vitest";
import {
  activeFor,
  formatBytes,
  forwardSummary,
  groupForwardsByHost,
  ruleLabel,
} from "./forwardOverview";
import type { ActiveForwardInfo, Forward } from "../backend/client";

const forward = (id: string, profile_id: string, name: string): Forward => ({
  id,
  name,
  profile_id,
  group_id: null,
  rules: [],
});

describe("forwardOverview", () => {
  it("按主机分组、排序并统计运行中条目", () => {
    const profiles = [
      { id: "p1", name: "甲主机", host: "10.0.0.1", port: 22 },
      { id: "p2", name: "乙主机", host: "10.0.0.2", port: 22 },
    ];
    const groups = groupForwardsByHost(
      [
        forward("f2", "p2", "B 条目"),
        forward("f1", "p1", "A 条目"),
        forward("f3", "gone", "孤儿条目"),
      ],
      profiles,
      [{ forward_id: "f2" }],
    );
    // zh-CN 排序按拼音：甲(jiǎ) → 未(wèi) → 乙(yǐ)。
    expect(groups.map((g) => g.profileName)).toEqual(["甲主机", "未知主机", "乙主机"]);
    expect(groups[2].activeCount).toBe(1);
    expect(groups[1].host).toBe("");
    expect(groups[1].forwards[0].name).toBe("孤儿条目");
  });

  it("组内按名称排序", () => {
    const groups = groupForwardsByHost(
      [forward("b", "p", "乙"), forward("a", "p", "甲")],
      [{ id: "p", name: "P", host: "h", port: 22 }],
      [],
    );
    expect(groups[0].forwards.map((f) => f.name)).toEqual(["乙", "甲"].sort((x, y) =>
      x.localeCompare(y, "zh-CN"),
    ));
  });

  it("规则文案与字节格式化", () => {
    expect(ruleLabel({ type: "local", local_port: 8080, remote_host: "db", remote_port: 5432 })).toBe(
      "本地 · 127.0.0.1:8080 → db:5432",
    );
    expect(ruleLabel({ type: "remote", local_port: 80, remote_host: "web", remote_port: 8080 })).toBe(
      "远程 · 远端 web:8080 → 本地 :80",
    );
    expect(ruleLabel({ type: "dynamic", local_port: 1080, remote_host: "", remote_port: 0 })).toBe(
      "SOCKS5 · 127.0.0.1:1080",
    );
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("条目摘要与查找", () => {
    const info = {
      active_id: "a1",
      forward_id: "f1",
      stats: { bytes_tx: 1024, bytes_rx: 2048, connections: 2, connected: true, rules: [] },
    } as ActiveForwardInfo;
    expect(forwardSummary(undefined)).toBe("");
    expect(forwardSummary(info)).toBe("2 连接 · ↑1 KB ↓2 KB");
    expect(activeFor([info], "f1")?.active_id).toBe("a1");
    expect(activeFor([info], "f2")).toBeUndefined();
  });
});
