/**
 * 全局传输队列面板（阶段 B；对齐 Netcatty SftpTransferQueue 同名区域子集）：
 * 队列列表（文件名/方向/大小/进度/状态图标）、暂停/恢复/取消、并发数设置、
 * 清空已结束项。与 SftpPaneView 的旧传输条整合：上传/下载统一入队
 * （sftp_transfer_enqueue），进度只在本面板展示，避免两套进度重复。
 *
 * 事件全部经 client.ts 封装（R1）：
 * - `sftp:queue_changed`（全量快照：入队 / 优先级 / 清空）；
 * - `sftp:transfer_updated:<id>`（单条状态迁移；后端不随状态发全量快照）；
 * - `sftp:progress:<id>`（运行中项的字节进度）。
 *
 * 冲突决策对话框（阶段 C）：出现 conflict 项即弹 SftpConflictDialog
 * （跳过/创建副本/替换 + 应用到全部，按批次生效）。
 */

import { useEffect, useRef, useState } from "react";
import * as api from "../backend/client";
import type {
  TransferConflictAction,
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
  pickActiveConflict,
  progressPercent,
  queueCounts,
  sortQueueForDisplay,
  transferDisplayName,
} from "../domain/transferQueue";
import { Icon } from "../ui/icons";
import { SftpConflictDialog } from "./SftpConflictDialog";

const CONCURRENCY_KEY = "sftp_transfer_concurrency";
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n)));
}

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

export function SftpQueuePanel() {
  const [items, setItems] = useState<TransferItem[]>([]);
  const [progress, setProgress] = useState<Record<string, TransferProgress>>({});
  const [concurrency, setConcurrency] = useState(2);
  const [error, setError] = useState("");
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState("");

  // 挂载：初始快照 + 并发设置 + 队列全量快照事件。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void api.sftpTransferList().then((list) => {
      if (alive) setItems(list);
    }).catch(() => {});
    void api.getSetting(CONCURRENCY_KEY).then((v) => {
      if (alive && v) setConcurrency(clampConcurrency(Number(v)));
    }).catch(() => {});
    void api.onSftpQueueChanged((snapshot) => setItems(snapshot)).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 单条状态更新订阅：按 id 订阅 `sftp:transfer_updated:<id>`；
  // 清空已结束后的孤儿订阅一并回收。
  const updatedSubs = useRef(new Map<string, () => void>());
  const updatedPending = useRef(new Set<string>());
  useEffect(() => {
    const subs = updatedSubs.current;
    const pending = updatedPending.current;
    let cancelled = false;
    const ids = new Set(items.map((i) => i.id));
    for (const item of items) {
      if (subs.has(item.id) || pending.has(item.id)) continue;
      pending.add(item.id);
      void api.onSftpTransferUpdated(item.id, (it) => {
        setItems((prev) => prev.map((p) => (p.id === it.id ? it : p)));
      }).then((u) => {
        pending.delete(item.id);
        if (cancelled || !ids.has(item.id)) {
          u();
          return;
        }
        subs.set(item.id, u);
      });
    }
    for (const [id, u] of subs) {
      if (!ids.has(id)) {
        u();
        subs.delete(id);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [items]);

  // 运行中项订阅字节进度；离开 running 即退订并清掉进度残留。
  const progressSubs = useRef(new Map<string, () => void>());
  useEffect(() => {
    const subs = progressSubs.current;
    let cancelled = false;
    const runningIds = new Set(
      items.filter((i) => i.status === "running").map((i) => i.id),
    );
    for (const id of runningIds) {
      if (subs.has(id)) continue;
      void api.onSftpProgress(id, (p) => {
        setProgress((prev) => ({ ...prev, [id]: p }));
      }).then((u) => {
        if (cancelled || !runningIds.has(id)) u();
        else subs.set(id, u);
      });
    }
    const stale: string[] = [];
    for (const [id, u] of subs) {
      if (!runningIds.has(id)) {
        u();
        subs.delete(id);
        stale.push(id);
      }
    }
    if (stale.length > 0) {
      setProgress((prev) => {
        const next = { ...prev };
        for (const id of stale) delete next[id];
        return next;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [items]);

  // 卸载：释放全部订阅。
  useEffect(() => {
    const updated = updatedSubs.current;
    const prog = progressSubs.current;
    return () => {
      for (const u of updated.values()) u();
      updated.clear();
      for (const u of prog.values()) u();
      prog.clear();
    };
  }, []);

  const run = (p: Promise<void>) => {
    setError("");
    p.catch((e) => setError(userVisibleError(String(e))));
  };

  const changeConcurrency = (value: number) => {
    const next = clampConcurrency(value);
    setConcurrency(next);
    run(api.sftpTransferSetConcurrency(next));
  };

  const resolveConflict = (
    transferId: string,
    action: TransferConflictAction,
    applyToAll: boolean,
  ) => {
    setConflictBusy(true);
    setConflictError("");
    api
      .sftpResolveConflict(transferId, action, applyToAll)
      .catch((e) => setConflictError(userVisibleError(String(e))))
      .finally(() => setConflictBusy(false));
  };

  if (items.length === 0) return null;

  const counts = queueCounts(items);
  const sorted = sortQueueForDisplay(items);
  const activeConflict = pickActiveConflict(items);

  return (
    <div className="nc-sftp-queue" data-section="sftp-transfer-queue">
      <div className="nc-sftp-queue-header">
        <span className="nc-sftp-queue-title">传输队列</span>
        {counts.active > 0 && (
          <span className="nc-sftp-queue-active">（{counts.active} 进行中）</span>
        )}
        {error && (
          <span className="nc-sftp-queue-error" title={error}>
            {error}
          </span>
        )}
        <div className="nc-sftp-queue-header-actions">
          <label className="nc-sftp-queue-concurrency">
            并发
            <select
              value={concurrency}
              onChange={(e) => changeConcurrency(Number(e.target.value))}
              aria-label="传输并发数"
            >
              {Array.from({ length: MAX_CONCURRENCY }, (_, i) => i + 1).map(
                (n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ),
              )}
            </select>
          </label>
          {counts.finished > 0 && (
            <button
              className="nc-sftp-queue-clear"
              onClick={() => run(api.sftpTransferClearFinished())}
            >
              清空已结束
            </button>
          )}
        </div>
      </div>

      <div className="nc-sftp-queue-list">
        {sorted.map((item) => {
          const pr = progress[item.id];
          const total = pr && pr.total > 0 ? pr.total : item.size;
          const pct =
            item.status === "running" || item.status === "completed"
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
              <span className="nc-sftp-queue-dir" title={item.direction === "upload" ? "上传" : "下载"}>
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
                <span className="nc-sftp-queue-note warn">
                  目标已存在，等待处理
                </span>
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

      {activeConflict && (
        <SftpConflictDialog
          conflict={activeConflict.conflict}
          sameBatchCount={activeConflict.sameBatchCount}
          busy={conflictBusy}
          error={conflictError}
          onResolve={(action, applyToAll) =>
            resolveConflict(activeConflict.conflict.id, action, applyToAll)
          }
        />
      )}
    </div>
  );
}
