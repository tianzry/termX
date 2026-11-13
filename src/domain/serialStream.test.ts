import { describe, expect, it } from "vitest";
import {
  createHexDumpFormatter,
  createReceiveNewlineTransformer,
  mapSendNewline,
  parseHexInput,
  resolveSerialTermOpts,
} from "./serialStream";

describe("mapSendNewline", () => {
  it("cr 模式保持原样（默认）", () => {
    expect(mapSendNewline("abc\r", "cr")).toBe("abc\r");
  });
  it("crlf 模式把单个 LF / CR 都展开", () => {
    expect(mapSendNewline("a\nb\rc", "crlf")).toBe("a\r\nb\r\nc");
  });
  it("lf 模式把 CRLF 折叠成 LF", () => {
    expect(mapSendNewline("a\r\nb", "lf")).toBe("a\nb");
  });
});

describe("createReceiveNewlineTransformer", () => {
  it("raw 直通不改写", () => {
    const t = createReceiveNewlineTransformer("raw");
    expect(t.push("a\r\nb")).toBe("a\r\nb");
    expect(t.flush()).toBe("");
  });
  it("跨块拆开的 CRLF 只算一个换行", () => {
    const t = createReceiveNewlineTransformer("crlf");
    expect(t.push("abc\r")).toBe("abc");
    expect(t.push("\nnext")).toBe("\r\nnext");
    expect(t.flush()).toBe("");
  });
  it("flush 补出块尾孤立 CR", () => {
    const t = createReceiveNewlineTransformer("lf");
    expect(t.push("x\r")).toBe("x");
    expect(t.flush()).toBe("\n");
  });
});

describe("parseHexInput", () => {
  it("空格 / 逗号分隔都可解析", () => {
    expect(Array.from(parseHexInput("41 42,4c") ?? [])).toEqual([0x41, 0x42, 0x4c]);
  });
  it("非法 token 整体返回 null", () => {
    expect(parseHexInput("41 zz")).toBeNull();
    expect(parseHexInput("123")).toBeNull();
  });
  it("空输入返回空数组", () => {
    expect(parseHexInput("  ")?.length).toBe(0);
  });
});

describe("createHexDumpFormatter", () => {
  it("满 16 字节成行，flush 补半行", () => {
    const f = createHexDumpFormatter();
    const full = f.push(
      Uint8Array.from(Array.from({ length: 16 }, (_, i) => 0x41 + i)),
    );
    expect(full).toContain("00000000  41 42 43");
    expect(full.endsWith("\r\n")).toBe(true);
    expect(f.push(Uint8Array.of(0x41, 0x42))).toBe("");
    const flushed = f.flush();
    expect(flushed).toContain("00000010  41 42");
    expect(flushed).toContain("|AB|");
  });
});

describe("resolveSerialTermOpts", () => {
  it("缺字段回落默认值", () => {
    expect(resolveSerialTermOpts(null).input_newline).toBe("cr");
    expect(resolveSerialTermOpts({ xany: true }).xany).toBe(true);
  });
  it("非法枚举回落默认项", () => {
    // 旧库 / 手改 JSON 可能带出非法值，用 JSON.parse 绕过类型检查模拟运行时输入。
    const opts = resolveSerialTermOpts(
      JSON.parse('{"input_mode":"bogus","output_newline":"nope"}'),
    );
    expect(opts.input_mode).toBe("normal");
    expect(opts.output_newline).toBe("raw");
  });
});
