import { describe, expect, it } from "vitest";
import { cellWidth, createSerialInput, lastGrapheme, removeLastGrapheme, utf8ByteLength } from "./serialInput";

function makeInput(overrides: Partial<Parameters<typeof createSerialInput>[0]> = {}) {
  return createSerialInput({
    lineMode: false,
    localEcho: false,
    backspaceBehavior: "default",
    byteOrientedBackspace: false,
    ...overrides,
  });
}

describe("字形与宽度工具", () => {
  it("代理对与组合符按字形簇", () => {
    expect(lastGrapheme("ab😀")).toBe("😀");
    expect(removeLastGrapheme("ab😀")).toBe("ab");
    expect(lastGrapheme("e\u0301")).toBe("e\u0301");
  });

  it("宽字符 2 格，UTF-8 字节数正确", () => {
    expect(cellWidth("a中")).toBe(3);
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("a")).toBe(1);
  });
});

describe("字符模式输入", () => {
  it("普通字符即时发送，未开本地回显时无 echo", () => {
    const input = makeInput();
    expect(input.feed("a")).toEqual({ wire: "a", echo: "" });
  });

  it("本地回显返回输入文本", () => {
    const input = makeInput({ localEcho: true });
    expect(input.feed("ab")).toEqual({ wire: "ab", echo: "ab" });
  });

  it("回退键默认 DEL，Ctrl+H 模式发 0x08", () => {
    const input = makeInput();
    input.feed("a");
    expect(input.feed("\x7f").wire).toBe("\x7f");
    const ctrlH = makeInput({ backspaceBehavior: "ctrl-h" });
    ctrlH.feed("a");
    expect(ctrlH.feed("\x7f").wire).toBe("\x08");
  });

  it("按字节退格：多字节字符发对应数量的 DEL", () => {
    const input = makeInput({ byteOrientedBackspace: true });
    input.feed("中");
    expect(input.feed("\x7f").wire).toBe("\x7f".repeat(3));
    input.feed("a");
    expect(input.feed("\x7f").wire).toBe("\x7f");
  });

  it("宽字符回显擦除两格", () => {
    const input = makeInput({ localEcho: true });
    input.feed("中");
    expect(input.feed("\x7f").echo).toBe("\b \b".repeat(2));
  });

  it("Ctrl+C 回显 ^C", () => {
    const input = makeInput({ localEcho: true });
    expect(input.feed("\x03")).toEqual({ wire: "\x03", echo: "^C" });
  });

  it("换行回显归一为 CRLF，单独 CR 原样", () => {
    const input = makeInput({ localEcho: true });
    expect(input.feed("\n").echo).toBe("\r\n");
    expect(input.feed("\r").echo).toBe("\r");
  });
});

describe("行模式输入", () => {
  it("缓冲输入，回车后整行发送", () => {
    const input = makeInput({ lineMode: true });
    expect(input.feed("a")).toEqual({ wire: "", echo: "" });
    expect(input.feed("b")).toEqual({ wire: "", echo: "" });
    expect(input.pending()).toBe("ab");
    expect(input.feed("\r")).toEqual({ wire: "ab\r", echo: "" });
    expect(input.pending()).toBe("");
  });

  it("本地回显逐字显示，提交时换行", () => {
    const input = makeInput({ lineMode: true, localEcho: true });
    expect(input.feed("a").echo).toBe("a");
    expect(input.feed("\r").echo).toBe("\r\n");
  });

  it("退格从缓冲区删除末字形并按显示宽度擦除", () => {
    const input = makeInput({ lineMode: true, localEcho: true });
    input.feed("中");
    expect(input.feed("\x7f")).toEqual({ wire: "", echo: "\b \b".repeat(2) });
    expect(input.pending()).toBe("");
  });

  it("Ctrl+U 清空缓冲并擦除整行", () => {
    const input = makeInput({ lineMode: true, localEcho: true });
    input.feed("abc");
    expect(input.feed("\x15")).toEqual({ wire: "", echo: "\b \b".repeat(3) });
    expect(input.pending()).toBe("");
  });

  it("Ctrl+C 立即发送并清空缓冲", () => {
    const input = makeInput({ lineMode: true, localEcho: true });
    input.feed("ab");
    expect(input.feed("\x03")).toEqual({ wire: "\x03", echo: "^C\r\n" });
    expect(input.pending()).toBe("");
  });

  it("粘贴含换行的文本按行提交", () => {
    const input = makeInput({ lineMode: true });
    expect(input.feed("one\ntwo").wire).toBe("one\r");
    expect(input.pending()).toBe("two");
    expect(input.feed("\r").wire).toBe("two\r");
  });

  it("reset 清空缓冲", () => {
    const input = makeInput({ lineMode: true });
    input.feed("abc");
    input.reset();
    expect(input.pending()).toBe("");
  });
});
