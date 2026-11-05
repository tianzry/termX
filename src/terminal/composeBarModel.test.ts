import { describe, expect, it } from "vitest";
import {
  COMPOSE_BAR_DEFAULT_HEIGHT,
  appendComposeHistory,
  buildComposePayload,
  canNavigateComposeHistory,
  clampComposeBarHeight,
  navigateComposeHistory,
  resolveComposeKeyAction,
} from "./composeBarModel";

describe("撰写栏高度", () => {
  it("默认 120，拖拽范围 72–360", () => {
    expect(clampComposeBarHeight(Number.NaN)).toBe(COMPOSE_BAR_DEFAULT_HEIGHT);
    expect(clampComposeBarHeight(10)).toBe(72);
    expect(clampComposeBarHeight(999)).toBe(360);
    expect(clampComposeBarHeight(150)).toBe(150);
  });
});

describe("撰写栏按键映射", () => {
  const base = { key: "a" };

  it("Enter 发送，Shift+Enter 换行，Ctrl/Alt/Cmd+Enter 也发送", () => {
    expect(resolveComposeKeyAction({ ...base, key: "Enter" })).toBe("send");
    expect(
      resolveComposeKeyAction({ ...base, key: "Enter", shiftKey: true }),
    ).toBe("default");
    expect(
      resolveComposeKeyAction({ ...base, key: "Enter", ctrlKey: true }),
    ).toBe("send");
    expect(
      resolveComposeKeyAction({ ...base, key: "Enter", altKey: true }),
    ).toBe("send");
    expect(
      resolveComposeKeyAction({ ...base, key: "Enter", metaKey: true }),
    ).toBe("send");
  });

  it("输入法组合态不触发发送或关闭", () => {
    expect(
      resolveComposeKeyAction({ ...base, key: "Enter", isComposing: true }),
    ).toBe("default");
    expect(
      resolveComposeKeyAction({ ...base, key: "Enter", keyCode: 229 }),
    ).toBe("default");
    expect(
      resolveComposeKeyAction({ ...base, key: "Escape", isComposing: true }),
    ).toBe("default");
  });

  it("Escape 关闭", () => {
    expect(resolveComposeKeyAction({ ...base, key: "Escape" })).toBe("close");
  });

  it("↑↓ 仅在允许翻阅且无修饰键时接管", () => {
    expect(
      resolveComposeKeyAction({ ...base, key: "ArrowUp", canHistoryUp: true }),
    ).toBe("history-up");
    expect(
      resolveComposeKeyAction({ ...base, key: "ArrowDown", canHistoryDown: true }),
    ).toBe("history-down");
    expect(
      resolveComposeKeyAction({ ...base, key: "ArrowUp", canHistoryUp: false }),
    ).toBe("default");
    expect(
      resolveComposeKeyAction({
        ...base,
        key: "ArrowUp",
        canHistoryUp: true,
        shiftKey: true,
      }),
    ).toBe("default");
  });
});

describe("撰写栏历史边界", () => {
  it("↑ 仅光标在首行、↓ 仅光标在末行时启用", () => {
    expect(canNavigateComposeHistory("abc", 2, "up")).toBe(true);
    expect(canNavigateComposeHistory("a\nb", 3, "up")).toBe(false);
    expect(canNavigateComposeHistory("a\nb", 1, "down")).toBe(false);
    expect(canNavigateComposeHistory("a\nb", 3, "down")).toBe(true);
    expect(canNavigateComposeHistory("abc", 1, "up", 2)).toBe(false);
  });

  it("↑ 取更早、↓ 回到更新，越过最新恢复草稿", () => {
    const entries = ["one", "two"];
    const first = navigateComposeHistory(
      entries,
      { index: Number.POSITIVE_INFINITY, draft: "" },
      "draft",
      "up",
    );
    expect(first).toEqual({ index: 1, value: "two", draft: "draft" });
    const second = navigateComposeHistory(
      entries,
      { index: 1, draft: "draft" },
      "two",
      "up",
    );
    expect(second).toEqual({ index: 0, value: "one", draft: "draft" });
    const back = navigateComposeHistory(
      entries,
      { index: 0, draft: "draft" },
      "one",
      "down",
    );
    expect(back).toEqual({ index: 1, value: "two", draft: "draft" });
    const draft = navigateComposeHistory(
      entries,
      { index: 1, draft: "draft" },
      "two",
      "down",
    );
    expect(draft).toEqual({ index: 2, value: "draft", draft: "draft" });
    expect(
      navigateComposeHistory([], { index: 0, draft: "" }, "", "up"),
    ).toBeNull();
  });

  it("发送历史跳过空白、连续重复并限制条数", () => {
    expect(appendComposeHistory([], "  ")).toEqual([]);
    expect(appendComposeHistory(["ls"], "ls")).toEqual(["ls"]);
    expect(appendComposeHistory(["ls"], "pwd")).toEqual(["ls", "pwd"]);
    const many = appendComposeHistory(["x"], "y", 1);
    expect(many).toEqual(["y"]);
    expect(appendComposeHistory([], "z")).toEqual(["z"]);
  });
});

describe("撰写栏发送内容", () => {
  it("换行统一为 LF 并追加回车", () => {
    expect(buildComposePayload("ls -la", false)).toBe("ls -la\r");
    expect(buildComposePayload("a\r\nb", false)).toBe("a\nb\r");
    expect(buildComposePayload("a\rb", false)).toBe("a\nb\r");
  });

  it("多行且 bracketed paste 开启时包裹内容，回车在包裹外", () => {
    expect(buildComposePayload("a\nb", true)).toBe(
      "\x1b[200~a\nb\x1b[201~\r",
    );
    expect(buildComposePayload("single", true)).toBe("single\r");
  });
});
