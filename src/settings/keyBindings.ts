/**
 * 快捷键模型（对照 Netcatty domain/models/keyBindings.ts）。
 *
 * DEFAULT_KEY_BINDINGS 逐条照抄 Netcatty（含 mac/pc 双方案与 Disabled 占位）；
 * 自定义覆盖 / 禁用列表存设置对象（settingsModel.customKeyBindings /
 * disabledKeyBindings），合并与按键捕获为纯函数，单测见 settings.test.ts。
 */

import type { AppSettings, HotkeyScheme } from "./settingsModel";

export type KeyBindingCategory = "tabs" | "terminal" | "navigation" | "app" | "sftp";

export interface KeyBinding {
  id: string;
  action: string;
  label: string;
  mac: string;
  pc: string;
  category: KeyBindingCategory;
}

export const DEFAULT_KEY_BINDINGS: KeyBinding[] = [
  // Tab Management
  { id: "switch-tab-1-9", action: "switchToTab", label: "Switch to Tab [1...9]", mac: "⌘ + [1...9]", pc: "Ctrl + [1...9]", category: "tabs" },
  { id: "next-tab", action: "nextTab", label: "Next Tab", mac: "⌘ + Shift + ]", pc: "Ctrl + Tab", category: "tabs" },
  { id: "prev-tab", action: "prevTab", label: "Previous Tab", mac: "⌘ + Shift + [", pc: "Ctrl + Shift + Tab", category: "tabs" },
  { id: "close-tab", action: "closeTab", label: "Close Tab", mac: "⌘ + W", pc: "Ctrl + W", category: "tabs" },
  { id: "close-session", action: "closeSession", label: "Close Session Pane", mac: "⌘ + Shift + W", pc: "Ctrl + Shift + W", category: "tabs" },
  { id: "new-tab", action: "newTab", label: "New Local Tab", mac: "⌘ + T", pc: "Ctrl + T", category: "tabs" },

  // Terminal Operations
  { id: "copy", action: "copy", label: "Copy from Terminal", mac: "⌘ + C", pc: "Ctrl + Shift + C", category: "terminal" },
  { id: "paste", action: "paste", label: "Paste to Terminal", mac: "⌘ + V", pc: "Ctrl + Shift + V", category: "terminal" },
  { id: "paste-selection", action: "pasteSelection", label: "Paste Selection to Terminal", mac: "⌘ + Shift + X", pc: "Ctrl + Shift + X", category: "terminal" },
  { id: "select-all", action: "selectAll", label: "Select All in Terminal", mac: "⌘ + A", pc: "Ctrl + Shift + A", category: "terminal" },
  { id: "clear-buffer", action: "clearBuffer", label: "Clear Terminal Buffer", mac: "⌘ + ⌃ + K", pc: "Ctrl + Shift + K", category: "terminal" },
  { id: "search-terminal", action: "searchTerminal", label: "Open Terminal Search", mac: "⌘ + F", pc: "Ctrl + F", category: "terminal" },
  { id: "increase-terminal-font-size", action: "increaseTerminalFontSize", label: "Increase Terminal Font Size", mac: "⌘ + =", pc: "Ctrl + =", category: "terminal" },
  { id: "decrease-terminal-font-size", action: "decreaseTerminalFontSize", label: "Decrease Terminal Font Size", mac: "⌘ + -", pc: "Ctrl + -", category: "terminal" },
  { id: "reset-terminal-font-size", action: "resetTerminalFontSize", label: "Reset Terminal Font Size", mac: "⌘ + 0", pc: "Ctrl + 0", category: "terminal" },

  // Navigation / Split View
  { id: "move-focus", action: "moveFocus", label: "Move focus between Split View panes", mac: "⌘ + ⌥ + arrows", pc: "Ctrl + Alt + arrows", category: "navigation" },
  { id: "split-horizontal", action: "splitHorizontal", label: "Split Horizontal", mac: "⌘ + D", pc: "Ctrl + Shift + D", category: "navigation" },
  { id: "split-vertical", action: "splitVertical", label: "Split Vertical", mac: "⌘ + Shift + D", pc: "Ctrl + Shift + E", category: "navigation" },
  { id: "toggle-pane-zoom", action: "togglePaneZoom", label: "Toggle Pane Zoom", mac: "⌥ + M", pc: "Alt + M", category: "navigation" },

  // App Features
  { id: "open-hosts", action: "openHosts", label: "Open Hosts Page", mac: "Disabled", pc: "Disabled", category: "app" },
  { id: "open-local", action: "openLocal", label: "Open Local Terminal", mac: "⌘ + L", pc: "Disabled", category: "app" },
  { id: "open-sftp", action: "openSftp", label: "Open SFTP", mac: "⌘ + Shift + O", pc: "Ctrl + Shift + O", category: "app" },
  { id: "port-forwarding", action: "portForwarding", label: "Open Port Forwarding", mac: "⌘ + P", pc: "Ctrl + P", category: "app" },
  { id: "command-palette", action: "commandPalette", label: "Open Command Palette", mac: "⌘ + K", pc: "Ctrl + K", category: "app" },
  { id: "quick-switch", action: "quickSwitch", label: "Quick Switch", mac: "⌘ + J", pc: "Ctrl + J", category: "app" },
  { id: "new-workspace", action: "newWorkspace", label: "New Workspace", mac: "⌘ + Shift + J", pc: "Ctrl + Shift + J", category: "app" },
  { id: "snippets", action: "snippets", label: "Open Snippets", mac: "⌘ + Shift + S", pc: "Ctrl + Shift + S", category: "app" },
  { id: "broadcast", action: "broadcast", label: "Switch the Broadcast Mode", mac: "⌘ + B", pc: "Ctrl + B", category: "app" },
  { id: "toggle-side-panel", action: "toggleSidePanel", label: "Toggle Side Panel", mac: "⌘ + \\", pc: "Ctrl + \\", category: "app" },
  { id: "toggle-host-tree", action: "toggleHostTree", label: "Toggle Host List", mac: "⌘ + Shift + B", pc: "Ctrl + Shift + B", category: "app" },
  { id: "open-settings", action: "openSettings", label: "Open Settings", mac: "⌘ + ,", pc: "Ctrl + ,", category: "app" },
  { id: "toggle-opacity", action: "toggleOpacity", label: "Toggle Window Transparency", mac: "⌘ + U", pc: "Ctrl + Shift + U", category: "app" },

  // SFTP Operations
  { id: "sftp-copy", action: "sftpCopy", label: "Copy Files", mac: "⌘ + C", pc: "Ctrl + C", category: "sftp" },
  { id: "sftp-cut", action: "sftpCut", label: "Cut Files", mac: "⌘ + X", pc: "Ctrl + X", category: "sftp" },
  { id: "sftp-paste", action: "sftpPaste", label: "Paste Files", mac: "⌘ + V", pc: "Ctrl + V", category: "sftp" },
  { id: "sftp-select-all", action: "sftpSelectAll", label: "Select All Files", mac: "⌘ + A", pc: "Ctrl + A", category: "sftp" },
  { id: "sftp-rename", action: "sftpRename", label: "Rename File", mac: "F2", pc: "F2", category: "sftp" },
];

