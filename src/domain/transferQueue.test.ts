import { describe, expect, it } from "vitest";
import type { TransferItem } from "../backend/client";
import {
  canCancel,
  canPause,
  canResume,
  formatBytes,
  progressPercent,
  queueCounts,
  sortQueueForDisplay,
  transferDisplayName,
} from "./transferQueue";

function item(patch: Partial<TransferItem>): TransferItem {
  return {
    id: "t",
    sftp_id: "s1",
    batch_id: "b1",
    direction: "upload",
    local_path: "C:\\dir\\file.txt",
    remote_path: "/remote/file.txt",
    size: 0,
    status: "queued",
    priority: "normal",
    seq: 0,
    overwrite: false,
    error: null,
    created_at: 0,
    ...patch,
  };
}

describe("transferDisplayName", () => {
  it("上传取本地文件名（反斜杠），下载取远端文件名（正斜杠）", () => {
    expect(
      transferDisplayName(item({ direction: "upload", local_path: "C:\\a\\b\\c.txt" })),
    ).toBe("c.txt");
    expect(
      transferDisplayName(item({ direction: "download", remote_path: "/x/y/z.log" })),
    ).toBe("z.log");
  });

  it("无分隔符或空名回退原串", () => {
    expect(transferDisplayName(item({ local_path: "bare.txt" }))).toBe("bare.txt");
    expect(transferDisplayName(item({ local_path: "" }))).toBe("");
  });
});

describe("sortQueueForDisplay", () => {
  it("活跃组在前（running > conflict > paused > queued），终态在后", () => {
    const items = [
      item({ id: "done", status: "completed", seq: 0 }),
      item({ id: "q", status: "queued", seq: 1 }),
      item({ id: "run", status: "running", seq: 2 }),
      item({ id: "cf", status: "conflict", seq: 3 }),
      item({ id: "p", status: "paused", seq: 4 }),
    ];
    expect(sortQueueForDisplay(items).map((i) => i.id)).toEqual([
      "run",
      "cf",
      "p",
      "q",
      "done",
    ]);
  });

  it("活跃组内优先级降序、同优先级 seq 升序", () => {
    const items = [
      item({ id: "n0", status: "queued", priority: "normal", seq: 0 }),
      item({ id: "l1", status: "queued", priority: "low", seq: 1 }),
      item({ id: "h2", status: "queued", priority: "high", seq: 2 }),
      item({ id: "h3", status: "queued", priority: "high", seq: 3 }),
    ];
    expect(sortQueueForDisplay(items).map((i) => i.id)).toEqual([
      "h2",
      "h3",
      "n0",
      "l1",
    ]);
  });

  it("终态组按 seq 升序，不比较优先级", () => {
    const items = [
      item({ id: "a", status: "failed", priority: "high", seq: 5 }),
      item({ id: "b", status: "completed", priority: "low", seq: 2 }),
    ];
    expect(sortQueueForDisplay(items).map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("不修改入参数组", () => {
    const items = [
      item({ id: "b", status: "queued", seq: 1 }),
      item({ id: "a", status: "running", seq: 0 }),
    ];
    sortQueueForDisplay(items);
    expect(items.map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("queueCounts", () => {
  it("活跃 / 已结束分组计数", () => {
    const items = [
      item({ status: "running" }),
      item({ status: "queued" }),
      item({ status: "paused" }),
      item({ status: "conflict" }),
      item({ status: "completed" }),
      item({ status: "failed" }),
      item({ status: "cancelled" }),
      item({ status: "skipped" }),
    ];
    expect(queueCounts(items)).toEqual({ active: 4, finished: 4 });
    expect(queueCounts([])).toEqual({ active: 0, finished: 0 });
  });
});

describe("按钮可用性", () => {
  it("暂停：仅 queued / running", () => {
    expect(canPause("queued")).toBe(true);
    expect(canPause("running")).toBe(true);
    expect(canPause("paused")).toBe(false);
    expect(canPause("conflict")).toBe(false);
    expect(canPause("completed")).toBe(false);
  });

  it("恢复：仅 paused", () => {
    expect(canResume("paused")).toBe(true);
    expect(canResume("queued")).toBe(false);
    expect(canResume("cancelled")).toBe(false);
  });

  it("取消：非终态均可", () => {
    expect(canCancel("queued")).toBe(true);
    expect(canCancel("running")).toBe(true);
    expect(canCancel("paused")).toBe(true);
    expect(canCancel("conflict")).toBe(true);
    expect(canCancel("completed")).toBe(false);
    expect(canCancel("failed")).toBe(false);
    expect(canCancel("cancelled")).toBe(false);
    expect(canCancel("skipped")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("0 / 负数 / 非有限 = 空串（未知大小）", () => {
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(-5)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });

  it("单位换算与精度", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
    expect(formatBytes(1024 * 1024 * 256)).toBe("256 MB");
    // 单位上限 TB，超出不再进位
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
  });
});

describe("progressPercent", () => {
  it("total<=0 不定长返回 null", () => {
    expect(progressPercent(10, 0)).toBeNull();
    expect(progressPercent(10, -1)).toBeNull();
  });

  it("百分比截断到 100，负 transferred 归 0", () => {
    expect(progressPercent(512, 1024)).toBe(50);
    expect(progressPercent(2048, 1024)).toBe(100);
    expect(progressPercent(-3, 100)).toBe(0);
  });
});
