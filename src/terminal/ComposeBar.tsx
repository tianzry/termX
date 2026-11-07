// 终端撰写栏（对照 Netcatty `TerminalComposeBar`）。
//
// 结构：固定在终端底部，体型自上而下为
// 顶边 6px 拖拽条 → 30px 快捷片段条（固定片段 chips + 管理浮层）→ 文本区 + 关闭按钮；
// 高度默认 120px、可拖拽 72–360px 并持久化，内容不撑高，textarea 内部滚动。
// 键盘：Enter 发送全部 / Shift+Enter 只发送光标所在行 / Ctrl+Enter 换行 /
// Alt·Cmd+Enter 发送 / Esc 关闭；↑↓ 在首末行翻阅本会话的撰写历史；输入法组合态一律交还给输入法。
// 片段：单击立即发送，Shift+单击只插入到输入框（含 {{变量}} 的片段先弹填值框再按该语义执行）。
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Pin, Plus, Search, X } from "lucide-react";
import type { Snippet } from "../backend/client";
import { useSettings } from "../settings/settingsStore";
import { isDarkTerminal, TERM_THEME_DARK, TERM_THEME_LIGHT } from "../Terminal";
import {
  COMPOSE_PINNED_STORAGE_KEY,
  buildComposeSnippetMap,
  filterComposeBarSnippets,
  insertSnippetIntoCompose,
  parsePinnedIds,
  prunePinnedIds,
  resolveComposeDefaultPinned,
  togglePinnedId,
} from "./composeBarSnippets";
import {
  COMPOSE_BAR_DEFAULT_HEIGHT,
  canNavigateComposeHistory,
  clampComposeBarHeight,
  navigateComposeHistory,
  resolveComposeKeyAction,
  sliceComposeLine,
  type ComposeHistoryState,
} from "./composeBarModel";
import { parseSnippetVariables } from "../snippets/snippetsModel";

const COMPOSE_BAR_HEIGHT_STORAGE_KEY = "termx.composeBar.height";

function readStoredHeight(): number {
  try {
    const raw = window.localStorage.getItem(COMPOSE_BAR_HEIGHT_STORAGE_KEY);
    if (!raw) return COMPOSE_BAR_DEFAULT_HEIGHT;
    return clampComposeBarHeight(Number(raw));
  } catch {
    return COMPOSE_BAR_DEFAULT_HEIGHT;
  }
}

function readPinned(): string[] | null {
  try {
    const raw = window.localStorage.getItem(COMPOSE_PINNED_STORAGE_KEY);
    if (raw === null) return null;
    return parsePinnedIds(raw);
  } catch {
    return [];
  }
}

