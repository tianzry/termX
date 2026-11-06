/**
 * 传输队列行列表。SFTP 视图底部面板（SftpQueuePanel）与顶栏全局传输中心
 * （GlobalTransferCenter）共用同一份渲染与行内动作，只是外壳不同
 * （对照 Netcatty：两个入口都读同一传输中心队列）。
 *
 * 行内动作仍走既有命令（暂停 / 恢复 / 取消），状态回流由父级订阅的
 * `sftp:transfer_updated:<id>` 事件驱动，不做本地乐观更新。
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
  canPause,
  canResume,
  formatBytes,
  progressPercent,
  transferDisplayName,
} from "../domain/transferQueue";
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

export function TransferQueueList({
  items,
  progress,
  onError,
}: {
  items: TransferItem[];
  progress: Record<string, TransferProgress>;
  onError?: (message: string) => void;
}) {
  const run = (p: Promise<void>) => {
    p.catch((e) => onError?.(userVisibleError(String(e))));
  };

  return (
    <div className="nc-sftp-queue-list" data-section="transfer-queue-list">
      {items.map((item) => {
        const pr = progress[item.id];
        const total = pr && pr.total > 0 ? pr.total : item.size;
        const pct =
          item.status === "completed"
            ? 100
            : item.status === "running"
              ? progressPercent(pr?.transferred ?? 0, total)
              : null;
        const indeterminate = item.status === "running" && pct === null;
        return (
          <div
            key={item.id}
            className="nc-sftp-queue-row"
            data-transfer-status={item.status}
            data-transfer-direction={item.direction}
          >
            <StatusIcon status={item.status} />
            <span
              className="nc-sftp-queue-dir"
              title={item.direction === "upload" ? "上传" : "下载"}
            >
              <Icon name={item.direction === "upload" ? "upload" : "download"} size={12} />
            </span>
            <span
              className="nc-sftp-queue-name"
              title={item.direction === "upload" ? item.local_path : item.remote_path}
            >
              {transferDisplayName(item)}
            </span>
            <span className="nc-sftp-queue-size">{formatBytes(item.size)}</span>

            {item.status === "failed" ? (
              <span className="nc-sftp-queue-note err">
                {item.error ? errorMessageFor(item.error) : "传输失败"}
              </span>
            ) : item.status === "conflict" ? (
              <span className="nc-sftp-queue-note warn">目标已存在，等待处理</span>
            ) : item.status === "skipped" ? (
              <span className="nc-sftp-queue-note">已跳过（目标已存在）</span>
            ) : (
              <>
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
                <span className="nc-sftp-queue-pct">
                  {item.status === "queued"
                    ? "排队中"
                    : pct === null
                      ? item.status === "running"
                        ? "传输中"
                        : ""
                      : `${Math.round(pct)}%`}
                </span>
              </>
            )}

            <span className="nc-sftp-queue-actions">
              {canPause(item.status) && (
                <button
                  className="nc-sftp-queue-btn"
                  title="暂停"
                  aria-label={`暂停：${transferDisplayName(item)}`}
                  onClick={() => run(api.sftpTransferPause(item.id))}
                >
                  <Icon name="pause" size={12} />
                </button>
              )}
              {canResume(item.status) && (
                <button
                  className="nc-sftp-queue-btn"
                  title="恢复"
                  aria-label={`恢复：${transferDisplayName(item)}`}
                  onClick={() => run(api.sftpTransferResume(item.id))}
                >
                  <Icon name="play" size={12} />
                </button>
              )}
              {canCancel(item.status) && (
                <button
                  className="nc-sftp-queue-btn danger"
                  title="取消"
                  aria-label={`取消：${transferDisplayName(item)}`}
                  onClick={() => run(api.sftpTransferCancel(item.id))}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
