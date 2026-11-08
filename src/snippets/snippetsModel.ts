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

// ── 多行发送方式（对照 Netcatty multiLineRunMode / AUTO_RUN_SNIPPET_LINE_DELAY_MS）──

export type MultiLineRunMode = "paste" | "lineDelay";

/** 逐行发送时每行间隔，对齐 Netcatty terminalHelpers.ts 的 250ms。 */
export const SNIPPET_LINE_DELAY_MS = 250;

/** 归一化为 "\n"（对照 Netcatty lib/utils.ts normalizeLineEndings）。 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 非法 / 空值回落到默认 paste。 */
export function resolveMultiLineRunMode(raw: string | undefined | null): MultiLineRunMode {
  return raw === "lineDelay" ? "lineDelay" : "paste";
}

/** 片段是否按脚本处理（对齐 Netcatty isScriptSnippet）。 */
export function isScriptSnippet(s: Pick<Snippet, "kind">): boolean {
  return s.kind === "script";
}

/** JavaScript 脚本（新 Worker 运行时）；空 / shell 保持旧 `#@` 文本路径。 */
export function isJavaScriptSnippet(
  s: Pick<Snippet, "kind" | "language">,
): boolean {
  return isScriptSnippet(s) && (s.language || "") === "javascript";
}

export type ScriptTrigger = "manual" | "onConnect" | "onOutput";

/** 触发方式归一化（对齐 Netcatty trigger；空 / 未知 = manual）。 */
export function resolveScriptTrigger(raw: string | undefined | null): ScriptTrigger {
  return raw === "onConnect" || raw === "onOutput" ? raw : "manual";
}

/**
 * 触发方式行内说明。阶段 B 已在渲染层实现 onConnect / onOutput：
 * 连接建立后按目标主机执行、输出匹配正则后触发（同一会话只触发一次）。
 */
export function scriptTriggerNote(raw: string | undefined | null): string {
  const trigger = resolveScriptTrigger(raw);
  if (trigger === "onConnect") {
    return "连接建立后自动执行（仅 SSH 会话）：勾选目标主机或「所有主机」后生效。";
  }
  if (trigger === "onOutput") {
    return "终端输出匹配该正则时自动执行；同一会话同一脚本只触发一次。";
  }
  return "手动运行：在脚本页选中活动终端后点「运行」。";
}

export interface SnippetWritePlan {
  /** 依次写入终端的片段（每段之间间隔 delayMs）。 */
  chunks: string[];
  /** 0 = 一次性连续写入。 */
  delayMs: number;
}

/**
 * 计算写入计划，语义对齐 Netcatty shouldDelayAutoRunSnippetInput：
 * - noAutoRun：原样插入，不追加回车、不逐行（无论模式）；
 * - paste（默认）：整段一次写入，末尾一个回车；
 * - lineDelay：仅当「自动执行 + 去掉末尾回车后仍有多行」时逐行发送，每行一个回车。
 */