function writePinned(ids: string[]) {
  try {
    window.localStorage.setItem(COMPOSE_PINNED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 存储不可用时仅本次生效。
  }
}

export interface ComposeBarProps {
  value: string;
  onChange: (next: string) => void;
  /** 返回 false 表示未发送（例如会话未连接），此时保留草稿。 */
  onSend: (text: string) => boolean;
  onClose: () => void;
  /** 本窗格的撰写发送历史（由最近到最早追加）。 */
  history: readonly string[];
  /** 是否能够发送；未连接时允许编辑草稿，但 Enter 不清空。 */
  connected: boolean;
  /** 仓库片段（顶部快捷条的数据源；内置 4 条在无片段时兜底）。 */
  snippets?: readonly Snippet[];
  /** 单击片段：立即发送执行（复用脚本模块）；返回 false 表示未连接。 */
  onRunSnippet?: (snippet: Snippet) => boolean;
  /**
   * 含 {{变量}} 的片段：交给父级弹填值框；填完按 mode 直接发送或只插入草稿。
   * （填值框由 TerminalPane 持有，避免把变量收集逻辑搬进撰写栏。）
   */
  onSnippetVariables?: (snippet: Snippet, mode: "send" | "insert") => void;
}

export function ComposeBar({
  value,
  onChange,
  onSend,
  onClose,
  history,
  connected,
  snippets = [],
  onRunSnippet,
  onSnippetVariables,
}: ComposeBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [height, setHeight] = useState(readStoredHeight);
  const heightRef = useRef(height);
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  const historyStateRef = useRef<ComposeHistoryState>({
    index: Number.POSITIVE_INFINITY,
    draft: "",
  });
  /** 顶部快捷片段条：固定 id、管理浮层与搜索。 */
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinned() ?? []);
  const [manageOpen, setManageOpen] = useState(false);
  const [snippetQuery, setSnippetQuery] = useState("");

  // 固定片段 chip 配色对齐 Netcatty：以终端主题的前景/背景混色，
  // 深色终端不再是突兀的浅灰底（6% 前景 + 94% 背景，hover 12%/88%）。
  const settings = useSettings();
  const termTheme = isDarkTerminal(settings)
    ? TERM_THEME_DARK
    : TERM_THEME_LIGHT;
  const chipThemeVars = {
    "--compose-chip-bg": termTheme.background ?? "#ffffff",
    "--compose-chip-fg": termTheme.foreground ?? "#16202b",
  } as CSSProperties;

  const snippetMap = useMemo(() => buildComposeSnippetMap(snippets), [snippets]);
  const pinnedSnippets = useMemo(
    () =>
      pinnedIds
        .map((id) => snippetMap.get(id))
        .filter((s): s is Snippet => Boolean(s)),
    [pinnedIds, snippetMap],
  );
  const manageSnippets = useMemo(
    () => filterComposeBarSnippets(snippets, snippetQuery),
    [snippets, snippetQuery],
  );

  // 首次使用：按 Netcatty 语义固定前 4 条；片段为空时延迟 300ms 用内置兜底。
  useEffect(() => {
    if (readPinned() !== null) return;
    const seed = resolveComposeDefaultPinned(snippets);
    const apply = () => {
      if (readPinned() !== null) return;
      writePinned(seed);
      setPinnedIds(seed);
    };
    if (seed.every((id) => id.startsWith("__compose_builtin_"))) {
      const timer = window.setTimeout(apply, 300);
      return () => window.clearTimeout(timer);
    }
    apply();
  }, [snippets]);

  // 片段被删除后同步剔除失效的固定项（内置项保留）。
  useEffect(() => {
    setPinnedIds((prev) => {
      const next = prunePinnedIds(
        prev,
        snippets.map((s) => s.id),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [snippets]);

  // 管理浮层：点击外部 / Esc 关闭（Netcatty Tooltip/Popover 同语义）。
  useEffect(() => {
    if (!manageOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".term-compose-snippet-strip")
      ) {
        return;
      }
      setManageOpen(false);
      setSnippetQuery("");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setManageOpen(false);
        setSnippetQuery("");
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [manageOpen]);

  function updatePinned(next: string[]) {
    setPinnedIds(next);
    writePinned(next);
  }

  /**
   * 片段激活：单击 = 直接发送，Shift+单击 = 只插入草稿。
   * 含 {{变量}} 时先交由父级弹填值框，填完再按同一语义发送或插入。
   */
  function handleSnippetActivate(snippet: Snippet, mode: "send" | "insert") {
    if (parseSnippetVariables(snippet.command).length > 0) {
      onSnippetVariables?.(snippet, mode);
      return;
    }
    if (mode === "send") {
      // 未连接时退回插入，避免点击无反馈、内容丢失。
      if (onRunSnippet?.(snippet)) return;
    }
    const insertion = insertSnippetIntoCompose(value, snippet.command);
    resetHistory();
    onChange(insertion.value);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(insertion.cursor, insertion.cursor);
    });
  }

  heightRef.current = height;

  useEffect(() => {
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => cleanupResizeRef.current?.(), []);

  function resetHistory() {
    historyStateRef.current = { index: Number.POSITIVE_INFINITY, draft: "" };
  }

  function handleChange(next: string) {
    resetHistory();
    onChange(next);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = event.currentTarget;
    const action = resolveComposeKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      canHistoryUp: canNavigateComposeHistory(
        el.value,
        el.selectionStart,
        "up",
        el.selectionEnd,
      ),
      canHistoryDown: canNavigateComposeHistory(
        el.value,
        el.selectionStart,
        "down",
        el.selectionEnd,
      ),
    });

    if (action === "send") {
      event.preventDefault();
      send();
      return;
    }
    if (action === "send-line") {
      event.preventDefault();
      sendCurrentLine();
      return;
    }
    if (action === "newline") {
      event.preventDefault();
      insertNewline();
      return;
    }
    if (action === "close") {
      event.preventDefault();
      onClose();
      return;
    }
    if (action === "history-up" || action === "history-down") {
      const direction = action === "history-up" ? "up" : "down";
      const result = navigateComposeHistory(
        history,
        historyStateRef.current,
        el.value,
        direction,
      );
      if (!result) return;
      event.preventDefault();
      historyStateRef.current = {
        index: result.index === history.length ? Number.POSITIVE_INFINITY : result.index,
        draft: result.draft,
      };
      onChange(result.value);
      const position = direction === "up" ? 0 : result.value.length;
      requestAnimationFrame(() => el.setSelectionRange(position, position));
    }
  }

  function send() {
    const text = value;
    if (!text.trim()) return;
    if (!connected || !onSend(text)) return;
    resetHistory();
    onChange("");
    textareaRef.current?.focus();
  }

  /** Shift+Enter：只发送光标所在行，其余内容留在草稿里（光标落在被删处）。 */
  function sendCurrentLine() {
    const el = textareaRef.current;
    if (!el) return;
    const slice = sliceComposeLine(value, el.selectionStart);
    if (!slice.line.trim()) return;
    if (!connected || !onSend(slice.line)) return;
    resetHistory();
    onChange(slice.rest);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(slice.cursor, slice.cursor);
    });
  }

  /** Ctrl+Enter：在光标处插入换行，不发送（浏览器默认不会为 Ctrl+Enter 换行）。 */
  function insertNewline() {
    const el = textareaRef.current;
    if (!el) return;
    const start = Math.max(0, Math.min(el.selectionStart, value.length));
    const end = Math.max(start, Math.min(el.selectionEnd, value.length));
    const next = `${value.slice(0, start)}\n${value.slice(end)}`;
    handleChange(next);
    const cursor = start + 1;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.setSelectionRange(cursor, cursor);
    });
  }

  function handleResizeStart(event: React.MouseEvent) {
    event.preventDefault();
    cleanupResizeRef.current?.();
    const startY = event.clientY;
    const startHeight = heightRef.current;

    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: MouseEvent) => {
      const next = clampComposeBarHeight(startHeight + (startY - moveEvent.clientY));
      heightRef.current = next;
      setHeight(next);
    };
    const cleanup = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      cleanupResizeRef.current = null;
    };
    const onUp = () => {
      try {
        window.localStorage.setItem(
          COMPOSE_BAR_HEIGHT_STORAGE_KEY,
          String(heightRef.current),
        );
      } catch {
        // 存储不可用时仅本次生效。
      }
      cleanup();
    };

    cleanupResizeRef.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      className="term-compose-bar"
      style={{ height, ...chipThemeVars }}
      data-section="terminal-compose-bar"
    >
      <div
        className="term-compose-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整撰写栏高度"
        title="拖拽调整撰写栏高度"
        onMouseDown={handleResizeStart}
      />
      <div
        className="term-compose-snippet-strip"
        data-section="compose-snippets"
      >
        <div className="term-compose-snippet-scroll">
          {pinnedSnippets.map((snippet) => (
            <div
              className="term-compose-chip"
              key={snippet.id}
              title={`${snippet.name}\n${snippet.command.split("\n")[0]}\n点击直接发送，Shift+点击插入到输入框`}
            >
              <button
                type="button"
                className="term-compose-chip-label"
                onClick={(event) =>
                  handleSnippetActivate(snippet, event.shiftKey ? "insert" : "send")
                }
              >
                {snippet.name}
              </button>
              <button
                type="button"
                className="term-compose-chip-unpin"
                aria-label={`取消固定 ${snippet.name}`}
                onClick={() =>
                  updatePinned(pinnedIds.filter((id) => id !== snippet.id))
                }
              >
                <X size={9} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={`term-compose-snippet-manage${manageOpen ? " active" : ""}`}
          title="管理快捷片段"
          aria-label="管理快捷片段"
          aria-expanded={manageOpen}
          onClick={() => {
            setManageOpen((open) => !open);
            setSnippetQuery("");
          }}
        >
          <Plus size={12} />
        </button>

        {manageOpen && (
          <div className="term-compose-snippet-popover">
            <div className="term-compose-snippet-popover-head">
              <div className="term-compose-snippet-popover-title">
                快捷片段
              </div>
              <div className="term-compose-snippet-search">
                <Search size={11} />
                <input
                  value={snippetQuery}
                  onChange={(event) => setSnippetQuery(event.target.value)}
                  placeholder="搜索片段..."
                  aria-label="搜索片段"
                />
              </div>
            </div>
            <div className="term-compose-snippet-list">
              {snippets.length === 0 ? (
                <div className="term-compose-snippet-none">暂无片段</div>
              ) : manageSnippets.length === 0 ? (
                <div className="term-compose-snippet-none">没有匹配的片段</div>
              ) : (
                manageSnippets.map((snippet) => {
                  const pinned = pinnedIds.includes(snippet.id);
                  return (
                    <button
                      type="button"
                      key={snippet.id}
                      className={`term-compose-snippet-row${pinned ? " pinned" : ""}`}
                      onClick={() =>
                        updatePinned(togglePinnedId(pinnedIds, snippet.id))
                      }
                    >
                      <Pin
                        size={11}
                        className="term-compose-snippet-pin"
                        fill={pinned ? "currentColor" : "none"}
                      />
                      <span>{snippet.name}</span>
                    </button>
                  );
                })
              )}
            </div>
            {pinnedSnippets.length > 0 && (
              <div className="term-compose-snippet-foot">
                已固定 {pinnedSnippets.length} 个片段
              </div>
            )}
          </div>
        )}
      </div>
      <div className="term-compose-body">
        <textarea
          ref={textareaRef}
          className="term-compose-input"
          value={value}
          placeholder="回车发送全部 · Shift+回车发送当前行 · Ctrl+回车换行"
          aria-label="撰写栏"
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="term-compose-close"
          title="关闭撰写栏"
          aria-label="关闭撰写栏"
          onClick={onClose}
        >
          <span className="term-compose-close-icon" aria-hidden="true">
            ×
          </span>
        </button>
      </div>
    </div>
  );
}
