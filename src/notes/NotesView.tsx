// Notes 管理页（P0 #37 阶段 A + B）。
// 对照 Netcatty `components/notes/NotesManager.tsx`：
// 左侧笔记树（300px，分组 / 标签 / 搜索）+ 右侧编辑器。
// 阶段 B：Markdown 预览切换 + 最小格式工具栏（标题/加粗/斜体/列表/引用/代码）、
// 分组路径、导入导出（系统文件对话框）、笔记内 `[名称](ssh://user@host:port)`
// 主机链接点击即开会话（Netcatty 的关联主机做法；不是单独的 hostId 字段）。
// 不引入 MDXEditor / react-markdown：正文仍是等宽 textarea + 自研低依赖预览。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../backend/client";
import type { Credential, Note, Profile } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { Icon } from "../ui/icons";
import { MarkdownPreview } from "./MarkdownPreview";
import {
  applyMarkdownAction,
  buildNoteExportFiles,
  deriveImportedTitle,
  insertMarkdownLink,
  sanitizeNoteFileName,
} from "./markdownModel";
import type { MarkdownAction } from "./markdownModel";
import {
  collectNoteGroups,
  collectNoteTags,
  createNoteSaveQueue,
  draftToNote,
  extractNoteOutline,
  filterNotes,
  findProfileForHostLink,
  noteSummary,
  toNoteDraft,
} from "./notesModel";
import type { NoteDraft, NoteSaveQueue } from "./notesModel";
import "./notes.css";

interface Props {
  profiles?: Profile[];
  credentials?: Credential[];
  /** 打开关联主机会话（由 VaultView 透传 App.connect）。 */
  onOpenHost?: (profile: Profile) => void;
}

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

/** 生成 Netcatty 同款主机深链：`ssh://user@host:port`。 */
function buildHostHref(profile: Profile, credentials: Credential[]): string {
  const credential = credentials.find((item) => item.id === profile.credential_id);
  const username = credential?.username?.trim();
  const host = profile.host.trim();
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = profile.port && profile.port !== 22 ? `:${profile.port}` : "";
  return `ssh://${username ? `${encodeURIComponent(username)}@` : ""}${hostPart}${port}`;
}

const TOOLBAR: { action: MarkdownAction; label: string; title: string }[] = [
  { action: "h1", label: "H1", title: "标题 1" },
  { action: "h2", label: "H2", title: "标题 2" },
  { action: "bold", label: "B", title: "加粗" },
  { action: "italic", label: "I", title: "斜体" },
  { action: "bullet", label: "•", title: "无序列表" },
  { action: "ordered", label: "1.", title: "有序列表" },
  { action: "quote", label: "❝", title: "引用" },
  { action: "code", label: "</>", title: "代码" },
];

