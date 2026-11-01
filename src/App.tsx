/**
 * 应用外壳（按 netcatty 的界面结构组织）：
 *
 * ```
 * ┌ TopTabs：Vaults / SFTP / 会话标签 / 右侧工具 ───────────────┐
 * ├ 终端态：HostSidebar（288px）+ Workspace + 右侧工具面板 ─────┤
 * └ Vault 态：VaultView（208px 导航 + 圆角内容面板）────────────┘
 * ```
 *
 * 会话标签状态仍由 `Workspace` 持有；本文件负责根标签（Vaults / SFTP /
 * 终端）切换、主机与分组数据、工具面板，以及活动窗格到串口 / Telnet /
 * SFTP 的桥接。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Workspace, type WorkspaceHandle } from "./Workspace";
import type { PaneHandle } from "./TerminalPane";
import type { Tab } from "./workspaceModel";
import { TopTabs, type RootSurface } from "./TopTabs";
import { HostSidebar } from "./HostSidebar";
import { VaultView } from "./VaultView";
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
/** 最近连接记录（v1: { id, ts }[]），仅前端保存。 */
const RECENT_KEY = "termx.recent.v1";
const RECENT_LIMIT = 8;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is { id: string; ts: number } =>
        Boolean(x) && typeof (x as { id?: unknown }).id === "string",
      )
      .map((x) => x.id);
  } catch {
    return [];
  }
}

function saveRecent(id: string, prev: string[]): string[] {
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
  try {
    const now = Date.now();
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(next.map((x, i) => ({ id: x, ts: now - i }))),
    );
  } catch {
    /* 忽略持久化失败 */
  }
  return next;
}

export default function App() {
  const workspaceRef = useRef<WorkspaceHandle>(null);
  const activePaneRef = useRef<PaneHandle | null>(null);
  const bridgeTargetRef = useRef<{
    pane: PaneHandle | null;
    transport: TerminalTransport | null;
  }>({ pane: null, transport: null });

  const [status, setStatus] = useState("就绪");
  const [surface, setSurface] = useState<RootSurface>("vault");
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

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>(loadRecent);

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

  // 标签从「有」变「无」时回到 Vault；新建标签的瞬间 tabs 仍为空，不能误判
  const priorTabCount = useRef(0);
  useEffect(() => {
    const prior = priorTabCount.current;
    priorTabCount.current = tabs.length;
    if (prior > 0 && tabs.length === 0 && surface === null) setSurface("vault");
  }, [tabs.length, surface]);

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
    setSurface(null);
    setRecentIds((prev) => saveRecent("__local", prev));
    workspaceRef.current?.newTab({ kind: "pty" });
  }

  function connect(profile: Profile) {
    setSurface(null);
    setRecentIds((prev) => saveRecent(profile.id, prev));
    workspaceRef.current?.newTab({
      kind: "ssh",
      profileId: profile.id,
      name: profile.name,
    });
  }

  function openSerial() {
    setSurface(null);
    workspaceRef.current?.ensureTab();
    setTool("serial");
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

  const terminalActive = surface === null;

  return (
    <div className="nc-shell">
      <TopTabs
        tabs={tabs}
        activeTabId={activeTabId}
        surface={surface}
        hostTreeOpen={sideOpen}
        status={status}
        onActivate={(id) => {
          setSurface(null);
          workspaceRef.current?.activateTab(id);
        }}
        onClose={(id) => workspaceRef.current?.closeTab(id)}
        onRename={(id, title) => workspaceRef.current?.renameTab(id, title)}
        onNewTab={openLocal}
        onOpenVault={() => setSurface("vault")}
        onOpenSftp={() => setSurface("sftp")}
        onToggleHostTree={() => setSideOpen((v) => !v)}
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
        {terminalActive && sideOpen && (
          <HostSidebar
            profiles={profiles}
            groups={groups}
            onConnect={connect}
            onLocal={openLocal}
            onOpenManager={() => setShowManager(true)}
            onClose={() => setSideOpen(false)}
          />
        )}

        <div className="nc-main">
          {surface === "vault" && (
            <VaultView
              profiles={profiles}
              groups={groups}
              recentIds={recentIds}
              onConnect={connect}
              onLocal={openLocal}
              onSerial={openSerial}
              onOpenManager={() => setShowManager(true)}
            />
          )}

          {surface === "sftp" && (
            <section className="nc-sftp-page">
              <header className="nc-sftp-page-header">
                <div>
                  <h1>SFTP</h1>
                  <p>独立连接或复用当前 SSH 会话传输文件</p>
                </div>
              </header>
              <div className="nc-sftp-page-body">
                <SftpPanel sshSessionId={activeSshSid} />
              </div>
            </section>
          )}

          <div className={`nc-workspace${terminalActive ? "" : " hidden"}`}>
            <Workspace
              ref={workspaceRef}
              onActivePane={onActivePane}
              onStatus={setStatus}
              onSnapshot={onSnapshot}
              onOpenTool={toggleTool}
            />
          </div>
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
