import { useEffect, useState } from "react";
import * as api from "./backend/client";
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
  /** 编辑时原样带回，避免 update 把自定义算法重置为默认。 */
  algorithms?: api.SshAlgorithms;
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
  return crypto.randomUUID();
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
export function ConnectionManager({ profiles, onClose, onConnect, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>("profiles");
  const [creds, setCreds] = useState<Credential[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [profDraft, setProfDraft] = useState<ProfDraft | null>(null);
  const [credDraft, setCredDraft] = useState<CredDraft | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);

  async function reload() {
    try {
      const [cs, gs] = await Promise.all([api.listCredentials(), api.listGroups()]);
      setCreds(cs);
      setGroups(gs);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    reload();
    // 仅在挂载时拉一次；后续由各写操作显式 reload。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      algorithms: p.algorithms,
    });
  }

  async function saveProfile() {
    const d = profDraft;
    if (!d) return;
    if (!d.name.trim() || !d.host.trim() || !d.credential_id) {
      setErr("名称、主机、凭据均为必填");
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
        algorithms: d.algorithms,
      };
      if (profiles.some((p) => p.id === d.id)) await api.updateProfile(profile);
      else await api.createProfile(profile);
      setProfDraft(null);
      onChanged();
    } catch (e) {
      setErr(String(e));
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
      setErr(String(e));
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
      setErr(String(e));
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
      setErr(String(e));
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
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function fillDefaultKey() {
    setErr("");
    try {
      const text = await api.readDefaultKeyFile("id_ed25519");
      setCredDraft((d) => (d ? { ...d, secret: text } : d));
    } catch (e) {
      setErr(`读取 ~/.ssh/id_ed25519 失败：${String(e)}`);
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
      setErr(String(e));
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
      setErr(String(e));
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
            连接 ({profiles.length})
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
                      {profiles
                        .filter((p) => p.id !== profDraft.id)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
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
                <button className="cm-new" onClick={() => setProfDraft(emptyProfile())}>
                  新建连接
                </button>
              )}

              {profiles.length === 0 && !profDraft && (
                <div className="cm-empty">还没有连接，先「新建连接」。</div>
              )}

              {profiles.map((p) => (
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
