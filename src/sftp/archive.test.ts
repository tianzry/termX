/** #24 归档解压：前端菜单显隐判定（纯逻辑）。 */

import { describe, expect, it } from "vitest";
import { isExtractableArchive } from "./sftpModel";

describe("isExtractableArchive", () => {
  it("识别 tar 系与 zip", () => {
    for (const name of [
      "a.tar",
      "a.tar.gz",
      "a.TGZ",
      "a.tar.bz2",
      "a.tbz2",
      "a.tar.xz",
      "a.txz",
      "a.tar.zst",
      "a.tzst",
      "a.zip",
    ]) {
      expect(isExtractableArchive(name)).toBe(true);
    }
  });

  it("识别单文件压缩", () => {
    expect(isExtractableArchive("log.txt.gz")).toBe(true);
    expect(isExtractableArchive("data.bz2")).toBe(true);
    expect(isExtractableArchive("dump.xz")).toBe(true);
  });

  it("普通文件与仅后缀名不算归档", () => {
    expect(isExtractableArchive("readme.txt")).toBe(false);
    expect(isExtractableArchive(".zip")).toBe(false);
    expect(isExtractableArchive("a.tar.gz.bak")).toBe(false);
  });
});
