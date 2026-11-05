import { describe, expect, it, vi } from "vitest";
import {
  PATH_COMPLETION_BUDGET_MS,
  buildPathSuggestions,
  createPathDirectoryCache,
  currentWordOf,
  filterPathEntries,
  joinDirectoryPath,
  replaceCommandWord,
  resolvePathLookup,
  shouldCompletePath,
  sortPathEntries,
  withPathBudget,
  type PathEntry,
} from "./autocompletePathModel";
import {
  computeAutocompletePopupPlacement,
  derivePathArgumentHistory,
  mergeAutocompleteSuggestions,
  type AutocompleteSuggestion,
} from "./autocompleteModel";
import type { CommandHistoryEntry } from "./commandHistoryModel";

function historyEntry(
  command: string,
  hostId: string,
  count: number,
  timestamp: number,
): CommandHistoryEntry {
  return {
    id: `${hostId}:${command}:${timestamp}`,
    command,
    hostId,
    hostLabel: hostId,
    timestamp,
    count,
  };
}

function entry(name: string, type: PathEntry["type"] = "file"): PathEntry {
  return { name, type };
}

describe("shouldCompletePath", () => {
  it("命令白名单的实参位置补全路径", () => {
    expect(shouldCompletePath("ls ")).toEqual({ complete: true, foldersOnly: false });
    expect(shouldCompletePath("cat /etc/pa")).toEqual({ complete: true, foldersOnly: false });
    expect(shouldCompletePath("cd ")).toEqual({ complete: true, foldersOnly: true });
    expect(shouldCompletePath("mkdir proj")).toEqual({ complete: true, foldersOnly: true });
  });

  it("命令位与非路径命令不补全", () => {
    expect(shouldCompletePath("ec").complete).toBe(false);
    expect(shouldCompletePath("echo hello").complete).toBe(false);
    expect(shouldCompletePath("ls -la").complete).toBe(false);
    expect(shouldCompletePath("git checkout ")).toEqual({ complete: false, foldersOnly: false });
  });

  it("直接输入路径片段时总是补全", () => {
    expect(shouldCompletePath("./scr").complete).toBe(true);
    expect(shouldCompletePath("../").complete).toBe(true);
    expect(shouldCompletePath("~/doc").complete).toBe(true);
    expect(shouldCompletePath("~/").complete).toBe(true);
  });
});

