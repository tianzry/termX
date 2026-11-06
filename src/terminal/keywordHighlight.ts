/**
 * 关键字高亮的纯逻辑：规则编译 + 单行匹配（不含 xterm 渲染）。
 *
 * 语义对齐 Netcatty components/terminal/keywordHighlight.ts：
 * 逐条正则、忽略大小写、同一行内先规则先得（后规则不覆盖已命中的区间）。
 * 渲染侧由 TerminalPane 用 xterm decoration 的 foregroundColor 分段着色。
 */

import type { KeywordHighlightRule } from "../settings/settingsModel";

export interface CompiledKeywordRule {
  id: string;
  color: string;
  patterns: RegExp[];
}

export interface KeywordHighlightSpan {
  start: number;
  end: number;
  color: string;
  ruleId: string;
}

/** 只编译已启用且至少含一条合法正则的规则；非法正则静默跳过（不阻断其余规则）。 */
export function compileKeywordRules(rules: KeywordHighlightRule[]): CompiledKeywordRule[] {
  const compiled: CompiledKeywordRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const patterns: RegExp[] = [];
    for (const source of rule.patterns) {
      try {
        patterns.push(new RegExp(source, "gi"));
      } catch {
        // 用户手工编辑的正则可能非法，忽略该条。
      }
    }
    if (patterns.length > 0) compiled.push({ id: rule.id, color: rule.color, patterns });
  }
  return compiled;
}

/** 单行匹配：返回不重叠区间（先规则先得）。 */
export function findKeywordSpans(text: string, compiled: CompiledKeywordRule[]): KeywordHighlightSpan[] {
  if (!text || compiled.length === 0) return [];
  const spans: KeywordHighlightSpan[] = [];
  for (const rule of compiled) {
    for (const re of rule.patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (end === start) {
          // 零宽匹配：避免死循环，跳到下一字符。
          re.lastIndex += 1;
          continue;
        }
        if (!overlaps(spans, start, end)) {
          spans.push({ start, end, color: rule.color, ruleId: rule.id });
        }
      }
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return spans;
}

function overlaps(spans: KeywordHighlightSpan[], start: number, end: number): boolean {
  for (const span of spans) {
    if (start < span.end && end > span.start) return true;
  }
  return false;
}

/** xterm buffer 行 → 每个字符对应的起始单元格列（宽字符按其显示宽度占位）。 */
export function cellOffsets(line: {
  length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}): number[] {
  const offsets: number[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) continue;
    const chars = cell.getChars();
    if (chars.length === 0) continue;
    for (let i = 0; i < chars.length; i += 1) offsets.push(x);
  }
  return offsets;
}
