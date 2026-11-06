/**
 * 全局传输队列的订阅源（SftpQueuePanel 与顶栏 GlobalTransferCenter 共用）。
 *
 * 事件（对齐 Netcatty sftpTransferCenterStore，全部推送、不轮询）：
 * - `sftp:queue_changed`：结构性变化（入队 / 清理 / 重排）→ 全量快照；
 * - `sftp:transfer_updated:<id>`：单条状态迁移（按 id 订阅，随队列增减回收）；
 * - `sftp:progress:<id>`：运行中项的字节进度（可选订阅：顶栏弹窗关闭时
 *   不订阅，避免每 32K 一次的重渲染）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../backend/client";
import type { TransferItem, TransferProgress } from "../backend/client";

/** 终态（不需要再收字节进度）的状态集合。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);

export interface SftpTransferQueueFeed {
  items: TransferItem[];
  progress: Record<string, TransferProgress>;
  /** 一次性对账快照（打开弹窗时用；不轮询）。 */
  refresh: () => void;
}

export function useSftpTransferQueue({
  subscribeProgress = true,
}: { subscribeProgress?: boolean } = {}): SftpTransferQueueFeed {
  const [items, setItems] = useState<TransferItem[]>([]);
  const [progress, setProgress] = useState<Record<string, TransferProgress>>({});
  const refresh = useCallback(() => {
    void api.sftpTransferList().then(setItems).catch(() => {});
  }, []);

  // 挂载：初始快照 + 队列全量快照事件。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void api.sftpTransferList().then((list) => {
      if (alive) setItems(list);
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
  /** 每条状态事件的代数：用于对账快照防「旧结果覆盖新事件」。 */
  const eventGen = useRef(new Map<string, number>());
  /** 当前队列仍存活 / 组件仍挂载：订阅注册是异步的，回来时按这两个状态决定去留。 */
  const liveIds = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    const subs = updatedSubs.current;
    const pending = updatedPending.current;
    const ids = new Set(items.map((i) => i.id));
    liveIds.current = ids;
    let subscribes = 0;
    for (const item of items) {
      if (subs.has(item.id) || pending.has(item.id)) continue;
      pending.add(item.id);
      subscribes += 1;
      void api.onSftpTransferUpdated(item.id, (it) => {
        eventGen.current.set(it.id, (eventGen.current.get(it.id) ?? 0) + 1);
        setItems((prev) => prev.map((p) => (p.id === it.id ? it : p)));
      }).then((u) => {
        pending.delete(item.id);
        // 不能用 effect 的 cancelled 判断：effect 因状态刷新重跑时，
        // 还在注册中的监听会被误退订，导致后续事件（尤其完成态）丢失。
        if (!mounted.current || !liveIds.current.has(item.id)) {
          u();
          return;
        }
        subs.set(item.id, u);
      });
    }
    // 入队快照到达后，状态可能已经在订阅建立前迁到 running（后端
    // queue_changed 先于 pump 触发）。这里做一次事件驱动的一跳对账，
    // 把错过的那次迁移补回来；不是定时轮询。
    if (subscribes > 0) {
      const genAtFetch = new Map(eventGen.current);
      void api.sftpTransferList().then((list) => {
        if (!mounted.current) return;
        const byId = new Map(list.map((i) => [i.id, i]));
        setItems((prev) =>
          prev.map((p) => {
            // 抓取期间该条已收到新状态事件 → 以事件为准，避免旧快照回退
            // （例如 completed 被迟到的 running 快照覆盖）。
            if ((eventGen.current.get(p.id) ?? 0) !== (genAtFetch.get(p.id) ?? 0)) {
              return p;
            }
            return byId.get(p.id) ?? p;
          }),
        );
      }).catch(() => {});
    }
    for (const [id, u] of subs) {
      if (!ids.has(id)) {
        u();
        subs.delete(id);
      }
    }
  }, [items]);

  // 非终态项订阅字节进度；终态（完成 / 失败 / 取消 / 跳过）即退订并清掉进度残留。
  // 订阅范围必须含 queued / paused / conflict：入队后编排器可能瞬间切 running，
  // 若只按 running 订阅，异步注册回来时状态已变，首帧进度事件会整段丢失。
  const progressSubs = useRef(new Map<string, () => void>());
  /** 仍需要进度的 id：异步订阅回来时据此决定是否保留（避免 effect 重跑误退订）。 */
  const liveActive = useRef(new Set<string>());
  /** 未落盘的进度（每帧最多合并一次 setState）。 */
  const pendingProgress = useRef(new Map<string, TransferProgress>());
  const progressFrame = useRef<number | null>(null);
  const flushProgress = useCallback(() => {
    progressFrame.current = null;
    if (pendingProgress.current.size === 0) return;
    const patch = pendingProgress.current;
    pendingProgress.current = new Map();
    setProgress((prev) => {
      const next = { ...prev };
      for (const [id, p] of patch) next[id] = p;
      return next;
    });
  }, []);
  useEffect(() => {
    const subs = progressSubs.current;
    // 弹窗关闭时退订全部进度，并清掉缓存（下次打开重新订阅当前非终态项）。
    if (!subscribeProgress) {
      liveActive.current = new Set();
      pendingProgress.current.clear();
      if (subs.size > 0) {
        for (const u of subs.values()) u();
        subs.clear();
        setProgress({});
      }
      return;
    }
    const activeIds = new Set(
      items.filter((i) => !TERMINAL_STATUSES.has(i.status)).map((i) => i.id),
    );
    liveActive.current = activeIds;
    for (const id of activeIds) {
      if (subs.has(id)) continue;
      void api.onSftpProgress(id, (p) => {
        // 后端每 32K 发一条（已按 200ms 节流）；再按 rAF 合并成每帧一次
        // setState，避免一次传输把整个队列组件重渲染几百次。
        pendingProgress.current.set(id, p);
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          if (progressFrame.current === null) {
            progressFrame.current = window.requestAnimationFrame(flushProgress);
          }
        } else {
          flushProgress();
        }
      }).then((u) => {
        if (!mounted.current || !liveActive.current.has(id)) u();
        else subs.set(id, u);
      });
    }
    const stale: string[] = [];
    for (const [id, u] of subs) {
      if (!activeIds.has(id)) {
        u();
        subs.delete(id);
        pendingProgress.current.delete(id);
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
  }, [items, subscribeProgress, flushProgress]);

  // 卸载：释放全部订阅。
  useEffect(() => {
    const updated = updatedSubs.current;
    const prog = progressSubs.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (progressFrame.current !== null) {
        window.cancelAnimationFrame(progressFrame.current);
        progressFrame.current = null;
      }
      for (const u of updated.values()) u();
      updated.clear();
      for (const u of prog.values()) u();
      prog.clear();
    };
  }, []);

  return { items, progress, refresh };
}