describe("resolvePathLookup", () => {
  it("无 cwd 时相对路径落到 home（~）", () => {
    const lookup = resolvePathLookup({ currentWord: "src", cwd: null });
    expect(lookup.dirToList).toBe("~");
    expect(lookup.filterPrefix).toBe("src");
    expect(lookup.pathPrefix).toBe("");
  });

  it("按 cwd 拼接相对目录并拆出前缀", () => {
    const lookup = resolvePathLookup({ currentWord: "./src/ma", cwd: "/home/u" });
    expect(lookup.dirToList).toBe("/home/u/src");
    expect(lookup.filterPrefix).toBe("ma");
    expect(lookup.pathPrefix).toBe("./src/");
    expect(lookup.separator).toBe("/");
  });

  it("绝对目录与 home 前缀保持原样", () => {
    const absolute = resolvePathLookup({ currentWord: "/usr/lo", cwd: "/" });
    expect(absolute.dirToList).toBe("/usr");
    expect(absolute.filterPrefix).toBe("lo");
    expect(absolute.pathPrefix).toBe("/usr/");

    const home = resolvePathLookup({ currentWord: "~/doc", cwd: "/home/u" });
    expect(home.dirToList).toBe("~");
    expect(home.pathPrefix).toBe("~/");
    expect(home.filterPrefix).toBe("doc");
  });

  it("`..` 解析到父目录（带尾随分隔符）", () => {
    const lookup = resolvePathLookup({ currentWord: "..", cwd: "/home/u" });
    expect(lookup.dirToList).toBe("/home");
    expect(lookup.pathPrefix).toBe("../");
  });

  it("Windows 盘符路径使用反斜杠", () => {
    const lookup = resolvePathLookup({
      currentWord: "C:\\Users\\",
      windows: true,
      cwd: "C:\\Users\\u",
    });
    expect(lookup.separator).toBe("\\");
    expect(lookup.dirToList).toBe("C:\\Users");
    expect(lookup.filterPrefix).toBe("");
  });

  it("Windows 下空词按 cwd 推断反斜杠分隔符", () => {
    const lookup = resolvePathLookup({
      currentWord: "",
      windows: true,
      cwd: "C:\\Users\\u",
    });
    expect(lookup.separator).toBe("\\");
    expect(lookup.dirToList).toBe("C:\\Users\\u");
  });

  it("根路径与盘符根不回退到 cwd", () => {
    expect(resolvePathLookup({ currentWord: "/", cwd: "/home/u" }).dirToList).toBe("/");
    const driveRoot = resolvePathLookup({ currentWord: "C:\\", windows: true, cwd: "C:\\Users\\u" });
    expect(driveRoot.dirToList).toBe("C:\\");
  });

  it("Windows 本地带空格目录用双引号，POSIX 用单引号", () => {
    const win = resolvePathLookup({ currentWord: "", windows: true, cwd: "C:\\Users\\u" });
    const posix = resolvePathLookup({ currentWord: "", cwd: "/home/u" });
    expect(
      buildPathSuggestions({ line: "dir ", lookup: win, entries: [entry("My Docs", "directory")] })[0]
        .command,
    ).toBe('dir "My Docs"\\');
    expect(
      buildPathSuggestions({ line: "ls ", lookup: posix, entries: [entry("My Docs", "directory")] })[0]
        .command,
    ).toBe("ls 'My Docs'/");
  });

  it("保留引号并只替换引号内的路径", () => {
    const lookup = resolvePathLookup({ currentWord: '"My Doc', cwd: "/home/u" });
    expect(lookup.quotePrefix).toBe('"');
    expect(lookup.quoted).toBe(true);
    expect(lookup.filterPrefix).toBe("My Doc");
  });
});

describe("路径候选拼接与排序", () => {
  it("目录补尾随 /，文件不补", () => {
    const lookup = resolvePathLookup({ currentWord: "/usr/", cwd: "/" });
    const result = buildPathSuggestions({
      line: "ls /usr/",
      lookup,
      entries: [entry("local", "directory"), entry("lib", "file")],
    });
    expect(result.map((item) => item.command)).toEqual(["ls /usr/local/", "ls /usr/lib"]);
    expect(result[0]).toMatchObject({
      source: "path",
      fileType: "directory",
      score: 750,
      pathDir: "/usr/local/",
    });
    expect(result[1].pathDir).toBeUndefined();
  });

  it("cd 只给目录候选", () => {
    const lookup = resolvePathLookup({ currentWord: "", cwd: "/home/u" });
    const result = buildPathSuggestions({
      line: "cd ",
      lookup,
      entries: [entry("src", "directory"), entry("notes.txt", "file")],
      foldersOnly: true,
    });
    expect(result.map((item) => item.command)).toEqual(["cd src/"]);
  });

  it("目录 → 符号链接 → 文件，同类按名称忽略大小写", () => {
    const sorted = sortPathEntries([
      entry("b.txt", "file"),
      entry("Link", "symlink"),
      entry("zdir", "directory"),
      entry("adir", "directory"),
    ]);
    expect(sorted.map((item) => `${item.type}:${item.name}`)).toEqual([
      "directory:adir",
      "directory:zdir",
      "symlink:Link",
      "file:b.txt",
    ]);
  });

  it("前缀过滤不区分大小写并限制数量", () => {
    const entries = [entry("Readme", "file"), entry("report", "file"), entry("run", "directory")];
    expect(filterPathEntries(entries, "re").map((item) => item.name)).toEqual(["Readme", "report"]);
    expect(filterPathEntries(entries, "", 2)).toHaveLength(2);
  });

  it("拼接目录保留尾随分隔符，替换当前词保留命令前缀", () => {
    expect(joinDirectoryPath("/usr/local", "bin", "/")).toBe("/usr/local/bin/");
    expect(replaceCommandWord("cd src", "/home/u/src/")).toBe("cd /home/u/src/");
  });

  it("currentWordOf 处理尾随空格（空词）", () => {
    expect(currentWordOf("ls ")).toBe("");
    expect(currentWordOf("cat /etc")).toBe("/etc");
  });

  it("Windows 尾随反斜杠不是转义符：空格后是新的空实参", () => {
    const line = "dir C:\\Users\\t\\.agent-browser\\browsers\\ ";
    expect(currentWordOf(line, true)).toBe("");
    expect(currentWordOf(line)).toBe("C:\\Users\\t\\.agent-browser\\browsers\\ ");
    expect(shouldCompletePath(line, true)).toEqual({ complete: true, foldersOnly: false });
    // POSIX 语义保持不变：`\ ` 仍是转义，空格不切 token（反斜杠字符本身保留）。
    expect(currentWordOf("cat /tmp/a\\ b")).toBe("/tmp/a\\ b");
  });
});

