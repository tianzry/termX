/**
 * 终端右侧工具栏（对齐 Netcatty TerminalLayerSidePanelSection 的 termX 子集）。
 *
 * 结构：h-9 工具条（左侧工具页 tab + 溢出「更多」，右侧放大 / 上下分屏 /
 * 左右分屏 / 关闭）+ 面板区（单 pane 或双 pane 分屏）。
 * 宽度：默认 420 / 最小 280 / 最大 1200 且给终端留 320（Netcatty 实测值），
 * 左缘可拖拽，宽度写 localStorage。
 *
 * 红圈排除项（对照图逐项核对，不在本组件渲染）：
 * - Browser 页签（globe）：termX 无内嵌浏览器面板；
 * - Theme 页签（palette）：termX 主题在设置中心「外观」；
 * - System 页签（activity 波形）：termX 系统监控走独立监控页；
 * - 「保存为默认布局」按钮：termX 无工作区默认布局概念；
 * - 「停靠位置」选择器：termX 侧栏固定右侧。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Profile } from "../backend/client";
import {
  SIDE_PANEL_TOOLBAR_HEIGHT,
  SIDE_PANEL_TOOLS,
  SIDE_PANEL_WIDTH_STORAGE_KEY,
  clampSidePanelWidth,
  getSidePanelMaxWidth,
  parseStoredSidePanelWidth,
  resolveSidePanelToolTabs,
  type SidePanelTool,
} from "../domain/terminalSidePanel";
import { NotesPanel } from "../notes/NotesPanel";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { SftpSidePane } from "../sftp/SftpSidePane";
import type { PaneHandle } from "../TerminalPane";
import { Icon, type IconName } from "../ui/icons";
import { ScriptsSidePane } from "./ScriptsSidePanel";

const TOOL_META: Record<
  SidePanelTool,
  { icon: IconName; label: string }
> = {
  sftp: { icon: "folder-tree", label: "SFTP" },
  scripts: { icon: "play", label: "脚本" },
  history: { icon: "history", label: "历史" },
  notes: { icon: "notebook", label: "笔记" },
};

type Layout = "single" | "row" | "column";

interface PaneState {
  id: string;
  tool: SidePanelTool;
}

interface Props {
  /** 当前工具页（由 App 保存；右键「打开 SFTP」会置为 sftp）。 */
  tool: SidePanelTool;
  onToolChange: (tool: SidePanelTool) => void;
  onClose: () => void;
  /** 活动 SSH 会话 id（SFTP 复用该会话通道）。 */
  sshSessionId: string | null;
  /** 终端 OSC 7 当前目录（SFTP 起始 / 跟随 / 跳到终端目录）。 */
  terminalCwd: string | null;
  /** 主机显示名 / user@host:port。 */
  sessionLabel: string;
  sessionMeta: string;
  hostId?: string;
  profiles: Profile[];
  onOpenHost: (profile: Profile) => void;
  /** 活动窗格（脚本运行 / 在终端打开路径）。 */
  activeHandle: PaneHandle | null;
  onRevealInTerminal?: (path: string) => void;
}

/** 读取持久化宽度并夹取到当前窗口。 */
function initialWidth(): number {
  try {
    // 保存的「期望宽度」按 280–1200 夹取，不受当前窗口临时变窄影响；
    // 实际展示宽度在渲染时再按可用空间夹取（窗口变宽后自动还原）。
    return parseStoredSidePanelWidth(
      window.localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY),
      9999,
    );
  } catch {
    return 420;
  }
}

