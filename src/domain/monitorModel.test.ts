import { describe, expect, it } from "vitest";
import type { MonitorSample } from "../backend/client";
import {
  appendPoint,
  buildTrendGeometry,
  formatCapacity,
  formatBytes,
  formatPercent,
  formatRate,
  formatUptime,
  limitDisks,
} from "./monitorModel";

function sample(overrides: Partial<MonitorSample>): MonitorSample {
  return {
    sampled_at_ms: 1_000_000,
    supported: true,
    unsupported_reason: null,
    warnings: [],
    hostname: "host",
    os_name: "Linux",
    kernel_release: "6.8",
    uptime_seconds: 3600,
    load_average: [0.1, 0.2, 0.3],
    cpu: 10,
    cpu_cores: 4,
    cpu_per_core: [10, 10, 10, 10],
    mem_total_mb: 16000,
    mem_used_mb: 8000,
    mem_free_mb: 4000,
    mem_buffers_mb: 1000,
    mem_cached_mb: 3000,
    swap_total_mb: 2048,
    swap_used_mb: 0,
    disk_percent: 25,
    disk_used_gb: 5,
    disk_total_gb: 20,
    disks: [],
    net_rx_speed: 1024,
    net_tx_speed: 2048,
    net_rx_bytes: 123,
    net_tx_bytes: 456,
    net_interfaces: [],
    ...overrides,
  };
}

describe("appendPoint", () => {
  it("按时间裁掉超出趋势范围的点并保留最新", () => {
    const points = [{ at: 0, cpu: 1, memory: 1, rx: 1, tx: 1 }];
    const next = appendPoint(points, sample({}), 5, 10_000);
    expect(next).toHaveLength(1);
    expect(next[0].at).toBe(10_000);
  });

  it("内存百分比来自已用/总量；不支持时曲线值置空", () => {
    const [point] = appendPoint([], sample({}), 300, 10_000);
    expect(point.memory).toBe(50);
    const [unsupported] = appendPoint(
      [],
      sample({ supported: false, unsupported_reason: "只支持 Linux" }),
      300,
      10_000,
    );
    expect(unsupported.cpu).toBeNull();
    expect(unsupported.memory).toBeNull();
  });
});

describe("buildTrendGeometry", () => {
  it("缺失采样超过 3 个间隔时断成两段，不跨缺口连线", () => {
    const points = [
      { at: 1000, cpu: 10, memory: 10, rx: 1, tx: 1 },
      { at: 3000, cpu: 20, memory: 20, rx: 1, tx: 1 },
      { at: 30_000, cpu: 40, memory: 40, rx: 1, tx: 1 },
    ];
    const geometry = buildTrendGeometry(points, "cpu", 60, 40_000, 2);
    expect(geometry.segments).toHaveLength(2);
    expect(geometry.max).toBe(100);
  });

  it("网络趋势按观测最大值缩放", () => {
    const points = [
      { at: 9000, cpu: 1, memory: 1, rx: 500, tx: 1 },
      { at: 10_000, cpu: 1, memory: 1, rx: 1000, tx: 1 },
    ];
    const geometry = buildTrendGeometry(points, "rx", 60, 10_000, 2);
    expect(geometry.segments).toHaveLength(1);
    expect(geometry.max).toBeGreaterThan(1000);
  });
});

describe("limitDisks", () => {
  const disk = (mount: string) => ({
    mount_point: mount,
    filesystem: "ext4",
    used_gb: 1,
    total_gb: 2,
    percent: 50,
  });

  it("超过上限时只展示前 max 个并给出剩余计数", () => {
    const preview = limitDisks([disk("/"), disk("/data"), disk("/home"), disk("/var"), disk("/tmp")]);
    expect(preview.shown).toHaveLength(3);
    expect(preview.extra).toBe(2);
  });

  it("未超过上限时不显示剩余计数", () => {
    const preview = limitDisks([disk("/"), disk("/data")]);
    expect(preview.shown).toHaveLength(2);
    expect(preview.extra).toBe(0);
  });
});

describe("格式化", () => {
  it("空值一律 --，不补零", () => {
    expect(formatPercent(null)).toBe("--");
    expect(formatPercent(12.34)).toBe("12.3%");
    expect(formatRate(null)).toBe("--");
    expect(formatCapacity(null)).toBe("--");
    expect(formatUptime(null)).toBe("--");
  });

  it("速率与容量单位换算", () => {
    expect(formatRate(1024)).toBe("1.0 KB/s");
    expect(formatRate(5 * 1024 * 1024)).toBe("5.0 MB/s");
    expect(formatBytes(248_917_480)).toBe("237 MB");
    expect(formatCapacity(2048)).toBe("2.0 GiB");
    expect(formatCapacity(800)).toBe("800 MiB");
    expect(formatUptime(90_000)).toBe("1 天 1 小时");
  });
});
