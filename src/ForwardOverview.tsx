/**
 * Vault「端口转发」总览：按目标主机分组展示转发条目与规则，
 * 支持条目级 / 规则级启停与实时连接统计（2s 轮询 forward_active_list）。
 *
 * 对照 Netcatty components/PortForwardingNew.tsx；规则新建 / 编辑仍由终端
 * 侧栏的 ForwardPanel 承担，这里只做总览与运行态操作，避免两套编辑状态打架。
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
import { Icon } from "./ui/icons";

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--card)",
  marginBottom: 14,
  overflow: "hidden",
};

const buttonStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--secondary)",
  color: "var(--foreground)",
  padding: "3px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const smallBtn = (disabled: boolean): CSSProperties => ({
  ...buttonStyle,
  opacity: disabled ? 0.5 : 1,
  cursor: disabled ? "default" : "pointer",
});

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

export function ForwardOverview() {
  const [forwards, setForwards] = useState<api.Forward[]>([]);
  const [profiles, setProfiles] = useState<api.Profile[]>([]);
  const [active, setActive] = useState<api.ActiveForwardInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>端口转发</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
          按主机分组 · 规则级启停与实时统计
        </div>
        <div style={{ flex: 1 }} />
        <button
          style={smallBtn(busy !== null)}
          disabled={busy !== null}
          onClick={() => void refreshAll()}
        >
          刷新
        </button>
      </div>

      {error && (
        <div
          style={{
            border: "1px solid var(--destructive)",
            color: "var(--destructive)",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 12,
            margin: "8px 0",
          }}
        >
          {error}
        </div>
      )}

      {!loaded ? (
        <div style={{ color: "var(--muted-foreground)", fontSize: 13, padding: 24 }}>
          正在加载…
        </div>
      ) : groups.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--border)",
            borderRadius: 10,
            padding: "28px 24px",
            color: "var(--muted-foreground)",
            fontSize: 13,
            marginTop: 12,
          }}
        >
          还没有端口转发规则。在终端侧栏打开「端口转发」工具即可新建条目与规则；启动后会在这里按主机汇总显示。
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {groups.map((g) => (
            <section key={g.profileId} style={cardStyle}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--muted)",
                }}
              >
                <Icon name="server" size={14} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{g.profileName}</span>
                <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
                  {g.host ? `${g.host}:${g.port}` : "档案已删除"}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
                  {g.forwards.length} 条目
                  {g.activeCount > 0 ? ` · ${g.activeCount} 运行中` : ""}
                </span>
              </div>
              <div style={{ padding: "4px 14px 10px" }}>
                {g.forwards.map((f) => {
                  const info = activeFor(active, f.id);
                  const pending = busy === `f:${f.id}`;
                  return (
                    <div
                      key={f.id}
                      style={{
                        padding: "8px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: info ? "var(--primary)" : "var(--muted-foreground)",
                            flex: "0 0 auto",
                          }}
                          title={info ? "运行中" : "未运行"}
                        />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{f.name}</span>
                        {!info && f.rules.length > 0 && (
                          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
                            {f.rules.length} 条规则
                          </span>
                        )}
                        {info && (
                          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>
                            {forwardSummary(info)}
                          </span>
                        )}
                        <div style={{ flex: 1 }} />
                        <button
                          style={smallBtn(pending)}
                          disabled={pending}
                          onClick={() => toggleForward(f, info)}
                        >
                          {pending ? "处理中…" : info ? "停止" : "启动"}
                        </button>
                      </div>

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
                              color: "var(--muted-foreground)",
                            }}
                          >
                            <span style={{ color: "var(--foreground)" }}>{ruleLabel(rule)}</span>
                            {rs?.effective_port != null && rs.effective_port !== rule.local_port && (
                              <span>实际端口 {rs.effective_port}</span>
                            )}
                            {rs?.error && (
                              <span style={{ color: "var(--destructive)" }}>{rs.error}</span>
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
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "10px 14px",
          opacity: 0.6,
        }}
        title="Netcatty 对照：以下能力尚未移植"
      >
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>未移植能力（置灰）</div>
        {UNSUPPORTED.map((u) => (
          <div key={u.title} style={{ display: "flex", gap: 10, fontSize: 12, padding: "2px 0" }}>
            <span style={{ width: 96, color: "var(--muted-foreground)" }}>{u.title}</span>
            <span style={{ color: "var(--muted-foreground)" }}>{u.reason}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
