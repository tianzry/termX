import { describe, expect, it } from "vitest";
import type { Profile } from "../backend/client";
import {
  buildPickerSections,
  connectBranch,
  flattenPickerItems,
  joinLocalPath,
  joinRemotePath,
  localParent,
  osFromUname,
  osIconName,
  pickerItemToTarget,
  remoteParent,
  type ConnectedHostEntry,
  type PickerSection,
} from "./sftpModel";

function profile(partial: Partial<Profile> & { id: string }): Profile {
  return {
    name: partial.id,
    host: "127.0.0.1",
    port: 22,
    credential_id: "cred-1",
    bastion_profile_id: null,
    init_command: null,
    group_id: null,
    ...partial,
  };
}

describe("远端路径拼接 / 父目录", () => {
  it("根目录拼接不产生双斜杠", () => {
    expect(joinRemotePath("/", "etc")).toBe("/etc");
  });

  it("普通目录拼接并去掉末尾多余斜杠", () => {
    expect(joinRemotePath("/home/tianzry", "docs")).toBe("/home/tianzry/docs");
    expect(joinRemotePath("/home/tianzry/", "docs")).toBe("/home/tianzry/docs");
    expect(joinRemotePath("/home///", "docs")).toBe("/home/docs");
  });

  it("父目录：根保持自身，多级逐级回退", () => {
    expect(remoteParent("/")).toBe("/");
    expect(remoteParent("/home")).toBe("/");
    expect(remoteParent("/home/tianzry")).toBe("/home");
    expect(remoteParent("/home/tianzry/")).toBe("/home");
  });
});

describe("本地路径拼接 / 父目录（Windows）", () => {
  it("盘符根与普通目录拼接", () => {
    expect(joinLocalPath("C:\\", "Users")).toBe("C:\\Users");
    expect(joinLocalPath("C:\\Users", "tianzry")).toBe("C:\\Users\\tianzry");
    expect(joinLocalPath("C:\\Users\\", "tianzry")).toBe("C:\\Users\\tianzry");
  });

  it("父目录：盘符根返回自身（带斜杠）", () => {
    expect(localParent("C:\\Users\\tianzry")).toBe("C:\\Users");
    expect(localParent("C:\\Users")).toBe("C:\\");
    expect(localParent("C:\\")).toBe("C:\\");
  });
});

describe("主机选择器分区", () => {
  const connected: ConnectedHostEntry[] = [
    { sessionId: "s-1", label: "129", meta: "tianzry@192.168.126.129", profileId: "p-129" },
  ];
  const profiles: Profile[] = [
    profile({ id: "p-129", name: "129", host: "192.168.126.129" }),
    profile({ id: "p-b", name: "beta", host: "10.0.0.2" }),
    profile({ id: "p-local", name: "本机", protocol: "local" }),
  ];

  function sectionKeys(sections: PickerSection[]): string[] {
    return sections.map((s) => s.key);
  }

  it("无搜索词：本地恒显 + 已连接 + 主机（排除 local 协议与已连接同 profile）", () => {
    const sections = buildPickerSections({ term: "", connected, profiles });
    expect(sectionKeys(sections)).toEqual(["local", "connected", "hosts"]);
    const hosts = sections[2];
    expect(hosts.items.map((i) => i.id)).toEqual(["p-b"]);
    expect(hosts.emptyHint).toBeUndefined();
  });

  it("本地行不受搜索词影响", () => {
    const sections = buildPickerSections({
      term: "zzz",
      connected,
      profiles,
    });
    expect(sections[0].key).toBe("local");
    expect(sections[0].items).toHaveLength(1);
  });

  it("搜索命中已连接时不再显示主机空分区", () => {
    const sections = buildPickerSections({ term: "129", connected, profiles });
    expect(sectionKeys(sections)).toEqual(["local", "connected"]);
  });

  it("全部无匹配：主机分区显示「没有匹配的主机」", () => {
    const sections = buildPickerSections({
      term: "zzz",
      connected: [],
      profiles,
    });
    const hosts = sections.find((s) => s.key === "hosts");
    expect(hosts?.items).toHaveLength(0);
    expect(hosts?.emptyHint).toBe("没有匹配的主机");
  });

  it("搜索按名称与 host 匹配（大小写不敏感）", () => {
    const byName = buildPickerSections({ term: "BETA", connected: [], profiles });
    expect(byName[1].items.map((i) => i.id)).toEqual(["p-b"]);
    const byHost = buildPickerSections({
      term: "10.0.0.2",
      connected: [],
      profiles,
    });
    expect(byHost[1].items.map((i) => i.id)).toEqual(["p-b"]);
  });

  it("主机分区按名称排序", () => {
    const sections = buildPickerSections({
      term: "",
      connected: [],
      profiles: [
        profile({ id: "z", name: "zeta" }),
        profile({ id: "a", name: "alpha" }),
      ],
    });
    const hosts = sections.find((s) => s.key === "hosts");
    expect(hosts?.items.map((i) => i.id)).toEqual(["a", "z"]);
  });

  it("flattenPickerItems 只取条目不取标题，供键盘导航", () => {
    const sections = buildPickerSections({ term: "", connected, profiles });
    const items = flattenPickerItems(sections);
    // local(1) + connected(1) + hosts(1)
    expect(items).toHaveLength(3);
    expect(items[0].type).toBe("local");
  });
});

describe("连接流分支", () => {
  it("本地 / 复用会话 / 独立连接三分支", () => {
    expect(connectBranch({ kind: "local" })).toBe("local");
    expect(
      connectBranch({
        kind: "session",
        entry: { sessionId: "s", label: "x", meta: "" },
      }),
    ).toBe("reuse-session");
    expect(
      connectBranch({ kind: "profile", profile: profile({ id: "p" }) }),
    ).toBe("standalone");
  });

  it("选择器条目 → 连接目标映射", () => {
    expect(pickerItemToTarget({ type: "local", id: "local" }).kind).toBe(
      "local",
    );
    const entry: ConnectedHostEntry = { sessionId: "s", label: "x", meta: "" };
    const sessionTarget = pickerItemToTarget({
      type: "connected",
      id: "connected:s",
      entry,
    });
    expect(sessionTarget.kind).toBe("session");
    const hostTarget = pickerItemToTarget({
      type: "host",
      id: "p",
      profile: profile({ id: "p" }),
    });
    expect(hostTarget.kind).toBe("profile");
  });
});

describe("主机 OS 判定（图标用）", () => {
  it("osFromUname 识别 Linux / Darwin / Windows，BSD 近似 linux", () => {
    expect(osFromUname("Linux")).toBe("linux");
    expect(osFromUname("Darwin")).toBe("macos");
    expect(osFromUname("Windows_NT")).toBe("windows");
    expect(osFromUname("FreeBSD")).toBe("linux");
    expect(osFromUname("  ")).toBe("unknown");
  });

  it("osIconName 映射 os-* 图标名，unknown 返回 null", () => {
    expect(osIconName("windows")).toBe("os-windows");
    expect(osIconName("macos")).toBe("os-macos");
    expect(osIconName("linux")).toBe("os-linux");
    expect(osIconName("unknown")).toBeNull();
  });
});
