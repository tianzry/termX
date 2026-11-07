// 脚本 / 片段管理页（按 Netcatty `SnippetsManager` + `ScriptsSidePanel` 重做）。
//
// 对齐点：
// - 顶栏：搜索、新建下拉（片段 / 脚本 / 分组）、导入、导出、视图切换、排序、多选；
// - 面包屑「全部分组 / …」；「分组」卡片节 +「片段」卡片节；
// - 列表两种视图：grid 68px 卡片 / list 56px 行；图标 Zap（片段）/ Play（脚本）；
// - 右键菜单：片段 = 运行 / 编辑 / 复制 / 导出 / 删除；分组 = 打开 / 导出 / 重命名 / 删除；
// - 右侧常驻编辑面板（SnippetsRightPanel）：描述 → 分组 → 命令（变量 chips）/ 脚本参数 →
//   目标主机 → 不自动运行 / 多行发送 → 快捷键（点击录制）→ 底部整宽 保存 / 运行。
//
// 与 Netcatty 的差异（已记录在 changelogs）：
// - termX 无多会话广播，运行目标固定为当前活动终端；
// - Snippet 无时间戳字段，newest / oldest 用数组顺序近似；
// - 脚本语言仅 shell（nct.* JS 运行时未移植）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit2,
  FileCode,
  FolderPlus,
  FolderTree,
  Keyboard,
  LayoutGrid,
  List as ListIcon,
  Maximize2,
  Package,
  Play,
  Plus,
  RotateCcw,
  Search,
  Server,
  Square,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import * as api from "../backend/client";
import type { Snippet } from "../backend/client";
import type { PaneHandle } from "../TerminalPane";
import { userVisibleError } from "../domain/sshErrors";
import {
  SNIPPETS_CHANGED_EVENT,
  SNIPPET_SORT_LABELS,
  buildSnippetPackageTree,
  deleteSnippetPackage,
  ensureSnippetIds,
  filterSnippets,
  findShortkeyConflict,
  flattenSnippetCommandPreview,
  formatShortkeyEvent,
  parseShortkey,
  parseSnippetVariables,
  previewSnippetCommand,
  renameSnippetPackage,
  resolveScriptTrigger,
  scriptTriggerNote,
  snippetBreadcrumb,
  sortSnippets,
  type SnippetSortMode,
} from "./snippetsModel";
import {
  buildSnippetExportPayload,
  describeImportStats,
  mergeSnippetImport,
  parseSnippetImportPayload,
  type SnippetExportPayload,
} from "./snippetsTransfer";
import "./snippets.css";

type SnippetKind = "" | "script";
type RunMode = "" | "paste" | "lineDelay";

/** 拖拽载荷类型：把条目拖到分组卡片 / 面包屑上移动所属分组。 */
const SNIPPET_DRAG_MIME = "application/x-termx-snippet";
type ViewMode = "list" | "grid";

type Draft = {
  id: string;
  name: string;
  command: string;
  description: string;
  package: string;
  tagsText: string;
  shortkey: string;
  noAutoRun: boolean;
  kind: SnippetKind;
  multiLineRunMode: RunMode;
  language: string;
  trigger: "" | "onConnect" | "onOutput";
  triggerPattern: string;
  targets: string[];
  targetsAllHosts: boolean;
};

type CtxTarget =
  | { type: "snippet"; id: string }
  | { type: "package"; path: string };

type HostBrief = { id: string; name: string; host: string; port: number };

function toDraft(s: Snippet): Draft {
  return {
    id: s.id,
    name: s.name,
    command: s.command,
    description: s.description,
    package: s.package,
    tagsText: s.tags.join(", "),
    shortkey: s.shortkey,
    noAutoRun: s.no_auto_run,
    kind: s.kind === "script" ? "script" : "",
    multiLineRunMode:
      s.multi_line_run_mode === "lineDelay" || s.multi_line_run_mode === "paste"
        ? s.multi_line_run_mode
        : "",
    language: s.language || "shell",
    trigger: s.trigger === "onConnect" || s.trigger === "onOutput" ? s.trigger : "",
    triggerPattern: s.trigger_pattern || "",
    targets: s.targets ?? [],
    targetsAllHosts: s.targets_all_hosts === true,
  };
}

function emptyDraft(kind: SnippetKind = "", pkg = ""): Draft {
  return {
    id: "",
    name: "",
    command: "",
    description: "",
    package: pkg,
    tagsText: "",
    shortkey: "",
    noAutoRun: false,
    kind,
    multiLineRunMode: "",
    language: "shell",
    trigger: "",
    triggerPattern: "",
    targets: [],
    targetsAllHosts: false,
  };
}

