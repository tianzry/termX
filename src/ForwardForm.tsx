/**
 * 端口转发条目表单（名称 / 目标主机 / 多规则），终端侧栏与 Vault 总览共用。
 *
 * 对照 Netcatty components/PortForwardingNew.tsx 的 NewFormPanel / EditPanel：
 * 表单自持字段状态，校验通过后交给调用方落库；成功创建后自动清空，
 * 编辑成功后由调用方切回新建态（key 变化会重建表单）。
 */

import { useEffect, useState, type CSSProperties } from "react";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";
import { sshProfiles, validateForwardDraft, type ForwardDraft } from "./domain/forwardDraft";
import type { Forward, ForwardRule } from "./backend/client";

export type { ForwardDraft } from "./domain/forwardDraft";

interface Props {
  profiles: api.Profile[];
  /** 非空 = 编辑既有条目，表单以它为初值。 */
  initial?: Forward | null;
  title: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (draft: ForwardDraft) => Promise<void>;
  onCancel: () => void;
}

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "hsl(var(--muted-foreground))",
};

const inputStyle: CSSProperties = {
  background: "hsl(var(--background))",
  color: "hsl(var(--foreground))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 13,
  width: "100%",
  minWidth: 0,
};

const btnStyle: CSSProperties = {
  background: "hsl(var(--secondary))",
  color: "hsl(var(--foreground))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const primaryBtnStyle: CSSProperties = {
  ...btnStyle,
  background: "hsl(var(--primary))",
  borderColor: "hsl(var(--primary))",
  color: "hsl(var(--primary-foreground))",
};

export function ForwardForm({
  profiles,
  initial,
  title,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: Props) {
  const candidates = sshProfiles(profiles);
  const [name, setName] = useState(initial?.name ?? "");
  const [profileId, setProfileId] = useState(
    initial?.profile_id ?? candidates[0]?.id ?? "",
  );
  const [rules, setRules] = useState<ForwardRule[]>(
    initial ? initial.rules.map((r) => ({ ...r })) : [],
  );
  const [autoStart, setAutoStart] = useState(initial?.auto_start ?? false);
  // 三态：null = 跟随 autoStart（对齐 Netcatty autoReconnect ?? autoStart）。
  const [autoReconnect, setAutoReconnect] = useState<boolean | null>(
    initial?.auto_reconnect ?? null,
  );
  const [err, setErr] = useState("");

  // 侧栏先于 listProfiles 渲染：档案晚到时自动补默认选中，避免空下拉。
  useEffect(() => {
    if (!initial && !profileId && candidates.length > 0) {
      setProfileId(candidates[0].id);
    }
  }, [initial, profileId, candidates]);

  function patchRule(index: number, patch: Partial<ForwardRule>) {
    setRules((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function submit() {
    const draft: ForwardDraft = {
      name: name.trim(),
      profile_id: profileId,
      rules,
      auto_start: autoStart,
      auto_reconnect: autoReconnect,
    };
    const message = validateForwardDraft(draft);
    if (message) {
      setErr(message);
      return;
    }
    setErr("");
    try {
      await onSubmit(draft);
      if (!initial) {
        setName("");
        setRules([]);
        setAutoStart(false);
        setAutoReconnect(null);
      }
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }

  return (
    <div
      style={{
        border: "1px solid hsl(var(--border))",
        borderRadius: 8,
        background: "hsl(var(--card))",
        marginBottom: 14,
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid hsl(var(--border))",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 10 }}>
          <label style={{ ...labelStyle, flex: 1 }}>
            名称
            <input
              style={inputStyle}
              placeholder="例如：数据库跳板"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label style={{ ...labelStyle, flex: 1.6 }}>
            SSH 会话档案
            <select
              style={inputStyle}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">选择 SSH 会话档案…</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.host}:{p.port}）
                </option>
              ))}
            </select>
          </label>
        </div>

        {rules.map((r, i) => (
          <div
            key={i}
            style={{
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
              <label style={{ ...labelStyle, flex: 1 }}>
                类型
                <select
                  style={inputStyle}
                  value={r.type}
                  onChange={(e) =>
                    patchRule(i, { type: e.target.value as ForwardRule["type"] })
                  }
                >
                  <option value="local">本地 (local)</option>
                  <option value="remote">远程 (remote)</option>
                  <option value="dynamic">动态 SOCKS5 (dynamic)</option>
                </select>
              </label>
              <label style={{ ...labelStyle, flex: 1 }}>
                本地端口
                <input
                  style={inputStyle}
                  type="number"
                  placeholder="0 = 自动分配"
                  value={r.local_port || ""}
                  onChange={(e) =>
                    patchRule(i, { local_port: Number(e.target.value) || 0 })
                  }
                />
              </label>
              {r.type !== "dynamic" && (
                <>
                  <label style={{ ...labelStyle, flex: 1.4 }}>
                    远端主机
                    <input
                      style={inputStyle}
                      placeholder="127.0.0.1"
                      value={r.remote_host}
                      onChange={(e) => patchRule(i, { remote_host: e.target.value })}
                    />
                  </label>
                  <label style={{ ...labelStyle, flex: 1 }}>
                    远端端口
                    <input
                      style={inputStyle}
                      type="number"
                      placeholder="22"
                      value={r.remote_port || ""}
                      onChange={(e) =>
                        patchRule(i, { remote_port: Number(e.target.value) || 0 })
                      }
                    />
                  </label>
                </>
              )}
              <button
                style={btnStyle}
                onClick={() => setRules((rs) => rs.filter((_, idx) => idx !== i))}
                title="移除这条规则"
              >
                删除
              </button>
            </div>
            <label style={{ ...labelStyle, maxWidth: 320 }}>
              监听地址
              <input
                style={inputStyle}
                placeholder={
                  r.type === "remote"
                    ? "默认：由 sshd 决定（127.0.0.1）"
                    : "默认：仅本机 127.0.0.1"
                }
                value={r.bind_address ?? ""}
                onChange={(e) => patchRule(i, { bind_address: e.target.value })}
              />
            </label>
          </div>
        ))}

        {err && (
          <div
            style={{
              border: "1px solid hsl(var(--destructive))",
              color: "hsl(var(--destructive))",
              borderRadius: 6,
              padding: "5px 9px",
              fontSize: 12,
            }}
          >
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
            />
            启动时自动运行
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoReconnect ?? autoStart}
              onChange={(e) => setAutoReconnect(e.target.checked)}
              title="断开后自动重连（最多 5 次）；默认跟随“启动时自动运行”"
            />
            断线自动重连
          </label>
          {autoReconnect === null && (
            <span style={{ color: "hsl(var(--muted-foreground))" }}>
              未设置：跟随自动运行
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            style={btnStyle}
            disabled={busy}
            onClick={() =>
              setRules((rs) => [
                ...rs,
                {
                  type: "local",
                  local_port: 0,
                  remote_host: "127.0.0.1",
                  remote_port: 22,
                  bind_address: "",
                },
              ])
            }
          >
            添加规则
          </button>
          <div style={{ flex: 1 }} />
          <button style={btnStyle} disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            style={{ ...primaryBtnStyle, opacity: busy ? 0.6 : 1 }}
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "处理中…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
