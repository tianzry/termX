/**
 * Vault 首页「主机」分区的展示选择（回归修复）。
 *
 * Netcatty 语义里根部「主机」节会排除「已置顶 / 最近连接」的条目；
 * 当所有主机都被这两个分区覆盖时，remaining 会为空。
 * 原实现沿用「remaining 为空就整节隐藏」，用户连接一台主机后关闭标签
 * 回到首页，会看到「主机」节整节消失（误以为主机列表丢失）。
 *
 * 修复：remaining 为空时回退展示 scopedHosts（仍遵守「根目录仅显示未分组」
 * 设置）；只有确实没有任何主机时才隐藏该节。保留非空时的去重展示
 * （不改变 Netcatty 布局）。
 */
export function rootHostsForDisplay<T extends { group_id?: string | null }>(
  scopedHosts: T[],
  rootRemaining: T[],
  onlyUngrouped = false,
): T[] {
  if (rootRemaining.length > 0) return rootRemaining;
  return onlyUngrouped
    ? scopedHosts.filter((p) => !p.group_id)
    : scopedHosts;
}

/** 仅在确实没有主机（或被搜索/树视图接管）时隐藏根部「主机」节。 */
export function shouldHideRootHostsSection(input: {
  atRoot: boolean;
  view: string;
  keyword: string;
  hostCount: number;
}): boolean {
  const { atRoot, view, keyword, hostCount } = input;
  return atRoot && view !== "tree" && !keyword && hostCount === 0;
}
