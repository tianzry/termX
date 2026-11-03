import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../backend/client";
import {
  collectNoteTags,
  createNoteSaveQueue,
  draftToNote,
  filterNotes,
  matchesNoteSearch,
  noteSummary,
  parseTagInput,
  sortNotes,
  toNoteDraft,
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
});
