import { describe, expect, it } from "vitest";
import { decodeAppError, isAuthFailureMessage, userVisibleError } from "./sshErrors";

describe("decodeAppError", () => {
  it("解析 __rssh_err__| 前缀里的 code 与 params", () => {
    const raw = '__rssh_err__|{"code":"ssh_auth_failed","params":{"user":"root"}}';
    const decoded = decodeAppError(raw);
    expect(decoded.code).toBe("ssh_auth_failed");
    expect(decoded.params).toEqual({ user: "root" });
    expect(decoded.message).toBe(raw);
  });

  it("JSON 损坏时回退原文", () => {
    const raw = "__rssh_err__|{not json";
    expect(decodeAppError(raw)).toEqual({ message: raw });
  });

  it("普通文本原样返回", () => {
    expect(decodeAppError("connection reset")).toEqual({ message: "connection reset" });
  });
});

describe("isAuthFailureMessage", () => {
  it("认证失败错误码判定为 true", () => {
    expect(isAuthFailureMessage('__rssh_err__|{"code":"ssh_password_auth_failed"}')).toBe(true);
    expect(isAuthFailureMessage('__rssh_err__|{"code":"ssh_pubkey_auth_failed"}')).toBe(true);
    expect(isAuthFailureMessage('__rssh_err__|{"code":"ssh_auth_failed"}')).toBe(true);
  });

  it("russh / OpenSSH 认证失败原文判定为 true", () => {
    expect(isAuthFailureMessage("All configured authentication methods failed")).toBe(true);
    expect(isAuthFailureMessage("Permission denied (publickey,password).")).toBe(true);
    expect(isAuthFailureMessage("Too many authentication failures")).toBe(true);
  });

  it("非认证错误判定为 false", () => {
    expect(isAuthFailureMessage('__rssh_err__|{"code":"db_error"}')).toBe(false);
    expect(isAuthFailureMessage("connection timed out")).toBe(false);
  });
});

describe("userVisibleError", () => {
  it("信封按 code 映射为中文，绝不泄漏原始信封", () => {
    const raw = '__rssh_err__|{"code":"ssh_auth_failed","params":{"err":"Permission denied"}}';
    expect(userVisibleError(raw)).toBe("认证失败：Permission denied");
    expect(userVisibleError(raw)).not.toContain("__rssh_err__");
  });

  it("params 插值到文案", () => {
    const raw = '__rssh_err__|{"code":"ssh_connect_timeout","params":{"host":"10.0.0.1","port":22,"secs":120}}';
    expect(userVisibleError(raw)).toContain("10.0.0.1:22");
    expect(userVisibleError(raw)).toContain("120");
  });

  it("未知 code 回退 params.err，再回退泛化文案", () => {
    expect(
      userVisibleError('__rssh_err__|{"code":"not_a_real_code","params":{"err":"boom"}}'),
    ).toBe("操作失败：boom");
    expect(userVisibleError('__rssh_err__|{"code":"not_a_real_code"}')).toBe(
      "操作失败，请重试。",
    );
  });

  it("非信封文本原样返回", () => {
    expect(userVisibleError("connection reset")).toBe("connection reset");
  });
});
