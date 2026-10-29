import { useRef, useState } from "react";
import * as api from "./backend/client";
import type { CredentialType, FileStat, RemoteEntry } from "./backend/client";

interface Props {
  /** 当前已建连的 SSH 会话 id，用于「复用 SSH 会话」建 SFTP。 */
  sshSessionId: string | null;
}

function joinPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** SFTP 文件浏览面板：独立连接 / 复用 SSH 会话，list/下载/上传/目录/重命名/删除/stat。 */
export function SftpPanel({ sshSessionId }: Props) {
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [stat, setStat] = useState<FileStat | null>(null);

  // 独立连接表单
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [authType, setAuthType] = useState<CredentialType>("password");
  const [secret, setSecret] = useState("");

  // 新建目录 / 重命名
  const [mkdirName, setMkdirName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refresh(path?: string) {
    if (!sftpId) return;
    setBusy(true);
    setErr("");
    try {
      const target = path ?? cwd;
      const list = await api.sftpList(sftpId, target);
      setCwd(target);
      setPathInput(target);
      setEntries(list);
      setStat(null);
      setRenaming(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectStandalone() {
    if (!host.trim() || !user.trim()) {
      setErr("请填写 host 和用户名");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const id = await api.sftpConnect(
        host,
        Number(port) || 22,
        user,
        authType,
        secret || null,
      );
      setSftpId(id);
      const home = await api.sftpHome(id);
      await refresh(home);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectFromSsh() {
    if (!sshSessionId) return;
    setBusy(true);
    setErr("");
    try {
      const id = await api.sftpConnectSession(sshSessionId);
      setSftpId(id);
      const home = await api.sftpHome(id);
      await refresh(home);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (sftpId) {
      try {
        await api.sftpClose(sftpId);
      } catch {
        /* 忽略关闭失败 */
      }
    }
    setSftpId(null);
    setEntries([]);
    setStat(null);
    setCwd("/");
    setPathInput("/");
    setRenaming(null);
  }

  async function openEntry(e: RemoteEntry) {
    if (e.is_dir) await refresh(joinPath(cwd, e.name));
  }

  async function goUp() {
    if (cwd === "/") return;
    const parent = cwd.split("/").slice(0, -1).join("/") || "/";
    await refresh(parent);
  }

  async function gotoPath() {
    await refresh(pathInput);
  }

  async function download(e: RemoteEntry) {
    if (!sftpId) return;
    setBusy(true);
    setErr("");
    try {
      const data = await api.sftpDownload(sftpId, joinPath(cwd, e.name));
      const blob = new Blob([Uint8Array.from(data)]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = e.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function onFilePicked(files: FileList | null) {
    const file = files?.[0];
    if (!file || !sftpId) return;
    setBusy(true);
    setErr("");
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      await api.sftpUpload(sftpId, joinPath(cwd, file.name), buf);
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function mkdir() {
    if (!sftpId || !mkdirName.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await api.sftpMkdir(sftpId, joinPath(cwd, mkdirName.trim()));
      setMkdirName("");
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(e: RemoteEntry) {
    if (!sftpId) return;
    setBusy(true);
    setErr("");
    try {
      await api.sftpRemove(sftpId, joinPath(cwd, e.name));
      await refresh();
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function renameEntry(e: RemoteEntry) {
    if (!sftpId || !renameValue.trim()) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await api.sftpRename(
        sftpId,
        joinPath(cwd, e.name),
        joinPath(cwd, renameValue.trim()),
      );
      setRenaming(null);
      await refresh();
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setBusy(false);
    }
  }

  async function statEntry(e: RemoteEntry) {
    if (!sftpId) return;
    setBusy(true);
    setErr("");
    try {
      setStat(await api.sftpStat(sftpId, joinPath(cwd, e.name)));
    } catch (ex) {
      setErr(String(ex));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sftp-panel">
      {/* 连接区 */}
      {!sftpId ? (
        <div className="sftp-connect">
          <div className="sftp-row">
            <button onClick={connectFromSsh} disabled={busy || !sshSessionId}>
              复用当前 SSH 会话
            </button>
          </div>
          <div className="sftp-rule">或独立连接</div>
          <div className="sftp-row">
            <input
              placeholder="host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
            <input
              placeholder="port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <div className="sftp-row">
            <input
              placeholder="用户名"
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value as CredentialType)}
            >
              <option value="password">密码</option>
              <option value="key">私钥</option>
              <option value="interactive">交互</option>
              <option value="agent">agent</option>
              <option value="none">无</option>
            </select>
          </div>
          {authType === "password" || authType === "key" ? (
            <div className="sftp-row">
              <input
                type={authType === "password" ? "password" : "text"}
                placeholder={authType === "password" ? "密码" : "私钥内容"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
          ) : null}
          <div className="sftp-row">
            <button onClick={connectStandalone} disabled={busy}>
              连接 SFTP
            </button>
          </div>
        </div>
      ) : (
        <div className="sftp-body">
          <div className="sftp-toolbar">
            <input
              className="sftp-path"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && gotoPath()}
            />
            <button onClick={gotoPath} disabled={busy} title="跳转">
              跳转
            </button>
            <button onClick={goUp} disabled={busy || cwd === "/"} title="上级">
              上级
            </button>
            <button onClick={() => refresh()} disabled={busy}>
              刷新
            </button>
            <button onClick={() => fileInputRef.current?.click()} disabled={busy}>
              上传
            </button>
            <button onClick={disconnect} disabled={busy}>
              断开
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="sftp-file"
              onChange={(e) => onFilePicked(e.target.files)}
              style={{ display: "none" }}
            />
          </div>

          <div className="sftp-toolbar">
            <input
              placeholder="新建目录名"
              value={mkdirName}
              onChange={(e) => setMkdirName(e.target.value)}
            />
            <button onClick={mkdir} disabled={busy || !mkdirName.trim()}>
              新建目录
            </button>
          </div>

          {stat && (
            <div className="sftp-stat">
              <strong>{stat.name}</strong> ·{" "}
              {stat.is_dir ? "目录" : formatSize(stat.size)}
              {stat.permissions != null && (
                <> · mode {`0o${stat.permissions.toString(8)}`}</>
              )}
            </div>
          )}

          <ul className="sftp-list">
            {entries.map((e) => (
              <li key={e.name} className={e.is_dir ? "is-dir" : "is-file"}>
                {renaming === e.name ? (
                  <span className="sftp-rename">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(ev) => setRenameValue(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") renameEntry(e);
                        if (ev.key === "Escape") setRenaming(null);
                      }}
                    />
                    <button onClick={() => renameEntry(e)} disabled={busy}>
                      确定
                    </button>
                  </span>
                ) : (
                  <>
                    <span
                      className="sftp-name"
                      title={e.is_symlink ? "符号链接" : e.name}
                      onClick={() => openEntry(e)}
                    >
                      {e.is_dir ? "📁" : "📄"} {e.name}
                    </span>
                    <span className="sftp-meta">
                      {e.is_dir ? "" : formatSize(e.size)}
                    </span>
                    <span className="sftp-actions">
                      {!e.is_dir && (
                        <button onClick={() => download(e)} disabled={busy}>
                          下载
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setRenaming(e.name);
                          setRenameValue(e.name);
                        }}
                        disabled={busy}
                      >
                        重命名
                      </button>
                      <button onClick={() => statEntry(e)} disabled={busy}>
                        stat
                      </button>
                      <button onClick={() => removeEntry(e)} disabled={busy}>
                        删除
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {err && <div className="sftp-error">{err}</div>}
    </div>
  );
}