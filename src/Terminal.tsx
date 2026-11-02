import { useEffect, useRef } from "react";
import { Terminal, type IDisposable, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AppSettings } from "./settings/settingsModel";
import { getSettings, resolvedThemeMode, subscribeSettings } from "./settings/settingsStore";

export interface TerminalController {
  term: Terminal;
  fit: FitAddon;
}

interface Props {
  onReady: (controller: TerminalController) => void;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

const DEFAULT_FONT_STACK = "Menlo, Monaco, Consolas, 'Courier New', monospace";

/** 终端主字体解析：auto → 默认栈；否则选中字体 + CJK 回退字体。 */
function resolveFontFamily(s: AppSettings): string {
  const base =
    s.terminalFontFamilyId && s.terminalFontFamilyId !== "auto"
      ? `'${s.terminalFontFamilyId}', `
      : "";
  const cjk = s.terminal.fallbackFont ? `'${s.terminal.fallbackFont}', ` : "";
  return `${base}${cjk}${DEFAULT_FONT_STACK}`;
}

/** 由设置中心（终端 tab）构建 xterm 选项；导出供单测。 */
export function buildXtermOptions(s: AppSettings): ITerminalOptions {
  // 终端主题：跟随应用主题；关闭 followAppTheme 时终端固定深色配色
  // （终端主题预设库未移植，对照 Netcatty settings.terminal.theme.followApp）。
  const dark = !s.terminal.followAppTheme || resolvedThemeMode(s) === "dark";
  const t = s.terminal;
  return {
    convertEol: false,
    cursorBlink: t.cursorBlink,
    cursorStyle: t.cursorShape,
    cursorWidth: t.cursorBarWidth,
    fontSize: s.terminalFontSize,
    fontFamily: resolveFontFamily(s),
    fontWeight: t.fontWeight,
    fontWeightBold: t.fontWeightBold,
    lineHeight: 1 + t.linePadding / 10,
    scrollback: t.scrollback,
    wordSeparator: t.wordSeparators,
    // xterm 的 Alt-as-Meta 仅 macOS 可配（windowsMode 下 Alt 行为由系统决定）。
    macOptionIsMeta: t.altAsMeta,
    scrollOnUserInput: t.scrollOnInput,
    theme: dark
      ? {
          background: "#16181d",
          foreground: "#dfe3ea",
          cursor: "#6aa1ff",
          cursorAccent: "#16181d",
          selectionBackground: "rgba(106, 161, 255, 0.28)",
        }
      : {
          background: "#ffffff",
          foreground: "#16202b",
          cursor: "#0a84ff",
          cursorAccent: "#ffffff",
          selectionBackground: "rgba(10, 132, 255, 0.22)",
        },
  };
}

/** 单例 xterm 画布：创建即 fit + focus，销毁时 unmount 清理。 */
export function TerminalView({ onReady, onData, onResize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal(buildXtermOptions(getSettings()));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    term.focus();

    const disposables: IDisposable[] = [];
    disposables.push(term.onData((s) => onData?.(s)));
    disposables.push(term.onResize(({ cols, rows }) => onResize?.(cols, rows)));
    // 设置变更（字体 / 光标 / 主题等）实时同步到已打开的终端。
    const unsubSettings = subscribeSettings(() => {
      term.options = buildXtermOptions(getSettings());
    });

    // 分屏 / 切换标签会改变容器尺寸（隐藏标签的尺寸为 0），
    // 靠 ResizeObserver 重新 fit，避免行列停留在旧值。
    const ro = new ResizeObserver(() => {
      if (containerRef.current) fit.fit();
    });
    ro.observe(containerRef.current!);

    onReady({ term, fit });

    return () => {
      unsubSettings();
      ro.disconnect();
      disposables.forEach((d) => d.dispose());
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="terminal" />;
}
