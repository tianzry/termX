import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYWORD_HIGHLIGHT_RULES,
  normalizeHostKeywordHighlightRules,
  normalizeKeywordHighlightRules,
  type KeywordHighlightRule,
} from "../settings/settingsModel";
import {
  compileKeywordRules,
  findKeywordSpans,
  mergeKeywordHighlightRules,
  resolveKeywordHighlightRuntime,
  validateKeywordRuleDraft,
} from "./keywordHighlight";

const rule = (id: string, color: string, patterns: string[], enabled = true): KeywordHighlightRule => ({
  id,
  label: id,
  color,
  patterns,
  enabled,
});

describe("keywordHighlight", () => {
  it("按规则顺序匹配并忽略大小写", () => {
    const compiled = compileKeywordRules([
      rule("error", "#F87171", ["\\berror\\b"]),
      rule("ok", "#34D399", ["\\bdone\\b"]),
    ]);
    const spans = findKeywordSpans("ERROR: boot done", compiled);
    expect(spans.map((s) => [s.start, s.end, s.ruleId])).toEqual([
      [0, 5, "error"],
      [12, 16, "ok"],
    ]);
  });

  it("先规则先得：后规则不覆盖已命中区间", () => {
    const compiled = compileKeywordRules([
      rule("error", "#F87171", ["fail"]),
      rule("warning", "#FBBF24", ["failed"]),
    ]);
    const spans = findKeywordSpans("operation failed", compiled);
    expect(spans).toHaveLength(1);
    expect(spans[0].ruleId).toBe("error");
    expect(spans[0].start).toBe(10);
    expect(spans[0].end).toBe(14);
  });

  it("跳过非法正则与禁用规则，不影响其他规则", () => {
    const compiled = compileKeywordRules([
      rule("broken", "#000000", ["("]),
      rule("off", "#000000", ["x"], false),
      rule("ok", "#34D399", ["\\bready\\b"]),
    ]);
    expect(compiled.map((r) => r.id)).toEqual(["ok"]);
    expect(findKeywordSpans("not ready", compiled)[0]?.ruleId).toBe("ok");
  });

  it("零宽匹配不会死循环", () => {
    const compiled = compileKeywordRules([rule("zero", "#000000", ["(?=a)"])]);
    const spans = findKeywordSpans("aaa", compiled);
    expect(spans).toHaveLength(0);
  });

  it("内置规则覆盖 Netcatty 七组，且都能编译", () => {
    expect(DEFAULT_KEYWORD_HIGHLIGHT_RULES.map((r) => r.id)).toEqual([
      "error",
      "warning",
      "ok",
      "info",
      "debug",
      "ip-mac",
      "unix-path",
    ]);
    expect(compileKeywordRules(DEFAULT_KEYWORD_HIGHLIGHT_RULES)).toHaveLength(7);
    const spans = findKeywordSpans("GET https://example.com/a -> 10.0.0.2", compileKeywordRules(DEFAULT_KEYWORD_HIGHLIGHT_RULES));
    expect(spans.some((s) => s.ruleId === "ip-mac")).toBe(true);
  });

  it("normalize 丢弃非法条目并回落内置规则", () => {
    expect(normalizeKeywordHighlightRules([])).toHaveLength(7);
    expect(normalizeKeywordHighlightRules([{ id: "x", label: "", patterns: [], color: "red", enabled: true }])).toHaveLength(7);
    const custom = normalizeKeywordHighlightRules([
      { id: "custom", label: "Custom", patterns: ["deploy"], color: "#22d3ee", enabled: false },
    ]);
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ id: "custom", enabled: false, color: "#22D3EE" });
  });

  it("normalize 保留超过 200 字符的内置正则（IPV6 / URL 不被截断）", () => {
    const normalized = normalizeKeywordHighlightRules(
      DEFAULT_KEYWORD_HIGHLIGHT_RULES.map((r) => ({ ...r, patterns: [...r.patterns] })),
    );
    const ipMac = normalized.find((r) => r.id === "ip-mac");
    expect(ipMac?.patterns).toEqual(DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === "ip-mac")?.patterns);
    expect(ipMac?.patterns.some((p) => p.length > 200)).toBe(true);
    expect(compileKeywordRules(normalized)).toHaveLength(7);
  });

  it("主机规则：空/非法 = 无主机规则，不回落内置", () => {
    expect(normalizeHostKeywordHighlightRules(null)).toEqual([]);
    expect(normalizeHostKeywordHighlightRules([])).toEqual([]);
    expect(
      normalizeHostKeywordHighlightRules([
        { id: "x", label: "X", patterns: ["("], color: "red", enabled: true },
      ]),
    ).toEqual([]);
    expect(
      normalizeHostKeywordHighlightRules([
        { id: "cover", label: "Cover", patterns: ["COVERED"], color: "#ff00aa", enabled: true },
      ]),
    ).toEqual([
      { id: "cover", label: "Cover", patterns: ["COVERED"], color: "#FF00AA", enabled: true },
    ]);
  });
});

