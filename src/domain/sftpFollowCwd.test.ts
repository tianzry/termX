import { describe, expect, it } from "vitest";
import {
  guessUnixHomeDirFromPath,
  isSftpFollowTargetPath,
  resolveTerminalCwdForSftp,
  shouldFollowTerminalCwdNavigate,
} from "./sftpFollowCwd";

describe("sftpFollowCwd", () => {
  it("跟随开关关闭 / 未连接 / 有传输在跑时不导航", () => {
    const base = {
      followEnabled: true,
      isConnected: true,
      hasActiveWork: false,
      terminalCwd: "/var/www",
      currentPath: "/root",
    };
    expect(shouldFollowTerminalCwdNavigate({ ...base, followEnabled: false })).toBe(false);
    expect(shouldFollowTerminalCwdNavigate({ ...base, isConnected: false })).toBe(false);
    expect(shouldFollowTerminalCwdNavigate({ ...base, hasActiveWork: true })).toBe(false);
  });

  it("cwd 为空 / 与当前目录相同 / 已处理过的路径不重复导航", () => {
    const base = {
      followEnabled: true,
      isConnected: true,
      hasActiveWork: false,
      currentPath: "/root",
    };
    expect(shouldFollowTerminalCwdNavigate({ ...base, terminalCwd: null })).toBe(false);
    expect(shouldFollowTerminalCwdNavigate({ ...base, terminalCwd: "  " })).toBe(false);
    expect(
      shouldFollowTerminalCwdNavigate({ ...base, terminalCwd: "/root" }),
    ).toBe(false);
    expect(
      shouldFollowTerminalCwdNavigate({
        ...base,
        terminalCwd: "/var/www",
        handledPath: "/var/www",
      }),
    ).toBe(false);
    expect(
      shouldFollowTerminalCwdNavigate({
        ...base,
        terminalCwd: "/var/www",
        blockedPath: "/var/www",
      }),
    ).toBe(false);
  });

  it("cwd 变化且可导航时返回 true", () => {
    expect(
      shouldFollowTerminalCwdNavigate({
        followEnabled: true,
        isConnected: true,
        hasActiveWork: false,
        terminalCwd: "/var/www",
        currentPath: "/root",
      }),
    ).toBe(true);
    expect(
      shouldFollowTerminalCwdNavigate({
        followEnabled: true,
        isConnected: true,
        hasActiveWork: false,
        terminalCwd: "/var/www",
        currentPath: "/root",
        handledPath: "/srv",
      }),
    ).toBe(true);
  });

  it("展开 ~ 并识别可导航的绝对路径", () => {
    expect(resolveTerminalCwdForSftp("~/app", "/home/alice")).toBe("/home/alice/app");
    expect(resolveTerminalCwdForSftp("~", null, "/home/bob/projects")).toBe("/home/bob");
    expect(resolveTerminalCwdForSftp("/tmp", "/home/alice")).toBe("/tmp");
    expect(guessUnixHomeDirFromPath("/root/work")).toBe("/root");
    expect(isSftpFollowTargetPath("/var/www")).toBe(true);
    expect(isSftpFollowTargetPath("C:/Users")).toBe(true);
    expect(isSftpFollowTargetPath("relative/dir")).toBe(false);
  });
});
