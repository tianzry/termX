// 笔记模块（按 Netcatty `components/notes/NotesManager.tsx` 重做）。
//
// 对齐点：
// - 左侧树：工具图标（搜索 / 新建笔记 / 新建分组 / 导入 / 导出 / 全部展开折叠）、
//   可折叠搜索行、分组文件夹（可折叠 + 子树计数）、笔记行（FileText）、拖拽移动分组；
// - 标题行：18px 标题输入 + 模式下拉（编辑 / 分屏 / 预览）+ 大纲开关 + 置顶 + 导出 + 删除；
// - 元数据：分组 pill、标签 pill（可删除）、「+ 添加标签」就地输入；
// - 工具栏：撤销/重做、字号、标题层级、粗体/斜体/删除线/下划线/代码、
//   列表/有序/任务/引用、代码块/公式/表格/分隔线/链接/图片；
// - 正文：编辑（带行号）、分屏、预览；右侧 256px 大纲。
//
// 与 Netcatty 的差异（记录在 changelogs）：
// - Netcatty 的 live 模式是 MDXEditor 内联渲染；termX 不引重依赖，用「分屏」替代；
// - 字体下拉只提供正文/代码字号；数学公式按等宽文本渲染（无 KaTeX）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bold,
  CheckSquare,
  ChevronRight,
  Code,
  Columns2,
  Download,
  Eye,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Hash,
  Italic,
  Link2,
  Image as ImageIcon,
  List as ListIcon,
  ListOrdered,
  ListTree,
  Minus,
  Pencil,
  Pin,
  PinOff,
  Quote,
  Redo2,
  Search,
  Sigma,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Underline,
  Undo2,
  Upload,
  X,
  WrapText,
} from "lucide-react";
import * as api from "../backend/client";
import type { Credential, Note, Profile } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
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
  buildNoteTreeRows,
  collectNoteGroups,
  createNoteSaveQueue,
  draftToNote,
  extractNoteOutline,
  findProfileForHostLink,
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

type DisplayMode = "edit" | "split" | "preview";

type HistEntry = {
  text: string;
  start: number;
  end: number;
  at: number;
  /** 由输入产生（可被合并窗口覆盖）；打开笔记时的基线快照为 false。 */
  merged?: boolean;
};

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

/** 从点击位置反推光标字符偏移，用于大纲跳转。 */
function offsetOfLine(content: string, line: number): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(line, lines.length); i += 1) offset += lines[i].length + 1;
  return offset;
}

const FONT_KEY = "termx:notes-font-size";

