import { describe, expect, it } from "vitest";
import {
  classifyAutocompleteData,
  computeAutocompleteAcceptTail,
  computeAutocompleteGhost,
  computeLivePreviewWrite,
  deriveAutocompleteSuggestions,
  moveAutocompleteSelection,
  resolveAutocompleteKey,
} from "./autocompleteModel";
import type { CommandHistoryEntry } from "./commandHistoryModel";

function historyEntry(
  command: string,
  hostId: string,
  count: number,
  timestamp = 0,
): CommandHistoryEntry {
  return {
    id: `${hostId}:${command}`,
    command,
    hostId,
    hostLabel: hostId,
    timestamp,
    count,
  };
}

describe("deriveAutocompleteSuggestions", () => {
  const history = [
    historyEntry("git status", "h1", 4),
    historyEntry("git stash", "h1", 2),
    historyEntry("ls -la", "h1", 7),
    historyEntry("grep foo", "h2", 3),
  ];

  it("按前缀匹配历史，次数多的优先", () => {
    const result = deriveAutocompleteSuggestions({
      typed: "git",
      history,
      scope: "host",
      hostId: "h1",
    });
    const historyOnly = result.filter((item) => item.source === "history");
    expect(historyOnly.map((item) => item.command)).toEqual(["git status", "git stash"]);
    expect(historyOnly[0].count).toBe(4);
    // 常见命令兜底只在命令位置追加，且排在历史之后。
    expect(result[result.length - 1]).toMatchObject({ command: "git", source: "command" });
  });

  it("大小写不敏感，全局范围合并所有主机", () => {
    const scopedHistory = [
      historyEntry("deploy prod", "h1", 5),
      historyEntry("Deploy staging", "h2", 2),
    ];
    const hostOnly = deriveAutocompleteSuggestions({
      typed: "DEP",
      history: scopedHistory,
      scope: "host",
      hostId: "h1",
    });
    expect(hostOnly.map((item) => item.command)).toEqual(["deploy prod"]);
    const global = deriveAutocompleteSuggestions({
      typed: "DEP",
      history: scopedHistory,
      scope: "global",
      hostId: "h1",
    });
    expect(global.map((item) => item.command)).toEqual(["deploy prod", "Deploy staging"]);
  });

  it("无历史时用常见命令兜底，且与历史去重", () => {
    const result = deriveAutocompleteSuggestions({
      typed: "l",
      history: [historyEntry("ls -la", "h1", 1)],
      scope: "host",
      hostId: "h1",
    });
    const commands = result.map((item) => item.command);
    expect(commands).toContain("ls -la");
    expect(commands).toContain("less");
    expect(commands.filter((command) => command === "ls")).toHaveLength(1);
    expect(result.find((item) => item.command === "ls")?.source).toBe("command");
  });

  it("光标已在参数位置（含空格）时不再给常见命令候选", () => {
    const result = deriveAutocompleteSuggestions({
      typed: "git st",
      history,
      scope: "host",
      hostId: "h1",
    });
    expect(result.map((item) => item.command)).toEqual(["git status", "git stash"]);
  });

  it("少于最小字符数 / 含换行 / 超上限时返回空或被裁剪", () => {
    expect(
      deriveAutocompleteSuggestions({
        typed: "",
        history,
        scope: "host",
        hostId: "h1",
        minChars: 1,
      }),
    ).toEqual([]);
    expect(
      deriveAutocompleteSuggestions({
        typed: "git\n",
        history,
        scope: "host",
        hostId: "h1",
      }),
    ).toEqual([]);
    const many = Array.from({ length: 60 }, (_, index) =>
      historyEntry(`ls ${index}`, "h1", 1),
    );
    expect(
      deriveAutocompleteSuggestions({
        typed: "ls",
        history: many,
        scope: "host",
        hostId: "h1",
        max: 5,
      }),
    ).toHaveLength(5);
  });
});

describe("ghost / accept", () => {
  it("ghost 返回相对前缀的尾部，相同或非前缀返回空", () => {
    expect(
      computeAutocompleteGhost("git", [
        { command: "git status", source: "history" },
      ]),
    ).toBe(" status");
    expect(
      computeAutocompleteGhost("git status", [
        { command: "git status", source: "history" },
      ]),
    ).toBe("");
    expect(
      computeAutocompleteGhost("git", [
        { command: "ls", source: "command" },
      ]),
    ).toBe("");
    expect(computeAutocompleteGhost("x", [])).toBe("");
  });

  it("接受尾部只补缺失部分，非前缀拒绝", () => {
    expect(computeAutocompleteAcceptTail("git sta", "git status")).toBe("tus");
    expect(computeAutocompleteAcceptTail("GIT sta", "git status")).toBe("tus");
    expect(computeAutocompleteAcceptTail("git", "ls")).toBeNull();
  });
});

