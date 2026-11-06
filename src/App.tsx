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
import { newId, type Tab, type Connector } from "./workspaceModel";
import { resolveCommandHistoryHostId } from "./terminal/commandHistoryModel";
import type { ConnectionStatus } from "./terminal/connectionStatus";
import { findProfileForHostLink } from "./notes/notesModel";

import { TopTabs, type RootSurface } from "./TopTabs";
import { HostSidebar } from "./HostSidebar";
import { VaultView } from "./VaultView";
import { TerminalSidePanel } from "./terminal/TerminalSidePanel";
import type { SidePanelTool } from "./domain/terminalSidePanel";
import { SerialConnectModal } from "./serial/SerialConnectModal";
import { TelnetConnectModal } from "./telnet/TelnetConnectModal";
import { useForwardSupervisor } from "./forwardSupervisor";
import { ConnectionManager } from "./ConnectionManager";
import { SftpView } from "./sftp/SftpView";
import {
  resolveSftpLocateCdCommand,
  type ConnectedHostEntry,
  type SftpOpenRequest,
} from "./sftp/sftpModel";
import * as api from "./backend/client";
import {
  SettingsDialog,
  type SettingsTabId,
} from "./settings/SettingsDialog";
import { loadSettings, useSettings } from "./settings/settingsStore";
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
import { shellDisplayName } from "./domain/shellName";
import {
  serialFormFromProfile,
  toSerialConfig,
} from "./domain/serialFormConfig";
import type { SerialProfileSnapshot } from "./domain/serialFormConfig";
import { userVisibleError } from "./domain/sshErrors";
import {
  isTelnetProfile,
  telnetSessionFromProfile,
} from "./domain/hostProtocol";
type Tool = SidePanelTool | null;

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
  const settings = useSettings();
  // 端口转发 auto_start / auto_reconnect（对齐 Netcatty 渲染层监督器）。
  useForwardSupervisor();

  const [status, setStatus] = useState("就绪");
  const [surface, setSurface] = useState<RootSurface>("vault");
  // 「显示 SFTP 标签页」关闭时，若当前停在 SFTP 视图则回到主机库。
  useEffect(() => {
    if (!settings.showSftpTab && surface === "sftp") setSurface("vault");
  }, [settings.showSftpTab, surface]);
  // SFTP 视图首次进入后常驻挂载，切走仅 CSS 隐藏（对齐 Netcatty SftpViewMount
  // 的 sticky 保活）：pane 标签 / 双栏状态不因 surface 切换丢失。
  const [sftpMounted, setSftpMounted] = useState(false);
  useEffect(() => {
    if (surface === "sftp") setSftpMounted(true);
  }, [surface]);
  const [activeSshSid, setActiveSshSid] = useState<string | null>(null);
  /** 外部「打开 SFTP」请求（主机右键）；seq 自增保证重复点击也重新定位。 */
  const [sftpOpenRequest, setSftpOpenRequest] = useState<SftpOpenRequest | null>(
    null,
  );
  const sftpOpenSeqRef = useRef(0);
  const [tool, setTool] = useState<Tool>(null);
  /**
   * 右侧栏的开启状态与工具页按标签记忆（对齐 Netcatty `sidePanelOpenTabs`：
   * Map<tabId, tool>，无记录即关闭）。切换标签后各标签恢复自己的视图。
   */
  const [sidePanelTabs, setSidePanelTabs] = useState<
    Record<string, SidePanelTool>
  >({});
  const [showManager, setShowManager] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 设置中心打开时定位的 tab（终端工具栏「终端设置」→ 外观）。 */
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("application");
  /** 顶栏 / 设置中心「打开同步页」：Vault 子页定位请求（nonce 保证重复点击生效）。 */
  const [vaultFocus, setVaultFocus] = useState<string | null>(null);
  const [vaultFocusNonce, setVaultFocusNonce] = useState(0);
  const openVaultSync = useCallback(() => {
    setSettingsOpen(false);
    setSurface("vault");
    setVaultFocus("sync");
    setVaultFocusNonce((n) => n + 1);
  }, []);
  useEffect(() => {
    void loadSettings();
  }, []);

  const [sideOpen, setSideOpen] = useState<boolean>(() => {
    try {
      // 对齐 Netcatty terminalHostTreeStore：主机树默认收起（终端全宽），
      // 由顶栏按钮切换并持久化。
      return localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [restorePending, setRestorePending] = useState(false);
  /** 标签级连接状态（Workspace 按窗格聚合后上报，用于标签状态点）。 */
  const [tabStatuses, setTabStatuses] = useState<
    Record<string, ConnectionStatus>
  >({});
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
  /** profiles 加载完成后再处理深链，避免「DB 还没读出来」误判无匹配主机。 */
  const [dataLoaded, setDataLoaded] = useState(false);
  const [deepLinks, setDeepLinks] = useState<string[]>([]);
  const handledDeepLinks = useRef(new Set<string>());

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
    } finally {
      setDataLoaded(true);
    }
  }, []);

  function openManager() {
    setManagerEditId(null);
    setShowManager(true);
  }

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // 后端发行版探测首次写入后会 emit `profiles:changed`：重拉档案，
  // 让主机卡片 / 快速切换器 / 选择器 / 终端标签的头像自动更新。
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void api.onProfilesChanged(() => {
      if (alive) void loadData();
    }).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
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
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
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

  useEffect(() => {
    if (!activeHandle) {
      setActiveCwd(null);
      return;
    }
    setActiveCwd(activeHandle.cwd());
    return activeHandle.subscribeCwd(setActiveCwd);
  }, [activeHandle]);

  function openLocal(shellOverride?: DiscoveredShell) {
    setSurface(null);
    setRecentIds((prev) => saveRecent("__local", prev));
    void (async () => {
      if (shellOverride) {
        workspaceRef.current?.newTab({
          kind: "pty",
          shell: shellOverride.command,
          args: shellOverride.args,
          name: shellOverride.name,
        });
        return;
      }
      // shell 解析 = 设置 local_shell → 空用后端默认（对齐 Netcatty）。
      // 标签名跟随 shell 显示名（Netcatty 本地会话标题行显示「Git Bash」）。
      let shell: string | undefined;
      let args: string[] | undefined;
      let name: string | undefined;
      try {
        const configured = (await api.getSetting("local_shell")) ?? "";
        const resolved = resolveShellSetting(configured, discoveredShells);
        shell = resolved?.command;
        args = resolved?.args;
        name = configured
          ? (discoveredShells.find((s) => s.id === configured)?.name ??
            (resolved ? shellDisplayName(resolved.command) : undefined))
          : shellDisplayName(resolved?.command ?? (await api.defaultShell()));
      } catch {
        /* 设置读取失败：走后端默认 shell */
      }
      workspaceRef.current?.newTab({ kind: "pty", shell, args, name });
    })();
  }

  /** 串口弹窗勾选「保存为主机」：先建 real 凭据（Profile 不变量要求非空 id），再落档案。 */
  async function saveSerialHost(
    name: string,
    snapshot: SerialProfileSnapshot,
  ): Promise<void> {
    const credentialId = newId();
    await api.createCredential({
      id: credentialId,
      name: `${name} (${snapshot.serial_port})`,
      username: "",
      type: "none",
      secret: null,
      save_to_remote: false,
    });
    await api.createProfile({
      id: newId(),
      name,
      host: snapshot.serial_port,
      port: 0,
      credential_id: credentialId,
      bastion_profile_id: null,
      init_command: null,
      group_id: null,
      agent_forwarding: false,
      protocol: "serial",
      ...snapshot,
    });
    await loadData();
  }

  function connect(profile: Profile) {
    setSurface(null);
    setRecentIds((prev) => saveRecent(profile.id, prev));
    if (profile.protocol === "serial") {
      const form = serialFormFromProfile(profile);
      workspaceRef.current?.newTab({
        kind: "serial",
        session: {
          port: form.port,
          config: toSerialConfig(form),
          lineMode: form.lineMode,
          localEcho: form.localEcho,
          backspaceBehavior: form.backspaceBehavior,
          byteOrientedBackspace: form.byteOrientedBackspace,
        },
        name: profile.name,
      });
      return;
    }
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
    if (isTelnetProfile(profile)) {
      // 密码只存在于后端 SecretStore（`telnet:<id>:password`），
      // 按需取一次放进本次会话内存；不落入工作区持久化数据。
      void (async () => {
        let password: string | null = null;
        try {
          password = await api.getProfileTelnetPassword(profile.id);
        } catch {
          /* 取不到 = 手动登录 */
        }
        workspaceRef.current?.newTab({
          kind: "telnet",
          name: profile.name,
          session: telnetSessionFromProfile(profile, password),
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

  // 深链订阅：冷启动 URL 用 getCurrent，运行中由 single-instance 转发（onOpenUrl）。
  // 只在主窗口订阅：deep-link 事件与 getCurrent 都是进程级，多窗口都订阅会重复开标签。
  const windowLabel = api.currentWindowLabel();
  useEffect(() => {
    if (windowLabel !== "main") return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void api
      .getCurrentDeepLinks()
      .then((urls) => {
        if (alive && urls?.length) setDeepLinks((prev) => [...prev, ...urls]);
      })
      .catch(() => {});
    void api
      .onDeepLink((urls) => {
        if (alive) setDeepLinks((prev) => [...prev, ...urls]);
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [windowLabel]);

  // 深链 → 匹配已有 SSH 主机并新建会话；同一 URL 只处理一次。
  useEffect(() => {
    if (!dataLoaded) return;
    for (const raw of deepLinks) {
      if (handledDeepLinks.current.has(raw)) continue;
      handledDeepLinks.current.add(raw);
      const profile = findProfileForHostLink(profiles, raw);
      if (!profile) {
        setStatus(`深链未找到匹配主机：${raw}`);
        continue;
      }
      connect(profile);
    }
  }, [dataLoaded, deepLinks, profiles]);

  // 新窗口冷启动：后端把连接参数写进 `window.__termx_clone`，这里恢复成标签。
  useEffect(() => {
    const clone = (window as unknown as { __termx_clone?: string }).__termx_clone;
    if (!clone) return;
    try {
      const connector = JSON.parse(clone) as Connector;
      if (connector && typeof connector === "object" && "kind" in connector) {
        workspaceRef.current?.newTab(connector);
      }
    } catch {
      /* 初始化脚本损坏时保持普通空窗口 */
    }
  }, []);

  function openTabInNewWindow(id: string) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    void api.openTabInNewWindow(JSON.stringify(tab.connector)).catch((e) => {
      setStatus(String(e));
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

  /** 记录当前标签的侧栏视图；null 表示关闭（无记录）。 */
  function markSidePanelTool(next: SidePanelTool | null) {
    if (!activeTabId) return;
    setSidePanelTabs((prev) => {
      if (next === null) {
        if (!(activeTabId in prev)) return prev;
        const rest = { ...prev };
        delete rest[activeTabId];
        return rest;
      }
      if (prev[activeTabId] === next) return prev;
      return { ...prev, [activeTabId]: next };
    });
  }

  /** 侧栏默认视图：SSH 会话优先 SFTP，其余（本地 / 串口 / Telnet）脚本。 */
  function defaultSidePanelView(): SidePanelTool {
    return activeTab?.connector.kind === "ssh" ? "sftp" : "scripts";
  }

  function toggleSidePanel() {
    if (tool !== null) {
      setTool(null);
      markSidePanelTool(null);
      return;
    }
    const next = defaultSidePanelView();
    setTool(next);
    markSidePanelTool(next);
  }

  function toggleTool(next: SidePanelTool) {
    // SFTP 侧栏复用当前 SSH 会话（对齐 Netcatty：未连接时不可用）。
    if (next === "sftp" && !activeSshSid) {
      setStatus("SFTP 需要已连接的 SSH 会话");
      return;
    }
    setTool(next);
    markSidePanelTool(next);
  }

  /** 侧栏内部切换页签：同步 App 的 tool 与「侧栏视图按标签记忆」。 */
  function changeSidePanelTool(next: SidePanelTool) {
    setTool(next);
    markSidePanelTool(next);
  }

  function closeTool() {
    setTool(null);
    markSidePanelTool(null);
  }

  useEffect(() => {
    if (!activeTabId) {
      setTool(null);
      return;
    }
    // 按标签记忆：该标签上次打开过的视图就恢复，无记录则关闭；
    // 视图只在首次打开时按协议选默认（toggleSidePanel），这里不覆盖。
    setTool(sidePanelTabs[activeTabId] ?? null);
  }, [activeTabId, sidePanelTabs]);

  const terminalActive = surface === null;

  // SFTP 主机选择器「已连接」分区：当前活动的 SSH 终端会话可复用建 SFTP。
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const sftpConnectedHosts: ConnectedHostEntry[] = activeSshSid
    ? [
        {
          sessionId: activeSshSid,
          label: activeTab?.title ?? "终端会话",
          meta: "复用当前终端会话",
          profileId:
            activeTab?.connector.kind === "ssh"
              ? activeTab.connector.profileId
              : undefined,
        },
      ]
    : [];

  /**
   * 「定位路径到终端」：把 SFTP 当前路径写进活动 SSH 终端（Netcatty
   * resolveInteractiveTerminalCdIntent 语义：仅绝对路径 / ~，`cd -- '<path>'`）。
   */
  const locatePathInTerminal = (path: string) => {
    const command = resolveSftpLocateCdCommand(path);
    if (!command) {
      setStatus("当前路径不支持定位到终端");
      return;
    }
    if (!activeHandle) {
      setStatus("终端未就绪，无法定位路径");
      return;
    }
    activeHandle.sendText(`${command}\r`);
  };

  /** 主机右键「打开 SFTP」：打开 SFTP 视图，左本地 + 右该主机（可复用已有会话）。 */
  function openSftpForHost(profile: Profile) {
    if (!settings.showSftpTab) {
      setStatus("设置中已关闭 SFTP 标签页");
      return;
    }
    setSurface("sftp");
    const session = sftpConnectedHosts.find((e) => e.profileId === profile.id);
    sftpOpenSeqRef.current += 1;
    setSftpOpenRequest({
      seq: sftpOpenSeqRef.current,
      hostId: profile.id,
      label: profile.name,
      meta: profile.host,
      sessionId: session?.sessionId,
    });
  }

  return (
    <div
      className="nc-shell"
      // 全局屏蔽 WebView2 默认右键菜单（返回/刷新/另存为/打印/检查）。
      // 捕获阶段只 preventDefault、不阻断冒泡：各页面已有的自定义菜单照常
      // 由自己的 onContextMenu 打开（Netcatty 同样没有系统默认菜单）。
      // 输入框保留系统「复制/粘贴/剪切」菜单（用户明确要求区分）。
      onContextMenuCapture={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      <TopTabs
        tabs={tabs}
        activeTabId={activeTabId}
        surface={surface}
        hostTreeOpen={sideOpen}
        status={status}
        connectionStatuses={tabStatuses}
        onActivate={(id) => {
          setSurface(null);
          workspaceRef.current?.activateTab(id);
        }}
        onClose={(id) => workspaceRef.current?.closeTab(id)}
        onDuplicateTab={(id) => {
          const tab = tabs.find((t) => t.id === id);
          if (tab) workspaceRef.current?.newTab(tab.connector);
        }}
        onOpenInNewWindow={openTabInNewWindow}
        profiles={profiles}
        groups={groups}
        shells={discoveredShells}
        onConnect={connect}
        onLocalShell={(shell) => openLocal(shell)}
        onRenameTab={(id, title) => workspaceRef.current?.renameTab(id, title)}
        onCloseOthers={(id) => workspaceRef.current?.closeOthers(id)}
        onCloseLeft={(id) => workspaceRef.current?.closeLeft(id)}
        onCloseRight={(id) => workspaceRef.current?.closeRight(id)}
        onCloseAll={() => workspaceRef.current?.closeAll()}
        onReconnectTab={(id) => workspaceRef.current?.reconnectTab(id)}
        onMoveTab={(id, index) => workspaceRef.current?.moveTab(id, index)}
        onOpenVault={() => setSurface("vault")}
        onOpenSftp={() => setSurface("sftp")}
        onToggleHostTree={() => setSideOpen((v) => !v)}
        onOpenSettings={() => {
          setSettingsTab("application");
          setSettingsOpen(true);
        }}
        onOpenSync={openVaultSync}
      />
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsTab}
          onOpenSync={openVaultSync}
        />
      )}

      {restorePending && (
        <div className="nc-restore">
          <span className="nc-restore-dot" />
          <span>发现上次会话记录，是否恢复标签与分屏布局？</span>
          <button onClick={() => workspaceRef.current?.acceptRestore()}>恢复</button>
          <button onClick={() => workspaceRef.current?.skipRestore()}>忽略并清空</button>
        </div>
      )}

      <div className="nc-body">
        {terminalActive && sideOpen && settings.showHostTreeSidebar && (
          <HostSidebar
            profiles={profiles}
            groups={groups}
            onConnect={connect}
            onLocal={openLocal}
            onOpenManager={openManager}
            onClose={() => setSideOpen(false)}
            onRefresh={() => void loadData()}
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
              onOpenSftp={openSftpForHost}
              onDataChanged={() => void loadData()}
              onOpenSettings={() => {
                setSettingsTab("application");
                setSettingsOpen(true);
              }}
              activeHandle={activeHandle}
              focusView={vaultFocus}
              focusNonce={vaultFocusNonce}
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
                openRequest={sftpOpenRequest}
              />
            </div>
          )}

          <div className={`nc-workspace${terminalActive ? "" : " hidden"}`}>
            <Workspace
              ref={workspaceRef}
              storageKey={
                windowLabel === "main"
                  ? undefined
                  : `termx.workspace.v1.${windowLabel}`
              }
              onActivePane={onActivePane}
              onStatus={setStatus}
              onSnapshot={onSnapshot}
              onTabStatuses={setTabStatuses}
              onOpenTool={toggleTool}
              sidePanelOpen={tool !== null}
              onToggleSidePanel={toggleSidePanel}
              onOpenSettings={() => {
                // 终端工具栏「终端设置」：对齐 Netcatty 的 theme 侧栏语义，
                // termX 对应设置中心的外观 tab（主题 / 字体 / 图标）。
                setSettingsTab("appearance");
                setSettingsOpen(true);
              }}
            />
          </div>
        </div>

        {terminalActive && tool && (
          <TerminalSidePanel
            tool={tool}
            onToolChange={changeSidePanelTool}
            sessionLabel={activeTab?.title ?? "终端会话"}
            sessionMeta="复用当前终端会话"
            hostId={
              activeTab?.connector.kind === "ssh"
                ? activeTab.connector.profileId
                : undefined
            }
            historyHostId={
              activeTab ? resolveCommandHistoryHostId(activeTab.connector) : ""
            }
            profiles={profiles}
            onOpenHost={connect}
            activeHandle={activeHandle}
            onLocatePathInTerminal={
              activeTab?.connector.kind === "ssh"
                ? locatePathInTerminal
                : undefined
            }
            sshSessionId={activeSshSid}
            terminalCwd={activeCwd}
            onClose={closeTool}
          />
        )}
      </div>

      {showSerialModal && (
        <SerialConnectModal
          open={showSerialModal}
          onClose={() => setShowSerialModal(false)}
          onConnect={(session, saveHost) => {
            setShowSerialModal(false);
            setSurface(null);
            const openSerialTab = () =>
              workspaceRef.current?.newTab({
                kind: "serial",
                session,
                name: saveHost?.name || `串口 ${session.port}`,
              });
            if (!saveHost) {
              openSerialTab();
              return;
            }
            // 保存失败只提示，不阻断本次连接。
            void (async () => {
              try {
                await saveSerialHost(saveHost.name, saveHost.snapshot);
              } catch (e) {
                setStatus(
                  `串口主机保存失败：${userVisibleError(String(e))}`,
                );
              } finally {
                openSerialTab();
              }
            })();
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
