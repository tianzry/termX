/**
 * Vault「监控」页（P1 #14）。
 *
 * 对齐 Netcatty MonitorPanels 的核心能力：多主机卡片 / 列表、CPU / 内存 /
 * 磁盘 / 网络实时读数与趋势曲线、连接状态、可调重采样间隔、断线自动重试。
 *
 * 监控使用独立的 SSH 会话（不占用终端标签），后端 `monitor_sample` 只读采样。
 * Netcatty 有而 termX 后端没有的字段（延迟 / GPU / 磁盘 I/O / 进程）保持置灰，
 * 并在界面上写明原因，绝不填假数据。
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as api from "../backend/client";
import type { MonitorSample, Profile } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  appendPoint,
  buildTrendGeometry,
  formatCapacity,
  formatBytes,
  formatClock,
  formatPercent,
  formatRate,
  formatUptime,
  type MonitorPoint,
  type TrendField,
} from "../domain/monitorModel";
import { Icon } from "../ui/icons";

const INTERVALS = [2, 5, 10, 30];
const RANGES = [5, 15, 30];
const DEFAULT_INTERVAL = 2;
const DEFAULT_RANGE = 5;
const VIEW_KEY = "termx.monitor.view.v1";

type Status =
  | "stopped"
  | "queued"
  | "connecting"
  | "live"
  | "error"
  | "disconnected";

interface HostState {
  status: Status;
  sessionId: string | null;
  sample: MonitorSample | null;
  points: MonitorPoint[];
  error: string | null;
  lastAt: number | null;
  failures: number;
  retryAt: number | null;
  unsupported: boolean;
}

const EMPTY_HOST: HostState = {
  status: "stopped",
  sessionId: null,
  sample: null,
  points: [],
  error: null,
  lastAt: null,
  failures: 0,
  retryAt: null,
  unsupported: false,
};

const STATUS_META: Record<Status, { label: string; color: string }> = {
  stopped: { label: "未开始", color: "hsl(var(--muted-foreground))" },
  queued: { label: "排队中", color: "hsl(var(--muted-foreground))" },
  connecting: { label: "连接中", color: "#fbbf24" },
  live: { label: "已更新", color: "#34d399" },
  error: { label: "采集失败", color: "#f87171" },
  disconnected: { label: "已断开", color: "#f87171" },
};

const panelCard: CSSProperties = {
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  background: "hsl(var(--card))",
  padding: "12px 14px",
  minWidth: 0,
};

const muted: CSSProperties = {
  color: "hsl(var(--muted-foreground))",
  fontSize: 11,
};

const btn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "hsl(var(--secondary))",
  color: "hsl(var(--foreground))",
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const iconBtn: CSSProperties = {
  ...btn,
  padding: "5px 7px",
};

function backoffMs(failures: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.min(failures, 4));
}

function memoryPercent(sample: MonitorSample | null): number | null {
  if (!sample || sample.mem_total_mb == null || sample.mem_used_mb == null || sample.mem_total_mb <= 0) {
    return null;
  }
  return (sample.mem_used_mb / sample.mem_total_mb) * 100;
}

/** Netcatty 有、termX 后端尚未采集的字段：置灰 + 原因，不造数。 */
const MISSING_FIELDS: Array<{ label: string; reason: string }> = [
  { label: "延迟", reason: "未实现 SSH 传输层 ping（Netcatty 有）" },
  { label: "GPU", reason: "未采集 NVIDIA 指标（Netcatty 有）" },
  { label: "磁盘 I/O", reason: "未实现两次采样差分（Netcatty 有）" },
  { label: "进程", reason: "未读取 top 进程（Netcatty 有）" },
];

function StatusBadge({ status, stale }: { status: Status; stale: boolean }) {
  const key: Status = stale ? "live" : status;
  const meta = STATUS_META[key];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: 500,
        color: stale ? "#fbbf24" : meta.color,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: "currentColor",
          flex: "none",
        }}
      />
      {stale ? "读数过期" : status === "stopped" ? "未开始" : meta.label}
    </span>
  );
}

