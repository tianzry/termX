import { describe, expect, it } from "vitest";
import {
  hostProtocolOf,
  isTelnetProfile,
  telnetSessionFromProfile,
} from "./hostProtocol";

describe("hostProtocolOf", () => {
  it("老数据 protocol 缺失按 SSH 派生（行为不变）", () => {
    expect(hostProtocolOf({ protocol: undefined })).toBe("ssh");
  });

  it("显式 telnet / local / serial 原样返回", () => {
    expect(hostProtocolOf({ protocol: "telnet" })).toBe("telnet");
    expect(hostProtocolOf({ protocol: "local" })).toBe("local");
    expect(hostProtocolOf({ protocol: "serial" })).toBe("serial");
  });

  it("未知协议值回落 SSH，避免拼写错误静默走 Telnet", () => {
    expect(hostProtocolOf({ protocol: "telnet ", } as never)).toBe("ssh");
    expect(hostProtocolOf({ protocol: "TELNET" } as never)).toBe("ssh");
  });
});

describe("isTelnetProfile", () => {
  it("仅 protocol === telnet 为真", () => {
    expect(isTelnetProfile({ protocol: "telnet" })).toBe(true);
    expect(isTelnetProfile({ protocol: "ssh" })).toBe(false);
    expect(isTelnetProfile({ protocol: undefined })).toBe(false);
  });
});

describe("telnetSessionFromProfile", () => {
  const base = { host: "10.0.0.9", port: 0 };

  it("端口为空回退 23，换行默认 crlf，字符集默认 utf-8", () => {
    const session = telnetSessionFromProfile(
      { ...base, telnet_username: null, telnet_charset: null },
      null,
    );
    expect(session).toEqual({
      host: "10.0.0.9",
      port: 23,
      inputNewline: "crlf",
      encoding: "utf-8",
    });
  });

  it("有用户名才携带自动登录凭据；密码缺省为空串", () => {
    const session = telnetSessionFromProfile(
      {
        host: "10.0.0.9",
        port: 2323,
        telnet_username: "admin",
        telnet_charset: "gb18030",
      },
      null,
    );
    expect(session).toMatchObject({
      port: 2323,
      username: "admin",
      password: "",
      inputNewline: "crlf",
      encoding: "gb18030",
    });
  });

  it("无用户名时丢弃密码（无法自动登录）", () => {
    const session = telnetSessionFromProfile(
      { ...base, telnet_username: "", telnet_charset: "utf-8" },
      "s3cret",
    );
    expect(session.username).toBeUndefined();
    expect(session.password).toBeUndefined();
  });
});
