import { describe, expect, it } from "vitest";
import {
  createTerminalDecoder,
  isTerminalEncoding,
  loadTerminalEncoding,
  saveTerminalEncoding,
  supportsEncodingSwitch,
  terminalEncodingStorageKey,
} from "./terminalEncoding";

describe("isTerminalEncoding", () => {
  it("只接受 utf-8 / gb18030", () => {
    expect(isTerminalEncoding("utf-8")).toBe(true);
    expect(isTerminalEncoding("gb18030")).toBe(true);
    expect(isTerminalEncoding("gbk")).toBe(false);
    expect(isTerminalEncoding(null)).toBe(false);
  });
});

describe("编码偏好持久化", () => {
  it("按 host id 分键且可读写", () => {
    expect(terminalEncodingStorageKey("abc")).toBe(
      "termx.terminalEncoding.abc",
    );
    expect(terminalEncodingStorageKey("")).toBeNull();
    saveTerminalEncoding("abc", "gb18030");
    expect(loadTerminalEncoding("abc")).toBe("gb18030");
    saveTerminalEncoding("abc", "utf-8");
    expect(loadTerminalEncoding("abc")).toBe("utf-8");
  });

  it("无 id 时回退 utf-8", () => {
    expect(loadTerminalEncoding(null)).toBe("utf-8");
  });
});

describe("supportsEncodingSwitch", () => {
  it("SSH / Telnet 可切换，本地与串口置灰", () => {
    expect(supportsEncodingSwitch("ssh")).toBe(true);
    expect(supportsEncodingSwitch("telnet")).toBe(true);
    expect(supportsEncodingSwitch("serial")).toBe(false);
    expect(supportsEncodingSwitch("pty")).toBe(false);
  });
});

describe("createTerminalDecoder", () => {
  it("utf-8 解码中文", () => {
    const d = createTerminalDecoder("utf-8");
    expect(d.decode(new TextEncoder().encode("你好"))).toBe("你好");
  });

  it("gb18030 解码中文（与 UTF-8 字节不同）", () => {
    const d = createTerminalDecoder("gb18030");
    // 「你」C4 E3，「好」BA C3
    const bytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    expect(d.decode(bytes)).toBe("你好");
  });

  it("分块跨多字节字符不产生替换符", () => {
    const d = createTerminalDecoder("utf-8");
    const first = d.decode(new Uint8Array([0xe4, 0xbd]));
    expect(first).toBe("");
    const rest = d.decode(new Uint8Array([0xa0, 0x21]));
    expect(first + rest).toBe("你!");
  });
});
