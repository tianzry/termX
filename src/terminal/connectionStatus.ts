/**
 * 连接状态 → 会话标签状态点（对照 Netcatty `components/top-tabs/TopTabItems.tsx`）：
 * Netcatty 的 {@link sessionStatusDot} 为 8px 圆点，配色
 * connected = emerald-400(#34d399)、connecting = amber-400(#fbbf24)、
 * 其余（disconnected / 错误）= rose-500(#f43f5e)，外加 2px 半透明外圈。
 * 串口 / Telnet 与 SSH 使用同一状态集合（Netcatty 无额外「端口状态点」；
 * 端口转发状态的圆点只出现在转发列表项，不在会话标签上）。
 */

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * 标签状态点样式类：Netcatty 只区分 connected / connecting / 其他，
 * 因此这里把错误态与断开态都归到 disconnected（rose）。
 */
export function resolveConnectionDotClass(
  status: ConnectionStatus | undefined,
): ConnectionStatus {
  if (status === "connected") return "connected";
  if (status === "disconnected") return "disconnected";
  // 未上报 ≠ 已断开：新建标签先显示 connecting（琥珀），避免先红一帧。
  return "connecting";
}

/**
 * 计算某个标签的状态：取该标签全部窗格的聚合值——
 * 任一窗格断开 → disconnected（状态点职责是提示异常，分屏不能因活动窗格正常就掩盖断线）；
 * 否则任一窗格未上报 / 连接中 → connecting；全部连接成功才返回 connected。
 */
export function resolveTabConnectionStatus({
  paneStatuses,
  paneIds,
}: {
  paneStatuses: Record<string, ConnectionStatus>;
  paneIds: string[];
}): ConnectionStatus {
  if (paneIds.length === 0) return "connecting";
  const statuses = paneIds.map((id) => paneStatuses[id]);
  if (statuses.some((s) => s === "disconnected")) return "disconnected";
  if (statuses.some((s) => s === undefined || s === "connecting")) return "connecting";
  return "connected";
}
