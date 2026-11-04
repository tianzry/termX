/**
 * Vault「端口转发」总览：按目标主机分组展示转发条目与规则，
 * 支持条目级 / 规则级启停、实时连接统计（2s 轮询 forward_active_list）
 * 以及条目新建 / 编辑 / 复制 / 删除（对照 Netcatty components/PortForwardingNew.tsx）。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";
import {
  activeFor,
  forwardSummary,
  groupForwardsByHost,
  ruleLabel,
} from "./domain/forwardOverview";
import { ForwardForm, type ForwardDraft } from "./ForwardForm";
import { Icon } from "./ui/icons";

const cardStyle: CSSProperties = {
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  background: "hsl(var(--card))",
  marginBottom: 14,
  overflow: "hidden",
};

const buttonStyle: CSSProperties = {
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "hsl(var(--secondary))",
  color: "hsl(var(--foreground))",
  padding: "3px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const smallBtn = (disabled: boolean): CSSProperties => ({
  ...buttonStyle,
  opacity: disabled ? 0.5 : 1,
  cursor: disabled ? "default" : "pointer",
});

const mutedText: CSSProperties = {
  color: "hsl(var(--muted-foreground))",
  fontSize: 12,
};

/** Netcatty 有、termX 尚未具备的能力：置灰并写明原因，不做假按钮。 */
const UNSUPPORTED = [
  {
    title: "自动启动",
    reason: "后端 ForwardRule 无 auto_start 字段，当前只能手动启动。",
  },
  {
    title: "断线重连",
    reason: "无 auto_reconnect 字段；SSH 断开后需重新启动转发。",
  },
  {
    title: "自定义监听地址",
    reason: "本地监听固定 127.0.0.1（后端无 bind_address 字段）。",
  },
  {
    title: "托盘快捷开关",
    reason: "termX 未创建系统托盘（lib.rs 无 TrayIcon），无法提供托盘菜单。",
  },
];

/** 打开的表单：新建或编辑既有条目。 */
type FormState = { mode: "create" } | { mode: "edit"; forward: api.Forward };

