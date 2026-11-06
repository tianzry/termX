/**
 * 已连接面板：面包屑（可点路径段 / 回根 / 回主目录）+ 工具行
 * （复制路径 / 新建文件夹 / 显示隐藏文件 / 刷新）+ 列头排序 + 条目列表 + 文件操作。
 * 交互基准为 Netcatty SftpPaneToolbar / SftpBreadcrumb / SftpPaneFileList 的
 * termX 范围子集：
 * - 单击选中，双击 / 回车进入目录（文件 → 内置编辑器，除非已知二进制）；
 * - 列头点选排序（名称 / 大小 / 修改时间，目录恒置顶）；
 * - 隐藏文件开关：本地看 hidden 属性，远端按点前缀约定；
 * - 右键菜单：远端行（下载/重命名/修改权限/删除）、本地行（重命名/删除）、
 *   空白处（新建文件夹，远端另有「上传文件」）。
 * 上传 / 下载统一入队传输队列（sftp_transfer_enqueue），
 * 进度 / 暂停 / 取消在 SftpQueuePanel 展示；上传完成后自动刷新本面板列表。
 * 跨栏拖放（阶段 B）：文件行可拖，拖到对面栏松手即入队传输队列——
 * 落点语义对齐 Netcatty：拖到目录行 = 放进该目录，拖到空白 = 当前目录；
 * 同侧拖拽在 dragover 阶段即被拒绝（no-drop 光标，等价取消）。
 * 拖出到桌面 / 视图切换 / 列显隐留后续阶段。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  Bookmark as BookmarkIcon,
  ClipboardCopy,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  List,
  ListTree,
  RefreshCw,
  Rows3,
  Search,
  Terminal as TerminalIcon,
  TerminalSquare,
} from "lucide-react";
import * as api from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { SftpEditorDialog } from "../editor/EditorDialog";
import { isKnownBinaryFile } from "../editor/editorFile";
import { useSettings } from "../settings/settingsStore";
import { Icon } from "../ui/icons";
import {
  breadcrumbSegments,
  buildDropTransferTasks,
  dropTargetPath,
  filterEntriesByName,
  filterHiddenEntries,
  formatEntryMtime,
  formatEntrySize,
  canExtractArchive,
  canExtractLocalArchive,
  isPathRoot,
  joinLocalPath,
  joinRemotePath,
  localParent,
  parseSftpDragPayload,
  parseSftpBookmarks,
  pathRoot,
  remoteParent,
  resolveBreadcrumbVisibleParts,
  rowTypeLabel,
  SFTP_DRAG_MIME,
  SFTP_GLOBAL_BOOKMARKS_STORAGE_KEY,
  SFTP_LEGACY_BOOKMARKS_STORAGE_KEY,
  SFTP_LOCAL_BOOKMARKS_STORAGE_KEY,
  sftpDragSideMime,
  sortSftpRows,
  canReorderSftpBookmark,
  createSftpBookmark,
  hasSftpBookmarkPath,
  moveSftpBookmark,
  renameSftpBookmark,
  resolveSftpLocateCdCommand,
  shouldToggleSftpBookmarkFromButton,
  toggleLocalSftpBookmark,
  type DropTransferTask,
  type PaneConnection,
  type SftpBookmark,
  type SftpDragPayload,
  type SftpSortField,
  type SftpSortOrder,
} from "./sftpModel";
import {
  SftpBookmarkDeleteDialog,
  SftpBookmarkPopover,
  SftpContextMenu,
  SftpDeleteDialog,
  SftpPermissionsDialog,
  SftpPromptDialog,
  type MenuItem,
} from "./SftpPaneDialogs";
import { SftpConflictDialog } from "./SftpConflictDialog";

interface Row {
  name: string;
  isDir: boolean;
  /** 本地条目类型（local_remove 的 expectedType 守卫）。 */
  kind?: "file" | "directory" | "symlink";
  size?: number;
  /** unix 秒；0 = 服务端未提供。 */
  mtime?: number;
  /** 本地 hidden 属性（远端无此属性，按点前缀约定判定）。 */
  hidden?: boolean;
  /** 远端所有者（user / group），侧栏 5 列布局展示。 */
  user?: string;
  group?: string;
}

type DialogState =
  | { type: "rename"; row: Row }
  | { type: "copy"; row: Row }
  | { type: "delete"; row: Row }
  | { type: "mkdir" }
  | { type: "newFile" }
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

/** 读取书签存储（存储不可用时按空列表；含旧版纯路径数据迁移）。 */
function readSftpBookmarks(key: string, legacyKey?: string): SftpBookmark[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return parseSftpBookmarks(raw);
    if (legacyKey) {
      const legacy = window.localStorage.getItem(legacyKey);
      if (legacy) {
        const migrated = parseSftpBookmarks(legacy);
        persistSftpBookmarks(key, migrated);
        return migrated;
      }
    }
    return [];
  } catch {
    return [];
  }
}

/** 写回书签（失败静默，仅本次生效）。 */
function persistSftpBookmarks(key: string, bookmarks: SftpBookmark[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(bookmarks));
  } catch {
    // 存储不可用时仅本次生效。
  }
}

