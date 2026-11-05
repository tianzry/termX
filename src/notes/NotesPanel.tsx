/**
 * SSH 终端右侧笔记面板（#205）。
 *
 * 对照 Netcatty `components/notes/NotesManager.tsx` 的 sidebar 模式：
 * 侧栏只放「搜索 + 笔记列表」，点开某条后在同一面板内进入编辑（覆盖列表），
 * 编辑保存与 Vault 的笔记页共用 `src/notes/notesModel.ts` 与 `save_note` 接口，
 * `ssh://` / `telnet://` 链接复用笔记本里的匹配逻辑打开会话。
 */

import { useEffect, useRef, useState } from "react";
import * as api from "../backend/client";
import type { Note, Profile } from "../backend/client";
import { Icon } from "../ui/icons";
import { MarkdownPreview } from "./MarkdownPreview";
import {
  createNoteSaveQueue,
  draftToNote,
  filterNotes,
  findProfileForHostLink,
  noteSummary,
  sortNotes,
  toNoteDraft,
  type NoteDraft,
  type NoteSaveQueue,
} from "./notesModel";
import "./notes.css";

interface Props {
  profiles: Profile[];
  onOpenHost: (profile: Profile) => void;
}

function createNoteRecord(): Note {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "无标题笔记",
    content: "",
    group: null,
    tags: [],
    linked_host_ids: [],
    created_at: now,
    updated_at: now,
    order: null,
    is_pinned: false,
  };
}

export function NotesPanel({ profiles, onOpenHost }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Note | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [preview, setPreview] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<Note | null>(null);
  const queueRef = useRef<NoteSaveQueue | null>(null);

  if (!queueRef.current) {
    queueRef.current = createNoteSaveQueue(
      async (note) => {
        await api.saveNote(note);
        setNotes((prev) => {
          const index = prev.findIndex((item) => item.id === note.id);
          if (index < 0) return [...prev, note];
          const next = [...prev];
          next[index] = note;
          return next;
        });
        if (activeRef.current?.id === note.id) activeRef.current = note;
        setSavedAt(Date.now());
        setError(null);
      },
      500,
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  }

  useEffect(() => {
    let alive = true;
    void api
      .listNotes()
      .then((list) => {
        if (alive) setNotes(list);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      // 卸载前落盘，避免切换标签/关闭面板丢内容。
      void queueRef.current?.flush();
    };
  }, []);

  function openNote(note: Note) {
    void queueRef.current?.flush();
    activeRef.current = note;
    setActive(note);
    setDraft(toNoteDraft(note));
    setPreview(false);
    setSavedAt(note.updated_at);
    setError(null);
  }

  function backToList() {
    void queueRef.current?.flush();
    activeRef.current = null;
    setActive(null);
    setDraft(null);
    setPreview(false);
  }

  async function newNote() {
    await queueRef.current?.flush();
    const note = createNoteRecord();
    try {
      await api.saveNote(note);
      setNotes((prev) => sortNotes([...prev, note]));
      openNote(note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeNote() {
    if (!active) return;
    queueRef.current?.cancel();
    try {
      await api.deleteNote(active.id);
      setNotes((prev) => prev.filter((item) => item.id !== active.id));
      backToList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function patchDraft(patch: Partial<NoteDraft>) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch, updatedAt: Date.now() };
      const base = activeRef.current;
      if (base) {
        const record = draftToNote(next, base);
        activeRef.current = record;
        queueRef.current?.schedule(record);
      }
      return next;
    });
  }

  const filtered = filterNotes(notes, { query, tag: "" });

  if (active && draft) {
    return (
      <div className="notes-panel is-editor">
        <div className="notes-panel-toolbar">
          <button
            type="button"
            className="notes-panel-icon-btn"
            title="返回笔记列表"
            onClick={backToList}
          >
            <Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} />
          </button>
          <span className="notes-panel-title">编辑笔记</span>
          <span className="notes-panel-spacer" />
          <button
            type="button"
            className="notes-panel-icon-btn"
            title={preview ? "返回编辑" : "预览 Markdown"}
            aria-pressed={preview}
            onClick={() => setPreview((v) => !v)}
          >
            <Icon name="eye" size={14} />
          </button>
          <button
            type="button"
            className="notes-panel-icon-btn is-danger"
            title="删除这条笔记"
            onClick={() => void removeNote()}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
        <input
          className="notes-panel-title-input"
          value={draft.title}
          placeholder="笔记标题"
          onChange={(event) => patchDraft({ title: event.target.value })}
        />
        {preview ? (
          <div className="notes-panel-preview">
            <MarkdownPreview
              content={draft.content}
              onOpenHostHref={(href) => {
                const profile = findProfileForHostLink(profiles, href);
                if (profile) onOpenHost(profile);
                else setError(`未找到匹配主机：${href}`);
              }}
            />
          </div>
        ) : (
          <textarea
            className="notes-panel-editor"
            value={draft.content}
            placeholder="写点什么…（支持 Markdown，ssh:// 链接可在预览中打开会话）"
            spellCheck={false}
            onChange={(event) => patchDraft({ content: event.target.value })}
          />
        )}
        <div className="notes-panel-footer">
          {error ? (
            <span className="notes-panel-error">{error}</span>
          ) : savedAt ? (
            <span>已保存 · {new Date(savedAt).toLocaleTimeString()}</span>
          ) : (
            <span>尚未保存</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="notes-panel">
      <div className="notes-panel-toolbar">
        <input
          className="notes-panel-search"
          value={query}
          placeholder="搜索笔记"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="notes-panel-icon-btn"
          title="新建笔记"
          onClick={() => void newNote()}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {error && <div className="notes-panel-error-banner">{error}</div>}
      <div className="notes-panel-list">
        {loading && <div className="notes-panel-empty">加载中…</div>}
        {!loading && filtered.length === 0 && (
          <div className="notes-panel-empty">
            {query ? "没有匹配的笔记" : "还没有笔记，点 + 新建"}
          </div>
        )}
        {filtered.map((note) => (
          <button
            key={note.id}
            type="button"
            className="notes-panel-row"
            onClick={() => openNote(note)}
          >
            <span className="notes-panel-row-icon">
              <Icon name="file-text" size={16} />
            </span>
            <span className="notes-panel-row-text">
              <span className="notes-panel-row-title">
                {note.is_pinned && <span className="notes-panel-pin">置顶</span>}
                {note.title || "无标题笔记"}
              </span>
              <span className="notes-panel-row-sub">
                {noteSummary(note.content, 60) || note.group || "空笔记"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
