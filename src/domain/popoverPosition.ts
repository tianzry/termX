/**
 * 弹层定位：把锚点按钮旁的浮层坐标限制在视口内。
 *
 * 侧栏工具条按钮只有 24px 宽且贴着窗口左缘，右对齐的菜单会向左溢出窗口，
 * 被上层 `.nc-shell` 的 overflow:hidden 裁掉——所以浮层必须 portal 到 body
 * 并在这里算好 fixed 坐标，而不是改祖先的 overflow/z-index 掩盖。
 */

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PopoverPosition {
  left: number;
  /** 视口内可用高度不足时的最大高度；为 null 表示无需限制。 */
  maxHeight: number | null;
  top: number;
}

export interface PlaceOptions {
  /** 锚点与浮层之间的间距。 */
  gap?: number;
  /** 浮层与视口边缘的最小留白。 */
  margin?: number;
  /** end = 浮层右边对齐锚点右边；start = 左边对齐锚点左边。 */
  align?: "start" | "end";
}

export function placeAnchoredPopover(
  anchor: AnchorRect,
  popover: PopoverSize,
  viewport: ViewportSize,
  options: PlaceOptions = {},
): PopoverPosition {
  const gap = options.gap ?? 4;
  const margin = options.margin ?? 8;
  const align = options.align ?? "end";

  const rawLeft = align === "end" ? anchor.right - popover.width : anchor.left;
  const maxLeft = Math.max(margin, viewport.width - popover.width - margin);
  const left = Math.round(Math.min(Math.max(rawLeft, margin), maxLeft));

  // 下方放不下时，只有上方更宽松才上翻；上下都放不下就选空间更大的一侧并限高滚动。
  const spaceBelow = viewport.height - margin - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap - margin;
  const flipped = popover.height > spaceBelow && spaceAbove > spaceBelow;

  let top = flipped ? anchor.top - gap - popover.height : anchor.bottom + gap;
  if (top < margin) top = margin;

  const limit = viewport.height - margin - top;
  const maxHeight = popover.height > limit ? Math.max(0, Math.floor(limit)) : null;

  return { left, maxHeight, top: Math.round(top) };
}
