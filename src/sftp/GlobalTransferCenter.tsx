/**
 * 顶栏「文件传输」按钮 + 全局传输中心弹窗（对照 Netcatty
 * `GlobalSftpTransferCenter`）。
 *
 * - 三态外观：未运行 = 纯 ⇅ 图标；运行/待办 = 图标右上角数量徽标
 *   （未完成条数，>99 显示 99+）；需要处理（冲突/失败）= 右上角红点。
 * - 点击展开弹窗：暂停全部 / 恢复全部 / 取消全部 + 分类页签
 *   （全部 / 进行中 / 排队中 / 已暂停 / 需要处理 / 已完成）。
 * - 数据全部来自推送事件（`sftp:queue_changed`、`sftp:transfer_updated:<id>`、
 *   打开弹窗时按运行项订阅 `sftp:progress:<id>`），不做定时轮询；仅在打开
 *   弹窗时拉一次快照对账，避免错过入队瞬间的状态迁移。
 * - 与 SftpQueuePanel 的关系：同一个 `useSftpTransferQueue` 订阅源 +
 *   同一个 `TransferQueueList` 行渲染，这里只是「全局入口」的另一种外壳；
 *   底部面板保留并发数设置与冲突对话框，弹窗只做全局浏览与批量操作。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDownUp } from "lucide-react";
import * as api from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  bucketTransferItems,
  canCancel,
  canPause,
  canResume,
  sortQueueForDisplay,
  transferBadge,
  transferBucket,
  type TransferBucket,
} from "../domain/transferQueue";
import { TransferQueueList } from "./TransferQueueList";
import { useSftpTransferQueue } from "./useSftpTransferQueue";

const BUCKETS: readonly { id: TransferBucket; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "queued", label: "排队中" },
  { id: "paused", label: "已暂停" },
  { id: "attention", label: "需要处理" },
  { id: "completed", label: "已完成" },
];

export function GlobalTransferCenter() {
  const [open, setOpen] = useState(false);
  const [bucket, setBucket] = useState<TransferBucket>("all");
  const [error, setError] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0,
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 弹窗关闭时不订阅字节进度，避免每 32K 一次重渲染顶栏。
  const { items, progress, speed, refresh } = useSftpTransferQueue({
    subscribeProgress: open,
  });
  const badge = transferBadge(items);

  const counts = useMemo(() => {
    const next: Record<TransferBucket, number> = {
      all: items.length,
      active: 0,
      queued: 0,
      paused: 0,
      attention: 0,
      completed: 0,
    };
    for (const item of items) next[transferBucket(item.status)] += 1;
    return next;
  }, [items]);

  const displayed = useMemo(
    () => sortQueueForDisplay(bucketTransferItems(items, bucket)),
    [items, bucket],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({
        top: Math.round(rect.bottom + 5),
        right: Math.round(window.innerWidth - rect.right),
      });
    }
    // 打开时做一次快照对账（非轮询）。
    refresh();
    setOpen(true);
  };

  const runBatch = (ids: string[], fn: (id: string) => Promise<void>) => {
    if (ids.length === 0) return;
    setError("");
    setBatchBusy(true);
    void Promise.allSettled(ids.map(fn)).then((results) => {
      setBatchBusy(false);
      const rejected = results.find((r) => r.status === "rejected");
      if (rejected) {
        setError(
          userVisibleError(String((rejected as PromiseRejectedResult).reason)),
        );
      }
    });
  };

  const pausableIds = items.filter((i) => canPause(i.status)).map((i) => i.id);
  const resumableIds = items.filter((i) => canResume(i.status)).map((i) => i.id);
  const cancellableIds = items.filter((i) => canCancel(i.status)).map((i) => i.id);

  return (
    <>
      <button
        ref={buttonRef}
        className="nc-icon-btn nc-utility-btn nc-transfer-toggle"
        title="文件传输"
        aria-label="文件传输"
        data-section="global-transfer-toggle"
        onClick={toggle}
      >
        <ArrowDownUp size={16} />
        {badge.count > 0 && (
          <span className="nc-transfer-badge">
            {badge.count > 99 ? "99+" : badge.count}
          </span>
        )}
        {badge.hasAttention && <span className="nc-transfer-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="nc-transfer-center"
          style={{ top: pos.top, right: pos.right }}
          data-section="global-transfer-center"
        >
          <div className="nc-transfer-center-head">
            <span className="nc-transfer-center-title">文件传输</span>
            <div className="nc-transfer-center-actions">
              <button
                className="nc-transfer-center-action"
                disabled={batchBusy || pausableIds.length === 0}
                onClick={() =>
                  runBatch(pausableIds, (id) => api.sftpTransferPause(id))
                }
              >
                暂停全部
              </button>
              <button
                className="nc-transfer-center-action"
                disabled={batchBusy || resumableIds.length === 0}
                onClick={() =>
                  runBatch(resumableIds, (id) => api.sftpTransferResume(id))
                }
              >
                恢复全部
              </button>
              <button
                className="nc-transfer-center-action danger"
                disabled={batchBusy || cancellableIds.length === 0}
                onClick={() =>
                  runBatch(cancellableIds, (id) => api.sftpTransferCancel(id))
                }
              >
                取消全部
              </button>
            </div>
          </div>

          <div className="nc-transfer-center-tabs" role="tablist">
            {BUCKETS.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={bucket === item.id}
                className={`nc-transfer-center-tab${bucket === item.id ? " active" : ""}`}
                onClick={() => setBucket(item.id)}
              >
                {item.label}
                {counts[item.id] > 0 && (
                  <span className="nc-transfer-center-tab-count">{counts[item.id]}</span>
                )}
              </button>
            ))}
          </div>

          {error && (
            <div className="nc-transfer-center-error" title={error}>
              {error}
            </div>
          )}

          {counts.attention > 0 && bucket !== "attention" && bucket !== "all" && (
            <div className="nc-transfer-center-hint">
              {counts.attention} 个传输需要处理（冲突可在 SFTP 视图的传输队列中答复）
            </div>
          )}

          {displayed.length === 0 ? (
            <div className="nc-transfer-center-empty">
              {badge.hasAttention && bucket !== "all" && bucket !== "attention" ? (
                <AlertCircle size={22} />
              ) : (
                <ArrowDownUp size={22} />
              )}
              <span>当前分类没有传输任务</span>
            </div>
          ) : (
            <TransferQueueList
              items={displayed}
              progress={progress}
              speed={speed}
              variant="center"
              onError={setError}
            />
          )}

          {bucket === "completed" && counts.completed > 0 && (
            <div className="nc-transfer-center-footer">
              <button
                className="nc-transfer-center-clear"
                onClick={() => {
                  setError("");
                  api.sftpTransferClearFinished().catch((e) => {
                    setError(userVisibleError(String(e)));
                  });
                }}
              >
                清空已结束
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
