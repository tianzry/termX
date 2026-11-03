/**
 * 已连接面板：标签头（名称 + 当前路径）+ 条目列表 + 文件操作。
 * 交互基准为 Netcatty SftpPaneFileList 右键菜单的 termX 范围子集：
 * - 远端行：下载（仅文件）/ 重命名 / 修改权限 / 删除；
 * - 本地行：重命名 / 删除；
 * - 空白处：新建文件夹（远端另有「上传文件」）。
 * 上传 / 下载统一入队传输队列（sftp_transfer_enqueue，阶段 B），
 * 进度 / 暂停 / 取消在 SftpQueuePanel 展示（不再有面板内传输条）；
 * 上传完成后自动刷新本面板列表。
 * 列头 / 排序 / 选择模型 / 虚拟化 / 面包屑留后续阶段；本地侧默认过滤隐藏文件。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as api from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { SftpEditorDialog } from "../editor/EditorDialog";
import { isKnownBinaryFile } from "../editor/editorFile";
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
  /** 内置编辑器目标行（非目录且非已知二进制扩展名才可打开）。 */
  const [editorRow, setEditorRow] = useState<Row | null>(null);
  /** 外部打开等操作的提示文本（远端临时路径等）。 */
  const [notice, setNotice] = useState("");
  /** 远端外部打开后的临时文件路径记录（key=远端路径），供后续「保存后回传」。 */
  const externalTemps = useRef(new Map<string, string>());

  const isRemote = connection.kind === "remote";
  const join = isRemote ? joinRemotePath : joinLocalPath;

  // 上传完成自动刷新：订阅本面板入队项的状态事件（经 client.ts，R1）。
  const pathRef = useRef(path);
  pathRef.current = path;
  const uploadSubs = useRef(new Map<string, () => void>());
  useEffect(() => {
    const subs = uploadSubs.current;
    return () => {
      for (const u of subs.values()) u();
      subs.clear();
    };
  }, []);

  const load = useCallback(
    async (target: string) => {
      setBusy(true);
      setError("");
      setNotice("");
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

  // ── 传输（入队到全局队列，进度在 SftpQueuePanel 展示） ──

  /** 订阅本面板入队的上传项，完成时刷新列表（终态即退订）。 */
  const watchUploads = (created: api.TransferItem[]) => {
    for (const item of created) {
      if (item.direction !== "upload") continue;
      void api.onSftpTransferUpdated(item.id, (it) => {
        if (it.status === "completed") {
          uploadSubs.current.get(it.id)?.();
          uploadSubs.current.delete(it.id);
          void load(pathRef.current);
        } else if (
          it.status === "failed" ||
          it.status === "cancelled" ||
          it.status === "skipped"
        ) {
          uploadSubs.current.get(it.id)?.();
          uploadSubs.current.delete(it.id);
        }
      }).then((u) => uploadSubs.current.set(item.id, u));
    }
  };

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
    try {
      await api.sftpTransferEnqueue([
        {
          sftp_id: connection.sftpId,
          direction: "download",
          local_path: local,
          remote_path: join(path, row.name),
        },
      ]);
    } catch (e) {
      setError(userVisibleError(String(e)));
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
    const items = picked.map((local) => ({
      sftp_id: connection.sftpId,
      direction: "upload" as const,
      local_path: local,
      remote_path: join(path, baseName(local)),
    }));
    try {
      // 单次入队 = 单批次：阶段 C 冲突「应用到全部」按批次生效。
      const created = await api.sftpTransferEnqueue(items);
      watchUploads(created);
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
  };

  // ── 外部打开（Netcatty downloadToTempAndOpen / openPath 等价） ──

  /** 外部打开：本地直接系统默认程序；远端先下载到临时目录再打开，
   *  并记录临时路径供后续「保存后回传」。 */
  const openExternal = async (row: Row) => {
    const full = join(path, row.name);
    try {
      if (connection.kind === "remote") {
        const temp = await api.sftpOpenExternal(connection.sftpId, full);
        externalTemps.current.set(full, temp);
        setNotice(
          `已下载到临时文件 ${temp} 并打开；编辑后请手动上传覆盖远端文件。`,
        );
      } else {
        await api.localOpenPath(full);
      }
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
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
      if (!row.isDir && !isKnownBinaryFile(row.name)) {
        menuItems.push({ label: "编辑", onClick: () => setEditorRow(row) });
      }
      if (!row.isDir) {
        menuItems.push({
          label: "外部打开",
          onClick: () => void openExternal(row),
        });
      }
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
        {!error && notice && (
          <div className="nc-sftp-pane-hint">{notice}</div>
        )}
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
              onDoubleClick={() => {
                // 双击文件 → 内置编辑器（对齐 Netcatty 打开动作；目录已由单击导航）。
                if (!row.isDir && !isKnownBinaryFile(row.name)) {
                  setEditorRow(row);
                }
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

      {editorRow && (
        <SftpEditorDialog
          target={{
            kind: isRemote ? "remote" : "local",
            sftpId: isRemote ? connection.sftpId : undefined,
            path: join(path, editorRow.name),
            name: editorRow.name,
          }}
          onClose={() => setEditorRow(null)}
        />
      )}
    </div>
  );
}
