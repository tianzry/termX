/**
 * 传输队列行列表。SFTP 视图底部面板（SftpQueuePanel，variant="panel"）与顶栏
 * 全局传输中心（GlobalTransferCenter，variant="center"）共用同一份数据与动作，
 * 排版分别对照 Netcatty 的两处 DOM：
 *
 * - panel（`components/sftp/SftpTransferItem.tsx` 顶层行）：状态图标 + 文件名 →
 *   目标目录（12px / 11px muted），右侧 `速率 • 已传/总大小 • 百分比 • 剩余`，
 *   下方 1.5px 进度条，行尾动作；失败时底部错误行。
 * - center（`components/GlobalSftpTransferCenter.tsx`）：方向图标 + 文件名与
 *   `源 → 目标`，右侧动作；进度条 + 一位小数百分比；状态文本 + 明细
 *   `已传 / 总大小 · 速率 · 剩余`。
 *
 * 速率走 `useSftpTransferQueue` 的滑动平均（3s 窗口），终态不再更新但保留
 * 最终字节数 / 100%，不会回退到空进度条。
 */

import * as api from "../backend/client";
import type {
  TransferItem,
  TransferProgress,
  TransferStatus,
} from "../backend/client";
import { errorMessageFor, userVisibleError } from "../domain/sshErrors";
import {
  canCancel,
  canDismiss,
  canPause,
  canRetry,
  canResume,
  estimateTransferEtaSeconds,
  formatTransferBytes,
  formatTransferEta,
  formatTransferSpeed,
  isSettledStatus,
  parentPath,
  progressPercent,
  transferDisplayName,
  transferSourcePath,
  transferTargetPath,
} from "../domain/transferQueue";
import { revealTransferTarget } from "./revealTarget";
import { Icon } from "../ui/icons";

function StatusIcon({ status }: { status: TransferStatus }) {
  switch (status) {
    case "running":
      return (
        <Icon
          name="loader"
          size={12}
          className="nc-sftp-queue-spin nc-sftp-queue-status-active"
        />
      );
    case "queued":
      return <Icon name="clock" size={12} className="nc-sftp-queue-status-muted" />;
    case "paused":
      return <Icon name="pause" size={12} className="nc-sftp-queue-status-warn" />;
    case "conflict":
      return (
        <Icon name="alert-triangle" size={12} className="nc-sftp-queue-status-warn" />
      );
    case "completed":
      return <Icon name="check" size={12} className="nc-sftp-queue-status-ok" />;
    case "failed":
      return <Icon name="x" size={12} className="nc-sftp-queue-status-err" />;
    case "cancelled":
      return <Icon name="x" size={12} className="nc-sftp-queue-status-muted" />;
    case "skipped":
      return (
        <Icon name="arrow-right" size={12} className="nc-sftp-queue-status-muted" />
      );
  }
}

