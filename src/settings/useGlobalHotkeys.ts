/**
 * 全局快捷键分发（对照 Netcatty `application/app/AppHandlers.ts` 的 window keydown
 * 与 `application/state/useGlobalHotkeys.ts` 的终端放行集合）。
 *
 * 规则：
 * - 输入框 / 文本域 / contenteditable / Monaco 内不触发（xterm 的隐藏 textarea 除外）；
 * - SFTP 文件操作绑定不参与全局分发；
 * - 动作返回 false（当前上下文不适用）时不拦截，继续留给下一条绑定 / 终端；
 * - 生效绑定来自设置对象，改绑后下一次按键立即使用新值。
 */

import { useEffect, useRef } from "react";
import type { KeyBinding } from "./keyBindings";
import { findMatchingBinding, clampFontSize, isHotkeyCaptureActive } from "./hotkeyRuntime";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "./settingsModel";
import { getSettings, updateSettings } from "./settingsStore";

/** 终端内由快捷键层直接处理的动作（Netcatty TERMINAL_PASSTHROUGH_ACTIONS）。 */
export const TERMINAL_PASSTHROUGH_ACTIONS = new Set<string>([
  "copy",
  "paste",
  "pasteSelection",
  "selectAll",
  "clearBuffer",
  "searchTerminal",
  "increaseTerminalFontSize",
  "decreaseTerminalFontSize",
  "resetTerminalFontSize",
]);

export type HotkeyExecutor = (binding: KeyBinding, event: KeyboardEvent) => boolean;

export function useGlobalHotkeys(execute: HotkeyExecutor): void {
  const executeRef = useRef(execute);
  executeRef.current = execute;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isHotkeyCaptureActive()) return;
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;

      const target = e.target instanceof Element ? e.target : null;
      const inXterm = target?.closest(".xterm") != null;
      const inFormField =
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [contenteditable=''], [contenteditable]",
        ) != null;
      if (target?.closest(".monaco-editor") != null) return;
      if (inFormField && !inXterm) return;

      const settings = getSettings();
      const match = findMatchingBinding(e, settings);
      if (!match) return;
      if (match.binding.category === "sftp") return;

      const handled = executeRef.current(match.binding, e);
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const settings = getSettings();
      if (settings.disableTerminalFontZoom) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(".xterm")) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 1 : -1;
      updateSettings({
        terminalFontSize: clampFontSize(
          settings.terminalFontSize + step,
          MIN_TERMINAL_FONT_SIZE,
          MAX_TERMINAL_FONT_SIZE,
        ),
      });
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onWheel, true);
    };
  }, []);
}
