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

    onReady({ term, fit });

    return () => {
      disposables.forEach((d) => d.dispose());
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="terminal" />;
}