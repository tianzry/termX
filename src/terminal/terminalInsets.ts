/**
 * 终端内容区留白（对照 Netcatty `TerminalView.tsx` 的 xterm 容器）：
 * 容器 inset 4px + 左额外 paddingLeft 6px → 视口边到文本左 10 / 右 4 / 上 4 / 下 4。
 *
 * termX 的 `.pane` 已自带 4px padding（等价于 Netcatty 的容器 inset），
 * 所以只给 `.terminal` 补左侧 6px；开启时间戳 gutter 时，
 * gutter（56px）本身占据左栏，终端侧仍保持 6px，总左侧变为 66px（与 Netcatty 一致）。
 * 留白加在 xterm 父容器上，FitAddon 按父容器内容区（已扣除 padding）计算列数/行数，
 * 因此不会出现右侧裁切；滚动条、选区、搜索定位都在内容区内。
 */
export const TERMINAL_PANE_PADDING = 4;

/** 应用于 xterm 父容器的 padding（上/右/下由 pane 提供）。 */
export const TERMINAL_INSETS = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 6,
} as const;

/** Netcatty 实测的视口边到内容留白（用于样式对齐与回归断言）。 */
export const TERMINAL_VIEW_INSETS = {
  top: TERMINAL_PANE_PADDING + TERMINAL_INSETS.top,
  right: TERMINAL_PANE_PADDING + TERMINAL_INSETS.right,
  bottom: TERMINAL_PANE_PADDING + TERMINAL_INSETS.bottom,
  left: TERMINAL_PANE_PADDING + TERMINAL_INSETS.left,
} as const;

export function terminalInsetsStyle(): {
  padding: string;
  boxSizing: "border-box";
} {
  const { top, right, bottom, left } = TERMINAL_INSETS;
  return {
    padding: `${top}px ${right}px ${bottom}px ${left}px`,
    boxSizing: "border-box",
  };
}

/** 可用内容尺寸（= pane 外框尺寸扣除视口留白；负值收敛为 0）。 */
export function terminalContentSize(
  width: number,
  height: number,
): { width: number; height: number } {
  return {
    width: Math.max(0, width - TERMINAL_VIEW_INSETS.left - TERMINAL_VIEW_INSETS.right),
    height: Math.max(0, height - TERMINAL_VIEW_INSETS.top - TERMINAL_VIEW_INSETS.bottom),
  };
}
