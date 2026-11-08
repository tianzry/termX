// 脚本代码编辑器（CodeMirror 6）：JavaScript 高亮、行号、撤销、Mod-Enter 运行、Tab 缩进。
//
// 用于脚本内容编辑（kind=script）；普通片段的命令仍用 textarea。
// 阶段 1 无语言选择，脚本一律按 javascript 高亮（块 7 引入 language 分流后再收敛）。

import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView, keymap } from "@codemirror/view";

export interface ScriptCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Mod-Enter（Ctrl/Cmd+Enter）触发运行。 */
  onRun?: () => void;
  /** 数字 = 固定像素高度；"fill" = 撑满父容器（放大编辑弹窗用）。 */
  height?: number | "fill";
}

/** 编辑器按键：Mod-Enter 运行、Tab 缩进（单测直接校验绑定）。 */
export function createEditorKeymap(onRun?: () => void) {
  return [
    {
      key: "Mod-Enter",
      run: () => {
        onRun?.();
        return true;
      },
    },
    indentWithTab,
  ];
}

const editorTheme = EditorView.theme({
  "&": {
    color: "hsl(var(--nc-fg))",
    backgroundColor: "transparent",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    padding: "6px 0",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "hsl(var(--nc-muted))",
    border: "none",
    borderRight: "1px solid hsl(var(--nc-border) / 0.4)",
  },
  ".cm-activeLine": { backgroundColor: "hsl(var(--nc-fg) / 0.04)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "hsl(var(--nc-primary) / 0.25)",
  },
  ".cm-cursor": { borderLeftColor: "hsl(var(--nc-fg))" },
  ".cm-scroller": { overflow: "auto" },
});

export function ScriptCodeEditor({
  value,
  onChange,
  onRun,
  height = 180,
}: ScriptCodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  const runRef = useRef(onRun);
  changeRef.current = onChange;
  runRef.current = onRun;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      doc: value,
      parent: host,
      extensions: [
        // 必须排在 basicSetup 之前：其 defaultKeymap 已把 Mod-Enter 绑到 insertBlankLine，
        // 高优先级才能让我们的运行键先命中（CodeMirror 按键位按扩展顺序取先命中者）。
        keymap.of(createEditorKeymap(() => runRef.current?.())),
        basicSetup,
        javascript(),
        editorTheme,
        EditorView.theme({
          "&": {
            height: height === "fill" ? "100%" : `${height}px`,
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changeRef.current(update.state.doc.toString());
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // value 只用于初始化，后续同步走下面的 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="sn-cm-host" data-height={height === "fill" ? "fill" : "fixed"} />;
}
