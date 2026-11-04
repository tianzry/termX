/**
 * 端口转发自动启动 / 断线重连监督器。
 *
 * 对齐 Netcatty（`usePortForwardingAutoStart` + `portForwardingReconnect`）：
 * 这两项行为由渲染层驱动，而不是 ssh 连接本身。
 * - `auto_start`：应用启动后自动拉起每条标记条目（每个应用生命周期只尝试一次）；
 * - `auto_reconnect`：意外断开后有上限地重启；未显式设置时跟随 `auto_start`
 *   （Netcatty `autoReconnect ?? autoStart`）；
 * - 手动停止会从“期望运行”集合移除，避免被监督器重新拉起。
 *
 * 纯逻辑放 `planForwardTick`，便于单测；`useForwardSupervisor` 负责定时轮询。
 */

import { useEffect } from "react";
import * as api from "./backend/client";

/** 单个条目的最大重连次数（对齐 Netcatty 的有限重试思路）。 */
export const FORWARD_RECONNECT_LIMIT = 5;
export const FORWARD_SUPERVISOR_TICK_MS = 2500;

export interface ForwardSupervisorState {
  /** 用户 / 自动启动要求保持运行的条目。 */
  desired: Set<string>;
  /** 已尝试重启次数；条目重新活跃后清零。 */
  attempts: Map<string, number>;
  /** 已执行过自动启动的条目（每个应用生命周期一次）。 */
  autoStartTried: Set<string>;
}

export function createForwardSupervisorState(): ForwardSupervisorState {
  return {
    desired: new Set<string>(),
    attempts: new Map<string, number>(),
    autoStartTried: new Set<string>(),
  };
}

const state = createForwardSupervisorState();
const launching = new Set<string>();

/** 记录用户 / 监督器发起的启动。 */
export function noteForwardStarted(id: string): void {
  state.desired.add(id);
  state.attempts.delete(id);
  state.autoStartTried.add(id);
}

/** 记录手动停止，避免自动重连把它重新拉起。 */
export function noteForwardStopped(id: string): void {
  state.desired.delete(id);
  state.attempts.delete(id);
  // 手动停止也视为“本次启动已处理过”，避免首轮 auto_start 竞态把它重新拉起。
  state.autoStartTried.add(id);
}

/** 单测用：拿到与 `noteForward*` 一致的状态实例。 */
export function currentForwardSupervisorState(): ForwardSupervisorState {
  return state;
}

/** 单测用：清空模块级状态。 */
export function resetForwardSupervisorForTest(): void {
  state.desired.clear();
  state.attempts.clear();
  state.autoStartTried.clear();
  launching.clear();
}

/**
 * 一轮调度：返回本轮应调用 `forward_start` 的条目 id。
 * `activeIds` 来自 `forward_active_list`；`launching` 防止上一轮启动未完成时重复拉起。
 */
export function planForwardTick(
  forwards: api.Forward[],
  activeIds: Set<string>,
  supervisor: ForwardSupervisorState,
  inFlight: Set<string>,
): string[] {
  const launches: string[] = [];
  for (const forward of forwards) {
    if (activeIds.has(forward.id)) {
      supervisor.attempts.delete(forward.id);
      supervisor.autoStartTried.add(forward.id);
      continue;
    }

    if (forward.auto_start && !supervisor.autoStartTried.has(forward.id)) {
      supervisor.autoStartTried.add(forward.id);
      supervisor.desired.add(forward.id);
    }

    const reconnect = forward.auto_reconnect ?? forward.auto_start;
    if (!supervisor.desired.has(forward.id) || !reconnect) continue;
    if (inFlight.has(forward.id)) continue;

    const attempts = supervisor.attempts.get(forward.id) ?? 0;
    if (attempts >= FORWARD_RECONNECT_LIMIT) continue;

    supervisor.attempts.set(forward.id, attempts + 1);
    launches.push(forward.id);
  }
  return launches;
}

/** 应用级监督器：轮询转发配置与运行态，自动启动 / 重连。 */
export function useForwardSupervisor(): void {
  useEffect(() => {
    let stopped = false;

    async function tick() {
      try {
        const [forwards, active] = await Promise.all([
          api.listForwards(),
          api.forwardActiveList(),
        ]);
        if (stopped) return;
        const activeIds = new Set(active.map((info) => info.forward_id));
        const launches = planForwardTick(forwards, activeIds, state, launching);
        for (const id of launches) {
          launching.add(id);
          void api
            .forwardStart(id)
            .catch(() => {
              // 失败留在 attempts 里，下一轮继续重试直到上限；错误在主面板可见。
            })
            .finally(() => launching.delete(id));
        }
      } catch {
        // 后端尚未就绪（启动瞬间）时静默，下一轮会重试。
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), FORWARD_SUPERVISOR_TICK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
}
