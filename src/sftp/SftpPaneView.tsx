/**
 * 已连接面板：标签头（名称 + 当前路径）+ 条目列表 + 文件操作。
 * 交互基准为 Netcatty SftpPaneFileList 右键菜单的 termX 范围子集：
 * - 远端行：下载（仅文件）/ 重命名 / 修改权限 / 删除；
 * - 本地行：重命名 / 删除；
 * - 空白处：新建文件夹（远端另有「上传文件」）。
 * 上传 / 下载走流式命令（sftp_upload_from / sftp_download_to），
 * 每传输一条订阅 `sftp:progress:<transferId>`，底部传输条展示进度、可取消。
 * 列头 / 排序 / 选择模型 / 虚拟化 / 面包屑留后续阶段；本地侧默认过滤隐藏文件。
 */

import { useCallback, useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as api from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { Icon } from "../ui/icons";
import {
  joinLocalPath,
  joinRemotePath,
  localParent,
  remoteParent,
  type PaneConnection,
} from "./sftpModel";
import {
  SftpContextMenu,
  SftpDeleteDialog,
  SftpPermissionsDialog,
  SftpPromptDialog,
  type MenuItem,
} from "./SftpPaneDialogs";

interface Row {
  name: string;
  isDir: boolean;
  /** 本地条目类型（local_remove 的 expectedType 守卫）。 */
  kind?: "file" | "directory" | "symlink";
}

interface Transfer {
  id: string;
  name: string;
  transferred: number;
  total: number;
}

type DialogState =
  | { type: "rename"; row: Row }
  | { type: "delete"; row: Row }
  | { type: "mkdir" }
  | { type: "chmod"; row: Row; mode: number }
  | null;

interface MenuState {
  x: number;
  y: number;
  row: Row | null;
}

let transferSeq = 0;
function nextTransferId(): string {
  transferSeq += 1;
  return `tx-${Date.now()}-${transferSeq}`;
}

/** 本地路径取文件名（兼容正反斜杠）。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

interface Props {
  connection: PaneConnection;
  /** 导航成功后回写 tab 的当前路径（切 tab 再回来保持位置）。 */
  onPathChange: (path: string) => void;
}

