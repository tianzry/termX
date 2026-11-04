/** #24 归档解压：前端菜单显隐判定（纯逻辑）。 */

import { describe, expect, it } from "vitest";
import { canExtractArchive, isExtractableArchive } from "./sftpModel";

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

describe("canExtractArchive（菜单项可见性）", () => {
  const remote = (canExec: boolean) => ({
    kind: "remote" as const,
    sftpId: "sftp-1",
    canExec,
    label: "129",
    meta: "tianzry@192.168.126.129",
    path: "/home/tianzry",
    os: "linux" as const,
  });

  it("会话派生的远端连接：归档文件显示解压", () => {
    expect(canExtractArchive(remote(true), "a.tar.gz")).toBe(true);
  });

  it("独立 SFTP 连接（无 exec 通道）不显示解压", () => {
    expect(canExtractArchive(remote(false), "a.tar.gz")).toBe(false);
  });

  it("本地连接与非归档文件都隐藏", () => {
    expect(
      canExtractArchive(
        { kind: "local", label: "本地", path: "C:\\", os: "windows" },
        "a.tar.gz",
      ),
    ).toBe(false);
    expect(canExtractArchive(remote(true), "readme.txt")).toBe(false);
  });
});