interface Props {
  connection: PaneConnection;
  /** 导航成功后回写 tab 的当前路径（切 tab 再回来保持位置）。 */
  onPathChange: (path: string) => void;
  /** 双击行为 = 传输到另一侧时，把文件交给 SftpView 入队（同栏拖动载荷）。
   *  返回 false 表示无法传输（对侧无标签 / 同类型面板），调用方回落打开文件。 */
  onTransferFile?: (payload: SftpDragPayload) => boolean;
  /** 递增触发重新加载（对侧传输完成后刷新列表）。 */
  refreshKey?: number;
  /**
   * 呈现形态：
   * - full：全页 SFTP 标签页（既有视图，列/行/工具栏保持原样）；
   * - side：终端侧栏面板（对齐 Netcatty SftpSidePanel：无面板标题头、
   *   5 列含所有者、侧栏工具行顺序与 44px 行高）。
   */
  variant?: "full" | "side";
  /** 终端当前目录（侧栏「跳到终端目录」目标）。 */
  terminalCwd?: string | null;
  /**
   * 「定位路径到终端」：把 SFTP 当前路径作为终端工作目录（`cd -- '<path>'`）。
   * 缺省（本地 / 串口 / Telnet 等无 SSH 终端）时不渲染按钮。
   */
  onLocatePathInTerminal?: (path: string) => void;
  /** 外部触发导航（跟随终端目录）；key 变化时跳到 path。 */
  externalPath?: { path: string; key: number } | null;
}

