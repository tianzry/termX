import { describe, expect, it } from "vitest";
import {
  MAX_EDITOR_BYTES,
  assertEditorSize,
  decodeText,
  encodeText,
  fileExtension,
  isKnownBinaryFile,
  looksBinary,
  statChanged,
} from "./editorFile";

describe("fileExtension", () => {
  it("取小写扩展名", () => {
    expect(fileExtension("a.TXT")).toBe("txt");
    expect(fileExtension("/etc/nginx/nginx.Conf")).toBe("conf");
    expect(fileExtension("C:\\dir\\file.Json")).toBe("json");
  });
  it("无扩展名 / 点开头隐藏文件返回空", () => {
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension("a.")).toBe("");
  });
});

describe("isKnownBinaryFile", () => {
  it("命中常见二进制扩展名", () => {
    expect(isKnownBinaryFile("photo.PNG")).toBe(true);
    expect(isKnownBinaryFile("app.exe")).toBe(true);
    expect(isKnownBinaryFile("archive.tar.gz")).toBe(true);
  });
  it("文本类不误伤", () => {
    expect(isKnownBinaryFile("nginx.conf")).toBe(false);
    expect(isKnownBinaryFile("a.log")).toBe(false);
    expect(isKnownBinaryFile("noext")).toBe(false);
  });
});

describe("looksBinary", () => {
  it("头部窗口含 NUL 判二进制", () => {
    const b = new Uint8Array([0x68, 0x69, 0x00, 0x61]);
    expect(looksBinary(b)).toBe(true);
  });
  it("窗口外的 NUL 不算（只采样头部 8KiB）", () => {
    const b = new Uint8Array(9000).fill(0x61);
    b[8500] = 0;
    expect(looksBinary(b)).toBe(false);
  });
  it("纯文本与空文件非二进制", () => {
    expect(looksBinary(new TextEncoder().encode("hello"))).toBe(false);
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
});

describe("decodeText", () => {
  it("剥 UTF-8 BOM", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi");
  });
  it("UTF-16LE BOM", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe("hi");
  });
  it("UTF-16BE BOM", () => {
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))).toBe("hi");
  });
  it("无 BOM 合法 UTF-8 直解", () => {
    expect(decodeText(new TextEncoder().encode("中文 abc"))).toBe("中文 abc");
  });
  it("非 UTF-8 字节回退 gb18030", () => {
    // "中" 的 GB18030 编码 0xD6 0xD0
    expect(decodeText(new Uint8Array([0xd6, 0xd0]))).toBe("中");
  });
});

describe("encodeText", () => {
  it("UTF-8 往返", () => {
    const text = "hello 中文 \n\t";
    expect(decodeText(encodeText(text))).toBe(text);
  });
});

describe("assertEditorSize", () => {
  it("上限内通过（含恰好等于）", () => {
    expect(() => assertEditorSize(0)).not.toThrow();
    expect(() => assertEditorSize(MAX_EDITOR_BYTES)).not.toThrow();
  });
  it("超限抛错", () => {
    expect(() => assertEditorSize(MAX_EDITOR_BYTES + 1)).toThrow(/10 MiB/);
  });
  it("NaN / Infinity 不拦（尺寸未知交给读取兜底）", () => {
    expect(() => assertEditorSize(NaN)).not.toThrow();
    expect(() => assertEditorSize(Infinity)).not.toThrow();
  });
});

describe("statChanged", () => {
  it("size 变化判变", () => {
    expect(statChanged({ mtime: 100, size: 10 }, { mtime: 100, size: 11 })).toBe(true);
  });
  it("mtime 变化判变（size 相同）", () => {
    expect(statChanged({ mtime: 100, size: 10 }, { mtime: 101, size: 10 })).toBe(true);
  });
  it("两者皆同判未变", () => {
    expect(statChanged({ mtime: 100, size: 10 }, { mtime: 100, size: 10 })).toBe(false);
  });
  it("mtime 不可用（0）时仅比 size", () => {
    expect(statChanged({ mtime: 0, size: 10 }, { mtime: 101, size: 10 })).toBe(false);
    expect(statChanged({ mtime: 100, size: 10 }, { mtime: 0, size: 10 })).toBe(false);
    expect(statChanged({ mtime: 0, size: 10 }, { mtime: 0, size: 11 })).toBe(true);
  });
});
