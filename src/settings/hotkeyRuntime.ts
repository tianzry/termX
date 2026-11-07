/**
 * 快捷键运行时纯逻辑（对照 Netcatty `domain/models/keyBindings.ts` +
 * `application/app/tabShortcutTargets.ts` + `application/state/useShortcutModifierHeld.ts`）。
 *
 * 这里只做「组合键解析 / 事件匹配 / 标签序号目标 / 分屏焦点」，
 * 事件监听与动作分发见 `useGlobalHotkeys.ts`，单测见 `hotkeyRuntime.test.ts`。
 */

import type { KeyBinding } from "./keyBindings";
import { DEFAULT_KEY_BINDINGS, effectiveBinding } from "./keyBindings";
import type { AppSettings, HotkeyScheme } from "./settingsModel";
import type { PanePlacement } from "../workspaceModel";

/** 根标签 id：与 TopTabs / App 的 surface 对应，用于 Cmd/Ctrl+1…9 序号。 */
export const PINNED_VAULT_TAB_ID = "vault";
export const PINNED_SFTP_TAB_ID = "sftp";

// 设置页录制快捷键时，全局分发必须让路，否则 Ctrl+W 之类会先执行动作。
let captureDepth = 0;

export function beginHotkeyCapture(): void {
  captureDepth += 1;
}

export function endHotkeyCapture(): void {
  if (captureDepth > 0) captureDepth -= 1;
}

export function isHotkeyCaptureActive(): boolean {
  return captureDepth > 0;
}

/** 匹配所需的最小键盘事件字段（测试里可直接构造字面量）。 */
export interface HotkeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ParsedKeyCombo {
  modifiers: string[];
  key: string;
}

/** 解析 "⌘ + Shift + K" / "Ctrl + Alt + T"；"Disabled" 或空串返回 null。 */
export function parseKeyCombo(keyStr: string): ParsedKeyCombo | null {
  if (!keyStr || keyStr === "Disabled") return null;
  const parts = keyStr.split("+").map((p) => p.trim());
  const key = parts.pop() || "";
  return { modifiers: parts, key };
}

const KEY_STRING_TO_EVENT_KEY: Record<string, string> = {
  Space: " ",
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  "←": "ArrowLeft",
  "→": "ArrowRight",
  Esc: "Escape",
  "⌫": "Backspace",
  Del: "Delete",
  "↵": "Enter",
  "⇥": "Tab",
};

/** 由存储的快捷键文本重建一个 keydown 形态的事件（冲突检测 / 单测用）。 */
export function keyStringToKeyboardEvent(
  keyString: string,
): (HotkeyEventLike & { key: string }) | null {
  const parsed = parseKeyCombo(keyString);
  if (!parsed) return null;
  const modifiers = new Set(parsed.modifiers);
  const mapped = KEY_STRING_TO_EVENT_KEY[parsed.key];
  const key = mapped ?? (parsed.key.length === 1 ? parsed.key.toLowerCase() : parsed.key);
  return {
    key,
    code: "",
    metaKey: modifiers.has("⌘") || modifiers.has("Win"),
    ctrlKey: modifiers.has("⌃") || modifiers.has("Ctrl"),
    altKey: modifiers.has("⌥") || modifiers.has("Alt"),
    shiftKey: modifiers.has("Shift"),
  };
}

const PHYSICAL_SHORTCUT_KEY_NAMES: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

function physicalShortcutKeyName(e: Pick<HotkeyEventLike, "code">): string | null {
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return PHYSICAL_SHORTCUT_KEY_NAMES[code] ?? null;
}

/** 优先物理 Digit 码：这样 Shift+1（e.key = "!"）仍能命中 [1...9]。 */
export function tabShortcutDigitFromEvent(
  e: Pick<HotkeyEventLike, "key" | "code">,
): number | null {
  const key = physicalShortcutKeyName(e) ?? e.key;
  if (!/^[1-9]$/.test(key)) return null;
  return Number.parseInt(key, 10);
}

const LATIN_SHORTCUT_KEY_PATTERN = /^\p{Script=Latin}$/u;
const PRINTABLE_NON_LETTER_SHORTCUT_KEY_PATTERN = /^[^\p{Letter}\p{Number}\s]$/u;

function shortcutEventKey(e: HotkeyEventLike): string {
  const physical = physicalShortcutKeyName(e);
  if (LATIN_SHORTCUT_KEY_PATTERN.test(e.key) || PRINTABLE_NON_LETTER_SHORTCUT_KEY_PATTERN.test(e.key)) {
    return e.key;
  }
  return physical ?? e.key;
}

