/**
 * 连接弹窗（移植自 netcatty/components/terminal/TerminalConnectionDialog.tsx）。
 *
 * - 540px 卡片：主机头像/名称 + 协议与端口、三阶段图标与两段进度条；
 * - connecting：进度 + 倒计时 + 日志 + 取消；
 * - needsAuth：内嵌认证重试表单（背景不透明）；
 * - hostKey：内嵌主机密钥校验；
 * - disconnected：错误 + 关闭会话 / 重新连接（可 Enter 重连）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../ui/icons";
import type { HostKeyInfo } from "../domain/hostKey";
import { TerminalAuthDialog, type TerminalAuthDialogProps } from "./TerminalAuthDialog";
import {
  TerminalConnectionProgress,
  type TerminalConnectionProgressProps,
} from "./TerminalConnectionProgress";
import { TerminalHostKeyVerification } from "./TerminalHostKeyVerification";

export interface ChainProgress {
  currentHop: number;
  totalHops: number;
  currentHostLabel: string;
}

export interface HostConnectionInfo {
  label: string;
  hostname: string;
  port: number;
  protocol?: string;
}

export interface TerminalConnectionDialogProps {
  host: HostConnectionInfo;
  status: "connecting" | "connected" | "disconnected";
  error: string | null;
  progressValue: number;
  chainProgress: ChainProgress | null;
  needsAuth: boolean;
  showLogs: boolean;
  setShowLogs: (show: boolean) => void;
  authProps: TerminalAuthDialogProps;
  onDismissDisconnected?: () => void;
  showEnterReconnectHint?: boolean;
  hostKeyVerification?: {
    hostKeyInfo: HostKeyInfo;
    onClose: () => void;
    onContinue: () => void;
    onAddAndContinue: () => void;
  };
  progressProps: Omit<
    TerminalConnectionProgressProps,
    "status" | "error" | "showLogs" | "showEnterReconnectHint"
  >;
}

function Avatar({ label, size = 36 }: { label: string; size?: number }) {
  const initials = (label.slice(0, 2) || "SS").toUpperCase();
  return (
    <div
      className="conn-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
      }}
    >
      {initials}
    </div>
  );
}

export function TerminalConnectionDialog({
  host,
  status,
  error,
  progressValue,
  chainProgress,
  needsAuth,
  showLogs,
  setShowLogs,
  authProps,
  onDismissDisconnected,
  showEnterReconnectHint,
  hostKeyVerification,
  progressProps,
}: TerminalConnectionDialogProps) {
  const hasError = Boolean(error);
  const isConnecting = status === "connecting";
  const isVerifyingHostKey = Boolean(hostKeyVerification);
  const isHostKeyChanged = hostKeyVerification?.hostKeyInfo.status === "changed";
  const shouldCompleteProgress = hasError || (!isConnecting && !needsAuth);
  const canDismissDisconnected = status === "disconnected" && !needsAuth && !!onDismissDisconnected;
  const canEnterReconnectFromDialog = Boolean(
    showEnterReconnectHint &&
      status === "disconnected" &&
      !needsAuth &&
      !isVerifyingHostKey &&
      progressProps.onRetry,
  );

  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!canEnterReconnectFromDialog) return;
    const node = dialogRef.current;
    if (!node) return;
    const focusOverlay = () => {
      if (
        document.activeElement instanceof HTMLElement &&
        node.contains(document.activeElement)
      ) {
        return;
      }
      node.focus({ preventScroll: true });
    };
    focusOverlay();
    const timer = window.setTimeout(focusOverlay, 0);
    return () => window.clearTimeout(timer);
  }, [canEnterReconnectFromDialog]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (
      e.key === "Enter" &&
      canEnterReconnectFromDialog &&
      !(e.target instanceof HTMLButtonElement) &&
      !(e.target instanceof HTMLInputElement)
    ) {
      e.preventDefault();
      e.stopPropagation();
      progressProps.onRetry?.();
    }
  };

  const targetFirstSegmentWidth = isVerifyingHostKey || shouldCompleteProgress
    ? 100
    : Math.min(100, progressValue * 2);
  const targetSecondSegmentWidth = isVerifyingHostKey
    ? 0
    : shouldCompleteProgress
      ? 100
      : Math.max(0, Math.min(100, (progressValue - 50) * 2));
  const [secondSegmentUnlocked, setSecondSegmentUnlocked] = useState(
    () => shouldCompleteProgress || targetSecondSegmentWidth <= 0,
  );
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (needsAuth || isVerifyingHostKey || targetSecondSegmentWidth <= 0 || shouldCompleteProgress) {
      if (unlockTimerRef.current) {
        clearTimeout(unlockTimerRef.current);
        unlockTimerRef.current = null;
      }
      setSecondSegmentUnlocked(shouldCompleteProgress);
      return;
    }
    if (secondSegmentUnlocked || unlockTimerRef.current) return;
    unlockTimerRef.current = setTimeout(() => {
      unlockTimerRef.current = null;
      setSecondSegmentUnlocked(true);
    }, 320);
  }, [isVerifyingHostKey, needsAuth, secondSegmentUnlocked, shouldCompleteProgress, targetSecondSegmentWidth]);

  const secondSegmentWidth = shouldCompleteProgress || secondSegmentUnlocked ? targetSecondSegmentWidth : 0;

  return (
    <div
      className="conn-mask"
      style={{
        backgroundColor: needsAuth
          ? "var(--conn-card-bg)"
          : "color-mix(in srgb, var(--conn-card-bg) 35%, transparent)",
      }}
      onMouseDown={(e) => {
        if (!canEnterReconnectFromDialog) return;
        if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
        dialogRef.current?.focus({ preventScroll: true });
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={canEnterReconnectFromDialog ? -1 : undefined}
        onKeyDown={handleKeyDown}
        className="conn-card"
      >
        <div className="conn-header">
          <div className="conn-header-left">
            <Avatar label={chainProgress?.currentHostLabel ?? host.label} />
            <div className="conn-header-copy">
              {chainProgress ? (
                <>
                  <div className="conn-title">
                    <span className="conn-title-muted">
                      {chainProgress.currentHop}/{chainProgress.totalHops}:{" "}
                    </span>
                    <span>{chainProgress.currentHostLabel}</span>
                  </div>
                  <div className="conn-subtitle">
                    {host.protocol || "SSH"}{" "}
                    {host.hostname}:{host.port}
                  </div>
                </>
              ) : (
                <>
                  <div className="conn-title">{host.label}</div>
                  <div className="conn-subtitle">
                    {host.protocol || "SSH"}{" "}
                    {host.hostname}:{host.port}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="conn-header-actions">
            {!needsAuth && (
              <button
                type="button"
                className="conn-btn conn-btn-sm"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? "隐藏日志" : "显示日志"}
              </button>
            )}
            {status === "connecting" && !needsAuth && !isVerifyingHostKey && (
              <button
                type="button"
                className="conn-btn conn-btn-sm"
                onClick={progressProps.onCancelConnect}
                disabled={progressProps.isCancelling}
              >
                {progressProps.isCancelling ? "取消中…" : "关闭"}
              </button>
            )}
            {canDismissDisconnected && (
              <button
                type="button"
                className="conn-btn conn-btn-icon"
                title="关闭提示"
                onClick={onDismissDisconnected}
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="conn-stages">
          <div
            className={
              needsAuth || isVerifyingHostKey
                ? "conn-stage active"
                : hasError
                  ? "conn-stage error"
                  : isConnecting
                    ? "conn-stage active"
                    : "conn-stage done"
            }
          >
            <Icon name="plug" size={13} />
          </div>
          <div className="conn-track">
            <div
              className={error ? "conn-track-fill error" : "conn-track-fill"}
              style={{ width: needsAuth ? "0%" : `${targetFirstSegmentWidth}%` }}
            />
          </div>
          <div
            className={
              isHostKeyChanged
                ? "conn-stage changed"
                : isVerifyingHostKey
                  ? "conn-stage verify"
                  : progressValue > 50 && !hasError
                    ? "conn-stage active"
                    : hasError
                      ? "conn-stage error"
                      : "conn-stage"
            }
          >
            <Icon name="fingerprint" size={13} />
          </div>
          <div className="conn-track">
            <div
              className={error ? "conn-track-fill error" : "conn-track-fill"}
              style={{ width: needsAuth || isVerifyingHostKey ? "0%" : `${secondSegmentWidth}%` }}
            />
          </div>
          <div className={hasError ? "conn-stage error" : "conn-stage"}>
            {isConnecting ? (
              <Icon name="loader" size={13} className="conn-spin" />
            ) : (
              <Icon name="terminal-square" size={13} />
            )}
          </div>
        </div>

        {needsAuth ? (
          <TerminalAuthDialog {...authProps} />
        ) : hostKeyVerification ? (
          <TerminalHostKeyVerification
            hostKeyInfo={hostKeyVerification.hostKeyInfo}
            showLogs={showLogs}
            progressLogs={progressProps.progressLogs}
            onClose={hostKeyVerification.onClose}
            onContinue={hostKeyVerification.onContinue}
            onAddAndContinue={hostKeyVerification.onAddAndContinue}
          />
        ) : (
          <TerminalConnectionProgress
            status={status}
            error={error}
            showLogs={showLogs}
            showEnterReconnectHint={showEnterReconnectHint}
            {...progressProps}
          />
        )}
      </div>
    </div>
  );
}

export default TerminalConnectionDialog;
