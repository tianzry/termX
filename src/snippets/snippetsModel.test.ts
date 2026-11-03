import { describe, expect, it } from "vitest";
import type { Snippet } from "../backend/client";
import {
  ensureSnippetIds,
  filterSnippets,
  groupSnippets,
  parseShortkey,
  shortkeyMatches,
  snippetPayload,
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
    ...over,
  };
}

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

describe("snippetPayload", () => {
  it("默认追加回车自动执行", () => {
    expect(snippetPayload("df -h", false)).toBe("df -h\r");
  });

  it("noAutoRun 原样插入", () => {
    expect(snippetPayload("df -h", true)).toBe("df -h");
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
