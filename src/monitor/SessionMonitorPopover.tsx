/**
 * 终端工具栏「系统监控」浮层。
 *
 * 只读取当前 SSH 会话的主机指标（后端 `monitor_sample` 只读采样）：打开即采
 * 一次，之后每 3 秒轮询；首次网络速率为 null 时显示 `--`，不造数。
 * 浮层挂在工具栏按钮的 `.term-monitor-anchor` 容器里，点击空白 / Esc 关闭，
 * 会话断开由 TerminalPane 卸载本组件，定时器随之清理。
 */

import { useEffect, useState } from "react";
import * as api from "../backend/client";
import type { MonitorSample } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  formatCapacity,
  formatClock,
  formatPercent,
  formatRate,
  limitDisks,
  type DiskPreview,
} from "../domain/monitorModel";
import { Icon } from "../ui/icons";

const POLL_INTERVAL_MS = 3_000;
const SAMPLE_TIMEOUT_MS = 8_000;

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function SessionMonitorPopover({ sessionId, onClose }: Props) {
  const [sample, setSample] = useState<MonitorSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAt, setLastAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: number | null = null;

    async function poll() {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const next = await api.monitorSample(sessionId, SAMPLE_TIMEOUT_MS);
        if (cancelled) return;
        setSample(next);
        setError(null);
        setLastAt(Date.now());
      } catch (e) {
        if (cancelled) return;
        setError(userVisibleError(String(e)));
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    }

    void poll();
    timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [sessionId]);

  /** 点击浮层 / 锚点以外的区域或按 Esc 关闭（触发器由锚点容器排除）。 */
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".term-monitor-anchor")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const memPercent =
    sample &&
    sample.mem_total_mb != null &&
    sample.mem_total_mb > 0 &&
    sample.mem_used_mb != null
      ? (sample.mem_used_mb / sample.mem_total_mb) * 100
      : null;
  const disks: DiskPreview = sample
    ? limitDisks(sample.disks)
    : { shown: [], extra: 0 };

  return (
    <div className="term-monitor-popover" role="dialog" aria-label="系统监控">
      <div className="term-monitor-head">
        <span className="term-monitor-title">系统监控</span>
        <button
          type="button"
          className="term-monitor-close"
          title="关闭"
          onClick={onClose}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {sample?.hostname && (
        <div className="term-monitor-host" title={`${sample.hostname}${sample.kernel_release ? ` · ${sample.kernel_release}` : ""}`}>
          {sample.hostname}
          {sample.os_name ? ` · ${sample.os_name}` : ""}
        </div>
      )}

      {error && <div className="term-monitor-error">{error}</div>}

      {sample && !sample.supported && (
        <div className="term-monitor-error">
          {sample.unsupported_reason ?? "当前主机不支持指标采集"}
        </div>
      )}

      {!sample && !error && loading && (
        <div className="term-monitor-muted">正在采集…</div>
      )}

      {sample && sample.supported && (
        <>
          <div className="term-monitor-cards">
            <div className="term-monitor-card">
              <div className="term-monitor-label">CPU</div>
              <div className="term-monitor-value">{formatPercent(sample.cpu)}</div>
              <div className="term-monitor-detail">
                {sample.cpu_cores > 0 ? `${sample.cpu_cores} 核` : "--"}
              </div>
            </div>
            <div className="term-monitor-card">
              <div className="term-monitor-label">内存</div>
              <div className="term-monitor-value">{formatPercent(memPercent)}</div>
              <div className="term-monitor-detail">
                {formatCapacity(sample.mem_used_mb)} / {formatCapacity(sample.mem_total_mb)}
              </div>
            </div>
          </div>

          <div className="term-monitor-section">
            <div className="term-monitor-label">磁盘</div>
            {disks.shown.length === 0 ? (
              <div className="term-monitor-muted term-monitor-disk-empty">无分区数据</div>
            ) : (
              <div className="term-monitor-disk-list">
                {disks.shown.map((disk) => (
                  <div
                    className="term-monitor-disk-row"
                    key={`${disk.mount_point}-${disk.filesystem}`}
                  >
                    <span
                      className="term-monitor-disk-name"
                      title={`${disk.filesystem} · ${disk.mount_point}`}
                    >
                      {disk.mount_point}
                    </span>
                    <span className="term-monitor-disk-num">
                      {formatPercent(disk.percent)}
                    </span>
                    <span className="term-monitor-muted">
                      {disk.used_gb}/{disk.total_gb} GB
                    </span>
                  </div>
                ))}
                {disks.extra > 0 && (
                  <div className="term-monitor-muted">另有 {disks.extra} 个分区未显示</div>
                )}
              </div>
            )}
          </div>

          <div className="term-monitor-section">
            <div className="term-monitor-label">网络</div>
            <div className="term-monitor-net-row">
              <span>↓ {formatRate(sample.net_rx_speed)}</span>
              <span>↑ {formatRate(sample.net_tx_speed)}</span>
            </div>
          </div>
        </>
      )}

      {sample && sample.warnings.length > 0 && (
        <div className="term-monitor-warnings">
          {sample.warnings.map((warning, index) => (
            <span key={index}>{warning}</span>
          ))}
        </div>
      )}

      <div className="term-monitor-foot">
        {lastAt ? `更新于 ${formatClock(lastAt)} · 每 3 秒刷新` : "每 3 秒刷新"}
      </div>
    </div>
  );
}