describe("computeLivePreviewWrite", () => {
  it("候选是当前行延伸时只写尾部", () => {
    expect(
      computeLivePreviewWrite({
        currentLine: "git",
        candidate: "git status",
        useBackspaceClear: false,
      }),
    ).toBe(" status");
  });

  it("非延伸候选：POSIX 用 Ctrl-U 清行后整行写入", () => {
    expect(
      computeLivePreviewWrite({
        currentLine: "gti",
        candidate: "git status",
        useBackspaceClear: false,
      }),
    ).toBe("\x15git status");
  });

  it("Windows Shell 用退格清行", () => {
    expect(
      computeLivePreviewWrite({
        currentLine: "abc",
        candidate: "abd",
        useBackspaceClear: true,
      }),
    ).toBe("\b\b\babd");
  });

  it("候选与当前行相同不写入", () => {
    expect(
      computeLivePreviewWrite({
        currentLine: "git status",
        candidate: "git status",
        useBackspaceClear: false,
      }),
    ).toBe("");
  });
});

describe("classifyAutocompleteData", () => {
  it("识别编辑 / 导航 / 接受相关的控制序列", () => {
    expect(classifyAutocompleteData("\r")).toBe("enter");
    expect(classifyAutocompleteData("\t")).toBe("tab");
    expect(classifyAutocompleteData("\x7f")).toBe("backspace");
    expect(classifyAutocompleteData("\x1b[A")).toBe("up");
    expect(classifyAutocompleteData("\x1bOB")).toBe("down");
    expect(classifyAutocompleteData("\x1b[C")).toBe("right");
    expect(classifyAutocompleteData("\x1b[D")).toBe("left");
    expect(classifyAutocompleteData("\x1b")).toBe("escape");
    expect(classifyAutocompleteData("\x15")).toBe("line-erase");
    expect(classifyAutocompleteData("\x03")).toBe("interrupt");
    expect(classifyAutocompleteData("a")).toBe("print");
    expect(classifyAutocompleteData("中")).toBe("print");
    expect(classifyAutocompleteData("git status")).toBe("print");
    expect(classifyAutocompleteData("\x1b[1;5A")).toBe("other");
  });
});

describe("resolveAutocompleteKey（接受键状态机）", () => {
  it("候选可见时 ↑/↓ 导航，否则交给 Shell 历史", () => {
    expect(
      resolveAutocompleteKey({ kind: "down", popupOpen: true, ghostVisible: false }),
    ).toEqual({ kind: "navigate", delta: 1 });
    expect(
      resolveAutocompleteKey({ kind: "up", popupOpen: true, ghostVisible: false }),
    ).toEqual({ kind: "navigate", delta: -1 });
    expect(
      resolveAutocompleteKey({ kind: "up", popupOpen: false, ghostVisible: false }),
    ).toEqual({ kind: "ignore" });
  });

  it("→ 只接受 ghost text", () => {
    expect(
      resolveAutocompleteKey({ kind: "right", popupOpen: false, ghostVisible: true }),
    ).toEqual({ kind: "accept-ghost" });
    expect(
      resolveAutocompleteKey({ kind: "right", popupOpen: true, ghostVisible: false }),
    ).toEqual({ kind: "ignore" });
  });

  it("Tab / Enter 放行给 Shell，Esc 关闭并恢复", () => {
    expect(
      resolveAutocompleteKey({ kind: "tab", popupOpen: true, ghostVisible: false }),
    ).toEqual({ kind: "release" });
    expect(
      resolveAutocompleteKey({ kind: "enter", popupOpen: true, ghostVisible: false }),
    ).toEqual({ kind: "confirm" });
    expect(
      resolveAutocompleteKey({ kind: "escape", popupOpen: true, ghostVisible: false }),
    ).toEqual({ kind: "dismiss", restore: true });
    expect(
      resolveAutocompleteKey({ kind: "escape", popupOpen: false, ghostVisible: true }),
    ).toEqual({ kind: "dismiss", restore: false });
    expect(
      resolveAutocompleteKey({ kind: "escape", popupOpen: false, ghostVisible: false }),
    ).toEqual({ kind: "ignore" });
  });
});

describe("moveAutocompleteSelection", () => {
  it("从 -1 向下选第一条、向上选最后一条", () => {
    expect(moveAutocompleteSelection(-1, 3, 1)).toBe(0);
    expect(moveAutocompleteSelection(-1, 3, -1)).toBe(2);
  });

  it("两端夹取且回到 -1 保持", () => {
    expect(moveAutocompleteSelection(2, 3, 1)).toBe(2);
    expect(moveAutocompleteSelection(0, 3, -1)).toBe(-1);
    expect(moveAutocompleteSelection(-1, 3, -1)).toBe(2);
    expect(moveAutocompleteSelection(0, 0, 1)).toBe(-1);
  });
});
