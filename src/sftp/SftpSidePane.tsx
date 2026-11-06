/**
 * 终端侧栏 SFTP 面板：复用当前 SSH 会话已有的 SFTP 通道（不新开连接）。
 *
 * 对齐 Netcatty `components/SftpSidePanel.tsx` 的 SFTP 分支：
 * - 连接：由终端 SSH 会话 `sftp_connect_session` 派生（同一连接上的子系统），
 *   不重新认证 / 不新拨 TCP；
 * - 起始目录：优先跟随终端 OSC 7 上报的绝对路径（可列出时），否则回主目录；
 * - 呈现：单栏 `SftpPaneView variant="side"`（无面板标题头 + 5 列 + 侧栏工具行）；
 * - 生命周期：切换 SSH 会话 / 卸载 / 会话断开时关闭该 sftp 通道，
 *   过期的异步连接结果直接丢弃（attempt 代次守卫）。
 */

import { useEffect, useRef, useState } from "react";
import * as api from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import { getSettings, subscribeSettings } from "../settings/settingsStore";
import { SftpPaneView } from "./SftpPaneView";
import { SftpQueuePanel } from "./SftpQueuePanel";
import type { RemoteConnection } from "./sftpModel";

interface Props {
  /** 当前 SSH 会话 id；null = 未连接。 */
  sshSessionId: string | null;
  /** 终端 OSC 7 上报的目录（绝对路径时作为起始 / 跟随目标）。 */
  terminalCwd: string | null;
  /** 面板标签名（通常为主机名）。 */
  label: string;
  /** 右侧灰字（user@host:port）。 */
  meta: string;
  /** 来源主机 profile id（对齐 RemoteConnection.hostId）。 */
  hostId?: string;
  /** 「在终端中打开当前路径」（发送 cd）；缺省隐藏入口。 */
  onRevealInTerminal?: (path: string) => void;
  /** 「定位路径到终端」（SFTP 当前路径 → 终端 cd）；缺省隐藏按钮。 */
  onLocatePathInTerminal?: (path: string) => void;
}

export function SftpSidePane({
  sshSessionId,
  terminalCwd,
  label,
  meta,
  hostId,
  onRevealInTerminal,
  onLocatePathInTerminal,
}: Props) {
  const [connection, setConnection] = useState<RemoteConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  /** 跟随终端目录时下发给 SftpPaneView 的外部导航（key 递增触发）。 */
  const [externalPath, setExternalPath] = useState<{
    path: string;
    key: number;
  } | null>(null);
  const [followEnabled, setFollowEnabled] = useState(
    () => getSettings().sftpFollowTerminalCwd,
  );

  const attemptRef = useRef(0);
  const sftpIdRef = useRef<string | null>(null);
  const pathRef = useRef("/");

  useEffect(() => {
    setFollowEnabled(getSettings().sftpFollowTerminalCwd);
    return subscribeSettings(() =>
      setFollowEnabled(getSettings().sftpFollowTerminalCwd),
    );
  }, []);

  /** 打开 / 切换会话：先释放旧 sftp，再复用新 SSH 会话建 SFTP。 */
  useEffect(() => {
    const attempt = ++attemptRef.current;
    const previous = sftpIdRef.current;
    sftpIdRef.current = null;
    if (previous) void api.sftpClose(previous).catch(() => {});
    setConnection(null);
    setError("");
    setConnecting(false);

    if (!sshSessionId) {
      setError("SSH 会话未连接");
      return;
    }

    let disposed = false;
    setConnecting(true);
    void (async () => {
      try {
        const sftpId = await api.sftpConnectSession(sshSessionId);
        if (disposed || attempt !== attemptRef.current) {
          void api.sftpClose(sftpId).catch(() => {});
          return;
        }
        sftpIdRef.current = sftpId;

        let startPath = "";
        if (terminalCwd && terminalCwd.startsWith("/")) {
          try {
            await api.sftpList(sftpId, terminalCwd);
            startPath = terminalCwd;
          } catch {
            startPath = await api.sftpHome(sftpId);
          }
        } else {
          startPath = await api.sftpHome(sftpId);
        }
        if (disposed || attempt !== attemptRef.current) return;
        pathRef.current = startPath;
        setConnection({
          kind: "remote",
          sftpId,
          canExec: true,
          label,
          meta,
          path: startPath,
          os: "unknown",
          hostId,
          sessionId: sshSessionId,
        });
      } catch (e) {
        if (!disposed && attempt === attemptRef.current) {
          setError(userVisibleError(String(e)));
        }
      } finally {
        if (!disposed && attempt === attemptRef.current) setConnecting(false);
      }
    })();

    return () => {
      disposed = true;
      const id = sftpIdRef.current;
      sftpIdRef.current = null;
      if (id) void api.sftpClose(id).catch(() => {});
    };
    // label/meta/hostId 不参与重连：会话 id 才是连接身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshSessionId]);

  /** 跟随终端目录：终端 cwd 变化时触发一次外部导航（同路径不重复）。 */
  useEffect(() => {
    if (!connection || !followEnabled) return;
    if (!terminalCwd || !terminalCwd.startsWith("/")) return;
    if (terminalCwd === pathRef.current) return;
    setExternalPath({ path: terminalCwd, key: Date.now() });
  }, [connection, followEnabled, terminalCwd]);

  if (connecting) {
    return <div className="nc-side-panel-empty">正在复用 SSH 会话建立 SFTP…</div>;
  }
  if (error || !connection) {
    return (
      <div className="nc-side-panel-empty">{error || "SFTP 未连接"}</div>
    );
  }

  return (
    // 对齐 Netcatty SftpSidePanel：文件列表在上、传输队列固定在下（队列可拖高）。
    <div className="nc-side-sftp-stack">
      <SftpPaneView
        connection={connection}
        variant="side"
        terminalCwd={terminalCwd}
        onPathChange={(next) => {
          pathRef.current = next;
        }}
        onRevealInTerminal={onRevealInTerminal}
        onLocatePathInTerminal={onLocatePathInTerminal}
        externalPath={externalPath}
      />
      <SftpQueuePanel />
    </div>
  );
}
