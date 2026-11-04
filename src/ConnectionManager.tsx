import { useEffect, useRef, useState } from "react";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";
import {
  EMPTY_PROXY_DRAFT,
  proxyDraftError,
  proxyDraftFromProfile,
  proxyPasswordToSave,
  proxyProfileFields,
  type ProxyDraft,
} from "./domain/proxyForm";
import type {
  Credential,
  CredentialType,
  Group,
  Profile,
} from "./backend/client";

type Tab = "profiles" | "creds" | "groups";

interface Props {
  /** 当前档案列表（由 App 持有，便于空闲页快速连接）。 */
  profiles: Profile[];
  /** 打开时直接进入某个档案的编辑表单。 */
  editProfileId?: string | null;
  /** 快速连接预填：只预填 name / host / port，凭据仍需选择。 */
  prefill?: { name: string; host: string; port: number } | null;
  onClose: () => void;
  onConnect: (p: Profile) => void;
  /** 档案 / 凭据 / 分组任一变更后触发，让 App 重新拉列表。 */
  onChanged: () => void;
}

type ProfDraft = {
  id: string;
  name: string;
  host: string;
  port: string;
  credential_id: string;
  group_id: string;
  init_command: string;
  bastion_profile_id: string;
  /** 转发本机 SSH Agent 到远端。 */
  agent_forwarding: boolean;
  /** 输入兼容模式：null = 老数据（SSH 视为开启）；新主机默认 false。 */
  ssh_input_compatibility: boolean | null;
  /** 编辑时原样带回，避免 update 把自定义算法重置为默认。 */
  algorithms?: api.SshAlgorithms;
  /** 主机级连接代理（密码单独落 SecretStore）。 */
  proxy: ProxyDraft;
  /** 引用代理库条目；非空时以库配置为准。 */
  proxy_profile_id: string;
};

type CredDraft = {
  id: string;
  name: string;
  username: string;
  type: CredentialType;
  secret: string;
  save_to_remote: boolean;
};

type GroupDraft = {
  id: string;
  name: string;
  color: string;
  sort_order: string;
  terminal_waves_enabled: boolean;
};

const CRED_LABEL: Record<CredentialType, string> = {
  password: "密码",
  key: "私钥",
  interactive: "键盘交互",
  agent: "SSH Agent",
  none: "无",
};

function newId(): string {
  // 与 workspaceModel.newId 一致：非安全上下文（http 调试）没有 randomUUID。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyProfile(): ProfDraft {
  return {
    id: newId(),
    name: "",
    host: "",
    port: "22",
    credential_id: "",
    group_id: "",
    init_command: "",
    bastion_profile_id: "",
    agent_forwarding: false,
    ssh_input_compatibility: false,
    proxy: { ...EMPTY_PROXY_DRAFT },
    proxy_profile_id: "",
  };
}

function emptyCred(): CredDraft {
  return {
    id: newId(),
    name: "",
    username: "",
    type: "password",
    secret: "",
    save_to_remote: false,
  };
}

function emptyGroup(): GroupDraft {
  return {
    id: newId(),
    name: "",
    color: "#58a6ff",
    sort_order: "0",
    terminal_waves_enabled: false,
  };
}

