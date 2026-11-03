import { describe, expect, it } from "vitest";

import {
  BAUD_RATES,
  CHARSETS,
  isValidBaudRate,
  validatePortPath,
} from "./serialValidate";

describe("serialValidate", () => {
  it("波特率必须是正整数", () => {
    expect(isValidBaudRate("9600")).toBe(true);
    expect(isValidBaudRate("1")).toBe(true);
    expect(isValidBaudRate("0")).toBe(false);
    expect(isValidBaudRate("-1")).toBe(false);
    expect(isValidBaudRate("9600.5")).toBe(false);
    expect(isValidBaudRate("abc")).toBe(false);
    expect(isValidBaudRate("")).toBe(false);
  });

  it("常用波特率表为 12 档且严格递增", () => {
    expect(BAUD_RATES).toHaveLength(12);
    expect(BAUD_RATES[0]).toBe(300);
    expect(BAUD_RATES[11]).toBe(921600);
    for (let i = 1; i < BAUD_RATES.length; i++) {
      expect(BAUD_RATES[i]).toBeGreaterThan(BAUD_RATES[i - 1]);
    }
  });

  it("字符集表首项为透传且无重复", () => {
    expect(CHARSETS[0]).toBe("");
    expect(new Set(CHARSETS).size).toBe(CHARSETS.length);
  });

  it("识别 Windows COM 端口（含 \\\\.\\ 前缀，大小写不敏感）", () => {
    expect(validatePortPath("COM3")).toBe("");
    expect(validatePortPath("com12")).toBe("");
    expect(validatePortPath("\\\\.\\COM9")).toBe("");
    expect(validatePortPath("  COM3  ")).toBe("");
  });

  it("识别 Unix 设备节点", () => {
    expect(validatePortPath("/dev/ttyUSB0")).toBe("");
    expect(validatePortPath("/dev/cu.usbserial-1420")).toBe("");
    expect(validatePortPath("/dev/ttyS0")).toBe("");
  });

  it("拒绝命名管道、空值与未知路径", () => {
    expect(validatePortPath("\\\\.\\pipe\\foo")).toContain("命名管道");
    expect(validatePortPath("")).toContain("串口路径");
    expect(validatePortPath("LPT1")).toContain("无法识别");
    expect(validatePortPath("http://x")).toContain("无法识别");
    expect(validatePortPath("/dev/")).toContain("无法识别");
  });
});
