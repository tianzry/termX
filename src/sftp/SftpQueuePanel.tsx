/**
 * SFTP 视图底部的传输队列面板（阶段 B；对齐 Netcatty SftpTransferQueue
 * 同名区域子集）：队列列表、暂停/恢复/取消、并发数设置、清空已结束项。
 *
 * 队列数据与事件订阅抽到 `useSftpTransferQueue`，与顶栏
 * `GlobalTransferCenter` 共用同一条推送通道（不轮询）；行渲染抽到
 * `TransferQueueList`，两个入口只是外壳不同。
 *
 * 高度可拖拽（对齐 Netcatty）：默认 220px，最小 112px、最大 480px 且不
 * 超过视口 60%；顶部 12px 拖拽条（向上拖变高），松手写 localStorage，
 * 不提供双击复位。
 *
 * 冲突决策对话框（阶段 C）：出现 conflict 项即弹 SftpConflictDialog
 * （跳过/创建副本/替换 + 应用到全部，按批次生效）。
 */

import { GripHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
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

const MIN_PANEL_HEIGHT = 112;
const MAX_PANEL_HEIGHT = 480;
const DEFAULT_PANEL_HEIGHT = 220;
const PANEL_HEIGHT_KEY = "termx.sftp.transferPanelHeight.v1";

function clampPanelHeight(height: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? MAX_PANEL_HEIGHT
      : Math.floor(window.innerHeight * 0.6);
  return Math.max(
    MIN_PANEL_HEIGHT,
    Math.min(Math.min(MAX_PANEL_HEIGHT, viewportMax), height),
  );
}

function readStoredPanelHeight(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_HEIGHT_KEY);
    const n = raw ? Number(raw) : NaN;
    return clampPanelHeight(Number.isFinite(n) ? n : DEFAULT_PANEL_HEIGHT);
  } catch {
    return DEFAULT_PANEL_HEIGHT;
  }
}

function persistPanelHeight(height: number): void {
  try {
    window.localStorage.setItem(PANEL_HEIGHT_KEY, String(height));
  } catch {
    // 存储不可用时仅本次生效。
  }
}

function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n)));
}

export function SftpQueuePanel() {
  const { items, progress, speed } = useSftpTransferQueue();
  // 并发数由设置中心「SFTP」tab 持有（单一来源），此处只做展示与调整入口。
  const settings = useSettings();
  const concurrency = settings.sftpTransferConcurrency;
  const [error, setError] = useState("");
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState("");

  // ── 高度拖拽（对齐 Netcatty：向上拖变高，松手持久化） ──
  const [panelHeight, setPanelHeight] = useState(readStoredPanelHeight);
  const [dragging, setDragging] = useState(false);
  const panelHeightRef = useRef(panelHeight);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );
  panelHeightRef.current = panelHeight;

  const startDrag = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStateRef.current = {
      startY: e.clientY,
      startHeight: panelHeightRef.current,
    };
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      const deltaY = state.startY - event.clientY;
      const next = clampPanelHeight(state.startHeight + deltaY);
      // 同步写 ref：mouseup 可能早于最后一次 setState 的渲染，落盘要拿最新值。
      panelHeightRef.current = next;
      setPanelHeight(next);
    };
    const onUp = () => {
      dragStateRef.current = null;
      persistPanelHeight(panelHeightRef.current);
      setDragging(false);
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

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
    <div
      className={`nc-sftp-queue${dragging ? " is-dragging" : ""}`}
      data-section="sftp-transfer-queue"
      style={{ height: panelHeight }}
    >
      <div
        className="nc-sftp-queue-resizer"
        role="separator"
        aria-label="拖拽调整传输队列高度"
        aria-orientation="horizontal"
        onMouseDown={startDrag}
        title="拖拽调整高度"
      >
        <GripHorizontal size={14} />
      </div>

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

      <TransferQueueList
        items={sorted}
        progress={progress}
        speed={speed}
        variant="panel"
        onError={setError}
      />

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
