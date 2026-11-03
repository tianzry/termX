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
import { SerialConnectModal } from "./serial/SerialConnectModal";
import { TelnetConnectModal } from "./telnet/TelnetConnectModal";
import { ForwardPanel } from "./ForwardPanel";
import { ConnectionManager } from "./ConnectionManager";
import { SftpView } from "./sftp/SftpView";
import type { ConnectedHostEntry } from "./sftp/sftpModel";
import * as api from "./backend/client";
import { SettingsDialog } from "./settings/SettingsDialog";
import { loadSettings } from "./settings/settingsStore";
import type {
  Credential,
  DiscoveredShell,
  Group,
  Profile,
} from "./backend/client";
import {
  resolveHostDefaultLocalShell,
  resolveShellSetting,
} from "./domain/localShellHost";

type Tool = "sftp" | "forward" | null;

const TOOL_TITLE: Record<Exclude<Tool, null>, string> = {
  sftp: "文件传输",
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

  const [status, setStatus] = useState("就绪");
  const [surface, setSurface] = useState<RootSurface>("vault");
  // SFTP 视图首次进入后常驻挂载，切走仅 CSS 隐藏（对齐 Netcatty SftpViewMount
  // 的 sticky 保活）：pane 标签 / 双栏状态不因 surface 切换丢失。
  const [sftpMounted, setSftpMounted] = useState(false);
  useEffect(() => {
    if (surface === "sftp") setSftpMounted(true);
  }, [surface]);
  const [activeSshSid, setActiveSshSid] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [showManager, setShowManager] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    void loadSettings();
  }, []);

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
  const [credentials, setCredentials] = useState<Credential[]>([]);
  /** 本机发现的 shell（本地主机连接时解析「系统默认 Shell」）。 */
  const [discoveredShells, setDiscoveredShells] = useState<DiscoveredShell[]>(
    [],
  );
  const [recentIds, setRecentIds] = useState<string[]>(loadRecent);
  const [managerEditId, setManagerEditId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [nextProfiles, nextGroups, nextCredentials] = await Promise.all([
        api.listProfiles(),
        api.listGroups(),
        api.listCredentials(),
      ]);
      setProfiles(nextProfiles);
      setGroups(nextGroups);
      setCredentials(nextCredentials);
    } catch {
      /* 首次启动或 DB 为空时忽略 */
    }
  }, []);

  function openManager() {
    setManagerEditId(null);
    setShowManager(true);
  }

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    let alive = true;
    api
      .discoverShells()
      .then((s) => {
        if (alive) setDiscoveredShells(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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

  function openLocal() {
    setSurface(null);
    setSideOpen(true);
    setRecentIds((prev) => saveRecent("__local", prev));
    void (async () => {
      // shell 解析 = 设置 local_shell → 空用后端默认（对齐 Netcatty）。
      let shell: string | undefined;
      let args: string[] | undefined;
      try {
        const configured = (await api.getSetting("local_shell")) ?? "";
        const resolved = resolveShellSetting(configured, discoveredShells);
        shell = resolved?.command;
        args = resolved?.args;
      } catch {
        /* 设置读取失败：走后端默认 shell */
      }
      workspaceRef.current?.newTab({ kind: "pty", shell, args });
    })();
  }

  function connect(profile: Profile) {
    setSurface(null);
    setSideOpen(true);
    setRecentIds((prev) => saveRecent(profile.id, prev));
    if (profile.protocol === "local") {
      void (async () => {
        let localShellSetting = "";
        try {
          localShellSetting = (await api.getSetting("local_shell")) ?? "";
        } catch {
          /* 仅用主机自身 shell 快照 */
        }
        const resolved = resolveHostDefaultLocalShell(profile, {
          discoveredShells,
          terminalSettings: { localShell: localShellSetting },
          resolveShellSetting,
        });
        workspaceRef.current?.newTab({
          kind: "pty",
          name: profile.name,
          shell: resolved.local_shell || undefined,
          args: resolved.local_shell_args ?? undefined,
          startDir: resolved.local_start_dir ?? undefined,
        });
      })();
      return;
    }
    workspaceRef.current?.newTab({
      kind: "ssh",
      profileId: profile.id,
      name: profile.name,
    });
  }

  const [showSerialModal, setShowSerialModal] = useState(false);
  const [showTelnetModal, setShowTelnetModal] = useState(false);

  // 串口 / Telnet 入口与 Netcatty 一致：先弹连接参数弹窗，确认后才新建
  // 对应协议的标签；不再借 ensureTab() 兜底开本地终端（错误分支）。
  function openSerial() {
    setShowSerialModal(true);
  }

  function openTelnet() {
    setShowTelnetModal(true);
  }

  function toggleTool(next: Exclude<Tool, null>) {
    if (tool === next) {
      setTool(null);
      return;
    }
    setTool(next);
  }

  const terminalActive = surface === null;

  // SFTP 主机选择器「已连接」分区：当前活动的 SSH 终端会话可复用建 SFTP。
  const sftpConnectedHosts: ConnectedHostEntry[] = activeSshSid
    ? [
        {
          sessionId: activeSshSid,
          label: tabs.find((t) => t.id === activeTabId)?.title ?? "终端会话",
          meta: "复用当前终端会话",
        },
      ]
    : [];

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
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

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
            onOpenManager={openManager}
            onClose={() => setSideOpen(false)}
          />
        )}

        <div className="nc-main">
          {surface === "vault" && (
            <VaultView
              profiles={profiles}
              groups={groups}
              credentials={credentials}
              recentIds={recentIds}
              onConnect={connect}
              onLocal={openLocal}
              onSerial={openSerial}
              onTelnet={openTelnet}
              onDataChanged={() => void loadData()}
            />
          )}

          {sftpMounted && (
            <div
              className={`nc-sftp-mount${surface === "sftp" ? "" : " hidden"}`}
            >
              <SftpView
                profiles={profiles}
                credentials={credentials}
                connectedHosts={sftpConnectedHosts}
              />
            </div>
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
            {tool === "forward" && <ForwardPanel />}
          </AsidePanel>
        )}
      </div>

      {showSerialModal && (
        <SerialConnectModal
          open={showSerialModal}
          onClose={() => setShowSerialModal(false)}
          onConnect={(session) => {
            setShowSerialModal(false);
            setSurface(null);
            workspaceRef.current?.newTab({
              kind: "serial",
              session,
              name: `串口 ${session.port}`,
            });
          }}
        />
      )}

      {showTelnetModal && (
        <TelnetConnectModal
          open={showTelnetModal}
          onClose={() => setShowTelnetModal(false)}
          onConnect={(session) => {
            setShowTelnetModal(false);
            setSurface(null);
            workspaceRef.current?.newTab({
              kind: "telnet",
              session,
              name: `Telnet ${session.host}`,
            });
          }}
        />
      )}

      {showManager && (
        <ConnectionManager
          profiles={profiles}
          editProfileId={managerEditId}
          onClose={() => {
            setShowManager(false);
            setManagerEditId(null);
          }}
          onConnect={(p) => {
            setShowManager(false);
            setManagerEditId(null);
            connect(p);
          }}
          onChanged={() => void loadData()}
        />
      )}
    </div>
  );
}