describe("mergeKeywordHighlightRules（全局 + 主机，Netcatty 追加语义）", () => {
  const global = rule("error", "#F87171", ["\\berror\\b"]);
  const host = rule("cover", "#FF00AA", ["COVERED"]);

  it("两开关都关 = 不启用、无规则", () => {
    expect(mergeKeywordHighlightRules([global], false, [host], false)).toEqual({
      enabled: false,
      rules: [],
    });
  });

  it("开关打开但无规则时规则为空", () => {
    expect(mergeKeywordHighlightRules([], false, [], true)).toEqual({
      enabled: true,
      rules: [],
    });
  });

  it("主机规则追加在全局之后，不替换全局", () => {
    const merged = mergeKeywordHighlightRules([global], true, [host], true);
    expect(merged.enabled).toBe(true);
    expect(merged.rules.map((r) => r.id)).toEqual(["error", "cover"]);
  });

  it("断开（主机关闭）回落全局；全局关闭时断开后完全不点亮", () => {
    expect(
      mergeKeywordHighlightRules([global], true, [host], false).rules.map((r) => r.id),
    ).toEqual(["error"]);
    expect(mergeKeywordHighlightRules([global], false, [host], false).enabled).toBe(false);
  });

  it("同输出在「全局主机」与「覆盖主机」命中不同规则", () => {
    const text = "error: COVERED";
    const globalOnly = compileKeywordRules(
      mergeKeywordHighlightRules([global], true, [host], false).rules,
    );
    const covered = compileKeywordRules(
      mergeKeywordHighlightRules([global], true, [host], true).rules,
    );
    expect(findKeywordSpans(text, globalOnly).map((s) => s.ruleId)).toEqual(["error"]);
    expect(findKeywordSpans(text, covered).map((s) => s.ruleId)).toEqual([
      "error",
      "cover",
    ]);
  });
});

describe("resolveKeywordHighlightRuntime（工具栏规则 vs 设置页全局规则）", () => {
  const globalRule = rule("global-a", "#F87171", ["GLOBAL_A"]);
  const toolbarRule = rule("toolbar-b", "#22D3EE", ["TOOLBAR_B"]);

  it("着色 = 全局 + 工具栏追加；过滤 = 只有工具栏规则", () => {
    const runtime = resolveKeywordHighlightRuntime([globalRule], true, [toolbarRule], true);
    expect(runtime.colorEnabled).toBe(true);
    expect(runtime.colorRules.map((r) => r.id)).toEqual(["global-a", "toolbar-b"]);
    expect(runtime.filterRules.map((r) => r.id)).toEqual(["toolbar-b"]);
  });

  it("开过滤时只保留命中工具栏规则的行（全局规则不参与过滤）", () => {
    const runtime = resolveKeywordHighlightRuntime([globalRule], true, [toolbarRule], true);
    const compiled = compileKeywordRules(runtime.filterRules);
    expect(findKeywordSpans("only GLOBAL_A here", compiled)).toHaveLength(0);
    expect(findKeywordSpans("has TOOLBAR_B here", compiled).map((s) => s.ruleId)).toEqual([
      "toolbar-b",
    ]);
  });

  it("工具栏规则关闭时不过滤也不着色，仅保留全局着色", () => {
    const runtime = resolveKeywordHighlightRuntime([globalRule], true, [toolbarRule], false);
    expect(runtime.colorRules.map((r) => r.id)).toEqual(["global-a"]);
    expect(runtime.filterRules).toEqual([]);
  });

  it("全局关闭时工具栏规则仍可着色并过滤", () => {
    const runtime = resolveKeywordHighlightRuntime([globalRule], false, [toolbarRule], true);
    expect(runtime.colorEnabled).toBe(true);
    expect(runtime.colorRules.map((r) => r.id)).toEqual(["toolbar-b"]);
    expect(runtime.filterRules.map((r) => r.id)).toEqual(["toolbar-b"]);
  });
});

describe("validateKeywordRuleDraft（编辑保存前校验）", () => {
  it("合法草稿返回 null", () => {
    expect(validateKeywordRuleDraft("WarnX", ["\\bwarnx\\b", "caution"])).toBeNull();
  });

  it("名称为空或全空白时拒绝", () => {
    expect(validateKeywordRuleDraft("", ["x"])).toBe("名称不能为空");
    expect(validateKeywordRuleDraft("   ", ["x"])).toBe("名称不能为空");
  });

  it("没有匹配内容时拒绝", () => {
    expect(validateKeywordRuleDraft("WarnX", [])).toBe("至少需要一条匹配内容");
  });

  it("非法正则报出具体条目，且不放过任何一条", () => {
    expect(validateKeywordRuleDraft("WarnX", ["[broken"])).toBe("无效的正则表达式：[broken");
    expect(validateKeywordRuleDraft("WarnX", ["ok", "("])).toBe("无效的正则表达式：(");
  });
});