export function NotesView({ profiles = [], credentials = [], onOpenHost }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<DisplayMode>("edit");
  const [outlineOn, setOutlineOn] = useState(false);
  const [fontSize, setFontSize] = useState(() => {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(FONT_KEY) : null;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 12 && n <= 20 ? n : 14;
  });
  const [tagEdit, setTagEdit] = useState<string | null>(null);
  const [groupEdit, setGroupEdit] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [headingMenu, setHeadingMenu] = useState(false);
  const [fontMenu, setFontMenu] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  const activeNoteRef = useRef<Note | null>(null);
  const draftRef = useRef<NoteDraft | null>(null);
  const queueRef = useRef<NoteSaveQueue | null>(null);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const historyRef = useRef<{ stack: HistEntry[]; index: number }>({ stack: [], index: -1 });

  if (!queueRef.current) {
    queueRef.current = createNoteSaveQueue(
      async (note) => {
        await api.saveNote(note);
        setSavedAt(Date.now());
        setDirty(false);
      },
      300,
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
        setExpanded(new Set(collectNoteGroups(list)));
        if (list.length > 0) {
          const first = list[0];
          activeNoteRef.current = first;
          draftRef.current = toNoteDraft(first);
          setActiveId(first.id);
          setDraft(draftRef.current);
          resetHistory(first.content);
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

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    if (!headingMenu && !fontMenu) return;
    const onDown = () => {
      setHeadingMenu(false);
      setFontMenu(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [headingMenu, fontMenu]);

  const resetHistory = (text: string) => {
    historyRef.current = {
      stack: [{ text, start: 0, end: 0, at: Date.now() }],
      index: 0,
    };
  };

  const openNote = useCallback(
    (note: Note) => {
      void queueRef.current?.flush();
      activeNoteRef.current = note;
      draftRef.current = toNoteDraft(note);
      setActiveId(note.id);
      setDraft(draftRef.current);
      setDirty(false);
      setSavedAt(null);
      setErr("");
      setNotice("");
      setTagEdit(null);
      setGroupEdit(null);
      resetHistory(note.content);
    },
    [],
  );

  /** 草稿同步更新：ref 先行，保证保存/导出立刻读到最新内容。 */
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

  /** 记录历史快照；750ms 内的连续输入合并成一步（对齐 Netcatty source undo）。 */
  const recordHistory = useCallback((text: string, start: number, end: number) => {
    const h = historyRef.current;
    const now = Date.now();
    const last = h.stack[h.index];
    // 只合并「输入产生」的尾部；打开笔记时的基线快照必须保留，否则撤销不回原文。
    if (last?.merged && now - last.at < 750) {
      h.stack[h.index] = { text, start, end, at: last.at, merged: true };
      return;
    }
    // undo 之后再输入：截断 redo 分支，避免重做跳到旧分支。
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push({ text, start, end, at: now, merged: true });
    if (h.stack.length > 100) h.stack.shift();
    h.index = h.stack.length - 1;
  }, []);

  const restoreEntry = useCallback(
    (entry: HistEntry) => {
      patchDraft({ content: entry.text });
      requestAnimationFrame(() => {
        const el = contentRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(entry.start, entry.end);
      });
    },
    [patchDraft],
  );

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    restoreEntry(h.stack[h.index]);
  }, [restoreEntry]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    restoreEntry(h.stack[h.index]);
  }, [restoreEntry]);

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
      openNote(note);
      setSavedAt(now);
      setNotice("已新建笔记");
      setMode("edit");
      requestAnimationFrame(() => titleRef.current?.focus());
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, [openNote]);

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
      const next = rest[0] ?? null;
      activeNoteRef.current = next;
      draftRef.current = next ? toNoteDraft(next) : null;
      setNotes(rest);
      setActiveId(next?.id ?? null);
      setDraft(draftRef.current);
      setDirty(false);
      setSavedAt(null);
      if (next) resetHistory(next.content);
      setNotice("已删除");
      setErr("");
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, [notes]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void queueRef.current?.flush();
        return;
      }
      // 撤销/重做只接管正文编辑区，标题/搜索/标签输入框保留原生行为。
      if (e.target !== contentRef.current) return;
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const runAction = useCallback(
    (action: MarkdownAction) => {
      if (!draft) return;
      const el = contentRef.current;
      const start = el?.selectionStart ?? draft.content.length;
      const end = el?.selectionEnd ?? start;
      const result = applyMarkdownAction(draft.content, start, end, action);
      patchDraft({ content: result.text });
      recordHistory(result.text, result.selectionStart, result.selectionEnd);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(result.selectionStart, result.selectionEnd);
      });
    },
    [draft, patchDraft, recordHistory],
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
      recordHistory(result.text, result.selectionStart, result.selectionEnd);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(result.selectionStart, result.selectionEnd);
      });
    },
    [credentials, draft, patchDraft, recordHistory],
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
      const files = buildNoteExportFiles(
        notes.map((note) =>
          note.id === activeNoteRef.current?.id
            ? activeNoteRef.current ?? note
            : note,
        ),
      );
      for (const file of files) {
        // 目录分隔符按系统取（Windows `\` / 其它 `/`），分组子目录先建再写。
        const sep = dir.includes("\\") ? "\\" : "/";
        const parts = file.path.split("/").filter(Boolean);
        const dest = `${dir.replace(/[\\/]$/, "")}${sep}${parts.join(sep)}`;
        if (parts.length > 1) {
          const parent = `${dir.replace(/[\\/]$/, "")}${sep}${parts
            .slice(0, -1)
            .join(sep)}`;
          await api.localMkdir(parent);
        }
        await api.localWriteFile(dest, new TextEncoder().encode(file.content));
      }
      setNotice(`已导出 ${files.length} 条笔记`);
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }, [notes]);

  const importNotes = useCallback(async () => {
    setErr("");
    try {
      const paths = await api.pickNoteImportFiles();
      if (!paths.length) return;
      const created: Note[] = [];
      let truncated = 0;
      for (const path of paths) {
        // 不传上限：后端缺省 16 MiB，超出时读尾部；用长度判断是否截断并提示。
        const bytes = await api.localReadFile(path);
        if (bytes.length >= 16 * 1024 * 1024) truncated += 1;
        const content = new TextDecoder().decode(new Uint8Array(bytes));
        const now = Date.now();
        const name = path.split(/[\\/]/).pop() ?? "note.md";
        created.push({
          id: crypto.randomUUID(),
          title: deriveImportedTitle(name, content),
          content,
          group: null,
          tags: [],
          linked_host_ids: [],
          created_at: now,
          updated_at: now,
          order: null,
          is_pinned: false,
        });
      }
      for (const note of created) await api.saveNote(note);
      setNotes((prev) => [...created, ...prev]);
      if (created[0]) openNote(created[0]);
      setNotice(
        truncated
          ? `已导入 ${created.length} 条笔记；${truncated} 个文件超过 16 MiB，仅导入尾部内容`
          : `已导入 ${created.length} 条笔记`,
      );
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }, [openNote]);

  const addGroup = useCallback(() => {
    const path = window.prompt("新建分组（可用 / 分隔层级）", "");
    const clean = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    // 展开到新分组的所有父级。
    const paths = new Set(expanded);
    const parts = clean.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) paths.add(parts.slice(0, i).join("/"));
    setExpanded(paths);
    const base = activeNoteRef.current;
    if (!base) return;
    const next = { ...base, group: clean, updated_at: Date.now() };
    activeNoteRef.current = next;
    draftRef.current = draftRef.current ? { ...draftRef.current, groupText: clean } : null;
    setDraft(draftRef.current);
    setNotes((prev) => prev.map((n) => (n.id === next.id ? next : n)));
    queueRef.current?.schedule(next);
    setDirty(true);
  }, [expanded]);

  const renameNote = useCallback(
    (note: Note) => {
      setRenamingId(note.id);
      setRenameText(note.title);
    },
    [],
  );

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const id = renamingId;
    const title = renameText.trim();
    setRenamingId(null);
    if (!title) return;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    const next = { ...note, title, updated_at: Date.now() };
    setNotes((prev) => prev.map((n) => (n.id === id ? next : n)));
    if (activeNoteRef.current?.id === id) {
      activeNoteRef.current = next;
      draftRef.current = draftRef.current
        ? { ...draftRef.current, title, updatedAt: next.updated_at }
        : null;
      setDraft(draftRef.current);
    }
    queueRef.current?.schedule(next);
  }, [notes, renameText, renamingId]);

  const moveNoteToGroup = useCallback(
    (noteId: string, group: string | null) => {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      const next = { ...note, group: group || null, updated_at: Date.now() };
      setNotes((prev) => prev.map((n) => (n.id === noteId ? next : n)));
      if (activeNoteRef.current?.id === noteId) {
        activeNoteRef.current = next;
        draftRef.current = draftRef.current
          ? { ...draftRef.current, groupText: group ?? "" }
          : null;
        setDraft(draftRef.current);
      }
      queueRef.current?.schedule(next);
    },
    [notes],
  );

  const togglePin = useCallback(() => {
    if (!draft) return;
    patchDraft({ isPinned: !draft.isPinned });
  }, [draft, patchDraft]);

  const treeRows = useMemo(
    () => buildNoteTreeRows(notes, expanded, query),
    [notes, expanded, query],
  );
  const outline = useMemo(
    () => (draft ? extractNoteOutline(draft.content) : []),
    [draft],
  );
  const lineCount = draft ? draft.content.split("\n").length : 1;

  const toggleGroup = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    if (expanded.size > 0) setExpanded(new Set());
    else setExpanded(new Set(collectNoteGroups(notes)));
  };

  const jumpToLine = (line: number) => {
    const el = contentRef.current;
    if (!draft) return;
    if (mode === "preview") setMode("edit");
    requestAnimationFrame(() => {
      if (!el) return;
      const offset = offsetOfLine(draft.content, line);
      el.focus();
      el.setSelectionRange(offset, offset);
      el.scrollTop = Math.max(0, line * 20 - 60);
    });
  };

  const onContentChange = (value: string) => {
    patchDraft({ content: value });
    recordHistory(value, contentRef.current?.selectionStart ?? 0, contentRef.current?.selectionEnd ?? 0);
  };

  const addTag = () => {
    const raw = (tagEdit ?? "").trim();
    setTagEdit(null);
    if (!raw || !draft) return;
    const known = draft.tagsText
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (known.includes(raw.toLowerCase())) return;
    patchDraft({ tagsText: [...draft.tagsText.split(",").map((t) => t.trim()).filter(Boolean), raw].join(", ") });
  };

  const removeTag = (tag: string) => {
    if (!draft) return;
    patchDraft({
      tagsText: draft.tagsText
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t && t !== tag)
        .join(", "),
    });
  };

  const commitGroup = () => {
    const value = (groupEdit ?? "").trim().replace(/^\/+|\/+$/g, "");
    setGroupEdit(null);
    if (!draft) return;
    patchDraft({ groupText: value });
  };

  const toolbar = (
    <div className="np-toolbar">
      <button className="np-tb" title="撤销 (Ctrl+Z)" onClick={undo}>
        <Undo2 size={16} />
      </button>
      <button className="np-tb" title="重做 (Ctrl+Y)" onClick={redo}>
        <Redo2 size={16} />
      </button>
      <span className="np-tb-sep" />
      <div className="np-tb-wrap">
        <button
          className="np-tb"
          title={`字号 ${fontSize}px`}
          onClick={() => setFontMenu((v) => !v)}
        >
          <WrapText size={16} />
        </button>
        {fontMenu && (
          <div className="np-menu">
            {[12, 13, 14, 15, 16, 18, 20].map((size) => (
              <button
                key={size}
                className={fontSize === size ? "is-active" : ""}
                onClick={() => {
                  setFontSize(size);
                  setFontMenu(false);
                }}
              >
                正文字号 {size}px
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="np-tb-wrap">
        <button
          className="np-tb"
          title="标题层级"
          onClick={() => setHeadingMenu((v) => !v)}
        >
          <span className="np-tb-text">H</span>
        </button>
        {headingMenu && (
          <div className="np-menu">
            {(["h1", "h2", "h3", "h4"] as MarkdownAction[]).map((action, i) => (
              <button
                key={action}
                onClick={() => {
                  runAction(action);
                  setHeadingMenu(false);
                }}
              >
                标题 {i + 1}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="np-tb" title="加粗" onClick={() => runAction("bold")}>
        <Bold size={16} />
      </button>
      <button className="np-tb" title="斜体" onClick={() => runAction("italic")}>
        <Italic size={16} />
      </button>
      <button className="np-tb" title="删除线" onClick={() => runAction("strikethrough")}>
        <Strikethrough size={16} />
      </button>
      <button className="np-tb" title="下划线" onClick={() => runAction("underline")}>
        <Underline size={16} />
      </button>
      <button className="np-tb" title="行内代码" onClick={() => runAction("code")}>
        <Code size={16} />
      </button>
      <span className="np-tb-sep" />
      <button className="np-tb" title="无序列表" onClick={() => runAction("bullet")}>
        <ListIcon size={16} />
      </button>
      <button className="np-tb" title="有序列表" onClick={() => runAction("ordered")}>
        <ListOrdered size={16} />
      </button>
      <button className="np-tb" title="任务列表" onClick={() => runAction("task")}>
        <CheckSquare size={16} />
      </button>
      <button className="np-tb" title="引用" onClick={() => runAction("quote")}>
        <Quote size={16} />
      </button>
      <span className="np-tb-sep" />
      <button className="np-tb" title="代码块" onClick={() => runAction("code")}>
        <FileCode2 size={16} />
      </button>
      <button className="np-tb" title="公式" onClick={() => runAction("math")}>
        <Sigma size={16} />
      </button>
      <button className="np-tb" title="表格" onClick={() => runAction("table")}>
        <TableIcon size={16} />
      </button>
      <button className="np-tb" title="分隔线" onClick={() => runAction("divider")}>
        <Minus size={16} />
      </button>
      <button className="np-tb" title="链接" onClick={() => runAction("link")}>
        <Link2 size={16} />
      </button>
      <button className="np-tb" title="图片" onClick={() => runAction("image")}>
        <ImageIcon size={16} />
      </button>
      <span className="np-tb-sep" />
      <button className="np-tb" title="插入主机链接" onClick={() => {
        const first = profiles[0];
        if (first) insertHostLink(first);
        else setNotice("还没有主机可插入");
      }}>
        <Pencil size={16} />
      </button>
      <div className="np-tb-spacer" />
      <span className="np-save-state">
        {dirty ? "未保存" : savedAt ? `已保存 ${formatTime(savedAt)}` : ""}
      </span>
    </div>
  );

  return (
    <div className="notes-page">
      <aside className="np-tree">
        <header className="np-tree-head">
          <span className="np-tree-title">笔记</span>
          <div className="np-tree-actions">
            <button
              className={`np-icon${searchOpen ? " is-active" : ""}`}
              title="搜索"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Search size={14} />
            </button>
            <button className="np-icon" title="新建笔记" onClick={() => void newNote()}>
              <FilePlus2 size={14} />
            </button>
            <button className="np-icon" title="新建分组" onClick={addGroup}>
              <FolderPlus size={14} />
            </button>
            <button className="np-icon" title="导入笔记" onClick={() => void importNotes()} disabled={busy}>
              <Upload size={14} />
            </button>
            <button className="np-icon" title="导出全部" onClick={() => void exportAll()} disabled={busy || !notes.length}>
              <Download size={14} />
            </button>
            <button className="np-icon" title="展开 / 折叠" onClick={toggleAll}>
              {expanded.size > 0 ? <FolderOpen size={14} /> : <Folder size={14} />}
            </button>
          </div>
        </header>

        {searchOpen && (
          <div className="np-search">
            <Search size={13} />
            <input
              autoFocus
              value={query}
              placeholder="搜索标题 / 正文 / 分组 / 标签"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="np-icon" onClick={() => setQuery("")}>
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <div
          className="np-tree-body"
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => moveNoteToGroup(draggedNoteId ?? "", null)}
        >
          {loading ? (
            <p className="np-empty-line">加载中…</p>
          ) : treeRows.length === 0 ? (
            <div className="np-tree-empty">
              <FileText size={28} />
              <p>{query.trim() ? "没有匹配的笔记" : "还没有笔记"}</p>
              {!query.trim() && (
                <button className="np-btn is-primary" onClick={() => void newNote()}>
                  <FilePlus2 size={13} /> 新建笔记
                </button>
              )}
            </div>
          ) : (
            treeRows.map((row) => {
              if (row.type === "group") {
                const path = row.path ?? "";
                const isOpen = expanded.has(path);
                return (
                  <div
                    key={`g:${path}`}
                    className="np-tree-row is-group"
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                    onClick={() => toggleGroup(path)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      if (draggedNoteId) moveNoteToGroup(draggedNoteId, path);
                    }}
                  >
                    <ChevronRight size={12} className={isOpen ? "is-open" : ""} />
                    {isOpen ? (
                      <FolderOpen size={14} className="np-folder" />
                    ) : (
                      <Folder size={14} className="np-folder" />
                    )}
                    <span className="np-tree-name">{path.split("/").pop()}</span>
                    <span className="np-tree-count">{row.count}</span>
                  </div>
                );
              }
              const note = row.note!;
              const title = note.title.trim() || "未命名笔记";
              return (
                <div
                  key={`n:${note.id}`}
                  className={`np-tree-row is-note${note.id === activeId ? " is-active" : ""}`}
                  style={{ paddingLeft: 24 + row.depth * 14 }}
                  draggable
                  onDragStart={() => setDraggedNoteId(note.id)}
                  onDragEnd={() => setDraggedNoteId(null)}
                  onClick={() => openNote(note)}
                  onDoubleClick={() => renameNote(note)}
                  title={note.content ? note.content.slice(0, 300) : title}
                >
                  {note.is_pinned ? (
                    <Pin size={12} className="np-pin" />
                  ) : (
                    <FileText size={12} />
                  )}
                  {renamingId === note.id ? (
                    <input
                      className="np-rename"
                      autoFocus
                      value={renameText}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameText(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className="np-tree-name">{title}</span>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="np-tree-foot">
          <span>{notes.length} 条笔记</span>
        </div>
      </aside>

      {draft && activeNoteRef.current ? (
        <section className={`np-editor is-${mode}${outlineOn ? " with-outline" : ""}`}>
          <header className="np-title-row">
            <input
              ref={titleRef}
              className="np-title"
              value={draft.title}
              placeholder="未命名笔记"
              onChange={(e) => patchDraft({ title: e.target.value })}
              onBlur={() => void queueRef.current?.flush()}
            />
            <div className="np-title-actions">
              <select
                className="np-mode-select"
                value={mode}
                onChange={(e) => setMode(e.target.value as DisplayMode)}
              >
                <option value="edit">编辑</option>
                <option value="split">分屏</option>
                <option value="preview">预览</option>
              </select>
              <button
                className={`np-icon${outlineOn ? " is-active" : ""}`}
                title="大纲"
                onClick={() => setOutlineOn((v) => !v)}
              >
                <ListTree size={16} />
              </button>
              <button
                className={`np-icon${draft.isPinned ? " is-active" : ""}`}
                title={draft.isPinned ? "取消置顶" : "置顶"}
                onClick={togglePin}
              >
                {draft.isPinned ? <PinOff size={16} /> : <Pin size={16} />}
              </button>
              <button className="np-icon" title="导出" onClick={() => void exportActive()} disabled={busy}>
                <Download size={16} />
              </button>
              <button className="np-icon is-danger" title="删除" onClick={() => void deleteActive()}>
                <Trash2 size={16} />
              </button>
            </div>
          </header>

          <div className="np-meta">
            {groupEdit !== null ? (
              <input
                className="np-meta-input"
                autoFocus
                value={groupEdit}
                placeholder="分组，如 ops/db"
                onChange={(e) => setGroupEdit(e.target.value)}
                onBlur={commitGroup}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitGroup();
                  if (e.key === "Escape") setGroupEdit(null);
                }}
              />
            ) : (
              <button
                className="np-pill is-group"
                title="点击编辑分组"
                onClick={() => setGroupEdit(draft.groupText)}
              >
                <Folder size={12} />
                {draft.groupText.trim() || "未分组"}
              </button>
            )}
            {draft.tagsText
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .map((tag) => (
                <span key={tag} className="np-pill is-tag">
                  <Hash size={12} />
                  {tag}
                  <button onClick={() => removeTag(tag)} title="移除标签">
                    <X size={10} />
                  </button>
                </span>
              ))}
            {tagEdit !== null ? (
              <input
                className="np-meta-input is-tag"
                autoFocus
                value={tagEdit}
                placeholder="标签"
                onChange={(e) => setTagEdit(e.target.value)}
                onBlur={addTag}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTag();
                  if (e.key === "Escape") setTagEdit(null);
                }}
              />
            ) : (
              <button className="np-add-tag" onClick={() => setTagEdit("")}>
                <Hash size={12} /> 添加标签
              </button>
            )}
            <span className="np-meta-time">
              创建 {formatTime(draft.createdAt)} · 更新 {formatTime(draft.updatedAt)}
            </span>
          </div>

          {mode !== "preview" && toolbar}

          <div className="np-body">
            {mode !== "preview" && (
              <div className="np-source">
                <div className="np-gutter" ref={gutterRef} aria-hidden="true">
                  {Array.from({ length: lineCount }, (_, i) => (
                    <span key={i}>{i + 1}</span>
                  ))}
                </div>
                <textarea
                  ref={contentRef}
                  className="np-textarea"
                  style={{ fontSize: `${fontSize}px` }}
                  value={draft.content}
                  spellCheck={false}
                  placeholder="开始写 Markdown…"
                  onChange={(e) => onContentChange(e.target.value)}
                  onScroll={(e) => {
                    if (gutterRef.current) {
                      gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                    }
                  }}
                />
              </div>
            )}
            {(mode === "preview" || mode === "split") && (
              <div className="np-preview">
                <MarkdownPreview content={draft.content} onOpenHostHref={handleHostHref} />
              </div>
            )}
          </div>

          <footer className="np-status">
            <span>{lineCount} 行</span>
            <span>·</span>
            <span>{draft.content.length} 字符</span>
            <div className="np-tb-spacer" />
                     {mode === "preview" ? <Eye size={12} /> : <Columns2 size={12} />}
            <span>{mode === "preview" ? "预览" : mode === "split" ? "分屏" : "编辑"}</span>
          </footer>
        </section>
      ) : (
        <section className="np-editor is-empty">
          <div className="np-empty-note">
            <FileText size={32} />
            <h3>{loading ? "加载中…" : "还没有笔记"}</h3>
            <p>新建笔记记录命令、排查过程或主机信息；`ssh://` 链接可直接起连。</p>
            <button className="np-btn is-primary" onClick={() => void newNote()}>
              <FilePlus2 size={14} /> 新建笔记
            </button>
          </div>
        </section>
      )}

      {outlineOn && draft && (
        <aside className="np-outline">
          <header className="np-outline-head">
            <span>大纲</span>
            <button className="np-icon" title="关闭" onClick={() => setOutlineOn(false)}>
              <X size={12} />
            </button>
          </header>
          <div className="np-outline-body">
            {outline.length === 0 ? (
              <p className="np-empty-line">用 # 标题生成大纲</p>
            ) : (
              outline.map((item, index) => (
                <button
                  key={index}
                  className="np-outline-item"
                  style={{ paddingLeft: 10 + (item.level - 1) * 10 }}
                  onClick={() => jumpToLine(item.line)}
                  title={`第 ${item.line + 1} 行`}
                >
                  {item.text}
                </button>
              ))
            )}
          </div>
        </aside>
      )}

      {(err || notice) && (
        <div className={`np-toast${err ? " is-error" : ""}`} onClick={() => {
          setErr("");
          setNotice("");
        }}>
          {err || notice}
        </div>
      )}
    </div>
  );
}

/** 拖拽中的笔记 id（模块级简单状态，避免为一次拖拽引入额外 context）。 */
let draggedNoteId: string | null = null;

function setDraggedNoteId(id: string | null) {
  draggedNoteId = id;
}
