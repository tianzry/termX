/**
 * 工作区外壳：顶部标签栏 + 标签内嵌套分屏 + 分隔条拖拽 + 会话恢复横幅。
 *
 * - 标签切换只切显示，不卸载窗格（会话与终端缓冲区都保留）；
 * - 分屏新增的窗格复用同一标签的连接器（SSH 用同一档案新建独立会话）；
 * - 布局与标签变更实时写入 localStorage，下次启动由用户确认后恢复。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TerminalPane, type PaneHandle } from "./TerminalPane";
import {
  resolveTabConnectionStatus,
  type ConnectionStatus,
} from "./terminal/connectionStatus";
import {
  collectLeaves,
  defaultTitle,
  firstLeafId,
  layoutPanePlacements,
  makeLeaf,
  newId,
  removeLeaf,
  splitLeaf,
  updateRatio,
  type Connector,
  type SplitDir,
  type SplitterPlacement,
  type Tab,
} from "./workspaceModel";
import {
  loadWorkspace,
  saveWorkspace,
  clearWorkspace,
  type SavedTab,
  type SavedWorkspace,
} from "./backend/workspaceStore";
import { getProfileTelnetPassword } from "./backend/client";

export interface WorkspaceHandle {
  /** 新建一个标签并立即连接。 */
  newTab: (connector: Connector) => void;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  /** 对齐 Netcatty 标签右键菜单：关闭其他 / 关闭左侧 / 关闭右侧 / 关闭全部 / 拖拽排序 / 重连。 */
  closeOthers: (tabId: string) => void;
  closeLeft: (tabId: string) => void;
  closeRight: (tabId: string) => void;
  closeAll: () => void;
  reconnectTab: (tabId: string) => void;
  moveTab: (tabId: string, toIndex: number) => void;
  renameTab: (tabId: string, title: string) => void;
  split: (dir: SplitDir) => void;
  closePane: () => void;
  acceptRestore: () => void;
  skipRestore: () => void;
}

interface Props {
  onActivePane: (handle: PaneHandle | null) => void;
  onStatus: (text: string) => void;
  /** 向上发布标签快照，供顶部 TopTabs 渲染（标签状态仍由本组件持有）。 */
  onSnapshot?: (
    tabs: Tab[],
    activeTabId: string | null,
    restorePending: boolean,
  ) => void;
  /** 标签级连接状态（会话标签状态点）。 */
  onTabStatuses?: (statuses: Record<string, ConnectionStatus>) => void;
  /** 终端工具栏里打开右侧工具面板。 */
  onOpenTool?: (tool: "sftp" | "scripts" | "history" | "notes") => void;
  /** 右侧栏是否打开（工具栏开关激活态）。 */
  sidePanelOpen?: boolean;
  /** 展开 / 收起主机右侧栏。 */
  onToggleSidePanel?: () => void;
  /** 终端工具栏「终端设置」→ 打开设置中心。 */
  onOpenSettings?: () => void;
  /** 工作区持久化 key；多窗口用独立 key，避免覆盖主窗口布局。 */
  storageKey?: string;
}

function resolveActivePane(
  tab: Tab,
  map: Record<string, string>,
): string {
  const leaves = collectLeaves(tab.layout);
  const cur = map[tab.id];
  return leaves.some((l) => l.id === cur) ? cur : leaves[0].id;
}

interface LayoutProps {
  tab: Tab;
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  onRegister: (paneId: string, handle: PaneHandle | null) => void;
  onStatus: (paneId: string, text: string) => void;
  /** 窗格连接状态（供会话标签状态点，对照 Netcatty）。 */
  onConnectionStatus: (paneId: string, status: ConnectionStatus) => void;
  onRatio: (splitId: string, ratio: number) => void;
  onOpenTool?: (tool: "sftp" | "scripts" | "history" | "notes") => void;
  sidePanelOpen?: boolean;
  onToggleSidePanel?: () => void;
  onOpenSettings?: () => void;
  onClosePane: (paneId: string) => void;
  onSplit: (dir: SplitDir) => void;
}

