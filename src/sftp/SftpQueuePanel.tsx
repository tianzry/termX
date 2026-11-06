/**
 * SFTP 视图底部的传输队列面板（阶段 B；对齐 Netcatty SftpTransferQueue
 * 同名区域子集）：队列列表、暂停/恢复/取消、并发数设置、清空已结束项。
 *
 * 队列数据与事件订阅抽到 `useSftpTransferQueue`，与顶栏
 * `GlobalTransferCenter` 共用同一条推送通道（不轮询）；行渲染抽到
 * `TransferQueueList`，两个入口只是外壳不同。
 *
 * 冲突决策对话框（阶段 C）：出现 conflict 项即弹 SftpConflictDialog
 * （跳过/创建副本/替换 + 应用到全部，按批次生效）。
 */

import { useState } from "react";
import * as api from "../backend/client";
import type { TransferConflictAction } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { updateSettings, useSettings } from "../settings/settingsStore";
import {
  pickActiveConflict,
  queueCounts,
  sortQueueForDisplay,
} from "../domain/transferQueue";
import { SftpConflictDialog } from "./SftpConflictDialog";
import { TransferQueueList } from "./TransferQueueList";
import { useSftpTransferQueue } from "./useSftpTransferQueue";

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY = 6;

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n)));
}

export function SftpQueuePanel() {
  const { items, progress } = useSftpTransferQueue();
  // 并发数由设置中心「SFTP」tab 持有（单一来源），此处只做展示与调整入口。
  const settings = useSettings();
  const concurrency = settings.sftpTransferConcurrency;
  const [error, setError] = useState("");
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState("");

  const run = (p: Promise<void>) => {
    setError("");
    p.catch((e) => setError(userVisibleError(String(e))));
  };

  const changeConcurrency = (value: number) => {
    const next = clampConcurrency(value);
    // 持久化 + 即时下发后端由设置 store 的副作用统一处理。
    updateSettings({ sftpTransferConcurrency: next });
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

      <TransferQueueList items={sorted} progress={progress} onError={setError} />

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
