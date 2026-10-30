import { useEffect, useRef } from "react";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalController {
  term: Terminal;
  fit: FitAddon;
}

interface Props {
  onReady: (controller: TerminalController) => void;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

/** 单例 xterm 画布：创建即 fit + focus，销毁时 unmount 清理。 */
export function TerminalView({ onReady, onData, onResize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: { background: "#0d1117", foreground: "#e6edf3" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    term.focus();

    const disposables: IDisposable[] = [];
    disposables.push(term.onData((s) => onData?.(s)));
    disposables.push(term.onResize(({ cols, rows }) => onResize?.(cols, rows)));

    // 分屏 / 切换标签会改变容器尺寸（隐藏标签的尺寸为 0），
    // 靠 ResizeObserver 重新 fit，避免行列停留在旧值。
    const ro = new ResizeObserver(() => {
      if (containerRef.current) fit.fit();
    });
    ro.observe(containerRef.current!);

    onReady({ term, fit });

    return () => {
      ro.disconnect();
      disposables.forEach((d) => d.dispose());
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="terminal" />;
}