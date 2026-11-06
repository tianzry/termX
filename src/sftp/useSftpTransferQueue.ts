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

  // 运行中项订阅字节进度；离开 running 即退订并清掉进度残留。
  const progressSubs = useRef(new Map<string, () => void>());
  /** 仍在运行的 id：异步订阅回来时据此决定是否保留（避免 effect 重跑误退订）。 */
  const liveRunning = useRef(new Set<string>());
  useEffect(() => {
    const subs = progressSubs.current;
    // 弹窗关闭时退订全部进度，并清掉缓存（下次打开重新订阅当前运行项）。
    if (!subscribeProgress) {
      liveRunning.current = new Set();
      if (subs.size > 0) {
        for (const u of subs.values()) u();
        subs.clear();
        setProgress({});
      }
      return;
    }
    const runningIds = new Set(
      items.filter((i) => i.status === "running").map((i) => i.id),
    );
    liveRunning.current = runningIds;
    for (const id of runningIds) {
      if (subs.has(id)) continue;
      void api.onSftpProgress(id, (p) => {
        setProgress((prev) => ({ ...prev, [id]: p }));
      }).then((u) => {
        if (!mounted.current || !liveRunning.current.has(id)) u();
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
  }, [items, subscribeProgress]);

  // 卸载：释放全部订阅。
  useEffect(() => {
    const updated = updatedSubs.current;
    const prog = progressSubs.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const u of updated.values()) u();
      updated.clear();
      for (const u of prog.values()) u();
      prog.clear();
    };
  }, []);

  return { items, progress, refresh };
}
