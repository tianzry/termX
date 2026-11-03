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
  let pending: Note | null = null;
  let flushing: Promise<void> | null = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function run() {
    clearTimer();
    const note = pending;
    pending = null;
    if (!note) return;
    flushing = save(note)
      .catch((error) => onError?.(error))
      .finally(() => {
        flushing = null;
      });
    await flushing;
  }

  return {
    schedule(note) {
      pending = note;
      clearTimer();
      timer = setTimeout(() => void run(), delay);
    },
    async flush() {
      if (flushing) await flushing;
      await run();
    },
    cancel() {
      clearTimer();
      pending = null;
    },
    isDirty() {
      return pending !== null || flushing !== null;
    },
  };
}
