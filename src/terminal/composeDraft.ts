/**
 * 撰写栏草稿持久化（按「已保存主机」分键）。
 *
 * 语义：只有绑定已保存主机的终端才保存草稿——SSH 主机必保存；
 * 串口 / Telnet 仅在来自已保存主机时才保存；本地 shell（pty）一律不保存。
 * 存储走 localStorage（与命令历史 / 编码偏好一致，跨重启保留）。
 */

import type { Connector } from "../workspaceModel";

export const COMPOSE_DRAFT_STORAGE_PREFIX = "termx.composeDraft.v1.";

/**
 * 草稿分桶键：null = 临时终端（不保存也不恢复）。
 * 同一主机的不同会话共享一份草稿（与 Netcatty 按主机记忆一致）。
 */
export function resolveComposeDraftKey(connector: Connector): string | null {
  switch (connector.kind) {
    case "ssh":
      return `ssh:${connector.profileId}`;
    case "serial":
      return connector.profileId ? `serial:${connector.profileId}` : null;
    case "telnet":
      // Telnet 会话参数自带来源主机 id（`telnetSessionFromProfile` 写入）。
      return connector.session.profileId
        ? `telnet:${connector.session.profileId}`
        : null;
    case "pty":
      return null;
  }
}

function storageKey(bucketId: string): string {
  return `${COMPOSE_DRAFT_STORAGE_PREFIX}${encodeURIComponent(bucketId)}`;
}

/** 读取草稿；无键 / 存储不可用 / 内容为空时返回空串。 */
export function loadComposeDraft(bucketId: string | null): string {
  if (!bucketId) return "";
  try {
    return window.localStorage.getItem(storageKey(bucketId)) ?? "";
  } catch {
    return "";
  }
}

/** 写入草稿；空白内容视为已删除，直接移除键。 */
export function saveComposeDraft(bucketId: string | null, text: string): void {
  if (!bucketId) return;
  try {
    if (!text.trim()) {
      window.localStorage.removeItem(storageKey(bucketId));
      return;
    }
    window.localStorage.setItem(storageKey(bucketId), text);
  } catch {
    // 存储不可用时仅本次生效。
  }
}
