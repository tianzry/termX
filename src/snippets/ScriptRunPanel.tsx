// 脚本运行状态面板（脚本页顶部）：展示运行状态、nct.log 输出与失败原因。
//
// 状态由 TerminalPane 维护（PaneHandle.scriptControl），本组件只做展示与
// 停止 / 关闭两个动作；日志保留上限（200 条）在宿主侧已做，这里不再裁剪。

import { useEffect, useRef } from "react";

export interface NctScriptViewState {
  runId: string;
  name: string;
  status: "running" | "completed" | "failed" | "stopped";
  logs: string[];
  error?: string;
}

const STATUS_TEXT: Record<NctScriptViewState["status"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

export function ScriptRunPanel({
  state,
  onStop,
  onDismiss,
}: {
  state: NctScriptViewState;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const logsRef = useRef<HTMLDivElement | null>(null);
  const running = state.status === "running";

  // 跟随最新日志：只在条数变化时滚动，避免每次状态刷新都强制到底。
  useEffect(() => {
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.logs.length]);

  return (
    <div className="sn-script-panel" data-status={state.status}>
      <div className="sn-script-head">
        <span className={`sn-run-dot${running ? "" : " is-idle"}`} />
        <span className="sn-script-title">
          「{state.name}」{STATUS_TEXT[state.status]}
        </span>
        <button type="button" onClick={onStop} disabled={!running}>
          停止
        </button>
        <button type="button" onClick={onDismiss} disabled={running}>
          关闭
        </button>
      </div>
      {state.error && <div className="sn-script-error">{state.error}</div>}
      {state.logs.length > 0 && (
        <div className="sn-script-logs" ref={logsRef} aria-label="脚本日志">
          {state.logs.map((line, index) => (
            <div className="sn-script-log" key={`${index}-${line}`}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
