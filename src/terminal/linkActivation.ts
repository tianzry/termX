/**
 * 终端链接激活与搜索快捷键的纯逻辑（对照 Netcatty `createXTermRuntime.ts`
 * 的 `canActivateTerminalLink` 与 `useTerminalSearch.ts` 的 Cmd/Ctrl+F 热键）。
 */

export type LinkModifier = "none" | "ctrl" | "alt" | "meta";

export interface ModifierState {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** 终端内链接是否允许激活：none = 直接点击，其余需按住对应修饰键。 */
export function linkModifierAllows(
  modifier: LinkModifier | undefined,
  event: ModifierState,
): boolean {
  switch (modifier) {
    case "ctrl":
      return event.ctrlKey;
    case "alt":
      return event.altKey;
    case "meta":
      return event.metaKey;
    default:
      return true;
  }
}

export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 终端搜索快捷键：Cmd/Ctrl+F（不含 Shift / Alt）。 */
export function isFindShortcut(event: ShortcutEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f"
  );
}
