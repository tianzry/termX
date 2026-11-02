/**
 * 已连接面板（骨架版）：标签头（名称 + 当前路径）+ 基础条目列表。
 * 仅用于验证连接流可用；列头 / 排序 / 选择 / 虚拟化 / 工具栏 / 面包屑
 * 在实现③补齐。本地侧默认过滤隐藏文件（对齐 Netcatty 默认）。
 */

import { useCallback, useEffect, useState } from "react";
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

interface Row {
  name: string;
  isDir: boolean;
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

  const isRoot =
    connection.kind === "local"
      ? localParent(path) === path
      : path === "/";
  const parent =
    connection.kind === "local" ? localParent(path) : remoteParent(path);
  const join = connection.kind === "local" ? joinLocalPath : joinRemotePath;

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

      <div className="nc-sftp-pane-list">
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
              className="nc-sftp-pane-row"
              onClick={() => {
                if (row.isDir) void load(join(path, row.name));
              }}
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
    </div>
  );
}