/** 分类展示顺序与标题（文案在 i18n 字典：settings.shortcuts.category.*）。 */
export const BINDING_CATEGORY_ORDER: KeyBindingCategory[] = [
  "tabs",
  "terminal",
  "navigation",
  "app",
  "sftp",
];

/** 当前方案下生效的绑定文本（自定义覆盖 > 默认）。 */
export function effectiveBinding(
  binding: KeyBinding,
  settings: Pick<AppSettings, "customKeyBindings">,
  scheme: HotkeyScheme,
): string {
  const override = settings.customKeyBindings[binding.id];
  const custom = override?.[scheme];
  if (typeof custom === "string" && custom.length > 0) return custom;
  return scheme === "mac" ? binding.mac : binding.pc;
}

/** 按键捕获：把 KeyboardEvent 序列化为 Netcatty 风格的绑定文本；纯修饰键返回 null。 */
export function captureBinding(e: KeyboardEvent, scheme: HotkeyScheme): string | null {
  const key = e.key;
  if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") return null;

  const mods: string[] = [];
  if (scheme === "mac") {
    if (e.metaKey) mods.push("⌘");
    if (e.ctrlKey) mods.push("⌃");
    if (e.altKey) mods.push("⌥");
    if (e.shiftKey) mods.push("Shift");
  } else {
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Win");
  }

  return [...mods, normalizeKeyName(key)].join(" + ");
}

/** 键名规范化（对照 Netcatty keyBindings.ts normalizeKey）。 */
export function normalizeKeyName(rawKey: string): string {
  switch (rawKey) {
    case " ":
      return "Space";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "Escape":
      return "Esc";
    case "Backspace":
      return "⌫";
    case "Delete":
      return "Del";
    default:
      return rawKey;
  }
}
