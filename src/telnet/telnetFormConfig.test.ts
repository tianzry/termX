import { describe, expect, it } from "vitest";
import {
  isTelnetConnectDisabled,
  resolveTelnetForm,
  telnetFormErrors,
  toTelnetSession,
} from "./telnetFormConfig";

describe("telnetFormConfig", () => {
  it("默认端口 23、CRLF、空主机", () => {
    expect(resolveTelnetForm()).toEqual({
      host: "",
      port: "23",
      inputNewline: "crlf",
    });
    expect(resolveTelnetForm("example.test", 2323)).toEqual({
      host: "example.test",
      port: "2323",
      inputNewline: "crlf",
    });
  });

  it("主机为空（含纯空白）时报错", () => {
    const errors = telnetFormErrors(resolveTelnetForm("   "));
    expect(errors.host).toBeTruthy();
    expect(isTelnetConnectDisabled(resolveTelnetForm("   "))).toBe(true);
  });

  it("端口必须是 1–65535 的整数", () => {
    expect(telnetFormErrors({ ...resolveTelnetForm("h"), port: "" }).port).toBeTruthy();
    expect(telnetFormErrors({ ...resolveTelnetForm("h"), port: "abc" }).port).toBeTruthy();
    expect(telnetFormErrors({ ...resolveTelnetForm("h"), port: "0" }).port).toBeTruthy();
    expect(
      telnetFormErrors({ ...resolveTelnetForm("h"), port: "65536" }).port,
    ).toBeTruthy();
    expect(
      telnetFormErrors({ ...resolveTelnetForm("h"), port: "23.5" }).port,
    ).toBeTruthy();
    expect(telnetFormErrors({ ...resolveTelnetForm("h"), port: "23" }).port).toBeUndefined();
  });

  it("合法表单可连接并去掉主机首尾空白", () => {
    const values = { ...resolveTelnetForm(" example.test "), port: "2323" };
    expect(isTelnetConnectDisabled(values)).toBe(false);
    expect(toTelnetSession(values)).toEqual({
      host: "example.test",
      port: 2323,
      inputNewline: "crlf",
    });
  });

  it("换行风格原样进入会话配置", () => {
    const values = { ...resolveTelnetForm("h"), inputNewline: "lf" as const };
    expect(toTelnetSession(values).inputNewline).toBe("lf");
  });
});