export function TerminalSidePanel({
  tool,
  onToolChange,
  onClose,
  sshSessionId,
  terminalCwd,
  sessionLabel,
  sessionMeta,
  hostId,
  profiles,
  onOpenHost,
  activeHandle,
  onRevealInTerminal,
}: Props) {
  const [desiredWidth, setDesiredWidth] = useState(initialWidth);
  const [maximized, setMaximized] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const width = maximized
    ? getSidePanelMaxWidth(viewportWidth)
    : clampSidePanelWidth(desiredWidth, viewportWidth);
  const [panes, setPanes] = useState<PaneState[]>([{ id: "p0", tool }]);
  const [focusedPaneId, setFocusedPaneId] = useState("p0");
  const [layout, setLayout] = useState<Layout>("single");
  const [moreMenu, setMoreMenu] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 外部工具页变化（App 打开 SFTP / 笔记）：同步到焦点 pane。
  useEffect(() => {
    setPanes((prev) =>
      prev.map((pane) =>
        pane.id === focusedPaneId ? { ...pane, tool } : pane,
      ),
    );
  }, [tool, focusedPaneId]);

  // 窗口缩放：仅更新可用宽度，期望宽度保留（窗口变宽后自动还原）。
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistWidth = (next: number) => {
    try {
      window.localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(next));
    } catch {
      // 存储不可用时仅本次生效。
    }
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: width };
    setMaximized(false);
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // 面板在右侧：向左拖 = 变宽。
      const next = clampSidePanelWidth(
        drag.startWidth + (drag.startX - ev.clientX),
        window.innerWidth,
      );
      setDesiredWidth(next);
      dragRef.current = { ...drag, startWidth: next, startX: ev.clientX };
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDesiredWidth((current) => {
        persistWidth(current);
        return current;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const focusedPane =
    panes.find((pane) => pane.id === focusedPaneId) ?? panes[0];
  const activeTool = focusedPane?.tool ?? tool;

  const tabs = useMemo(
    () => resolveSidePanelToolTabs(SIDE_PANEL_TOOLS, width),
    [width],
  );

  /** 切换焦点 pane 的工具页（同时回写 App 的 tool）。 */
  const selectTool = (next: SidePanelTool) => {
    setPanes((prev) =>
      prev.map((pane) =>
        pane.id === focusedPaneId ? { ...pane, tool: next } : pane,
      ),
    );
    onToolChange(next);
  };

  /** 分屏：单 pane 时克隆当前工具页，已分屏时仅调整方向。 */
  const split = (next: Layout) => {
    if (panes.length < 2) {
      const source = focusedPane ?? panes[0];
      const id = `p${Date.now()}`;
      setPanes([{ ...source }, { id, tool: source.tool }]);
      setLayout(next);
      setFocusedPaneId(source.id);
      return;
    }
    setLayout(next);
  };

  /** 放大 / 还原整个侧栏（Netcatty 的 Maximize2 语义，不是窗格最大化）。 */
  const toggleMaximize = () => setMaximized((current) => !current);

  const closePane = (id: string) => {
    if (panes.length <= 1) {
      onClose();
      return;
    }
    const rest = panes.filter((pane) => pane.id !== id);
    setPanes(rest);
    setLayout("single");
    setFocusedPaneId(rest[0].id);
  };

  const renderTool = (pane: PaneState) => {
    if (pane.tool === "sftp") {
      return (
        <SftpSidePane
          sshSessionId={sshSessionId}
          terminalCwd={terminalCwd}
          label={sessionLabel}
          meta={sessionMeta}
          hostId={hostId}
          onRevealInTerminal={onRevealInTerminal}
        />
      );
    }
    if (pane.tool === "scripts") {
      return <ScriptsSidePane activeHandle={activeHandle} />;
    }
    if (pane.tool === "history") {
      return (
        <CommandHistoryPanel
          hostId={hostId ?? ""}
          hostLabel={sessionLabel}
          onClose={onClose}
          onRun={(command) => activeHandle?.sendText(`${command}\r`)}
          onPaste={(command) => activeHandle?.sendText(command)}
        />
      );
    }
    return <NotesPanel profiles={profiles} onOpenHost={onOpenHost} />;
  };

  const bodyLayout = panes.length > 1 ? layout : "single";

  return (
    <aside
      className="nc-side-panel"
      style={{ width }}
      data-section="terminal-side-panel"
      data-side-panel-width={width}
      data-active-tool={activeTool}
    >
      <div
        className="nc-side-panel-resizer"
        role="separator"
        aria-label="调整侧栏宽度"
        aria-orientation="vertical"
        onPointerDown={startResize}
      />
      <div
        className="nc-side-panel-tabs"
        data-section="terminal-side-panel-tabs"
        style={{ height: SIDE_PANEL_TOOLBAR_HEIGHT }}
      >
        <div className="nc-side-panel-tools">
          {tabs.shown.map((name) => {
            const meta = TOOL_META[name];
            const active = activeTool === name;
            return (
              <button
                key={name}
                className={
                  active ? "nc-side-panel-tool active" : "nc-side-panel-tool"
                }
                aria-label={meta.label}
                title={meta.label}
                aria-pressed={active}
                onClick={() => selectTool(name)}
              >
                <Icon name={meta.icon} size={15} />
              </button>
            );
          })}
          {tabs.hidden.length > 0 && (
            <button
              className={
                moreMenu
                  ? "nc-side-panel-tool active"
                  : "nc-side-panel-tool"
              }
              aria-label="更多工具"
              title="更多工具"
              aria-expanded={moreMenu}
              onClick={() => setMoreMenu((v) => !v)}
            >
              <Icon name="more-horizontal" size={15} />
            </button>
          )}
        </div>
        <div className="nc-side-panel-actions">
          <button
            className="nc-side-panel-tool"
            aria-label={maximized ? "还原侧栏宽度" : "放大侧栏"}
            title={maximized ? "还原侧栏宽度" : "放大侧栏"}
            aria-pressed={maximized}
            onClick={toggleMaximize}
          >
            <Icon name="maximize" size={15} />
          </button>
          <button
            className="nc-side-panel-tool"
            aria-label="上下分屏"
            title="上下分屏"
            onClick={() => split("row")}
          >
            <Icon name="split-horizontal" size={15} />
          </button>
          <button
            className="nc-side-panel-tool"
            aria-label="左右分屏"
            title="左右分屏"
            onClick={() => split("column")}
          >
            <Icon name="split-vertical" size={15} />
          </button>
          <button
            className="nc-side-panel-tool"
            aria-label="关闭侧栏"
            title="关闭侧栏"
            onClick={onClose}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        {moreMenu && tabs.hidden.length > 0 && (
          <div className="nc-side-panel-more">
            {tabs.hidden.map((name) => {
              const meta = TOOL_META[name];
              return (
                <button
                  key={name}
                  className={
                    activeTool === name
                      ? "nc-side-panel-more-item active"
                      : "nc-side-panel-more-item"
                  }
                  onClick={() => {
                    selectTool(name);
                    setMoreMenu(false);
                  }}
                >
                  <Icon name={meta.icon} size={13} />
                  <span>{meta.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={`nc-side-panel-body ${bodyLayout}`}>
        {panes.map((pane) => (
          <div
            key={pane.id}
            className={
              pane.id === focusedPaneId
                ? "nc-side-panel-pane focused"
                : "nc-side-panel-pane"
            }
            data-section="terminal-side-panel-pane"
            data-pane-tool={pane.tool}
            onPointerDown={() => setFocusedPaneId(pane.id)}
          >
            {panes.length > 1 && (
              <div className="nc-side-panel-pane-header">
                <Icon name={TOOL_META[pane.tool].icon} size={12} />
                <span>{TOOL_META[pane.tool].label}</span>
                <div className="nc-side-panel-pane-spacer" />
                <button
                  className="nc-side-panel-pane-close"
                  aria-label={`关闭 ${TOOL_META[pane.tool].label} 面板`}
                  title="关闭面板"
                  onClick={(e) => {
                    e.stopPropagation();
                    closePane(pane.id);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}
            <div className="nc-side-panel-pane-content">{renderTool(pane)}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}


