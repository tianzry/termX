import { useEffect, useState } from "react";
import * as api from "./backend/client";
import type { Forward, ForwardRule, ForwardStats } from "./backend/client";

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

  // 新建表单
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [rules, setRules] = useState<ForwardRule[]>([]);

  // 已启动的转发：forward.id -> 活跃 session + 最近一次统计
  const [active, setActive] = useState<Record<string, ActiveInfo>>({});

  async function refresh() {
    setBusy(true);
    setErr("");
    try {
      const [fs, ps] = await Promise.all([api.listForwards(), api.listProfiles()]);
      setForwards(fs);
      setProfiles(ps);
      setProfileId((cur) => cur || ps[0]?.id || "");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function addRule() {
    setRules((r) => [
      ...r,
      { type: "local", local_port: 0, remote_host: "127.0.0.1", remote_port: 0 },
    ]);
  }

  function updateRule(index: number, patch: Partial<ForwardRule>) {
    setRules((r) => r.map((x, i) => (i === index ? { ...x, ...patch } : x)));
  }

  function removeRule(index: number) {
    setRules((r) => r.filter((_, i) => i !== index));
  }

  async function create() {
    if (!name.trim()) return setErr("请填写转发名称");
    if (!profileId) return setErr("请选择 SSH 会话档案（profile）");
    if (!rules.length) return setErr("请至少添加一条转发规则");
    setBusy(true);
    setErr("");
    try {
      await api.createForward({
        id: crypto.randomUUID(),
        name: name.trim(),
        profile_id: profileId,
        group_id: null,
        rules,
      });
      setName("");
      setRules([]);
      await refresh();
    } catch (e) {
      setErr(String(e));
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
          await api.forwardStop(info.activeId);
        } catch {
          /* 忽略 */
        }
      }
      await api.deleteForward(f.id);
      setActive((a) => {
        const next = { ...a };
        delete next[f.id];
        return next;
      });
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function start(f: Forward) {
    setBusy(true);
    setErr("");
    try {
      const activeId = await api.forwardStart(f.id);
      setActive((a) => ({ ...a, [f.id]: { activeId, stats: null } }));
    } catch (e) {
      setErr(String(e));
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
      await api.forwardStop(info.activeId);
      setActive((a) => {
        const next = { ...a };
        delete next[f.id];
        return next;
      });
    } catch (e) {
      setErr(String(e));
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
      setErr(String(e));
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
      setErr(String(e));
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

      {/* 新建转发 */}
      <div className="fwd-form">
        <input
          placeholder="转发名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
        >
          <option value="">选择 SSH 会话档案…</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.host}:{p.port}）
            </option>
          ))}
        </select>
        <div className="fwd-rules">
          {rules.map((r, i) => (
            <div className="fwd-rule" key={i}>
              <div className="fwd-rule-row">
                <select
                  className="fwd-select"
                  value={r.type}
                  onChange={(e) =>
                    updateRule(i, { type: e.target.value as ForwardRule["type"] })
                  }
                >
                  <option value="local">本地 (local)</option>
                  <option value="remote">远程 (remote)</option>
                  <option value="dynamic">动态 SOCKS5 (dynamic)</option>
                </select>
                <button onClick={() => removeRule(i)}>删除</button>
              </div>
              <div className="fwd-rule-row">
                <input
                  type="number"
                  placeholder="本地端口"
                  value={r.local_port || ""}
                  onChange={(e) =>
                    updateRule(i, { local_port: Number(e.target.value) || 0 })
                  }
                />
                {r.type !== "dynamic" && (
                  <>
                    <input
                      placeholder="远端主机"
                      value={r.remote_host}
                      onChange={(e) =>
                        updateRule(i, { remote_host: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      placeholder="远端端口"
                      value={r.remote_port || ""}
                      onChange={(e) =>
                        updateRule(i, { remote_port: Number(e.target.value) || 0 })
                      }
                    />
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="sftp-row">
          <button onClick={addRule}>添加规则</button>
          <button onClick={create} disabled={busy || !name.trim() || !rules.length}>
            新建转发
          </button>
        </div>
      </div>

      {/* 已有转发列表 */}
      <ul className="sftp-list">
        {forwards.map((f) => {
          const info = active[f.id];
          const fstats = info?.stats ?? null;
          return (
            <li key={f.id} className="fwd-item">
              <div className="fwd-name">{f.name}</div>
              <div className="sftp-meta">
                {f.rules.length} 条规则 · {profiles.find((p) => p.id === f.profile_id)?.name ?? f.profile_id}
              </div>
              <div className="fwd-actions">
                {!info ? (
                  <button onClick={() => start(f)} disabled={busy}>
                    启动
                  </button>
                ) : (
                  <>
                    <button onClick={() => stop(f)} disabled={busy}>
                      停止
                    </button>
                    <button onClick={() => stats(f)} disabled={busy}>
                      统计
                    </button>
                  </>
                )}
                <button onClick={() => remove(f)} disabled={busy}>
                  删除
                </button>
              </div>
              {fstats && (
                <div className="fwd-stats">
                  <div>
                    总流量 {formatBytes(fstats.bytes_rx)} ↓ /{" "}
                    {formatBytes(fstats.bytes_tx)} ↑ · {fstats.connections}{" "}
                    连接 · {fstats.connected ? "运行中" : "已断开"}
                  </div>
                  {fstats.rules.map((r) => (
                    <div key={r.index} className="fwd-rule-stat">
                      <span>
                        [{r.index}] {RULE_TYPE_LABEL[r.rule.type]}{" "}
                        {r.rule.type !== "dynamic"
                          ? `${r.rule.local_port} → ${r.rule.remote_host}:${r.rule.remote_port}`
                          : `绑本机 ${r.rule.local_port}`}
                      </span>
                      <span className="fwd-tag" data-status={r.status}>
                        {r.status}
                      </span>
                      <div className="sftp-meta">
                        {formatBytes(r.bytes_rx)} ↓ / {formatBytes(r.bytes_tx)} ↑ ·{" "}
                        {r.connections} 连接
                        {r.error ? ` · ${r.error}` : ""}
                      </div>
                      {fstats.connected && (
                        <div className="fwd-rule-actions">
                          <button
                            onClick={() => ruleToggle(f, r.index, true)}
                            disabled={busy || r.status === "active"}
                          >
                            启动规则
                          </button>
                          <button
                            onClick={() => ruleToggle(f, r.index, false)}
                            disabled={busy || r.status === "stopped"}
                          >
                            停止规则
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {err && <div className="sftp-error">{err}</div>}
    </div>
  );
}