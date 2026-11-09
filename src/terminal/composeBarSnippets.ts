/**
 * 撰写栏顶部「快捷片段条」纯逻辑（对照 Netcatty
 * `components/terminal/TerminalComposeBar.tsx` + `composeBarHelpers.ts`）。
 *
 * Netcatty 行为基线：
 * - 顶栏高 30px，左侧横向滚动展示已固定片段 chips（label 10px 等宽字体，
 *   右侧 9px X 取消固定），右侧 + 按钮打开管理浮层；
 * - 首次使用按 label 排序取前 4 条固定；仓库没有片段时用内置 4 条
 *   （ls -la / df -h / free -h / pwd）；
 * - 普通点击把命令**追加**到草稿末尾（草稿非空且不以换行结尾时先补一个换行），
 *   光标落在末尾；Shift+点击直接发送执行；
 * - 管理浮层：标题 + 搜索（匹配 label/command/package）、可滚动列表、
 *   点击行切换固定状态、底部“已固定 n 个片段”；无键盘上下/回车导航。
 *
 * 无 React、无副作用；单测见 composeBarSnippets.test.ts。
 */
import type { Snippet } from "../backend/client";

export const COMPOSE_SNIPPET_STRIP_HEIGHT = 30;
export const COMPOSE_SNIPPET_MAX_WIDTH = 168;
export const COMPOSE_DEFAULT_SEED_COUNT = 4;
export const COMPOSE_PINNED_STORAGE_KEY = "termx.composeBar.pinnedSnippets.v1";

/** 仓库没有片段时展示的内置快捷命令（与 Netcatty 完全一致）。 */
export const COMPOSE_BUILTIN_SNIPPETS: Snippet[] = [
  {
    id: "__compose_builtin_ls",
    name: "ls -la",
    command: "ls -la",
    description: "",
    package: "",
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "snippet",
    multi_line_run_mode: "paste",
    language: "",
    trigger: "manual",
    trigger_pattern: "",
  },
  {
    id: "__compose_builtin_df",
    name: "df -h",
    command: "df -h",
    description: "",
    package: "",
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "snippet",
    multi_line_run_mode: "paste",
    language: "",
    trigger: "manual",
    trigger_pattern: "",
  },
  {
    id: "__compose_builtin_free",
    name: "free -h",
    command: "free -h",
    description: "",
    package: "",
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "snippet",
    multi_line_run_mode: "paste",
    language: "",
    trigger: "manual",
    trigger_pattern: "",
  },
  {
    id: "__compose_builtin_pwd",
    name: "pwd",
    command: "pwd",
    description: "",
    package: "",
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "snippet",
    multi_line_run_mode: "paste",
    language: "",
    trigger: "manual",
    trigger_pattern: "",
  },
];

export const COMPOSE_BUILTIN_IDS = COMPOSE_BUILTIN_SNIPPETS.map((s) => s.id);

/** 大小写不敏感搜索：命中名称 / 命令 / 分组（与 Netcatty 一致）。 */
export function filterComposeBarSnippets(
  snippets: readonly Snippet[],
  query: string,
): Snippet[] {
  const q = query.trim().toLowerCase();
  const list = q
    ? snippets.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.command.toLowerCase().includes(q) ||
          (s.package ?? "").toLowerCase().includes(q),
      )
    : [...snippets];
  // 固定 zh-CN collation：默认 localeCompare 跟随系统 locale（en-US 下汉字排在拉丁字母之后），
  // 同一份片段在不同机器上顺序会漂移。
  return list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

/** 内置片段 + 仓库片段，按 id 覆盖（同 id 以仓库为准）。 */
export function buildComposeSnippetMap(
  snippets: readonly Snippet[],
): Map<string, Snippet> {
  const map = new Map<string, Snippet>();
  for (const s of COMPOSE_BUILTIN_SNIPPETS) map.set(s.id, s);
  for (const s of snippets) map.set(s.id, s);
  return map;
}

/** 首次使用时的默认固定集合：仓库片段按名称前 4 条，否则内置 4 条。 */
export function resolveComposeDefaultPinned(
  snippets: readonly Snippet[],
): string[] {
  if (snippets.length > 0) {
    return filterComposeBarSnippets(snippets, "")
      .slice(0, COMPOSE_DEFAULT_SEED_COUNT)
      .map((s) => s.id);
  }
  return COMPOSE_BUILTIN_IDS.slice(0, COMPOSE_DEFAULT_SEED_COUNT);
}

/** 解析 localStorage 里的固定 id 列表；非法值回退空数组。 */
export function parsePinnedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** 过滤已删除片段的固定项；内置项始终保留。 */
export function prunePinnedIds(
  ids: readonly string[],
  availableIds: readonly string[],
): string[] {
  const available = new Set(availableIds);
  return ids.filter((id) => COMPOSE_BUILTIN_IDS.includes(id) || available.has(id));
}

/** 切换固定状态（保持原有顺序，新增追加到末尾）。 */
export function togglePinnedId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export interface ComposeInsertion {
  value: string;
  /** 插入后的光标位置（末尾）。 */
  cursor: number;
}

/**
 * 普通点击片段：追加到草稿末尾。
 * 与 Netcatty `insertCommand` 一致——草稿非空且不以换行结尾时先补 `\n`，
 * 不重排/缩进多行命令，光标停在末尾。
 */
export function insertSnippetIntoCompose(
  current: string,
  command: string,
): ComposeInsertion {
  if (!current) return { value: command, cursor: command.length };
  const prefix = current.endsWith("\n") ? "" : "\n";
  const value = `${current}${prefix}${command}`;
  return { value, cursor: value.length };
}
