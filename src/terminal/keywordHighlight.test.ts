import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYWORD_HIGHLIGHT_RULES,
  normalizeKeywordHighlightRules,
  type KeywordHighlightRule,
} from "../settings/settingsModel";
import { compileKeywordRules, findKeywordSpans } from "./keywordHighlight";

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
});
