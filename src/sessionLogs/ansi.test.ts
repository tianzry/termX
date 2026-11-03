import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

const textOf = (spans: ReturnType<typeof parseAnsi>): string =>
  spans.map((s) => s.text).join("");

describe("parseAnsi", () => {
  it("纯文本原样返回，不产生额外 span", () => {
    const spans = parseAnsi("hello world");
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe("hello world");
    expect(spans[0].fg).toBeUndefined();
  });

  it("16 色前景 + 重置后恢复默认", () => {
    const spans = parseAnsi("a\x1b[31mred\x1b[0mz");
    expect(spans.map((s) => s.text)).toEqual(["a", "red", "z"]);
    expect(spans[1].fg).toBe("#cd3131");
    expect(spans[2].fg).toBeUndefined();
  });

  it("粗体 / 斜体 / 下划线 / 暗色 与对应的取消码", () => {
    const spans = parseAnsi("\x1b[1;2;3;4mbold\x1b[22;23;24mplain");
    expect(spans[0]).toMatchObject({
      text: "bold",
      bold: true,
      dim: true,
      italic: true,
      underline: true,
    });
    expect(spans[1]).toMatchObject({
      text: "plain",
      bold: false,
      dim: false,
      italic: false,
      underline: false,
    });
  });

  it("亮色 90-97 / 背景 100-107，39 / 49 恢复默认", () => {
    const spans = parseAnsi("\x1b[91;104mX\x1b[39;49mY");
    expect(spans[0].fg).toBe("#f14c4c");
    expect(spans[0].bg).toBe("#3b8eea");
    expect(spans[1].fg).toBeUndefined();
    expect(spans[1].bg).toBeUndefined();
  });

  it("inverse 标记保留，27 取消", () => {
    const spans = parseAnsi("\x1b[7mrev\x1b[27mnormal");
    expect(spans[0].inverse).toBe(true);
    expect(spans[1].inverse).toBe(false);
  });

  it("未知 CSI（清屏 / 光标移动）整段丢弃，不残留乱码", () => {
    const spans = parseAnsi("a\x1b[2J\x1b[1;1Hb\x1b[?25l");
    expect(textOf(spans)).toBe("ab");
    expect(textOf(spans)).not.toContain("\x1b");
  });

  it("行内 \\r 覆盖只保留最后一段内容", () => {
    const spans = parseAnsi("progress 10%\rprogress 90%\rdone\nnext");
    expect(textOf(spans)).toBe("done\nnext");
    expect(spans).toHaveLength(2);
    expect(spans[0].text).toBe("done\n");
    expect(spans[1].text).toBe("next");
  });

  it("\\r\\n 只产生换行，不保留回车", () => {
    expect(textOf(parseAnsi("a\r\nb"))).toBe("a\nb");
  });

  it("退格忽略，不破坏后续文本", () => {
    expect(textOf(parseAnsi("ab\bc"))).toBe("abc");
  });

  it("混合文本：ANSI 之间穿插尖括号等普通字符", () => {
    const spans = parseAnsi("\x1b[32m<ok>\x1b[0m && 中文");
    expect(textOf(spans)).toBe("<ok> && 中文");
    expect(spans[0].fg).toBe("#0dbc79");
    expect(spans[1].text).toBe(" && 中文");
  });
});
