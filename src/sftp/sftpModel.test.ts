import { describe, expect, it } from "vitest";
import type { Profile } from "../backend/client";
import {
  breadcrumbSegments,
  buildDropTransferTasks,
  buildPickerSections,
  connectBranch,
  dropTargetPath,
  filterHiddenEntries,
  flattenPickerItems,
  formatEntryMtime,
  formatEntrySize,
  isHiddenEntry,
  isPathRoot,
  isWindowsLikePath,
  joinLocalPath,
  joinRemotePath,
  localParent,
  normalizeBreadcrumbBudget,
  octalToMode,
  osFromUname,
  osIconName,
  parseSftpDragPayload,
  pathRoot,
  permsFromMode,
  permsToOctal,
  pickerItemToTarget,
  remoteParent,
  resolveBreadcrumbVisibleParts,
  SFTP_DRAG_MIME,
  sftpDragSideMime,
  sortSftpRows,
  type ConnectedHostEntry,
  type PickerSection,
  type SftpDragPayload,
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

describe("权限位换算（chmod 对话框）", () => {
  it("mode → 矩阵：0o640 为 owner rw、group r、others 无", () => {
    const m = permsFromMode(0o640);
    expect(m.owner).toEqual({ read: true, write: true, execute: false });
    expect(m.group).toEqual({ read: true, write: false, execute: false });
    expect(m.others).toEqual({ read: false, write: false, execute: false });
  });

  it("矩阵 → 八进制字符串与 mode 往返一致", () => {
    expect(permsToOctal(permsFromMode(0o755))).toBe("755");
    expect(permsToOctal(permsFromMode(0o644))).toBe("644");
    expect(permsToOctal(permsFromMode(0o640))).toBe("640");
  });

  it("八进制 → mode：只接受 3-4 位八进制数", () => {
    expect(octalToMode("640")).toBe(0o640);
    expect(octalToMode("0755")).toBe(0o755);
    expect(octalToMode("9")).toBeNull();
    expect(octalToMode("abc")).toBeNull();
    expect(octalToMode("")).toBeNull();
  });
});

describe("面包屑分段 / 根判定", () => {
  it("isWindowsLikePath：盘符与反斜杠 UNC 命中，纯 //host/share 按 POSIX", () => {
    expect(isWindowsLikePath("C:\\Users")).toBe(true);
    expect(isWindowsLikePath("c:/Users")).toBe(true);
    expect(isWindowsLikePath("\\\\srv\\share\\x")).toBe(true);
    expect(isWindowsLikePath("//srv/share")).toBe(false);
    expect(isWindowsLikePath("/home/x")).toBe(false);
  });

  it("POSIX 分段：前缀 /，逐段累积路径", () => {
    const { segments, isWindowsDrive } = breadcrumbSegments("/home/tianzry/docs");
    expect(isWindowsDrive).toBe(false);
    expect(segments.map((s) => s.label)).toEqual(["home", "tianzry", "docs"]);
    expect(segments.map((s) => s.path)).toEqual([
      "/home",
      "/home/tianzry",
      "/home/tianzry/docs",
    ]);
  });

  it("POSIX 根路径无分段；//host/share 保留 // 前缀", () => {
    expect(breadcrumbSegments("/").segments).toEqual([]);
    const { segments } = breadcrumbSegments("//host/share/a");
    expect(segments[0]).toEqual({ label: "host", path: "//host" });
    expect(segments[1].path).toBe("//host/share");
  });

  it("Windows 盘符分段：首段显示 C: 但路径为 C:\\", () => {
    const { segments, isWindowsDrive } = breadcrumbSegments("C:\\Users\\tianzry");
    expect(isWindowsDrive).toBe(true);
    expect(segments[0]).toEqual({ label: "C:", path: "C:\\" });
    expect(segments[1]).toEqual({ label: "Users", path: "C:\\Users" });
    expect(segments[2].path).toBe("C:\\Users\\tianzry");
  });

  it("UNC 分段：\\\\server\\share 合并为单一首段", () => {
    const { segments, isWindowsDrive } = breadcrumbSegments("\\\\wsl.localhost\\Ubuntu\\home");
    expect(isWindowsDrive).toBe(false);
    expect(segments[0]).toEqual({
      label: "\\\\wsl.localhost\\Ubuntu",
      path: "\\\\wsl.localhost\\Ubuntu",
    });
    expect(segments[1].path).toBe("\\\\wsl.localhost\\Ubuntu\\home");
  });

  it("pathRoot：POSIX → /；盘符 → C:\\；UNC → 共享根", () => {
    expect(pathRoot("/home/x")).toBe("/");
    expect(pathRoot("C:\\Users")).toBe("C:\\");
    expect(pathRoot("\\\\srv\\share\\dir")).toBe("\\\\srv\\share");
  });

  it("isPathRoot：根目录命中，非根不命中", () => {
    expect(isPathRoot("/")).toBe(true);
    expect(isPathRoot("/home")).toBe(false);
    expect(isPathRoot("C:\\")).toBe(true);
    expect(isPathRoot("C:")).toBe(true);
    expect(isPathRoot("C:\\Users")).toBe(false);
    expect(isPathRoot("\\\\srv\\share")).toBe(true);
    expect(isPathRoot("\\\\srv\\share\\x")).toBe(false);
  });
});

describe("面包屑截断", () => {
  const segs = (labels: string[]) =>
    labels.map((label, i) => ({ label, path: `/${labels.slice(0, i + 1).join("/")}` }));

  it("预算钳制为正整数", () => {
    expect(normalizeBreadcrumbBudget(4)).toBe(4);
    expect(normalizeBreadcrumbBudget(0)).toBe(1);
    expect(normalizeBreadcrumbBudget(2.9)).toBe(2);
    expect(normalizeBreadcrumbBudget(Number.NaN)).toBe(1);
  });

  it("不超长原样返回", () => {
    const r = resolveBreadcrumbVisibleParts({ segments: segs(["a", "b"]), maxVisibleParts: 4 });
    expect(r.needsTruncation).toBe(false);
    expect(r.visibleParts).toHaveLength(2);
    expect(r.hiddenParts).toHaveLength(0);
  });

  it("budget=1 只显示首段", () => {
    const r = resolveBreadcrumbVisibleParts({ segments: segs(["a", "b", "c"]), maxVisibleParts: 1 });
    expect(r.visibleParts.map((p) => p.segment.label)).toEqual(["a"]);
    expect(r.hiddenParts.map((p) => p.segment.label)).toEqual(["b", "c"]);
    expect(r.needsTruncation).toBe(true);
  });

  it("budget=4：首段 + 尾部 3 段，中间折叠且保留原始下标", () => {
    const r = resolveBreadcrumbVisibleParts({
      segments: segs(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]),
      maxVisibleParts: 4,
    });
    expect(r.visibleParts.map((p) => p.segment.label)).toEqual(["s1", "s5", "s6", "s7"]);
    expect(r.visibleParts.map((p) => p.originalIndex)).toEqual([0, 4, 5, 6]);
    expect(r.hiddenParts.map((p) => p.segment.label)).toEqual(["s2", "s3", "s4"]);
    expect(r.hiddenParts.map((p) => p.originalIndex)).toEqual([1, 2, 3]);
  });
});

