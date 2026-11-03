import { describe, expect, it } from "vitest";
import { formatTelnetLocalEcho } from "./telnetEcho";

describe("formatTelnetLocalEcho", () => {
  it("回显可见字符与换行", () => {
    expect(formatTelnetLocalEcho("ps\r")).toBe("ps\r\n");
    expect(formatTelnetLocalEcho("one\ntwo")).toBe("one\r\ntwo");
    expect(formatTelnetLocalEcho("a\r\nb")).toBe("a\r\nb");
  });

  it("退格与 Ctrl-C", () => {
    expect(formatTelnetLocalEcho("\x7f")).toBe("\b \b");
    expect(formatTelnetLocalEcho("\b")).toBe("\b \b");
    expect(formatTelnetLocalEcho("\x03")).toBe("^C");
  });

  it("忽略转义序列与非显示控制键", () => {
    expect(formatTelnetLocalEcho("\x1b[A")).toBe("");
    expect(formatTelnetLocalEcho("\x1bOP")).toBe("");
    expect(formatTelnetLocalEcho("\x1bb")).toBe("");
  });
});
