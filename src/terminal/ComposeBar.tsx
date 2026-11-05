// 终端撰写栏（对照 Netcatty `TerminalComposeBar`）。
//
// 结构：固定在终端底部、顶边 6px 拖拽条 + 文本区 + 关闭按钮；
// 高度默认 120px、可拖拽 72–360px 并持久化，内容不撑高，textarea 内部滚动。
// 键盘：Enter 发送 / Shift+Enter 换行 / Ctrl·Alt·Cmd+Enter 发送 / Esc 关闭；
// ↑↓ 在首末行翻阅本会话的撰写历史；输入法组合态一律交还给输入法。
import { useEffect, useRef, useState } from "react";
import {
  COMPOSE_BAR_DEFAULT_HEIGHT,
  canNavigateComposeHistory,
  clampComposeBarHeight,
  navigateComposeHistory,
  resolveComposeKeyAction,
  type ComposeHistoryState,
} from "./composeBarModel";

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
}

export function ComposeBar({
  value,
  onChange,
  onSend,
  onClose,
  history,
  connected,
}: ComposeBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [height, setHeight] = useState(readStoredHeight);
  const heightRef = useRef(height);
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  const historyStateRef = useRef<ComposeHistoryState>({
    index: Number.POSITIVE_INFINITY,
    draft: "",
  });

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
      style={{ height }}
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
      <div className="term-compose-body">
        <textarea
          ref={textareaRef}
          className="term-compose-input"
          value={value}
          placeholder="在此输入命令，按回车发送..."
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
