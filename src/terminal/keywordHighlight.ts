/**
 * 关键字高亮的纯逻辑：规则编译 + 单行匹配（不含 xterm 渲染）。
 *
 * 语义对齐 Netcatty components/terminal/keywordHighlight.ts：
 * 逐条正则、忽略大小写、同一行内先规则先得（后规则不覆盖已命中的区间）。
 * 渲染侧由 TerminalPane 用 xterm decoration 的 foregroundColor 分段着色。
 */

import type { KeywordHighlightRule } from "../settings/settingsModel";

interface CompiledKeywordRule {
  id: string;
  color: string;
  patterns: RegExp[];
}

/**
 * 合并「全局 + 主机」规则（对齐 Netcatty `terminalKeywordHighlightRules.ts`）：
 * 主机规则是**追加**，不是替换；匹配时全局先规则先得，主机规则只补充全局未命中的区间。
 * 总开关 = 全局开 || 主机开（主机断开时由调用方关闭 hostEnabled 以回落全局）。
 */
export function mergeKeywordHighlightRules(
  globalRules: KeywordHighlightRule[],
  globalEnabled: boolean,
  hostRules: KeywordHighlightRule[],
  hostEnabled: boolean,
): { enabled: boolean; rules: KeywordHighlightRule[] } {
  return {
    enabled: globalEnabled || hostEnabled,
    rules: [
      ...(globalEnabled ? globalRules : []),
      ...(hostEnabled ? hostRules : []),
    ],
  };
}

/**
 * 运行时规则来源解析（工具栏浮层语义）：
 * - 着色：全局规则在前，工具栏规则追加在后（主机级 / 会话级按终端类型二选一）；
 * - 过滤：只用工具栏规则，不包含设置页的全局规则。
 * 工具栏规则关闭时既不参与着色，也不参与过滤。
 */
export function resolveKeywordHighlightRuntime(
  globalRules: KeywordHighlightRule[],
  globalEnabled: boolean,
  toolbarRules: KeywordHighlightRule[],
  toolbarEnabled: boolean,
): {
  colorEnabled: boolean;
  colorRules: KeywordHighlightRule[];
  filterRules: KeywordHighlightRule[];
} {
  const merged = mergeKeywordHighlightRules(
    globalRules,
    globalEnabled,
    toolbarRules,
    toolbarEnabled,
  );
  return {
    colorEnabled: merged.enabled,
    colorRules: merged.rules,
    filterRules: toolbarEnabled ? toolbarRules : [],
  };
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

/**
 * 规则编辑草稿校验（浮层「保存」前调用）：名称必填、至少一条正则、逐条编译。
 * 返回首条错误文案（直接展示给用户），全部合法返回 null。
 */
export function validateKeywordRuleDraft(label: string, patterns: string[]): string | null {
  if (!label.trim()) return "名称不能为空";
  if (patterns.length === 0) return "至少需要一条匹配内容";
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "gi");
    } catch {
      return `无效的正则表达式：${pattern}`;
    }
  }
  return null;
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
