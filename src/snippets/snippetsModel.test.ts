import { describe, expect, it } from "vitest";
import type { Snippet } from "../backend/client";
import {
  deleteSnippetPackage,
  ensureSnippetIds,
  filterSnippets,
  findShortkeyConflict,
  groupSnippets,
  isScriptSnippet,
  normalizeLineEndings,
  parseShortkey,
  renameSnippetPackage,
  resolveMultiLineRunMode,
  resolveScriptTrigger,
  scriptTriggerNote,
  shortkeyMatches,
  SNIPPET_LINE_DELAY_MS,
  snippetWritePlan,
  buildSnippetPackageTree,
  flattenSnippetCommandPreview,
  formatShortkeyEvent,
  parseSnippetVariables,
  previewSnippetCommand,
  snippetBreadcrumb,
  sortSnippets,
} from "./snippetsModel";

function snip(over: Partial<Snippet> = {}): Snippet {
  return {
    id: "id-1",
    name: "磁盘用量",
    command: "df -h",
    description: "",
    package: "",
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "",
    multi_line_run_mode: "",
    language: "",
    trigger: "",
    trigger_pattern: "",
    ...over,
  };
}

describe("列表派生（排序 / 分组树 / 变量 / 快捷键录制）", () => {
  it("排序：manual 保持原序，az/za 按名称，group 先分组再名称", () => {
    const list = [
      snip({ id: "b", name: "乙", package: "ops/web" }),
      snip({ id: "a", name: "甲", package: "" }),
      snip({ id: "c", name: "丙", package: "ops" }),
    ];
    expect(sortSnippets(list, "manual").map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(sortSnippets(list, "newest").map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(sortSnippets(list, "group").map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("分组树：隐式父级、子树计数、面包屑", () => {
    const tree = buildSnippetPackageTree([
      snip({ package: "ops/web" }),
      snip({ package: "ops/db" }),
      snip({ package: "ops" }),
    ]);
    expect(tree.map((p) => [p.path, p.count])).toEqual([
      ["ops", 3],
      ["ops/db", 1],
      ["ops/web", 1],
    ]);
    expect(snippetBreadcrumb("ops/db")).toEqual([
      { name: "ops", path: "ops" },
      { name: "db", path: "ops/db" },
    ]);
  });

  it("命令预览折叠空白", () => {
    expect(flattenSnippetCommandPreview("  df   -h\n du -sh  ")).toBe("df -h du -sh");
  });

  it("变量解析：去重、默认值、填充", () => {
    expect(parseSnippetVariables("echo {{host}} {{user:root}} {{host}}")).toEqual([
      { name: "host" },
      { name: "user", defaultValue: "root" },
    ]);
    expect(previewSnippetCommand("echo {{host}} {{user:root}}", { host: "a" })).toBe(
      "echo a root",
    );
  });

  it("变量替换先于脚本编译：JS 字符串里的占位符按原引号替换", () => {
    const source = "await nct.screen.sendLine('echo {{host}}');";
    expect(parseSnippetVariables(source)).toEqual([{ name: "host" }]);
    expect(previewSnippetCommand(source, { host: "web1" })).toBe(
      "await nct.screen.sendLine('echo web1');",
    );
  });

  it("快捷键录制：忽略纯修饰键，主键大写并拼接修饰键", () => {
    expect(formatShortkeyEvent({ key: "Control", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBeNull();
    expect(
      formatShortkeyEvent({ key: "f1", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    ).toBe("Ctrl + Shift + F1");
    expect(parseShortkey("Ctrl + Shift + F1")?.key).toBe("f1");
  });
});

describe("filterSnippets", () => {
  const list = [
    snip({ id: "a", name: "磁盘用量", command: "df -h", tags: ["ops"] }),
    snip({
      id: "b",
      name: "重启服务",
      command: "systemctl restart nginx",
      description: "web server",
      package: "ops/web",
    }),
    snip({ id: "c", name: "日志跟随", command: "tail -f /var/log/syslog" }),
  ];

  it("空搜索返回全部", () => {
    expect(filterSnippets(list, "  ").map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("命中 名称/命令/描述/分组/标签，忽略大小写", () => {
    expect(filterSnippets(list, "磁盘").map((s) => s.id)).toEqual(["a"]);
    expect(filterSnippets(list, "SYSTEMCTL").map((s) => s.id)).toEqual(["b"]);
    expect(filterSnippets(list, "web server").map((s) => s.id)).toEqual(["b"]);
    expect(filterSnippets(list, "ops/web").map((s) => s.id)).toEqual(["b"]);
    expect(filterSnippets(list, "OPS").map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("无匹配返回空数组", () => {
    expect(filterSnippets(list, "不存在")).toEqual([]);
  });
});

describe("groupSnippets", () => {
  it("按分组字母序、未分组最后、组内保持原顺序", () => {
    const list = [
      snip({ id: "1", package: "" }),
      snip({ id: "2", package: "ops/web" }),
      snip({ id: "3", package: "db" }),
      snip({ id: "4", package: "ops/web" }),
      snip({ id: "5", package: "   " }),
    ];
    const groups = groupSnippets(list);
    expect(groups.map((g) => g.pkg)).toEqual(["db", "ops/web", ""]);
    expect(groups[1].items.map((s) => s.id)).toEqual(["2", "4"]);
    expect(groups[2].items.map((s) => s.id)).toEqual(["1", "5"]);
  });

  it("空列表返回空分组", () => {
    expect(groupSnippets([])).toEqual([]);
  });
});

describe("parseShortkey", () => {
  it("解析单键", () => {
    expect(parseShortkey("F1")).toEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
      key: "f1",
    });
  });

  it("解析修饰键 + 主键（忽略大小写与空白）", () => {
    expect(parseShortkey(" Ctrl + Shift + F1 ")).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
      key: "f1",
    });
    expect(parseShortkey("Cmd + S")).toEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: true,
      key: "s",
    });
    expect(parseShortkey("Alt + Option + A")).toEqual({
      ctrl: false,
      shift: false,
      alt: true,
      meta: false,
      key: "a",
    });
  });

  it("非法输入返回 null", () => {
    expect(parseShortkey("")).toBeNull();
    expect(parseShortkey("   ")).toBeNull();
    expect(parseShortkey("Ctrl + Shift")).toBeNull(); // 只有修饰键
    expect(parseShortkey("Ctrl + Foo + S")).toBeNull(); // 未知修饰键
    expect(parseShortkey("A + B")).toBeNull(); // 中段非修饰键
  });
});

describe("shortkeyMatches", () => {
  const ev = (
    over: Partial<{
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      metaKey: boolean;
      key: string;
    }> = {},
  ) => ({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    key: "F1",
    ...over,
  });

  it("主键忽略大小写", () => {
    const b = parseShortkey("Ctrl + F1")!;
    expect(shortkeyMatches(b, ev({ ctrlKey: true, key: "f1" }))).toBe(true);
  });

  it("修饰键必须严格一致", () => {
    const b = parseShortkey("Ctrl + F1")!;
    expect(shortkeyMatches(b, ev({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(shortkeyMatches(b, ev())).toBe(false);
  });

  it("主键不同不匹配", () => {
    const b = parseShortkey("Ctrl + F1")!;
    expect(shortkeyMatches(b, ev({ ctrlKey: true, key: "F2" }))).toBe(false);
  });
});

describe("normalizeLineEndings / resolveMultiLineRunMode", () => {
  it("CRLF 与 CR 统一为 LF", () => {
    expect(normalizeLineEndings("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("仅 lineDelay 生效，其余回落 paste", () => {
    expect(resolveMultiLineRunMode("lineDelay")).toBe("lineDelay");
    expect(resolveMultiLineRunMode("paste")).toBe("paste");
    expect(resolveMultiLineRunMode("")).toBe("paste");
    expect(resolveMultiLineRunMode(undefined)).toBe("paste");
    expect(resolveMultiLineRunMode("bogus")).toBe("paste");
  });
});

describe("isScriptSnippet", () => {
  it("kind=script 才算脚本", () => {
    expect(isScriptSnippet({ kind: "script" })).toBe(true);
    expect(isScriptSnippet({ kind: "" })).toBe(false);
  });
});

describe("scriptTrigger", () => {
  it("归一化：空 / 未知 = manual，其余保留", () => {
    expect(resolveScriptTrigger(undefined)).toBe("manual");
    expect(resolveScriptTrigger("")).toBe("manual");
    expect(resolveScriptTrigger("bogus")).toBe("manual");
    expect(resolveScriptTrigger("onConnect")).toBe("onConnect");
    expect(resolveScriptTrigger("onOutput")).toBe("onOutput");
  });

  it("自动触发说明写明生效条件", () => {
    expect(scriptTriggerNote("onConnect")).toContain("目标主机");
    expect(scriptTriggerNote("onOutput")).toContain("同一会话同一脚本只触发一次");
    expect(scriptTriggerNote("manual")).toContain("手动运行");
  });
});

describe("snippetWritePlan", () => {
  it("单行默认：一次写入 + 末尾单回车", () => {
    expect(snippetWritePlan("df -h", false)).toEqual({
      chunks: ["df -h\r"],
      delayMs: 0,
    });
  });

  it("noAutoRun：原样插入，不追加回车", () => {
    expect(snippetWritePlan("df -h", true)).toEqual({
      chunks: ["df -h"],
      delayMs: 0,
    });
  });

  it("多行 paste：整体一次写入，行间 CR，末尾单回车", () => {
    expect(snippetWritePlan("a\nb\nc", false, "paste")).toEqual({
      chunks: ["a\rb\rc\r"],
      delayMs: 0,
    });
  });

  it("多行 lineDelay：逐行发送，每行一个回车、250ms 间隔", () => {
    expect(snippetWritePlan("a\nb\nc", false, "lineDelay")).toEqual({
      chunks: ["a\r", "b\r", "c\r"],
      delayMs: SNIPPET_LINE_DELAY_MS,
    });
  });

  it("lineDelay 但只有一行：退化为整段写入", () => {
    expect(snippetWritePlan("uptime", false, "lineDelay")).toEqual({
      chunks: ["uptime\r"],
      delayMs: 0,
    });
  });

  it("lineDelay + noAutoRun：不逐行、不追加回车", () => {
    expect(snippetWritePlan("a\nb", true, "lineDelay")).toEqual({
      chunks: ["a\rb"],
      delayMs: 0,
    });
  });

  it("去掉末尾换行后不产生空行（末尾单回车）", () => {
    expect(snippetWritePlan("a\nb\n", false, "lineDelay")).toEqual({
      chunks: ["a\r", "b\r"],
      delayMs: SNIPPET_LINE_DELAY_MS,
    });
  });

  it("CRLF 输入按多行处理", () => {
    expect(snippetWritePlan("a\r\nb", false, "lineDelay").chunks).toEqual([
      "a\r",
      "b\r",
    ]);
  });
});

describe("ensureSnippetIds", () => {
  it("补齐缺失 id 并对重复 id 去重", () => {
    const list = [snip({ id: "" }), snip({ id: "x" }), snip({ id: "x" })];
    const out = ensureSnippetIds(list);
    const ids = out.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    expect(out[1].id).toBe("x");
    expect(out[0].id).not.toBe("");
  });

  it("已有合法 id 保持不变", () => {
    const list = [snip({ id: "a" }), snip({ id: "b" })];
    expect(ensureSnippetIds(list).map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("findShortkeyConflict", () => {
  const list = [
    snip({ id: "a", shortkey: "F1" }),
    snip({ id: "b", shortkey: "Ctrl + Shift + F2" }),
  ];

  it("忽略大小写与修饰键顺序命中原片段", () => {
    expect(findShortkeyConflict(list, "shift + ctrl + f2")?.id).toBe("b");
    expect(findShortkeyConflict(list, "f1")?.id).toBe("a");
  });

  it("排除自身", () => {
    expect(findShortkeyConflict(list, "F1", "a")).toBeNull();
  });

  it("空值与非法格式不冲突", () => {
    expect(findShortkeyConflict(list, "")).toBeNull();
    expect(findShortkeyConflict(list, "Ctrl")).toBeNull();
  });
});

describe("renameSnippetPackage", () => {
  it("级联重命名子分组", () => {
    const list = [
      snip({ id: "a", package: "ops" }),
      snip({ id: "b", package: "ops/db" }),
      snip({ id: "c", package: "other" }),
    ];
    const out = renameSnippetPackage(list, "ops", "prod");
    expect(out.map((s) => s.package)).toEqual(["prod", "prod/db", "other"]);
  });

  it("空名 / 同名保持不变", () => {
    const list = [snip({ id: "a", package: "ops" })];
    expect(renameSnippetPackage(list, "ops", "  ")).toBe(list);
    expect(renameSnippetPackage(list, "ops", "ops")).toBe(list);
  });
});

describe("deleteSnippetPackage", () => {
  it("删除分组及其子分组下的片段，保留其他分组", () => {
    const list = [
      snip({ id: "a", package: "ops" }),
      snip({ id: "b", package: "ops/db" }),
      snip({ id: "c", package: "ops2" }),
      snip({ id: "d", package: "" }),
    ];
    expect(deleteSnippetPackage(list, "ops").map((s) => s.id)).toEqual(["c", "d"]);
  });
});
