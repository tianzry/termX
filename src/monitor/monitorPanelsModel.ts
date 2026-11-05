/**
 * 监控多面板（#206）纯逻辑：默认面板、按面板筛主机、排序与草稿归一化。
 *
 * 「全部 SSH 主机」不是数据库行，而是前端固定默认面板（id = `all`），
 * 内容始终等于当前所有 SSH 主机；自定义面板只存主机 id 集合。
 */

import type { MonitorPanel, Profile } from "../backend/client";

export const ALL_PANELS_ID = "all";

export const MONITOR_INTERVALS = [2, 5, 10, 30] as const;
export const DEFAULT_MONITOR_INTERVAL = 2;

/** 0 = 自动列数；UI 允许 1-4 列。 */
export const MAX_MONITOR_COLUMNS = 4;

export function defaultMonitorPanel(sshProfiles: Profile[]): MonitorPanel {
  return {
    id: ALL_PANELS_ID,
    name: "全部 SSH 主机",
    host_ids: sshProfiles.map((profile) => profile.id),
    layout: "charts",
    columns: 0,
    interval: DEFAULT_MONITOR_INTERVAL,
    sort_order: 0,
  };
}

/** 默认面板始终排在最前，其余按 sort_order / 名称。 */
export function panelsWithDefault(
  panels: MonitorPanel[],
  sshProfiles: Profile[],
): MonitorPanel[] {
  return [defaultMonitorPanel(sshProfiles), ...sortPanels(panels.filter((p) => p.id !== ALL_PANELS_ID))];
}

export function sortPanels(panels: MonitorPanel[]): MonitorPanel[] {
  return [...panels].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  );
}

export function nextSortOrder(panels: MonitorPanel[]): number {
  return panels.reduce((max, panel) => Math.max(max, panel.sort_order), 0) + 1;
}

/** 默认面板 = 全部 SSH 主机；自定义面板按 id 集合过滤（已删除的主机自动忽略）。 */
export function profilesForPanel(
  sshProfiles: Profile[],
  panel: MonitorPanel,
): Profile[] {
  if (panel.id === ALL_PANELS_ID) return sshProfiles;
  const wanted = new Set(panel.host_ids);
  return sshProfiles.filter((profile) => wanted.has(profile.id));
}

function normalizeInterval(value: number): number {
  return MONITOR_INTERVALS.includes(value as (typeof MONITOR_INTERVALS)[number])
    ? value
    : DEFAULT_MONITOR_INTERVAL;
}

/**
 * 保存前归一化：名称去空白、主机去重且只保留仍存在的 SSH 主机、
 * 布局 / 列数 / 间隔收敛到 UI 支持范围。
 */
export function normalizePanelDraft(
  draft: MonitorPanel,
  sshProfileIds: ReadonlySet<string>,
): MonitorPanel {
  const hostIds: string[] = [];
  for (const raw of draft.host_ids) {
    const id = raw.trim();
    if (id && sshProfileIds.has(id) && !hostIds.includes(id)) hostIds.push(id);
  }
  return {
    ...draft,
    name: draft.name.trim(),
    host_ids: hostIds,
    layout: draft.layout === "list" ? "list" : "charts",
    columns: Math.min(MAX_MONITOR_COLUMNS, Math.max(0, Math.trunc(draft.columns) || 0)),
    interval: normalizeInterval(draft.interval),
    sort_order: Math.max(0, Math.trunc(draft.sort_order) || 0),
  };
}