export function snippetWritePlan(
  command: string,
  noAutoRun: boolean,
  rawMode?: string | null,
): SnippetWritePlan {
  const text = normalizeLineEndings(command).replace(/\n/g, "\r");
  if (noAutoRun) return { chunks: [text], delayMs: 0 };
  if (resolveMultiLineRunMode(rawMode) === "paste") {
    return { chunks: [`${text}\r`], delayMs: 0 };
  }
  const body = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (!body.includes("\r")) return { chunks: [`${body}\r`], delayMs: 0 };
  return { chunks: body.split("\r").map((line) => `${line}\r`), delayMs: SNIPPET_LINE_DELAY_MS };
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

/** 快捷键冲突检测（排除自身）；命中返回冲突片段，否则 null。对齐 Netcatty shortkey 冲突校验。 */
export function findShortkeyConflict(
  snippets: Snippet[],
  shortkey: string,
  selfId?: string,
): Snippet | null {
  const binding = parseShortkey(shortkey);
  if (!binding) return null;
  for (const s of snippets) {
    if (s.id === selfId || !s.shortkey) continue;
    const other = parseShortkey(s.shortkey);
    if (
      other &&
      other.ctrl === binding.ctrl &&
      other.shift === binding.shift &&
      other.alt === binding.alt &&
      other.meta === binding.meta &&
      other.key === binding.key
    ) {
      return s;
    }
  }
  return null;
}

/** 重命名分组并级联子分组（ops → prod 时 ops/db → prod/db）；空名或同名不处理。 */
export function renameSnippetPackage(
  snippets: Snippet[],
  from: string,
  to: string,
): Snippet[] {
  const fromPath = from.trim();
  const toPath = to.trim();
  if (!fromPath || !toPath || fromPath === toPath) return snippets;
  return snippets.map((s) => {
    const pkg = (s.package || "").trim();
    if (pkg === fromPath) return { ...s, package: toPath };
    if (pkg.startsWith(`${fromPath}/`)) {
      return { ...s, package: toPath + pkg.slice(fromPath.length) };
    }
    return s;
  });
}

/** 删除分组（含子分组）及其下全部片段。 */
export function deleteSnippetPackage(snippets: Snippet[], pkg: string): Snippet[] {
  const path = pkg.trim();
  if (!path) return snippets;
  return snippets.filter((s) => {
    const p = (s.package || "").trim();
    return !(p === path || p.startsWith(`${path}/`));
  });
}

// ── 列表 / 分组树 / 排序（对照 Netcatty SnippetsManager 与 ScriptsSidePanel）──

/** 单行命令预览：折叠所有空白（对齐 Netcatty flattenSnippetCommandPreview）。 */
export function flattenSnippetCommandPreview(command: string): string {
  return String(command ?? "").replace(/\s+/g, " ").trim();
}

export type SnippetSortMode = "manual" | "az" | "za" | "newest" | "oldest" | "group";

export const SNIPPET_SORT_LABELS: Record<SnippetSortMode, string> = {
  manual: "手动顺序",
  az: "名称 A→Z",
  za: "名称 Z→A",
  newest: "最近添加",
  oldest: "最早添加",
  group: "按分组",
};

/**
 * 排序。termX 的 Snippet 没有时间戳字段：newest / oldest 用数组顺序近似
 * （新增条目追加在末尾，故 newest = 反序），与 Netcatty 的 updatedAt 排序语义
 * 在「只增不改」场景一致。
 */
export function sortSnippets(list: Snippet[], mode: SnippetSortMode): Snippet[] {
  const items = [...list];
  switch (mode) {
    case "az":
      return items.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    case "za":
      return items.sort((a, b) => b.name.localeCompare(a.name, "zh-CN"));
    case "newest":
      return items.reverse();
    case "oldest":
      return items;
    case "group":
      return items.sort(
        (a, b) =>
          (a.package || "").localeCompare(b.package || "", "zh-CN") ||
          a.name.localeCompare(b.name, "zh-CN"),
      );
    default:
      return items;
  }
}

export interface SnippetPackageNode {
  /** 完整路径，如 "ops/db"。 */
  path: string;
  /** 末级名称，如 "db"。 */
  name: string;
  /** 含子分组在内的条目总数。 */
  count: number;
  depth: number;
}

/**
 * 由条目的 package 路径派生出全部目录节点（含隐式父级），按路径升序。
 * 父节点 count 累加子树条目（踩坑 163）。
 */
export function buildSnippetPackageTree(list: Snippet[]): SnippetPackageNode[] {
  const counts = new Map<string, number>();
  for (const s of list) {
    const path = (s.package || "").trim();
    if (!path) continue;
    const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
    .map(([path, count]) => {
      const parts = path.split("/");
      return { path, name: parts[parts.length - 1], count, depth: parts.length - 1 };
    });
}

/** 面包屑：`ops/db` → [{name:"ops",path:"ops"},{name:"db",path:"ops/db"}]。 */
export function snippetBreadcrumb(path: string): { name: string; path: string }[] {
  const parts = (path || "").split("/").map((p) => p.trim()).filter(Boolean);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }));
}

// ── {{变量}} 占位符（对照 Netcatty domain/snippetVariables.ts）──

export interface SnippetVariable {
  name: string;
  defaultValue?: string;
}

const VARIABLE_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}\}/g;

/** 解析命令里的 `{{name}}` / `{{name:默认值}}`，按首次出现去重。 */
export function parseSnippetVariables(command: string): SnippetVariable[] {
  const seen = new Set<string>();
  const result: SnippetVariable[] = [];
  for (const match of String(command ?? "").matchAll(VARIABLE_RE)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(match[2] !== undefined ? { name, defaultValue: match[2] } : { name });
  }
  return result;
}

/** 用给定值替换变量；缺值且有默认值时用默认值，否则保留占位符。 */
export function previewSnippetCommand(
  command: string,
  values: Record<string, string>,
): string {
  const defs = parseSnippetVariables(command);
  if (defs.length === 0) return String(command ?? "");
  return String(command ?? "").replace(VARIABLE_RE, (token, rawName: string) => {
    const name = rawName;
    const value = values[name];
    if (value !== undefined && value.trim() !== "") return value;
    const def = defs.find((d) => d.name === name);
    return def?.defaultValue !== undefined ? def.defaultValue : token;
  });
}

// ── 快捷键录制（对照 Netcatty keyEventToString）──

export interface RecordableKeyEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * 把键盘事件转成 termX 的快捷键字符串（"Ctrl + Shift + F1"）。
 * 纯修饰键返回 null（继续录制）；主键字母大写、命名键保留。
 */
export function formatShortkeyEvent(ev: RecordableKeyEvent): string | null {
  const key = ev.key;
  if (!key || ["Control", "Shift", "Alt", "Meta", "OS"].includes(key)) return null;
  if (key === "Escape") return null;
  const mods: string[] = [];
  if (ev.ctrlKey) mods.push("Ctrl");
  if (ev.shiftKey) mods.push("Shift");
  if (ev.altKey) mods.push("Alt");
  if (ev.metaKey) mods.push("Meta");
  const main =
    key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  return [...mods, main].join(" + ");
}
