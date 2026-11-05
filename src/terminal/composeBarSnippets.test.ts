import { describe, expect, it } from "vitest";
import type { Snippet } from "../backend/client";
import {
  COMPOSE_BUILTIN_IDS,
  buildComposeSnippetMap,
  filterComposeBarSnippets,
  insertSnippetIntoCompose,
  parsePinnedIds,
  prunePinnedIds,
  resolveComposeDefaultPinned,
  togglePinnedId,
} from "./composeBarSnippets";

function snippet(id: string, name: string, command = name, pkg = ""): Snippet {
  return {
    id,
    name,
    command,
    description: "",
    package: pkg,
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "snippet",
    multi_line_run_mode: "paste",
    language: "",
    trigger: "manual",
    trigger_pattern: "",
  };
}

describe("filterComposeBarSnippets", () => {
  const list = [
    snippet("1", "uptime", "uptime"),
    snippet("2", "磁盘", "df -h", "ops"),
    snippet("3", "Deploy", "kubectl apply -f x.yaml", "k8s"),
  ];

  it("空搜索按名称排序", () => {
    expect(filterComposeBarSnippets(list, "").map((s) => s.id)).toEqual([
      "2",
      "3",
      "1",
    ]);
  });

  it("命中名称 / 命令 / 分组，大小写不敏感", () => {
    expect(filterComposeBarSnippets(list, "KUBECTL").map((s) => s.id)).toEqual(["3"]);
    expect(filterComposeBarSnippets(list, "ops").map((s) => s.id)).toEqual(["2"]);
    expect(filterComposeBarSnippets(list, "DF").map((s) => s.id)).toEqual(["2"]);
  });

  it("无命中返回空数组", () => {
    expect(filterComposeBarSnippets(list, "nope")).toEqual([]);
  });
});

describe("固定集合", () => {
  it("有仓库片段时取按名称排序的前 4 条", () => {
    const list = ["z", "a", "m", "b", "c"].map((n) => snippet(n, n));
    expect(resolveComposeDefaultPinned(list)).toEqual(["a", "b", "c", "m"]);
  });

  it("没有片段时用内置 4 条", () => {
    expect(resolveComposeDefaultPinned([])).toEqual(COMPOSE_BUILTIN_IDS);
  });

  it("内置片段始终可解析，仓库片段可覆盖同 id", () => {
    const map = buildComposeSnippetMap([snippet("__compose_builtin_ls", "custom")]);
    expect(map.get("__compose_builtin_ls")?.name).toBe("custom");
    expect(map.get("__compose_builtin_df")?.name).toBe("df -h");
  });

  it("切换固定状态：新增追加、取消移除", () => {
    expect(togglePinnedId(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePinnedId(["a", "b"], "a")).toEqual(["b"]);
  });

  it("删除片段后剔除失效 id，内置 id 保留", () => {
    expect(
      prunePinnedIds(["__compose_builtin_ls", "gone", "kept"], ["kept"]),
    ).toEqual(["__compose_builtin_ls", "kept"]);
  });

  it("localStorage 解析容错", () => {
    expect(parsePinnedIds(null)).toEqual([]);
    expect(parsePinnedIds("{bad")).toEqual([]);
    expect(parsePinnedIds('["a",1,"b"]')).toEqual(["a", "b"]);
  });
});

describe("insertSnippetIntoCompose", () => {
  it("空草稿直接插入，光标在末尾", () => {
    expect(insertSnippetIntoCompose("", "ls -la")).toEqual({
      value: "ls -la",
      cursor: 6,
    });
  });

  it("已有草稿时补换行追加，保留多行内容", () => {
    expect(insertSnippetIntoCompose("pwd", "a\n  b")).toEqual({
      value: "pwd\na\n  b",
      cursor: 9,
    });
  });

  it("草稿已以换行结尾时不重复换行", () => {
    expect(insertSnippetIntoCompose("pwd\n", "uptime")).toEqual({
      value: "pwd\nuptime",
      cursor: 10,
    });
  });
});
