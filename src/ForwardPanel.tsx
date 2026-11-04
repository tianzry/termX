import { useEffect, useState } from "react";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";
import type { Forward, ForwardRule, ForwardStats } from "./backend/client";
import { ForwardForm, type ForwardDraft } from "./ForwardForm";
import { noteForwardStarted, noteForwardStopped } from "./forwardSupervisor";

interface ActiveInfo {
  activeId: string;
  stats: ForwardStats | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const RULE_TYPE_LABEL: Record<ForwardRule["type"], string> = {
  local: "本地 (local)",
  remote: "远程 (remote)",
  dynamic: "动态 SOCKS5 (dynamic)",
};

/** 端口转发侧栏：转发条目 CRUD + 三类型规则编辑 + start/stop/stats + 单规则启停。 */
export function ForwardPanel() {
  const [forwards, setForwards] = useState<Forward[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 表单状态由 ForwardForm 自持；非空 = 正在编辑该条目（保存走 updateForward）。
  const [editing, setEditing] = useState<Forward | null>(null);

  // 已启动的转发：forward.id -> 活跃 session + 最近一次统计
  const [active, setActive] = useState<Record<string, ActiveInfo>>({});

  async function refresh() {
    setBusy(true);
    setErr("");
    try {
      const [fs, ps, act] = await Promise.all([
        api.listForwards(),
        api.listProfiles(),
        api.forwardActiveList(),
      ]);
      setForwards(fs);
      setProfiles(ps);
      // 运行态以后端为权威：重新打开侧栏 / Vault 已启动的条目这里也能显示为运行中。
      setActive((prev) => {
        const next: Record<string, ActiveInfo> = {};
        for (const a of act) {
          next[a.forward_id] = {
            activeId: a.active_id,
            stats: prev[a.forward_id]?.stats ?? a.stats,
          };
        }
        return next;
      });
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // 有运行中条目时 2s 轮询统计（对齐 Netcatty 的运行态自动刷新），不打断 busy。
  const activeKey = Object.values(active)
    .map((a) => a.activeId)
    .join(",");
  useEffect(() => {
    if (!activeKey) return;
    let cancelled = false;
    const tick = async () => {
      const snap = Object.entries(active);
      for (const [fid, info] of snap) {
        try {
          const s = await api.forwardStats(info.activeId);
          if (cancelled) return;
          setActive((prev) =>
            prev[fid]?.activeId === info.activeId
              ? { ...prev, [fid]: { ...prev[fid], stats: s } }
              : prev,
          );
        } catch {
          /* 会话已断开时忽略，等待下一次 refresh */
        }
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  /** 表单校验已在 ForwardForm 内完成，这里只落库并刷新。 */
  async function submitDraft(draft: ForwardDraft) {
    setBusy(true);
    setErr("");
    try {
      if (editing) {
        await api.updateForward({
          id: editing.id,
          name: draft.name,
          profile_id: draft.profile_id,
          group_id: editing.group_id,
          rules: draft.rules,
          auto_start: draft.auto_start,
          auto_reconnect: draft.auto_reconnect,
        });
        setEditing(null);
      } else {
        await api.createForward({
          id: crypto.randomUUID(),
          name: draft.name,
          profile_id: draft.profile_id,
          group_id: null,
          rules: draft.rules,
          auto_start: draft.auto_start,
          auto_reconnect: draft.auto_reconnect,
        });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /** 编辑运行中的条目会与旧会话脱节，先要求停止（避免“改了不生效”的假象）。 */
  function beginEdit(f: Forward) {
    if (active[f.id]) {
      setErr("该转发正在运行，请先停止再编辑。");
      return;
    }
    setEditing(f);
    setErr("");
  }

  function cancelEdit() {
    setEditing(null);
    setErr("");
  }

  async function duplicate(f: Forward) {
    setBusy(true);
    setErr("");
    try {
      await api.createForward({
        id: crypto.randomUUID(),
        name: `${f.name} 副本`,
        profile_id: f.profile_id,
        group_id: f.group_id,
        rules: f.rules.map((r) => ({ ...r })),
        auto_start: f.auto_start ?? false,
        auto_reconnect: f.auto_reconnect ?? null,
      });
      await refresh();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: Forward) {
    setBusy(true);
    setErr("");
    try {
      const info = active[f.id];
      if (info) {
        try {
          noteForwardStopped(f.id);
          await api.forwardStop(info.activeId);
        } catch {
          /* 忽略 */
        }
      }
      await api.deleteForward(f.id);
      if (editing?.id === f.id) cancelEdit();
      setActive((a) => {
        const next = { ...a };
        delete next[f.id];
        return next;
      });
      await refresh();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function start(f: Forward) {
    setBusy(true);
    setErr("");
    try {
      noteForwardStarted(f.id);
      const activeId = await api.forwardStart(f.id);
      setActive((a) => ({ ...a, [f.id]: { activeId, stats: null } }));
      const s = await api.forwardStats(activeId);
      setActive((a) => ({ ...a, [f.id]: { activeId, stats: s } }));
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function stop(f: Forward) {
    const info = active[f.id];
    if (!info) return;
    setBusy(true);
    setErr("");
    try {
      noteForwardStopped(f.id);
      await api.forwardStop(info.activeId);
      setActive((a) => {
        const next = { ...a };
        delete next[f.id];
        return next;
      });
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function stats(f: Forward) {
    const info = active[f.id];
    if (!info) return;
    setBusy(true);
    setErr("");
    try {
      const s = await api.forwardStats(info.activeId);
      setActive((a) => ({ ...a, [f.id]: { ...info, stats: s } }));
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function ruleToggle(f: Forward, index: number, startRule: boolean) {
    const info = active[f.id];
    if (!info) return;
    setBusy(true);
    setErr("");
    try {
      if (startRule) await api.forwardRuleStart(info.activeId, index);
      else await api.forwardRuleStop(info.activeId, index);
      await stats(f);
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sftp-panel">
      <div className="sftp-toolbar">
        <button onClick={refresh} disabled={busy}>
          刷新
        </button>
      </div>

      {/* 新建 / 编辑转发 */}
      <ForwardForm
        key={editing?.id ?? "new"}
        profiles={profiles}
        initial={editing}
        title={editing ? "编辑转发" : "新建转发"}
        submitLabel={editing ? "保存修改" : "新建转发"}
        busy={busy}
        onSubmit={submitDraft}
        onCancel={cancelEdit}
      />

      {/* 已有转发列表：条目头 + 逐规则行（对齐 Netcatty RuleCard 的信息密度） */}
      <ul className="sftp-list">
        {forwards.map((f) => {
          const info = active[f.id];
          const fstats = info?.stats ?? null;
          const profileName =
            profiles.find((p) => p.id === f.profile_id)?.name ?? f.profile_id;
          return (
            <li key={f.id} className="fwd-item">
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flex: "0 0 auto",
                    background: info
                      ? "hsl(var(--primary))"
                      : "hsl(var(--muted-foreground))",
                  }}
                  title={info ? "运行中" : "未运行"}
                />
                <span className="fwd-name">{f.name}</span>
                <span className="sftp-meta">
                  {f.rules.length} 条规则 · {profileName}
                </span>
                <div style={{ flex: 1 }} />
                {!info ? (
                  <button onClick={() => start(f)} disabled={busy}>
                    启动
                  </button>
                ) : (
                  <button onClick={() => stop(f)} disabled={busy}>
                    停止
                  </button>
                )}
                <button
                  onClick={() => beginEdit(f)}
                  disabled={busy}
                  title={info ? "请先停止该转发再编辑" : "编辑名称、主机与规则"}
                >
                  编辑
                </button>
                <button onClick={() => duplicate(f)} disabled={busy} title="复制为新条目">
                  复制
                </button>
                <button onClick={() => remove(f)} disabled={busy}>
                  删除
                </button>
              </div>

              {fstats && (
                <div className="sftp-meta" style={{ marginTop: 4 }}>
                  总流量 {formatBytes(fstats.bytes_rx)} ↓ / {formatBytes(fstats.bytes_tx)} ↑ ·{" "}
                  {fstats.connections} 连接 · {fstats.connected ? "运行中" : "已断开"}
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  marginTop: 6,
                }}
              >
                {f.rules.map((r, index) => {
                  const rs = fstats?.rules.find((x) => x.index === index);
                  const status = rs?.status ?? (info ? "connecting" : "stopped");
                  const ruleActive = status === "active" || status === "starting";
                  const rulePending = busy;
                  return (
                    <div
                      key={index}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                        fontSize: 12,
                        color: "hsl(var(--muted-foreground))",
                      }}
                    >
                      <span className="fwd-tag" data-status={status}>
                        {status === "stopped" ? "未启动" : status}
                      </span>
                      <span style={{ color: "hsl(var(--foreground))", fontWeight: 500 }}>
                        {RULE_TYPE_LABEL[r.type]}
                      </span>
                      <span>
                        {r.type !== "dynamic"
                          ? `${r.local_port} → ${r.remote_host}:${r.remote_port}`
                          : `SOCKS5 绑本机 ${r.local_port}`}
                      </span>
                      {rs && (
                        <span>
                          {formatBytes(rs.bytes_rx)} ↓ / {formatBytes(rs.bytes_tx)} ↑ ·{" "}
                          {rs.connections} 连接
                        </span>
                      )}
                      {rs?.error && (
                        <span style={{ color: "hsl(var(--destructive))" }}>{rs.error}</span>
                      )}
                      {info && (
                        <>
                          <div style={{ flex: 1 }} />
                          <button
                            onClick={() => ruleToggle(f, index, !ruleActive)}
                            disabled={rulePending}
                            title={ruleActive ? "停止该规则" : "启动该规则"}
                          >
                            {ruleActive ? "停规则" : "启规则"}
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>

      {err && <div className="sftp-error">{err}</div>}
    </div>
  );
}