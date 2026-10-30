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
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TerminalPane, type PaneHandle } from "./TerminalPane";
import {
  collectLeaves,
  defaultTitle,
  firstLeafId,
  makeLeaf,
  newId,
  removeLeaf,
  splitLeaf,
  updateRatio,
  type Connector,
  type PaneNode,
  type SplitDir,
  type Tab,
} from "./workspace";
import {
  loadWorkspace,
  saveWorkspace,
  clearWorkspace,
  type SavedWorkspace,
} from "./backend/workspaceStore";

export interface WorkspaceHandle {
  /** 新建一个标签并立即连接。 */
  newTab: (connector: Connector) => void;
  /** 工作区为空时兜底建一个本地终端（侧栏面板需要窗格承载）。 */
  ensureTab: () => void;
}

interface Props {
  onActivePane: (handle: PaneHandle | null) => void;
  onStatus: (text: string) => void;
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
  node: PaneNode;
  tab: Tab;
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  onRegister: (paneId: string, handle: PaneHandle | null) => void;
  onStatus: (text: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
}

/** 递归渲染分屏树；split 节点带一条可拖拽分隔条。 */
function LayoutView({
  node,
  tab,
  activePaneId,
  onActivate,
  onRegister,
  onStatus,
  onRatio,
}: LayoutProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  if (node.type === "leaf") {
    return (
      <TerminalPane
        tab={tab}
        paneId={node.id}
        active={node.id === activePaneId}
        onActivate={() => onActivate(node.id)}
        onRegister={onRegister}
        onStatus={onStatus}
      />
    );
  }

  const dir = node.dir;

  function startDrag(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const horizontal = dir === "horizontal";
    const total = horizontal ? rect.width : rect.height;
    if (total <= 0) return;
    const origin = horizontal ? rect.left : rect.top;

    const move = (ev: PointerEvent) => {
      const pos = (horizontal ? ev.clientX : ev.clientY) - origin;
      onRatio(node.id, pos / total);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const common: Omit<LayoutProps, "node"> = {
    tab,
    activePaneId,
    onActivate,
    onRegister,
    onStatus,
    onRatio,
  };

  return (
    <div ref={boxRef} className={`split split-${node.dir}`}>
      <div className="split-cell" style={{ flexGrow: node.ratio }}>
        <LayoutView node={node.a} {...common} />
      </div>
      <div
        className={`splitter splitter-${node.dir}`}
        onPointerDown={startDrag}
      />
      <div className="split-cell" style={{ flexGrow: 1 - node.ratio }}>
        <LayoutView node={node.b} {...common} />
      </div>
    </div>
  );
}

export const Workspace = forwardRef<WorkspaceHandle, Props>(
  function Workspace({ onActivePane, onStatus }, ref) {
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activePaneByTab, setActivePaneByTab] = useState<
      Record<string, string>
    >({});
    const [handles, setHandles] = useState<Record<string, PaneHandle>>({});

    // 启动即读一次；有记录先弹横幅，等用户决定是否恢复。
    const [restore, setRestore] = useState<SavedWorkspace | null>(() =>
      loadWorkspace(),
    );
    // 无旧记录时可直接落盘；有旧记录则等用户点「恢复 / 忽略」后再写，
    // 否则首帧的空工作区会把旧布局覆盖掉。
    const [hydrated, setHydrated] = useState(false);

    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingText, setEditingText] = useState("");

    const tabsRef = useRef<Tab[]>([]);
    tabsRef.current = tabs;
    const activeTabIdRef = useRef<string | null>(null);
    activeTabIdRef.current = activeTabId;
    const paneMapRef = useRef<Record<string, string>>({});
    paneMapRef.current = activePaneByTab;
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

    const ensureTab = useCallback(() => {
      if (tabsRef.current.length === 0) newTab({ kind: "pty" });
    }, [newTab]);

    useImperativeHandle(ref, () => ({ newTab, ensureTab }), [newTab, ensureTab]);

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

    // 恢复 / 忽略
    function acceptRestore() {
      if (!restore) return;
      setTabs(restore.tabs);
      setActiveTabId(restore.activeTabId ?? restore.tabs[0]?.id ?? null);
      setActivePaneByTab(
        Object.fromEntries(
          restore.tabs.map((t) => [t.id, firstLeafId(t.layout)]),
        ),
      );
      setRestore(null);
      setHydrated(true);
    }

    function skipRestore() {
      clearWorkspace();
      setRestore(null);
      setHydrated(true);
    }

    // 启动时没有旧记录 → 立即进入可落盘状态
    useEffect(() => {
      if (!restore) setHydrated(true);
    }, [restore]);

    // 持久化：用户完成恢复决策后才开始覆盖旧记录
    useEffect(() => {
      if (!hydrated) return;
      saveWorkspace({
        version: 1,
        activeTabId,
        tabs: tabs.map(({ id, title, layout, connector }) => ({
          id,
          title,
          layout,
          connector,
        })),
      });
    }, [tabs, activeTabId, hydrated]);

    const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
    const activePaneId = activeTab
      ? resolveActivePane(activeTab, activePaneByTab)
      : null;

    // 活动窗格变化 → 通知外壳（SFTP 面板取 SSH 会话、串口面板取桥接目标）
    useEffect(() => {
      onActivePane(activePaneId ? handles[activePaneId] ?? null : null);
    }, [activePaneId, handles, onActivePane]);

    function beginRename(tab: Tab) {
      setEditingId(tab.id);
      setEditingText(tab.title);
    }

    function commitRename() {
      const id = editingId;
      const text = editingText.trim();
      setEditingId(null);
      if (!id || !text) return;
      setTabs((cur) =>
        cur.map((t) => (t.id === id ? { ...t, title: text } : t)),
      );
    }

    return (
      <div className="ws">
        {restore && (
          <div className="restore-banner">
            <span>
              发现上次会话：{restore.tabs.length} 个标签
            </span>
            <button onClick={acceptRestore}>恢复</button>
            <button onClick={skipRestore}>忽略并清空</button>
          </div>
        )}

        <div className="tab-bar">
          <div className="tab-list">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab${tab.id === activeTabId ? " active" : ""}`}
                onMouseDown={() => setActiveTabId(tab.id)}
              >
                {editingId === tab.id ? (
                  <input
                    className="tab-title-input"
                    autoFocus
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="tab-title"
                    title={tab.title}
                    onDoubleClick={() => beginRename(tab)}
                  >
                    {tab.title}
                  </span>
                )}
                <button
                  className="tab-close"
                  title="关闭标签"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => closeTab(tab.id)}
                >
                  ×
                </button>
              </div>
            ))}
            <button className="tab-new" title="新建本地终端" onClick={() => newTab({ kind: "pty" })}>
              +
            </button>
          </div>
          <div className="tab-actions">
            <button
              disabled={!activeTab}
              onClick={() => splitActive("horizontal")}
            >
              左右分屏
            </button>
            <button
              disabled={!activeTab}
              onClick={() => splitActive("vertical")}
            >
              上下分屏
            </button>
            <button
              disabled={!activeTab || collectLeaves(activeTab.layout).length <= 1}
              onClick={closeActivePane}
            >
              关闭窗格
            </button>
          </div>
        </div>

        <div className="tab-view-holder">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-view${tab.id === activeTabId ? "" : " hidden"}`}
            >
              <LayoutView
                node={tab.layout}
                tab={tab}
                activePaneId={tab.id === activeTabId ? activePaneId : null}
                onActivate={(paneId) => activatePane(tab.id, paneId)}
                onRegister={registerPane}
                onStatus={onStatus}
                onRatio={(splitId, ratio) => setRatio(tab.id, splitId, ratio)}
              />
            </div>
          ))}
          {!activeTab && (
            <div className="ws-empty">
              <div>还没有打开的终端</div>
              <div className="hint">
                点上方「+」开本地终端，或用工具栏「连接管理」连 SSH。
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);