/** 连接管理器：档案 / 凭据 / 分组三合一面板，替代原来的「每次连接临时建档」。 */
export function ConnectionManager({
  profiles,
  editProfileId,
  prefill,
  onClose,
  onConnect,
  onChanged,
}: Props) {
  const [tab, setTab] = useState<Tab>("profiles");
  const [creds, setCreds] = useState<Credential[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 本地终端主机由 Vault / LocalShellPanel 管理；CM 只列 SSH 连接，
  // 避免 local 档案进 SSH 表单后被「凭据必填」卡死。
  const sshProfiles = profiles.filter((p) => p.protocol !== "local");

  const [profDraft, setProfDraft] = useState<ProfDraft | null>(null);
  const [credDraft, setCredDraft] = useState<CredDraft | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  // 「转发 Agent」开关打开时的探测结果；null = 未探测（开关关闭 / 未打开表单）。
  const [agentRunning, setAgentRunning] = useState<boolean | null>(null);
  /** 编辑档案时是否已存代理密码（决定密码框留空时的保存策略）。 */
  const proxySecretRef = useRef(false);
  /** 代理库条目（档案表单可引用）。 */
  const [proxyProfiles, setProxyProfiles] = useState<api.ProxyProfile[]>([]);

  useEffect(() => {
    api.listProxyProfiles().then(setProxyProfiles).catch(() => {});
  }, []);

  async function checkAgent() {
    try {
      const st = await api.sshAgentStatus();
      setAgentRunning(st.running);
    } catch {
      // 契约上此命令不抛错；取不到就按未运行提示，避免静默放行。
      setAgentRunning(false);
    }
  }

  async function reload() {
    try {
      const [cs, gs] = await Promise.all([api.listCredentials(), api.listGroups()]);
      setCreds(cs);
      setGroups(gs);
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }

  useEffect(() => {
    reload();
    // 仅在挂载时拉一次；后续由各写操作显式 reload。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部入口：编辑指定档案 / 快速连接预填（只应用一次，避免后续 props 更新覆盖草稿）。
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    if (editProfileId) {
      const target = profiles.find((p) => p.id === editProfileId);
      if (!target) return;
      editProfile(target);
      opened.current = true;
      return;
    }
    if (prefill) {
      setTab("profiles");
      setAgentRunning(null);
      setProfDraft({
        id: newId(),
        name: prefill.name,
        host: prefill.host,
        port: String(prefill.port),
        credential_id: creds[0]?.id ?? "",
        group_id: "",
        init_command: "",
        bastion_profile_id: "",
        agent_forwarding: false,
        ssh_input_compatibility: false,
        proxy: { ...EMPTY_PROXY_DRAFT },
        proxy_profile_id: "",
      });
      opened.current = true;
    }
    // editProfile 只在挂载阶段调用一次，不加入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editProfileId, prefill, profiles, creds]);

  function groupName(id: string | null | undefined): string {
    if (!id) return "未分组";
    return groups.find((g) => g.id === id)?.name ?? "未分组";
  }

  // ── 档案 ────────────────────────────────────────────────

  function editProfile(p: Profile) {
    setErr("");
    setProfDraft({
      id: p.id,
      name: p.name,
      host: p.host,
      port: String(p.port),
      credential_id: p.credential_id,
      group_id: p.group_id ?? "",
      init_command: p.init_command ?? "",
      bastion_profile_id: p.bastion_profile_id ?? "",
      agent_forwarding: p.agent_forwarding,
      ssh_input_compatibility: p.ssh_input_compatibility ?? null,
      algorithms: p.algorithms,
      proxy: proxyDraftFromProfile(p),
      proxy_profile_id: p.proxy_profile_id ?? "",
    });
    // 开关已开着的档案打开表单就探测一次，警告态不依赖用户再拨一下。
    setAgentRunning(null);
    if (p.agent_forwarding) void checkAgent();
    proxySecretRef.current = false;
    void api
      .getProfileProxyPassword(p.id)
      .then((s) => {
        proxySecretRef.current = Boolean(s);
      })
      .catch(() => {
        proxySecretRef.current = false;
      });
  }

  async function saveProfile() {
    const d = profDraft;
    if (!d) return;
    if (!d.name.trim() || !d.host.trim() || !d.credential_id) {
      setErr("名称、主机、凭据均为必填");
      return;
    }
    const proxyErr = d.proxy_profile_id ? null : proxyDraftError(d.proxy);
    if (proxyErr) {
      setErr(proxyErr);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const profile: api.Profile = {
        id: d.id,
        name: d.name.trim(),
        host: d.host.trim(),
        port: Number(d.port) || 22,
        credential_id: d.credential_id,
        bastion_profile_id: d.bastion_profile_id || null,
        init_command: d.init_command.trim() || null,
        group_id: d.group_id || null,
        agent_forwarding: d.agent_forwarding,
        ssh_input_compatibility: d.ssh_input_compatibility,
        algorithms: d.algorithms,
        ...proxyProfileFields(d.proxy_profile_id ? EMPTY_PROXY_DRAFT : d.proxy),
        proxy_profile_id: d.proxy_profile_id || null,
      };
      if (profiles.some((p) => p.id === d.id)) await api.updateProfile(profile);
      else await api.createProfile(profile);
      // 代理密码走 SecretStore（`proxy:<profile_id>`）；引用代理库时清掉主机级密码。
      if (d.proxy_profile_id) {
        await api.setProfileProxyPassword(profile.id, null);
        proxySecretRef.current = false;
      } else {
        const proxySecret = proxyPasswordToSave(d.proxy, proxySecretRef.current);
        if (proxySecret !== undefined) {
          await api.setProfileProxyPassword(profile.id, proxySecret);
          proxySecretRef.current = proxySecret !== null;
        }
      }
      setProfDraft(null);
      onChanged();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile(p: Profile) {
    if (!confirm(`删除连接「${p.name}」？`)) return;
    setBusy(true);
    setErr("");
    try {
      await api.deleteProfile(p.id);
      onChanged();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  // ── 凭据 ────────────────────────────────────────────────

  async function editCredential(c: Credential) {
    setErr("");
    try {
      // 列表不带 secret，编辑时取全量，避免保存时把已有 secret 清空。
      const full = await api.getCredential(c.id);
      setCredDraft({
        id: full.id,
        name: full.name,
        username: full.username,
        type: full.type,
        secret: full.secret ?? "",
        save_to_remote: full.save_to_remote,
      });
    } catch (e) {
      setErr(userVisibleError(String(e)));
    }
  }

  async function saveCredential() {
    const d = credDraft;
    if (!d) return;
    if (!d.name.trim() || !d.username.trim()) {
      setErr("名称、用户名为必填");
      return;
    }
    if (d.type === "password" && !d.secret.trim()) {
      setErr("密码认证需要填写密码");
      return;
    }
    if (d.type === "key" && !d.secret.trim()) {
      setErr("私钥认证需要粘贴私钥内容");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const credential: Credential = {
        id: d.id,
        name: d.name.trim(),
        username: d.username.trim(),
        type: d.type,
        secret: d.secret.trim() ? d.secret : null,
        save_to_remote: d.save_to_remote,
      };
      if (creds.some((c) => c.id === d.id)) await api.updateCredential(credential);
      else await api.createCredential(credential);
      setCredDraft(null);
      await reload();
      onChanged();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential(c: Credential) {
    if (!confirm(`删除凭据「${c.name}」？引用它的连接将无法使用。`)) return;
    setBusy(true);
    setErr("");
    try {
      await api.deleteCredential(c.id);
      await reload();
      onChanged();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function fillDefaultKey() {
    setErr("");
    try {
      // 默认密钥名来自钥匙串设置（后端缺省回落 id_ed25519，历史行为）。
      const name = await api.keychainGetDefaultKey();
      const text = await api.readDefaultKeyFile(name);
      setCredDraft((d) => (d ? { ...d, secret: text } : d));
    } catch (e) {
      setErr(`读取默认密钥失败：${userVisibleError(String(e))}`);
    }
  }

  // ── 分组 ────────────────────────────────────────────────

  function editGroup(g: Group) {
    setErr("");
    setGroupDraft({
      id: g.id,
      name: g.name,
      color: g.color || "#58a6ff",
      sort_order: String(g.sort_order),
      terminal_waves_enabled: g.terminal_waves_enabled ?? false,
    });
  }

  async function saveGroup() {
    const d = groupDraft;
    if (!d) return;
    if (!d.name.trim()) {
      setErr("分组名必填");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const group: Group = {
        id: d.id,
        name: d.name.trim(),
        color: d.color.trim() || "#58a6ff",
        sort_order: Number(d.sort_order) || 0,
        terminal_waves_enabled: d.terminal_waves_enabled,
      };
      if (groups.some((g) => g.id === d.id)) await api.updateGroup(group);
      else await api.createGroup(group);
      setGroupDraft(null);
      await reload();
      onChanged();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function removeGroup(g: Group) {
    if (!confirm(`删除分组「${g.name}」？组内连接会变为未分组。`)) return;
    setBusy(true);
    setErr("");
    try {
      await api.deleteGroup(g.id);
      await reload();
      onChanged();
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal cm-modal">
        <div className="cm-head">
          <h3>连接管理器</h3>
          <button onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>

        <nav className="cm-tabs">
          <button
            className={tab === "profiles" ? "active" : ""}
            onClick={() => setTab("profiles")}
          >
            连接 ({sshProfiles.length})
          </button>
          <button
            className={tab === "creds" ? "active" : ""}
            onClick={() => setTab("creds")}
          >
            凭据 ({creds.length})
          </button>
          <button
            className={tab === "groups" ? "active" : ""}
            onClick={() => setTab("groups")}
          >
            分组 ({groups.length})
          </button>
        </nav>

        {err && <div className="cm-err">{err}</div>}

        <div className="cm-body">
          {tab === "profiles" && (
            <>
              {profDraft ? (
                <div className="cm-form">
                  <label>
                    名称
                    <input
                      value={profDraft.name}
                      onChange={(e) =>
                        setProfDraft({ ...profDraft, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    主机
                    <input
                      value={profDraft.host}
                      onChange={(e) =>
                        setProfDraft({ ...profDraft, host: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    端口
                    <input
                      value={profDraft.port}
                      onChange={(e) =>
                        setProfDraft({ ...profDraft, port: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    凭据
                    <select
                      value={profDraft.credential_id}
                      onChange={(e) =>
                        setProfDraft({ ...profDraft, credential_id: e.target.value })
                      }
                    >
                      <option value="">请选择…</option>
                      {creds.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}（{c.username}·{CRED_LABEL[c.type]}）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    分组
                    <select
                      value={profDraft.group_id}
                      onChange={(e) =>
                        setProfDraft({ ...profDraft, group_id: e.target.value })
                      }
                    >
                      <option value="">未分组</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    跳板机
                    <select
                      value={profDraft.bastion_profile_id}
                      onChange={(e) =>
                        setProfDraft({
                          ...profDraft,
                          bastion_profile_id: e.target.value,
                        })
                      }
                    >
                      <option value="">不使用</option>
                      {sshProfiles
                        .filter((p) => p.id !== profDraft.id)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="cm-wide">
                    代理来源
                    <select
                      value={profDraft.proxy_profile_id}
                      onChange={(e) =>
                        setProfDraft({
                          ...profDraft,
                          proxy_profile_id: e.target.value,
                        })
                      }
                    >
                      <option value="">内联配置 / 直连</option>
                      {proxyProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}（{p.proxy_type.toUpperCase()} {p.host}:{p.port}）
                        </option>
                      ))}
                    </select>
                  </label>
                  {profDraft.proxy_profile_id ? (
                    <div className="cm-wide" style={{ fontSize: 12, opacity: 0.8 }}>
                      使用代理库条目；配置与密码在 Vault「代理」页统一维护。
                    </div>
                  ) : (
                    <>
                      <label>
                        代理类型
                        <select
                          value={profDraft.proxy.type}
                          onChange={(e) =>
                            setProfDraft({
                              ...profDraft,
                              proxy: {
                                ...profDraft.proxy,
                                type: e.target.value as ProxyDraft["type"],
                              },
                            })
                          }
                        >
                          <option value="none">无（直连）</option>
                          <option value="http">HTTP 代理</option>
                          <option value="socks5">SOCKS5 代理</option>
                        </select>
                      </label>
                      {profDraft.proxy.type !== "none" && (
                        <>
                          <label>
                            代理主机
                            <input
                              value={profDraft.proxy.host}
                              onChange={(e) =>
                                setProfDraft({
                                  ...profDraft,
                                  proxy: { ...profDraft.proxy, host: e.target.value },
                                })
                              }
                            />
                          </label>
                          <label>
                            代理端口
                            <input
                              type="number"
                              min={1}
                              max={65535}
                              value={profDraft.proxy.port}
                              onChange={(e) =>
                                setProfDraft({
                                  ...profDraft,
                                  proxy: { ...profDraft.proxy, port: e.target.value },
                                })
                              }
                            />
                          </label>
                          <label>
                            代理用户名（可选）
                            <input
                              value={profDraft.proxy.username}
                              onChange={(e) =>
                                setProfDraft({
                                  ...profDraft,
                                  proxy: { ...profDraft.proxy, username: e.target.value },
                                })
                              }
                            />
                          </label>
                          <label>
                            代理密码（可选）
                            <input
                              type="password"
                              value={profDraft.proxy.password}
                              placeholder={
                                proxySecretRef.current ? "已保存（留空保持不变）" : ""
                              }
                              onChange={(e) =>
                                setProfDraft({
                                  ...profDraft,
                                  proxy: { ...profDraft.proxy, password: e.target.value },
                                })
                              }
                            />
                          </label>
                          <label className="cm-wide">
                            不使用代理（逗号分隔）
                            <input
                              value={profDraft.proxy.noProxy}
                              placeholder="localhost, 127.0.0.1"
                              onChange={(e) =>
                                setProfDraft({
                                  ...profDraft,
                                  proxy: { ...profDraft.proxy, noProxy: e.target.value },
                                })
                              }
                            />
                          </label>
                        </>
                      )}
                    </>
                  )}
                  <label className="cm-wide">
                    初始化命令（可选）
                    <input
                      value={profDraft.init_command}
                      onChange={(e) =>
                        setProfDraft({
                          ...profDraft,
                          init_command: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="cm-wide cm-agent-row">
                    <div className="cm-agent-line">
                      <span>转发 Agent</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={profDraft.agent_forwarding}
                        className={`host-switch${profDraft.agent_forwarding ? " on" : ""}`}
                        onClick={() => {
                          const next = !profDraft.agent_forwarding;
                          setProfDraft({ ...profDraft, agent_forwarding: next });
                          if (next) void checkAgent();
                          else setAgentRunning(null);
                        }}
                      >
                        <span className="host-switch-knob" />
                      </button>
                    </div>
                    {profDraft.agent_forwarding && agentRunning === false && (
                      <div className="cm-agent-warn">
                        未检测到运行中的 SSH Agent，转发将不可用
                      </div>
                    )}
                  </div>
                  <div className="cm-wide cm-agent-row">
                    <div className="cm-agent-line">
                      <span>输入兼容模式：逐字发送</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={profDraft.ssh_input_compatibility ?? true}
                        className={`host-switch${(profDraft.ssh_input_compatibility ?? true) ? " on" : ""}`}
                        onClick={() =>
                          setProfDraft({
                            ...profDraft,
                            ssh_input_compatibility: !(
                              profDraft.ssh_input_compatibility ?? true
                            ),
                          })
                        }
                      >
                        <span className="host-switch-knob" />
                      </button>
                    </div>
                    <p className="host-setting-hint">
                      中文输入或短粘贴出现丢字时尝试开启。保存后重新连接生效。
                    </p>
                  </div>
                  <div className="cm-actions-bar">
                    <button onClick={saveProfile} disabled={busy}>
                      保存
                    </button>
                    <button onClick={() => setProfDraft(null)} disabled={busy}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="cm-new"
                  onClick={() => {
                    setAgentRunning(null);
                    setProfDraft(emptyProfile());
                  }}
                >
                  新建连接
                </button>
              )}

              {sshProfiles.length === 0 && !profDraft && (
                <div className="cm-empty">还没有连接，先「新建连接」。</div>
              )}

              {sshProfiles.map((p) => (
                <div key={p.id} className="cm-row">
                  <div className="cm-main">
                    <span className="cm-name">{p.name}</span>
                    <span className="cm-sub">
                      {p.host}:{p.port} · {groupName(p.group_id)}
                      {p.bastion_profile_id ? " · 经跳板机" : ""}
                    </span>
                  </div>
                  <div className="cm-actions">
                    <button onClick={() => onConnect(p)} disabled={busy}>
                      连接
                    </button>
                    <button onClick={() => editProfile(p)} disabled={busy}>
                      编辑
                    </button>
                    <button onClick={() => removeProfile(p)} disabled={busy}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "creds" && (
            <>
              {credDraft ? (
                <div className="cm-form">
                  <label>
                    名称
                    <input
                      value={credDraft.name}
                      onChange={(e) =>
                        setCredDraft({ ...credDraft, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    用户名
                    <input
                      value={credDraft.username}
                      onChange={(e) =>
                        setCredDraft({ ...credDraft, username: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    认证方式
                    <select
                      value={credDraft.type}
                      onChange={(e) =>
                        setCredDraft({
                          ...credDraft,
                          type: e.target.value as CredentialType,
                        })
                      }
                    >
                      {(["password", "key", "interactive", "agent", "none"] as CredentialType[]).map(
                        (t) => (
                          <option key={t} value={t}>
                            {CRED_LABEL[t]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  {(credDraft.type === "password" || credDraft.type === "key") && (
                    <label className="cm-wide">
                      {credDraft.type === "key" ? "私钥内容（PEM）" : "密码"}
                      <textarea
                        rows={credDraft.type === "key" ? 6 : 2}
                        value={credDraft.secret}
                        onChange={(e) =>
                          setCredDraft({ ...credDraft, secret: e.target.value })
                        }
                      />
                    </label>
                  )}
                  {credDraft.type === "key" && (
                    <div className="cm-wide">
                      <button onClick={fillDefaultKey} disabled={busy}>
                        读取 ~/.ssh/id_ed25519
                      </button>
                    </div>
                  )}
                  <div className="cm-actions-bar">
                    <button onClick={saveCredential} disabled={busy}>
                      保存
                    </button>
                    <button onClick={() => setCredDraft(null)} disabled={busy}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button className="cm-new" onClick={() => setCredDraft(emptyCred())}>
                  新建凭据
                </button>
              )}

              {creds.length === 0 && !credDraft && (
                <div className="cm-empty">还没有凭据，先「新建凭据」。</div>
              )}

              {creds.map((c) => (
                <div key={c.id} className="cm-row">
                  <div className="cm-main">
                    <span className="cm-name">{c.name}</span>
                    <span className="cm-sub">
                      {c.username} · {CRED_LABEL[c.type]}
                    </span>
                  </div>
                  <div className="cm-actions">
                    <button onClick={() => editCredential(c)} disabled={busy}>
                      编辑
                    </button>
                    <button onClick={() => removeCredential(c)} disabled={busy}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "groups" && (
            <>
              {groupDraft ? (
                <div className="cm-form">
                  <label>
                    分组名
                    <input
                      value={groupDraft.name}
                      onChange={(e) =>
                        setGroupDraft({ ...groupDraft, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    颜色
                    <input
                      value={groupDraft.color}
                      onChange={(e) =>
                        setGroupDraft({ ...groupDraft, color: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    排序
                    <input
                      value={groupDraft.sort_order}
                      onChange={(e) =>
                        setGroupDraft({
                          ...groupDraft,
                          sort_order: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="cm-actions-bar">
                    <button onClick={saveGroup} disabled={busy}>
                      保存
                    </button>
                    <button onClick={() => setGroupDraft(null)} disabled={busy}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button className="cm-new" onClick={() => setGroupDraft(emptyGroup())}>
                  新建分组
                </button>
              )}

              {groups.length === 0 && !groupDraft && (
                <div className="cm-empty">还没有分组。</div>
              )}

              {groups.map((g) => (
                <div key={g.id} className="cm-row">
                  <div className="cm-main">
                    <span className="cm-name">
                      <span
                        className="cm-dot"
                        style={{ background: g.color || "#58a6ff" }}
                      />
                      {g.name}
                    </span>
                    <span className="cm-sub">排序 {g.sort_order}</span>
                  </div>
                  <div className="cm-actions">
                    <button onClick={() => editGroup(g)} disabled={busy}>
                      编辑
                    </button>
                    <button onClick={() => removeGroup(g)} disabled={busy}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
