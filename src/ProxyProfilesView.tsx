/**
 * Vault「代理」页：代理库条目列表 + 新建 / 编辑 / 删除 / 拖拽排序
 * （对照 Netcatty components/ProxyProfilesManager.tsx）。密码走 SecretStore，
 * 不落库；支持钥匙串身份引用与 ProxyCommand。
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
  proxy_type: "http" | "socks5" | "command";
  host: string;
  port: string;
  username: string;
  no_proxy: string;
  identity_id: string;
  command: string;
}

type FormState = { mode: "create" | "edit"; draft: Draft };

function newDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    label: "",
    proxy_type: "http",
    host: "",
    port: "8080",
    username: "",
    no_proxy: "",
    identity_id: "",
    command: "",
  };
}

function draftFrom(p: api.ProxyProfile): Draft {
  return {
    id: p.id,
    label: p.label,
    proxy_type:
      p.proxy_type === "socks5"
        ? "socks5"
        : p.proxy_type === "command"
          ? "command"
          : "http",
    host: p.host,
    port: String(p.port),
    username: p.username ?? "",
    no_proxy: p.no_proxy ?? "",
    identity_id: p.identity_id ?? "",
    command: p.command ?? "",
  };
}

function validate(d: Draft, credentials: api.Credential[]): string | null {
  if (!d.label.trim()) return "请填写名称";
  if (d.proxy_type === "command") {
    return d.command.trim() ? null : "请填写 ProxyCommand 命令";
  }
  if (!d.host.trim()) return "请填写代理主机";
  const port = Number(d.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "代理端口需在 1–65535 之间";
  }
  if (d.no_proxy.trim() && d.host.trim().includes("/")) {
    return "代理主机不能包含路径";
  }
  if (d.identity_id && !credentials.some((c) => c.id === d.identity_id)) {
    return "选择的钥匙串身份不存在";
  }
  return null;
}

/** 拖动后按目标位置重排（源位于目标之前时目标下标需左移一位）。 */
function moveItem(
  items: api.ProxyProfile[],
  sourceId: string,
  targetId: string,
): api.ProxyProfile[] {
  const from = items.findIndex((p) => p.id === sourceId);
  const to = items.findIndex((p) => p.id === targetId);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function ProxyProfilesView({
  profiles,
  groups,
  credentials,
  onDataChanged,
}: {
  profiles: api.Profile[];
  groups: api.Group[];
  credentials: api.Credential[];
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
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  /** 主机引用计数（主机优先，分组默认是独立的一层引用）。 */
  const hostUsage = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of profiles) {
      const id = p.proxy_profile_id;
      if (id) map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  }, [profiles]);

  const groupUsage = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of groups) {
      const id = g.proxy_profile_id;
      if (id) map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  }, [groups]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.proxy_type.toLowerCase().includes(q) ||
        (p.command ?? "").toLowerCase().includes(q),
    );
  }, [list, search]);

  const canDrag = search.trim() === "";

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
    const msg = validate(form.draft, credentials);
    if (msg) {
      setError(msg);
      return;
    }
    const isCommand = form.draft.proxy_type === "command";
    const identityId = isCommand ? null : form.draft.identity_id || null;
    const now = Date.now();
    const profile: api.ProxyProfile = {
      id: form.draft.id,
      label: form.draft.label.trim(),
      proxy_type: form.draft.proxy_type,
      host: isCommand ? "" : form.draft.host.trim(),
      port: isCommand ? 0 : Number(form.draft.port),
      username:
        isCommand || identityId ? null : form.draft.username.trim() || null,
      no_proxy: isCommand ? null : form.draft.no_proxy.trim() || null,
      created_at:
        form.mode === "edit"
          ? list.find((p) => p.id === form.draft.id)?.created_at ?? now
          : now,
      updated_at: now,
      order:
        form.mode === "edit"
          ? list.find((p) => p.id === form.draft.id)?.order ?? null
          : null,
      identity_id: identityId,
      command: isCommand ? form.draft.command.trim() : null,
    };
    // null = 不动既有密码；空串 = 清除；有值 = 覆盖。身份/命令模式不写密码。
    const pwd = isCommand || identityId ? null : password ? password : hasSavedPassword ? null : "";
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

  /** 乐观重排：先本地更新，服务端失败时刷新回滚。 */
  async function dropOn(targetId: string) {
    const sourceId = dragId;
    setDragId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const next = moveItem(list, sourceId, targetId);
    if (next === list) return;
    setList(next);
    try {
      await api.reorderProxyProfiles(next.map((p) => p.id));
    } catch (e) {
      setError(userVisibleError(String(e)));
      await refresh();
    }
  }

  const identitySelected = Boolean(form?.draft.identity_id);
  const isCommand = form?.draft.proxy_type === "command";

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
              const hostN = hostUsage.get(p.id) ?? 0;
              const groupN = groupUsage.get(p.id) ?? 0;
              const dragged = dragId === p.id;
              const hovered = dragOverId === p.id && dragId !== p.id;
              return (
                <div
                  key={p.id}
                  style={{
                    ...cardStyle,
                    opacity: dragged ? 0.5 : 1,
                    outline: hovered ? "2px solid hsl(var(--primary))" : "none",
                    outlineOffset: 2,
                  }}
                  draggable={canDrag}
                  onDragStart={(e) => {
                    setDragId(p.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", p.id);
                  }}
                  onDragOver={(e) => {
                    if (!canDrag) return;
                    e.preventDefault();
                    if (dragId && dragId !== p.id) setDragOverId(p.id);
                  }}
                  onDragLeave={() =>
                    setDragOverId((cur) => (cur === p.id ? null : cur))
                  }
                  onDrop={(e) => {
                    if (!canDrag) return;
                    e.preventDefault();
                    void dropOn(p.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDragOverId(null);
                  }}
                  onClick={() => openEdit(p)}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.label}
                    </span>
                    <span style={{ ...muted, marginLeft: "auto", flexShrink: 0 }}>
                      {p.proxy_type.toUpperCase()}
                    </span>
                  </div>
                  {p.proxy_type === "command" ? (
                    <div style={{ ...muted, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      ProxyCommand · {p.command || "（未填写）"}
                    </div>
                  ) : (
                    <div style={{ ...muted, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.host}:{p.port}
                    </div>
                  )}
                  <div style={muted}>
                    {hostN + groupN > 0
                      ? `被 ${hostN} 台主机、${groupN} 个分组引用`
                      : "未被主机或分组引用"}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!canDrag && (
          <div style={{ ...muted, marginTop: 8 }}>
            清除搜索后可拖拽调整顺序。
          </div>
        )}

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
              <option value="command">ProxyCommand</option>
            </select>
          </label>
          {isCommand ? (
            <>
              <label style={labelStyle}>
                命令行
                <input
                  style={inputStyle}
                  value={form.draft.command}
                  onChange={(e) => patch({ command: e.target.value })}
                  placeholder="ssh -W %h:%p jumphost"
                />
              </label>
              <div style={muted}>
                支持 %h 目标主机、%p 目标端口、%% 字面 %，由本地 shell 启动。
              </div>
            </>
          ) : (
            <>
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
                钥匙串身份（可选）
                <select
                  style={inputStyle}
                  value={form.draft.identity_id}
                  onChange={(e) => patch({ identity_id: e.target.value, username: "" })}
                >
                  <option value="">手动填写</option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.username || "无用户名"}）
                    </option>
                  ))}
                </select>
              </label>
              {identitySelected ? (
                <div style={muted}>用户名与密码取自所选钥匙串身份。</div>
              ) : (
                <>
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
                </>
              )}
              <label style={labelStyle}>
                不走代理（逗号分隔，可选）
                <input style={inputStyle} value={form.draft.no_proxy} onChange={(e) => patch({ no_proxy: e.target.value })} placeholder="localhost, 127.0.0.1" />
              </label>
            </>
          )}
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
              引用它的 {hostUsage.get(deleteTarget.id) ?? 0} 台主机会解除绑定并回退到内联代理配置（若有）；{" "}
              {groupUsage.get(deleteTarget.id) ?? 0} 个分组会恢复为直连。
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
