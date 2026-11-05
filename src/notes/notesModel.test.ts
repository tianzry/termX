import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../backend/client";
import {
  collectNoteTags,
  createNoteSaveQueue,
  draftToNote,
  extractNoteOutline,
  filterNotes,
  matchesNoteSearch,
  noteSummary,
  parseTagInput,
  sortNotes,
  toNoteDraft,
  buildNoteTreeRows,
  collectNoteGroups,
  parentNoteGroup,
} from "./notesModel";

function note(partial: Partial<Note>): Note {
  return {
    id: "n1",
    title: "",
    content: "",
    group: null,
    tags: [],
    linked_host_ids: [],
    created_at: 1,
    updated_at: 1,
    order: null,
    is_pinned: false,
    ...partial,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("笔记树派生", () => {
  const notes = [
    note({ id: "root", title: "根笔记", group: null }),
    note({ id: "db", title: "数据库", group: "ops/db" }),
    note({ id: "web", title: "Web", group: "ops/web" }),
    note({ id: "ops", title: "总览", group: "ops" }),
  ];

  it("父级路径与分组集合", () => {
    expect(parentNoteGroup("ops/db")).toBe("ops");
    expect(parentNoteGroup("ops")).toBe("");
    expect(collectNoteGroups(notes)).toEqual(["ops", "ops/db", "ops/web"]);
  });

  it("折叠时只输出根分组与根笔记，且计数含子树", () => {
    const rows = buildNoteTreeRows(notes, new Set());
    expect(rows.map((r) => (r.type === "group" ? `g:${r.path}:${r.count}` : `n:${r.note!.id}`)).sort()).toEqual(
      ["g:ops:3", "n:root"].sort(),
    );
  });

  it("展开后按层级输出子分组与笔记", () => {
    const rows = buildNoteTreeRows(notes, ["ops", "ops/db"]);
    expect(rows.map((r) => (r.type === "group" ? `g:${r.path}` : `n:${r.note!.id}`))).toEqual([
      "g:ops",
      "g:ops/db",
      "n:db",
      "g:ops/web",
      "n:ops",
      "n:root",
    ]);
  });

  it("搜索时扁平返回命中笔记", () => {
    const rows = buildNoteTreeRows(notes, new Set(["ops"]), "数据库");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("note");
    expect(rows[0].note!.id).toBe("db");
  });
});

describe("notesModel", () => {
  it("搜索覆盖标题 / 正文 / 分组 / 标签", () => {
    const n = note({
      title: "数据库巡检",
      content: "check pg replication",
      group: "ops/db",
      tags: ["postgres"],
    });
    expect(matchesNoteSearch(n, "")).toBe(true);
    expect(matchesNoteSearch(n, "巡检")).toBe(true);
    expect(matchesNoteSearch(n, "PG")).toBe(true);
    expect(matchesNoteSearch(n, "ops/db")).toBe(true);
    expect(matchesNoteSearch(n, "postgres")).toBe(true);
    expect(matchesNoteSearch(n, "nope")).toBe(false);
  });

  it("筛选：搜索 + 标签精确匹配（大小写不敏感）", () => {
    const a = note({ id: "a", title: "A", tags: ["SSH"], updated_at: 10 });
    const b = note({ id: "b", title: "B", tags: ["db"], updated_at: 20 });
    expect(filterNotes([a, b], { query: "", tag: "ssh" }).map((n) => n.id)).toEqual([
      "a",
    ]);
    expect(filterNotes([a, b], { query: "A", tag: "" }).map((n) => n.id)).toEqual([
      "a",
    ]);
  });

  it("排序：置顶优先，其次更新时间倒序", () => {
    const list = [
      note({ id: "a", updated_at: 100 }),
      note({ id: "b", updated_at: 50, is_pinned: true }),
      note({ id: "c", updated_at: 300 }),
    ];
    expect(sortNotes(list).map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("标签汇总去重并保留首次写法", () => {
    expect(
      collectNoteTags([
        note({ tags: ["ssh", "DB"] }),
        note({ id: "n2", tags: ["SSH", "ops"] }),
      ]),
    ).toEqual(["DB", "ops", "ssh"]);
  });

  it("标签输入拆分与去重", () => {
    expect(parseTagInput("ssh, db   ssh，ops")).toEqual(["ssh", "db", "ops"]);
    expect(parseTagInput("  ,  ")).toEqual([]);
  });

  it("摘要压平空白并截断", () => {
    expect(noteSummary("# 标题\n\n- 第一行\n- 第二行")).toBe("标题 第一行 第二行");
    expect(noteSummary("abcdef", 3)).toBe("abc…");
  });

  it("草稿转换保留 group / order / linked_host_ids", () => {
    const base = note({ group: "ops/db", order: 3, linked_host_ids: ["h1"] });
    const draft = toNoteDraft(base);
    expect(draft.tagsText).toBe("");
    const next = draftToNote(
      { ...draft, title: "改", content: "body", tagsText: "a, b", updatedAt: 99 },
      base,
    );
    expect(next).toMatchObject({
      title: "改",
      content: "body",
      tags: ["a", "b"],
      group: "ops/db",
      order: 3,
      linked_host_ids: ["h1"],
      updated_at: 99,
    });
  });

  it("保存队列：合并写只落最后一次，dirty 状态随 flush 复位", async () => {
    vi.useFakeTimers();
    const saved: Note[] = [];
    const queue = createNoteSaveQueue(async (n) => {
      saved.push(n);
    }, 600);

    queue.schedule(note({ id: "n1", title: "v1" }));
    queue.schedule(note({ id: "n1", title: "v2" }));
    expect(queue.isDirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(saved.map((n) => n.title)).toEqual(["v2"]);
    expect(queue.isDirty()).toBe(false);
  });

  it("保存队列：flush 立即落盘，cancel 丢弃待存", async () => {
    vi.useFakeTimers();
    const saved: Note[] = [];
    const queue = createNoteSaveQueue(async (n) => {
      saved.push(n);
    }, 600);
    queue.schedule(note({ title: "pending" }));
    await queue.flush();
    expect(saved.map((n) => n.title)).toEqual(["pending"]);
    expect(queue.isDirty()).toBe(false);

    queue.schedule(note({ title: "discard" }));
    queue.cancel();
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(1);
  });

  it("保存队列：不同笔记分槽，互不覆盖", async () => {
    vi.useFakeTimers();
    const saved: string[] = [];
    const queue = createNoteSaveQueue(async (n) => {
      saved.push(`${n.id}:${n.title}`);
    }, 600);
    queue.schedule(note({ id: "n1", title: "rename" }));
    queue.schedule(note({ id: "n2", title: "typing" }));
    await vi.advanceTimersByTimeAsync(600);
    expect(saved.sort()).toEqual(["n1:rename", "n2:typing"]);
  });

  it("保存队列：写失败保留待存，下一次 flush 重试", async () => {
    vi.useFakeTimers();
    let fail = true;
    const saved: string[] = [];
    const errors: unknown[] = [];
    const queue = createNoteSaveQueue(
      async (n) => {
        if (fail) throw new Error("disk full");
        saved.push(n.title);
      },
      600,
      (e) => errors.push(e),
    );
    queue.schedule(note({ title: "must-not-lost" }));
    await queue.flush();
    expect(saved).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(queue.isDirty()).toBe(true);

    fail = false;
    await queue.flush();
    expect(saved).toEqual(["must-not-lost"]);
    expect(queue.isDirty()).toBe(false);
  });
});

describe("extractNoteOutline", () => {
  it("提取各级标题与行号，忽略非标题行", () => {
    const outline = extractNoteOutline("# 顶部\n正文\n## 二级\n### 三级 ###");
    expect(outline).toEqual([
      { level: 1, text: "顶部", line: 0 },
      { level: 2, text: "二级", line: 2 },
      { level: 3, text: "三级", line: 3 },
    ]);
  });

  it("跳过围栏代码块中的 # 行", () => {
    const outline = extractNoteOutline("# A\n```\n# 注释\n```\n## B");
    expect(outline.map((item) => item.text)).toEqual(["A", "B"]);
  });

  it("空内容与纯 # 返回空数组", () => {
    expect(extractNoteOutline("")).toEqual([]);
    expect(extractNoteOutline("#\n##")).toEqual([]);
  });
});