export function SftpPaneView({ connection, onPathChange }: Props) {
  const [path, setPath] = useState(connection.path);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  const isRemote = connection.kind === "remote";
  const join = isRemote ? joinRemotePath : joinLocalPath;

  const load = useCallback(
    async (target: string) => {
      setBusy(true);
      setError("");
      try {
        if (connection.kind === "local") {
          const entries = await api.localListDir(target);
          setRows(
            entries
              .filter((e) => !e.hidden)
              .map((e) => ({
                name: e.name,
                isDir: e.kind === "directory" || e.link_target === "directory",
                kind: e.kind,
              })),
          );
        } else {
          const entries = await api.sftpList(connection.sftpId, target);
          setRows(entries.map((e) => ({ name: e.name, isDir: e.is_dir })));
        }
        setPath(target);
        onPathChange(target);
      } catch (e) {
        setError(userVisibleError(String(e)));
      } finally {
        setBusy(false);
      }
    },
    [connection, onPathChange],
  );

  useEffect(() => {
    void load(connection.path);
    // 仅在挂载时加载一次；其后的导航走 navigate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 传输条 ─────────────────────────────────────────────

  const patchTransfer = useCallback((id: string, patch: Partial<Transfer>) => {
    setTransfers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }, []);
  const dropTransfer = useCallback((id: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const runDownload = async (row: Row) => {
    if (connection.kind !== "remote") return;
    let local: string | null;
    try {
      local = await api.sftpPickSavePath(row.name);
    } catch (e) {
      setError(userVisibleError(String(e)));
      return;
    }
    if (!local) return;
    const tid = nextTransferId();
    setTransfers((p) => [
      ...p,
      { id: tid, name: row.name, transferred: 0, total: 0 },
    ]);
    const unlisten = await api.onSftpProgress(tid, (pr) =>
      patchTransfer(tid, { transferred: pr.transferred, total: pr.total }),
    );
    try {
      await api.sftpDownloadTo(
        connection.sftpId,
        join(path, row.name),
        local,
        tid,
      );
    } catch (e) {
      setError(userVisibleError(String(e)));
    } finally {
      unlisten();
      dropTransfer(tid);
    }
  };

  const runUpload = async () => {
    if (connection.kind !== "remote") return;
    let picked: string[] | null;
    try {
      picked = await api.sftpPickOpenFiles();
    } catch (e) {
      setError(userVisibleError(String(e)));
      return;
    }
    if (!picked || picked.length === 0) return;
    for (const local of picked) {
      const name = baseName(local);
      const tid = nextTransferId();
      setTransfers((p) => [
        ...p,
        { id: tid, name, transferred: 0, total: 0 },
      ]);
      const unlisten = await api.onSftpProgress(tid, (pr) =>
        patchTransfer(tid, { transferred: pr.transferred, total: pr.total }),
      );
      try {
        await api.sftpUploadFrom(
          connection.sftpId,
          local,
          join(path, name),
          tid,
        );
      } catch (e) {
        setError(userVisibleError(String(e)));
      } finally {
        unlisten();
        dropTransfer(tid);
      }
    }
    void load(path);
  };

  // ── 文件操作 ───────────────────────────────────────────

  const runDelete = async (row: Row) => {
    setDialogBusy(true);
    setDialogError("");
    try {
      if (connection.kind === "remote") {
        await api.sftpRemove(connection.sftpId, join(path, row.name));
      } else {
        await api.localRemove(join(path, row.name), row.kind ?? "file");
      }
      setDialog(null);
      setSelected(null);
      void load(path);
    } catch (e) {
      setDialogError(userVisibleError(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };

  const runRename = async (row: Row, newName: string) => {
    setDialogBusy(true);
    setDialogError("");
    try {
      if (connection.kind === "remote") {
        await api.sftpRename(
          connection.sftpId,
          join(path, row.name),
          join(path, newName),
        );
      } else {
        await api.localRename(join(path, row.name), join(path, newName));
      }
      setDialog(null);
      void load(path);
    } catch (e) {
      setDialogError(userVisibleError(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };

  const runMkdir = async (name: string) => {
    setDialogBusy(true);
    setDialogError("");
    try {
      if (connection.kind === "remote") {
        await api.sftpMkdir(connection.sftpId, join(path, name));
      } else {
        await api.localMkdir(join(path, name));
      }
      setDialog(null);
      void load(path);
    } catch (e) {
      setDialogError(userVisibleError(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };

  const openChmod = async (row: Row) => {
    if (connection.kind !== "remote") return;
    try {
      const st = await api.sftpStat(connection.sftpId, join(path, row.name));
      setDialogError("");
      setDialog({ type: "chmod", row, mode: st.permissions ?? 0 });
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
  };

  const runChmod = async (row: Row, mode: number) => {
    if (connection.kind !== "remote") return;
    setDialogBusy(true);
    setDialogError("");
    try {
      await api.sftpChmod(connection.sftpId, join(path, row.name), mode);
      setDialog(null);
      void load(path);
    } catch (e) {
      setDialogError(userVisibleError(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };

  // ── 右键菜单 ───────────────────────────────────────────

  const openRowMenu = (e: ReactMouseEvent, row: Row) => {
    e.preventDefault();
    setSelected(row.name);
    setMenu({ x: e.clientX, y: e.clientY, row });
  };
  const openBlankMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    setSelected(null);
    setMenu({ x: e.clientX, y: e.clientY, row: null });
  };

  let menuItems: MenuItem[] = [];
  if (menu) {
    const row = menu.row;
    if (row) {
      if (isRemote && !row.isDir) {
        menuItems.push({ label: "下载", onClick: () => void runDownload(row) });
      }
      menuItems.push({
        label: "重命名",
        onClick: () => {
          setDialogError("");
          setDialog({ type: "rename", row });
        },
      });
      if (isRemote) {
        menuItems.push({ label: "修改权限", onClick: () => void openChmod(row) });
      }
      menuItems.push({
        label: "删除",
        danger: true,
        onClick: () => {
          setDialogError("");
          setDialog({ type: "delete", row });
        },
      });
    } else {
      if (isRemote) {
        menuItems.push({ label: "上传文件", onClick: () => void runUpload() });
      }
      menuItems.push({
        label: "新建文件夹",
        onClick: () => {
          setDialogError("");
          setDialog({ type: "mkdir" });
        },
      });
    }
  }

  // ── 渲染 ───────────────────────────────────────────────

  const isRoot =
    connection.kind === "local"
      ? localParent(path) === path
      : path === "/";
  const parent =
    connection.kind === "local" ? localParent(path) : remoteParent(path);

  return (
    <div className="nc-sftp-pane">
      <div className="nc-sftp-pane-header">
        <Icon
          name={connection.kind === "local" ? "monitor" : "server"}
          size={13}
        />
        <span className="nc-sftp-pane-label">{connection.label}</span>
        <span className="nc-sftp-pane-path" title={path}>
          {path}
        </span>
        <button
          className="nc-sftp-pane-refresh"
          aria-label="刷新"
          title="刷新"
          onClick={() => void load(path)}
          disabled={busy}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>

      <div className="nc-sftp-pane-list" onContextMenu={openBlankMenu}>
        {error && <div className="nc-sftp-pane-error">{error}</div>}
        {!error && busy && rows.length === 0 && (
          <div className="nc-sftp-pane-hint">加载中...</div>
        )}
        {!error && !busy && rows.length === 0 && (
          <div className="nc-sftp-pane-hint">空目录</div>
        )}
        {!error && !isRoot && (
          <div
            className="nc-sftp-pane-row"
            onClick={() => void load(parent)}
          >
            <Icon name="folder" size={14} />
            <span>..</span>
          </div>
        )}
        {!error &&
          rows.map((row) => (
            <div
              key={row.name}
              className={
                selected === row.name
                  ? "nc-sftp-pane-row selected"
                  : "nc-sftp-pane-row"
              }
              onClick={() => {
                setSelected(row.name);
                if (row.isDir) void load(join(path, row.name));
              }}
              onContextMenu={(e) => openRowMenu(e, row)}
            >
              {row.isDir ? (
                <Icon name="folder" size={14} />
              ) : (
                <span className="nc-sftp-pane-row-filemark" />
              )}
              <span className="nc-sftp-pane-row-name">{row.name}</span>
            </div>
          ))}
      </div>

      {transfers.length > 0 && (
        <div className="nc-sftp-transfers">
          {transfers.map((t) => (
            <div key={t.id} className="nc-sftp-transfer">
              <span className="nc-sftp-transfer-name" title={t.name}>
                {t.name}
              </span>
              <div className="nc-sftp-transfer-bar">
                <div
                  className="nc-sftp-transfer-fill"
                  style={{
                    width:
                      t.total > 0
                        ? `${Math.min(100, (t.transferred / t.total) * 100)}%`
                        : "0%",
                  }}
                />
              </div>
              <button
                className="nc-sftp-transfer-cancel"
                title="取消传输"
                onClick={() => void api.sftpCancelTransfer(t.id)}
              >
                取消
              </button>
            </div>
          ))}
        </div>
      )}

      {menu && (
        <SftpContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {dialog?.type === "rename" && (
        <SftpPromptDialog
          title={`重命名 ${dialog.row.name}`}
          initial={dialog.row.name}
          confirmLabel="重命名"
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(v) => void runRename(dialog.row, v)}
        />
      )}
      {dialog?.type === "mkdir" && (
        <SftpPromptDialog
          title="新建文件夹"
          initial=""
          confirmLabel="创建"
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(v) => void runMkdir(v)}
        />
      )}
      {dialog?.type === "delete" && (
        <SftpDeleteDialog
          names={[dialog.row.name]}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onConfirm={() => void runDelete(dialog.row)}
        />
      )}
      {dialog?.type === "chmod" && (
        <SftpPermissionsDialog
          name={dialog.row.name}
          mode={dialog.mode}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onApply={(m) => void runChmod(dialog.row, m)}
        />
      )}
    </div>
  );
}
