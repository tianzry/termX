/**
 * Notes 纯逻辑（P0 #37 阶段 A）：搜索、标签筛选、草稿转换、保存防抖。
 *
 * 对照 Netcatty `domain/notes.ts` / `components/notes/NotesManager.tsx`：
 * 搜索覆盖标题 / 正文 / 分组 / 标签；列表置顶优先、其次按更新时间倒序。
 */

import type { Note, Profile } from "../backend/client";

export interface NotesFilter {
  query: string;
  /** 空串 = 全部标签。 */
  tag: string;
  /** 空串 = 全部分组；匹配含子分组（`ops` 命中 `ops/db`）。 */
  group?: string;
}

export function matchesNoteSearch(note: Note, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [note.title, note.content, note.group ?? "", note.tags.join(" ")]
    .join("\n")
    .toLowerCase()
    .includes(needle);
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    return a.title.localeCompare(b.title);
  });
}

export function filterNotes(notes: Note[], filter: NotesFilter): Note[] {
  const tag = filter.tag.trim().toLowerCase();
  const group = (filter.group ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const list = notes.filter((note) => {
    if (!matchesNoteSearch(note, filter.query)) return false;
    if (tag && !note.tags.some((item) => item.toLowerCase() === tag)) return false;
    if (!group) return true;
    const noteGroup = (note.group ?? "").trim().toLowerCase().replace(/\/+$/, "");
    return noteGroup === group || noteGroup.startsWith(`${group}/`);
  });
  return sortNotes(list);
}

/** 汇总分组路径（`ops/db` 同时产出 `ops` 与 `ops/db`），按层级排序。 */
export function collectNoteGroups(notes: Note[]): string[] {
  const seen = new Set<string>();
  for (const note of notes) {
    const path = (note.group ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!path) continue;
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      seen.add(parts.slice(0, i).join("/"));
    }
  }
  return [...seen].sort((a, b) =>
    a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}

// ── 关联主机：对齐 Netcatty 的 `[名称](ssh://user@host:port)` 笔记链接 ──

export interface HostLink {
  username?: string;
  host: string;
  port: number;
}

export function parseHostLinkHref(href: string): HostLink | null {
  if (!/^(ssh|telnet):\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    if (!url.hostname) return null;
    return {
      username: url.username || undefined,
      host: url.hostname,
      port: url.port ? Number(url.port) : href.toLowerCase().startsWith("telnet://") ? 23 : 22,
    };
  } catch {
    return null;
  }
}

/** 按 host/port（有用户名时再比对）找主机档案；找不到返回 null。 */
export function findProfileForHostLink(
  profiles: Profile[],
  href: string,
): Profile | null {
  const target = parseHostLinkHref(href);
  if (!target) return null;
  const host = target.host.trim().toLowerCase();
  const matches = profiles.filter(
    (profile) =>
      (profile.protocol ?? "ssh") === "ssh" &&
      profile.host.trim().toLowerCase() === host &&
      (profile.port || 22) === target.port,
  );
  const byName = target.username
    ? matches.find(
        (profile) => profile.name.trim().toLowerCase() === target.username!.toLowerCase(),
      )
    : undefined;
  return byName ?? matches[0] ?? null;
}

/** 汇总所有标签（大小写不敏感去重，保留首次出现的写法）。 */
export function collectNoteTags(notes: Note[]): string[] {
  const seen = new Map<string, string>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** 标签输入框：逗号 / 中文逗号 / 空白分隔，去重去空。 */
export function parseTagInput(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,，\s]+/)) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** 列表里的一行摘要：压平空白、去掉 Markdown 前缀，截断到 max 字。 */
export function noteSummary(content: string, max = 120): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export interface NoteDraft {
  id: string;
  title: string;
  content: string;
  tagsText: string;
  /** 分组路径，`/` 分隔（对齐 Netcatty 的 folder 树语义）。 */
  groupText: string;
  isPinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export function toNoteDraft(note: Note): NoteDraft {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    tagsText: note.tags.join(", "),
    groupText: note.group ?? "",
    isPinned: note.is_pinned,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  };
}

/** 从草稿生成要入库的 Note；order / linked_host_ids 沿用原值。 */
export function draftToNote(draft: NoteDraft, base: Note): Note {
  const group = draft.groupText.trim().replace(/^\/+|\/+$/g, "");
  return {
    ...base,
    title: draft.title,
    content: draft.content,
    group: group || null,
    tags: parseTagInput(draft.tagsText),
    is_pinned: draft.isPinned,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
  };
}

