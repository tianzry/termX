/**
 * 应用外壳：工具栏（新建终端 / 连接管理 / 侧栏开关）+ 工作区。
 *
 * 会话本身全部下沉到 `Workspace` 的终端窗格；这里只维护：
 * - 已保存的连接档案（快捷入口 / 连接管理弹窗）；
 * - 侧栏面板（SFTP / 串口 / Telnet / 端口转发）与「当前活动窗格」的桥接。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Workspace, type WorkspaceHandle } from "./Workspace";
import type { PaneHandle } from "./TerminalPane";
import { SftpPanel } from "./SftpPanel";
import { SerialPanel } from "./SerialPanel";
import { TelnetPanel } from "./TelnetPanel";
import { ForwardPanel } from "./ForwardPanel";
import { ConnectionManager } from "./ConnectionManager";
import * as api from "./backend/client";
import type {
  Profile,
  TermBridge,
  TerminalTransport,
} from "./backend/client";

export default function App() {
  const workspaceRef = useRef<WorkspaceHandle>(null);
  const activePaneRef = useRef<PaneHandle | null>(null);
  /** 串口 / Telnet 面板绑定到「打开面板时处于活动状态的窗格」。 */
  const bridgeTargetRef = useRef<{
    pane: PaneHandle | null;
    transport: TerminalTransport | null;
  }>({ pane: null, transport: null });

  const [status, setStatus] = useState("待命：新建终端或从连接管理连 SSH");
  const [activeSshSid, setActiveSshSid] = useState<string | null>(null);
  const [showSftp, setShowSftp] = useState(false);
  const [showSerial, setShowSerial] = useState(false);
  const [showTelnet, setShowTelnet] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [showManager, setShowManager] = useState(false);

  // 已保存的连接档案（由连接管理器维护，工具栏下方据此快速开新标签）
  const [profiles, setProfiles] = useState<Profile[]>([]);

  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await api.listProfiles());
    } catch {
      /* 首次启动或 DB 为空时忽略 */
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // 活动窗格变化：记录句柄，并跟随其 SSH 会话（SFTP 面板依赖）
  const [activeHandle, setActiveHandle] = useState<PaneHandle | null>(null);
  const onActivePane = useCallback((handle: PaneHandle | null) => {
    activePaneRef.current = handle;
    setActiveHandle(handle);
  }, []);

  useEffect(() => {
    if (!activeHandle) {
      setActiveSshSid(null);
      return;
    }
    setActiveSshSid(activeHandle.sshSessionId());
    return activeHandle.subscribeSession(setActiveSshSid);
  }, [activeHandle]);

  // 串口 / Telnet 侧栏面板通过该桥把会话绑定到窗格：
  // 面板持 session，窗格负责渲染输出、上行按键、resize。
  const bridge: TermBridge = {
    receive: (bytes) => bridgeTargetRef.current.pane?.write(bytes),
    attach: (t) => {
      const pane = activePaneRef.current;
      bridgeTargetRef.current = { pane, transport: t };
      pane?.attachTransport(t);
    },
    detach: () => {
      bridgeTargetRef.current.pane?.attachTransport(null);
      bridgeTargetRef.current = { pane: null, transport: null };
    },
    size: () =>
      (bridgeTargetRef.current.pane ?? activePaneRef.current)?.size() ?? null,
  };

  function toggleSerial() {
    setShowSerial((v) => {
      if (!v) workspaceRef.current?.ensureTab();
      return !v;
    });
  }

  function toggleTelnet() {
    setShowTelnet((v) => {
      if (!v) workspaceRef.current?.ensureTab();
      return !v;
    });
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button onClick={() => workspaceRef.current?.newTab({ kind: "pty" })}>
          新建终端
        </button>
        <button onClick={() => setShowManager(true)}>连接管理</button>
        <button
          onClick={toggleSerial}
          className={showSerial ? "active" : ""}
        >
          串口
        </button>
        <button
          onClick={toggleTelnet}
          className={showTelnet ? "active" : ""}
        >
          Telnet
        </button>
        <button
          onClick={() => setShowForward((v) => !v)}
          className={showForward ? "active" : ""}
        >
          端口转发
        </button>
        <button
          onClick={() => setShowSftp((v) => !v)}
          className={showSftp ? "active" : ""}
        >
          文件传输 (SFTP)
        </button>
        <span className="status">{status}</span>
      </header>

      <div className="profiles-bar">
        {profiles.length === 0 ? (
          <span className="hint">还没有连接，点「连接管理」新建。</span>
        ) : (
          profiles.map((p) => (
            <button
              key={p.id}
              className="profile-chip"
              onClick={() =>
                workspaceRef.current?.newTab({
                  kind: "ssh",
                  profileId: p.id,
                  name: p.name,
                })
              }
            >
              <span>{p.name}</span>
              <span className="profile-chip-sub">
                {p.host}:{p.port}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="main">
        <Workspace
          ref={workspaceRef}
          onActivePane={onActivePane}
          onStatus={setStatus}
        />
        {showSftp && <SftpPanel sshSessionId={activeSshSid} />}
        {showSerial && <SerialPanel bridge={bridge} />}
        {showTelnet && <TelnetPanel bridge={bridge} />}
        {showForward && <ForwardPanel />}
      </div>

      {showManager && (
        <ConnectionManager
          profiles={profiles}
          onClose={() => setShowManager(false)}
          onConnect={(p) => {
            setShowManager(false);
            workspaceRef.current?.newTab({
              kind: "ssh",
              profileId: p.id,
              name: p.name,
            });
          }}
          onChanged={loadProfiles}
        />
      )}
    </div>
  );
}
