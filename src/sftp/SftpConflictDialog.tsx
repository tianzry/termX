/**
 * SFTP 传输冲突对话框（阶段 C；对齐 Netcatty SftpConflictDialog 的文件冲突子集）：
 * - 标题 = 文件名 + 「已存在」（Netcatty DialogTitle 形状）；
 * - 说明区分方向：上传 → 远端目标已存在同名文件；下载 → 本地目标已存在同名文件；
 * - 按钮顺序对齐 Netcatty 右组：跳过 | 创建副本 | 替换；
 *   替换为破坏性覆盖（termX 无 merge 选项，替换总是覆盖 → 恒用危险样式）；
 * - 「将此操作应用到剩余的 N 个冲突」按批次生效（后端 conflict_policy +
 *   同批已冲突项回溯，见 transfer_center::resolve_conflict）；
 * - Esc / 点击遮罩 = 跳过（Netcatty onOpenChange → skip 语义）。
 *
 * 与 Netcatty 的简化差异（changelogs 有记）：无 停止/合并 按钮，
 * 无 已有/新文件 的大小与修改时间对比（后端冲突检测未采集元数据）。
 */

import { useEffect, useRef, useState } from "react";
import type { TransferConflictAction, TransferItem } from "../backend/client";
import { transferDisplayName } from "../domain/transferQueue";

export function SftpConflictDialog({
  conflict,
  sameBatchCount,
  busy,
  error,
  onResolve,
}: {
  conflict: TransferItem;
  /** 同批 conflict 总数（含当前项）；> 1 时显示「应用到全部」。 */
  sameBatchCount: number;
  busy: boolean;
  error: string;
  onResolve: (action: TransferConflictAction, applyToAll: boolean) => void;
}) {
  const [applyToAll, setApplyToAll] = useState(false);
  const replaceRef = useRef<HTMLButtonElement>(null);

  // 切换到新冲突项时重置勾选并聚焦首选动作（Netcatty：文件冲突 preferred = replace）。
  useEffect(() => {
    setApplyToAll(false);
    replaceRef.current?.focus();
  }, [conflict.id]);

  // Esc = 跳过（对齐 Netcatty 关闭即 skip）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onResolve("skip", false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onResolve]);

  const name = transferDisplayName(conflict);
  const desc =
    conflict.direction === "upload"
      ? "远端目标位置已存在同名文件。替换将覆盖远端文件，创建副本将保留两者。"
      : "本地目标位置已存在同名文件。替换将覆盖本地文件，创建副本将保留两者。";

  const resolve = (action: TransferConflictAction) => {
    if (busy) return;
    onResolve(action, applyToAll && sameBatchCount > 1);
  };

  return (
    <div
      className="nc-sftp-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`文件冲突：${name} 已存在`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) resolve("skip");
      }}
    >
      <div className="nc-sftp-dialog nc-sftp-conflict">
        <h3>
          {name} <span className="nc-sftp-conflict-suffix">已存在</span>
        </h3>
        <p className="nc-sftp-dialog-text">{desc}</p>
        {sameBatchCount > 1 && (
          <label className="nc-sftp-conflict-apply-all">
            <input
              type="checkbox"
              checked={applyToAll}
              disabled={busy}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            将此操作应用到剩余的 {sameBatchCount} 个冲突
          </label>
        )}
        {error && <div className="nc-sftp-dialog-error">{error}</div>}
        <div className="nc-sftp-dialog-actions">
          <button disabled={busy} onClick={() => resolve("skip")}>
            跳过
          </button>
          <button disabled={busy} onClick={() => resolve("rename")}>
            创建副本
          </button>
          <button
            ref={replaceRef}
            className="danger-outline"
            disabled={busy}
            onClick={() => resolve("replace")}
          >
            替换
          </button>
        </div>
      </div>
    </div>
  );
}
