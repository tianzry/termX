/**
 * 终端侧栏面板（对齐 Netcatty `domain/sidePanelLayout.ts` +
 * `application/state/terminalSidePanelWidth.ts` 的 termX 子集）：
 * - 宽度常量与夹取：默认 420 / 最小 280 / 最大 1200，且给终端至少留 320；
 * - 工具按钮溢出：面板宽度决定最多内联几个 tab，其余进「更多」；
 * - 宽度持久化 key 与解析。
 *
 * 纯函数、无 React / 无副作用，单测见 `terminalSidePanel.test.ts`。
 */

export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAX_WIDTH = 1200;
export const SIDE_PANEL_MIN_TERMINAL_WIDTH = 320;
/** 单个工具按钮占位宽：按钮 24px + 间距 4px（与工具栏共享令牌一致）。 */
export const SIDE_PANEL_TOOL_SLOT_WIDTH = 28;
export const SIDE_PANEL_TOOLBAR_RESERVED_WIDTH = 200;
export const SIDE_PANEL_DEFAULT_WIDTH = 420;

/**
 * 侧栏可承载的工具页（对齐 Netcatty tab 顺序 sftp → browser → scripts →
 * history → theme → system → notes → ai；红圈排除项 browser / theme /
 * system 不在其中）。
 */
export const SIDE_PANEL_TOOLS = [
  "sftp",
  "scripts",
  "history",
  "notes",
] as const;
export type SidePanelTool = (typeof SIDE_PANEL_TOOLS)[number];

export const SIDE_PANEL_WIDTH_STORAGE_KEY = "termx.terminalSidePanel.width.v1";

/** 面板最大宽度：不超过 1200，且终端至少保留 320。 */
export function getSidePanelMaxWidth(availableSurfaceWidth: number): number {
  const availableWidth = availableSurfaceWidth - SIDE_PANEL_MIN_TERMINAL_WIDTH;
  return Math.max(
    SIDE_PANEL_MIN_WIDTH,
    Math.min(SIDE_PANEL_MAX_WIDTH, availableWidth),
  );
}

/** 夹取面板宽度（窗口缩放 / 拖拽 / 读持久化值后都要过一遍）。 */
export function clampSidePanelWidth(
  width: number,
  availableSurfaceWidth: number,
  contentMinimumWidth = SIDE_PANEL_MIN_WIDTH,
): number {
  const maximumWidth = getSidePanelMaxWidth(availableSurfaceWidth);
  const minimumWidth = Math.min(
    maximumWidth,
    Math.max(SIDE_PANEL_MIN_WIDTH, contentMinimumWidth),
  );
  const safeWidth = Number.isFinite(width) ? width : SIDE_PANEL_DEFAULT_WIDTH;
  return Math.max(minimumWidth, Math.min(maximumWidth, safeWidth));
}

/** 当前宽度最多内联显示几个工具按钮（其余进「更多」）。 */
export function getSidePanelMaxShownTools(panelWidth: number): number {
  return Math.max(
    1,
    Math.floor(
      (panelWidth - SIDE_PANEL_TOOLBAR_RESERVED_WIDTH) /
        SIDE_PANEL_TOOL_SLOT_WIDTH,
    ),
  );
}

export interface SidePanelToolTabs {
  shown: SidePanelTool[];
  hidden: SidePanelTool[];
}

/** 工具页按宽度分配：前 N 个内联，其余进溢出菜单。 */
export function resolveSidePanelToolTabs(
  tools: readonly SidePanelTool[],
  panelWidth: number,
): SidePanelToolTabs {
  const maxShown = getSidePanelMaxShownTools(panelWidth);
  return {
    shown: tools.slice(0, maxShown),
    hidden: tools.slice(maxShown),
  };
}

/** 读取持久化宽度；空 / 非法 / 越界都回落到默认值（再夹取一次）。 */
export function parseStoredSidePanelWidth(
  raw: string | null,
  availableSurfaceWidth: number,
): number {
  if (raw === null || raw.trim() === "") return SIDE_PANEL_DEFAULT_WIDTH;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return SIDE_PANEL_DEFAULT_WIDTH;
  return clampSidePanelWidth(parsed, availableSurfaceWidth);
}