/** 导出：浏览器下载 JSON（Netcatty snippet 传输格式）。 */
function downloadExport(snippets: Snippet[], fileName: string) {
  const payload = buildSnippetExportPayload(snippets);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileName}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SnippetsView({ activeHandle }: { activeHandle?: PaneHandle | null }) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [pkgFilter, setPkgFilter] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sortMode, setSortMode] = useState<SnippetSortMode>("manual");
  const [openMenu, setOpenMenu] = useState<"new" | "view" | "sort" | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: CtxTarget } | null>(
    null,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [pkgRename, setPkgRename] = useState<{ from: string; to: string } | null>(null);
  const [pkgNew, setPkgNew] = useState<string | null>(null);
  const [importPending, setImportPending] = useState<{
    payload: SnippetExportPayload;
    conflicts: number;
  } | null>(null);
  const [hosts, setHosts] = useState<HostBrief[]>([]);
  const [targetPicker, setTargetPicker] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [run, setRun] = useState<{ name: string; paneId: string } | null>(null);
  const [varPrompt, setVarPrompt] = useState<{
    snippet: Snippet;
    fromPanel: boolean;
    values: Record<string, string>;
  } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  /** 最新待提交/已提交列表：并发操作按它做增量，避免用过期快照覆盖。 */
  const latestRef = useRef<Snippet[]>([]);
  /** 串行化整份覆盖写入，防止两次 save 交叉。 */
  const writeRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    latestRef.current = snippets;
  }, [snippets]);

  const refresh = async () => {
    try {
      setErr("");
      setSnippets(ensureSnippetIds(await api.loadSnippets()));
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  };

  useEffect(() => {
    void refresh();
    api
      .listProfiles()
      .then((list) =>
        setHosts(
          list.map((p) => ({ id: p.id, name: p.name, host: p.host, port: p.port })),
        ),
      )
      .catch(() => {});
  }, []);

  // 切换活动窗格 / 关闭终端后清空运行横幅，避免把控制键发给错误的会话。
  useEffect(() => {
    setRun(null);
  }, [activeHandle]);

  // 点击空白处关闭下拉与右键菜单。
  useEffect(() => {
    if (!openMenu && !ctxMenu) return;
    const onDown = () => {
      setOpenMenu(null);
      setCtxMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [openMenu, ctxMenu]);

  // 快捷键录制：监听 window keydown（对齐 Netcatty keyEventToString 交互）。
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setDraft((d) => (d ? { ...d, shortkey: "" } : d));
        setRecording(false);
        return;
      }
      const key = formatShortkeyEvent(e);
      if (!key) return; // 纯修饰键：继续录制
      if (!parseShortkey(key)) return;
      setDraft((d) => (d ? { ...d, shortkey: key } : d));
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const persist = (
    update: Snippet[] | ((prev: Snippet[]) => Snippet[]),
    onDone?: () => void,
  ) => {
    const run = async () => {
      const prev = latestRef.current;
      const next = typeof update === "function" ? update(prev) : update;
      setBusy(true);
      setErr("");
      try {
        await api.saveSnippets(next);
        latestRef.current = next;
        setSnippets(next);
        window.dispatchEvent(new Event(SNIPPETS_CHANGED_EVENT));
        onDone?.();
      } catch (e) {
        // 写失败：回退到上一次已提交的列表，避免后续增量基于未落库状态。
        latestRef.current = prev;
        setErr(userVisibleError(String(e)));
      } finally {
        setBusy(false);
      }
    };
    const chained = writeRef.current.then(run, run);
    writeRef.current = chained.catch(() => {});
    return chained;
  };

  const packageTree = useMemo(() => buildSnippetPackageTree(snippets), [snippets]);
  const breadcrumb = useMemo(() => snippetBreadcrumb(pkgFilter), [pkgFilter]);

  /** 把条目拖进分组卡片 / 「全部分组」面包屑即可移动（空组 = 未分组）。 */
  const moveSnippetToPackage = (id: string, pkg: string) => {
    const current = snippets.find((s) => s.id === id);
    if (!current || (current.package || "").trim() === pkg) return;
    persist((prev) => prev.map((s) => (s.id === id ? { ...s, package: pkg } : s)));
    setNotice(`已移动到「${pkg || "未分组"}」`);
  };
  const dragOverPackage = (event: ReactDragEvent) => {
    if (!event.dataTransfer.types.includes(SNIPPET_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const dropOnPackage = (event: ReactDragEvent, pkg: string) => {
    if (!event.dataTransfer.types.includes(SNIPPET_DRAG_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData(SNIPPET_DRAG_MIME);
    if (id) moveSnippetToPackage(id, pkg);
  };

  const filtered = useMemo(() => filterSnippets(snippets, query), [snippets, query]);
  const scoped = useMemo(() => {
    if (!pkgFilter) return filtered;
    return filtered.filter((s) => {
      const p = (s.package || "").trim();
      return p === pkgFilter || p.startsWith(`${pkgFilter}/`);
    });
  }, [filtered, pkgFilter]);

  const displayedSnippets = useMemo(
    () => sortSnippets(scoped, sortMode),
    [scoped, sortMode],
  );

  /** 当前层级直接包含的子分组（选中分组时只显示直属子级）。 */
  const childPackages = useMemo(() => {
    if (query.trim()) return [];
    if (!pkgFilter) return packageTree.filter((p) => p.depth === 0);
    const prefix = `${pkgFilter}/`;
    return packageTree.filter(
      (p) => p.path.startsWith(prefix) && p.depth === pkgFilter.split("/").length,
    );
  }, [packageTree, pkgFilter, query]);

  const openNew = (kind: SnippetKind) => {
    setIsNew(true);
    setErr("");
    setNotice("");
    setTargetPicker(false);
    setDraft(emptyDraft(kind, pkgFilter));
    setOpenMenu(null);
  };

  const openEdit = (s: Snippet) => {
    setIsNew(false);
    setErr("");
    setNotice("");
    setTargetPicker(false);
    setDraft(toDraft(s));
  };

  const sendSnippet = (s: Snippet, fromPanel = false) => {
    if (!activeHandle?.runSnippet(s)) {
      setNotice("脚本未能发送：终端未就绪。");
      return;
    }
    setRun({ name: s.name, paneId: activeHandle.paneId });
    if (fromPanel) setIsNew(false);
  };

  const runScript = (s: Snippet, fromPanel = false) => {
    if (!activeHandle) {
      setNotice("先在终端打开一个已连接的会话，再回来运行脚本。");
      return;
    }
    if (!activeHandle.connected()) {
      setNotice("活动终端当前未连接，无法运行脚本。");
      return;
    }
    // 命令里含 {{变量}} 时先收集取值，再替换成真实命令发送；缺省值预填。
    const vars = parseSnippetVariables(s.command);
    if (vars.length > 0) {
      setVarPrompt({
        snippet: s,
        fromPanel,
        values: Object.fromEntries(vars.map((v) => [v.name, v.defaultValue ?? ""])),
      });
      return;
    }
    sendSnippet(s, fromPanel);
  };

  const confirmVarPrompt = () => {
    if (!varPrompt) return;
    const filled: Snippet = {
      ...varPrompt.snippet,
      command: previewSnippetCommand(varPrompt.snippet.command, varPrompt.values),
    };
    const prompt = varPrompt;
    setVarPrompt(null);
    sendSnippet(filled, prompt.fromPanel);
  };

  const controlRun = (action: "stop" | "pause" | "resume") => {
    if (!activeHandle) return;
    const ok =
      action === "stop"
        ? activeHandle.interrupt()
        : action === "pause"
          ? activeHandle.suspend()
          : activeHandle.resume();
    setNotice(
      ok
        ? action === "stop"
          ? "已发送 Ctrl-C（SIGINT）"
          : action === "pause"
            ? "已发送 Ctrl-Z（SIGTSTP）"
            : "已发送 fg"
        : "活动终端已断开，无法发送控制键。",
    );
  };

  const saveDraft = (): Snippet | null => {
    if (!draft) return null;
    const name = draft.name.trim();
    if (!name) {
      setErr("名称不能为空");
      return null;
    }
    if (!draft.command.trim()) {
      setErr("命令内容不能为空");
      return null;
    }
    if (draft.shortkey.trim() && !parseShortkey(draft.shortkey)) {
      setErr(`快捷键格式无效：${draft.shortkey}`);
      return null;
    }
    const conflict = findShortkeyConflict(snippets, draft.shortkey, draft.id || undefined);
    if (conflict) {
      setErr(`快捷键 ${draft.shortkey.trim()} 已被「${conflict.name}」占用`);
      return null;
    }
    const next: Snippet = {
      id: draft.id || crypto.randomUUID(),
      name,
      command: draft.command,
      description: draft.description.trim(),
      package: draft.package.trim(),
      tags: draft.tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      shortkey: draft.shortkey.trim(),
      no_auto_run: draft.noAutoRun,
      kind: draft.kind === "script" ? "script" : "",
      multi_line_run_mode: draft.multiLineRunMode,
      language: draft.kind === "script" ? draft.language || "shell" : "",
      trigger: draft.kind === "script" ? draft.trigger : "",
      trigger_pattern:
        draft.kind === "script" && draft.trigger === "onOutput"
          ? draft.triggerPattern.trim()
          : "",
      targets: draft.kind === "script" ? draft.targets : [],
      targets_all_hosts: draft.kind === "script" ? draft.targetsAllHosts : false,
    };
    void persist(
      (prev) =>
        isNew ? [...prev, next] : prev.map((s) => (s.id === next.id ? next : s)),
      () => setDraft(null),
    );
    return next;
  };

  const removeSnippet = (s: Snippet) => {
    if (!window.confirm(`删除「${s.name}」？不可恢复。`)) return;
    if (draft && draft.id === s.id) setDraft(null);
    void persist((prev) => prev.filter((x) => x.id !== s.id));
  };

  const removePackage = (pkg: string) => {
    const count = snippets.filter((s) => {
      const p = (s.package || "").trim();
      return p === pkg || p.startsWith(`${pkg}/`);
    }).length;
    if (!window.confirm(`删除分组「${pkg}」及其下 ${count} 条？不可恢复。`)) return;
    void persist((prev) => deleteSnippetPackage(prev, pkg));
    if (pkgFilter === pkg) setPkgFilter("");
  };

  const applyPkgRename = () => {
    if (!pkgRename) return;
    const to = pkgRename.to.trim();
    if (!to || to === pkgRename.from) return;
    void persist((prev) => renameSnippetPackage(prev, pkgRename.from, to), () =>
      setPkgRename(null),
    );
    if (pkgFilter === pkgRename.from) setPkgFilter(to);
  };

  const applyPkgNew = () => {
    const path = (pkgNew ?? "").trim();
    if (!path) return;
    // 分组是隐式的（由条目的 package 字段派生）；新建后直接进入该分组。
    setPkgFilter(path);
    setPkgNew(null);
  };

  const exportSelected = () => {
    const list = snippets.filter((s) => selectedIds.has(s.id));
    if (!list.length) return;
    downloadExport(list, `termx-snippets-selected-${list.length}`);
    setNotice(`已导出所选 ${list.length} 条`);
  };

  const exportPackage = (path: string) => {
    const list = snippets.filter((s) => {
      const p = (s.package || "").trim();
      return p === path || p.startsWith(`${path}/`);
    });
    downloadExport(list, `termx-package-${path.replace(/\//g, "-")}`);
    setNotice(`已导出分组「${path}」共 ${list.length} 条`);
  };

  const deleteSelected = () => {
    if (!selectedIds.size) return;
    if (!window.confirm(`删除所选 ${selectedIds.size} 条？不可恢复。`)) return;
    void persist((prev) => prev.filter((s) => !selectedIds.has(s.id)));
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const readImportFile = async (file: File) => {
    setErr("");
    try {
      const payload = parseSnippetImportPayload(await file.text());
      if (payload.snippets.length === 0) throw new Error("导入文件没有可用条目");
      const commandSet = new Set(snippets.map((s) => s.command));
      const conflicts = payload.snippets.filter((s) => commandSet.has(s.command)).length;
      setImportPending({ payload, conflicts });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const applyImport = async (conflictAction: "skip" | "overwrite") => {
    if (!importPending) return;
    setBusy(true);
    try {
      const merged = mergeSnippetImport({
        existing: snippets,
        payload: importPending.payload,
        conflictAction,
        createId: () => crypto.randomUUID(),
      });
      await api.saveSnippets(merged.snippets);
      setSnippets(merged.snippets);
      window.dispatchEvent(new Event(SNIPPETS_CHANGED_EVENT));
      setNotice(`导入完成：${describeImportStats(merged.stats)}`);
      setImportPending(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 右键菜单坐标：fixed 定位 + 视口内翻转（踩坑 164）。
   * 菜单若嵌在 overflow 容器里会被裁切。
   */
  const openCtx = (event: ReactMouseEvent, target: CtxTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxMenu({
      x: Math.min(event.clientX, window.innerWidth - 200),
      y: Math.min(event.clientY, window.innerHeight - 220),
      target,
    });
  };

  const ctxTarget = ctxMenu?.target ?? null;
  const ctxSnippet =
    ctxTarget?.type === "snippet"
      ? snippets.find((s) => s.id === ctxTarget.id) ?? null
      : null;
  const ctxPkg = ctxTarget?.type === "package" ? ctxTarget : null;

  const variables = useMemo(
    () => parseSnippetVariables(draft?.command ?? ""),
    [draft?.command],
  );

  const isScript = draft?.kind === "script";
  const canRunActive = Boolean(activeHandle?.connected());
  const canSubmit = Boolean(draft?.name.trim() && draft?.command.trim());

  // ── 列表渲染 ─────────────────────────────────────────────────────────────

  const renderSnippetCard = (s: Snippet) => {
    const script = s.kind === "script";
    const isSelected = selectedIds.has(s.id);
    return (
      <div
        key={s.id}
        className={`sn-row ${viewMode === "grid" ? "is-grid" : "is-list"}${
          isSelected ? " is-selected" : ""
        }${draft?.id === s.id ? " is-active" : ""}`}
        data-snippet-id={s.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SNIPPET_DRAG_MIME, s.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => (multiSelect ? toggleSelected(s.id) : openEdit(s))}
        onContextMenu={(e) => openCtx(e, { type: "snippet", id: s.id })}
      >
        {multiSelect && (
          <span className="sn-check" onClick={(e) => e.stopPropagation()}>
            {isSelected ? (
              <CheckSquare size={18} className="sn-check-on" onClick={() => toggleSelected(s.id)} />
            ) : (
              <Square size={18} className="sn-check-off" onClick={() => toggleSelected(s.id)} />
            )}
          </span>
        )}
        <span className={`sn-icon ${script ? "is-script" : "is-snippet"}`}>
          {script ? <Play size={18} /> : <Zap size={18} />}
        </span>
        <div className="sn-row-text">
          <div className="sn-row-name">{s.name}</div>
          <div className="sn-row-command" title={s.command}>
            {flattenSnippetCommandPreview(s.command) || "（空命令）"}
          </div>
        </div>
        {s.shortkey && <span className="sn-shortkey-badge">{s.shortkey}</span>}
        {viewMode === "list" && !multiSelect && (
          <button
            className="sn-row-edit"
            title="编辑"
            onClick={(e) => {
              e.stopPropagation();
              openEdit(s);
            }}
          >
            <Edit2 size={14} />
          </button>
        )}
      </div>
    );
  };

  const renderPackageCard = (p: { path: string; name: string; count: number }) => (
    <div
      key={p.path}
      className={`sn-row sn-pkg ${viewMode === "grid" ? "is-grid" : "is-list"}`}
      onDragOver={dragOverPackage}
      onDrop={(e) => dropOnPackage(e, p.path)}
      onClick={() => setPkgFilter(p.path)}
      onContextMenu={(e) => openCtx(e, { type: "package", path: p.path })}
    >
      <span className="sn-icon is-package">
        <Package size={18} />
      </span>
      <div className="sn-row-text">
        <div className="sn-row-name">{p.name}</div>
        <div className="sn-row-command">{p.count} 条片段</div>
      </div>
      <ChevronRight size={14} className="sn-row-chevron" />
    </div>
  );

  return (
    <div className="snippets-page">
      <div className="sn-main">
        <div className="sn-header">
          <div className="sn-search">
            <Search size={14} />
            <input
              value={query}
              placeholder="搜索名称 / 命令 / 描述 / 分组 / 标签"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="sn-icon-btn" title="清空" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            )}
          </div>

          <div className="sn-menu-wrap">
            <button
              className="sn-btn"
              onClick={() => setOpenMenu(openMenu === "new" ? null : "new")}
            >
              <Plus size={14} />
              新建
              <ChevronDown size={13} className={openMenu === "new" ? "is-rotated" : ""} />
            </button>
            {openMenu === "new" && (
              <div
                className="sn-dropdown sn-new-menu"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button onClick={() => openNew("")}>
                  <Zap size={16} className="sn-accent-sky" />
                  新建片段
                </button>
                <button onClick={() => openNew("script")}>
                  <Play size={16} className="sn-accent-violet" />
                  新建脚本
                </button>
                <button
                  onClick={() => {
                    setOpenMenu(null);
                    setPkgNew("");
                  }}
                >
                  <FolderPlus size={16} className="sn-accent-primary" />
                  新建分组
                </button>
              </div>
            )}
          </div>

          <button className="sn-btn" onClick={() => importRef.current?.click()} disabled={busy}>
            <Upload size={14} />
            导入
          </button>
          <button
            className="sn-btn"
            onClick={() => {
              downloadExport(snippets, "termx-snippets");
              setNotice(`已导出 ${snippets.length} 条`);
            }}
            disabled={!snippets.length}
          >
            <Download size={14} />
            导出
          </button>

          <div className="sn-spacer" />

          <div className="sn-menu-wrap">
            <button
              className="sn-icon-btn"
              title="视图"
              onClick={() => setOpenMenu(openMenu === "view" ? null : "view")}
            >
              {viewMode === "grid" ? <LayoutGrid size={16} /> : <ListIcon size={16} />}
              <ChevronDown size={10} />
            </button>
            {openMenu === "view" && (
              <div
                className="sn-dropdown sn-align-end"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  className={viewMode === "grid" ? "is-active" : ""}
                  onClick={() => setViewMode("grid")}
                >
                  <LayoutGrid size={14} /> 卡片视图
                </button>
                <button
                  className={viewMode === "list" ? "is-active" : ""}
                  onClick={() => setViewMode("list")}
                >
                  <ListIcon size={14} /> 列表视图
                </button>
              </div>
            )}
          </div>

          <div className="sn-menu-wrap">
            <button
              className="sn-icon-btn"
              title={`排序：${SNIPPET_SORT_LABELS[sortMode]}`}
              onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
            >
              <ChevronDown size={16} />
            </button>
            {openMenu === "sort" && (
              <div
                className="sn-dropdown sn-align-end"
                onMouseDown={(e) => e.stopPropagation()}
              >
                {(Object.keys(SNIPPET_SORT_LABELS) as SnippetSortMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={sortMode === mode ? "is-active" : ""}
                    onClick={() => setSortMode(mode)}
                  >
                    {SNIPPET_SORT_LABELS[mode]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className={`sn-icon-btn${multiSelect ? " is-active" : ""}`}
            title="多选"
            onClick={() => {
              setMultiSelect((v) => !v);
              setSelectedIds(new Set());
            }}
          >
            <CheckSquare size={16} />
          </button>

          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void readImportFile(f);
            }}
          />
        </div>

        {multiSelect && (
          <div className="sn-selection">
            <span>已选 {selectedIds.size} 条</span>
            <div className="sn-spacer" />
            <button onClick={() => setSelectedIds(new Set(displayedSnippets.map((s) => s.id)))}>
              全选可见
            </button>
            <button onClick={() => setSelectedIds(new Set())}>取消全选</button>
            <button className="is-primary" disabled={!selectedIds.size} onClick={exportSelected}>
              <Download size={12} /> 导出所选（{selectedIds.size}）
            </button>
            <button className="is-danger" disabled={!selectedIds.size} onClick={deleteSelected}>
              <Trash2 size={12} /> 删除所选（{selectedIds.size}）
            </button>
            <button
              className="sn-icon-btn"
              onClick={() => {
                setMultiSelect(false);
                setSelectedIds(new Set());
              }}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {run && (
          <div className="sn-runbar">
            <span className="sn-run-dot" />
            正在运行「{run.name}」
            <button onClick={() => controlRun("stop")}>停止</button>
            <button onClick={() => controlRun("pause")}>暂停</button>
            <button onClick={() => controlRun("resume")}>恢复</button>
            <span className="sn-run-hint">停止 = Ctrl-C；暂停 = Ctrl-Z；恢复 = fg</span>
          </div>
        )}

        {(err || notice) && (
          <div className={`sn-message${err ? " is-error" : ""}`} onClick={() => setErr("")}>
            {err || notice}
          </div>
        )}

        <div className="sn-breadcrumb">
          <button
            onDragOver={dragOverPackage}
            onDrop={(e) => dropOnPackage(e, "")}
            onClick={() => setPkgFilter("")}
          >
            全部分组
          </button>
          {breadcrumb.map((b) => (
            <span key={b.path}>
              <span className="sn-crumb-sep">/</span>
              <button
                onDragOver={dragOverPackage}
                onDrop={(e) => dropOnPackage(e, b.path)}
                onClick={() => setPkgFilter(b.path)}
              >
                {b.name}
              </button>
            </span>
          ))}
        </div>

        {snippets.length === 0 ? (
          <div className="sn-empty">
            <div className="sn-empty-icon">
              <FileCode size={32} />
            </div>
            <h3>还没有片段或脚本</h3>
            <p>新建片段保存常用命令；新建脚本可发送到当前会话执行或按条件自动触发。</p>
            <button className="sn-btn is-primary" onClick={() => openNew("")}>
              <Plus size={14} /> 新建片段
            </button>
          </div>
        ) : (
          <div className="sn-list">
            {childPackages.length > 0 && (
              <section className="sn-section">
                <h4>分组</h4>
                <div className={viewMode === "grid" ? "sn-grid" : "sn-rows"}>
                  {childPackages.map(renderPackageCard)}
                </div>
              </section>
            )}

            {displayedSnippets.length > 0 && (
              <section className="sn-section">
                <h4>片段</h4>
                <div className={viewMode === "grid" ? "sn-grid" : "sn-rows"}>
                  {displayedSnippets.map(renderSnippetCard)}
                </div>
              </section>
            )}

            {displayedSnippets.length === 0 && childPackages.length === 0 && (
              <div className="sn-noresult">
                <div className="sn-empty-icon is-sm">
                  <Search size={24} />
                </div>
                <h3>{query.trim() ? "没有匹配的条目" : "此分组为空"}</h3>
                <p>{query.trim() ? `换个关键词试试（${query.trim()}）` : "从「全部分组」返回，或在此分组下新建。"}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {draft && (
        <aside className="sn-panel">
          <header className="sn-panel-head">
            <h3>
              {isScript
                ? isNew
                  ? "新建脚本"
                  : "编辑脚本"
                : isNew
                  ? "新建片段"
                  : "编辑片段"}
            </h3>
            <div className="sn-panel-actions">
              {!isNew && (
                <button
                  className="sn-icon-btn is-danger"
                  title="删除"
                  onClick={() => {
                    const s = snippets.find((x) => x.id === draft.id);
                    if (s) removeSnippet(s);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              )}
              <button
                className="sn-icon-btn"
                title="保存"
                disabled={!canSubmit || busy}
                onClick={() => saveDraft()}
              >
                <Check size={16} />
              </button>
              <button className="sn-icon-btn" title="关闭" onClick={() => setDraft(null)}>
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="sn-panel-body">
            <div className="sn-card">
              <p className="sn-card-title">名称 *</p>
              <input
                className="sn-input"
                value={draft.name}
                placeholder="如：查看磁盘用量"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <textarea
                className="sn-textarea"
                value={draft.description}
                rows={2}
                placeholder="描述（可选）"
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>

            <div className="sn-card">
              <p className="sn-card-title">分组</p>
              <input
                className="sn-input"
                value={draft.package}
                placeholder="如 ops/db；留空 = 未分组"
                list="sn-package-options"
                onChange={(e) => setDraft({ ...draft, package: e.target.value })}
              />
              <datalist id="sn-package-options">
                {packageTree.map((p) => (
                  <option key={p.path} value={p.path} />
                ))}
              </datalist>
            </div>

            <div className="sn-card">
              <div className="sn-card-row">
                <p className="sn-card-title">{isScript ? "脚本内容 *" : "命令 *"}</p>
                <button
                  className="sn-mini-btn"
                  onClick={() => setScriptExpanded(true)}
                  title="放大编辑"
                >
                  <Maximize2 size={13} /> 放大
                </button>
              </div>
              <textarea
                className="sn-code"
                value={draft.command}
                placeholder={isScript ? "如：\nset -e\nuptime" : "如：df -h"}
                spellCheck={false}
                rows={8}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              />
              {!isScript && (
                <>
                  <p className="sn-hint">
                    变量占位符：<code>{"{{name}}"}</code>、<code>{"{{name:默认值}}"}</code>
                  </p>
                  {variables.length > 0 && (
                    <div className="sn-vars">
                      <span className="sn-vars-label">检测到变量：</span>
                      {variables.map((v) => (
                        <span key={v.name} className="sn-var">
                          {v.name}
                          {v.defaultValue !== undefined && (
                            <em>（{v.defaultValue}）</em>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {isScript && (
              <div className="sn-card">
                <p className="sn-card-title">触发方式</p>
                <select
                  className="sn-input"
                  value={resolveScriptTrigger(draft.trigger)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraft({
                      ...draft,
                      trigger: v === "onConnect" || v === "onOutput" ? v : "",
                    });
                  }}
                >
                  <option value="manual">手动运行</option>
                  <option value="onConnect">连接后自动执行（仅 SSH）</option>
                  <option value="onOutput">输出匹配自动执行</option>
                </select>
                {draft.trigger === "onOutput" && (
                  <input
                    className="sn-input is-mono"
                    value={draft.triggerPattern}
                    placeholder="sudo.*password"
                    onChange={(e) => setDraft({ ...draft, triggerPattern: e.target.value })}
                  />
                )}
                <p className="sn-hint">{scriptTriggerNote(draft.trigger)}</p>
              </div>
            )}

            {isScript && (
              <div className="sn-card">
                <div className="sn-card-row">
                  <p className="sn-card-title">目标主机</p>
                  <div className="sn-card-actions">
                    {!draft.targetsAllHosts && (
                      <button
                        className="sn-mini-btn is-primary"
                        onClick={() => setTargetPicker((v) => !v)}
                      >
                        <Server size={12} /> 选择主机
                      </button>
                    )}
                    <button
                      className={`sn-mini-btn${draft.targetsAllHosts ? " is-on" : ""}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          targetsAllHosts: !draft.targetsAllHosts,
                          targets: draft.targetsAllHosts ? draft.targets : [],
                        })
                      }
                    >
                      <FolderTree size={12} /> 所有主机
                    </button>
                  </div>
                </div>
                {draft.targetsAllHosts ? (
                  <p className="sn-hint">对所有主机生效。</p>
                ) : targetPicker ? (
                  <div className="sn-host-list">
                    {hosts.length === 0 ? (
                      <p className="sn-hint">本机还没有主机。</p>
                    ) : (
                      hosts.map((h) => (
                        <label key={h.id} className="sn-host">
                          <input
                            type="checkbox"
                            checked={draft.targets.includes(h.id)}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                targets: e.target.checked
                                  ? [...draft.targets, h.id]
                                  : draft.targets.filter((x) => x !== h.id),
                              })
                            }
                          />
                          <span>{h.name}</span>
                          <em>{h.host}</em>
                        </label>
                      ))
                    )}
                  </div>
                ) : draft.targets.length === 0 ? (
                  <button
                    className="sn-btn is-secondary is-block"
                    onClick={() => setTargetPicker(true)}
                  >
                    添加目标主机
                  </button>
                ) : (
                  <div className="sn-target-pills">
                    {draft.targets.map((id) => {
                      const h = hosts.find((x) => x.id === id);
                      if (!h) return null;
                      return (
                        <span key={id} className="sn-target-pill">
                          <Server size={12} />
                          {h.name}
                          <button
                            onClick={() =>
                              setDraft({
                                ...draft,
                                targets: draft.targets.filter((x) => x !== id),
                              })
                            }
                          >
                            <X size={10} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isScript && (
              <>
                <label className="sn-checkline">
                  <input
                    type="checkbox"
                    checked={draft.noAutoRun}
                    onChange={(e) => setDraft({ ...draft, noAutoRun: e.target.checked })}
                  />
                  <span>仅插入，不自动执行（不发送回车）</span>
                </label>

                <div className="sn-card">
                  <p className="sn-card-title">多行发送</p>
                  <select
                    className="sn-input"
                    value={draft.multiLineRunMode || "paste"}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        multiLineRunMode:
                          e.target.value === "lineDelay" ? "lineDelay" : "",
                      })
                    }
                  >
                    <option value="paste">一次性发送</option>
                    <option value="lineDelay">逐行发送（每行 250ms）</option>
                  </select>
                  <p className="sn-hint">仅多行且自动执行时生效。</p>
                </div>

                <div className="sn-card">
                  <div className="sn-card-row">
                    <p className="sn-card-title">快捷键</p>
                    {draft.shortkey && (
                      <button
                        className="sn-mini-btn"
                        title="清除快捷键"
                        onClick={() => setDraft({ ...draft, shortkey: "" })}
                      >
                        <RotateCcw size={12} />
                      </button>
                    )}
                  </div>
                  <button
                    className={`sn-record${recording ? " is-recording" : ""}`}
                    onClick={() => setRecording((v) => !v)}
                  >
                    <Keyboard size={14} />
                    {recording
                      ? "请按下组合键…（Esc 取消）"
                      : draft.shortkey || "点击录制快捷键"}
                  </button>
                  <p className="sn-hint">终端获得焦点时按快捷键插入到当前会话。</p>
                </div>

                <div className="sn-card">
                  <p className="sn-card-title">标签</p>
                  <input
                    className="sn-input"
                    value={draft.tagsText}
                    placeholder="用逗号分隔"
                    onChange={(e) => setDraft({ ...draft, tagsText: e.target.value })}
                  />
                </div>
              </>
            )}
          </div>

          <footer className="sn-panel-foot">
            <button
              className="sn-btn is-primary is-block"
              disabled={!canSubmit || busy}
              onClick={() => {
                if (isScript && canRunActive) {
                  const saved = saveDraft();
                  if (saved) runScript(saved, true);
                } else {
                  saveDraft();
                }
              }}
            >
              {isScript && canRunActive ? "保存并运行" : "保存"}
            </button>
            {isScript && !canRunActive && (
              <p className="sn-hint is-center">运行需要先在终端打开一个已连接的会话。</p>
            )}
          </footer>
        </aside>
      )}

      {scriptExpanded && draft && (
        <div className="sn-modal-backdrop" onClick={() => setScriptExpanded(false)}>
          <div className="sn-modal is-wide" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>{isScript ? "脚本内容" : "命令内容"}</h3>
              <button className="sn-icon-btn" onClick={() => setScriptExpanded(false)}>
                <X size={16} />
              </button>
            </header>
            <textarea
              className="sn-code is-fill"
              value={draft.command}
              autoFocus
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
            <footer>
              <button className="sn-btn" onClick={() => setScriptExpanded(false)}>
                关闭
              </button>
            </footer>
          </div>
        </div>
      )}

      {varPrompt && (
        <div className="sn-modal-backdrop" onClick={() => setVarPrompt(null)}>
          <div className="sn-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>填写变量</h3>
              <button className="sn-icon-btn" onClick={() => setVarPrompt(null)}>
                <X size={16} />
              </button>
            </header>
            <div className="sn-var-list">
              <p className="sn-hint">
                运行「{varPrompt.snippet.name}」前请填写命令里的变量。
              </p>
              {Object.entries(varPrompt.values).map(([name, value]) => (
                <label key={name} className="sn-var-row">
                  <span>{name}</span>
                  <input
                    className="sn-input"
                    value={value}
                    autoFocus
                    onChange={(e) =>
                      setVarPrompt((prev) =>
                        prev ? { ...prev, values: { ...prev.values, [name]: e.target.value } } : prev,
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <footer>
              <button className="sn-btn" onClick={() => setVarPrompt(null)}>
                取消
              </button>
              <button className="sn-btn is-primary" onClick={confirmVarPrompt}>
                运行
              </button>
            </footer>
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          className="sn-ctx"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxPkg ? (
            <>
              <button onClick={() => { setPkgFilter(ctxPkg.path); setCtxMenu(null); }}>
                打开
              </button>
              <button onClick={() => { exportPackage(ctxPkg.path); setCtxMenu(null); }}>
                <Download size={16} /> 导出分组
              </button>
              <button
                onClick={() => {
                  setPkgRename({ from: ctxPkg.path, to: ctxPkg.path });
                  setCtxMenu(null);
                }}
              >
                重命名
              </button>
              <button
                className="is-danger"
                onClick={() => { removePackage(ctxPkg.path); setCtxMenu(null); }}
              >
                <Trash2 size={16} /> 删除
              </button>
            </>
          ) : ctxSnippet ? (
            <>
              <button
                disabled={!canRunActive}
                title={canRunActive ? "发送到活动终端" : "活动终端未连接"}
                onClick={() => { runScript(ctxSnippet); setCtxMenu(null); }}
              >
                <Play size={16} /> 运行
              </button>
              <hr />
              <button onClick={() => { openEdit(ctxSnippet); setCtxMenu(null); }}>
                <Edit2 size={16} /> 编辑
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(ctxSnippet.command);
                  setNotice("已复制命令");
                  setCtxMenu(null);
                }}
              >
                <Copy size={16} /> 复制
              </button>
              <button
                onClick={() => {
                  downloadExport([ctxSnippet], `termx-snippet-${ctxSnippet.name}`);
                  setCtxMenu(null);
                }}
              >
                <Download size={16} /> 导出
              </button>
              <button
                className="is-danger"
                onClick={() => { removeSnippet(ctxSnippet); setCtxMenu(null); }}
              >
                <Trash2 size={16} /> 删除
              </button>
            </>
          ) : null}
        </div>
      )}

      {pkgNew !== null && (
        <div className="sn-modal-backdrop" onClick={() => setPkgNew(null)}>
          <div className="sn-modal" onClick={(e) => e.stopPropagation()}>
            <h3>新建分组</h3>
            <input
              className="sn-input"
              autoFocus
              value={pkgNew}
              placeholder="如 ops 或 ops/db"
              onChange={(e) => setPkgNew(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyPkgNew();
                if (e.key === "Escape") setPkgNew(null);
              }}
            />
            <p className="sn-hint">分组由条目的「分组」字段派生，进入分组后新建条目会自动填入。</p>
            <div className="sn-modal-actions">
              <button className="sn-btn" onClick={() => setPkgNew(null)}>取消</button>
              <button className="sn-btn is-primary" disabled={!pkgNew.trim()} onClick={applyPkgNew}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {pkgRename && (
        <div className="sn-modal-backdrop" onClick={() => setPkgRename(null)}>
          <div className="sn-modal" onClick={(e) => e.stopPropagation()}>
            <h3>重命名分组</h3>
            <input
              className="sn-input"
              autoFocus
              value={pkgRename.to}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyPkgRename();
                if (e.key === "Escape") setPkgRename(null);
              }}
              onChange={(e) => setPkgRename({ ...pkgRename, to: e.target.value })}
            />
            <p className="sn-hint">
              子分组会一并改名（{pkgRename.from}/db → {pkgRename.to.trim() || "<新名>"}/db）。
            </p>
            <div className="sn-modal-actions">
              <button className="sn-btn" onClick={() => setPkgRename(null)}>取消</button>
              <button
                className="sn-btn is-primary"
                disabled={!pkgRename.to.trim() || pkgRename.to.trim() === pkgRename.from}
                onClick={applyPkgRename}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {importPending && (
        <div className="sn-modal-backdrop" onClick={() => setImportPending(null)}>
          <div className="sn-modal" onClick={(e) => e.stopPropagation()}>
            <h3>导入片段</h3>
            <p>
              共 {importPending.payload.snippets.length} 条，其中{" "}
              <strong>{importPending.conflicts}</strong> 条与本地命令重复。
            </p>
            <p className="sn-hint">重复条目按命令判定：覆盖 = 用导入项替换本地；跳过 = 保留本地。</p>
            <div className="sn-modal-actions">
              <button className="sn-btn" onClick={() => setImportPending(null)}>取消</button>
              <button className="sn-btn" disabled={busy} onClick={() => void applyImport("skip")}>
                跳过重复
              </button>
              <button
                className="sn-btn is-primary"
                disabled={busy}
                onClick={() => void applyImport("overwrite")}
              >
                覆盖重复
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
