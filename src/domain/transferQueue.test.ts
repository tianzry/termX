import { describe, expect, it } from "vitest";
import type { TransferItem } from "../backend/client";
import {
  averageSpeed,
  bucketTransferItems,
  canCancel,
  canDismiss,
  canPause,
  canResume,
  canRetry,
  estimateTransferEtaSeconds,
  formatBytes,
  formatTransferBytes,
  formatTransferEta,
  formatTransferSpeed,
  pickActiveConflict,
  progressPercent,
  queueCounts,
  sortQueueForDisplay,
  transferBadge,
  transferBucket,
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
    checkpoint: 0,
    source_mtime: null,
    session_live: true,
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

  it("移除：仅终态；重试：仅失败（对齐 Netcatty 行尾按钮）", () => {
    expect(canDismiss("completed")).toBe(true);
    expect(canDismiss("failed")).toBe(true);
    expect(canDismiss("cancelled")).toBe(true);
    expect(canDismiss("skipped")).toBe(true);
    expect(canDismiss("running")).toBe(false);
    expect(canDismiss("paused")).toBe(false);
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("completed")).toBe(false);
    expect(canRetry("cancelled")).toBe(false);
  });
});

describe("传输字段格式", () => {
  it("字节：0 给 0 B，非 0 一位小数", () => {
    expect(formatTransferBytes(0)).toBe("0 B");
    expect(formatTransferBytes(512)).toBe("512 B");
    expect(formatTransferBytes(1024)).toBe("1.0 KB");
    expect(formatTransferBytes(1536)).toBe("1.5 KB");
    expect(formatTransferBytes(100 * 1024 * 1024)).toBe("100.0 MB");
  });

  it("速率：小于 1MB/s 用 KB/s，否则 MB/s；0 为空", () => {
    expect(formatTransferSpeed(0)).toBe("");
    expect(formatTransferSpeed(1536)).toBe("1.5 KB/s");
    expect(formatTransferSpeed(10 * 1024 * 1024)).toBe("10.0 MB/s");
  });

  it("剩余时间：剩余 <=0 或速率过低为 null；超过 48h 隐藏", () => {
    expect(estimateTransferEtaSeconds(0, 1024)).toBeNull();
    expect(estimateTransferEtaSeconds(100, 512)).toBeNull();
    expect(estimateTransferEtaSeconds(100 * 1024 * 1024, 10 * 1024 * 1024)).toBe(10);
    expect(estimateTransferEtaSeconds(600 * 1024 * 1024, 1024)).toBeNull();
    expect(formatTransferEta(6)).toBe("6s");
    expect(formatTransferEta(65)).toBe("1m 5s");
    expect(formatTransferEta(3600)).toBe("1h 0m");
    expect(formatTransferEta(null)).toBeNull();
  });

  it("滑动平均速率：窗口内差分；不足 0.5s 或回退为 0", () => {
    expect(
      averageSpeed([
        { at: 0, bytes: 0 },
        { at: 1000, bytes: 1024 },
      ]),
    ).toBe(1024);
    expect(
      averageSpeed([
        { at: 0, bytes: 0 },
        { at: 300, bytes: 1024 },
      ]),
    ).toBe(0);
    expect(
      averageSpeed([
        { at: 0, bytes: 2048 },
        { at: 1000, bytes: 1024 },
      ]),
    ).toBe(0);
    expect(averageSpeed([{ at: 0, bytes: 0 }])).toBe(0);
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

describe("全局传输中心分类与徽标", () => {
  it("状态 → 分类（失败与冲突进需要处理，终态进已完成）", () => {
    expect(transferBucket("running")).toBe("active");
    expect(transferBucket("queued")).toBe("queued");
    expect(transferBucket("paused")).toBe("paused");
    expect(transferBucket("conflict")).toBe("attention");
    expect(transferBucket("failed")).toBe("attention");
    expect(transferBucket("completed")).toBe("completed");
    expect(transferBucket("cancelled")).toBe("completed");
    expect(transferBucket("skipped")).toBe("completed");
  });

  it("按分类筛选；all 返回浅拷贝不改原数组", () => {
    const items = [
      item({ id: "r", status: "running" }),
      item({ id: "q", status: "queued" }),
      item({ id: "c", status: "conflict" }),
      item({ id: "d", status: "completed" }),
    ];
    expect(bucketTransferItems(items, "active").map((i) => i.id)).toEqual(["r"]);
    expect(bucketTransferItems(items, "attention").map((i) => i.id)).toEqual(["c"]);
    expect(bucketTransferItems(items, "completed").map((i) => i.id)).toEqual(["d"]);
    const all = bucketTransferItems(items, "all");
    expect(all).toEqual(items);
    expect(all).not.toBe(items);
  });

  it("徽标：未完成计数含冲突，失败只触发红点", () => {
    expect(transferBadge([])).toEqual({ count: 0, hasAttention: false });
    const badge = transferBadge([
      item({ status: "running" }),
      item({ status: "queued" }),
      item({ status: "paused" }),
      item({ status: "conflict" }),
      item({ status: "failed" }),
      item({ status: "completed" }),
      item({ status: "cancelled" }),
    ]);
    expect(badge).toEqual({ count: 4, hasAttention: true });
  });

  it("徽标：全部完成后归零（三态里的「已完成」）", () => {
    expect(
      transferBadge([
        item({ status: "completed" }),
        item({ status: "skipped" }),
      ]),
    ).toEqual({ count: 0, hasAttention: false });
  });
});

describe("pickActiveConflict", () => {
  it("无冲突返回 null", () => {
    expect(pickActiveConflict([])).toBeNull();
    expect(
      pickActiveConflict([item({ status: "running" }), item({ status: "completed" })]),
    ).toBeNull();
  });

  it("取展示序第一个冲突项（优先级降序、seq 升序）", () => {
    const a = item({ id: "a", status: "conflict", seq: 2, priority: "normal" });
    const b = item({ id: "b", status: "conflict", seq: 0, priority: "normal" });
    const c = item({ id: "c", status: "conflict", seq: 1, priority: "high" });
    expect(pickActiveConflict([a, b, c])?.conflict.id).toBe("c");
  });

  it("sameBatchCount = 同批 conflict 总数（含当前项）", () => {
    const a = item({ id: "a", status: "conflict", batch_id: "b1", seq: 0 });
    const b = item({ id: "b", status: "conflict", batch_id: "b1", seq: 1 });
    const c = item({ id: "c", status: "conflict", batch_id: "b2", seq: 2 });
    const picked = pickActiveConflict([c, b, a]);
    expect(picked?.conflict.id).toBe("a");
    expect(picked?.sameBatchCount).toBe(2);
  });
});