describe("排序 / 隐藏过滤", () => {
  const rows = [
    { name: "zeta.txt", isDir: false, size: 10, mtime: 300 },
    { name: "alpha", isDir: true, size: 0, mtime: 100 },
    { name: "beta.txt", isDir: false, size: 2048, mtime: 200 },
    { name: "gamma", isDir: true, size: 0, mtime: 400 },
  ];

  it("名称升序：目录恒置顶", () => {
    const sorted = sortSftpRows(rows, "name", "asc");
    expect(sorted.map((r) => r.name)).toEqual(["alpha", "gamma", "beta.txt", "zeta.txt"]);
  });

  it("名称降序：只反转组内顺序，目录仍置顶", () => {
    const sorted = sortSftpRows(rows, "name", "desc");
    expect(sorted.map((r) => r.name)).toEqual(["gamma", "alpha", "zeta.txt", "beta.txt"]);
  });

  it("大小 / 时间排序（缺省按 0 计；目录仍恒置顶）", () => {
    expect(sortSftpRows(rows, "size", "desc").map((r) => r.name)).toEqual([
      "alpha", "gamma", "beta.txt", "zeta.txt",
    ]);
    expect(sortSftpRows(rows, "modified", "asc").map((r) => r.name)).toEqual([
      "alpha", "gamma", "beta.txt", "zeta.txt",
    ]);
    expect(sortSftpRows(rows, "modified", "desc").map((r) => r.name)).toEqual([
      "gamma", "alpha", "zeta.txt", "beta.txt",
    ]);
  });

  it("不修改原数组", () => {
    const before = rows.map((r) => r.name);
    sortSftpRows(rows, "name", "desc");
    expect(rows.map((r) => r.name)).toEqual(before);
  });

  it("隐藏判定：.. 永不隐藏；点前缀与 hidden 属性均命中", () => {
    expect(isHiddenEntry({ name: ".." })).toBe(false);
    expect(isHiddenEntry({ name: ".bashrc" })).toBe(true);
    expect(isHiddenEntry({ name: "desktop.ini", hidden: true })).toBe(true);
    expect(isHiddenEntry({ name: "a.txt", hidden: false })).toBe(false);
  });

  it("过滤：关闭时隐藏条目被移除，开启时原样返回", () => {
    const entries = [
      { name: ".." },
      { name: ".ssh" },
      { name: "a.txt" },
      { name: "hidden.sys", hidden: true },
    ];
    expect(filterHiddenEntries(entries, false).map((e) => e.name)).toEqual(["..", "a.txt"]);
    expect(filterHiddenEntries(entries, true)).toBe(entries);
  });
});

