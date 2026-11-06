/**
 * 主机级关键字高亮的前端联动。
 *
 * 主机档案保存成功后广播 profileId，已打开的终端据此重拉档案，实现
 * 「改完主机规则立即生效、无需重启」（对齐 Netcatty HostKeywordHighlightPopover
 * 的 onUpdateHost → 终端重算 mergedRules）。
 *
 * 为什么不用后端事件：`profiles:changed` 目前只由发行版探测发；主机编辑在
 * 前端完成，编辑方直接广播更省事，也避免给命令层加 AppHandle 依赖。
 */

type Listener = (profileId: string) => void;

const listeners = new Set<Listener>();

/** 通知指定主机的档案已变更（规则 / 开关 / 甚至删除后重拉）。 */
export function notifyHostKeywordHighlightChanged(profileId: string): void {
  for (const listener of Array.from(listeners)) listener(profileId);
}

/** 订阅主机档案变更；返回退订函数。 */
export function subscribeHostKeywordHighlightChanged(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