export interface NoteSaveQueue {
  /** 排入一次保存；后续调用会覆盖上一次的待存内容（合并写）。 */
  schedule(note: Note): void;
  /** 立即落盘（切换到另一条笔记 / 卸载时调用）。 */
  flush(): Promise<void>;
  /** 丢弃待存内容（删除笔记时调用）。 */
  cancel(): void;
  isDirty(): boolean;
}

export function createNoteSaveQueue(
  save: (note: Note) => Promise<void>,
  delay = 600,
  onError?: (error: unknown) => void,
): NoteSaveQueue {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 按 note.id 分槽：不同笔记的待存内容互不覆盖（重命名/移动不会丢）。 */
  const pending = new Map<string, Note>();
  let flushing: Promise<void> | null = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function run() {
    clearTimer();
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    flushing = (async () => {
      for (const note of batch) {
        try {
          await save(note);
        } catch (error) {
          // 失败内容回填（已有更新内容则保留新的），下次 flush 可重试，避免只留在内存。
          if (!pending.has(note.id)) pending.set(note.id, note);
          onError?.(error);
        }
      }
    })().finally(() => {
      flushing = null;
    });
    await flushing;
  }

  return {
    schedule(note) {
      pending.set(note.id, note);
      clearTimer();
      timer = setTimeout(() => void run(), delay);
    },
    async flush() {
      if (flushing) await flushing;
      await run();
    },
    cancel() {
      clearTimer();
      pending.clear();
    },
    isDirty() {
      return pending.size > 0 || flushing !== null;
    },
  };
}

// ── 树的派生（对照 Netcatty NotesManager 的 noteGroups 树）──

export interface NoteTreeRow {
  type: "group" | "note";
  depth: number;
  /** 分组路径（type=group 时有效）。 */
  path?: string;
  /** 分组下的笔记总数（含子分组）。 */
  count?: number;
  note?: Note;
}

/** 父级分组路径；根返回 ""。 */
export function parentNoteGroup(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

/**
 * 派生树的扁平行列表。
 * - 有搜索词：扁平返回命中笔记（对齐 Netcatty 搜索态隐藏分组）；
 * - 无搜索词：分组优先、根笔记随后；仅展开集合中的分组输出子节点；
 * - 分组 count 累加子树笔记（踩坑 163）。
 */
export function buildNoteTreeRows(
  notes: Note[],
  expanded: Set<string> | string[],
  query = "",
): NoteTreeRow[] {
  const expandedSet = expanded instanceof Set ? expanded : new Set(expanded);
  const needle = query.trim();
  if (needle) {
    return sortNotes(notes.filter((n) => matchesNoteSearch(n, needle))).map((note) => ({
      type: "note" as const,
      depth: 0,
      note,
    }));
  }

  const groups = collectNoteGroups(notes);
  const groupOf = (n: Note) => (n.group ?? "").trim().replace(/^\/+|\/+$/g, "");
  const subtreeCount = (path: string) =>
    notes.filter((n) => {
      const g = groupOf(n);
      return g === path || g.startsWith(`${path}/`);
    }).length;

  const rows: NoteTreeRow[] = [];
  const pushChildren = (parent: string, depth: number) => {
    for (const path of groups.filter((g) => parentNoteGroup(g) === parent)) {
      rows.push({ type: "group", depth, path, count: subtreeCount(path) });
      if (expandedSet.has(path)) pushChildren(path, depth + 1);
    }
    const direct = sortNotes(notes.filter((n) => groupOf(n) === parent));
    for (const note of direct) rows.push({ type: "note", depth, note });
  };
  pushChildren("", 0);
  return rows;
}

export interface NoteOutlineItem {
  level: number;
  text: string;
  /** 0 基行号，用于编辑器跳转。 */
  line: number;
}

/** 提取 Markdown 标题大纲（跳过 ``` / ~~~ 围栏代码块）；对齐 Netcatty NoteOutline。 */
export function extractNoteOutline(content: string): NoteOutlineItem[] {
  const items: NoteOutlineItem[] = [];
  let fence: string | null = null;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading && heading[2].trim()) {
      items.push({ level: heading[1].length, text: heading[2].trim(), line: i });
    }
  }
  return items;
}