function normalizeKey(rawKey: string): string {
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

/** 与 Netcatty `matchesKeyBinding` 同规则（平台修饰键互斥 + 修饰键精确匹配 + 键名不区分大小写）。 */
export function matchesKeyBinding(
  e: HotkeyEventLike,
  keyStr: string,
  scheme: HotkeyScheme,
): boolean {
  if (!keyStr || keyStr === "Disabled") return false;

  if (keyStr.includes("[1...9]")) {
    const base = keyStr.replace("[1...9]", "");
    const digit = tabShortcutDigitFromEvent(e);
    if (digit === null) return false;
    return matchesKeyBinding(
      { ...e, key: String(digit) },
      (base + String(digit)).trim(),
      scheme,
    );
  }

  if (keyStr.includes("arrows")) {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return false;
    const symbol =
      e.key === "ArrowUp" ? "↑" : e.key === "ArrowDown" ? "↓" : e.key === "ArrowLeft" ? "←" : "→";
    return matchesKeyBinding(e, (keyStr.replace("arrows", "") + symbol).trim(), scheme);
  }

  const parsed = parseKeyCombo(keyStr);
  if (!parsed) return false;
  const { modifiers, key } = parsed;

  const hasMacModifiers = modifiers.some((m) => ["⌘", "⌃", "⌥"].includes(m));
  const hasPcModifiers = modifiers.some((m) => ["Ctrl", "Alt", "Win"].includes(m));
  if ((scheme !== "mac" && hasMacModifiers) || (scheme === "mac" && hasPcModifiers)) {
    return false;
  }

  if (scheme === "mac") {
    const needMeta = modifiers.includes("⌘");
    const needCtrl = modifiers.includes("⌃");
    const needAlt = modifiers.includes("⌥");
    const needShift = modifiers.includes("Shift");
    if (
      e.metaKey !== needMeta ||
      e.ctrlKey !== needCtrl ||
      e.altKey !== needAlt ||
      e.shiftKey !== needShift
    ) {
      return false;
    }
  } else {
    const needCtrl = modifiers.includes("Ctrl");
    const needAlt = modifiers.includes("Alt");
    const needShift = modifiers.includes("Shift");
    const needMeta = modifiers.includes("Win");
    if (
      e.ctrlKey !== needCtrl ||
      e.altKey !== needAlt ||
      e.shiftKey !== needShift ||
      e.metaKey !== needMeta
    ) {
      return false;
    }
  }

  return normalizeKey(shortcutEventKey(e)).toLowerCase() === normalizeKey(key).toLowerCase();
}

/** 当前方案下生效的绑定（含自定义覆盖；不含禁用过滤）。 */
export function resolveEffectiveBindings(
  settings: Pick<AppSettings, "customKeyBindings" | "hotkeyScheme">,
): Array<{ binding: KeyBinding; keyStr: string }> {
  return DEFAULT_KEY_BINDINGS.map((binding) => ({
    binding,
    keyStr: effectiveBinding(binding, settings, settings.hotkeyScheme),
  }));
}

export function isBindingDisabled(
  settings: Pick<AppSettings, "disabledKeyBindings">,
  id: string,
): boolean {
  return settings.disabledKeyBindings.includes(id);
}

/**
 * 从键按下事件找到第一个命中的绑定（DISABLED / 未绑定的条目跳过）。
 * 返回顺序 = DEFAULT_KEY_BINDINGS 表格顺序，即冲突优先级：靠前者胜。
 */
export function findMatchingBinding(
  e: HotkeyEventLike,
  settings: Pick<AppSettings, "customKeyBindings" | "hotkeyScheme" | "disabledKeyBindings">,
): { binding: KeyBinding; keyStr: string } | null {
  for (const { binding, keyStr } of resolveEffectiveBindings(settings)) {
    if (isBindingDisabled(settings, binding.id)) continue;
    if (matchesKeyBinding(e, keyStr, settings.hotkeyScheme)) return { binding, keyStr };
  }
  return null;
}

// ── 标签序号（对照 Netcatty tabShortcutTargets.ts）────────────────────────

export interface TabShortcutTargetInput {
  showSftpTab: boolean;
  shellOnlyTabNumberShortcuts: boolean;
  sessionTabIds: readonly string[];
}

/** 序号快捷键的目标顺序：固定标签（Vault / SFTP）+ 会话标签；「仅固定标签」时只看会话标签。 */
export function buildNumberShortcutTabTargets(input: TabShortcutTargetInput): string[] {
  const workTabs = [...new Set(input.sessionTabIds)];
  if (input.shellOnlyTabNumberShortcuts) return workTabs;
  const pinned = input.showSftpTab
    ? [PINNED_VAULT_TAB_ID, PINNED_SFTP_TAB_ID]
    : [PINNED_VAULT_TAB_ID];
  return [...new Set([...pinned, ...workTabs])];
}

/** 目标 id → 1…9 序号（只给前 9 个）。 */
export function buildTabShortcutNumberById(input: TabShortcutTargetInput): Map<string, number> {
  const targets = buildNumberShortcutTabTargets(input);
  const map = new Map<string, number>();
  for (let i = 0; i < Math.min(9, targets.length); i += 1) {
    map.set(targets[i], i + 1);
  }
  return map;
}

/** 当前激活 id 在目标列表中的位置（不在列表返回 -1）。 */
export function indexOfShortcutTarget(targets: readonly string[], activeId: string | null): number {
  return activeId === null ? -1 : targets.indexOf(activeId);
}

// ── 修饰键按住检测（对照 useShortcutModifierHeld.ts）────────────────────────

export interface ShortcutModifierRequirements {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_TOKENS: Record<HotkeyScheme, Record<string, keyof ShortcutModifierRequirements>> = {
  mac: { "⌘": "metaKey", "⌃": "ctrlKey", "⌥": "altKey", Shift: "shiftKey" },
  pc: { Ctrl: "ctrlKey", Alt: "altKey", Shift: "shiftKey", Win: "metaKey" },
};

/** [1...9] 绑定所需的修饰键组合；非范围 / 无修饰键 / 禁用返回 null。 */
export function getShortcutModifierRequirements(
  keyBinding: string | null,
  scheme: HotkeyScheme,
): ShortcutModifierRequirements | null {
  if (!keyBinding || !keyBinding.includes("[1...9]")) return null;
  const parsed = parseKeyCombo(keyBinding);
  if (!parsed || parsed.modifiers.length === 0) return null;
  const requirements: ShortcutModifierRequirements = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
  const tokens = MODIFIER_TOKENS[scheme];
  for (const modifier of parsed.modifiers) {
    const flag = tokens[modifier];
    if (!flag) return null;
    requirements[flag] = true;
  }
  return requirements;
}

/** 修饰键必须精确等于绑定要求（多按 / 少按都不显示角标）。 */
export function isShortcutModifierHeld(
  event: HotkeyEventLike,
  requirements: ShortcutModifierRequirements | null,
): boolean {
  if (!requirements) return false;
  return (
    event.metaKey === requirements.metaKey &&
    event.ctrlKey === requirements.ctrlKey &&
    event.altKey === requirements.altKey &&
    event.shiftKey === requirements.shiftKey
  );
}

// ── 冲突检测（设置页可复用；当前用于单测与回执）────────────────────────────

function canonicalCombo(keyStr: string, scheme: HotkeyScheme): string | null {
  const parsed = parseKeyCombo(keyStr);
  if (!parsed) return null;
  const tokens = MODIFIER_TOKENS[scheme];
  const mods = new Set<string>();
  for (const modifier of parsed.modifiers) {
    const flag = tokens[modifier];
    if (!flag) return null;
    mods.add(flag);
  }
  return `${[...mods].sort().join("+")}|${normalizeKey(parsed.key).toLowerCase()}`;
}

/** 同一方案下完全相同的组合键 = 冲突；返回冲突键与实际生效的条目 id。 */
export function findBindingConflicts(
  bindings: ReadonlyArray<{ id: string; keyStr: string }>,
  scheme: HotkeyScheme,
): Array<{ key: string; ids: string[] }> {
  const byKey = new Map<string, string[]>();
  const labelByKey = new Map<string, string>();
  for (const { id, keyStr } of bindings) {
    const canonical = canonicalCombo(keyStr, scheme);
    if (!canonical) continue;
    const ids = byKey.get(canonical) ?? [];
    ids.push(id);
    byKey.set(canonical, ids);
    if (!labelByKey.has(canonical)) labelByKey.set(canonical, keyStr);
  }
  return [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key: labelByKey.get(key) ?? key, ids }));
}

