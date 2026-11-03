// Notes 管理页（P0 #37 阶段 A）。
// 对照 Netcatty `components/notes/NotesManager.tsx`：左侧笔记树（300px）+
// 右侧编辑器；阶段 A 做标题 / 正文 / 标签 / 搜索 / 标签筛选 / 置顶 / 删除，
// 分组文件夹、Markdown 预览、关联主机、导入导出留到阶段 B。
// 正文用等宽 textarea 编辑 Markdown 原文（不引入 Monaco / MDXEditor）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../backend/client";
import type { Note } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { Icon } from "../ui/icons";
import {
  collectNoteTags,
  createNoteSaveQueue,
  draftToNote,
  filterNotes,
  noteSummary,
  toNoteDraft,
} from "./notesModel";
import type { NoteDraft, NoteSaveQueue } from "./notesModel";
import "./notes.css";

function formatTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function NotesView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const activeNoteRef = useRef<Note | null>(null);
  const queueRef = useRef<NoteSaveQueue | null>(null);

  if (!queueRef.current) {
    queueRef.current = createNoteSaveQueue(
      async (note) => {
        await api.saveNote(note);
        setSavedAt(Date.now());
        setDirty(false);
      },
      600,
      (error) => {
        setErr(userVisibleError(String(error)));
        setDirty(true);
      },
    );
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .listNotes()
      .then((list) => {
        if (!live) return;
        setNotes(list);
        if (list.length > 0) {
          const first = list[0];
          activeNoteRef.current = first;
          setActiveId(first.id);
          setDraft(toNoteDraft(first));
        }
      })
      .catch((e) => live && setErr(userVisibleError(String(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      void queueRef.current?.flush();
    };
  }, []);

  const openNote = useCallback((note: Note) => {
    void queueRef.current?.flush();
    activeNoteRef.current = note;
    setActiveId(note.id);
    setDraft(toNoteDraft(note));
    setDirty(false);
    setSavedAt(null);
    setErr("");
    setNotice("");
  }, []);

  const patchDraft = useCallback((patch: Partial<NoteDraft>) => {
    const base = activeNoteRef.current;
    if (!base) return;
    const now = Date.now();
    setDraft((cur) => {
      if (!cur) return cur;
      const next: NoteDraft = { ...cur, ...patch, updatedAt: now };
      const note = draftToNote(next, activeNoteRef.current ?? base);
      activeNoteRef.current = note;
      setNotes((prev) =>
        prev.map((item) => (item.id === note.id ? note : item)),
      );
      queueRef.current?.schedule(note);
      return next;
    });
    setDirty(true);
    setErr("");
  }, []);

  const newNote = useCallback(async () => {
    await queueRef.current?.flush();
    const now = Date.now();
    const note: Note = {
      id: crypto.randomUUID(),
      title: "",
      content: "",
      group: null,
      tags: [],
      linked_host_ids: [],
      created_at: now,
      updated_at: now,
      order: null,
      is_pinned: false,
    };
    try {
      await api.saveNote(note);
      setNotes((prev) => [note, ...prev]);
      activeNoteRef.current = note;
      setActiveId(note.id);
      setDraft(toNoteDraft(note));
      setDirty(false);
      setSavedAt(now);
      setNotice("已新建笔记");
      setErr("");
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, []);

  const deleteActive = useCallback(async () => {
    const note = activeNoteRef.current;
    if (!note) return;
    if (!window.confirm(`删除笔记「${note.title.trim() || "未命名笔记"}」？不可恢复。`)) {
      return;
    }
    queueRef.current?.cancel();
    try {
      await api.deleteNote(note.id);
      const rest = notes.filter((item) => item.id !== note.id);
      setNotes(rest);
      const next = rest[0] ?? null;
      activeNoteRef.current = next;
      setActiveId(next?.id ?? null);
      setDraft(next ? toNoteDraft(next) : null);
      setDirty(false);
      setSavedAt(null);
      setNotice("已删除");
      setErr("");
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, [notes]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void queueRef.current?.flush();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const tags = useMemo(() => collectNoteTags(notes), [notes]);
  const visible = useMemo(
    () => filterNotes(notes, { query, tag: tagFilter }),
    [notes, query, tagFilter],
  );

  return (
    <div className="notes-page">
      <aside className="notes-tree">
        <div className="notes-tree-head">
          <span>笔记</span>
          <button
            type="button"
            className="notes-new"
            title="新建笔记"
            onClick={() => void newNote()}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="notes-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索笔记（标题 / 正文 / 标签）"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="notes-clear"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
        {tags.length > 0 && (
          <div className="notes-tagbar">
            <button
              type="button"
              className={`notes-tag-filter${tagFilter ? "" : " active"}`}
              onClick={() => setTagFilter("")}
            >
              全部
            </button>
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`notes-tag-filter${
                  tagFilter.toLowerCase() === tag.toLowerCase() ? " active" : ""
                }`}
                onClick={() => setTagFilter(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
        <div className="notes-list">
          {visible.length === 0 ? (
            <p className="notes-list-empty">
              {loading
                ? "加载中…"
                : notes.length
                  ? "没有匹配的笔记"
                  : "还没有笔记，点右上角 + 新建"}
            </p>
          ) : (
            visible.map((note) => (
              <button
                key={note.id}
                type="button"
                className={`notes-item${note.id === activeId ? " active" : ""}`}
                onClick={() => openNote(note)}
              >
                <span className="notes-item-title">
                  {note.is_pinned && (
                    <Icon name="pin" size={11} className="notes-item-pin" />
                  )}
                  {note.title.trim() || "未命名笔记"}
                </span>
                <span className="notes-item-meta">
                  <span className="notes-item-time">
                    {formatTime(note.updated_at)}
                  </span>
                  {note.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="notes-item-tag">
                      #{tag}
                    </span>
                  ))}
                </span>
                {noteSummary(note.content, 90) && (
                  <span className="notes-item-summary">
                    {noteSummary(note.content, 90)}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="notes-editor">
        {draft ? (
          <>
            <header className="notes-editor-head">
              <input
                className="notes-title"
                value={draft.title}
                onChange={(e) => patchDraft({ title: e.target.value })}
                placeholder="未命名笔记"
                spellCheck={false}
              />
              <span className="notes-status">
                {dirty ? "未保存…" : savedAt ? `已保存 · ${formatTime(savedAt)}` : ""}
              </span>
              <button
                type="button"
                className={`notes-action${draft.isPinned ? " active" : ""}`}
                title={draft.isPinned ? "取消置顶" : "置顶"}
                onClick={() => patchDraft({ isPinned: !draft.isPinned })}
              >
                <Icon name="pin" size={14} />
              </button>
              <button
                type="button"
                className="notes-action notes-danger"
                title="删除笔记"
                onClick={() => void deleteActive()}
              >
                <Icon name="trash" size={14} />
              </button>
            </header>
            <div className="notes-tags-row">
              <Icon name="tag" size={13} />
              <input
                value={draft.tagsText}
                onChange={(e) => patchDraft({ tagsText: e.target.value })}
                placeholder="标签，逗号分隔"
                spellCheck={false}
              />
            </div>
            <textarea
              className="notes-content"
              value={draft.content}
              onChange={(e) => patchDraft({ content: e.target.value })}
              placeholder="正文（Markdown 原文）"
              spellCheck={false}
            />
            {(err || notice) && (
              <p className={`notes-message${err ? " error" : ""}`}>
                {err || notice}
              </p>
            )}
          </>
        ) : (
          <div className="notes-empty">
            <Icon name="file-text" size={28} />
            <p>选择左侧笔记，或点 + 新建一条</p>
          </div>
        )}
      </section>
    </div>
  );
}
