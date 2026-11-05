import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLog } from "../backend/client";
import {
  collectLogHosts,
  filterSessionLogs,
  formatLogDuration,
  formatLogSize,
  formatLogTime,
  parseAsciicast,
  sessionLogExportName,
  sessionLogItemTitle,
  sortSessionLogs,
} from "./sessionLogsModel";

function log(partial: Partial<SessionLog>): SessionLog {
  return {
    id: "cast:a.cast",
    session_id: "",
    host_id: null,
    host_name: "prod web",
    title: "prod web",
    format: "asciicast",
    path: "a.cast",
    started_at: 1,
    ended_at: 2,
    duration_ms: 1000,
    size_bytes: 1024,
    event_count: 1,
    status: "completed",
    ...partial,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sessionLogsModel", () => {
  it("解析 asciicast：拼接 o 事件、保留 ANSI、坏行跳过", () => {
    const content = [
      '{"version":2,"width":120,"height":30,"timestamp":1700000000}',
      '[0.25,"o","hello "]',
      "not-json",
      '[1.5,"r","ignored size"]',
      '[2.0,"o","\\u001b[31mred\\u001b[0m"]',
    ].join("\n");
    const summary = parseAsciicast(content);
    expect(summary.width).toBe(120);
    expect(summary.height).toBe(30);
    expect(summary.eventCount).toBe(2);
    expect(summary.durationMs).toBe(2000);
    expect(summary.text).toContain("hello ");
    expect(summary.text).toContain("\u001b[31mred\u001b[0m");
    expect(summary.text).not.toContain("ignored");
  });

  it("header 缺失 / 全坏行时返回空摘要而不抛错", () => {
    expect(parseAsciicast("")).toEqual({
      text: "",
      eventCount: 0,
      durationMs: 0,
      width: 0,
      height: 0,
    });
    expect(parseAsciicast("garbage\n[]\n{}")).toEqual({
      text: "",
      eventCount: 0,
      durationMs: 0,
      width: 0,
      height: 0,
    });
  });

  it("时长格式化覆盖秒 / 分 / 小时边界", () => {
    expect(formatLogDuration(999)).toBe("0s");
    expect(formatLogDuration(12000)).toBe("12s");
    expect(formatLogDuration(185000)).toBe("3m 05s");
    expect(formatLogDuration(3600000)).toBe("1h 00m");
    expect(formatLogDuration(8040000)).toBe("2h 14m");
    expect(formatLogDuration(-1)).toBe("0s");
  });

  it("大小格式化覆盖 B / KiB / MiB", () => {
    expect(formatLogSize(0)).toBe("0 B");
    expect(formatLogSize(512)).toBe("512 B");
    expect(formatLogSize(1024)).toBe("1.0 KiB");
    expect(formatLogSize(1536)).toBe("1.5 KiB");
    expect(formatLogSize(1024 * 1024)).toBe("1.0 MiB");
    expect(formatLogSize(3.5 * 1024 * 1024)).toBe("3.5 MiB");
  });

  it("搜索匹配 title / host_name / status（大小写不敏感）", () => {
    const logs = [
      log({ id: "a", title: "数据库巡检", status: "completed" }),
      log({ id: "b", title: "build", host_name: "Prod-Web", status: "failed" }),
    ];
    expect(filterSessionLogs(logs, { query: "产" }).map((l) => l.id)).toEqual([]);
    expect(filterSessionLogs(logs, { query: "数据库" }).map((l) => l.id)).toEqual([
      "a",
    ]);
    expect(filterSessionLogs(logs, { query: "prod-web" }).map((l) => l.id)).toEqual([
      "b",
    ]);
    expect(
      filterSessionLogs(logs, { query: "COMPLETED" }).map((l) => l.id),
    ).toEqual(["a"]);
  });

  it("主机精确匹配；不再按格式过滤", () => {
    const logs = [
      log({ id: "a", host_name: "prod" }),
      log({ id: "b", host_name: "prod-web", format: "log" }),
    ];
    expect(filterSessionLogs(logs, { host: "prod" }).map((l) => l.id)).toEqual([
      "a",
    ]);
    expect(filterSessionLogs(logs, { host: "pro" })).toEqual([]);
    expect(filterSessionLogs(logs, {})).toHaveLength(2);
  });

  it("列表首行标题：与主机名相同则不重复，自定义标题保留", () => {
    expect(sessionLogItemTitle(log({ title: "129", host_name: "129" }))).toBeNull();
    expect(
      sessionLogItemTitle(log({ title: "129", host_name: "129 " })),
    ).toBeNull();
    expect(
      sessionLogItemTitle(log({ title: "数据库巡检", host_name: "prod" })),
    ).toBe("数据库巡检");
    expect(sessionLogItemTitle(log({ title: "my session", host_name: "" }))).toBe(
      "my session",
    );
    expect(sessionLogItemTitle(log({ title: "  ", host_name: "prod" }))).toBeNull();
  });

  it("collectLogHosts 去重并排序", () => {
    const hosts = collectLogHosts([
      log({ id: "a", host_name: "zeta" }),
      log({ id: "b", host_name: "alpha" }),
      log({ id: "c", host_name: "alpha" }),
      log({ id: "d", host_name: " " }),
    ]);
    expect(hosts).toEqual(["alpha", "zeta"]);
  });

  it("sortSessionLogs 按 started_at 倒序、id 升序兜底且不改入参", () => {
    const logs = [
      log({ id: "cast:a.cast", started_at: 100 }),
      log({ id: "cast:c.cast", started_at: 300 }),
      log({ id: "cast:b.cast", started_at: 300 }),
    ];
    const sorted = sortSessionLogs(logs);
    expect(sorted.map((l) => l.id)).toEqual([
      "cast:b.cast",
      "cast:c.cast",
      "cast:a.cast",
    ]);
    expect(logs.map((l) => l.id)).toEqual([
      "cast:a.cast",
      "cast:c.cast",
      "cast:b.cast",
    ]);
  });

  it("导出文件名使用 host（或 title）+ started_at 时间戳", () => {
    const started = new Date(2024, 0, 2, 3, 4, 5).getTime();
    expect(
      sessionLogExportName(
        log({ host_name: "prod web", title: "x", started_at: started }),
        "txt",
      ),
    ).toBe("prod web_20240102_030405.txt");
    expect(
      sessionLogExportName(
        log({ host_name: "", title: "my session", started_at: started }),
        "html",
      ),
    ).toBe("my session_20240102_030405.html");
  });

  it("导出文件名替换非法字符，空标题回退 session", () => {
    const started = new Date(2024, 0, 2, 3, 4, 5).getTime();
    expect(
      sessionLogExportName(
        log({ host_name: 'prod/web:*?"<>|', title: "", started_at: started }),
        "cast",
      ),
    ).toBe("prod_web________20240102_030405.cast");
    expect(
      sessionLogExportName(
        log({ host_name: "", title: "", started_at: started }),
        "cast",
      ),
    ).toBe("session_20240102_030405.cast");
  });

  it("formatLogTime 今天 HH:mm、其它日期 MM-DD HH:mm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 5, 10, 12, 0, 0));
    const today = new Date(2024, 5, 10, 9, 8, 0).getTime();
    const other = new Date(2024, 0, 2, 3, 4, 0).getTime();
    expect(formatLogTime(today)).toBe("09:08");
    expect(formatLogTime(other)).toBe("01-02 03:04");
    expect(formatLogTime(0)).toBe("");
  });
});