export function NotesView({ profiles = [], credentials = [], onOpenHost }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [outlineOn, setOutlineOn] = useState(true);
  const [hostPicker, setHostPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const activeNoteRef = useRef<Note | null>(null);
  const draftRef = useRef<NoteDraft | null>(null);
  const queueRef = useRef<NoteSaveQueue | null>(null);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

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
          draftRef.current = toNoteDraft(first);
          setActiveId(first.id);
          setDraft(draftRef.current);
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
    draftRef.current = toNoteDraft(note);
    setActiveId(note.id);
    setDraft(draftRef.current);
    setDirty(false);
    setSavedAt(null);
    setErr("");
    setNotice("");
    setHostPicker(false);
  }, []);

  /** 草稿同步更新：ref 先行，保证保存/导出立刻读到最新内容（避免少一个字符）。 */
  const patchDraft = useCallback((patch: Partial<NoteDraft>) => {
    const base = activeNoteRef.current;
    const cur = draftRef.current;
    if (!base || !cur) return;
    const next: NoteDraft = { ...cur, ...patch, updatedAt: Date.now() };
    const note = draftToNote(next, base);
    draftRef.current = next;
    activeNoteRef.current = note;
    setDraft(next);
    setNotes((prev) => prev.map((item) => (item.id === note.id ? note : item)));
    queueRef.current?.schedule(note);
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
      group: groupFilter || null,
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
      draftRef.current = toNoteDraft(note);
      setActiveId(note.id);
      setDraft(draftRef.current);
      setDirty(false);
      setSavedAt(now);
      setNotice("已新建笔记");
      setErr("");
      setMode("edit");
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, [groupFilter]);

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
      draftRef.current = next ? toNoteDraft(next) : null;
      setActiveId(next?.id ?? null);
      setDraft(draftRef.current);
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

  const runToolbar = useCallback(
    (action: MarkdownAction) => {
      if (!draft) return;
      const el = contentRef.current;
      const start = el?.selectionStart ?? draft.content.length;
      const end = el?.selectionEnd ?? start;
      const result = applyMarkdownAction(draft.content, start, end, action);
      patchDraft({ content: result.text });
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(result.selectionStart, result.selectionEnd);
      });
    },
    [draft, patchDraft],
  );

  const insertHostLink = useCallback(
    (profile: Profile) => {
      if (!draft) return;
      const el = contentRef.current;
      const start = el?.selectionStart ?? draft.content.length;
      const end = el?.selectionEnd ?? start;
      const result = insertMarkdownLink(
        draft.content,
        start,
        end,
        profile.name || `${profile.host}:${profile.port}`,
        buildHostHref(profile, credentials),
      );
      patchDraft({ content: result.text });
      setHostPicker(false);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(result.selectionStart, result.selectionEnd);
      });
    },
    [credentials, draft, patchDraft],
  );

  const handleHostHref = useCallback(
    (href: string) => {
      const profile = findProfileForHostLink(profiles, href);
      if (!profile) {
        setNotice(`未找到匹配的主机：${href}`);
        return;
      }
      if (!onOpenHost) {
        setNotice("当前页面无法打开会话");
        return;
      }
      void queueRef.current?.flush();
      onOpenHost(profile);
    },
    [onOpenHost, profiles],
  );

  const exportActive = useCallback(async () => {
    const note = activeNoteRef.current;
    if (!note) return;
    await queueRef.current?.flush();
    setBusy(true);
    setErr("");
    try {
      const path = await api.pickNoteExportFile(
        `${sanitizeNoteFileName(note.title, "note")}.md`,
      );
      if (!path) return;
      await api.localWriteFile(
        path,
        new TextEncoder().encode(activeNoteRef.current?.content ?? note.content),
      );
      setNotice("已导出当前笔记");
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }, []);

  const exportAll = useCallback(async () => {
    await queueRef.current?.flush();
    setBusy(true);
    setErr("");
    try {
      const dir = await api.pickNoteExportFolder();
      if (!dir) return;
      const latest = notes.map((item) =>
        item.id === activeNoteRef.current?.id ? activeNoteRef.current : item,
      );
      const files = buildNoteExportFiles(latest);
      for (const file of files) {
        const full = `${dir.replace(/[\\/]+$/, "")}/${file.path}`;
        const parent = full.slice(0, full.lastIndexOf("/"));
        if (parent) await api.localMkdir(parent);
        await api.localWriteFile(full, new TextEncoder().encode(file.content));
      }
      setNotice(`已导出 ${files.length} 条笔记`);
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }, [notes]);

  const importNotes = useCallback(async () => {
    await queueRef.current?.flush();
    setBusy(true);
    setErr("");
    try {
      const files = await api.pickNoteImportFiles();
      if (!files.length) return;
      const created: Note[] = [];
      for (const path of files) {
        const bytes = await api.localReadFile(path);
        const content = api.bytesToText(bytes);
        const now = Date.now();
        const note: Note = {
          id: crypto.randomUUID(),
          title: deriveImportedTitle(path, content),
          content,
          group: groupFilter || null,
          tags: [],
          linked_host_ids: [],
          created_at: now,
          updated_at: now,
          order: null,
          is_pinned: false,
        };
        await api.saveNote(note);
        created.push(note);
      }
      if (created.length) {
        setNotes((prev) => [...created, ...prev]);
        const first = created[0];
        activeNoteRef.current = first;
        draftRef.current = toNoteDraft(first);
        setActiveId(first.id);
        setDraft(draftRef.current);
        setDirty(false);
        setSavedAt(null);
        setNotice(`已导入 ${created.length} 条笔记`);
      }
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }, [groupFilter]);

  const tags = useMemo(() => collectNoteTags(notes), [notes]);
  const groups = useMemo(() => collectNoteGroups(notes), [notes]);
  const visible = useMemo(
    () => filterNotes(notes, { query, tag: tagFilter, group: groupFilter }),
    [notes, query, tagFilter, groupFilter],
  );
  const outline = useMemo(
    () => extractNoteOutline(draft?.content ?? ""),
    [draft?.content],
  );

  const jumpToLine = useCallback(
    (line: number) => {
      if (!draft) return;
      if (mode !== "edit") setMode("edit");
      const el = contentRef.current;
      if (!el) return;
      const index = draft.content
        .split(/\r?\n/)
        .slice(0, line)
        .reduce((sum, text) => sum + text.length + 1, 0);
      el.focus();
      el.setSelectionRange(index, index);
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      el.scrollTop = Math.max(0, line * lineHeight - lineHeight * 2);
    },
    [draft, mode],
  );

  return (
    <div className="notes-page">
      <aside className="notes-tree">
        <div className="notes-tree-head">
          <span>笔记</span>
          <span className="notes-tree-actions">
            <button
              type="button"
              className="notes-new"
              title="导入 Markdown"
              disabled={busy}
              onClick={() => void importNotes()}
            >
              <Icon name="upload" size={14} />
            </button>
            <button
              type="button"
              className="notes-new"
              title="导出全部（目录 + 分组）"
              disabled={busy || notes.length === 0}
              onClick={() => void exportAll()}
            >
              <Icon name="download" size={14} />
            </button>
            <button
              type="button"
              className="notes-new"
              title="新建笔记"
              onClick={() => void newNote()}
            >
              <Icon name="plus" size={14} />
            </button>
          </span>
        </div>
        <div className="notes-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索笔记（标题 / 正文 / 标签 / 主机）"
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
        {groups.length > 0 && (
          <div className="notes-groupbar">
            <button
              type="button"
              className={`notes-group-filter${groupFilter ? "" : " active"}`}
              onClick={() => setGroupFilter("")}
            >
              <Icon name="folder" size={12} />
              全部分组
            </button>
            {groups.map((group) => (
              <button
                key={group}
                type="button"
                className={`notes-group-filter${groupFilter === group ? " active" : ""}`}
                style={{ paddingLeft: 10 + (group.split("/").length - 1) * 12 }}
                onClick={() => setGroupFilter(group)}
              >
                <Icon name="folder" size={12} />
                {group.split("/").pop()}
              </button>
            ))}
          </div>
        )}
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
                  {note.group && (
                    <span className="notes-item-tag">{note.group}</span>
                  )}
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
                {busy ? "处理中…" : dirty ? "未保存…" : savedAt ? `已保存 · ${formatTime(savedAt)}` : ""}
              </span>
              <button
                type="button"
                className="notes-action"
                title="导出当前笔记"
                disabled={busy}
                onClick={() => void exportActive()}
              >
                <Icon name="download" size={14} />
              </button>
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

            <div className="notes-meta-row">
              <div className="notes-tags-row">
                <Icon name="tag" size={13} />
                <input
                  value={draft.tagsText}
                  onChange={(e) => patchDraft({ tagsText: e.target.value })}
                  placeholder="标签，逗号分隔"
                  spellCheck={false}
                />
              </div>
              <div className="notes-tags-row">
                <Icon name="folder" size={13} />
                <input
                  value={draft.groupText}
                  onChange={(e) => patchDraft({ groupText: e.target.value })}
                  placeholder="分组，如 ops/db"
                  spellCheck={false}
                />
              </div>
            </div>

            <div className="notes-mode-row">
              <div className="notes-mode">
                <button
                  type="button"
                  className={`notes-mode-btn${mode === "edit" ? " active" : ""}`}
                  onClick={() => setMode("edit")}
                >
                  原文
                </button>
                <button
                  type="button"
                  className={`notes-mode-btn${mode === "preview" ? " active" : ""}`}
                  onClick={() => setMode("preview")}
                >
                  预览
                </button>
                <button
                  type="button"
                  className={`notes-mode-btn${outlineOn ? " active" : ""}`}
                  title={outlineOn ? "隐藏大纲" : "显示大纲"}
                  onClick={() => setOutlineOn((prev) => !prev)}
                >
                  大纲
                </button>
              </div>
              {mode === "edit" && (
                <div className="notes-toolbar">
                  {TOOLBAR.map((item) => (
                    <button
                      key={item.action}
                      type="button"
                      className="notes-tool"
                      title={item.title}
                      onClick={() => runToolbar(item.action)}
                    >
                      {item.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="notes-tool notes-tool-host"
                    title="插入关联主机链接"
                    onClick={() => setHostPicker((prev) => !prev)}
                  >
                    <Icon name="network" size={13} />
                    主机
                  </button>
                </div>
              )}
            </div>

            {hostPicker && mode === "edit" && (
              <div className="notes-hostpicker">
                {profiles.length === 0 ? (
                  <p className="notes-hostpicker-empty">还没有主机档案</p>
                ) : (
                  profiles.slice(0, 12).map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className="notes-hostpicker-item"
                      onClick={() => insertHostLink(profile)}
                    >
                      <span>{profile.name || profile.host}</span>
                      <span className="notes-hostpicker-host">
                        {profile.host}:{profile.port}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            <div className="notes-body">
              {outlineOn && outline.length > 0 && (
                <aside className="notes-outline">
                  {outline.map((item) => (
                    <button
                      key={`${item.line}-${item.text}`}
                      type="button"
                      className="notes-outline-item"
                      style={{ paddingLeft: 8 + (item.level - 1) * 12 }}
                      title={item.text}
                      onClick={() => jumpToLine(item.line)}
                    >
                      {item.text}
                    </button>
                  ))}
                </aside>
              )}
              {mode === "edit" ? (
                <textarea
                  ref={contentRef}
                  className="notes-content"
                  value={draft.content}
                  onChange={(e) => patchDraft({ content: e.target.value })}
                  placeholder="正文（Markdown 原文）"
                  spellCheck={false}
                />
              ) : (
                <div className="notes-preview">
                  <MarkdownPreview
                    content={draft.content}
                    onOpenHostHref={onOpenHost ? handleHostHref : undefined}
                  />
                </div>
              )}
            </div>

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