// ── 分屏焦点移动 ─────────────────────────────────────────────────────────

export type MoveFocusDirection = "left" | "right" | "up" | "down";

/**
 * 按窗格矩形找当前窗格在指定方向上的最近邻居（先比主轴距离，再比次轴偏移）。
 * 无候选返回 null（单窗格时快捷键应放行给终端）。
 */
export function resolveFocusTarget(
  panes: readonly PanePlacement[],
  activePaneId: string | null,
  direction: MoveFocusDirection,
): string | null {
  const current = panes.find((p) => p.paneId === activePaneId);
  if (!current) return null;
  const cx = current.rect.left + current.rect.width / 2;
  const cy = current.rect.top + current.rect.height / 2;

  let best: { paneId: string; score: number } | null = null;
  for (const pane of panes) {
    if (pane.paneId === current.paneId) continue;
    const px = pane.rect.left + pane.rect.width / 2;
    const py = pane.rect.top + pane.rect.height / 2;
    const dx = px - cx;
    const dy = py - cy;
    const inDirection =
      direction === "left" ? dx < 0 : direction === "right" ? dx > 0 : direction === "up" ? dy < 0 : dy > 0;
    if (!inDirection) continue;
    const primary = direction === "left" || direction === "right" ? Math.abs(dx) : Math.abs(dy);
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2;
    if (!best || score < best.score) best = { paneId: pane.paneId, score };
  }
  return best?.paneId ?? null;
}

// ── 字号缩放 ─────────────────────────────────────────────────────────────

export function clampFontSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
