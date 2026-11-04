import { useEffect, useState } from "react";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";
import type { Forward, ForwardRule, ForwardStats } from "./backend/client";
import { ForwardForm, type ForwardDraft } from "./ForwardForm";

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
        });
        setEditing(null);
      } else {
        await api.createForward({
          id: crypto.randomUUID(),
          name: draft.name,
          profile_id: draft.profile_id,
          group_id: null,
          rules: draft.rules,
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
      const activeId = await api.forwardStart(f.id);
      setActive((a) => ({ ...a, [f.id]: { activeId, stats: null } }));
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