import { useRef, useState } from "react";
import * as api from "./backend/client";
import type { CredentialType, FileStat, RemoteEntry } from "./backend/client";

interface Props {
  /** 当前已建连的 SSH 会话 id，用于「复用 SSH 会话」建 SFTP。 */
  sshSessionId: string | null;
}

type Direction = "up" | "down";
type TransferStatus = "running" | "done" | "error" | "canceled";

interface TransferRow {
  id: string;
  label: string;
  direction: Direction;
  transferred: number;
  total: number;
  status: TransferStatus;
  error?: string;
  /** 当前子任务的 transfer_id（批量传输时用于取消）。 */
  current?: string;
}

function joinPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** 去掉末尾的 '/' 或 '\'（原生目录选择器在 Windows 上返回反斜杠）。 */
function trimSep(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/** 取本地路径的最后一段（兼容 Windows 反斜杠）。 */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * SFTP 文件浏览面板：独立连接 / 复用 SSH 会话。
 * 支持 list/下载/上传/目录/重命名/删除/stat，以及流式传输 + 递归目录 + 原生选择框 + 进度条。
 */
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

  // 传输队列与取消标记
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const canceled = useRef<Set<string>>(new Set());

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

  // ── 传输队列辅助 ────────────────────────────────────────

  function addRow(row: TransferRow) {
    // 只保留最近 8 条，避免长列表撑爆面板
    setTransfers((cur) => [row, ...cur].slice(0, 8));
  }

  function patchRow(id: string, patch: Partial<TransferRow>) {
    setTransfers((cur) =>
      cur.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  function cancelRow(id: string) {
    canceled.current.add(id);
    const row = transfers.find((t) => t.id === id);
    if (row?.current) {
      api.sftpCancelTransfer(row.current).catch(() => {
        /* 取消失败不阻塞 UI */
      });
    }
    patchRow(id, { status: "canceled" });
  }

  function isCanceled(id: string): boolean {
    return canceled.current.has(id);
  }

  // ── 下载：单文件（原生另存为 + 进度） ────────────────────

  async function downloadFile(remotePath: string, name: string) {
    if (!sftpId) return;
    const localPath = await api.sftpPickSavePath(name);
    if (!localPath) return;
    setErr("");
    const rowId = crypto.randomUUID();
    const tid = crypto.randomUUID();
    addRow({
      id: rowId,
      label: name,
      direction: "down",
      transferred: 0,
      total: 0,
      status: "running",
      current: tid,
    });
    const un = await api.onSftpProgress(tid, (p) =>
      patchRow(rowId, { transferred: p.transferred, total: p.total }),
    );
    try {
      await api.sftpDownloadTo(sftpId, remotePath, localPath, tid);
      patchRow(rowId, { status: "done", current: undefined });
    } catch (e) {
      if (isCanceled(rowId)) {
        patchRow(rowId, { status: "canceled", current: undefined });
      } else {
        patchRow(rowId, { status: "error", error: String(e), current: undefined });
      }
    } finally {
      un();
      canceled.current.delete(rowId);
    }
  }

  // ── 下载：整个目录（递归 walk + 逐文件流式） ──────────────

  async function downloadDirectory(remoteRoot: string, name: string) {
    if (!sftpId) return;
    const destRoot = await api.sftpPickFolder();
    if (!destRoot) return;
    setErr("");
    const rowId = crypto.randomUUID();
    addRow({
      id: rowId,
      label: `${name}/`,
      direction: "down",
      transferred: 0,
      total: 0,
      status: "running",
    });
    try {
      const files = await api.sftpWalkRemote(sftpId, remoteRoot);
      const total = files.reduce((s, f) => s + f.size, 0);
      patchRow(rowId, { total });
      let done = 0;
      for (const f of files) {
        if (isCanceled(rowId)) {
          patchRow(rowId, { status: "canceled", current: undefined });
          return;
        }
        const rp = `${trimSep(remoteRoot)}/${f.rel_path}`;
        const lp = `${trimSep(destRoot)}/${f.rel_path}`;
        const tid = crypto.randomUUID();
        patchRow(rowId, { current: tid });
        const un = await api.onSftpProgress(tid, (p) =>
          patchRow(rowId, { transferred: done + p.transferred }),
        );
        try {
          await api.sftpDownloadTo(sftpId, rp, lp, tid);
        } finally {
          un();
        }
        done += f.size;
        patchRow(rowId, { transferred: done });
      }
      patchRow(rowId, { status: "done", current: undefined });
    } catch (e) {
      if (isCanceled(rowId)) {
        patchRow(rowId, { status: "canceled", current: undefined });
      } else {
        patchRow(rowId, { status: "error", error: String(e), current: undefined });
      }
    } finally {
      canceled.current.delete(rowId);
    }
  }

  // ── 上传：多选文件（原生选择框 + 进度） ──────────────────

  async function uploadFiles() {
    if (!sftpId) return;
    const picked = await api.sftpPickOpenFiles();
    if (!picked || picked.length === 0) return;
    setErr("");
    const rowId = crypto.randomUUID();
    addRow({
      id: rowId,
      label: picked.length === 1 ? basename(picked[0]) : `${picked.length} 个文件`,
      direction: "up",
      transferred: 0,
      total: 0,
      status: "running",
    });
    try {
      let doneBytes = 0;
      let knownTotal = 0;
      for (const lp of picked) {
        if (isCanceled(rowId)) {
          patchRow(rowId, { status: "canceled", current: undefined });
          return;
        }
        const tid = crypto.randomUUID();
        patchRow(rowId, { current: tid });
        let fileTotal = 0;
        const un = await api.onSftpProgress(tid, (p) => {
          fileTotal = p.total;
          patchRow(rowId, {
            transferred: doneBytes + p.transferred,
            total: knownTotal + p.total,
          });
        });
        try {
          await api.sftpUploadFrom(sftpId, lp, joinPath(cwd, basename(lp)), tid);
        } finally {
          un();
        }
        doneBytes += fileTotal;
        knownTotal += fileTotal;
        patchRow(rowId, { transferred: doneBytes, total: knownTotal });
      }
      patchRow(rowId, { status: "done", current: undefined });
      await refresh();
    } catch (e) {
      if (isCanceled(rowId)) {
        patchRow(rowId, { status: "canceled", current: undefined });
      } else {
        patchRow(rowId, { status: "error", error: String(e), current: undefined });
      }
      await refresh();
    } finally {
      canceled.current.delete(rowId);
    }
  }

  // ── 上传：整个本地目录（递归 walk + 逐文件流式） ──────────

  async function uploadDirectory() {
    if (!sftpId) return;
    const localRoot = await api.sftpPickFolder();
    if (!localRoot) return;
    setErr("");
    const rowId = crypto.randomUUID();
    addRow({
      id: rowId,
      label: `${basename(localRoot)}/`,
      direction: "up",
      transferred: 0,
      total: 0,
      status: "running",
    });
    try {
      const files = await api.walkLocalDir(localRoot);
      const total = files.reduce((s, f) => s + f.size, 0);
      patchRow(rowId, { total });
      let done = 0;
      for (const f of files) {
        if (isCanceled(rowId)) {
          patchRow(rowId, { status: "canceled", current: undefined });
          return;
        }
        const lp = `${trimSep(localRoot)}/${f.rel_path}`;
        const rp = joinPath(cwd, f.rel_path);
        const tid = crypto.randomUUID();
        patchRow(rowId, { current: tid });
        const un = await api.onSftpProgress(tid, (p) =>
          patchRow(rowId, { transferred: done + p.transferred }),
        );
        try {
          // 远端父目录由后端 upload_streaming 自动 mkdir -p
          await api.sftpUploadFrom(sftpId, lp, rp, tid);
        } finally {
          un();
        }
        done += f.size;
        patchRow(rowId, { transferred: done });
      }
      patchRow(rowId, { status: "done", current: undefined });
      await refresh();
    } catch (e) {
      if (isCanceled(rowId)) {
        patchRow(rowId, { status: "canceled", current: undefined });
      } else {
        patchRow(rowId, { status: "error", error: String(e), current: undefined });
      }
      await refresh();
    } finally {
      canceled.current.delete(rowId);
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

  function percentOf(t: TransferRow): number {
    if (t.total <= 0) return 0;
    return Math.min(100, Math.round((t.transferred / t.total) * 100));
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
            <button onClick={uploadFiles} disabled={busy} title="原生文件选择框（可多选）">
              上传文件
            </button>
            <button onClick={uploadDirectory} disabled={busy} title="原生目录选择框（递归）">
              上传目录
            </button>
            <button onClick={disconnect} disabled={busy}>
              断开
            </button>
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

          {transfers.length > 0 && (
            <div className="xfer-list">
              {transfers.map((t) => (
                <div key={t.id} className="xfer-row" data-status={t.status}>
                  <span className="xfer-name" title={t.error ?? t.label}>
                    {t.direction === "up" ? "↑" : "↓"} {t.label}
                  </span>
                  <div className="xfer-bar" data-indeterminate={t.total <= 0}>
                    <div
                      className="xfer-fill"
                      style={{ width: `${percentOf(t)}%` }}
                    />
                  </div>
                  <span className="xfer-pct">
                    {t.total > 0 ? `${percentOf(t)}%` : t.status === "running" ? "…" : ""}
                  </span>
                  {t.status === "running" ? (
                    <button onClick={() => cancelRow(t.id)}>取消</button>
                  ) : (
                    <span className="xfer-state" data-status={t.status}>
                      {t.status === "done"
                        ? "完成"
                        : t.status === "canceled"
                          ? "已取消"
                          : "失败"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

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
                      <button
                        onClick={() =>
                          e.is_dir
                            ? downloadDirectory(joinPath(cwd, e.name), e.name)
                            : downloadFile(joinPath(cwd, e.name), e.name)
                        }
                        disabled={busy}
                        title={e.is_dir ? "选择目标目录后递归下载" : "原生另存为"}
                      >
                        {e.is_dir ? "下载目录" : "下载"}
                      </button>
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