export function SftpPaneView({
  connection,
  onPathChange,
  onTransferFile,
  refreshKey = 0,
  variant = "full",
  terminalCwd = null,
  onLocatePathInTerminal,
  externalPath = null,
}: Props) {
  const settings = useSettings();
  const side = variant === "side";
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
  /** 显示隐藏文件（本地看 hidden 属性，远端按点前缀约定）；初值取设置默认。 */
  const [showHidden, setShowHidden] = useState(settings.sftpShowHiddenFiles);
  /** 名称过滤（对齐 Netcatty 工具栏 filter）：不改变底层列表，仅影响渲染。 */
  const [showFilter, setShowFilter] = useState(false);
  const [filter, setFilter] = useState("");
  /** 侧栏形态：列表 / 树视图（对齐 Netcatty viewMode）。 */
  const [viewMode, setViewMode] = useState<"list" | "tree">("list");
  /** 侧栏形态：紧凑行高（对齐 Netcatty listDensity）。 */
  const [compact, setCompact] = useState(false);
  /** 侧栏书签：本机 + 全局（对齐 Netcatty 的 location / global 两套存储）。 */
  const [localBookmarks, setLocalBookmarks] = useState<SftpBookmark[]>(() =>
    readSftpBookmarks(
      SFTP_LOCAL_BOOKMARKS_STORAGE_KEY,
      SFTP_LEGACY_BOOKMARKS_STORAGE_KEY,
    ),
  );
  const [globalBookmarks, setGlobalBookmarks] = useState<SftpBookmark[]>(() =>
    readSftpBookmarks(SFTP_GLOBAL_BOOKMARKS_STORAGE_KEY),
  );
  /** 收藏弹层锚点（按钮 rect）与待确认删除的收藏。 */
  const [bookmarkMenu, setBookmarkMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [pendingBookmarkRemoval, setPendingBookmarkRemoval] =
    useState<SftpBookmark | null>(null);
  /** 树视图：已展开目录与其子项（按绝对路径索引）。 */
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
  const [treeChildren, setTreeChildren] = useState<Record<string, Row[]>>({});
  /** 列头排序状态（默认名称升序，目录恒置顶）。 */
  const [sortField, setSortField] = useState<SftpSortField>("name");
  const [sortOrder, setSortOrder] = useState<SftpSortOrder>("asc");
  /** 面包屑省略号菜单（被折叠的中间段）。 */
  const [crumbMenu, setCrumbMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  /** 跨栏拖放悬停：rowName = 悬停行（目录行高亮为落点）；null = 未悬停。 */
  const [dropHint, setDropHint] = useState<{ rowName: string | null } | null>(
    null,
  );

  const isRemote = connection.kind === "remote";
  const join = isRemote ? joinRemotePath : joinLocalPath;
  /** 同主机复制的同名冲突（复用 SftpConflictDialog 的 跳过/创建副本/替换 策略）。 */
  const [copyConflict, setCopyConflict] = useState<{
    src: string;
    dst: string;
    sftpId: string;
  } | null>(null);

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
      setSelected(null);
      setTreeExpanded(new Set());
      setTreeChildren({});
      try {
        if (connection.kind === "local") {
          const entries = await api.localListDir(target);
          setRows(
            entries.map((e) => ({
              name: e.name,
              isDir: e.kind === "directory" || e.link_target === "directory",
              kind: e.kind,
              size: e.size,
              mtime: e.mtime,
              hidden: e.hidden,
            })),
          );
        } else {
          const entries = await api.sftpList(connection.sftpId, target);
          setRows(
            entries.map((e) => ({
              name: e.name,
              isDir: e.is_dir,
              size: e.size,
              mtime: e.mtime,
              user: e.user ?? undefined,
              group: e.group ?? undefined,
            })),
          );
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

  // 外部触发导航（侧栏跟随终端目录）：key 变化且路径不同才跳转。
  useEffect(() => {
    if (!externalPath) return;
    if (externalPath.path === pathRef.current) return;
    void load(externalPath.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPath?.key]);

  // 设置里的隐藏文件默认值即时生效（覆盖面板内临时开关）。
  useEffect(() => {
    setShowHidden(settings.sftpShowHiddenFiles);
  }, [settings.sftpShowHiddenFiles]);

  // 对侧传输完成 → 刷新当前列表。
  useEffect(() => {
    if (refreshKey > 0) void load(pathRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // ── 导航 / 工具行（面包屑、排序、隐藏开关）──────────────

  /** 过滤 + 排序后的可见行（隐藏开关 / 列头排序不触发重新加载）。 */
  const visibleRows = useMemo(
    () =>
      sortSftpRows(
        filterEntriesByName(filterHiddenEntries(rows, showHidden), filter),
        sortField,
        sortOrder,
      ),
    [rows, showHidden, filter, sortField, sortOrder],
  );

  /** 双击 / 回车激活：目录进入；文件按设置「打开」或「传输到另一侧」。 */
  const activateRow = (row: Row) => {
    if (row.isDir) {
      void load(join(path, row.name));
      return;
    }
    if (settings.sftpDoubleClickBehavior === "transfer" && onTransferFile) {
      const handled = onTransferFile({
        side: connection.kind,
        sftpId: connection.kind === "remote" ? connection.sftpId : undefined,
        fromPath: path,
        names: [row.name],
      });
      if (handled) return;
    }
    if (!isKnownBinaryFile(row.name)) setEditorRow(row);
  };

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    if (selected === "..") {
      if (!isPathRoot(path)) {
        void load(
          connection.kind === "local" ? localParent(path) : remoteParent(path),
        );
      }
      return;
    }
    const row = visibleRows.find((r) => r.name === selected);
    if (row) activateRow(row);
  };

  /** 回主目录（本地 local_home / 远端 sftp_home）。 */
  const goHome = async () => {
    try {
      const home =
        connection.kind === "local"
          ? await api.localHome()
          : await api.sftpHome(connection.sftpId);
      void load(home);
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
  };

  /** 复制当前路径（Netcatty copyPath 工具项）。 */
  const copyCurrentPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setNotice("已复制当前路径");
    } catch {
      setNotice("复制失败：剪贴板不可用");
    }
  };

  /** 列头点选：同字段切换方向，换字段回到升序。 */
  const toggleSort = (field: SftpSortField) => {
    if (sortField === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const { segments } = useMemo(() => breadcrumbSegments(path), [path]);
  const { visibleParts, hiddenParts, needsTruncation } = useMemo(
    () => resolveBreadcrumbVisibleParts({ segments, maxVisibleParts: 4 }),
    [segments],
  );
  const showEllipsis = needsTruncation && hiddenParts.length > 0;
  const root = pathRoot(path);
  const atRoot = isPathRoot(path);
  const parent =
    connection.kind === "local" ? localParent(path) : remoteParent(path);
  /** 「定位路径到终端」的 cd 命令；null = 当前路径不可注入（按钮禁用）。 */
  const locateTarget = resolveSftpLocateCdCommand(path);

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

  // ── 跨栏拖放（远端→本地 = 下载入队；本地→远端 = 上传入队） ──

  /** 行 dragstart：仅文件可拖（传输队列只支持单文件传输）。 */
  const onRowDragStart = (e: ReactDragEvent, row: Row) => {
    if (row.isDir) return;
    const payload: SftpDragPayload = {
      side: connection.kind,
      sftpId: connection.kind === "remote" ? connection.sftpId : undefined,
      fromPath: path,
      names: [row.name],
    };
    e.dataTransfer.setData(SFTP_DRAG_MIME, JSON.stringify(payload));
    // 侧标记：dragover 阶段可读 types，目标栏据此拒绝同侧拖拽。
    e.dataTransfer.setData(sftpDragSideMime(connection.kind), "");
    e.dataTransfer.effectAllowed = "copy";
    setSelected(row.name);
  };

  /** 跨栏拖拽中（且非本栏自身发起）：此时本栏才接受 drop。 */
  const isCrossPaneDrag = (e: ReactDragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    return (
      types.includes(SFTP_DRAG_MIME) &&
      !types.includes(sftpDragSideMime(connection.kind))
    );
  };

  /** 从事件目标取悬停行（data-sftp-row）；空白处返回 null。 */
  const rowNameFromEvent = (e: ReactDragEvent): string | null => {
    const el = (e.target as HTMLElement).closest("[data-sftp-row]");
    return el?.getAttribute("data-sftp-row") ?? null;
  };

  /** drop 入队：走既有传输队列（冲突策略沿用阶段 C），上传完成刷新。 */
  const enqueueDropTasks = async (tasks: DropTransferTask[]) => {
    try {
      const created = await api.sftpTransferEnqueue(tasks);
      watchUploads(created);
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
  };

  const onListDragOver = (e: ReactDragEvent) => {
    if (!isCrossPaneDrag(e)) return; // 同侧 / OS 文件等拖拽：不接受（系统 no-drop）
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const rowName = rowNameFromEvent(e);
    setDropHint((prev) =>
      prev !== null && prev.rowName === rowName ? prev : { rowName },
    );
  };

  const onListDragLeave = (e: ReactDragEvent) => {
    if (!isCrossPaneDrag(e)) return;
    const next = e.relatedTarget as Node | null;
    if (next !== null && e.currentTarget.contains(next)) return;
    setDropHint(null);
  };

  const onListDrop = (e: ReactDragEvent) => {
    if (!isCrossPaneDrag(e)) return;
    e.preventDefault();
    const rowName = rowNameFromEvent(e);
    setDropHint(null);
    const payload = parseSftpDragPayload(
      e.dataTransfer.getData(SFTP_DRAG_MIME),
    );
    if (!payload) return;
    const hoverRow = visibleRows.find((r) => r.name === rowName) ?? null;
    const targetDir = dropTargetPath(path, hoverRow, join);
    const tasks = buildDropTransferTasks({
      payload,
      destKind: connection.kind,
      destSftpId: connection.kind === "remote" ? connection.sftpId : undefined,
      targetDir,
    });
    if (!tasks || tasks.length === 0) return;
    void enqueueDropTasks(tasks);
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
    // 对齐 Netcatty 的重命名语义：空名（trim 后）或与原名相同都视为取消，
    // 不发请求、不显示错误（服务端对 old == new 会直接返回 Failure）。
    const trimmed = newName.trim();
    if (!trimmed || trimmed === row.name) {
      setDialogError("");
      setDialog(null);
      return;
    }
    setDialogBusy(true);
    setDialogError("");
    try {
      if (connection.kind === "remote") {
        await api.sftpRename(
          connection.sftpId,
          join(path, row.name),
          join(path, trimmed),
        );
      } else {
        await api.localRename(join(path, row.name), join(path, trimmed));
      }
      setDialog(null);
      void load(path);
    } catch (e) {
      setDialogError(userVisibleError(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };

  /** 默认副本名：`a.txt` → `a 副本.txt`。 */
  const copySuggestion = (name: string): string => {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return `${name} 副本`;
    return `${name.slice(0, dot)} 副本${name.slice(dot)}`;
  };

  const doCopy = async (sftpId: string, src: string, dst: string) => {
    setDialogBusy(true);
    setDialogError("");
    try {
      await api.sftpCopy(sftpId, src, dst);
      setCopyConflict(null);
      setDialog(null);
      void load(path);
    } catch (e) {
      setDialogError(userVisibleError(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };

  /** 同主机复制入口：目标存在时交给既有冲突策略（跳过 / 创建副本 / 替换）。 */
  const runCopy = async (row: Row, target: string) => {
    if (connection.kind !== "remote") return;
    const raw = target.trim();
    if (!raw) return;
    const sftpId = connection.sftpId;
    const src = join(path, row.name);
    const dst = raw.startsWith("/") ? raw : join(path, raw);
    setDialogBusy(true);
    setDialogError("");
    try {
      const existing = await api.sftpStat(sftpId, dst).catch(() => null);
      if (existing) {
        setCopyConflict({ src, dst, sftpId });
        setDialog(null);
        return;
      }
      await doCopy(sftpId, src, dst);
    } catch (e) {
      setDialogError(userVisibleError(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };

  /** 「创建副本」：按 `name (1)`、`name (2)` … 找第一个空位。 */
  const copyWithUniqueName = async (sftpId: string, src: string, dst: string) => {
    const slash = dst.lastIndexOf("/");
    const dir = slash >= 0 ? dst.slice(0, slash) : "";
    const name = dst.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = dst;
    for (let i = 1; i <= 100; i += 1) {
      const probe = `${dir}/${stem} (${i})${ext}`;
      const stat = await api.sftpStat(sftpId, probe).catch(() => null);
      if (!stat) {
        candidate = probe;
        break;
      }
    }
    await doCopy(sftpId, src, candidate);
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

  /** 新建空文件（对齐 Netcatty newFile）：远端走 sftp_write_file，本地走 local_write_file。 */
  const runNewFile = async (name: string) => {
    setDialogBusy(true);
    setDialogError("");
    try {
      const target = join(path, name);
      // 先探测同名文件：写入是整体覆盖，已存在时必须拦下，避免静默清空既有内容。
      const exists = await (
        connection.kind === "remote"
          ? api.sftpLstat(connection.sftpId, target)
          : api.localStat(target, false)
      ).then(
        () => true,
        () => false,
      );
      if (exists) {
        setDialogError("同名文件已存在");
        return;
      }
      if (connection.kind === "remote") {
        await api.sftpWriteFile(connection.sftpId, target, new Uint8Array());
      } else {
        await api.localWriteFile(target, new Uint8Array());
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

  /** #24 归档解压：远端原地解压到归档所在目录，完成后刷新。 */
  const runExtract = async (row: Row) => {
    if (connection.kind !== "remote") return;
    try {
      setError("");
      await api.sftpExtractArchive(connection.sftpId, join(path, row.name));
      void load(path);
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
  };

  /** #31 本地归档解压：原地解压到归档所在目录，完成后刷新。 */
  const runExtractLocal = async (row: Row) => {
    if (connection.kind !== "local") return;
    try {
      setError("");
      await api.localExtractArchive(join(path, row.name));
      void load(path);
    } catch (e) {
      setError(userVisibleError(String(e)));
    }
  };

  // ── 右键菜单 ───────────────────────────────────────────

  const openRowMenu = (e: ReactMouseEvent, row: Row) => {
    e.preventDefault();
    setSelected(row.name);
    setMenu({ x: e.clientX, y: e.clientY, row });
  };
  const openBlankMenu = (e: ReactMouseEvent) => {
    // 行右键会冒泡到列表容器，这里必须放行，否则行菜单会被空白菜单覆盖。
    if ((e.target as HTMLElement).closest("[data-sftp-row]")) return;
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
      if (canExtractLocalArchive(connection, row.name) && !row.isDir) {
        menuItems.push({ label: "解压到当前目录", onClick: () => void runExtractLocal(row) });
      }
      if (isRemote && !row.isDir) {
        menuItems.push({ label: "下载", onClick: () => void runDownload(row) });
        menuItems.push({
          label: "复制到…",
          onClick: () => {
            setDialogError("");
            setDialog({ type: "copy", row });
          },
        });
        if (canExtractArchive(connection, row.name)) {
          menuItems.push({ label: "解压到当前目录", onClick: () => void runExtract(row) });
        }
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
      // 对齐 Netcatty 空白区右键顺序：刷新 / 新建文件夹 / 新建文件 / 上传文件
      menuItems.push({ label: "刷新", onClick: () => void load(path) });
      menuItems.push({
        label: "新建文件夹",
        onClick: () => {
          setDialogError("");
          setDialog({ type: "mkdir" });
        },
      });
      menuItems.push({
        label: "新建文件",
        onClick: () => {
          setDialogError("");
          setDialog({ type: "newFile" });
        },
      });
      if (isRemote) {
        menuItems.push({ label: "上传文件", onClick: () => void runUpload() });
      }
    }
  }

  // ── 渲染 ───────────────────────────────────────────────

  // ── 收藏（对齐 Netcatty SftpPaneView 的 toggle / addGlobal / 管理逻辑）──

  /** 合并列表：全局在前、本机在后。 */
  const mergedBookmarks = useMemo(
    () => [...globalBookmarks, ...localBookmarks],
    [globalBookmarks, localBookmarks],
  );
  const isCurrentPathBookmarked = hasSftpBookmarkPath(mergedBookmarks, path);
  const isCurrentPathGlobalBookmarked = hasSftpBookmarkPath(
    globalBookmarks,
    path,
  );

  const updateLocalBookmarks = (next: SftpBookmark[]) => {
    setLocalBookmarks(next);
    persistSftpBookmarks(SFTP_LOCAL_BOOKMARKS_STORAGE_KEY, next);
  };
  const updateGlobalBookmarks = (next: SftpBookmark[]) => {
    setGlobalBookmarks(next);
    persistSftpBookmarks(SFTP_GLOBAL_BOOKMARKS_STORAGE_KEY, next);
  };

  /** 顶部动作：全局独有 → 删除全局；否则切换本地收藏（Netcatty toggleBookmark）。 */
  const toggleBookmark = () => {
    if (isCurrentPathGlobalBookmarked && !hasSftpBookmarkPath(localBookmarks, path)) {
      const bookmark = globalBookmarks.find((item) => item.path === path);
      if (bookmark) setPendingBookmarkRemoval(bookmark);
      return;
    }
    updateLocalBookmarks(toggleLocalSftpBookmark(localBookmarks, path));
  };

  const addGlobalBookmark = () => {
    if (isCurrentPathGlobalBookmarked) return;
    updateGlobalBookmarks([
      ...globalBookmarks,
      createSftpBookmark(path, { global: true }),
    ]);
  };

  const deleteBookmark = (bookmark: SftpBookmark) => {
    if (bookmark.global) {
      updateGlobalBookmarks(
        globalBookmarks.filter((item) => item.id !== bookmark.id),
      );
    } else {
      updateLocalBookmarks(
        localBookmarks.filter((item) => item.id !== bookmark.id),
      );
    }
  };

  const reorderBookmark = (from: SftpBookmark, to: SftpBookmark) => {
    if (!canReorderSftpBookmark(from, to)) return;
    if (from.global) {
      updateGlobalBookmarks(moveSftpBookmark(globalBookmarks, from.id, to.id));
    } else {
      updateLocalBookmarks(moveSftpBookmark(localBookmarks, from.id, to.id));
    }
  };

  const renameBookmark = (bookmark: SftpBookmark, label: string) => {
    if (bookmark.global) {
      updateGlobalBookmarks(
        renameSftpBookmark(globalBookmarks, bookmark.id, label),
      );
    } else {
      updateLocalBookmarks(renameSftpBookmark(localBookmarks, bookmark.id, label));
    }
  };

  /** 侧栏书签按钮：无收藏时直加当前路径，否则开合收藏弹层（对齐 Netcatty）。 */
  const handleBookmarkClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (bookmarkMenu) {
      setBookmarkMenu(null);
      return;
    }
    if (
      shouldToggleSftpBookmarkFromButton({
        bookmarkCount: mergedBookmarks.length,
        isCurrentPathBookmarked,
      })
    ) {
      updateLocalBookmarks(toggleLocalSftpBookmark(localBookmarks, path));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setBookmarkMenu({ x: rect.left, y: rect.bottom + 4 });
  };

  /** 树视图展开 / 收起目录（首次展开时才拉子项）。 */
  async function toggleTreeDir(dir: string) {
    if (treeExpanded.has(dir)) {
      const next = new Set(treeExpanded);
      next.delete(dir);
      setTreeExpanded(next);
      return;
    }
    if (!treeChildren[dir] && connection.kind === "remote") {
      try {
        const entries = await api.sftpList(connection.sftpId, dir);
        setTreeChildren((prev) => ({
          ...prev,
          [dir]: entries.map((e) => ({
            name: e.name,
            isDir: e.is_dir,
            size: e.size,
            mtime: e.mtime,
            user: e.user ?? undefined,
            group: e.group ?? undefined,
          })),
        }));
      } catch (e) {
        setError(userVisibleError(String(e)));
        return;
      }
    }
    setTreeExpanded(new Set([...treeExpanded, dir]));
  }

  const fileIconClass = (name: string): string =>
    /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst|tzst|tar|zip|gz|bz2|xz|7z|rar)$/i.test(
      name,
    )
      ? "archive"
      : "file";

  const sortArrow = (field: SftpSortField) =>
    sortField === field ? (
      <Icon name={sortOrder === "asc" ? "arrow-up" : "arrow-down"} size={11} />
    ) : null;

  /** 行 className：选中态 + 跨栏拖放悬停时的落点目录高亮。 */
  const rowClasses = (row: Row): string => {
    const cls = ["nc-sftp-pane-row"];
    if (selected === row.name) cls.push("selected");
    if (dropHint?.rowName === row.name && row.isDir) cls.push("drop-target");
    return cls.join(" ");
  };

  /** 单行渲染（列表 / 树共用；侧栏多第 5 列所有者）。 */
  const renderRow = (
    row: Row,
    key: string,
    depth = 0,
    leading?: React.ReactNode,
  ) => (
    <div
      key={key}
      className={rowClasses(row)}
      draggable={!row.isDir}
      data-sftp-row={row.name}
      onClick={() => setSelected(row.name)}
      onDoubleClick={() => activateRow(row)}
      onContextMenu={(e) => openRowMenu(e, row)}
      onDragStart={(e) => onRowDragStart(e, row)}
    >
      <span
        className="nc-sftp-pane-row-cell-name"
        style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
      >
        {leading}
        {side ? (
          <span
            className={`nc-sftp-row-icon ${row.isDir ? "dir" : fileIconClass(row.name)}`}
          >
            <Icon name={row.isDir ? "folder" : "file"} size={14} />
          </span>
        ) : row.isDir ? (
          <Icon name="folder" size={14} />
        ) : (
          <span className="nc-sftp-pane-row-filemark" />
        )}
        <span className="nc-sftp-pane-row-name">{row.name}</span>
      </span>
      <span className="nc-sftp-pane-row-cell-num">
        {formatEntryMtime(row.mtime)}
      </span>
      <span className="nc-sftp-pane-row-cell-num">
        {side && row.isDir ? "--" : formatEntrySize(row.size)}
      </span>
      <span className="nc-sftp-pane-row-cell-num">{rowTypeLabel(row)}</span>
      {side && (
        <span className="nc-sftp-pane-row-cell-owner">
          {row.user ?? row.group ?? "--"}
        </span>
      )}
    </div>
  );

  /** 树视图：递归渲染（过滤 / 排序对每一层生效）。 */
  const renderTreeRows = (items: Row[], dir: string, depth: number): React.ReactNode[] =>
    sortSftpRows(
      filterEntriesByName(filterHiddenEntries(items, showHidden), filter),
      sortField,
      sortOrder,
    ).flatMap((row) => {
      const fullPath = join(dir, row.name);
      const expanded = row.isDir && treeExpanded.has(fullPath);
      const node = renderRow(
        row,
        fullPath,
        depth,
        row.isDir ? (
          <button
            className="nc-sftp-tree-toggle"
            aria-label={expanded ? "收起目录" : "展开目录"}
            onClick={(e) => {
              e.stopPropagation();
              void toggleTreeDir(fullPath);
            }}
          >
            <Icon name={expanded ? "chevron-down" : "chevron-right"} size={11} />
          </button>
        ) : (
          <span className="nc-sftp-tree-toggle-spacer" />
        ),
      );
      return expanded
        ? [node, ...renderTreeRows(treeChildren[fullPath] ?? [], fullPath, depth + 1)]
        : [node];
    });

  return (
    <div
      className={[
        "nc-sftp-pane",
        side ? "nc-sftp-sidepanel" : "",
        side && compact ? "nc-sftp-sidepanel-dense" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* 面包屑行：回主目录 / 回根 / 可点路径段（超长折叠中间段进省略号） */}
      <div className="nc-sftp-toolbar">
        <button
          className="nc-sftp-toolbar-btn"
          aria-label="回主目录"
          title="回主目录"
          onClick={() => void goHome()}
        >
          <Icon name="home" size={13} />
        </button>
        {root !== null && (
          <button
            className="nc-sftp-toolbar-btn nc-sftp-toolbar-root"
            aria-label="回根目录"
            title={atRoot ? "已在根目录" : `回到 ${root}`}
            onClick={() => void load(root)}
            disabled={atRoot}
          >
            {root}
          </button>
        )}
        <div className="nc-sftp-breadcrumb">
          {visibleParts.map((part, i) => (
            <Fragment key={part.segment.path}>
              {i > 0 && (
                <Icon
                  name="chevron-right"
                  size={12}
                  className="nc-sftp-breadcrumb-sep"
                />
              )}
              {i === 1 && showEllipsis && (
                <>
                  <button
                    className="nc-sftp-breadcrumb-seg"
                    title="展开被折叠的路径段"
                    onClick={(e) =>
                      setCrumbMenu({ x: e.clientX, y: e.clientY })
                    }
                  >
                    …
                  </button>
                  <Icon
                    name="chevron-right"
                    size={12}
                    className="nc-sftp-breadcrumb-sep"
                  />
                </>
              )}
              <button
                className={
                  part.originalIndex === segments.length - 1
                    ? "nc-sftp-breadcrumb-seg current"
                    : "nc-sftp-breadcrumb-seg"
                }
                title={part.segment.path}
                onClick={() => void load(part.segment.path)}
              >
                {part.segment.label}
              </button>
            </Fragment>
          ))}
        </div>
      </div>

      {/* 动作行（侧栏顺序对齐 Netcatty：书签 / 跳到终端目录 / 复制路径 /
          视图 / 密度 / 过滤 / 新建文件夹 / 新建文件 / 隐藏 / 刷新） */}
      {side ? (
        <div className="nc-sftp-toolbar nc-sftp-actions-side">
          <button
            className={
              "nc-sftp-toolbar-btn" +
              (isCurrentPathBookmarked ? " bookmarked" : "") +
              (mergedBookmarks.length > 0 && !isCurrentPathBookmarked
                ? " has-bookmarks"
                : "")
            }
            aria-label="收藏"
            title={
              isCurrentPathBookmarked ? "取消收藏当前路径" : "收藏当前路径"
            }
            aria-pressed={isCurrentPathBookmarked}
            onClick={handleBookmarkClick}
          >
            <BookmarkIcon
              size={14}
              fill={isCurrentPathBookmarked ? "currentColor" : "none"}
            />
          </button>
          <button
            className="nc-sftp-toolbar-btn"
            aria-label="跳到终端目录"
            title={
              terminalCwd
                ? `跳到终端目录 ${terminalCwd}`
                : "终端目录未知"
            }
            disabled={!terminalCwd}
            onClick={() => {
              if (terminalCwd) void load(terminalCwd);
            }}
          >
            <TerminalSquare size={14} />
          </button>
          {onLocatePathInTerminal && (
            <button
              className="nc-sftp-toolbar-btn"
              aria-label="定位路径到终端"
              title={
                locateTarget
                  ? `在终端中 cd 到 ${path}`
                  : "当前路径不支持定位到终端"
              }
              disabled={!locateTarget}
              onClick={() => {
                if (locateTarget) onLocatePathInTerminal(path);
              }}
            >
              <TerminalIcon size={14} />
            </button>
          )}
          <button
            className="nc-sftp-toolbar-btn"
            aria-label="复制当前路径"
            title="复制当前路径"
            onClick={() => void copyCurrentPath()}
          >
            <ClipboardCopy size={14} />
          </button>
          <button
            className={
              viewMode === "tree"
                ? "nc-sftp-toolbar-btn active"
                : "nc-sftp-toolbar-btn"
            }
            aria-label="切换视图"
            title={viewMode === "tree" ? "切换到列表视图" : "切换到树视图"}
            onClick={() => setViewMode((v) => (v === "tree" ? "list" : "tree"))}
          >
            {viewMode === "tree" ? <ListTree size={14} /> : <List size={14} />}
          </button>
          <button
            className={
              compact ? "nc-sftp-toolbar-btn active" : "nc-sftp-toolbar-btn"
            }
            aria-label="切换行密度"
            title={compact ? "切换到标准行高" : "切换到紧凑行高"}
            onClick={() => setCompact((v) => !v)}
          >
            <Rows3 size={14} />
          </button>
          <button
            className={
              showFilter ? "nc-sftp-toolbar-btn active" : "nc-sftp-toolbar-btn"
            }
            aria-label="按名称过滤"
            title="按名称过滤"
            onClick={() => setShowFilter((v) => !v)}
          >
            <Search size={14} />
          </button>
          <button
            className="nc-sftp-toolbar-btn"
            aria-label="新建文件夹"
            title="新建文件夹"
            onClick={() => {
              setDialogError("");
              setDialog({ type: "mkdir" });
            }}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="nc-sftp-toolbar-btn"
            aria-label="新建文件"
            title="新建文件"
            onClick={() => {
              setDialogError("");
              setDialog({ type: "newFile" });
            }}
          >
            <FilePlus size={14} />
          </button>
          <button
            className={
              showHidden
                ? "nc-sftp-toolbar-btn active"
                : "nc-sftp-toolbar-btn"
            }
            aria-label="显示隐藏文件"
            title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <div className="nc-sftp-toolbar-spacer" />
          <button
            className="nc-sftp-toolbar-btn"
            aria-label="刷新"
            title="刷新"
            onClick={() => void load(path)}
            disabled={busy}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      ) : (
        <div className="nc-sftp-toolbar">
          <button
            className="nc-sftp-toolbar-btn"
            title="复制当前路径"
            onClick={() => void copyCurrentPath()}
          >
            <ClipboardCopy size={14} />
          </button>
          <button
            className={
              showFilter ? "nc-sftp-toolbar-btn active" : "nc-sftp-toolbar-btn"
            }
            title="按名称过滤"
            onClick={() => setShowFilter((v) => !v)}
          >
            <Search size={14} />
          </button>
          <button
            className="nc-sftp-toolbar-btn"
            title="新建文件夹"
            onClick={() => {
              setDialogError("");
              setDialog({ type: "mkdir" });
            }}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="nc-sftp-toolbar-btn"
            title="新建文件"
            onClick={() => {
              setDialogError("");
              setDialog({ type: "newFile" });
            }}
          >
            <FilePlus size={14} />
          </button>
          <button
            className={
              showHidden
                ? "nc-sftp-toolbar-btn active"
                : "nc-sftp-toolbar-btn"
            }
            title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <div className="nc-sftp-toolbar-spacer" />
          <button
            className="nc-sftp-toolbar-btn"
            aria-label="刷新"
            title="刷新"
            onClick={() => void load(path)}
            disabled={busy}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      )}

      {showFilter && (
        <div className="nc-sftp-filter">
          <Icon name="search" size={12} />
          <input
            autoFocus
            value={filter}
            placeholder="按名称过滤"
            aria-label="按名称过滤"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                setShowFilter(false);
              }
            }}
          />
          {filter && (
            <button
              className="nc-sftp-filter-clear"
              title="清除过滤"
              onClick={() => setFilter("")}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      )}

      {/* 列头：点选排序（目录恒置顶）；列序对齐 Netcatty：名称 / 修改时间 / 大小 / 类型 */}
      <div className="nc-sftp-cols">
        <button className="nc-sftp-col" onClick={() => toggleSort("name")}>
          名称 {sortArrow("name")}
        </button>
        <button className="nc-sftp-col" onClick={() => toggleSort("modified")}>
          修改时间 {sortArrow("modified")}
        </button>
        <button
          className="nc-sftp-col nc-sftp-col-num"
          onClick={() => toggleSort("size")}
        >
          大小 {sortArrow("size")}
        </button>
        <button
          className="nc-sftp-col nc-sftp-col-num"
          onClick={() => toggleSort("type")}
        >
          类型 {sortArrow("type")}
        </button>
        {side && <span className="nc-sftp-col nc-sftp-col-owner">所有者</span>}
      </div>

      <div
        className={
          dropHint !== null
            ? "nc-sftp-pane-list drop-active"
            : "nc-sftp-pane-list"
        }
        tabIndex={0}
        onContextMenu={openBlankMenu}
        onKeyDown={onListKeyDown}
        onDragOver={onListDragOver}
        onDragLeave={onListDragLeave}
        onDrop={onListDrop}
      >
        {error && <div className="nc-sftp-pane-error">{error}</div>}
        {!error && notice && (
          <div className="nc-sftp-pane-hint">{notice}</div>
        )}
        {!error && busy && rows.length === 0 && (
          <div className="nc-sftp-pane-hint">加载中...</div>
        )}
        {!error && !busy && visibleRows.length === 0 && (
          <div className="nc-sftp-pane-hint">空目录</div>
        )}
        {!error && !atRoot && (
          <div
            className={
              selected === ".."
                ? "nc-sftp-pane-row selected"
                : "nc-sftp-pane-row"
            }
            onClick={() => setSelected("..")}
            onDoubleClick={() => void load(parent)}
          >
            <span className="nc-sftp-pane-row-cell-name">
              {side ? (
                <span className="nc-sftp-row-icon dir">
                  <Icon name="folder" size={14} />
                </span>
              ) : (
                <Icon name="folder" size={14} />
              )}
              <span className="nc-sftp-pane-row-name">..</span>
            </span>
            <span className="nc-sftp-pane-row-cell-num" />
            <span className="nc-sftp-pane-row-cell-num" />
            <span className="nc-sftp-pane-row-cell-num">
              {side ? "folder" : ""}
            </span>
            {side && <span className="nc-sftp-pane-row-cell-owner">--</span>}
          </div>
        )}
        {!error &&
          (side && viewMode === "tree"
            ? renderTreeRows(visibleRows, path, 0)
            : visibleRows.map((row) => renderRow(row, row.name)))}
      </div>

      {/* 底部状态栏（对齐 Netcatty SftpPaneFileList）：左侧项数/选中数，右侧当前路径 */}
      <div className="nc-sftp-statusbar">
        <span>
          {visibleRows.length} 项
          {selected && selected !== ".." ? " · 已选 1" : ""}
        </span>
        <span className="nc-sftp-statusbar-path" title={path}>
          {path}
        </span>
      </div>

      {crumbMenu && (
        <SftpContextMenu
          x={crumbMenu.x}
          y={crumbMenu.y}
          items={hiddenParts.map((h) => ({
            label: h.segment.label,
            onClick: () => void load(h.segment.path),
          }))}
          onClose={() => setCrumbMenu(null)}
        />
      )}

      {menu && (
        <SftpContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {bookmarkMenu && (
        <SftpBookmarkPopover
          x={bookmarkMenu.x}
          y={bookmarkMenu.y}
          bookmarks={mergedBookmarks}
          currentPath={path}
          isCurrentPathBookmarked={isCurrentPathBookmarked}
          isCurrentPathGlobalBookmarked={isCurrentPathGlobalBookmarked}
          onToggle={toggleBookmark}
          onAddGlobal={addGlobalBookmark}
          onNavigate={(target) => void load(target)}
          onRequestDelete={(bookmark) => setPendingBookmarkRemoval(bookmark)}
          onReorder={reorderBookmark}
          onRename={renameBookmark}
          onClose={() => setBookmarkMenu(null)}
        />
      )}

      {pendingBookmarkRemoval && (
        <SftpBookmarkDeleteDialog
          bookmark={pendingBookmarkRemoval}
          onConfirm={() => {
            deleteBookmark(pendingBookmarkRemoval);
            setPendingBookmarkRemoval(null);
          }}
          onClose={() => setPendingBookmarkRemoval(null)}
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
      {dialog?.type === "copy" && (
        <SftpPromptDialog
          title={`复制 ${dialog.row.name} 到`}
          initial={copySuggestion(dialog.row.name)}
          confirmLabel="复制"
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(v) => void runCopy(dialog.row, v)}
        />
      )}
      {copyConflict && (
        <SftpConflictDialog
          conflict={
            {
              id: `copy-${copyConflict.dst}`,
              sftp_id: copyConflict.sftpId,
              batch_id: "copy",
              direction: "upload",
              // 复用现有对话框：标题取 local_path 的文件名，这里放目标名。
              local_path: copyConflict.dst,
              remote_path: copyConflict.dst,
              size: 0,
              status: "conflict",
              priority: "normal",
              seq: 0,
              overwrite: false,
              error: null,
              created_at: Date.now(),
            } as api.TransferItem
          }
          sameBatchCount={1}
          busy={dialogBusy}
          error={dialogError}
          onResolve={(action) => {
            if (action === "skip") {
              setCopyConflict(null);
              setDialogError("");
            } else if (action === "replace") {
              void doCopy(copyConflict.sftpId, copyConflict.src, copyConflict.dst);
            } else {
              void copyWithUniqueName(
                copyConflict.sftpId,
                copyConflict.src,
                copyConflict.dst,
              );
            }
          }}
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
      {dialog?.type === "newFile" && (
        <SftpPromptDialog
          title="新建文件"
          initial=""
          confirmLabel="创建"
          busy={dialogBusy}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(v) => void runNewFile(v)}
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
