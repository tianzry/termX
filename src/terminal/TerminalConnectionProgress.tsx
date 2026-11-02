/**
 * 连接进度内容（移植自 netcatty/components/terminal/TerminalConnectionProgress.tsx）。
 *
 * - connecting：旋转图标 + 倒计时（等待用户输入时改为提示文案）；
 * - connected：绿点 + 已连接；
 * - disconnected：红点 + 错误文本；
 * - 日志折叠列表；
 * - 断开后提供 “关闭会话” / “重新连接”。
 */
import { Icon } from "../ui/icons";

export interface TerminalConnectionProgressProps {
  status: "connecting" | "connected" | "disconnected";
  error: string | null;
  timeLeft: number;
  isAwaitingUserInput?: boolean;
  showEnterReconnectHint?: boolean;
  isCancelling: boolean;
  showLogs: boolean;
  progressLogs: string[];
  onCancelConnect: () => void;
  onCloseSession: () => void;
  onRetry?: () => void;
  reconnectLabel?: string;
}

export interface TerminalConnectionLogListProps {
  progressLogs: string[];
  error?: string | null;
}

export function TerminalConnectionLogList({
  progressLogs,
  error,
}: TerminalConnectionLogListProps) {
  return (
    <div className="conn-log-box">
      <div className="conn-log-scroll">
        {progressLogs.map((line, idx) => (
          <div key={idx} className="conn-log-row">
            <span className="conn-log-dot ok" />
            <span className="conn-log-text">{line}</span>
          </div>
        ))}
        {error && (
          <div className="conn-log-row error">
            <span className="conn-log-dot bad" />
            <span className="conn-log-text">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TerminalConnectionProgress({
  status,
  error,
  timeLeft,
  isAwaitingUserInput = false,
  showEnterReconnectHint = false,
  isCancelling: _isCancelling,
  showLogs,
  progressLogs,
  onCancelConnect: _onCancelConnect,
  onCloseSession,
  onRetry,
  reconnectLabel,
}: TerminalConnectionProgressProps) {
  return (
    <>
      <div className="conn-status-line">
        {status === "connecting" ? (
          <>
            <Icon name="loader" size={12} className="conn-spin" />
            <span>
              {isAwaitingUserInput
                ? "等待用户输入…"
                : `${timeLeft} 秒后超时`}
            </span>
          </>
        ) : status === "connected" ? (
          <>
            <span className="conn-log-dot ok" />
            <span className="conn-status-ok">已连接</span>
          </>
        ) : (
          <>
            <span className="conn-log-dot bad" />
            <span className="conn-status-bad">{error || "已断开"}</span>
          </>
        )}
      </div>

      {showLogs && <TerminalConnectionLogList progressLogs={progressLogs} error={error} />}

      {status !== "connecting" && (
        <div className="conn-dialog-footer">
          {showEnterReconnectHint && (
            <div className="conn-hint">按 Enter 重新连接</div>
          )}
          <div className="conn-footer-actions">
            <button type="button" className="conn-btn conn-btn-ghost" onClick={onCloseSession}>
              关闭会话
            </button>
            {onRetry && (
              <button type="button" className="conn-btn conn-btn-primary" onClick={onRetry}>
                <Icon name="play" size={12} />
                {reconnectLabel ?? "重新连接"}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default TerminalConnectionProgress;