describe("createPathDirectoryCache", () => {
  it("TTL 内命中缓存，过期后重新取数", async () => {
    let now = 1000;
    const loader = vi.fn(async () => [entry("a", "file")]);
    const cache = createPathDirectoryCache({ ttlMs: 5000, now: () => now });
    await cache.get("k", loader);
    await cache.get("k", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    now += 5001;
    await cache.get("k", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("并发请求合并为一次 in-flight", async () => {
    const loader = vi.fn(
      () =>
        new Promise<PathEntry[]>((resolve) =>
          setTimeout(() => resolve([entry("a", "file")]), 10),
        ),
    );
    const cache = createPathDirectoryCache();
    const [first, second] = await Promise.all([
      cache.get("k", loader),
      cache.get("k", loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("取数失败静默返回空数组，且不留下 in-flight", async () => {
    const cache = createPathDirectoryCache();
    const result = await cache.get("k", async () => {
      throw new Error("boom");
    });
    expect(result).toEqual([]);
    const retry = vi.fn(async () => [entry("ok", "directory")]);
    expect(await cache.get("k", retry)).toEqual([entry("ok", "directory")]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("超过上限时淘汰最旧条目", async () => {
    const cache = createPathDirectoryCache({ maxEntries: 2 });
    await cache.get("a", async () => [entry("a")]);
    await cache.get("b", async () => [entry("b")]);
    await cache.get("c", async () => [entry("c")]);
    expect(cache.size()).toBe(2);
  });

  it("invalidate 清理全部或单个 key", async () => {
    const cache = createPathDirectoryCache();
    const loader = vi.fn(async () => [entry("a")]);
    await cache.get("a", loader);
    cache.invalidate("a");
    await cache.get("a", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });
});

describe("withPathBudget", () => {
  it("预算内完成直接返回结果", async () => {
    const result = await withPathBudget(Promise.resolve([entry("a")]), 50);
    expect(result).toEqual([entry("a")]);
  });

  it("超时先返回空，迟到结果回填且只回调一次", async () => {
    const late = vi.fn();
    const pending = new Promise<PathEntry[]>((resolve) =>
      setTimeout(() => resolve([entry("late")]), 40),
    );
    const result = await withPathBudget(pending, 5, late);
    expect(result).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith([entry("late")]);
  });

  it("迟到失败静默丢弃", async () => {
    const late = vi.fn();
    const failing = new Promise<PathEntry[]>((_, reject) =>
      setTimeout(() => reject(new Error("boom")), 20),
    );
    const result = await withPathBudget(failing, 5, late);
    expect(result).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(late).not.toHaveBeenCalled();
  });

  it("默认预算常量为 150ms", () => {
    expect(PATH_COMPLETION_BUDGET_MS).toBe(150);
  });
});

describe("derivePathArgumentHistory", () => {
  it("只保留同命令 + 实参前缀的历史，权重 720 起，最多 5 条", () => {
    const history = [
      historyEntry("ls /tmp", "h1", 3, 5),
      historyEntry("ls /var/log", "h1", 9, 4),
      historyEntry("ls -la /tmp", "h1", 1, 3),
      historyEntry("cat /tmp/x", "h1", 2, 2),
      historyEntry("ls /tmp", "h2", 7, 1),
    ];
    const result = derivePathArgumentHistory({
      typed: "ls /t",
      history,
      scope: "host",
      hostId: "h1",
    });
    expect(result.map((item) => item.command)).toEqual(["ls /tmp", "ls -la /tmp"]);
    expect(result[0].score).toBe(720);
    expect(result[1].score).toBe(719);
    expect(result[0].description).toBe("历史路径");
  });

  it("global 范围合并所有主机；命令位（无实参）不产生路径历史", () => {
    const history = [
      historyEntry("ls /tmp", "h1", 1, 2),
      historyEntry("ls /tmp", "h2", 1, 1),
    ];
    expect(
      derivePathArgumentHistory({ typed: "ls ", history, scope: "global", hostId: "h1" }).length,
    ).toBe(1);
    expect(
      derivePathArgumentHistory({ typed: "ls", history, scope: "global", hostId: "h1" }),
    ).toEqual([]);
  });
});

describe("mergeAutocompleteSuggestions 与浮层几何", () => {
  const history: AutocompleteSuggestion = {
    command: "ls",
    source: "history",
    score: 1004,
  };
  const command: AutocompleteSuggestion = {
    command: "lsblk",
    source: "command",
    score: 600,
  };
  const path: AutocompleteSuggestion = {
    command: "ls /tmp/",
    source: "path",
    score: 750,
  };

  it("按权重排序并按命令去重", () => {
    const merged = mergeAutocompleteSuggestions([history, command], [path, history]);
    expect(merged.map((item) => item.command)).toEqual(["ls", "ls /tmp/", "lsblk"]);
  });

  it("浮层默认 400 宽、28 行高、最高 240、间距 8", () => {
    const placement = computeAutocompletePopupPlacement({
      anchorTop: 100,
      anchorBottom: 118,
      anchorLeft: 200,
      paneWidth: 900,
      paneHeight: 600,
      itemCount: 3,
      subPanelCount: 0,
    });
    expect(placement.width).toBe(400);
    expect(placement.maxHeight).toBe(3 * 28 + 8);
    expect(placement.top).toBe(118 + 8);
    expect(placement.left).toBe(200);
    expect(placement.renderUpward).toBe(false);
  });

  it("下方不足时上翻，并夹取在 pane 内", () => {
    const placement = computeAutocompletePopupPlacement({
      anchorTop: 520,
      anchorBottom: 540,
      anchorLeft: 700,
      paneWidth: 720,
      paneHeight: 560,
      itemCount: 10,
      subPanelCount: 1,
    });
    expect(placement.renderUpward).toBe(true);
    expect(placement.maxHeight).toBeLessThanOrEqual(240);
    expect(placement.top).toBeGreaterThanOrEqual(8);
    // 主列表 + 子面板（400 + 4 + 240）贴右侧夹取。
    expect(placement.left).toBe(68);
  });

  it("子面板宽 240，整体随级数增加", () => {
    const placement = computeAutocompletePopupPlacement({
      anchorTop: 100,
      anchorBottom: 118,
      anchorLeft: 300,
      paneWidth: 1280,
      paneHeight: 700,
      itemCount: 5,
      subPanelCount: 2,
    });
    expect(placement.subPanelWidth).toBe(240);
    expect(placement.left).toBe(300);
  });

  it("pane 较窄时压缩子面板宽度，整体不溢出", () => {
    const placement = computeAutocompletePopupPlacement({
      anchorTop: 100,
      anchorBottom: 118,
      anchorLeft: 8,
      paneWidth: 820,
      paneHeight: 600,
      itemCount: 5,
      subPanelCount: 3,
    });
    expect(placement.width + placement.subPanelWidth * 3 + 12).toBeLessThanOrEqual(820 - 16);
  });
});