/**
 * 渲染一个标签的分屏布局。
 *
 * 关键：终端组件不嵌在布局树里，而是以 paneId 为 key 平铺在同一个
 * `.pane-layer` 中，布局树只负责算出每格的矩形与分隔条位置。
 * split / close 只改变位置与数量，既有窗格的 React 实例保持挂载，
 * 因此不会重新建立 SSH / PTY 连接，也不会丢 scrollback（分屏重连 bug 的根因）。
 */
function TabLayout({
  tab,
  activePaneId,
  onActivate,
  onRegister,
  onStatus,
  onConnectionStatus,
  onRatio,
  onOpenTool,
  sidePanelOpen,
  onToggleSidePanel,
  onOpenSettings,
  onClosePane,
  onSplit,
}: LayoutProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const { panes, splitters } = useMemo(
    () => layoutPanePlacements(tab.layout),
    [tab.layout],
  );

  function startDrag(
    e: ReactPointerEvent<HTMLDivElement>,
    splitter: SplitterPlacement,
  ) {
    e.preventDefault();
    const layer = layerRef.current;
    if (!layer) return;
    const box = layer.getBoundingClientRect();
    const horizontal = splitter.dir === "horizontal";
    const origin = horizontal
      ? box.left + splitter.rect.left * box.width
      : box.top + splitter.rect.top * box.height;
    const total = horizontal
      ? splitter.rect.width * box.width
      : splitter.rect.height * box.height;
    if (total <= 0) return;

    const move = (ev: PointerEvent) => {
      const pos = (horizontal ? ev.clientX : ev.clientY) - origin;
      onRatio(splitter.splitId, pos / total);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div ref={layerRef} className="pane-layer">
      {panes.map(({ paneId, rect }) => (
        <div
          key={paneId}
          className="pane-cell"
          style={{
            left: `${rect.left * 100}%`,
            top: `${rect.top * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
          }}
        >
          <TerminalPane
            tab={tab}
            paneId={paneId}
            active={paneId === activePaneId}
            onActivate={() => onActivate(paneId)}
            onRegister={onRegister}
            onStatus={(text) => onStatus(paneId, text)}
            onConnectionStatus={(s) => onConnectionStatus(paneId, s)}
            onOpenTool={onOpenTool}
            sidePanelOpen={sidePanelOpen}
            onToggleSidePanel={onToggleSidePanel}
            onOpenSettings={onOpenSettings}
            onClosePane={() => onClosePane(paneId)}
            onSplit={onSplit}
          />
        </div>
      ))}
      {splitters.map((splitter) => {
        const horizontal = splitter.dir === "horizontal";
        const style = horizontal
          ? {
              left: `${splitter.rect.left * 100}%`,
              top: `${splitter.rect.top * 100}%`,
              height: `${splitter.rect.height * 100}%`,
            }
          : {
              left: `${splitter.rect.left * 100}%`,
              top: `${splitter.rect.top * 100}%`,
              width: `${splitter.rect.width * 100}%`,
            };
        return (
          <div
            key={splitter.splitId}
            className={`splitter splitter-${splitter.dir}`}
            style={style}
            onPointerDown={(e) => startDrag(e, splitter)}
          />
        );
      })}
    </div>
  );
}

export const Workspace = forwardRef<WorkspaceHandle, Props>(
  function Workspace(
    {
      onActivePane,
      onStatus,
      onSnapshot,
      onTabStatuses,
      onOpenTool,
      sidePanelOpen,
      onToggleSidePanel,
      onOpenSettings,
      storageKey,
    },
    ref,
  ) {
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activePaneByTab, setActivePaneByTab] = useState<
      Record<string, string>
    >({});
    const [handles, setHandles] = useState<Record<string, PaneHandle>>({});
    /** 每窗格最近一次状态文案；顶栏只显示活动窗格的，关窗格即清除（F2）。 */
    const [paneStatus, setPaneStatus] = useState<Record<string, string>>({});
    /** 每窗格连接状态：聚合成标签状态点（per-pane，互不影响）。 */
    const [paneConnStatus, setPaneConnStatus] = useState<
      Record<string, ConnectionStatus>
    >({});

    // 启动即读一次；有记录先弹横幅，等用户决定是否恢复。
    const [restore, setRestore] = useState<SavedWorkspace | null>(() =>
      loadWorkspace(storageKey),
    );
    // 无旧记录时可直接落盘；有旧记录则等用户点「恢复 / 忽略」后再写，
    // 否则首帧的空工作区会把旧布局覆盖掉。
    const [hydrated, setHydrated] = useState(false);

    const tabsRef = useRef<Tab[]>([]);
    tabsRef.current = tabs;
    const activeTabIdRef = useRef<string | null>(null);
    activeTabIdRef.current = activeTabId;
    const paneMapRef = useRef<Record<string, string>>({});
    paneMapRef.current = activePaneByTab;
    const handlesRef = useRef<Record<string, PaneHandle>>({});
    handlesRef.current = handles;
    const seqRef = useRef(0);

    const newTab = useCallback((connector: Connector) => {
      seqRef.current += 1;
      const layout = makeLeaf();
      const tab: Tab = {
        id: newId(),
        title: defaultTitle(connector, seqRef.current),
        layout,
        connector,
      };
      setTabs((cur) => [...cur, tab]);
      setActiveTabId(tab.id);
      setActivePaneByTab((m) => ({ ...m, [tab.id]: layout.id }));
      // 用户主动新建即视为放弃恢复，后续变更正常落盘
      setRestore(null);
      setHydrated(true);
    }, []);

    const registerPane = useCallback(
      (paneId: string, handle: PaneHandle | null) => {
        setHandles((cur) => {
          if (handle) {
            if (cur[paneId] === handle) return cur;
            return { ...cur, [paneId]: handle };
          }
          if (!cur[paneId]) return cur;
          const rest = { ...cur };
          delete rest[paneId];
          return rest;
        });
        if (!handle) {
          setPaneStatus((cur) => {
            if (!(paneId in cur)) return cur;
            const rest = { ...cur };
            delete rest[paneId];
            return rest;
          });
          setPaneConnStatus((cur) => {
            if (!(paneId in cur)) return cur;
            const rest = { ...cur };
            delete rest[paneId];
            return rest;
          });
        }
      },
      [],
    );

    const reportPaneStatus = useCallback((paneId: string, text: string) => {
      setPaneStatus((cur) =>
        cur[paneId] === text ? cur : { ...cur, [paneId]: text },
      );
    }, []);

    const reportPaneConnectionStatus = useCallback(
      (paneId: string, value: ConnectionStatus) => {
        setPaneConnStatus((cur) =>
          cur[paneId] === value ? cur : { ...cur, [paneId]: value },
        );
      },
      [],
    );

    const activatePane = useCallback((tabId: string, paneId: string) => {
      setActivePaneByTab((m) => ({ ...m, [tabId]: paneId }));
    }, []);

    const closeTab = useCallback((tabId: string) => {
      const cur = tabsRef.current;
      const idx = cur.findIndex((t) => t.id === tabId);
      const next = cur.filter((t) => t.id !== tabId);
      setTabs(next);
      setActiveTabId((prev) => {
        if (prev !== tabId) return prev;
        return next[Math.min(idx, next.length - 1)]?.id ?? null;
      });
      setActivePaneByTab((m) => {
        const rest = { ...m };
        delete rest[tabId];
        return rest;
      });
    }, []);

    const closeOthers = useCallback((tabId: string) => {
      const cur = tabsRef.current;
      const keep = cur.find((t) => t.id === tabId);
      if (!keep) return;
      setTabs([keep]);
      setActiveTabId(tabId);
      setActivePaneByTab((m) => ({
        [tabId]: m[tabId] ?? firstLeafId(keep.layout),
      }));
    }, []);

    const closeRight = useCallback((tabId: string) => {
      const cur = tabsRef.current;
      const idx = cur.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const next = cur.slice(0, idx + 1);
      setTabs(next);
      setActiveTabId(tabId);
      setActivePaneByTab((m) =>
        Object.fromEntries(
          next.map((t) => [t.id, m[t.id] ?? firstLeafId(t.layout)]),
        ),
      );
    }, []);

    const closeLeft = useCallback((tabId: string) => {
      const cur = tabsRef.current;
      const idx = cur.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const next = cur.slice(idx);
      setTabs(next);
      setActiveTabId(tabId);
      setActivePaneByTab((m) =>
        Object.fromEntries(
          next.map((t) => [t.id, m[t.id] ?? firstLeafId(t.layout)]),
        ),
      );
    }, []);

    const closeAll = useCallback(() => {
      setTabs([]);
      setActiveTabId(null);
      setActivePaneByTab({});
    }, []);

    const reconnectTab = useCallback((tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const paneId = resolveActivePane(tab, paneMapRef.current);
      handlesRef.current[paneId]?.reconnect();
    }, []);

    const moveTab = useCallback((tabId: string, toIndex: number) => {
      setTabs((cur) => {
        const from = cur.findIndex((t) => t.id === tabId);
        if (from < 0) return cur;
        const next = [...cur];
        const [moved] = next.splice(from, 1);
        const clamped = Math.max(0, Math.min(toIndex, next.length));
        next.splice(clamped, 0, moved);
        return next;
      });
    }, []);

    const closePane = useCallback(
      (tabId: string, paneId: string) => {
        const tab = tabsRef.current.find((t) => t.id === tabId);
        if (!tab) return;
        const layout = removeLeaf(tab.layout, paneId);
        if (!layout) {
          closeTab(tabId);
          return;
        }
        setTabs((cur) =>
          cur.map((t) => (t.id === tabId ? { ...t, layout } : t)),
        );
        const leaves = collectLeaves(layout);
        setActivePaneByTab((m) => {
          const curPane = m[tabId];
          if (leaves.some((l) => l.id === curPane)) return m;
          return { ...m, [tabId]: leaves[0].id };
        });
      },
      [closeTab],
    );

    const splitActive = useCallback((dir: SplitDir) => {
      const tabId = activeTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const paneId = resolveActivePane(tab, paneMapRef.current);
      const leaf = makeLeaf();
      setTabs((cur) =>
        cur.map((t) =>
          t.id === tab.id
            ? { ...t, layout: splitLeaf(t.layout, paneId, dir, leaf) }
            : t,
        ),
      );
      setActivePaneByTab((m) => ({ ...m, [tab.id]: leaf.id }));
    }, []);

    const closeActivePane = useCallback(() => {
      const tabId = activeTabIdRef.current;
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      closePane(tab.id, resolveActivePane(tab, paneMapRef.current));
    }, [closePane]);

    const setRatio = useCallback((tabId: string, splitId: string, r: number) => {
      setTabs((cur) =>
        cur.map((t) =>
          t.id === tabId
            ? { ...t, layout: updateRatio(t.layout, splitId, r) }
            : t,
        ),
      );
    }, []);

    /**
     * 工作区落盘时已剥离 Telnet 密码（见 workspaceStore.sanitizeConnectorForStorage），
     * 恢复前按 profileId 从 SecretStore 回填；取不到就保持空密码，避免明文进 localStorage。
     */
    async function hydrateTelnetPasswords(tabs: SavedTab[]): Promise<SavedTab[]> {
      return Promise.all(
        tabs.map(async (tab) => {
          if (tab.connector.kind !== "telnet") return tab;
          const profileId = tab.connector.session.profileId;
          if (!profileId) return tab;
          try {
            const password = await getProfileTelnetPassword(profileId);
            if (password == null) return tab;
            return {
              ...tab,
              connector: {
                ...tab.connector,
                session: { ...tab.connector.session, password },
              },
            };
          } catch {
            return tab;
          }
        }),
      );
    }

    // 恢复 / 忽略
    async function acceptRestore() {
      if (!restore) return;
      const tabs = await hydrateTelnetPasswords(restore.tabs);
      setTabs(tabs);
      setActiveTabId(restore.activeTabId ?? tabs[0]?.id ?? null);
      setActivePaneByTab(
        Object.fromEntries(
          restore.tabs.map((t) => [t.id, firstLeafId(t.layout)]),
        ),
      );
      setRestore(null);
      setHydrated(true);
    }

    function skipRestore() {
      clearWorkspace(storageKey);
      setRestore(null);
      setHydrated(true);
    }

    useImperativeHandle(
      ref,
      () => ({
        newTab,
        activateTab: (tabId: string) => setActiveTabId(tabId),
        closeTab,
        closeOthers,
        closeLeft,
        closeRight,
        closeAll,
        reconnectTab,
        moveTab,
        renameTab: (tabId: string, title: string) =>
          setTabs((cur) =>
            cur.map((t) => (t.id === tabId ? { ...t, title } : t)),
          ),
        split: splitActive,
        closePane: closeActivePane,
        acceptRestore,
        skipRestore,
      }),
      [newTab, closeTab, closeOthers, closeLeft, closeRight, closeAll, reconnectTab, moveTab, splitActive, closeActivePane],
    );

    // 启动时没有旧记录 → 立即进入可落盘状态
    useEffect(() => {
      if (!restore) setHydrated(true);
    }, [restore]);

    // 标签快照向上同步给 TopTabs
    useEffect(() => {
      onSnapshot?.(tabs, activeTabId, restore !== null);
    }, [tabs, activeTabId, restore, onSnapshot]);

    // 持久化：用户完成恢复决策后才开始覆盖旧记录
    useEffect(() => {
      if (!hydrated) return;
      saveWorkspace(
        {
          version: 1,
          activeTabId,
          tabs: tabs.map(({ id, title, layout, connector }) => ({
            id,
            title,
            layout,
            connector,
          })),
        },
        storageKey,
      );
    }, [tabs, activeTabId, hydrated, storageKey]);

    const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
    const activePaneId = activeTab
      ? resolveActivePane(activeTab, activePaneByTab)
      : null;

    // 活动窗格变化 → 通知外壳（SFTP 面板取 SSH 会话、串口面板取桥接目标）
    useEffect(() => {
      onActivePane(activePaneId ? handles[activePaneId] ?? null : null);
    }, [activePaneId, handles, onActivePane]);

    // 顶栏状态只反映活动窗格；窗格关闭 / 切换后自动回落（F2）。
    useEffect(() => {
      onStatus(activePaneId ? paneStatus[activePaneId] ?? "就绪" : "就绪");
    }, [activePaneId, paneStatus, onStatus]);

    // 标签状态点：按标签内全部窗格聚合（任一断开即断开，对照 Netcatty tab dot）。
    const tabStatusesRef = useRef<Record<string, ConnectionStatus>>({});
    useEffect(() => {
      if (!onTabStatuses) return;
      const statuses: Record<string, ConnectionStatus> = {};
      for (const tab of tabs) {
        statuses[tab.id] = resolveTabConnectionStatus({
          paneStatuses: paneConnStatus,
          paneIds: collectLeaves(tab.layout).map((leaf) => leaf.id),
        });
      }
      // 拖动分屏会每帧改 tabs 引用，内容未变时跳过回调，避免 App 级重复渲染。
      const prev = tabStatusesRef.current;
      const keys = Object.keys(statuses);
      const unchanged =
        keys.length === Object.keys(prev).length &&
        keys.every((key) => prev[key] === statuses[key]);
      if (unchanged) return;
      tabStatusesRef.current = statuses;
      onTabStatuses(statuses);
    }, [tabs, paneConnStatus, onTabStatuses]);

    return (
      <div className="ws">
        <div className="tab-view-holder">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-view${tab.id === activeTabId ? "" : " hidden"}`}
            >
              <TabLayout
                tab={tab}
                activePaneId={tab.id === activeTabId ? activePaneId : null}
                onActivate={(paneId) => activatePane(tab.id, paneId)}
                onRegister={registerPane}
                onStatus={reportPaneStatus}
                onConnectionStatus={reportPaneConnectionStatus}
                onRatio={(splitId, ratio) => setRatio(tab.id, splitId, ratio)}
                onOpenTool={onOpenTool}
                sidePanelOpen={sidePanelOpen}
                onToggleSidePanel={onToggleSidePanel}
                onOpenSettings={onOpenSettings}
                onClosePane={(paneId) => closePane(tab.id, paneId)}
                onSplit={splitActive}
              />
            </div>
          ))}
        </div>
      </div>
    );
  },
);
