/**
 * SSH 连接超时（对齐 netcatty/domain/sshConnectionTimeouts.ts +
 * components/terminal/connectionTimeouts.ts）。
 *
 * 拨号阶段用较短的 TCP 超时；完成 TCP 拨号后改用更宽松的认证就绪超时。
 */

export const DEFAULT_SSH_TCP_CONNECT_TIMEOUT_SECONDS = 20;
export const DEFAULT_SSH_AUTH_READY_TIMEOUT_SECONDS = 120;
export const MAX_SSH_CONNECTION_TIMEOUT_SECONDS = 3600;

export const SSH_TCP_CONNECT_TIMEOUT_MS = DEFAULT_SSH_TCP_CONNECT_TIMEOUT_SECONDS * 1000;
export const SSH_AUTH_READY_TIMEOUT_MS = DEFAULT_SSH_AUTH_READY_TIMEOUT_SECONDS * 1000;

export const hasConnectionPassedTcpDial = (status: string): boolean =>
  status === "tcp-connected" ||
  status === "authenticating" ||
  status === "authenticated" ||
  status === "connected" ||
  status === "shell";

type ConnectionTimeoutState = {
  status: string;
  needsAuth: boolean;
  needsHostKeyVerification: boolean;
  isConnectionAwaitingUserInput: boolean;
  isConnectionPastTcpDial: boolean;
  hasSshTcpConnectProgress: boolean;
};

export function getConnectionTimeoutMs(state: ConnectionTimeoutState): number {
  if (!state.hasSshTcpConnectProgress) return SSH_AUTH_READY_TIMEOUT_MS;
  return state.isConnectionPastTcpDial
    ? SSH_AUTH_READY_TIMEOUT_MS
    : SSH_TCP_CONNECT_TIMEOUT_MS;
}

export function shouldRunConnectionTimeout(state: ConnectionTimeoutState): boolean {
  return (
    state.status === "connecting" &&
    !state.needsAuth &&
    !state.needsHostKeyVerification &&
    !state.isConnectionAwaitingUserInput
  );
}
