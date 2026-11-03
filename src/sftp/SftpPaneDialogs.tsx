/**
 * SFTP 双栏文件操作浮层（右键菜单 / 重命名 / 新建文件夹 / 删除确认 / 权限）。
 * 交互基准为 Netcatty SftpPaneFileList + SftpPaneDialogs + SftpPermissionsDialog
 * 的 termX 范围子集：
 * - 重命名 / 新建文件夹走弹窗（非行内编辑），Enter 确认、Esc 取消；
 * - 删除确认显示目标名，删除中禁用按钮；
 * - 权限弹窗 3×3 复选 + 实时八进制展示（仅远端侧使用）。
 */

import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  permsFromMode,
  permsToOctal,
  type PermGroup,
  type PermMatrix,
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
    <div ref={ref} className="nc-sftp-ctx" style={{ left: x, top: y }}>
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