function TrendChart({
  points,
  field,
  rangeSecs,
  intervalSec,
  color,
  height = 56,
}: {
  points: MonitorPoint[];
  field: TrendField;
  rangeSecs: number;
  intervalSec: number;
  color: string;
  height?: number;
}) {
  const gradientId = useId();
  const now = Date.now();
  const geometry = useMemo(
    () => buildTrendGeometry(points, field, rangeSecs, now, intervalSec, 300, 64),
    [points, field, rangeSecs, intervalSec, now],
  );
  return (
    <svg
      role="img"
      aria-label={`${field} 趋势`}
      viewBox="0 0 300 64"
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height, color, marginTop: 6 }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity=".02" />
        </linearGradient>
      </defs>
      <path
        d="M0 4 H300 M0 31 H300 M0 58 H300"
        stroke="hsl(var(--border))"
        strokeWidth={0.5}
        strokeDasharray="3 4"
        fill="none"
      />
      {geometry.segments.length === 0 ? (
        <text x="150" y="36" textAnchor="middle" fontSize="10" fill="hsl(var(--muted-foreground))">
          等待读数
        </text>
      ) : (
        geometry.segments.map((segment, index) => (
          <g key={index}>
            <path
              d={`${segment.path} L ${segment.x.toFixed(2)} 58 L ${segment.firstX.toFixed(2)} 58 Z`}
              fill={`url(#${gradientId})`}
              stroke="none"
            />
            <path
              d={segment.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))
      )}
    </svg>
  );
}

function Metric({
  label,
  value,
  detail,
  color,
}: {
  label: string;
  value: string;
  detail: string;
  color?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...muted, display: "flex", alignItems: "center", gap: 5 }}>
        {color && (
          <span
            style={{ width: 6, height: 6, borderRadius: 2, background: color, flex: "none" }}
          />
        )}
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          fontSize: 22,
          lineHeight: 1.15,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: "hsl(var(--foreground))",
        }}
      >
        {value}
      </div>
      <div style={{ ...muted, marginTop: 2, minHeight: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {detail}
      </div>
    </div>
  );
}

