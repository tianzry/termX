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
  if (status === "connecting") return "connecting";
  return "disconnected";
}

/**
 * 计算某个标签的状态：优先取活动窗格的状态，活动窗格不属于该标签时
 * 回落到该标签的第一个窗格；尚无状态时视为 connecting（新建会话的初始态）。
 */
export function resolveTabConnectionStatus({
  paneStatuses,
  paneIds,
  activePaneId,
}: {
  paneStatuses: Record<string, ConnectionStatus>;
  paneIds: string[];
  activePaneId: string | null;
}): ConnectionStatus {
  const target =
    activePaneId && paneIds.includes(activePaneId) ? activePaneId : paneIds[0];
  if (!target) return "connecting";
  return paneStatuses[target] ?? "connecting";
}
