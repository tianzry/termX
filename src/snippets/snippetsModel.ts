// Snippets 纯逻辑（P0 #5 阶段 A）：搜索 / 分组 / 快捷键解析 / 插入载荷。
// 无 React、无副作用；单测见 snippetsModel.test.ts。
// 对照 Netcatty：ScriptsSidePanel 搜索（label/command 模糊匹配）、
// Snippet.shortkey（"F1" / "Ctrl + F1"）、noAutoRun（不追加回车）。
import type { Snippet } from "../backend/client";

/** 片段保存后派发；终端窗格监听它刷新列表。 */
export const SNIPPETS_CHANGED_EVENT = "termx:snippets-changed";

/** 大小写不敏感搜索：命中 名称 / 命令 / 描述 / 分组 / 标签 任一。 */
export function filterSnippets(snippets: Snippet[], query: string): Snippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...snippets];
  return snippets.filter((s) =>
    [s.name, s.command, s.description, s.package, ...s.tags].some(
      (h) => h && h.toLowerCase().includes(q),
    ),
  );
}

export interface SnippetGroup {
  /** 空串 = 未分组。 */
  pkg: string;
  items: Snippet[];
}

/** 按 package 分组（字母序），未分组排最后；组内保持原顺序。 */
export function groupSnippets(snippets: Snippet[]): SnippetGroup[] {
  const map = new Map<string, Snippet[]>();
  for (const s of snippets) {
    const key = (s.package || "").trim();
    const arr = map.get(key);
    if (arr) arr.push(s);
    else map.set(key, [s]);
  }
  const named = [...map.keys()]
    .filter((k) => k !== "")
    .sort((a, b) => a.localeCompare(b));
  const groups: SnippetGroup[] = named.map((pkg) => ({ pkg, items: map.get(pkg)! }));
  const ungrouped = map.get("");
  if (ungrouped) groups.push({ pkg: "", items: ungrouped });
  return groups;
}

export interface ShortkeyBinding {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** 归一化小写的主键，如 "f1" / "s" / "enter"。 */
  key: string;
}

export interface KeyEventLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
}

const MODIFIERS: Record<string, "ctrl" | "shift" | "alt" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
};

/**
 * 解析 Netcatty 风格快捷键串（"F1"、"Ctrl + Shift + F1"）。
 * 非法（空 / 只有修饰键 / 未知修饰键 / 中段出现非修饰键）返回 null。
 */
export function parseShortkey(raw: string): ShortkeyBinding | null {
  const parts = raw
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const binding: ShortkeyBinding = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    key: "",
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const mod = MODIFIERS[part];
    if (mod) {
      binding[mod] = true;
      continue;
    }
    if (i !== parts.length - 1) return null;
    binding.key = part;
  }
  if (!binding.key) return null;
  return binding;
}

/** 键盘事件是否命中绑定（修饰键严格一致 + 主键忽略大小写）。 */
export function shortkeyMatches(binding: ShortkeyBinding, ev: KeyEventLike): boolean {
  return (
    binding.ctrl === ev.ctrlKey &&
    binding.shift === ev.shiftKey &&
    binding.alt === ev.altKey &&
    binding.meta === ev.metaKey &&
    binding.key === ev.key.toLowerCase()
  );
}

/** 插入载荷：默认追加回车（\r）自动执行；noAutoRun 时原样插入。 */
export function snippetPayload(command: string, noAutoRun: boolean): string {
  return noAutoRun ? command : `${command}\r`;
}

/** 为缺少 id 的旧数据补稳定 id（并对重复 id 去重）。 */
export function ensureSnippetIds(snippets: Snippet[]): Snippet[] {
  const seen = new Set<string>();
  return snippets.map((s, i) => {
    if (s.id && !seen.has(s.id)) {
      seen.add(s.id);
      return s;
    }
    let id = "";
    do {
      id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `snip-${i}-${Math.random().toString(36).slice(2)}`;
    } while (seen.has(id));
    seen.add(id);
    return { ...s, id };
  });
}
