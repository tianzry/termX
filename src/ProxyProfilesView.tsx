/**
 * Vault「代理」页：代理库条目列表 + 新建 / 编辑 / 删除（对照 Netcatty
 * components/ProxyProfilesManager.tsx）。密码走 SecretStore，不落库。
 *
 * 未移植项在页面底部置灰列明原因，不做假按钮。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";

const cardStyle: CSSProperties = {
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  background: "hsl(var(--card))",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 220,
  cursor: "pointer",
};

const sectionTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  margin: "4px 0 8px",
};

const muted: CSSProperties = { color: "hsl(var(--muted-foreground))", fontSize: 12 };

const buttonStyle: CSSProperties = {
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "hsl(var(--secondary))",
  color: "hsl(var(--foreground))",
  padding: "5px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  ...buttonStyle,
  background: "hsl(var(--primary))",
  borderColor: "hsl(var(--primary))",
  color: "hsl(var(--primary-foreground))",
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

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "hsl(var(--muted-foreground))",
};

interface Draft {
  id: string;
  label: string;
  proxy_type: "http" | "socks5";
  host: string;
  port: string;
  username: string;
  no_proxy: string;
}

type FormState = { mode: "create"; draft: Draft } | { mode: "edit"; draft: Draft };

function newDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    label: "",
    proxy_type: "http",
    host: "",
    port: "8080",
    username: "",
    no_proxy: "",
  };
}

function draftFrom(p: api.ProxyProfile): Draft {
  return {
    id: p.id,
    label: p.label,
    proxy_type: p.proxy_type === "socks5" ? "socks5" : "http",
    host: p.host,
    port: String(p.port),
    username: p.username ?? "",
    no_proxy: p.no_proxy ?? "",
  };
}

function validate(d: Draft): string | null {
  if (!d.label.trim()) return "请填写名称";
  if (!d.host.trim()) return "请填写代理主机";
  const port = Number(d.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "代理端口需在 1–65535 之间";
  }
  if (d.no_proxy.trim() && d.host.trim().includes("/")) {
    return "代理主机不能包含路径";
  }
  return null;
}

export function ProxyProfilesView({
  profiles,
  onDataChanged,
}: {
  profiles: api.Profile[];
  onDataChanged: () => void;
}) {
  const [list, setList] = useState<api.ProxyProfile[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [password, setPassword] = useState("");
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<api.ProxyProfile | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await api.listProxyProfiles());
      setError("");
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usage = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of profiles) {
      const id = p.proxy_profile_id;
      if (id) map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.proxy_type.toLowerCase().includes(q),
    );
  }, [list, search]);

  function openCreate() {
    setPassword("");
    setHasSavedPassword(false);
    setError("");
    setForm({ mode: "create", draft: newDraft() });
  }

  function openEdit(p: api.ProxyProfile) {
    setPassword("");
    setError("");
    setForm({ mode: "edit", draft: draftFrom(p) });
    setHasSavedPassword(false);
    void api
      .getProxyProfilePassword(p.id)
      .then((s) => setHasSavedPassword(Boolean(s)))
      .catch(() => {});
  }

  function patch(patch: Partial<Draft>) {
    setForm((f) => (f ? { ...f, draft: { ...f.draft, ...patch } } : f));
  }

  async function submit() {
    if (!form) return;
    const msg = validate(form.draft);
    if (msg) {
      setError(msg);
      return;
    }
    const now = Date.now();
    const profile: api.ProxyProfile = {
      id: form.draft.id,
      label: form.draft.label.trim(),
      proxy_type: form.draft.proxy_type,
      host: form.draft.host.trim(),
      port: Number(form.draft.port),
      username: form.draft.username.trim() || null,
      no_proxy: form.draft.no_proxy.trim() || null,
      created_at: form.mode === "edit" ? (list.find((p) => p.id === form.draft.id)?.created_at ?? now) : now,
      updated_at: now,
      order: form.mode === "edit" ? (list.find((p) => p.id === form.draft.id)?.order ?? null) : null,
    };
    // null = 不动既有密码；空串 = 清除；有值 = 覆盖。
    const pwd = password ? password : hasSavedPassword ? null : "";
    setBusy(true);
    try {
      await api.saveProxyProfile(profile, pwd);
      setForm(null);
      setPassword("");
      await refresh();
      onDataChanged();
    } catch (e) {
      setError(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deleteProxyProfile(deleteTarget.id);
      setDeleteTarget(null);
      if (form?.draft.id === deleteTarget.id) setForm(null);
      await refresh();
      onDataChanged();
    } catch (e) {
      setError(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
          <button style={buttonStyle} onClick={openCreate}>
            + 新建代理
          </button>
          <div style={{ flex: 1 }} />
          <input
            style={{ ...inputStyle, width: 220 }}
            placeholder="搜索名称 / 主机 / 类型"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div style={sectionTitle}>已保存的代理（{filtered.length}）</div>

        {filtered.length === 0 ? (
          <div style={{ ...muted, padding: "32px 0", textAlign: "center" }}>
            暂无代理配置。新建一份后可在主机详情中复用。
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
            {filtered.map((p) => {
              const n = usage.get(p.id) ?? 0;
              return (
                <div key={p.id} style={cardStyle} onClick={() => openEdit(p)}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.label}
                    </span>
                    <span style={{ ...muted, marginLeft: "auto", flexShrink: 0 }}>
                      {p.proxy_type.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ ...muted, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.host}:{p.port}
                  </div>
                  <div style={muted}>
                    {n > 0 ? `被 ${n} 台主机使用` : "未被主机引用"}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 24, borderTop: "1px solid hsl(var(--border))", paddingTop: 12 }}>
          <div style={{ ...muted, fontWeight: 600, marginBottom: 6 }}>未移植能力（置灰，不做假按钮）</div>
          {[
            ["ProxyCommand 代理", "后端仅支持 HTTP / SOCKS5，未实现 command 类型。"],
            ["密钥串身份引用", "代理凭据只支持手填用户名密码，未接入钥匙串身份。"],
            ["分组级默认代理", "Group 表无 proxy 字段，仅支持主机级引用。"],
            ["拖拽手动排序", "已存 order_index，但 Vault 代理页暂未提供拖拽交互。"],
          ].map(([title, reason]) => (
            <div key={title} style={{ ...muted, opacity: 0.6, padding: "3px 0" }}>
              <strong style={{ color: "hsl(var(--foreground))" }}>{title}</strong>：{reason}
            </div>
          ))}
        </div>

        {error && !form && (
          <div style={{ color: "hsl(var(--destructive))", fontSize: 12, marginTop: 8 }}>{error}</div>
        )}
      </div>

      {form && (
        <div
          style={{
            width: 340,
            flexShrink: 0,
            border: "1px solid hsl(var(--border))",
            borderRadius: 10,
            background: "hsl(var(--card))",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {form.mode === "create" ? "新建代理" : "编辑代理"}
            </span>
            <button
              style={{ ...buttonStyle, marginLeft: "auto", padding: "2px 8px" }}
              onClick={() => setForm(null)}
            >
              关闭
            </button>
          </div>
          <label style={labelStyle}>
            名称
            <input style={inputStyle} value={form.draft.label} onChange={(e) => patch({ label: e.target.value })} placeholder="例如：公司代理" />
          </label>
          <label style={labelStyle}>
            类型
            <select
              style={inputStyle}
              value={form.draft.proxy_type}
              onChange={(e) => patch({ proxy_type: e.target.value as Draft["proxy_type"] })}
            >
              <option value="http">HTTP</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>
          <label style={labelStyle}>
            代理主机
            <input style={inputStyle} value={form.draft.host} onChange={(e) => patch({ host: e.target.value })} placeholder="127.0.0.1" />
          </label>
          <label style={labelStyle}>
            端口
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={65535}
              value={form.draft.port}
              onChange={(e) => patch({ port: e.target.value })}
              placeholder={form.draft.proxy_type === "http" ? "8080" : "1080"}
            />
          </label>
          <label style={labelStyle}>
            用户名（可选）
            <input style={inputStyle} value={form.draft.username} onChange={(e) => patch({ username: e.target.value })} />
          </label>
          <label style={labelStyle}>
            密码（可选）
            <input
              style={inputStyle}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasSavedPassword ? "已保存（留空保持不变）" : "保存在系统密钥库"}
            />
          </label>
          <label style={labelStyle}>
            不走代理（逗号分隔，可选）
            <input style={inputStyle} value={form.draft.no_proxy} onChange={(e) => patch({ no_proxy: e.target.value })} placeholder="localhost, 127.0.0.1" />
          </label>
          {error && <div style={{ color: "hsl(var(--destructive))", fontSize: 12 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {form.mode === "edit" && (
              <button
                style={{ ...buttonStyle, color: "hsl(var(--destructive))" }}
                disabled={busy}
                onClick={() =>
                  setDeleteTarget(list.find((p) => p.id === form.draft.id) ?? null)
                }
              >
                删除
              </button>
            )}
            <button style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={() => void submit()}>
              {busy ? "处理中…" : "保存"}
            </button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            style={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 10,
              padding: 18,
              width: 360,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>删除代理「{deleteTarget.label}」？</div>
            <div style={{ ...muted, marginBottom: 14 }}>
              引用它的 {usage.get(deleteTarget.id) ?? 0} 台主机会解除绑定并回退到内联代理配置（若有）。
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={buttonStyle} onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                style={{ ...buttonStyle, color: "hsl(var(--destructive))", borderColor: "hsl(var(--destructive))" }}
                disabled={busy}
                onClick={() => void remove()}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
