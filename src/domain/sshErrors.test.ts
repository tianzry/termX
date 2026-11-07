import { describe, expect, it } from "vitest";
import {
  decodeAppError,
  errorMessageFor,
  isAuthFailureMessage,
  userVisibleError,
} from "./sshErrors";

describe("decodeAppError", () => {
  it("解析 __termx_err__| 前缀里的 code 与 params", () => {
    const raw = '__termx_err__|{"code":"ssh_auth_failed","params":{"user":"root"}}';
    const decoded = decodeAppError(raw);
    expect(decoded.code).toBe("ssh_auth_failed");
    expect(decoded.params).toEqual({ user: "root" });
    expect(decoded.message).toBe(raw);
  });

  it("JSON 损坏时回退原文", () => {
    const raw = "__termx_err__|{not json";
    expect(decodeAppError(raw)).toEqual({ message: raw });
  });

  it("普通文本原样返回", () => {
    expect(decodeAppError("connection reset")).toEqual({ message: "connection reset" });
  });
});

describe("isAuthFailureMessage", () => {
  it("认证失败错误码判定为 true", () => {
    expect(isAuthFailureMessage('__termx_err__|{"code":"ssh_password_auth_failed"}')).toBe(true);
    expect(isAuthFailureMessage('__termx_err__|{"code":"ssh_pubkey_auth_failed"}')).toBe(true);
    expect(isAuthFailureMessage('__termx_err__|{"code":"ssh_auth_failed"}')).toBe(true);
  });

  it("russh / OpenSSH 认证失败原文判定为 true", () => {
    expect(isAuthFailureMessage("All configured authentication methods failed")).toBe(true);
    expect(isAuthFailureMessage("Permission denied (publickey,password).")).toBe(true);
    expect(isAuthFailureMessage("Too many authentication failures")).toBe(true);
  });

  it("非认证错误判定为 false", () => {
    expect(isAuthFailureMessage('__termx_err__|{"code":"db_error"}')).toBe(false);
    expect(isAuthFailureMessage("connection timed out")).toBe(false);
  });
});

describe("userVisibleError", () => {
  it("信封按 code 映射为中文，绝不泄漏原始信封", () => {
    const raw = '__termx_err__|{"code":"ssh_auth_failed","params":{"err":"Permission denied"}}';
    expect(userVisibleError(raw)).toBe("认证失败：Permission denied");
    expect(userVisibleError(raw)).not.toContain("__termx_err__");
  });

  it("params 插值到文案", () => {
    const raw = '__termx_err__|{"code":"ssh_connect_timeout","params":{"host":"10.0.0.1","port":22,"secs":120}}';
    expect(userVisibleError(raw)).toContain("10.0.0.1:22");
    expect(userVisibleError(raw)).toContain("120");
  });

  it("sftp 错误码映射为中文（文件操作五链路）", () => {
    expect(
      userVisibleError('__termx_err__|{"code":"sftp_io_failed","params":{"op":"rename","err":"No such file"}}'),
    ).toBe("SFTP 操作失败（rename）：No such file");
    expect(
      userVisibleError('__termx_err__|{"code":"sftp_tree_too_deep","params":{"path":"/a","depth":64,"limit":64}}'),
    ).toContain("目录层级过深");
    expect(userVisibleError('__termx_err__|{"code":"sftp_session_not_found"}')).toBe(
      "SFTP 会话不存在或已关闭。",
    );
  });

  it("传输队列错误码映射为中文（R5）", () => {
    expect(
      userVisibleError('__termx_err__|{"code":"sftp_transfer_not_found","params":{"id":"t1"}}'),
    ).toBe("未找到传输任务：t1");
    expect(
      userVisibleError('__termx_err__|{"code":"sftp_transfer_state_invalid","params":{"id":"t1"}}'),
    ).toBe("传输任务当前状态不允许该操作。");
  });

  it("钥匙串错误码映射为中文（阶段 A）", () => {
    expect(
      userVisibleError('__termx_err__|{"code":"key_file_exists","params":{"name":"id_ed25519"}}'),
    ).toBe("~/.ssh/id_ed25519 已存在，拒绝覆盖，请更换密钥名。");
    expect(
      userVisibleError('__termx_err__|{"code":"key_file_not_found","params":{"name":"gone"}}'),
    ).toBe("未找到密钥 ~/.ssh/gone。");
    expect(
      userVisibleError('__termx_err__|{"code":"invalid_key_name","params":{"name":"a/b"}}'),
    ).toContain("单层文件名");
  });

  it("端口转发绑定/冲突错误码映射为中文", () => {
    expect(
      userVisibleError('__termx_err__|{"code":"ssh_port_bind_failed","params":{"port":19022,"err":"Address already in use (os error 10048)"}}'),
    ).toBe("本地端口 19022 绑定失败（127.0.0.1）：Address already in use (os error 10048)");
    expect(
      userVisibleError('__termx_err__|{"code":"ssh_port_bind_failed","params":{"port":19022,"addr":"0.0.0.0","err":"denied"}}'),
    ).toBe("本地端口 19022 绑定失败（0.0.0.0）：denied");
    expect(
      userVisibleError('__termx_err__|{"code":"ssh_tcpip_forward_failed","params":{"err":"administratively prohibited"}}'),
    ).toContain("远端端口转发失败");
    expect(
      userVisibleError('__termx_err__|{"code":"fwd_duplicate_remote_port","params":{"port":8080}}'),
    ).toContain("8080");
  });

  it("未知 code 回退 params.err，再回退泛化文案", () => {
    expect(
      userVisibleError('__termx_err__|{"code":"not_a_real_code","params":{"err":"boom"}}'),
    ).toBe("操作失败：boom");
    expect(userVisibleError('__termx_err__|{"code":"not_a_real_code"}')).toBe(
      "操作失败，请重试。",
    );
  });

  it("非信封文本原样返回", () => {
    expect(userVisibleError("connection reset")).toBe("connection reset");
  });
});

describe("errorMessageFor", () => {
  it("裸 code（队列项 error 字段）映射为中文", () => {
    expect(errorMessageFor("sftp_transfer_not_found", { id: "t2" })).toBe(
      "未找到传输任务：t2",
    );
    expect(errorMessageFor("sftp_transfer_state_invalid")).toBe(
      "传输任务当前状态不允许该操作。",
    );
  });

  it("未知 code 回退泛化文案", () => {
    expect(errorMessageFor("not_a_code")).toBe("操作失败，请重试。");
    expect(errorMessageFor("not_a_code", { err: "x" })).toBe("操作失败：x");
  });
});
