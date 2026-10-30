/**
 * 应用外壳（按 netcatty 的界面结构组织）：
 *
 * ```
 * ┌ TopTabs：品牌 / 标签 / chrome 工具 ─────────────────────────┐
 * ├ HostSidebar ├ 主区：VaultHome（空闲）或 Workspace（会话）┤ AsidePanel ┤
 * └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * 会话与标签状态仍由 `Workspace` 持有；本文件只做外壳编排：
 * 主机与分组数据、侧栏开关、当前工具面板、以及「活动窗格」到
 * 串口 / Telnet / SFTP 的桥接。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Workspace, type WorkspaceHandle } from "./Workspace";
import type { PaneHandle } from "./TerminalPane";
import type { Tab } from "./workspaceModel";
import { TopTabs } from "./TopTabs";
import { HostSidebar } from "./HostSidebar";
import { VaultHome } from "./VaultHome";
import { AsidePanel } from "./AsidePanel";
import { SftpPanel } from "./SftpPanel";
import { SerialPanel } from "./SerialPanel";
import { TelnetPanel } from "./TelnetPanel";
import { ForwardPanel } from "./ForwardPanel";
import { ConnectionManager } from "./ConnectionManager";
import * as api from "./backend/client";
import type {
  Group,
  Profile,
  TermBridge,
  TerminalTransport,
} from "./backend/client";

type Tool = "sftp" | "serial" | "telnet" | "forward" | null;

const TOOL_TITLE: Record<Exclude<Tool, null>, string> = {
  sftp: "文件传输",
  serial: "串口",
  telnet: "Telnet",
  forward: "端口转发",
};

const SIDEBAR_KEY = "termx.sidebar.v1";

export default function App() {
  const workspaceRef = useRef<WorkspaceHandle>(null);
  const activePaneRef = useRef<PaneHandle | null>(null);
  /** 串口 / Telnet 面板绑定到「打开面板时处于活动状态的窗格」。 */
  const bridgeTargetRef = useRef<{
    pane: PaneHandle | null;
    transport: TerminalTransport | null;
  }>({ pane: null, transport: null });

  const [status, setStatus] = useState("就绪");
  const [activeSshSid, setActiveSshSid] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [showManager, setShowManager] = useState(false);
  const [sideOpen, setSideOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "0";
    } catch {
      return true;
    }
  });

  // 标签快照由 Workspace 发布
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  const onSnapshot = useCallback(
    (next: Tab[], active: string | null, pending: boolean) => {
      setTabs(next);
      setActiveTabId(active);
      setRestorePending(pending);
    },
    [],
  );

  // 主机 / 分组数据
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [nextProfiles, nextGroups] = await Promise.all([
        api.listProfiles(),
        api.listGroups(),
      ]);
      setProfiles(nextProfiles);
      setGroups(nextGroups);
    } catch {
      /* 首次启动或 DB 为空时忽略 */
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sideOpen ? "1" : "0");
    } catch {
      /* 忽略持久化失败 */
    }
  }, [sideOpen]);

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

  // 串口 / Telnet 侧栏面板通过该桥把会话绑定到窗格
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

  function openLocal() {
    workspaceRef.current?.newTab({ kind: "pty" });
  }

  function connect(profile: Profile) {
    workspaceRef.current?.newTab({
      kind: "ssh",
      profileId: profile.id,
      name: profile.name,
    });
  }

  function toggleTool(next: Exclude<Tool, null>) {
    if (tool === next) {
      setTool(null);
      return;
    }
    if (next === "serial" || next === "telnet") {
      workspaceRef.current?.ensureTab();
    }
    setTool(next);
  }

  return (
    <div className="nc-shell">
      <TopTabs
        tabs={tabs}
        activeTabId={activeTabId}
        status={status}
        sideOpen={sideOpen}
        tool={tool}
        onActivate={(id) => workspaceRef.current?.activateTab(id)}
        onClose={(id) => workspaceRef.current?.closeTab(id)}
        onRename={(id, title) => workspaceRef.current?.renameTab(id, title)}
        onNewTab={openLocal}
        onToggleSidebar={() => setSideOpen((v) => !v)}
        onOpenManager={() => setShowManager(true)}
        onToggleTool={toggleTool}
        onSplit={(dir) => workspaceRef.current?.split(dir)}
        onClosePane={() => workspaceRef.current?.closePane()}
        onRefresh={() => void loadData()}
      />

      {restorePending && (
        <div className="nc-restore">
          <span className="nc-restore-dot" />
          <span>发现上次会话记录，是否恢复标签与分屏布局？</span>
          <button onClick={() => workspaceRef.current?.acceptRestore()}>恢复</button>
          <button onClick={() => workspaceRef.current?.skipRestore()}>忽略并清空</button>
        </div>
      )}

      <div className="nc-body">
        {sideOpen && (
          <HostSidebar
            profiles={profiles}
            groups={groups}
            onConnect={connect}
            onLocal={openLocal}
            onOpenManager={() => setShowManager(true)}
          />
        )}

        <div className="nc-main">
          <div className={`nc-workspace${tabs.length === 0 ? " hidden" : ""}`}>
            <Workspace
              ref={workspaceRef}
              onActivePane={onActivePane}
              onStatus={setStatus}
              onSnapshot={onSnapshot}
            />
          </div>
          {tabs.length === 0 && (
            <VaultHome
              profiles={profiles}
              groups={groups}
              onConnect={connect}
              onLocal={openLocal}
              onOpenManager={() => setShowManager(true)}
            />
          )}
        </div>

        {tool && (
          <AsidePanel
            title={TOOL_TITLE[tool]}
            subtitle="工具面板"
            onClose={() => setTool(null)}
          >
            {tool === "sftp" && <SftpPanel sshSessionId={activeSshSid} />}
            {tool === "serial" && <SerialPanel bridge={bridge} />}
            {tool === "telnet" && <TelnetPanel bridge={bridge} />}
            {tool === "forward" && <ForwardPanel />}
          </AsidePanel>
        )}
      </div>

      {showManager && (
        <ConnectionManager
          profiles={profiles}
          onClose={() => setShowManager(false)}
          onConnect={(p) => {
            setShowManager(false);
            connect(p);
          }}
          onChanged={() => void loadData()}
        />
      )}
    </div>
  );
}
