/**
 * SFTP 双栏文件操作浮层（右键菜单 / 重命名 / 新建文件夹 / 删除确认 / 权限）。
 * 交互基准为 Netcatty SftpPaneFileList + SftpPaneDialogs + SftpPermissionsDialog
 * 的 termX 范围子集：
 * - 重命名 / 新建文件夹走弹窗（非行内编辑），Enter 确认、Esc 取消；
 * - 删除确认显示目标名，删除中禁用按钮；
 * - 权限弹窗 3×3 复选 + 实时八进制展示（仅远端侧使用）。
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  Globe,
  GripVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  canReorderSftpBookmark,
  getSftpBookmarkIdentity,
  getSftpBookmarkMoveTargets,
  permsFromMode,
  permsToOctal,
  type PermGroup,
  type PermMatrix,
  type SftpBookmark,
} from "./sftpModel";

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

/** 定点渲染的右键菜单；点击外部或 Esc 关闭。 */
export function SftpContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** 视口内夹取后的落点（对齐 Netcatty Popover 的 avoidCollisions + 8px padding）。 */
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    // 右侧放不下 → 翻到锚点左侧；仍超出则贴右边。
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, x - rect.width);
      if (left + rect.width > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - pad - rect.width);
      }
    }
    // 下方放不下 → 向上翻；仍超出则贴底（配合 max-height 内部滚动）。
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - pad - rect.height);
    }
    setPos({ left, top });
  }, [x, y, items]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="nc-sftp-ctx" style={pos}>
      {items.map((it) => (
        <button
          key={it.label}
          className={
            it.danger ? "nc-sftp-ctx-item danger" : "nc-sftp-ctx-item"
          }
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 收藏弹层（对齐 Netcatty SftpBookmarkPopoverBody）：
 * 头部「收藏路径」+ 管理/完成；动作行收藏/取消收藏 + 「+全局」；
 * 列表支持点击跳转、悬停删除、管理态上移/下移/改名/拖拽排序。
 * 列表按「全局在前、本机在后」合并，跨 scope 插入时显示分组分隔线。
 */
export function SftpBookmarkPopover({
  x,
  y,
  bookmarks,
  currentPath,
  isCurrentPathBookmarked,
  isCurrentPathGlobalBookmarked,
  onToggle,
  onAddGlobal,
  onNavigate,
  onRequestDelete,
  onReorder,
  onRename,
  onClose,
}: {
  x: number;
  y: number;
  bookmarks: SftpBookmark[];
  currentPath: string;
  isCurrentPathBookmarked: boolean;
  isCurrentPathGlobalBookmarked: boolean;
  onToggle: () => void;
  onAddGlobal: () => void;
  onNavigate: (path: string) => void;
  onRequestDelete: (bookmark: SftpBookmark) => void;
  onReorder: (from: SftpBookmark, to: SftpBookmark) => void;
  onRename: (bookmark: SftpBookmark, label: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [managing, setManaging] = useState(false);
  const [dragging, setDragging] = useState<SftpBookmark | null>(null);
  const [renaming, setRenaming] = useState<SftpBookmark | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pos, setPos] = useState({ left: x, top: y });

  // 贴边夹取（对齐 Netcatty Popover avoidCollisions + 8px padding）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const rect = el.getBoundingClientRect();
    const left = Math.max(
      pad,
      Math.min(x, window.innerWidth - pad - rect.width),
    );
    const top = Math.max(
      pad,
      Math.min(y, window.innerHeight - pad - rect.height),
    );
    setPos({ left, top });
  }, [x, y, bookmarks.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const runThenClose = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="nc-sftp-bookmark-popover"
      style={pos}
      data-section="sftp-bookmark-popover"
    >
      <div className="nc-sftp-bookmark-header">
        <span>收藏路径</span>
        {bookmarks.length > 0 && (
          <button
            className="nc-sftp-bookmark-manage"
            onClick={() => setManaging((v) => !v)}
          >
            {managing ? "完成" : "管理"}
          </button>
        )}
      </div>
      <div className="nc-sftp-bookmark-actions">
        <button
          className={
            isCurrentPathBookmarked
              ? "nc-sftp-bookmark-action active"
              : "nc-sftp-bookmark-action"
          }
          aria-label={isCurrentPathBookmarked ? "取消收藏" : "收藏此路径"}
          onClick={() => runThenClose(onToggle)}
        >
          <Bookmark
            size={12}
            fill={isCurrentPathBookmarked ? "currentColor" : "none"}
            className={
              isCurrentPathBookmarked
                ? "nc-sftp-bookmark-icon bookmarked"
                : "nc-sftp-bookmark-icon"
            }
          />
          {isCurrentPathBookmarked ? "取消收藏" : "收藏此路径"}
        </button>
        {currentPath && !isCurrentPathGlobalBookmarked && (
          <button
            className="nc-sftp-bookmark-global"
            title="保存为全局收藏（所有主机共享）"
            onClick={() => runThenClose(onAddGlobal)}
          >
            +全局
          </button>
        )}
      </div>
      {bookmarks.length === 0 ? (
        <div className="nc-sftp-bookmark-empty">暂无收藏路径</div>
      ) : (
        <div className="nc-sftp-bookmark-list">
          {bookmarks.map((bm, index) => {
            const identity = getSftpBookmarkIdentity(bm);
            const startsHostGroup =
              index > 0 && !!bookmarks[index - 1]?.global && !bm.global;
            const targets = getSftpBookmarkMoveTargets(bookmarks, bm);
            const isDragging =
              !!dragging &&
              dragging.id === bm.id &&
              !!dragging.global === !!bm.global;
            const isRenaming =
              !!renaming &&
              renaming.id === bm.id &&
              !!renaming.global === !!bm.global;
            const content = (
              <>
                <div className="nc-sftp-bookmark-label">{bm.label}</div>
                <div className="nc-sftp-bookmark-path">{bm.path}</div>
              </>
            );
            return (
              <div
                key={identity}
                className={
                  "nc-sftp-bookmark-row" +
                  (startsHostGroup ? " host-group" : "") +
                  (isDragging ? " dragging" : "")
                }
                data-bookmark-scope={bm.global ? "global" : "location"}
                draggable={managing && !isRenaming}
                onDragStart={(event) => {
                  if (!managing) return;
                  setDragging(bm);
                  event.dataTransfer.setData(
                    "text/termx-sftp-bookmark",
                    identity,
                  );
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (
                    !managing ||
                    !dragging ||
                    (dragging.id === bm.id &&
                      !!dragging.global === !!bm.global) ||
                    !canReorderSftpBookmark(dragging, bm)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const transferred = event.dataTransfer.getData(
                    "text/termx-sftp-bookmark",
                  );
                  const source =
                    bookmarks.find(
                      (candidate) =>
                        getSftpBookmarkIdentity(candidate) === transferred,
                    ) ?? dragging;
                  setDragging(null);
                  if (
                    source &&
                    (source.id !== bm.id ||
                      !!source.global !== !!bm.global) &&
                    canReorderSftpBookmark(source, bm)
                  ) {
                    onReorder(source, bm);
                  }
                }}
                onDragEnd={() => setDragging(null)}
              >
                {managing && (
                  <GripVertical
                    size={12}
                    className="nc-sftp-bookmark-grip"
                    aria-hidden="true"
                  />
                )}
                {bm.global && (
                  <Globe size={10} className="nc-sftp-bookmark-globe" />
                )}
                {managing && isRenaming ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    aria-label="重命名收藏"
                    className="nc-sftp-bookmark-rename-input"
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onRename(bm, renameDraft);
                        setRenaming(null);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => {
                      onRename(bm, renameDraft);
                      setRenaming(null);
                    }}
                  />
                ) : managing ? (
                  <div className="nc-sftp-bookmark-content">{content}</div>
                ) : (
                  <button
                    className="nc-sftp-bookmark-content"
                    onClick={() => runThenClose(() => onNavigate(bm.path))}
                  >
                    {content}
                  </button>
                )}
                {managing && (
                  <>
                    <button
                      className="nc-sftp-bookmark-row-btn"
                      aria-label={`上移 ${bm.label}`}
                      disabled={!targets.previous}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (targets.previous) onReorder(bm, targets.previous);
                      }}
                    >
                      <ArrowUp size={10} />
                    </button>
                    <button
                      className="nc-sftp-bookmark-row-btn"
                      aria-label={`下移 ${bm.label}`}
                      disabled={!targets.next}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (targets.next) onReorder(bm, targets.next);
                      }}
                    >
                      <ArrowDown size={10} />
                    </button>
                  </>
                )}
                {managing && !isRenaming && (
                  <button
                    className="nc-sftp-bookmark-row-btn"
                    aria-label="重命名收藏"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRenaming(bm);
                      setRenameDraft(bm.label);
                    }}
                  >
                    <Pencil size={10} />
                  </button>
                )}
                <button
                  className={
                    managing
                      ? "nc-sftp-bookmark-row-btn remove always"
                      : "nc-sftp-bookmark-row-btn remove"
                  }
                  aria-label="删除收藏"
                  onClick={(event) => {
                    event.stopPropagation();
                    runThenClose(() => onRequestDelete(bm));
                  }}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 删除收藏确认（对齐 Netcatty ConfirmDialog destructive）。 */
export function SftpBookmarkDeleteDialog({
  bookmark,
  onConfirm,
  onClose,
}: {
  bookmark: SftpBookmark;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="nc-sftp-dialog-backdrop"
      role="dialog"
      aria-label="取消收藏"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nc-sftp-dialog">
        <h3>取消收藏</h3>
        <p className="nc-sftp-dialog-text">删除收藏 {bookmark.path}？</p>
        <div className="nc-sftp-dialog-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary danger-bg" onClick={onConfirm}>
            取消收藏
          </button>
        </div>
      </div>
    </div>
  );
}

function DialogShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="nc-sftp-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          // 点击遮罩关闭由父组件 onClose 处理
          (e.currentTarget as HTMLElement).dataset.hit = "1";
        }
      }}
    >
      <div className="nc-sftp-dialog">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** 单输入弹窗：重命名 / 新建文件夹共用。 */
export function SftpPromptDialog({
  title,
  initial,
  confirmLabel,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  confirmLabel: string;
  busy: boolean;
  error: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const ok = value.trim().length > 0 && !busy;
  return (
    <div
      className="nc-sftp-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="nc-sftp-dialog">
        <h3>{title}</h3>
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ok) onSubmit(value.trim());
            if (e.key === "Escape" && !busy) onClose();
          }}
        />
        {error && <div className="nc-sftp-dialog-error">{error}</div>}
        <div className="nc-sftp-dialog-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={!ok}
            onClick={() => onSubmit(value.trim())}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 删除确认：显示目标名，删除中禁用（对齐 Netcatty SftpPaneDialogs 删除节）。 */
export function SftpDeleteDialog({
  names,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  names: string[];
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const title = names.length > 1 ? `删除 ${names.length} 个项目` : "删除";
  return (
    <DialogShell title={title}>
      <p className="nc-sftp-dialog-text">
        确定要删除以下{names.length > 1 ? "项目" : "项目"}吗？此操作无法撤销。
      </p>
      <ul className="nc-sftp-dialog-list">
        {names.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      {error && <div className="nc-sftp-dialog-error">{error}</div>}
      <div className="nc-sftp-dialog-actions">
        <button onClick={onClose} disabled={busy}>
          取消
        </button>
        <button className="primary danger-bg" disabled={busy} onClick={onConfirm}>
          {busy ? "删除中..." : "删除"}
        </button>
      </div>
    </DialogShell>
  );
}

/** 权限弹窗：owner/group/others × read/write/execute + 实时八进制。 */
export function SftpPermissionsDialog({
  name,
  mode,
  busy,
  error,
  onApply,
  onClose,
}: {
  name: string;
  mode: number;
  busy: boolean;
  error: string;
  onApply: (mode: number) => void;
  onClose: () => void;
}) {
  const [matrix, setMatrix] = useState<PermMatrix>(() => permsFromMode(mode));
  const octal = permsToOctal(matrix);
  const toggle = (who: keyof PermMatrix, what: keyof PermGroup) =>
    setMatrix((prev) => ({
      ...prev,
      [who]: { ...prev[who], [what]: !prev[who][what] },
    }));
  const rows: Array<[keyof PermMatrix, string]> = [
    ["owner", "所有者"],
    ["group", "组"],
    ["others", "其他"],
  ];
  const cols: Array<[keyof PermGroup, string]> = [
    ["read", "读取"],
    ["write", "写入"],
    ["execute", "执行"],
  ];
  return (
    <DialogShell title={`权限 · ${name}`}>
      <div className="nc-sftp-perm-grid">
        <span />
        {cols.map(([, label]) => (
          <span key={label}>{label}</span>
        ))}
        {rows.map(([who, label]) => (
          <Fragment key={who}>
            <span>{label}</span>
            {cols.map(([what]) => (
              <label key={what}>
                <input
                  type="checkbox"
                  checked={matrix[who][what]}
                  disabled={busy}
                  onChange={() => toggle(who, what)}
                />
              </label>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="nc-sftp-perm-octal">八进制：{octal}</div>
      {error && <div className="nc-sftp-dialog-error">{error}</div>}
      <div className="nc-sftp-dialog-actions">
        <button onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => onApply(Number.parseInt(octal, 8))}
        >
          {busy ? "应用中..." : "应用"}
        </button>
      </div>
    </DialogShell>
  );
}
