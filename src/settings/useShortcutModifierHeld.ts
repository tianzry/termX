/**
 * 「按住快捷键修饰键时显示标签序号角标」（对照 Netcatty useShortcutModifierHeld):
 * keydown/keyup 精确匹配 [1...9] 绑定所需的修饰键；多按 / 少按都不显示。
 * 窗口失焦 / 页面隐藏时清空，避免 Ctrl+Tab 切走后角标残留。
 */

import { useEffect, useState } from "react";
import {
  getShortcutModifierRequirements,
  isShortcutModifierHeld,
} from "./hotkeyRuntime";
import type { HotkeyScheme } from "./settingsModel";

export function useShortcutModifierHeld(
  keyBinding: string | null,
  scheme: HotkeyScheme,
): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const requirements = getShortcutModifierRequirements(keyBinding, scheme);
    if (!requirements) {
      setHeld(false);
      return;
    }
    const update = (e: KeyboardEvent) => {
      setHeld(isShortcutModifierHeld(e, requirements));
    };
    const clear = () => setHeld(false);
    window.addEventListener("keydown", update, true);
    window.addEventListener("keyup", update, true);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", update, true);
      window.removeEventListener("keyup", update, true);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [keyBinding, scheme]);

  return held;
}
