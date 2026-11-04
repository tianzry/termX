import { describe, expect, it } from "vitest";
import {
  conflictBlocks,
  detectSyncConflict,
  normalizeGitHubRepo,
  normalizeWebdavUrl,
  remoteIsNewer,
  summarizeRemote,
} from "./syncModel";

describe("normalizeGitHubRepo", () => {
  it("接受 owner/repo / URL / .git 三种写法", () => {
    expect(normalizeGitHubRepo("owner/repo")).toBe("owner/repo");
    expect(normalizeGitHubRepo("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(normalizeGitHubRepo("  github.com/owner/repo/  ")).toBe("owner/repo");
  });

  it("符号链接式多余路径只取前两段", () => {
    expect(normalizeGitHubRepo("owner/repo/tree/main")).toBe("owner/repo");
  });
});

describe("normalizeWebdavUrl", () => {
  it("缺协议补 https，已有协议保持", () => {
    expect(normalizeWebdavUrl("dav.example.com/remote.php/dav")).toBe(
      "https://dav.example.com/remote.php/dav",
    );
    expect(normalizeWebdavUrl("http://127.0.0.1:8080/dav")).toBe("http://127.0.0.1:8080/dav");
  });
});

describe("remoteIsNewer / summarizeRemote", () => {
  it("只在远端版本更大时为 true", () => {
    expect(remoteIsNewer(3, 4)).toBe(true);
    expect(remoteIsNewer(4, 3)).toBe(false);
    expect(remoteIsNewer(4, 4)).toBe(false);
    expect(remoteIsNewer(null, 4)).toBe(false);
  });

  it("区分未配置 / 探测失败 / 已同步 / 远端更新", () => {
    expect(summarizeRemote(null, 1).tone).toBe("empty");
    expect(
      summarizeRemote({ remote: null, error: "401", pulled: false }, 1).tone,
    ).toBe("error");
    expect(
      summarizeRemote(
        { remote: { version: 2, config_digest: "sha256:x" }, error: null, pulled: false },
        2,
      ).tone,
    ).toBe("synced");
    expect(
      summarizeRemote(
        { remote: { version: 5, config_digest: "sha256:x" }, error: null, pulled: false },
        2,
      ).tone,
    ).toBe("newer");
  });
});

describe("detectSyncConflict / conflictBlocks", () => {
  const local = { version: 4, config_digest: "sha256:a" };

  it("远端更高只拦推送，本地更高只拦拉取", () => {
    const remoteNewer = { version: 5, config_digest: "sha256:a" };
    expect(detectSyncConflict(local, remoteNewer)).toBe("remote_newer");
    expect(conflictBlocks("remote_newer", "push")).toBe(true);
    expect(conflictBlocks("remote_newer", "pull")).toBe(false);

    const localNewer = { version: 3, config_digest: "sha256:a" };
    expect(detectSyncConflict(local, localNewer)).toBe("local_newer");
    expect(conflictBlocks("local_newer", "push")).toBe(false);
    expect(conflictBlocks("local_newer", "pull")).toBe(true);
  });

  it("同版本不同摘要视为分叉，两个方向都拦", () => {
    expect(
      detectSyncConflict(local, { version: 4, config_digest: "sha256:b" }),
    ).toBe("diverged");
    expect(conflictBlocks("diverged", "push")).toBe(true);
    expect(conflictBlocks("diverged", "pull")).toBe(true);
  });

  it("缺失远端或完全一致时不算冲突", () => {
    expect(detectSyncConflict(local, null)).toBe("none");
    expect(detectSyncConflict(local, { ...local })).toBe("none");
    expect(conflictBlocks("none", "push")).toBe(false);
  });
});