export function ForwardOverview() {
  const [forwards, setForwards] = useState<api.Forward[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [active, setActive] = useState<api.ActiveForwardInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<api.Forward | null>(null);
  const [search, setSearch] = useState("");
  const [bulk, setBulk] = useState<"start" | "stop" | null>(null);

  const refreshActive = useCallback(async () => {
    try {
      setActive(await api.forwardActiveList());
    } catch {
      // 轮询失败静默（例如窗口切换瞬间），下一轮会恢复。
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [fs, ps, act] = await Promise.all([
        api.listForwards(),
        api.listProfiles(),
        api.forwardActiveList(),
      ]);
      setForwards(fs);
      setProfiles(ps);
      setActive(act);
      setError(null);
    } catch (e) {
      setError(userVisibleError(String(e)));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => void refreshActive(), 2000);
    return () => clearInterval(timer);
  }, [refreshAll, refreshActive]);

  const groups = useMemo(
    () => groupForwardsByHost(forwards, profiles, active),
    [forwards, profiles, active],
  );

  const query = search.trim().toLowerCase();
  // 搜索命中：条目名 / 规则文本 / 主机名或地址；命中主机则整组保留。
  const filteredGroups = useMemo(() => {
    if (!query) return groups;
    return groups
      .filter((g) => {
        const groupHit =
          g.profileName.toLowerCase().includes(query) ||
          (g.host ?? "").toLowerCase().includes(query);
        if (groupHit) return true;
        return g.forwards.some(
          (f) =>
            f.name.toLowerCase().includes(query) ||
            f.rules.some((r) => ruleLabel(r).toLowerCase().includes(query)),
        );
      })
      .map((g) => ({
        ...g,
        forwards: g.forwards.filter(
          (f) =>
            g.profileName.toLowerCase().includes(query) ||
            (g.host ?? "").toLowerCase().includes(query) ||
            f.name.toLowerCase().includes(query) ||
            f.rules.some((r) => ruleLabel(r).toLowerCase().includes(query)),
        ),
      }));
  }, [groups, query]);

  const totals = useMemo(() => {
    let rules = 0;
    let runningRules = 0;
    for (const f of forwards) rules += f.rules.length;
    for (const info of active) {
      runningRules += info.stats.rules.filter(
        (r) => r.status === "active" || r.status === "starting",
      ).length;
    }
    return { rules, runningRules };
  }, [forwards, active]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await refreshAll();
      setError(null);
    } catch (e) {
      setError(userVisibleError(String(e)));
    } finally {
      setBusy(null);
    }
  };

  const toggleForward = (f: api.Forward, info: api.ActiveForwardInfo | undefined) => {
    if (info) return run(`f:${f.id}`, () => api.forwardStop(info.active_id));
    return run(`f:${f.id}`, () => api.forwardStart(f.id));
  };

  const toggleRule = (
    info: api.ActiveForwardInfo,
    index: number,
    activeRule: boolean,
  ) =>
    run(`r:${info.active_id}:${index}`, () =>
      activeRule
        ? api.forwardRuleStop(info.active_id, index)
        : api.forwardRuleStart(info.active_id, index),
    );

  /** 表单落库；校验与错误提示由 ForwardForm 负责（失败时抛回让它展示）。 */
  const submitForm = async (draft: ForwardDraft) => {
    setBusy("form");
    try {
      if (form?.mode === "edit") {
        const target = form.forward;
        await api.updateForward({
          id: target.id,
          name: draft.name,
          profile_id: draft.profile_id,
          group_id: target.group_id,
          rules: draft.rules,
        });
      } else {
        await api.createForward({
          id: crypto.randomUUID(),
          name: draft.name,
          profile_id: draft.profile_id,
          group_id: null,
          rules: draft.rules,
        });
      }
      setForm(null);
      await refreshAll();
    } finally {
      setBusy(null);
    }
  };

  const duplicate = (f: api.Forward) =>
    run(`dup:${f.id}`, () =>
      api.createForward({
        id: crypto.randomUUID(),
        name: `${f.name} 副本`,
        profile_id: f.profile_id,
        group_id: f.group_id,
        rules: f.rules.map((r) => ({ ...r })),
      }),
    );

  /** 全部启动：逐条启动未运行条目（失败逐条收集，成功后统一刷新）。 */
  const startAll = async () => {
    setBulk("start");
    const failures: string[] = [];
    try {
      for (const f of forwards) {
        if (activeFor(active, f.id)) continue;
        try {
          await api.forwardStart(f.id);
        } catch (e) {
          failures.push(`${f.name}：${userVisibleError(String(e))}`);
        }
      }
      await refreshAll();
      setError(failures.length ? failures.join("；") : null);
    } finally {
      setBulk(null);
    }
  };

  /** 全部停止：结束所有运行中会话（已断开的忽略）。 */
  const stopAll = async () => {
    setBulk("stop");
    const failures: string[] = [];
    try {
      for (const info of active) {
        try {
          await api.forwardStop(info.active_id);
        } catch (e) {
          failures.push(userVisibleError(String(e)));
        }
      }
      await refreshAll();
      setError(failures.length ? failures.join("；") : null);
    } finally {
      setBulk(null);
    }
  };

  /** 删除运行中的条目先停会话，避免后端留下无主 listener。 */
  const confirmDelete = async () => {
    const f = deleteTarget;
    if (!f) return;
    setDeleteTarget(null);
    await run(`del:${f.id}`, async () => {
      const info = activeFor(active, f.id);
      if (info) {
        try {
          await api.forwardStop(info.active_id);
        } catch {
          /* 已断开时忽略 */
        }
      }
      await api.deleteForward(f.id);
    });
    if (form?.mode === "edit" && form.forward.id === f.id) setForm(null);
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>端口转发</div>
        <div style={mutedText}>
          {forwards.length} 条目 · {totals.rules} 规则
          {totals.runningRules > 0 ? ` · ${totals.runningRules} 运行中` : ""}
        </div>
        <div style={{ flex: 1 }} />
        <input
          style={{
            background: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 12,
            width: 200,
          }}
          placeholder="搜索名称 / 主机 / 规则"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          style={smallBtn(bulk !== null || forwards.length === 0)}
          disabled={bulk !== null || forwards.length === 0}
          title="启动所有未运行条目"
          onClick={() => void startAll()}
        >
          {bulk === "start" ? "启动中…" : "全部启动"}
        </button>
        <button
          style={smallBtn(bulk !== null || active.length === 0)}
          disabled={bulk !== null || active.length === 0}
          title="停止所有运行中条目"
          onClick={() => void stopAll()}
        >
          {bulk === "stop" ? "停止中…" : "全部停止"}
        </button>
        <button
          style={smallBtn(busy !== null)}
          disabled={busy !== null}
          onClick={() => void refreshAll()}
        >
          刷新
        </button>
        <button
          style={smallBtn(busy !== null)}
          disabled={busy !== null}
          onClick={() => setForm({ mode: "create" })}
        >
          新建转发
        </button>
      </div>

      {error && (
        <div
          style={{
            border: "1px solid hsl(var(--destructive))",
            color: "hsl(var(--destructive))",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            margin: "8px 0",
          }}
        >
          {error}
        </div>
      )}

      {form && (
        <div style={{ marginTop: 12 }}>
          <ForwardForm
            key={form.mode === "edit" ? form.forward.id : "new"}
            profiles={profiles}
            initial={form.mode === "edit" ? form.forward : null}
            title={form.mode === "edit" ? "编辑转发" : "新建转发"}
            submitLabel={form.mode === "edit" ? "保存修改" : "新建转发"}
            busy={busy !== null}
            onSubmit={submitForm}
            onCancel={() => setForm(null)}
          />
        </div>
      )}

      {!loaded ? (
        <div style={{ ...mutedText, fontSize: 13, padding: 24 }}>正在加载…</div>
      ) : filteredGroups.length === 0 ? (
        <div
          style={{
            border: "1px dashed hsl(var(--border))",
            borderRadius: 10,
            padding: "28px 24px",
            color: "hsl(var(--muted-foreground))",
            fontSize: 13,
            marginTop: 12,
          }}
        >
          {query
            ? `没有匹配「${search.trim()}」的转发条目或规则。`
            : "还没有端口转发规则。点击右上角「新建转发」选择目标主机并添加规则；启动后会在这里按主机汇总显示。"}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {filteredGroups.map((g) => (
            <section key={g.profileId} style={cardStyle}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px",
                  borderBottom: "1px solid hsl(var(--border))",
                  background: "hsl(var(--muted))",
                }}
              >
                <Icon name="server" size={14} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{g.profileName}</span>
                <span style={mutedText}>
                  {g.host ? `${g.host}:${g.port}` : "档案已删除"}
                </span>
                <div style={{ flex: 1 }} />
                <span style={mutedText}>
                  {g.forwards.length} 条目
                  {g.activeCount > 0 ? ` · ${g.activeCount} 运行中` : ""}
                </span>
              </div>
              <div style={{ padding: "4px 14px 10px" }}>
                {g.forwards.map((f) => {
                  const info = activeFor(active, f.id);
                  const pending =
                    busy === `f:${f.id}` ||
                    busy === `dup:${f.id}` ||
                    busy === `del:${f.id}`;
                  return (
                    <div
                      key={f.id}
                      style={{
                        padding: "8px 0",
                        borderBottom: "1px solid hsl(var(--border))",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: info
                              ? "hsl(var(--primary))"
                              : "hsl(var(--muted-foreground))",
                            flex: "0 0 auto",
                          }}
                          title={info ? "运行中" : "未运行"}
                        />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{f.name}</span>
                        {!info && f.rules.length > 0 && (
                          <span style={mutedText}>{f.rules.length} 条规则</span>
                        )}
                        {info && <span style={mutedText}>{forwardSummary(info)}</span>}
                        <div style={{ flex: 1 }} />
                        <button
                          style={smallBtn(pending)}
                          disabled={pending}
                          onClick={() => toggleForward(f, info)}
                        >
                          {pending ? "处理中…" : info ? "停止" : "启动"}
                        </button>
                        <button
                          style={smallBtn(pending || !!info)}
                          disabled={pending || !!info}
                          title={
                            info ? "运行中无法编辑，请先停止该转发" : "编辑名称、主机与规则"
                          }
                          onClick={() => setForm({ mode: "edit", forward: f })}
                        >
                          编辑
                        </button>
                        <button
                          style={smallBtn(pending)}
                          disabled={pending}
                          title="复制为新条目"
                          onClick={() => void duplicate(f)}
                        >
                          复制
                        </button>
                        <button
                          style={smallBtn(pending)}
                          disabled={pending}
                          onClick={() => setDeleteTarget(f)}
                        >
                          删除
                        </button>
                      </div>
                      {info && (
                        <div style={{ ...mutedText, marginLeft: 15, marginTop: 4 }}>
                          运行中 · 停止后可编辑
                        </div>
                      )}

                      {f.rules.map((rule, index) => {
                        const rs = info?.stats.rules.find((r) => r.index === index);
                        const activeRule = rs?.status === "active" || rs?.status === "starting";
                        const rulePending = busy === `r:${info?.active_id}:${index}`;
                        return (
                          <div
                            key={index}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              marginLeft: 15,
                              marginTop: 5,
                              fontSize: 12,
                              color: "hsl(var(--muted-foreground))",
                            }}
                          >
                            <span style={{ color: "hsl(var(--foreground))" }}>
                              {ruleLabel(rule)}
                            </span>
                            {rs?.effective_port != null && rs.effective_port !== rule.local_port && (
                              <span>实际端口 {rs.effective_port}</span>
                            )}
                            {rs?.error && (
                              <span style={{ color: "hsl(var(--destructive))" }}>{rs.error}</span>
                            )}
                            {rs && (
                              <span>
                                {rs.status}
                                {rs.connections > 0 ? ` · ${rs.connections} 连接` : ""}
                              </span>
                            )}
                            {info && (
                              <>
                                <div style={{ flex: 1 }} />
                                <button
                                  style={smallBtn(rulePending)}
                                  disabled={rulePending}
                                  onClick={() => toggleRule(info, index, activeRule)}
                                >
                                  {activeRule ? "停规则" : "启规则"}
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <section
        style={{
          marginTop: 18,
          border: "1px solid hsl(var(--border))",
          borderRadius: 10,
          padding: "10px 14px",
          opacity: 0.6,
        }}
        title="Netcatty 对照：以下能力尚未移植"
      >
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>未移植能力（置灰）</div>
        {UNSUPPORTED.map((u) => (
          <div key={u.title} style={{ display: "flex", gap: 10, fontSize: 12, padding: "2px 0" }}>
            <span style={{ width: 96, color: "hsl(var(--muted-foreground))" }}>{u.title}</span>
            <span style={{ color: "hsl(var(--muted-foreground))" }}>{u.reason}</span>
          </div>
        ))}
      </section>

      {deleteTarget && (
        <div className="modal-mask" onMouseDown={() => setDeleteTarget(null)}>
          <div
            className="modal kh-delete-modal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="kh-delete-title">
              <Icon name="alert-triangle" size={18} />
              删除转发“{deleteTarget.name}”？
            </h3>
            <p className="kh-delete-desc">
              {deleteTarget.rules.length} 条规则将被删除
              {activeFor(active, deleteTarget.id) ? "，正在运行的会话会先停止" : ""}
              。不可恢复。
            </p>
            <div className="modal-actions">
              <button onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="danger" onClick={() => void confirmDelete()}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