const STATUS_TEXT: Record<TransferStatus, string> = {
  queued: "排队中",
  running: "传输中",
  paused: "已暂停",
  conflict: "等待处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};

/** 目录部分（同时兼容远端 "/" 与 Windows "\\"）。 */
// parentPath 在 domain/transferQueue 中导出（目标目录语义共用）。

function targetPath(item: TransferItem): string {
  return transferTargetPath(item);
}

function sourcePath(item: TransferItem): string {
  return transferSourcePath(item);
}

/** 行尾动作矩阵（对齐 Netcatty 各状态按钮显隐）。 */
function RowActions({
  item,
  variant,
  run,
  onReveal,
}: {
  item: TransferItem;
  variant: "panel" | "center";
  run: (p: Promise<void>) => void;
  onReveal: (item: TransferItem) => void;
}) {
  const name = transferDisplayName(item);
  const offline =
    item.session_live === false && !isSettledStatus(item.status);
  const dismissIcon = variant === "center" ? "trash" : "x";
  // 底部面板仅在 completed 显示「打开目标目录」（Netcatty canRevealTarget）；
  // 顶栏弹窗与 Netcatty 一致：任何状态都保留该按钮。
  const showReveal = variant === "center" || item.status === "completed";
  return (
    <span className="nc-sftp-queue-actions">
      {showReveal && (
        <button
          className="nc-sftp-queue-btn"
          title="打开目标目录"
          aria-label={`打开目标目录：${name}`}
          data-action="reveal"
          onClick={() => onReveal(item)}
        >
          <Icon name="folder-open" size={variant === "center" ? 13 : 12} />
        </button>
      )}
      {canPause(item.status) && (
        <button
          className="nc-sftp-queue-btn"
          title="暂停"
          aria-label={`暂停：${name}`}
          data-action="pause"
          onClick={() => run(api.sftpTransferPause(item.id))}
        >
          <Icon name="pause" size={12} />
        </button>
      )}
      {canResume(item.status) && (
        <button
          className="nc-sftp-queue-btn"
          title={offline ? "会话已断开，无法续传" : "恢复"}
          aria-label={`恢复：${name}`}
          data-action="resume"
          disabled={offline}
          onClick={() => run(api.sftpTransferResume(item.id))}
        >
          <Icon name="play" size={12} />
        </button>
      )}
      {canRetry(item.status) && (
        <button
          className="nc-sftp-queue-btn"
          title={offline ? "会话已断开，无法重试" : "重试"}
          aria-label={`重试：${name}`}
          data-action="retry"
          disabled={offline}
          onClick={() => run(api.sftpTransferRetry(item.id))}
        >
          <Icon name="refresh" size={12} />
        </button>
      )}
      {canCancel(item.status) && (
        <button
          className="nc-sftp-queue-btn danger"
          title="取消"
          aria-label={`取消：${name}`}
          data-action="cancel"
          onClick={() => run(api.sftpTransferCancel(item.id))}
        >
          <Icon name="x" size={12} />
        </button>
      )}
      {canDismiss(item.status) && (
        <button
          className="nc-sftp-queue-btn"
          title="移除"
          aria-label={`移除：${name}`}
          data-action="dismiss"
          onClick={() => run(api.sftpTransferDismiss(item.id))}
        >
          <Icon name={dismissIcon} size={12} />
        </button>
      )}
    </span>
  );
}

export function TransferQueueList({
  items,
  progress,
  speed = {},
  variant = "panel",
  onError,
}: {
  items: TransferItem[];
  progress: Record<string, TransferProgress>;
  speed?: Record<string, number>;
  variant?: "panel" | "center";
  onError?: (message: string) => void;
}) {
  const run = (p: Promise<void>) => {
    p.catch((e) => onError?.(userVisibleError(String(e))));
  };
  const reveal = (item: TransferItem) => {
    void revealTransferTarget(item).then((result) => {
      if (result.status !== "ok") onError?.(result.message);
    });
  };

  return (
    <div
      className="nc-sftp-queue-list"
      data-section="transfer-queue-list"
      data-variant={variant}
    >
      {items.map((item) => {
        const pr = progress[item.id];
        const total = pr && pr.total > 0 ? pr.total : item.size;
        const transferred =
          total > 0
            ? Math.min(total, Math.max(pr?.transferred ?? 0, item.checkpoint ?? 0))
            : Math.max(pr?.transferred ?? 0, item.checkpoint ?? 0);
        const pct =
          item.status === "completed"
            ? 100
            : total > 0
              ? progressPercent(transferred, total)
              : null;
        const indeterminate = item.status === "running" && pct === null;
        const activeSpeed = item.status === "running" ? (speed[item.id] ?? 0) : 0;
        const speedText = formatTransferSpeed(activeSpeed);
        const etaSeconds =
          item.status === "running" && total > 0
            ? estimateTransferEtaSeconds(total - transferred, activeSpeed)
            : null;
        const etaText = formatTransferEta(etaSeconds);
        const bytesText =
          total > 0
            ? `${formatTransferBytes(transferred)} / ${formatTransferBytes(total)}`
            : formatTransferBytes(transferred);
        const offline =
          item.session_live === false && !isSettledStatus(item.status);
        const note = offline
          ? "会话已断开：无法续传/重试，请重新连接后重新发起传输"
          : item.status === "failed"
            ? item.error
              ? errorMessageFor(item.error)
              : "传输失败"
            : item.status === "conflict"
              ? "目标已存在，等待处理"
              : item.status === "skipped"
                ? "已跳过（目标已存在）"
                : item.status === "paused"
                  ? "已暂停，可从此处续传"
                  : null;

        if (variant === "center") {
          return (
            <div
              key={item.id}
              className="nc-sftp-center-row"
              data-transfer-id={item.id}
              data-transfer-status={item.status}
              data-transfer-direction={item.direction}
            >
              <div className="nc-sftp-center-main">
                <span className="nc-sftp-center-icon" title={item.direction === "upload" ? "上传" : "下载"}>
                  <Icon
                    name={item.direction === "upload" ? "upload" : "download"}
                    size={13}
                  />
                </span>
                <div className="nc-sftp-center-body">
                  <span
                    className="nc-sftp-center-name"
                    title={sourcePath(item)}
                  >
                    {transferDisplayName(item)}
                  </span>
                  <span className="nc-sftp-center-paths" title={`${sourcePath(item)} → ${targetPath(item)}`}>
                    {sourcePath(item)} → {targetPath(item)}
                  </span>
                </div>
                <RowActions item={item} variant={variant} run={run} onReveal={reveal} />
              </div>
              <div className="nc-sftp-center-barwrap">
                <div className="nc-sftp-queue-bar">
                  <div
                    className={
                      indeterminate
                        ? "nc-sftp-queue-fill indeterminate"
                        : "nc-sftp-queue-fill"
                    }
                    style={{ width: pct === null ? "0%" : `${pct}%` }}
                  />
                </div>
                <span className="nc-sftp-center-pct">
                  {pct === null ? "" : `${(Math.round(pct * 10) / 10).toFixed(1)}%`}
                </span>
              </div>
              <div className="nc-sftp-center-status">
                <span className="nc-sftp-center-state">{STATUS_TEXT[item.status]}</span>
                <span className="nc-sftp-center-detail">
                  {[bytesText, speedText, etaText].filter(Boolean).join(" · ")}
                </span>
              </div>
              {item.status === "failed" && note && (
                <div className="nc-sftp-center-error">{note}</div>
              )}
            </div>
          );
        }

        const summaryText = [
          speedText,
          bytesText,
          pct === null ? null : `${Math.round(pct)}%`,
          etaText ? `剩余 ${etaText}` : null,
        ]
          .filter(Boolean)
          .join(" • ");

        return (
          <div
            key={item.id}
            className="nc-sftp-queue-row"
            data-transfer-id={item.id}
            data-transfer-status={item.status}
            data-transfer-direction={item.direction}
          >
            <div className="nc-sftp-queue-main">
              <span className="nc-sftp-queue-statusbox">
                <StatusIcon status={item.status} />
              </span>
              <span
                className="nc-sftp-queue-dir"
                title={item.direction === "upload" ? "上传" : "下载"}
              >
                <Icon name={item.direction === "upload" ? "upload" : "download"} size={12} />
              </span>
              <span className="nc-sftp-queue-name" title={sourcePath(item)}>
                {transferDisplayName(item)}
              </span>
              <Icon
                name="arrow-right"
                size={11}
                className="nc-sftp-queue-arrow"
              />
              <span className="nc-sftp-queue-target" title={targetPath(item)}>
                {parentPath(targetPath(item))}
              </span>
              <span className="nc-sftp-queue-summary">{summaryText}</span>
              <RowActions item={item} variant={variant} run={run} onReveal={reveal} />
            </div>
            <div className="nc-sftp-queue-bar nc-sftp-queue-bar-indent">
              <div
                className={
                  indeterminate
                    ? "nc-sftp-queue-fill indeterminate"
                    : "nc-sftp-queue-fill"
                }
                style={{ width: pct === null ? "0%" : `${pct}%` }}
              />
            </div>
            {note && (
              <div
                className={
                  item.status === "failed"
                    ? "nc-sftp-queue-footnote err"
                    : offline
                      ? "nc-sftp-queue-footnote err"
                      : "nc-sftp-queue-footnote"
                }
              >
                {note}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
