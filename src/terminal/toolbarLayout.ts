/**
 * 终端工具栏 / 标题行的图标集合与顺序（对照 Netcatty
 * `components/terminal/TerminalToolbar.tsx` 的 defaultLayout + placement，
 * 以及 `components/terminal/TerminalView.tsx` 状态栏的小图标行）。
 *
 * Netcatty 的 defaultLayout（placement=show 的项才在工具栏内联显示）：
 *   highlight → sftp → ymodem（仅串口，termX 用拖放/右键）→ compose → search
 *   （locked）→ sessionLog（showLogButton 时）→ scripts
 * 折叠到 ⋮ 的项：openSessionLog / history / configureOsc7 / terminalSettings /
 * recording / encoding —— termX 的 More 菜单与此一致；此外 Netcatty 工具栏
 * 没有「端口转发」，因此 termX 已移除该按钮（入口仍在 Vault 页）。
 *
 * 标题行（Netcatty 状态栏）顺序：
 *   复制主机地址 → 时间戳 Clock3 → 系统监控 Activity → 断开 Unplug → 重连 RefreshCcw。
 */

import {
  deriveToolbarCapabilities,
  type TerminalKind,
  type ToolbarCapabilities,
} from "./toolbarCapabilities";

/** 右侧主工具栏的内联条目顺序（Netcatty placement=show 的那些）。 */
export const TERMINAL_TOOLBAR_ACTIONS = [
  "highlight",
  "sftp",
  "compose",
  "search",
  "sessionLog",
  "scripts",
  // Netcatty 的笔记入口在侧栏工具 rail；termX 没有 rail，落在工具栏末尾（唯一新增项）。
  "notes",
] as const;

export type TerminalToolbarAction = (typeof TERMINAL_TOOLBAR_ACTIONS)[number];

/** 标题行小图标顺序（Netcatty TerminalView 状态栏）。 */
export const TERMINAL_TITLEBAR_ACTIONS = [
  "copyHost",
  "timestamps",
  "monitor",
  "disconnect",
  "reconnect",
] as const;

export type TerminalTitlebarAction = (typeof TERMINAL_TITLEBAR_ACTIONS)[number];

/**
 * 按终端类型过滤右侧工具栏条目（保持 Netcatty 顺序）。
 * 现在所有内联项都经能力表过滤，JSX 不再自己判断类型。
 */
/** 工具栏动作 → 能力字段（JSX 不再各自判断，统一走这张表）。 */
const TOOLBAR_CAPABILITY_OF: Record<TerminalToolbarAction, keyof ToolbarCapabilities> = {
  highlight: "highlight",
  sftp: "sftp",
  compose: "compose",
  search: "search",
  sessionLog: "sessionLog",
  scripts: "scripts",
  notes: "notes",
};

export function resolveTerminalToolbarActions(
  kind: TerminalKind,
): TerminalToolbarAction[] {
  const caps = deriveToolbarCapabilities(kind);
  return TERMINAL_TOOLBAR_ACTIONS.filter((action) => caps[TOOLBAR_CAPABILITY_OF[action]]);
}

/** More（⋮）菜单条目顺序（Netcatty 折叠项）。 */
export const TERMINAL_MORE_ACTIONS = [
  "history",
  "osc7",
  "terminalSettings",
  "recording",
  "encoding",
] as const;

export type TerminalMoreAction = (typeof TERMINAL_MORE_ACTIONS)[number];

const MORE_CAPABILITY_OF: Record<TerminalMoreAction, keyof ToolbarCapabilities> = {
  history: "menuHistory",
  osc7: "menuOsc7",
  terminalSettings: "menuTerminalSettings",
  recording: "menuRecording",
  encoding: "menuEncoding",
};

/** 按终端类型过滤 More 菜单条目（顺序固定）。 */
export function resolveTerminalMoreActions(kind: TerminalKind): TerminalMoreAction[] {
  const caps = deriveToolbarCapabilities(kind);
  return TERMINAL_MORE_ACTIONS.filter((action) => caps[MORE_CAPABILITY_OF[action]]);
}

/** 按终端类型过滤标题行条目（保持 Netcatty 顺序）。 */
export function resolveTerminalTitlebarActions(
  kind: TerminalKind,
): TerminalTitlebarAction[] {
  const caps = deriveToolbarCapabilities(kind);
  return TERMINAL_TITLEBAR_ACTIONS.filter((action) => {
    if (action === "copyHost") return caps.copyHost;
    if (action === "monitor") return caps.systemMonitor;
    return true;
  });
}
