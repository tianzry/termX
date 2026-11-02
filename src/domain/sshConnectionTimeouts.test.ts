import { describe, expect, it } from "vitest";
import {
  getConnectionTimeoutMs,
  hasConnectionPassedTcpDial,
  shouldRunConnectionTimeout,
  SSH_AUTH_READY_TIMEOUT_MS,
  SSH_TCP_CONNECT_TIMEOUT_MS,
} from "./sshConnectionTimeouts";

const base = {
  status: "connecting",
  needsAuth: false,
  needsHostKeyVerification: false,
  isConnectionAwaitingUserInput: false,
  isConnectionPastTcpDial: false,
  hasSshTcpConnectProgress: false,
};

describe("getConnectionTimeoutMs", () => {
  it("拨号阶段未开始（无进度事件）时用更宽松的认证就绪超时", () => {
    expect(getConnectionTimeoutMs(base)).toBe(SSH_AUTH_READY_TIMEOUT_MS);
  });

  it("拨号中用较短的 TCP 连接超时", () => {
    expect(
      getConnectionTimeoutMs({ ...base, hasSshTcpConnectProgress: true }),
    ).toBe(SSH_TCP_CONNECT_TIMEOUT_MS);
  });

  it("TCP 已建立后切回认证就绪超时", () => {
    expect(
      getConnectionTimeoutMs({
        ...base,
        hasSshTcpConnectProgress: true,
        isConnectionPastTcpDial: true,
      }),
    ).toBe(SSH_AUTH_READY_TIMEOUT_MS);
  });
});

describe("hasConnectionPassedTcpDial", () => {
  it("拨号之后的全部状态为 true", () => {
    for (const s of ["tcp-connected", "authenticating", "authenticated", "connected", "shell"]) {
      expect(hasConnectionPassedTcpDial(s)).toBe(true);
    }
  });

  it("connecting / error 为 false", () => {
    expect(hasConnectionPassedTcpDial("connecting")).toBe(false);
    expect(hasConnectionPassedTcpDial("error")).toBe(false);
  });
});

describe("shouldRunConnectionTimeout", () => {
  it("仅 connecting 且不等待任何用户交互时启用超时", () => {
    expect(shouldRunConnectionTimeout(base)).toBe(true);
    expect(shouldRunConnectionTimeout({ ...base, status: "connected" })).toBe(false);
    expect(shouldRunConnectionTimeout({ ...base, needsAuth: true })).toBe(false);
    expect(shouldRunConnectionTimeout({ ...base, needsHostKeyVerification: true })).toBe(false);
    expect(shouldRunConnectionTimeout({ ...base, isConnectionAwaitingUserInput: true })).toBe(false);
  });
});
