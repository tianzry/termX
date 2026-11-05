/**
 * 终端右键菜单项派生（对照 Netcatty `components/terminal/TerminalContextMenu.tsx`）。
 *
 * Netcatty 的顺序：复制 → 粘贴 →（剪贴板图片 / 加入对话 / 粘贴选中文本）→ 全选
 * → ⌁ 打开 SFTP（ssh）→ ⌁ 打开浏览器 → ⌁ 重新连接（仅断线）→ ⌁ YMODEM（串口）
 * → ⌁ 水平分屏 / 垂直分屏 → ⌁（保存屏幕）清空缓冲区 → ⌁（重命名）→ ⌁（移出工作区）
 * → ⌁ 插件菜单 → ⌁ 关闭终端（destructive）。
 *
 * termX 尚未实现的入口（剪贴板图片、加入对话、粘贴选中文本、打开浏览器、
 * YMODEM、保存屏幕、重命名、移出工作区、插件菜单）不渲染假按钮（AGENTS Pr3），
 * 因此这里只派生已落地项；分隔线跟随所属分组存在与否，避免出现悬空横线。
 */

import type { IconName } from "../ui/icons";
import type { ConnectionStatus } from "./connectionStatus";

/** 当前窗格可提供的菜单动作（其余能力未实现，保持缺席）。 */
export type TerminalContextMenuAction =
  | "copy"
  | "paste"
  | "selectAll"
  | "openSftp"
  | "reconnect"
  | "splitHorizontal"
  | "splitVertical"
  | "clearBuffer"
  | "closeTerminal";

export interface TerminalContextMenuItemSpec {
  kind: "item";
  action: TerminalContextMenuAction;
  /** 图标名（lucide 风格，尺寸 14 由渲染层统一）。 */
  icon: IconName;
  /** 快捷键展示用的 keyBindings action；null 表示无提示。 */
  shortcutAction: string | null;
  disabled: boolean;
  danger?: boolean;
}

export interface TerminalContextMenuSeparatorSpec {
  kind: "separator";
  id: string;
}

export type TerminalContextMenuSpec =
  | TerminalContextMenuItemSpec
  | TerminalContextMenuSeparatorSpec;

export interface TerminalContextMenuState {
  /** 会话是否已连接（SFTP 入口要求已连接）。 */
  connected: boolean;
  status: ConnectionStatus;
  /** 终端当前是否有选中文本（复制 / 粘贴选中文本的启用条件）。 */
  hasSelection: boolean;
  /** 该传输类型是否支持 SFTP（对照 toolbarLayout 的 sftp 能力）。 */
  showSftp: boolean;
  /** 是否提供分屏回调。 */
  canSplit: boolean;
  /** 是否提供关闭窗格回调。 */
  canClosePane: boolean;
}

export function resolveTerminalContextMenu(
  state: TerminalContextMenuState,
): TerminalContextMenuSpec[] {
  const items: TerminalContextMenuSpec[] = [];
  const pushItems = (list: TerminalContextMenuItemSpec[]) => {
    // 仅当分组至少有一项时才补分隔线，避免连续虚线。
    if (list.length === 0) return;
    if (items.length > 0) {
      items.push({ kind: "separator", id: `sep-${list[0].action}` });
    }
    items.push(...list);
  };

  pushItems([
    {
      kind: "item",
      action: "copy",
      icon: "copy",
      shortcutAction: "copy",
      disabled: !state.hasSelection,
    },
    {
      kind: "item",
      action: "paste",
      icon: "clipboard-paste",
      shortcutAction: "paste",
      disabled: false,
    },
    {
      kind: "item",
      action: "selectAll",
      icon: "terminal",
      shortcutAction: "selectAll",
      disabled: false,
    },
  ]);

  if (state.showSftp) {
    pushItems([
      {
        kind: "item",
        action: "openSftp",
        icon: "folder-input",
        shortcutAction: null,
        disabled: !state.connected,
      },
    ]);
  }

  if (state.status === "disconnected") {
    pushItems([
      {
        kind: "item",
        action: "reconnect",
        icon: "refresh",
        shortcutAction: null,
        disabled: false,
      },
    ]);
  }

  pushItems([
    {
      kind: "item",
      action: "splitHorizontal",
      icon: "columns",
      shortcutAction: "splitHorizontal",
      disabled: !state.canSplit,
    },
    {
      kind: "item",
      action: "splitVertical",
      icon: "rows",
      shortcutAction: "splitVertical",
      disabled: !state.canSplit,
    },
  ]);

  pushItems([
    {
      kind: "item",
      action: "clearBuffer",
      icon: "trash",
      shortcutAction: "clearBuffer",
      disabled: false,
    },
  ]);

  if (state.canClosePane) {
    pushItems([
      {
        kind: "item",
        action: "closeTerminal",
        icon: "trash",
        shortcutAction: null,
        disabled: false,
        danger: true,
      },
    ]);
  }

  return items;
}