describe("大小 / 时间格式化", () => {
  it("0 与缺省 → --；Bytes 无小数，其余两位", () => {
    expect(formatEntrySize(0)).toBe("--");
    expect(formatEntrySize(undefined)).toBe("--");
    expect(formatEntrySize(512)).toBe("512 Bytes");
    expect(formatEntrySize(1024)).toBe("1.00 KB");
    expect(formatEntrySize(1536)).toBe("1.50 KB");
    expect(formatEntrySize(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("mtime → YYYY-MM-DD HH:mm；0 / 缺省 → --", () => {
    expect(formatEntryMtime(0)).toBe("--");
    expect(formatEntryMtime(undefined)).toBe("--");
    const ts = new Date(2026, 0, 5, 8, 7).getTime() / 1000;
    expect(formatEntryMtime(ts)).toBe("2026-01-05 08:07");
  });
});

describe("跨栏拖放：载荷解析 / 落点目录 / 任务构建", () => {
  const remotePayload: SftpDragPayload = {
    side: "remote",
    sftpId: "sftp-1",
    fromPath: "/home/tianzry",
    names: ["a.txt"],
  };

  it("载荷 MIME 与侧标记 MIME", () => {
    expect(SFTP_DRAG_MIME).toBe("application/x-termx-sftp");
    expect(sftpDragSideMime("local")).toBe("application/x-termx-sftp-side-local");
    expect(sftpDragSideMime("remote")).toBe("application/x-termx-sftp-side-remote");
  });

  it("解析合法 local / remote 载荷", () => {
    expect(
      parseSftpDragPayload(
        JSON.stringify({ side: "local", fromPath: "C:\\tmp", names: ["a.txt", "b.log"] }),
      ),
    ).toEqual({ side: "local", fromPath: "C:\\tmp", names: ["a.txt", "b.log"] });
    expect(parseSftpDragPayload(JSON.stringify(remotePayload))).toEqual(remotePayload);
  });

  it("拒绝非法载荷：坏 JSON / 未知 side / 空 names / 穿越名 / 远端缺 sftpId / 空 fromPath", () => {
    expect(parseSftpDragPayload("{oops")).toBeNull();
    expect(parseSftpDragPayload(JSON.stringify({ side: "both", fromPath: "/", names: ["a"] }))).toBeNull();
    expect(parseSftpDragPayload(JSON.stringify({ side: "local", fromPath: "/", names: [] }))).toBeNull();
    expect(parseSftpDragPayload(JSON.stringify({ side: "local", fromPath: "/", names: [".."] }))).toBeNull();
    expect(parseSftpDragPayload(JSON.stringify({ side: "local", fromPath: "/", names: ["a/b"] }))).toBeNull();
    expect(parseSftpDragPayload(JSON.stringify({ side: "local", fromPath: "/", names: ["a\\b"] }))).toBeNull();
    expect(parseSftpDragPayload(JSON.stringify({ side: "remote", fromPath: "/", names: ["a"] }))).toBeNull();
    expect(parseSftpDragPayload(JSON.stringify({ side: "local", fromPath: "", names: ["a"] }))).toBeNull();
  });

  it("落点目录：目录行 = 进该目录；文件行 / 空白 / .. = 当前路径", () => {
    expect(dropTargetPath("/home", { name: "docs", isDir: true }, joinRemotePath)).toBe("/home/docs");
    expect(dropTargetPath("/home", { name: "a.txt", isDir: false }, joinRemotePath)).toBe("/home");
    expect(dropTargetPath("/home", null, joinRemotePath)).toBe("/home");
    expect(dropTargetPath("/home", { name: "..", isDir: true }, joinRemotePath)).toBe("/home");
    expect(dropTargetPath("C:\\tmp", { name: "d", isDir: true }, joinLocalPath)).toBe("C:\\tmp\\d");
  });

  it("remote → local 栏 = 下载批次（sftp_id 取来源会话，两侧路径各自拼接）", () => {
    const tasks = buildDropTransferTasks({
      payload: { ...remotePayload, names: ["a.txt", "b.log"] },
      destKind: "local",
      targetDir: "D:\\dl",
    });
    expect(tasks).toEqual([
      { sftp_id: "sftp-1", direction: "download", local_path: "D:\\dl\\a.txt", remote_path: "/home/tianzry/a.txt" },
      { sftp_id: "sftp-1", direction: "download", local_path: "D:\\dl\\b.log", remote_path: "/home/tianzry/b.log" },
    ]);
  });

  it("local → remote 栏 = 上传批次（sftp_id 取落点栏会话）", () => {
    const tasks = buildDropTransferTasks({
      payload: { side: "local", fromPath: "C:\\tmp", names: ["c.txt"] },
      destKind: "remote",
      destSftpId: "sftp-2",
      targetDir: "/var/tmp",
    });
    expect(tasks).toEqual([
      { sftp_id: "sftp-2", direction: "upload", local_path: "C:\\tmp\\c.txt", remote_path: "/var/tmp/c.txt" },
    ]);
  });

  it("不入队：同侧拖拽 / 上传缺落点会话 / 下载缺来源会话", () => {
    expect(
      buildDropTransferTasks({ payload: remotePayload, destKind: "remote", destSftpId: "s", targetDir: "/" }),
    ).toBeNull();
    expect(
      buildDropTransferTasks({ payload: { side: "local", fromPath: "C:\\", names: ["a"] }, destKind: "remote", targetDir: "/" }),
    ).toBeNull();
    expect(
      buildDropTransferTasks({ payload: { side: "remote", fromPath: "/", names: ["a"] }, destKind: "local", targetDir: "C:\\" }),
    ).toBeNull();
  });
});