export function MonitorView({
  profiles,
  onOpenHost,
}: {
  profiles: Profile[];
  onOpenHost?: (profile: Profile) => void;
}) {
  const movable = useMemo(
    () => profiles.filter((p) => (p.protocol ?? "ssh") === "ssh"),
    [profiles],
  );
  const movableIds = useMemo(() => new Set(movable.map((p) => p.id)), [movable]);
  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const [hosts, setHosts] = useState<Record<string, HostState>>({});
  const hostsRef = useRef(hosts);
  const listenersRef = useRef(new Map<string, () => void>());
  const pendingRef = useRef(new Set<string>());

  const [running, setRunning] = useState(false);
  const runningRef = useRef(running);
  runningRef.current = running;

  const [interval, setIntervalSec] = useState(DEFAULT_INTERVAL);
  const [range, setRange] = useState(DEFAULT_RANGE);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [view, setView] = useState<"charts" | "list">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "charts";
    } catch {
      return "charts";
    }
  });
  const [query, setQuery] = useState("");

  function patchHost(id: string, patch: Partial<HostState>) {
    const next = {
      ...hostsRef.current,
      [id]: { ...(hostsRef.current[id] ?? EMPTY_HOST), ...patch },
    };
    hostsRef.current = next;
    setHosts(next);
  }

  async function connectHost(profileId: string) {
    if (!runningRef.current || pendingRef.current.has(profileId)) return;
    pendingRef.current.add(profileId);
    const sid = api.newSessionId();
    patchHost(profileId, {
      status: "connecting",
      sessionId: sid,
      error: null,
      retryAt: null,
    });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await api
        .onSshProgress(sid, (ev) => {
          if (!runningRef.current) return;
          if (ev.status === "error") {
            patchHost(profileId, {
              status: "error",
              error: userVisibleError(ev.error ?? "连接失败"),
            });
          }
        })
        .catch(() => () => {});
      listenersRef.current.set(profileId, unlisten ?? (() => {}));
      await api.sshConnect(profileId, 80, 24, sid);
      if (runningRef.current) {
        patchHost(profileId, { status: "live", error: null });
      }
    } catch (e) {
      unlisten?.();
      listenersRef.current.delete(profileId);
      if (!runningRef.current) return;
      const failures = (hostsRef.current[profileId]?.failures ?? 0) + 1;
      patchHost(profileId, {
        status: "disconnected",
        sessionId: null,
        error: userVisibleError(String(e)),
        failures,
        retryAt: Date.now() + backoffMs(failures),
      });
    } finally {
      pendingRef.current.delete(profileId);
    }
  }

  async function sampleHost(id: string, sid: string) {
    try {
      const sample = await api.monitorSample(sid, 8000);
      if (!runningRef.current) return;
      const prev = hostsRef.current[id] ?? EMPTY_HOST;
      patchHost(id, {
        status: sample.supported ? "live" : "error",
        sample,
        points: appendPoint(prev.points, sample, rangeRef.current * 60),
        lastAt: Date.now(),
        failures: 0,
        error: sample.supported
          ? null
          : sample.unsupported_reason ?? "监控暂不可用",
        unsupported: !sample.supported,
      });
    } catch (e) {
      if (!runningRef.current) return;
      const prev = hostsRef.current[id] ?? EMPTY_HOST;
      const failures = prev.failures + 1;
      const message = userVisibleError(String(e));
      if (failures >= 2) {
        void api.sshDisconnect(sid).catch(() => {});
        const unlisten = listenersRef.current.get(id);
        unlisten?.();
        listenersRef.current.delete(id);
        patchHost(id, {
          status: "disconnected",
          sessionId: null,
          error: message,
          failures,
          retryAt: Date.now() + backoffMs(failures),
        });
      } else {
        patchHost(id, { status: "error", error: message, failures });
      }
    }
  }

  const tickBusyRef = useRef(false);
  async function tick() {
    if (!runningRef.current || tickBusyRef.current) return;
    tickBusyRef.current = true;
    try {
      for (const id of selectedRef.current) {
        if (!runningRef.current) return;
        const state = hostsRef.current[id];
        if (!state || state.unsupported || pendingRef.current.has(id)) continue;
        if (!state.sessionId) {
          if (state.retryAt && Date.now() < state.retryAt) continue;
          await connectHost(id);
          continue;
        }
        if (state.status === "live" || state.status === "error") {
          await sampleHost(id, state.sessionId);
        }
      }
    } finally {
      tickBusyRef.current = false;
    }
  }
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!running) return;
    void tickRef.current();
    const handle = window.setInterval(() => {
      void tickRef.current();
    }, interval * 1000);
    return () => window.clearInterval(handle);
  }, [running, interval]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      for (const state of Object.values(hostsRef.current)) {
        if (state.sessionId) void api.sshDisconnect(state.sessionId).catch(() => {});
      }
      for (const unlisten of listenersRef.current.values()) unlisten();
      listenersRef.current.clear();
    };
  }, []);

  function start() {
    const ids = [...selectedRef.current].filter((id) => movableIds.has(id));
    if (!ids.length) return;
    for (const id of ids) {
      patchHost(id, {
        status: "queued",
        sessionId: null,
        sample: null,
        points: [],
        error: null,
        failures: 0,
        retryAt: null,
        lastAt: null,
        unsupported: false,
      });
    }
    runningRef.current = true;
    setRunning(true);
  }

  function stop() {
    runningRef.current = false;
    setRunning(false);
    for (const state of Object.values(hostsRef.current)) {
      if (state.sessionId) void api.sshDisconnect(state.sessionId).catch(() => {});
    }
    for (const unlisten of listenersRef.current.values()) unlisten();
    listenersRef.current.clear();
    pendingRef.current.clear();
    const next = { ...hostsRef.current };
    for (const id of Object.keys(next)) {
      next[id] = { ...next[id], status: "stopped", sessionId: null, retryAt: null, failures: 0 };
    }
    hostsRef.current = next;
    setHosts(next);
  }

  function retry(id: string) {
    if (!runningRef.current) return;
    const sid = hostsRef.current[id]?.sessionId;
    if (sid) void api.sshDisconnect(sid).catch(() => {});
    const unlisten = listenersRef.current.get(id);
    unlisten?.();
    listenersRef.current.delete(id);
    patchHost(id, {
      sessionId: null,
      status: "queued",
      retryAt: null,
      error: null,
      failures: 0,
      unsupported: false,
    });
    void connectHost(id);
  }

  function toggleSelected(id: string) {
    if (running) return;
    const next = new Set(selectedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedRef.current = next;
    setSelected(next);
  }

  function changeView(next: "charts" | "list") {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* 忽略存储失败 */
    }
  }

  const now = Date.now();
  const selectedProfiles = [...selected]
    .map((id) => profileMap.get(id))
    .filter((p): p is Profile => !!p);
  const filteredProfiles = movable.filter((p) => {
    const q = query.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.host.toLowerCase().includes(q);
  });
  const runningProfiles = selectedProfiles.filter((p) => hosts[p.id]);

  const renderCard = (profile: Profile) => {
    const state = hosts[profile.id] ?? EMPTY_HOST;
    const sample = state.sample;
    const stale =
      state.status === "live" &&
      !!state.lastAt &&
      now - state.lastAt > Math.max(5000, interval * 2500);
    const memPct = memoryPercent(sample);
    return (
      <div key={profile.id} style={{ ...panelCard, opacity: state.status === "stopped" ? 0.65 : 1 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {profile.name}
            </div>
            <div style={{ ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {profile.host}:{profile.port}
              {sample?.hostname ? ` · ${sample.hostname}` : ""}
              {sample?.kernel_release ? ` · ${sample.kernel_release}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
            <StatusBadge status={state.status} stale={stale} />
            {onOpenHost && (
              <button style={{ ...iconBtn, padding: 3 }} title="打开终端" onClick={() => onOpenHost(profile)}>
                <Icon name="terminal" size={13} />
              </button>
            )}
            {running && state.status !== "live" && state.status !== "connecting" && (
              <button style={{ ...iconBtn, padding: 3 }} title="重试连接" onClick={() => retry(profile.id)}>
                <Icon name="refresh" size={13} />
              </button>
            )}
          </div>
        </div>

        {state.error && (
          <div
            style={{
              marginTop: 8,
              padding: "6px 8px",
              borderRadius: 6,
              background: "hsl(var(--destructive) / 0.08)",
              color: "hsl(var(--destructive))",
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {state.error}
            {state.status === "disconnected" && state.retryAt
              ? ` · ${Math.max(0, Math.ceil((state.retryAt - now) / 1000))}s 后自动重试`
              : ""}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 10 }}>
          <div>
            <Metric
              label="CPU"
              value={formatPercent(sample?.cpu)}
              detail={sample?.cpu_cores ? `${sample.cpu_cores} 核` + (sample.load_average.length ? ` · 负载 ${sample.load_average[0].toFixed(2)}` : "") : "--"}
              color="#38bdf8"
            />
            {view === "charts" && (
              <TrendChart points={state.points} field="cpu" rangeSecs={range * 60} intervalSec={interval} color="#38bdf8" />
            )}
          </div>
          <div>
            <Metric
              label="内存"
              value={formatPercent(memPct)}
              detail={`${formatCapacity(sample?.mem_used_mb)} / ${formatCapacity(sample?.mem_total_mb)}`}
              color="#34d399"
            />
            {view === "charts" && (
              <TrendChart points={state.points} field="memory" rangeSecs={range * 60} intervalSec={interval} color="#34d399" />
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 8 }}>
          <Metric
            label="磁盘（根分区）"
            value={formatPercent(sample?.disk_percent)}
            detail={
              sample
                ? `${sample.disk_used_gb ?? "--"} GB / ${sample.disk_total_gb ?? "--"} GB`
                : "--"
            }
            color="#a78bfa"
          />
          <Metric
            label="网络"
            value={sample?.net_rx_speed != null ? `↓ ${formatRate(sample.net_rx_speed)}` : "--"}
            detail={
              sample
                ? `↑ ${formatRate(sample.net_tx_speed)} · 累计 ↓ ${formatBytes(sample.net_rx_bytes)}`
                : "--"
            }
            color="#fbbf24"
          />
        </div>

        {sample && sample.disks.length > 0 && (
          <div style={{ ...muted, marginTop: 8, display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
            {sample.disks.slice(0, 3).map((disk) => (
              <span key={`${disk.mount_point}-${disk.filesystem}`}>
                {disk.mount_point} {formatPercent(disk.percent)}（{disk.used_gb}/{disk.total_gb} GB）
              </span>
            ))}
          </div>
        )}

        {sample && sample.warnings.length > 0 && (
          <div style={{ ...muted, marginTop: 6, color: "#fbbf24" }}>{sample.warnings.join(" ")}</div>
        )}

        {state.lastAt && (
          <div style={{ ...muted, marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>更新于 {formatClock(state.lastAt)}</span>
            {sample?.uptime_seconds != null && <span>运行 {formatUptime(sample.uptime_seconds)}</span>}
            {sample?.swap_total_mb != null && sample.swap_total_mb > 0 && (
              <span>Swap {formatCapacity(sample.swap_used_mb)} / {formatCapacity(sample.swap_total_mb)}</span>
            )}
          </div>
        )}

        <div style={{ ...muted, marginTop: 8, display: "flex", flexWrap: "wrap", gap: "2px 10px", opacity: 0.75 }}>
          {MISSING_FIELDS.map((field) => (
            <span key={field.label} title={field.reason} style={{ textDecoration: "line-through", textDecorationColor: "hsl(var(--muted-foreground) / 0.5)" }}>
              {field.label}
            </span>
          ))}
          <span>— 置灰项未采集：延迟（未实现 SSH 传输层 ping）· GPU（无 NVIDIA）· 磁盘 I/O（未做差分）· 进程（未读 top）</span>
        </div>
      </div>
    );
  };

  const renderTable = () => (
    <div style={{ ...panelCard, padding: 0, overflow: "hidden" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(140px, 1.4fr) 90px 70px 90px 90px 120px 80px",
          gap: 12,
          padding: "8px 14px",
          fontSize: 11,
          color: "hsl(var(--muted-foreground))",
          borderBottom: "1px solid hsl(var(--border))",
        }}
      >
        <span>主机</span>
        <span>状态</span>
        <span>CPU</span>
        <span>内存</span>
        <span>磁盘</span>
        <span>网络</span>
        <span>更新</span>
      </div>
      {runningProfiles.map((profile) => {
        const state = hosts[profile.id] ?? EMPTY_HOST;
        const sample = state.sample;
        const stale =
          state.status === "live" &&
          !!state.lastAt &&
          now - state.lastAt > Math.max(5000, interval * 2500);
        return (
          <div
            key={profile.id}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(140px, 1.4fr) 90px 70px 90px 90px 120px 80px",
              gap: 12,
              padding: "9px 14px",
              borderBottom: "1px solid hsl(var(--border) / 0.5)",
              alignItems: "center",
              fontSize: 12,
            }}
            title={state.error ?? ""}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile.name}</div>
              <div style={{ ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {profile.host}:{profile.port}
              </div>
            </div>
            <StatusBadge status={state.status} stale={stale} />
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatPercent(sample?.cpu)}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatPercent(memoryPercent(sample))}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatPercent(sample?.disk_percent)}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              ↓{formatRate(sample?.net_rx_speed)} ↑{formatRate(sample?.net_tx_speed)}
            </span>
            <span style={{ ...muted }}>{formatClock(state.lastAt)}</span>
          </div>
        );
      })}
      <div style={{ ...muted, padding: "8px 14px" }}>
        置灰项未采集：延迟（未实现 SSH 传输层 ping）· GPU（无 NVIDIA）· 磁盘 I/O（未做差分）· 进程（未读 top）
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 4px 10px 0",
          borderBottom: "1px solid hsl(var(--border) / 0.6)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginRight: 4 }}>监控</div>
        {!running && (
          <>
            <div style={{ position: "relative" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索主机、分组或地址"
                style={{
                  width: 200,
                  padding: "5px 8px 5px 26px",
                  borderRadius: 6,
                  border: "1px solid hsl(var(--border))",
                  background: "hsl(var(--input, var(--background)))",
                  color: "hsl(var(--foreground))",
                  fontSize: 12,
                }}
              />
              <span style={{ position: "absolute", left: 7, top: 5, opacity: 0.6 }}>
                <Icon name="search" size={13} />
              </span>
            </div>
            <span style={{ ...muted }}>已选 {selectedProfiles.length} 台主机</span>
          </>
        )}
        {running && (
          <span style={{ ...muted }}>
            {runningProfiles.length} 台监控中 · 每 {interval} 秒采样
          </span>
        )}
        <div style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 5, ...muted }}>
          更新频率
          <select
            value={interval}
            disabled={running}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--secondary))", color: "hsl(var(--foreground))", fontSize: 12 }}
          >
            {INTERVALS.map((value) => (
              <option key={value} value={value}>每 {value} 秒</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 5, ...muted }}>
          趋势范围
          <select
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
            style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--secondary))", color: "hsl(var(--foreground))", fontSize: 12 }}
          >
            {RANGES.map((value) => (
              <option key={value} value={value}>最近 {value} 分钟</option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", border: "1px solid hsl(var(--border))", borderRadius: 6, overflow: "hidden" }}>
          <button
            onClick={() => changeView("charts")}
            style={{ ...btn, border: "none", borderRadius: 0, background: view === "charts" ? "hsl(var(--primary) / 0.18)" : "transparent", color: view === "charts" ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}
            title="图表"
          >
            图表
          </button>
          <button
            onClick={() => changeView("list")}
            style={{ ...btn, border: "none", borderRadius: 0, background: view === "list" ? "hsl(var(--primary) / 0.18)" : "transparent", color: view === "list" ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}
            title="列表"
          >
            列表
          </button>
        </div>
        {!running ? (
          <button style={{ ...btn, borderColor: "hsl(var(--primary) / 0.6)", color: "hsl(var(--primary))" }} onClick={start} disabled={selectedProfiles.length === 0}>
            <Icon name="play" size={13} /> 开始监控
          </button>
        ) : (
          <button style={btn} onClick={stop}>
            <Icon name="square" size={12} /> 停止
          </button>
        )}
      </div>

      {movable.length === 0 ? (
        <div style={{ ...panelCard, marginTop: 14, textAlign: "center", padding: "36px 16px" }}>
          <Icon name="activity" size={26} />
          <div style={{ marginTop: 8, fontWeight: 600 }}>还没有可监控的主机</div>
          <div style={{ ...muted, marginTop: 4 }}>监控只对已保存的 SSH 主机生效；本地终端 / 串口 / Telnet 不支持采集。</div>
        </div>
      ) : !running ? (
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
          {filteredProfiles.map((profile) => {
            const checked = selected.has(profile.id);
            return (
              <button
                key={profile.id}
                onClick={() => toggleSelected(profile.id)}
                style={{
                  ...panelCard,
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor: checked ? "hsl(var(--primary) / 0.55)" : "hsl(var(--border))",
                  background: checked ? "hsl(var(--primary) / 0.06)" : "hsl(var(--card))",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 4,
                      border: "1px solid hsl(var(--border))",
                      background: checked ? "hsl(var(--primary))" : "transparent",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: "none",
                      color: "#fff",
                      fontSize: 10,
                    }}
                  >
                    {checked ? "✓" : ""}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile.name}</div>
                    <div style={{ ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile.host}:{profile.port}</div>
                  </div>
                </div>
              </button>
            );
          })}
          {filteredProfiles.length === 0 && (
            <div style={{ ...muted, padding: 12 }}>没有符合条件的主机</div>
          )}
          <div style={{ gridColumn: "1 / -1", ...muted, marginTop: 4, lineHeight: 1.7 }}>
            开始后会为每台主机建立独立 SSH 会话并每 {interval} 秒只读采样一次；连接失败会自动退避重试。
            <br />
            主机密钥确认仍需人工处理（监控页没有交互弹窗）；Netcatty 有而 termX 后端无数据的字段会置灰并写明原因。
          </div>
        </div>
      ) : view === "charts" ? (
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12, overflowY: "auto", paddingBottom: 12 }}>
          {runningProfiles.map(renderCard)}
        </div>
      ) : (
        <div style={{ marginTop: 12, overflowY: "auto", paddingBottom: 12 }}>{renderTable()}</div>
      )}
    </div>
  );
}
