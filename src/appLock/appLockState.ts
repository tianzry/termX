/**
 * 应用锁运行态 store（#23）。
 *
 * - 锁定状态由后端 settings 表持久化（`app_lock_state` 命令读取）。
 * - 解锁口令校验在 Rust 侧（PBKDF2-SHA256），前端只拿布尔结果。
 * - 遮罩组件 `AppLockGate` 订阅本 store；设置中心通过 `lockNow()` 广播。
 *
 * 对标 Netcatty `application/state/useAppLockState.ts` + `domain/appLock.ts`：
 * 口令档位已移植；系统凭据（Touch ID / Windows Hello）需原生 helper，置灰。
 */

import { useSyncExternalStore } from "react";
import * as api from "../backend/client";

export type AppLockStateData = api.AppLockState;

export const DEFAULT_APP_LOCK_STATE: AppLockStateData = {
  enabled: false,
  has_password: false,
  timeout_minutes: 15,
};

/** 与 Netcatty `APP_LOCK_TIMEOUT_OPTIONS_MINUTES` 对齐。 */
export const APP_LOCK_TIMEOUT_OPTIONS = [0, 1, 5, 15, 30, 60] as const;

/** 设置中心「立即锁定」→ 遮罩组件的进程内广播。 */
export const APP_LOCK_NOW_EVENT = "termx:app-lock:lock-now";

type Listener = () => void;
let current: AppLockStateData = DEFAULT_APP_LOCK_STATE;
const listeners = new Set<Listener>();

export function getAppLockState(): AppLockStateData {
  return current;
}

export function subscribeAppLock(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

export function useAppLock(): AppLockStateData {
  return useSyncExternalStore(subscribeAppLock, getAppLockState, getAppLockState);
}

let loadStarted = false;

/** 启动时加载（幂等）；失败回落默认（未启用）。 */
export async function loadAppLock(): Promise<AppLockStateData> {
  if (loadStarted) return current;
  loadStarted = true;
  await refreshAppLock();
  return current;
}

export async function refreshAppLock(): Promise<AppLockStateData> {
  try {
    current = await api.getAppLockState();
  } catch {
    current = DEFAULT_APP_LOCK_STATE;
  }
  emit();
  return current;
}

function applyState(next: AppLockStateData): AppLockStateData {
  current = next;
  emit();
  return next;
}

export function setAppLockPassword(
  currentPassword: string | null,
  nextPassword: string,
): Promise<AppLockStateData> {
  return api.appLockSetPassword(currentPassword, nextPassword).then(applyState);
}

export function disableAppLock(currentPassword: string): Promise<AppLockStateData> {
  return api.appLockDisable(currentPassword).then(applyState);
}

export function unlockAppLock(password: string): Promise<boolean> {
  return api.appLockUnlock(password);
}

export function setAppLockEnabled(enabled: boolean): Promise<AppLockStateData> {
  return api.appLockSetEnabled(enabled).then(applyState);
}

export function setAppLockTimeout(minutes: number): Promise<AppLockStateData> {
  return api.appLockSetTimeout(minutes).then(applyState);
}

export function lockNow(): void {
  window.dispatchEvent(new Event(APP_LOCK_NOW_EVENT));
}

/**
 * 失焦/隐藏后回到前台是否需要重新验证。
 * `timeoutMinutes === 0` → 立即；否则按离开时长判断。
 */
export function shouldLockAfterReturn(
  hiddenAt: number | null,
  now: number,
  timeoutMinutes: number,
  enabled: boolean,
): boolean {
  if (!enabled || hiddenAt === null) return false;
  if (timeoutMinutes <= 0) return true;
  return now - hiddenAt >= timeoutMinutes * 60_000;
}
