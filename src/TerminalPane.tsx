/**
 * 单个终端窗格：自持 xterm、会话、事件订阅与连接管理。
 *
 * 连接建立 / 管理状态机移植自 netcatty `components/Terminal.tsx` +
 * `components/terminal/runtime/createTerminalSessionStarters.ts`：
 * - connecting：连接弹窗（三阶段进度、逐跳日志、超时倒计时、取消）；
 * - needsAuth：认证失败后在弹窗内重试（一次性覆盖，不写回 DB）；
 * - hostKey：未知 / 变更的主机密钥校验；
 * - disconnected：错误 + 关闭会话 / 重新连接（Enter 可重连）。
 *
 * 与旧版 App 单会话的区别：
 * - 每格独立一个 sessionId 与传输对象，互不影响；
 * - 断线后保留终端内容，由连接弹窗提示；
 * - 支持 SSH / 本地 / 串口 / Telnet 四种传输，各自独立连接与生命周期。
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { PanelRight } from "lucide-react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { TerminalView, type TerminalController } from "./Terminal";
import { ComposeBar } from "./terminal/ComposeBar";
import { appendComposeHistory, buildComposePayload, buildPastePayload } from "./terminal/composeBarModel";
import { insertSnippetIntoCompose } from "./terminal/composeBarSnippets";
import { loadComposeDraft, resolveComposeDraftKey, saveComposeDraft } from "./terminal/composeDraft";
import {
  readCommandHistory,
  recordCommandHistory,
  resolveCommandHistoryHostId,
} from "./terminal/commandHistoryModel";
import {
  AUTOCOMPLETE_DEBOUNCE_MS,
  classifyAutocompleteData,
  computeAutocompleteAcceptTail,
  computeAutocompleteGhost,
  computeAutocompletePopupPlacement,
  computeLivePreviewWrite,
  deriveAutocompleteSuggestions,
  derivePathArgumentHistory,
  mergeAutocompleteSuggestions,
  moveAutocompleteSelection,
  resolveAutocompleteKey,
  type AutocompleteSuggestion,
} from "./terminal/autocompleteModel";
import {
  PATH_COMPLETION_BUDGET_MS,
  buildPathSuggestions,
  createPathDirectoryCache,
  currentWordOf,
  filterPathEntries,
  joinDirectoryPath,
  replaceCommandWord,
  resolvePathLookup,
  shouldCompletePath,
  sortPathEntries,
  withPathBudget,
  type PathEntry,
} from "./terminal/autocompletePathModel";
import { Icon } from "./ui/icons";
import * as api from "./backend/client";
import { SessionMonitorPopover } from "./monitor/SessionMonitorPopover";
import {
  SNIPPETS_CHANGED_EVENT,
  isScriptSnippet,
  parseShortkey,
  parseSnippetVariables,
  previewSnippetCommand,
  resolveScriptTrigger,
  shortkeyMatches,
  snippetWritePlan,
} from "./snippets/snippetsModel";
import { parseScriptBlocks, runScriptBlocks } from "./snippets/scriptRunner";
import { appendScriptTrigger } from "./snippets/scriptTriggerLog";
import "./snippets/snippets.css";
import type {
  AuthOverride,
  AuthPrompt,
  CloseInfo,
  SshProgressEvent,
  TerminalDomain,
  TerminalTransport,
} from "./backend/client";
import type { Tab } from "./workspaceModel";
import { getSettings, subscribeSettings, updateSettings } from "./settings/settingsStore";
import { cloneKeywordHighlightRules, normalizeHostKeywordHighlightRules, type KeywordHighlightRule } from "./settings/settingsModel";
import {
  cellOffsets,
  compileKeywordRules,
  findKeywordSpans,
  mergeKeywordHighlightRules,
  validateKeywordRuleDraft,
} from "./terminal/keywordHighlight";
import { subscribeHostKeywordHighlightChanged } from "./terminal/hostKeywordHighlight";
import { readTerminalSelection } from "./Terminal";
import {
  advanceIndeterminateConnectionProgress,
  advanceMonotonicConnectionProgress,
  CONNECTION_PROGRESS_START,
  resolveHopConnectionProgress,
} from "./domain/connectionProgress";
import {
  DEFAULT_SSH_AUTH_READY_TIMEOUT_SECONDS,
  getConnectionTimeoutMs,
  hasConnectionPassedTcpDial,
  shouldRunConnectionTimeout,
} from "./domain/sshConnectionTimeouts";
import { toHostKeyInfo, type HostKeyInfo } from "./domain/hostKey";
import { isAuthFailureMessage, userVisibleError } from "./domain/sshErrors";
import { createSerialInput } from "./domain/serialInput";
import { formatTelnetLocalEcho } from "./domain/telnetEcho";
import {
  appendKeystrokes,
  beginScriptRecording,
  buildScriptCommand,
  createScriptRecordingBuffer,
  endScriptRecording,
  type ScriptRecordingBuffer,
} from "./terminal/scriptRecording";
import {
  TerminalConnectionDialog,
  type ChainProgress,
  type HostConnectionInfo,
} from "./terminal/TerminalConnectionDialog";
import type { AuthKeyOption, TerminalAuthMethod } from "./terminal/TerminalAuthDialog";
import {
  buildOsc7SetupPlan,
  osc7ReloadCommand,
  parseOsc7Cwd,
  parseOsc7SetupResult,
} from "./terminal/osc7";
import {
  createTerminalDecoder,
  loadTerminalEncoding,
  saveTerminalEncoding,
  terminalEncodingLabel,
  type TerminalDecoder,
  type TerminalEncoding,
} from "./terminal/terminalEncoding";
import { deriveToolbarCapabilities } from "./terminal/toolbarCapabilities";
import type { ConnectionStatus } from "./terminal/connectionStatus";
import {
  resolveTerminalMoreActions,
  resolveTerminalTitlebarActions,
  resolveTerminalToolbarActions,
} from "./terminal/toolbarLayout";
import {
  TERMINAL_CONTEXT_MENU_TEXT,
  TERMINAL_MORE_TEXT,
  TERMINAL_TOOLBAR_TEXT,
  terminalRecordingText,
} from "./terminal/terminalActionText";
import { resolveTerminalContextMenu } from "./terminal/contextMenuLayout";
import {
  createZmodemController,
  type ZmodemController,
  type ZmodemEvent,
} from "./terminal/zmodem";
import {
  resolveInputCompatibility,
  splitCompatibleWrites,
} from "./terminal/inputCompatibility";

/** 搜索高亮配色，逐项对齐 Netcatty `SEARCH_DECORATIONS`。 */
const SEARCH_DECORATIONS = {
  matchBackground: "#FFFF0044",
  matchBorder: "#FFFF00",
  matchOverviewRuler: "#FFFF00",
  activeMatchBackground: "#FF880088",
  activeMatchBorder: "#FF8800",
  activeMatchColorOverviewRuler: "#FF8800",
} as const;

/** 搜索选项：非正则 / 忽略大小写 / 非整词，附带高亮装饰。 */
const SEARCH_OPTIONS = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  decorations: SEARCH_DECORATIONS,
} as const;

type PaneStatus = ConnectionStatus;

/** 自动补全浮层的锚点（相对 pane 的像素坐标 + 单元格 / 字体信息）。 */
interface AutocompleteAnchor {
  left: number;
  top: number;
  cellW: number;
  cellH: number;
  paneWidth: number;
  paneHeight: number;
  fontFamily: string;
  fontSize: string;
}

/** 浮层的子面板（逐级下钻目录）：每级 240 宽。 */
interface AutocompleteSubPanel {
  dirPath: string;
  entries: PathEntry[];
  selected: number;
}

interface AutocompleteUiState {
  popup: boolean;
  suggestions: AutocompleteSuggestion[];
  selected: number;
  ghost: string;
  anchor: AutocompleteAnchor;
  subPanels: AutocompleteSubPanel[];
  subFocus: number;
}

type Prompt =
  | { kind: "auth"; sessionId: string; payload: AuthPrompt }
  | { kind: "passphrase"; sessionId: string; payload: { prompt: string } };

/** 输出行时间戳开关的持久化（应用级，四类终端共用）。 */
const SHOW_TIMESTAMPS_KEY = "termx.terminal.showTimestamps.v1";

function readShowTimestamps(): boolean {
  try {
    return window.localStorage.getItem(SHOW_TIMESTAMPS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistShowTimestamps(value: boolean) {
  try {
    window.localStorage.setItem(SHOW_TIMESTAMPS_KEY, value ? "1" : "0");
  } catch {
    // 存储不可用时仅本次生效。
  }
}

/** 窗格对外的句柄：供工作区切换活动窗格并订阅读话状态。 */
export interface PaneHandle {
  paneId: string;
  /** 本窗格 SSH 会话 id；非 SSH 或未连接为 null。 */
  sshSessionId: () => string | null;
  /** 订阅 SSH 会话变化（连接 / 断开时回调）。 */
  subscribeSession: (cb: (sid: string | null) => void) => () => void;
  /** 最近一次 OSC 7 上报的远端目录（未上报 / 非 SSH 为 null）。 */
  cwd: () => string | null;
  /** 订阅 cwd 变化（SFTP 跟随终端目录用）。 */
  subscribeCwd: (cb: (cwd: string | null) => void) => () => void;
  /** 重新连接当前窗格（对齐 Netcatty 标签右键「重连」）。 */
  reconnect: () => void;
  focus: () => void;
  /** 本窗格是否已连接（脚本页运行按钮据此置灰）。 */
  connected: () => boolean;
  /** 运行片段 / 脚本：复用终端右键插入同一发送链路；未连接返回 false。 */
  runSnippet: (snippet: api.Snippet) => boolean;
  /** 直接向终端写入文本（侧栏「在终端中打开当前路径」）；未连接返回 false。 */
  sendText: (text: string) => boolean;
  /** 停止脚本：发送 Ctrl-C（SIGINT）并清空逐行待发送队列。 */
  interrupt: () => boolean;
  /** 暂停：发送 Ctrl-Z（SIGTSTP），仅对被 Ctrl-Z 挂起的前台任务有意义。 */
  suspend: () => boolean;
  /** 恢复：发送 fg + 回车。 */
  resume: () => boolean;
  /** 打开终端内搜索框（快捷键 Ctrl/Cmd+F）。 */
  openSearch: () => boolean;
  /** 打开 / 关闭撰写栏（快捷键分发用）。 */
  toggleCompose: () => boolean;
  /** 复制当前选区；无选区返回 false（快捷键不拦截）。 */
  copySelection: () => boolean;
  /** 读取系统剪贴板并粘贴。 */
  pasteClipboard: () => boolean;
  /** 全选终端内容。 */
  selectAllText: () => boolean;
  /** 清屏（含回滚缓冲区）。 */
  clearBuffer: () => boolean;
}

/** 自动打开侧栏时可落地的视图；Netcatty 的 theme/system/ai/browser 在 termX 未移植，忽略。 */
const AUTO_OPEN_SIDE_PANEL_PANES: Record<string, "sftp" | "scripts" | "history" | "notes"> = {
  sftp: "sftp",
  scripts: "scripts",
  history: "history",
  notes: "notes",
};

interface Props {
  tab: Tab;
  paneId: string;
  active: boolean;
  onActivate: () => void;
  onRegister: (paneId: string, handle: PaneHandle | null) => void;
  onStatus: (text: string) => void;
  /** 连接状态变化（供会话标签状态点使用）。 */
  onConnectionStatus?: (status: PaneStatus) => void;
  /** 打开右侧工具面板（SFTP / 脚本 / 历史 / 笔记）。 */
  onOpenTool?: (tool: "sftp" | "scripts" | "history" | "notes") => void;
  /** 展开 / 收起主机右侧栏（与左侧栏开关成对）。 */
  sidePanelOpen?: boolean;
  onToggleSidePanel?: () => void;
  /** 关闭当前窗格。 */
  onClosePane?: () => void;
  /** 分屏（在当前标签内）。 */
  onSplit?: (dir: "horizontal" | "vertical") => void;
  /** 打开设置中心（「更多」→ 终端设置）。 */
  onOpenSettings?: () => void;
}

const AUTH_RETRY_MESSAGE = "身份验证失败。请检查凭据后重试。";
const PROGRESS_ATTEMPT_TIMEOUT_MESSAGE = "连接超时，请重试。";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clockLabel(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/**
 * 常用标准色块：黑/红/绿/黄/蓝/品红/青/白 + 橙/紫/灰。
 * 深浅主题下都选中间明度，避免纯黑/纯白在另一种主题里糊成一片。
 */
const HIGHLIGHT_COLOR_SWATCHES: { name: string; color: string }[] = [
  { name: "黑", color: "#111111" },
  { name: "红", color: "#F87171" },
  { name: "绿", color: "#34D399" },
  { name: "黄", color: "#FBBF24" },
  { name: "蓝", color: "#3B82F6" },
  { name: "品红", color: "#EC4899" },
  { name: "青", color: "#22CCCC" },
  { name: "白", color: "#FFFFFF" },
  { name: "橙", color: "#FB923C" },
  { name: "紫", color: "#A78BFA" },
  { name: "灰", color: "#94A3B8" },
];

/** 色块选中对勾的对比色：浅色块配深勾，深色块配白勾。 */
function highlightCheckTone(hex: string): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return "#FFFFFF";
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#111111" : "#FFFFFF";
}

/**
 * 颜色选择：一排标准色块点选；自定义取色是补充入口（原生取色器），
 * 不再作为唯一方式。当前值不命中标准色时「自定义」块高亮并显示该颜色值。
 */
function HighlightColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const normalized = value.toUpperCase();
  const isStandard = HIGHLIGHT_COLOR_SWATCHES.some(
    (swatch) => swatch.color.toUpperCase() === normalized,
  );
  return (
    <div className="term-highlight-color-picker">
      <div className="term-highlight-color-swatches" role="radiogroup" aria-label="规则颜色">
        {HIGHLIGHT_COLOR_SWATCHES.map((swatch) => {
          const selected = swatch.color.toUpperCase() === normalized;
          return (
            <button
              key={swatch.color}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={swatch.name}
              title={swatch.name}
              className={`term-highlight-color-chip${selected ? " is-selected" : ""}`}
              style={{ background: swatch.color }}
              onClick={() => onChange(swatch.color)}
            >
              {selected && (
                <Icon name="check" size={11} style={{ color: highlightCheckTone(swatch.color) }} />
              )}
            </button>
          );
        })}
        <label
          className={`term-highlight-color-custom${isStandard ? "" : " is-active"}`}
          title="自定义颜色"
        >
          <input
            type="color"
            value={normalized}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
            aria-label="自定义颜色"
          />
          {isStandard ? (
            <Icon name="pencil" size={11} />
          ) : (
            <span className="term-highlight-color-dot" style={{ background: normalized }} />
          )}
          <span className="term-highlight-color-custom-text">
            {isStandard ? "自定义" : normalized}
          </span>
        </label>
      </div>
    </div>
  );
}

/**
 * 规则实时预览：用真实匹配引擎（compileKeywordRules / findKeywordSpans）
 * 对示例行着色，颜色改动即时反映；patterns 无法命中时仍显示色点与标签。
 */
function HighlightRulePreview({
  label,
  patterns,
  color,
}: {
  label: string;
  patterns: string[];
  color: string;
}) {
  const text = `示例输出：${label || "关键字"}`;
  const spans = findKeywordSpans(
    text,
    compileKeywordRules([{ id: "preview", label, patterns, color, enabled: true }]),
  );
  const nodes: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    if (span.start > cursor) {
      nodes.push(<span key={`t${index}`}>{text.slice(cursor, span.start)}</span>);
    }
    nodes.push(
      <span key={`s${index}`} style={{ color: span.color, fontWeight: 600 }}>
        {text.slice(span.start, span.end)}
      </span>,
    );
    cursor = span.end;
  });
  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  return (
    <div className="term-highlight-preview">
      <span className="term-highlight-preview-dot" style={{ background: color }} />
      <span className="term-highlight-preview-caption">实时预览</span>
      <span className="term-highlight-preview-text">{nodes}</span>
    </div>
  );
}

export function TerminalPane({
  tab,
  paneId,
  active,
  onActivate,
  onRegister,
  onStatus,
  onConnectionStatus,
  onOpenTool,
  sidePanelOpen,
  onToggleSidePanel,
  onClosePane,
  onSplit,
  onOpenSettings,
}: Props) {
  const isSsh = tab.connector.kind === "ssh";
  const sshProfileId = tab.connector.kind === "ssh" ? tab.connector.profileId : null;
  /** 终端编码按主机持久化的 key：SSH 用 profileId，Telnet 用来源档案 id。 */
  const encodingProfileId =
    tab.connector.kind === "ssh"
      ? tab.connector.profileId
      : tab.connector.kind === "telnet"
        ? tab.connector.session.profileId ?? null
        : null;

  const [status, setStatus] = useState<PaneStatus>("connecting");
  // 会话标签状态点：把窗格级连接状态上报给 Workspace（对照 Netcatty tab dot）。
  // 回调用 ref 持有：父组件每次渲染都会新建箭头函数，若进依赖会在每次渲染都 setState。
  const onConnectionStatusRef = useRef(onConnectionStatus);
  onConnectionStatusRef.current = onConnectionStatus;
  useEffect(() => {
    onConnectionStatusRef.current?.(status);
  }, [status]);
  const [error, setError] = useState<string | null>(null);
  const [progressValue, setProgressValue] = useState(CONNECTION_PROGRESS_START);
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [chainProgress, setChainProgress] = useState<ChainProgress | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [timeLeft, setTimeLeft] = useState(DEFAULT_SSH_AUTH_READY_TIMEOUT_SECONDS);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authRetryMessage, setAuthRetryMessage] = useState<string | null>(null);
  /** 当前是否在等待用户输入（keyboard-interactive / passphrase / 主机密钥）。 */
  const [isAwaitingUserInput, setIsAwaitingUserInput] = useState(false);
  const [isConnectionPastTcpDial, setIsConnectionPastTcpDial] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [disconnectedDismissed, setDisconnectedDismissed] = useState(false);
  const [hostKeyInfo, setHostKeyInfo] = useState<HostKeyInfo | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  /**
   * 快捷键插入含 {{变量}} 的片段：先收集取值再写入。
   * 与脚本页运行入口保持一致，避免把占位符原样发给 shell。
   */
  const [snippetVarPrompt, setSnippetVarPrompt] = useState<{
    snippet: api.Snippet;
    values: Record<string, string>;
    /** send = 填值后直接发送；insert = 填值后只插入撰写栏草稿。 */
    mode: "send" | "insert";
  } | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 工具栏「系统监控」浮层开关（仅 SSH 已连接会话可用）。 */
  const [monitorOpen, setMonitorOpen] = useState(false);
  /** ZMODEM 传输提示（检测 / 进度 / 完成 / 错误），空闲为 null。 */
  const [zmodemState, setZmodemState] = useState<ZmodemEvent | null>(null);
  /** 文件拖拽悬停在终端上时显示投放蒙层。 */
  const [zmodemDragActive, setZmodemDragActive] = useState(false);
  /**
   * 终端编码（Netcatty `encoding`）：按主机记住选择，输出用 TextDecoder
   * 解码、输入交给后端重编码。与日志/录制无关，独立于会话生命周期。
   */
  const [encoding, setEncoding] = useState<TerminalEncoding>(() =>
    tab.connector.kind === "telnet" && tab.connector.session.encoding
      ? tab.connector.session.encoding
      : loadTerminalEncoding(encodingProfileId),
  );
  const encodingRef = useRef<TerminalEncoding>(encoding);
  /**
   * 输入兼容模式快照（对齐 Netcatty 的 session-owned terminalSettingsRef）：
   * 连接建立时读一次主机配置，本次会话内不再跟随设置变化；重连会重新取快照。
   */
  const inputCompatRef = useRef(false);
  const decoderRef = useRef<TerminalDecoder>(createTerminalDecoder(encoding));
  /** 终端编码子菜单（Netcatty 折叠项里的二级选择）。 */
  const [encodingMenuOpen, setEncodingMenuOpen] = useState(false);
  /**
   * OSC 7 目录追踪：`cwd` 是最近一次上报的远端目录；`cwdTracked` 表示本轮
   * 会话已经收到过上报（菜单里据此显示「已启用」）。
   */
  const [cwd, setCwd] = useState<string | null>(null);
  const [cwdTracked, setCwdTracked] = useState(false);
  const [osc7DialogOpen, setOsc7DialogOpen] = useState(false);
  const [osc7Busy, setOsc7Busy] = useState(false);
  /**
   * 文本会话日志状态：后端把输出写成剥 ANSI 的 `.log`（默认目录 + 命名模板）。
   * 主机「自动记录」与工具栏手动开始共用同一文本槽，按钮据此显示录制态。
   * 与「开始录制」（脚本录制）是两套独立能力，互不共享状态与产物。
   */
  const [sessionLog, setSessionLog] = useState<api.ManualSessionLogStatus | null>(
    null,
  );
  const [logBusy, setLogBusy] = useState(false);
  /** 脚本录制（Netcatty `recording`）：记录输入命令，停止后生成脚本片段。 */
  const [scriptRec, setScriptRec] = useState(false);
  const [scriptRecBusy, setScriptRecBusy] = useState(false);
  /** 自动补全浮层（候选下拉 / 内联 ghost text），空闲为 null。 */
  const [autocompleteUi, setAutocompleteUi] = useState<AutocompleteUiState | null>(null);
  /** 历史分桶 id：非 SSH 终端按连接参数（端口 / 主机 / shell）区分，不随标签标题变化。 */
  const historyHostId = resolveCommandHistoryHostId(tab.connector);
  /** 输出行时间戳（工具栏时钟开关；应用级持久化，四类终端共用）。 */
  const [showTimestamps, setShowTimestamps] = useState(readShowTimestamps);
  /** 撰写栏 / 终端搜索 / 主机关键词高亮。 */
  const [composeOpen, setComposeOpen] = useState(false);
  /**
   * 撰写草稿：仅绑定已保存主机的终端（SSH / 来自已保存主机的串口·Telnet）
   * 按主机记忆并恢复；本地 shell 与临时串口·Telnet 不保存也不恢复。
   */
  const composeDraftHostKey = resolveComposeDraftKey(tab.connector);
  const [composeText, setComposeText] = useState(() =>
    loadComposeDraft(resolveComposeDraftKey(tab.connector)),
  );
  /** 本窗格的撰写发送历史（↑↓ 翻阅；与终端命令历史分离）。 */
  const [composeHistory, setComposeHistory] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [highlightOpen, setHighlightOpen] = useState(false);
  /** 主机规则的「添加」草稿；对齐 Netcatty HostKeywordHighlightPopover（名称 + 颜色 + 正则）。 */
  const [hostHighlightLabel, setHostHighlightLabel] = useState("");
  const [hostHighlightPattern, setHostHighlightPattern] = useState("");
  const [hostHighlightColor, setHostHighlightColor] = useState("#F87171");
  const [hostHighlightError, setHostHighlightError] = useState("");
  /** 已有规则的编辑态：非 null 时浮层切到编辑器（名称 / 正则 / 颜色 / 启用）。 */
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editRuleLabel, setEditRuleLabel] = useState("");
  const [editRulePatterns, setEditRulePatterns] = useState("");
  const [editRuleColor, setEditRuleColor] = useState("#F87171");
  const [editRuleEnabled, setEditRuleEnabled] = useState(true);
  const [editRuleError, setEditRuleError] = useState("");
  /** 关键字高亮规则来自设置（设置页与工具栏浮层共享同一份，改后即时重绘）。 */
  const [highlightEnabled, setHighlightEnabled] = useState(
    () => getSettings().terminal.keywordHighlightEnabled,
  );
  const [highlightRules, setHighlightRules] = useState<KeywordHighlightRule[]>(() =>
    cloneKeywordHighlightRules(getSettings().terminal.keywordHighlightRules),
  );
  /**
   * 主机级规则（schema v50，对齐 Netcatty Host.keywordHighlightRules）：
   * 连接期间追加到全局规则，断开回落全局。
   */
  const [hostHighlightEnabled, setHostHighlightEnabled] = useState(false);
  const [hostHighlightRules, setHostHighlightRules] = useState<KeywordHighlightRule[]>([]);
  /**
   * 高亮浮层的「仅显示匹配行」：纯界面过滤，只影响本窗格渲染；
   * 后端会话日志 / asciicast 自动录制在数据到达前端前已完成写入，不受影响。
   * 关闭时从关闭那一刻恢复全量，关闭前被过滤掉的历史不回流。
   */
  const [onlyMatchingLines, setOnlyMatchingLines] = useState(false);
  const onlyMatchingLinesRef = useRef(false);
  /** 过滤判断复用着色规则（effectiveHighlight 编译结果）。 */
  const filterRulesRef = useRef<ReturnType<typeof compileKeywordRules>>([]);
  /** 过滤模式下行缓冲：等待 \n 的未完成行。 */
  const filterPendingRef = useRef("");
  /** 回填 / 内部清屏时绕过过滤。 */
  const filterBypassRef = useRef(false);
  /** 串口字节流解码（过滤模式需要文本做行匹配）。 */
  const serialFilterDecoderRef = useRef<TextDecoder | null>(null);

  /**
   * 拉取本主机的高亮规则；主机编辑器保存后广播 profileId，已开终端重拉
   * （无需重启）。主机级规则仅 SSH 有（主机编辑器也只对其可见）；
   * 本地 / 串口 / Telnet 恒为空，只用全局规则。
   */
  useEffect(() => {
    const profileId = sshProfileId;
    if (!profileId) {
      setHostHighlightEnabled(false);
      setHostHighlightRules([]);
      return;
    }
    let disposed = false;
    const load = () => {
      void api
        .getProfile(profileId)
        .then((p) => {
          if (disposed) return;
          setHostHighlightEnabled(p.keyword_highlight_enabled === true);
          const next = normalizeHostKeywordHighlightRules(p.keyword_highlight_rules ?? []);
          setHostHighlightRules((prev) =>
            JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
          );
        })
        .catch(() => {
          if (disposed) return;
          setHostHighlightEnabled(false);
          setHostHighlightRules([]);
        });
    };
    load();
    const unsubscribe = subscribeHostKeywordHighlightChanged((changed) => {
      if (changed === profileId) load();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [sshProfileId]);
  /** 片段 / 脚本列表（P0 #5）：右键插入与快捷键，均只写入本窗格自己的会话。 */
  const [snippets, setSnippets] = useState<api.Snippet[]>([]);
  /** 自动触发用最新快照（异步回调里避免闭包旧值）。 */
  const snippetsRef = useRef<api.Snippet[]>([]);
  /** 本会话已触发的 onOutput 脚本（同一会话只触发一次）。 */
  const firedOutputRef = useRef<Set<string>>(new Set());
  const outputCheckTimerRef = useRef<number | null>(null);
  useEffect(() => {
    snippetsRef.current = snippets;
  }, [snippets]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .loadSnippets()
        .then((list) => {
          if (alive) setSnippets(list);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(SNIPPETS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(SNIPPETS_CHANGED_EVENT, load);
    };
  }, []);

  /**
   * 连接建立后拉取一次文本会话日志状态：主机自动记录开启时按钮直接进入
   * 录制态；手动开始 / 停止也会用同一个 `.log` 槽。断开即清空并结束脚本录制。
   */
  useEffect(() => {
    const sid = status === "connected" ? sidRef.current : null;
    if (!sid) {
      setSessionLog(null);
      // 断线时 sidRef 已被 notifySession(null) 清空，必须用录制时记下的
      // 会话 id 释放全局槽，否则其它终端会一直报「已有其他终端正在录制」。
      const recSid = scriptRecSidRef.current;
      if (recSid) {
        endScriptRecording(recSid);
        scriptRecSidRef.current = null;
      }
      setScriptRec(false);
      return;
    }
    let alive = true;
    api
      .manualSessionLogStatus(sid)
      .then((rec) => {
        if (alive) setSessionLog(rec);
      })
      .catch(() => {
        // 状态查询失败不应打断终端使用，静默即可。
      });
    return () => {
      alive = false;
    };
  }, [status, isSsh]);

  /**
   * 编码切换即时生效：重建流式解码器（清掉半截多字节状态）并持久化到该主机。
   * 输入方向由后端 `ssh_write` / `telnet_write` 的 encoding 参数处理。
   */
  useEffect(() => {
    encodingRef.current = encoding;
    decoderRef.current = createTerminalDecoder(encoding);
    saveTerminalEncoding(encodingProfileId, encoding);
  }, [encoding, encodingProfileId]);

  /** 会话断开 / 重连时关闭系统监控浮层（轮询随组件卸载一起清理）。 */
  useEffect(() => {
    if (!isSsh || status !== "connected") setMonitorOpen(false);
  }, [isSsh, status]);

  /** 目录追踪只在活动 SSH 会话上有意义；断开后清空。 */
  useEffect(() => {
    if (status !== "connected") {
      applyCwd(null);
      setCwdTracked(false);
    }
  }, [status]);

  /** 逐行发送的待执行定时器（断开 / 卸载时必须清掉，避免写入错误会话）。 */
  const pendingWritesRef = useRef<number[]>([]);
  /** 句柄注册时是稳定闭包；经 ref 调用最新的插入链路（连接状态随渲染变化）。 */
  const runSnippetRef = useRef<(s: api.Snippet) => boolean>(() => false);
  function clearPendingWrites() {
    pendingWritesRef.current.forEach((id) => window.clearTimeout(id));
    pendingWritesRef.current = [];
  }

  function writeToPane(text: string) {
    transportRef.current?.write(text);
  }

  /** OSC 7 上报：刷新当前目录，标记目录追踪已生效。 */
  function handleOsc7(payload: string) {
    const path = parseOsc7Cwd(payload);
    if (!path) return;
    applyCwd(path);
    setCwdTracked(true);
  }

  /**
   * 「配置目录追踪」：通过 SSH exec 通道写入 shell 钩子，再向交互 shell 发送
   * 一次重载命令；之后 shell 每次出提示符都会上报 OSC 7。
   */
  async function runOsc7Setup() {
    const sid = sidRef.current;
    if (osc7Busy) return;
    if (!sid) {
      setOsc7DialogOpen(false);
      onStatus("目录追踪配置失败：会话未连接");
      return;
    }
    setOsc7Busy(true);
    try {
      const { command } = buildOsc7SetupPlan();
      const result = await api.sshExec(sid, command, 20_000);
      if (result.exit_code !== 0) {
        onStatus(`目录追踪配置失败：${result.stderr.trim() || result.stdout.trim()}`);
        return;
      }
      const { shell } = parseOsc7SetupResult(result.stdout);
      writeToPane(`${osc7ReloadCommand(shell)}\r`);
      setOsc7DialogOpen(false);
      onStatus("目录追踪配置已发送到终端");
    } catch (e) {
      onStatus(`目录追踪配置失败：${userVisibleError(String(e))}`);
    } finally {
      setOsc7Busy(false);
    }
  }

  /** 目录追踪配置对话框：Esc 关闭（与其它模态一致）。 */
  useEffect(() => {
    if (!osc7DialogOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOsc7DialogOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [osc7DialogOpen]);

  /** 屏幕等待 / 自动触发：终端缓冲全文（xterm buffer translateToString）。 */
  function termBufferText(): string {
    const term = controllerRef.current?.term;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i += 1) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  /** 自动触发目标判定：全部主机，或脚本 targets 含当前 Profile.id。 */
  function scriptAppliesToThisHost(s: api.Snippet): boolean {
    if (s.kind !== "script") return false;
    if (s.targets_all_hosts) return true;
    return !!(sshProfileId && (s.targets ?? []).includes(sshProfileId));
  }

  /** 执行一个自动触发脚本并写入触发日志（失败也记录，不伪造成功）。 */
  async function runAutoScript(
    s: api.Snippet,
    kind: "onConnect" | "onOutput",
  ): Promise<void> {
    const detail = kind === "onConnect" ? "连接建立" : `输出匹配 /${s.trigger_pattern}/`;
    appendScriptTrigger({ kind, name: s.name, paneId, detail, status: "started" });
    onStatus(`自动触发脚本：${s.name}`);
    const handle = runScriptBlocks(parseScriptBlocks(s.command), {
      write: (t) => {
        if (aliveRef.current) writeToPane(t);
      },
      readBuffer: termBufferText,
    });
    try {
      await handle.done;
      appendScriptTrigger({ kind, name: s.name, paneId, detail: "完成", status: "done" });
    } catch (e) {
      const msg = userVisibleError(String(e));
      appendScriptTrigger({ kind, name: s.name, paneId, detail: msg, status: "error" });
      onStatus(`脚本自动触发失败：${msg}`);
    }
  }

  /** 连接建立后按顺序执行 onConnect 脚本（仅 SSH 会话）。 */
  async function runOnConnectScripts(): Promise<void> {
    if (!isSsh) return;
    firedOutputRef.current = new Set();
    let all = snippetsRef.current;
    if (!all.length) all = await api.loadSnippets().catch(() => []);
    const scripts = all.filter(
      (s) =>
        isScriptSnippet(s) &&
        resolveScriptTrigger(s.trigger) === "onConnect" &&
        scriptAppliesToThisHost(s),
    );
    for (const s of scripts) {
      // 刚连接时 init_command 可能仍在执行，先等提示符（最多 6s，超时也继续）。
      try {
        await runScriptBlocks([{ kind: "wait-prompt", timeoutMs: 6000 }], {
          write: (t) => {
            if (aliveRef.current) writeToPane(t);
          },
          readBuffer: termBufferText,
        }).done;
      } catch {
        // 提示符未就绪也继续执行连接脚本，避免静默跳过。
      }
      await runAutoScript(s, "onConnect");
    }
  }

  /** 终端输出 → 防抖匹配 onOutput 脚本；同一会话同一脚本只触发一次。 */
  async function checkOutputTriggers(): Promise<void> {
    if (!isSsh || !sshProfileId) return;
    const text = termBufferText().slice(-4000);
    if (!text) return;
    for (const s of snippetsRef.current) {
      if (!isScriptSnippet(s) || resolveScriptTrigger(s.trigger) !== "onOutput") continue;
      if (!scriptAppliesToThisHost(s)) continue;
      if (!s.trigger_pattern || firedOutputRef.current.has(s.id)) continue;
      let re: RegExp;
      try {
        re = new RegExp(s.trigger_pattern, "m");
      } catch {
        continue;
      }
      if (!re.test(text)) continue;
      firedOutputRef.current.add(s.id);
      await runAutoScript(s, "onOutput");
    }
  }

  function scheduleOutputTriggerCheck() {
    if (!isSsh || !sshProfileId) return;
    if (outputCheckTimerRef.current !== null) return;
    outputCheckTimerRef.current = window.setTimeout(() => {
      outputCheckTimerRef.current = null;
      void checkOutputTriggers();
    }, 300);
  }

  /** 下行字节 → 文本（按会话编码）；串口由后端按串口配置解码，走原字节流。 */
  function writeTerminalOutput(bytes: Uint8Array) {
    const zmodem = zmodemRef.current;
    if (zmodem) {
      zmodem.consume(bytes);
      return;
    }
    writeTerminalText(bytes);
  }

  /** 去掉 ANSI 控制序列：仅用于过滤匹配判断，显示内容保持原样。 */
  function stripAnsiForFilter(line: string): string {
    return line
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[@-_]/g, "");
  }

  /** 过滤命中判断：与着色共用已编译规则；规则全关时视为无命中。 */
  function filterLineMatches(line: string): boolean {
    if (!line.trim()) return false;
    return findKeywordSpans(stripAnsiForFilter(line), filterRulesRef.current).length > 0;
  }

  /**
   * 过滤模式下的显示写入：按 \n 切行，仅写出命中行，不命中的整行丢弃。
   * 只影响终端显示；会话日志 / asciicast 录制在后端完成，不在本链路。
   */
  function writeFilteredText(text: string) {
    const term = controllerRef.current?.term;
    if (!term) return;
    if (!onlyMatchingLinesRef.current || filterBypassRef.current) {
      term.write(text);
      return;
    }
    const combined = filterPendingRef.current + text;
    const lines = combined.split("\n");
    filterPendingRef.current = lines.pop() ?? "";
    let out = "";
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (filterLineMatches(line)) out += `${line}\r\n`;
    }
    if (out) term.write(out);
  }

  /** 串口字节流 → 文本后再过滤；关闭过滤时保持原字节直写。 */
  function writeSerialText(bytes: Uint8Array) {
    const term = controllerRef.current?.term;
    if (!term) return;
    if (!onlyMatchingLinesRef.current) {
      term.write(bytes);
      return;
    }
    if (!serialFilterDecoderRef.current) serialFilterDecoderRef.current = new TextDecoder();
    const text = serialFilterDecoderRef.current.decode(bytes, { stream: true });
    if (text) writeFilteredText(text);
  }

  /** 打开过滤：清屏后只回填当前缓冲区中命中的行；关闭时的历史不回流。 */
  function rebuildFilteredView() {
    const term = controllerRef.current?.term;
    if (!term) return;
    const buf = term.buffer.active;
    const matched: string[] = [];
    for (let y = 0; y < buf.length; y += 1) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true).replace(/\s+$/, "");
      if (filterLineMatches(text)) matched.push(text);
    }
    filterPendingRef.current = "";
    filterBypassRef.current = true;
    try {
      term.write("\x1b[3J\x1b[2J\x1b[H");
      for (const line of matched) term.write(`${line}\r\n`);
    } finally {
      filterBypassRef.current = false;
    }
  }

  /** 关闭过滤：把尚未成行的半截输出照常写出，之后的输出全量显示。 */
  function flushFilterPending() {
    const term = controllerRef.current?.term;
    if (!term) return;
    const pending = filterPendingRef.current;
    filterPendingRef.current = "";
    if (pending) term.write(pending);
  }

  function toggleOnlyMatchingLines() {
    const next = !onlyMatchingLinesRef.current;
    onlyMatchingLinesRef.current = next;
    setOnlyMatchingLines(next);
    if (next) rebuildFilteredView();
    else flushFilterPending();
  }

  /** 关键字高亮总开关：关闭时同步关掉行过滤，避免留下过滤后的残视图。 */
  function setHighlightMasterEnabled(next: boolean) {
    if (!next && onlyMatchingLinesRef.current) {
      onlyMatchingLinesRef.current = false;
      setOnlyMatchingLines(false);
      flushFilterPending();
    }
    persistHostKeywordHighlight({ enabled: next });
  }

  /** 直通字节 → 终端（ZMODEM 非协议输出、串口原始字节共用）。 */
  function writeTerminalText(bytes: Uint8Array) {
    const term = controllerRef.current?.term;
    if (!term) return;
    if (transportRef.current?.kind === "serial") {
      writeSerialText(bytes);
      return;
    }
    const text = decoderRef.current.decode(bytes);
    if (text) {
      writeFilteredText(text);
      scheduleOutputTriggerCheck();
    }
  }

  /** ZMODEM 完成 / 失败提示：完成显示 4 秒，错误保留到下次传输。 */
  function handleZmodemEvent(event: ZmodemEvent) {
    setZmodemState(event);
    if (event.phase === "complete") {
      const what = event.direction === "download" ? "下载" : "上传";
      onStatus(
        `ZMODEM ${what}完成：${event.filename ?? ""}${
          event.savedPath ? ` → ${event.savedPath}` : ""
        }`,
      );
      window.setTimeout(() => {
        setZmodemState((prev) => (prev === event ? null : prev));
      }, 4000);
    } else if (event.phase === "error") {
      onStatus(`ZMODEM 失败：${event.message ?? "未知错误"}`);
    }
  }

  /** 下载落盘：固定写到本机 `~/Downloads`（与 Netcatty 的目录选择框不同）。 */
  async function saveZmodemDownload(
    filename: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const home = await api.localHome();
    const dir = `${home}/Downloads`;
    try {
      await api.localStat(dir, true);
    } catch {
      await api.localMkdir(dir);
    }
    const safe = (filename || "download.bin").replace(/[\\/]+/g, "_");
    const withIndex = (name: string, n: number) => {
      const dot = name.lastIndexOf(".");
      if (dot <= 0) return `${name} (${n})`;
      return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
    };
    let target = `${dir}/${safe}`;
    for (let n = 1; n < 1000; n++) {
      try {
        await api.localStat(target, true);
      } catch {
        break;
      }
      target = `${dir}/${withIndex(safe, n)}`;
    }
    await api.localWriteFile(target, bytes);
    return target;
  }

  /** 文件拖入终端：记录待传文件并启动远端 `rz`，检测到 ZRINIT 后自动发送。 */
  function handleZmodemDrop(files: File[]) {
    if (!isSsh || status !== "connected" || !zmodemRef.current) {
      onStatus("ZMODEM 拖拽上传仅支持已连接的 SSH 会话");
      return;
    }
    if (files.length === 0) return;
    zmodemRef.current.startUpload(files);
    transportRef.current?.write("rz -y\r");
    if (zmodemUploadTimerRef.current !== null) {
      window.clearTimeout(zmodemUploadTimerRef.current);
    }
    zmodemUploadTimerRef.current = window.setTimeout(() => {
      zmodemUploadTimerRef.current = null;
      if (zmodemRef.current?.active()) return;
      handleZmodemEvent({
        phase: "error",
        direction: "upload",
        message: "远端未响应 ZRINIT（请确认已安装 lrzsz 的 rz）",
      });
    }, 10000);
  }

  /**
   * 插入片段 / 运行脚本：仅当前窗格会话，禁止跨会话发送；未连接时不动作。
   * 多行方式对齐 Netcatty：paste 整段 + 末尾单回车；lineDelay 逐行 250ms。
   * 脚本（kind=script）走同一链路——把脚本文本发送到活动 shell，输出在本终端回显。
   * （Netcatty 的 nct.* JS 运行时未移植，见 todo/changelogs 留档。）
   */
  const insertSnippet = (s: api.Snippet): boolean => {
    if (status !== "connected") return false;
    clearPendingWrites();
    const plan = snippetWritePlan(s.command, s.no_auto_run, s.multi_line_run_mode);
    if (plan.delayMs <= 0 || plan.chunks.length === 1) {
      writeToPane(plan.chunks[0] ?? "");
      return true;
    }
    plan.chunks.forEach((chunk, i) => {
      if (i === 0) {
        writeToPane(chunk);
        return;
      }
      pendingWritesRef.current.push(
        window.setTimeout(() => {
          // 会话已断开时不再续写（transport 为空即丢弃）。
          if (aliveRef.current) writeToPane(chunk);
        }, plan.delayMs * i),
      );
    });
    return true;
  };
  // 句柄在注册时是稳定闭包，需通过 ref 拿到最新的连接状态与发送链路。
  runSnippetRef.current = insertSnippet;

  /** 快捷键片段变量：填值后替换占位符，再按 send / insert 语义执行。 */
  const submitSnippetVarPrompt = () => {
    const pending = snippetVarPrompt;
    if (!pending) return;
    setSnippetVarPrompt(null);
    const command = previewSnippetCommand(pending.snippet.command, pending.values);
    if (pending.mode === "insert") {
      appendComposeCommand(command);
      return;
    }
    insertSnippet({ ...pending.snippet, command });
  };

  /** 输入缓冲：命令历史与脚本录制共用；开始录制时清空步数。 */
  const inputBufferRef = useRef<ScriptRecordingBuffer>(createScriptRecordingBuffer());

  /**
   * 工具栏「会话日志」（file-text）：未录制时按「设置 → 终端 → 会话日志」
   * 的目录与命名模板新建 `.log`（不弹保存对话框）；录制中点击则停止。
   * 四类会话都能手动开始 / 停止，与主机「自动记录」开关无关。
   * 与「开始录制」（脚本录制）完全独立，不共享录制槽。
   */
  async function toggleManualSessionLog() {
    const sid = sidRef.current;
    if (logBusy || !sid) return;
    setLogBusy(true);
    try {
      // 每次点击都查后端真实状态，避免自动录制 / 其它入口造成的状态过期。
      const current = await api.manualSessionLogStatus(sid);
      if (current) {
        const stopped = await api.stopManualSessionLog(sid);
        setSessionLog(null);
        onStatus(`会话日志已保存：${stopped.path}`);
        return;
      }
      // 命名占位符的 host / title 取当前窗格可见信息；本地终端无远端主机时
      // 回退到标签标题，保证生成的文件名仍可读。
      const rec = await api.startDefaultSessionLog(
        sid,
        hostInfo.hostname || tab.title,
        tab.title,
        transportKind,
      );
      setSessionLog(rec);
      onStatus(`开始记录会话日志：${rec.path}`);
    } catch (e) {
      // 与终端其它错误一致：走用户可见文案（error code → 中文）。
      onStatus(userVisibleError(String(e)));
    } finally {
      setLogBusy(false);
    }
  }

  /**
   * 「开始录制」（Netcatty `recording`）：脚本录制，记录用户输入的命令。
   * 全局互斥：其它会话在录时提示「已有其他终端正在录制」；停止后把命令序列
   * 保存成脚本片段（termX 没有 nct.* JS 运行时，产物是 shell 命令序列）。
   */
  async function toggleScriptRecording() {
    const sid = sidRef.current;
    if (scriptRecBusy || !sid || status !== "connected") return;
    setScriptRecBusy(true);
    try {
      if (scriptRec) {
        const steps = [...inputBufferRef.current.steps];
        endScriptRecording(sid);
        scriptRecSidRef.current = null;
        setScriptRec(false);
        if (steps.length === 0) {
          onStatus("没有录到任何命令，本次录制已丢弃");
          return;
        }
        const name = `录制 ${clockLabel(new Date())}`;
        const snippet: api.Snippet = {
          id: `rec-${Date.now().toString(36)}`,
          name,
          command: buildScriptCommand(steps),
          description: "由终端输入录制生成",
          package: "",
          tags: [],
          shortkey: "",
          no_auto_run: false,
          kind: "script",
          multi_line_run_mode: steps.length > 1 ? "lineDelay" : "paste",
          // 录制生成的是发往 shell 的脚本；触发方式为手动。
          language: "shell",
          trigger: "",
          trigger_pattern: "",
        };
        const next = [...snippets, snippet];
        await api.saveSnippets(next);
        setSnippets(next);
        onStatus(`脚本录制已停止，已保存到「脚本」：${name}`);
        return;
      }
      if (!beginScriptRecording(sid)) {
        onStatus("已有其他终端正在录制");
        return;
      }
      scriptRecSidRef.current = sid;
      inputBufferRef.current = createScriptRecordingBuffer(Date.now());
      setScriptRec(true);
      onStatus("开始录制脚本：在终端里执行的命令会被记录");
    } catch (e) {
      endScriptRecording(sid);
      scriptRecSidRef.current = null;
      setScriptRec(false);
      onStatus(userVisibleError(String(e)));
    } finally {
      setScriptRecBusy(false);
    }
  }

  /**
   * 自动补全（对照 Netcatty `components/terminal/autocomplete/*`）。
   *
   * 与 Netcatty 一致：Tab 在候选可见时放行给 Shell（当前行已被实时预览改写）；
   * → 只接受内联 ghost text；Esc 恢复原行；点击候选同样进入实时预览。
   * 串口是网络设备 CLI，Ctrl-U 可能被当作会话终止，关闭预览改写与行替换；
   * Telnet 与 SSH 同（仍允许预览）。
   */
  const autocompleteLivePreviewAllowed =
    tab.connector.kind === "ssh" ||
    tab.connector.kind === "pty" ||
    tab.connector.kind === "telnet";
  /** 本地 Shell 在 Windows 下是 PowerShell / cmd，不认 Ctrl-U，用退格清行。 */
  const autocompleteUseBackspaceClear = tab.connector.kind === "pty";

  function resetAutocomplete() {
    const ac = autocompleteRef.current;
    if (ac.timer !== null) {
      window.clearTimeout(ac.timer);
      ac.timer = null;
    }
    ac.queryVersion += 1;
    ac.typed = "";
    ac.reliable = true;
    ac.unknownLine = false;
    ac.suggestions = [];
    ac.selected = -1;
    ac.previewedCommand = null;
    ac.subPanels = [];
    ac.subFocus = -1;
    ac.subVersion += 1;
    setAutocompleteUi(null);
  }

  /** 关闭浮层但保留已输入前缀：Esc / 接受后继续输入仍按原行补全。 */
  function dismissAutocomplete(options: { restorePreview?: boolean } = {}) {
    const ac = autocompleteRef.current;
    if (options.restorePreview) restoreAutocompletePreview();
    ac.queryVersion += 1;
    ac.suggestions = [];
    ac.selected = -1;
    ac.previewedCommand = null;
    ac.subPanels = [];
    ac.subFocus = -1;
    ac.subVersion += 1;
    publishAutocomplete();
  }

  function computeAutocompleteAnchor(): AutocompleteAnchor | null {
    const pane = paneRef.current;
    const term = controllerRef.current?.term;
    const screen = pane?.querySelector<HTMLElement>(".xterm-screen");
    const rows = pane?.querySelector<HTMLElement>(".xterm-rows");
    if (!pane || !term || !screen || !rows) return null;
    const paneBox = pane.getBoundingClientRect();
    const screenBox = screen.getBoundingClientRect();
    if (screenBox.width <= 0 || screenBox.height <= 0) return null;
    const cellW = screenBox.width / Math.max(1, term.cols);
    const cellH = screenBox.height / Math.max(1, term.rows);
    const styles = window.getComputedStyle(rows);
    const buf = term.buffer.active;
    return {
      left: screenBox.left - paneBox.left + buf.cursorX * cellW,
      top: screenBox.top - paneBox.top + buf.cursorY * cellH,
      cellW,
      cellH,
      paneWidth: paneBox.width,
      paneHeight: paneBox.height,
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
    };
  }

  /** 把当前 ref 状态同步到浮层；alternate screen（vim / top 等）一律隐藏。 */
  function publishAutocomplete() {
    const ac = autocompleteRef.current;
    const term = controllerRef.current?.term;
    if (!term || term.buffer.active.type === "alternate") {
      setAutocompleteUi(null);
      return;
    }
    const anchor = computeAutocompleteAnchor();
    if (!anchor) {
      setAutocompleteUi(null);
      return;
    }
    const settings = getSettings().terminal;
    const popup = settings.autocompletePopupMenu && ac.suggestions.length > 0;
    const ghost =
      settings.autocompleteGhostText && ac.selected < 0 && ac.subFocus < 0
        ? computeAutocompleteGhost(ac.typed, ac.suggestions)
        : "";
    if (!popup && !ghost) {
      setAutocompleteUi(null);
      return;
    }
    setAutocompleteUi({
      popup,
      suggestions: ac.suggestions,
      selected: ac.selected,
      ghost,
      anchor,
      subPanels: ac.subPanels,
      subFocus: ac.subFocus,
    });
  }

  /** 当前行是否是密码 / 口令输入，避免把敏感内容喂给历史候选。 */
  function isSensitivePromptLine(term: TerminalController["term"]): boolean {
    const buf = term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
    return /password|passwd|密码|口令/i.test(line.slice(0, buf.cursorX + 1));
  }

  /**
   * 读取当前行光标左侧的文本，并去掉 shell 提示符前缀。
   * 方向键 / Shell 原生补全等改动无法靠按键流追踪，Enter 提交前用它校准历史。
   */
  function readCurrentCommandLine(): string | null {
    const term = controllerRef.current?.term;
    if (!term) return null;
    const buf = term.buffer.active;
    if (buf.type === "alternate") return null;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    if (!line) return null;
    const text = line.translateToString(true).slice(0, buf.cursorX);
    // 去掉提示符（"...$ " / "...# " / "PS C:\> " / zsh "❯ "）后再比对。
    const stripped = text.replace(/^.*?[#$>❯]\s/u, "");
    return stripped;
  }

  /**
   * 光标所在逻辑行的完整文本（把软换行续行拼回去）：多行粘贴时末行若超宽，
   * 只看当前可视行会丢内容。
   */
  function readCurrentLogicalLine(): string | null {
    const term = controllerRef.current?.term;
    if (!term) return null;
    const buf = term.buffer.active;
    if (buf.type === "alternate") return null;
    const cursorRow = buf.baseY + buf.cursorY;
    const current = buf.getLine(cursorRow);
    if (!current) return null;
    let text = current.translateToString(true).slice(0, buf.cursorX);
    let row = cursorRow;
    while (row > 0 && buf.getLine(row)?.isWrapped) {
      row -= 1;
      const upper = buf.getLine(row);
      if (!upper) break;
      text = upper.translateToString(true) + text;
    }
    return text.replace(/^.*?[#$>❯]\s/u, "");
  }

  /** 本地 Shell 的路径分隔符：Windows（PowerShell / cmd）用 `\`，其余用 `/`。 */
  const autocompleteWindowsPaths =
    tab.connector.kind === "pty" && /Windows/i.test(navigator.userAgent);

  /** 路径补全的 provider 标识：SSH = 当前会话，本地 = fs；串口 / Telnet 不提供。 */
  function autocompletePathProviderId(): string | null {
    if (tab.connector.kind === "ssh") {
      return sidRef.current ? `ssh:${sidRef.current}` : null;
    }
    if (tab.connector.kind === "pty") return "local";
    return null;
  }

  /** 复用当前 SSH 会话的 SFTP 子系统（不新开连接），失败后丢弃句柄以便下次重试。 */
  function ensureAutocompleteSftp(): Promise<string> {
    const sessionId = sidRef.current;
    if (!sessionId) return Promise.reject(new Error("no session"));
    const existing = autocompleteSftpRef.current;
    if (existing && existing.sessionId === sessionId) return existing.promise;
    // 会话切换（重连后 sid 变化）：先释放旧 SFTP 子句柄，避免泄漏。
    if (existing) {
      autocompleteSftpRef.current = null;
      void existing.promise.then((old) => api.sftpClose(old)).catch(() => {});
    }
    const promise = api.sftpConnectSession(sessionId);
    autocompleteSftpRef.current = { sessionId, promise };
    promise.catch(() => {
      if (autocompleteSftpRef.current?.promise === promise) {
        autocompleteSftpRef.current = null;
      }
    });
    return promise;
  }

  /** `~` 展开为 home；其它路径原样返回（空路径落到 home）。 */
  async function expandAutocompleteHome(dir: string): Promise<string> {
    const raw = dir || "~";
    if (!raw.startsWith("~")) return raw === "." ? "~" : raw;
    const rest = raw.slice(1).replace(/^[\\/]+/, "");
    const providerId = autocompletePathProviderId() ?? "local";
    let cached = autocompleteHomeRef.current;
    if (!cached || cached.providerId !== providerId) {
      const promise =
        tab.connector.kind === "ssh"
          ? ensureAutocompleteSftp().then((sftpId) => api.sftpHome(sftpId))
          : api.localHome();
      cached = { providerId, promise };
      autocompleteHomeRef.current = cached;
      const entry = cached;
      promise.catch(() => {
        if (autocompleteHomeRef.current === entry) autocompleteHomeRef.current = null;
      });
    }
    const home = await cached.promise;
    if (!rest) return home;
    const separator = home.includes("\\") && !home.startsWith("/") ? "\\" : "/";
    return `${home.replace(/[\\/]+$/, "")}${separator}${rest.replace(/[\\/]/g, separator)}`;
  }

  /** 单次目录列举：SSH 走 `sftp_list`，本地走 fs；失败由缓存层静默降级为空结果。 */
  async function loadAutocompletePathEntries(dir: string): Promise<PathEntry[]> {
    const expanded = await expandAutocompleteHome(dir);
    if (tab.connector.kind === "ssh") {
      const rows = await api.sftpList(await ensureAutocompleteSftp(), expanded);
      return rows
        .filter((row) => row.name !== "." && row.name !== "..")
        .map((row) => ({
          name: row.name,
          type: row.is_symlink ? "symlink" : row.is_dir ? "directory" : "file",
        }));
    }
    const rows = await api.localListDir(expanded);
    return rows
      .filter((row) => row.name !== "." && row.name !== "..")
      .map((row) => ({ name: row.name, type: row.kind }));
  }

  function autocompletePathEntries(providerId: string, dir: string): Promise<PathEntry[]> {
    return autocompletePathCacheRef.current.get(`${providerId}:${dir}`, () =>
      loadAutocompletePathEntries(dir),
    );
  }

  function scheduleAutocompleteSuggestions() {
    const ac = autocompleteRef.current;
    if (ac.timer !== null) window.clearTimeout(ac.timer);
    ac.timer = null;
    const term = controllerRef.current?.term;
    if (
      !term ||
      term.buffer.active.type === "alternate" ||
      ac.unknownLine ||
      !ac.reliable ||
      !ac.typed.trim() ||
      isSensitivePromptLine(term)
    ) {
      ac.suggestions = [];
      ac.selected = -1;
      ac.subPanels = [];
      ac.subFocus = -1;
      publishAutocomplete();
      return;
    }
    ac.timer = window.setTimeout(() => {
      ac.timer = null;
      void runAutocompleteQuery();
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  }

  /**
   * 命令候选立即出、路径候选异步补：目录列举有 150ms 软预算，
   * 到点先用已有结果，迟到结果再回填（同一请求共用 in-flight / 5s 缓存）。
   */
  async function runAutocompleteQuery() {
    const ac = autocompleteRef.current;
    const settings = getSettings().terminal;
    if (!settings.autocompleteEnabled) return;
    const typed = ac.typed;
    const queryVersion = ++ac.queryVersion;
    if (!typed.trim()) return;

    const providerId = autocompletePathProviderId();
    const pathCheck = providerId
      ? shouldCompletePath(typed, autocompleteWindowsPaths)
      : { complete: false, foldersOnly: false };
    const historyScope = settings.autocompleteHistoryScope === "global" ? "global" : "host";
    const history = readCommandHistory();
    // 路径补全生效时，整行历史让位给当前目录（历史只保留同命令 + 实参前缀的最近 5 条）。
    const base = pathCheck.complete
      ? derivePathArgumentHistory({ typed, history, scope: historyScope, hostId: historyHostId })
      : deriveAutocompleteSuggestions({
          typed,
          history,
          scope: historyScope,
          hostId: historyHostId,
        });
    ac.suggestions = base;
    ac.selected = -1;
    ac.subPanels = [];
    ac.subFocus = -1;
    ac.subVersion += 1;
    publishAutocomplete();

    if (!pathCheck.complete || !providerId) return;

    // 本地 Shell 不报 OSC 7，cwd 为空时用 home 兜底：cmd / PowerShell 不展开 `~`，
    // 直接用 `~` 拼出的候选执行会失败。SSH 远端 shell 会展开 `~`，不必兜底。
    let cwd = cwdRef.current;
    if (!cwd && providerId === "local") {
      cwd = await expandAutocompleteHome("~").catch(() => null);
    }
    const lookup = resolvePathLookup({
      currentWord: currentWordOf(typed, autocompleteWindowsPaths),
      cwd,
      windows: autocompleteWindowsPaths,
    });
    const isCurrent = () =>
      ac.typed === typed && ac.timer === null && ac.queryVersion === queryVersion;
    const listing = autocompletePathEntries(providerId, lookup.dirToList).then((entries) =>
      filterPathEntries(sortPathEntries(entries), lookup.filterPrefix),
    );

    const entries = await withPathBudget(listing, PATH_COMPLETION_BUDGET_MS, (late) => {
      // 用户已经选中/预览或进入下钻后，迟到结果不得覆盖当前状态。
      if (!isCurrent() || ac.subFocus >= 0 || ac.selected >= 0 || ac.previewedCommand !== null) {
        return;
      }
      const lateSuggestions = buildPathSuggestions({
        line: typed,
        lookup,
        entries: late,
        foldersOnly: pathCheck.foldersOnly,
      });
      if (!lateSuggestions.length) return;
      ac.suggestions = mergeAutocompleteSuggestions(ac.suggestions, lateSuggestions);
      ac.selected = -1;
      publishAutocomplete();
    });

    if (!isCurrent()) return;
    if (ac.selected >= 0 || ac.previewedCommand !== null) return;
    const pathSuggestions = buildPathSuggestions({
      line: typed,
      lookup,
      entries,
      foldersOnly: pathCheck.foldersOnly,
    });
    if (!pathSuggestions.length) return;
    ac.suggestions = mergeAutocompleteSuggestions(base, pathSuggestions);
    publishAutocomplete();
  }

  /** 实时预览：把当前行改写成候选（只对 SSH / 本地 Shell 生效）。 */
  function previewAutocompleteCandidate(candidate: string) {
    const ac = autocompleteRef.current;
    if (!autocompleteLivePreviewAllowed) return;
    const currentLine = ac.previewedCommand ?? ac.typed;
    const write = computeLivePreviewWrite({
      currentLine,
      candidate,
      useBackspaceClear: autocompleteUseBackspaceClear,
    });
    if (write) transportRef.current?.write(write);
    ac.previewedCommand = candidate;
  }

  /** 取消预览：把行恢复成用户原始输入。 */
  function restoreAutocompletePreview() {
    const ac = autocompleteRef.current;
    if (ac.previewedCommand === null) return;
    const currentLine = ac.previewedCommand;
    const candidate = ac.typed;
    ac.previewedCommand = null;
    if (!autocompleteLivePreviewAllowed) return;
    const write = computeLivePreviewWrite({
      currentLine,
      candidate,
      useBackspaceClear: autocompleteUseBackspaceClear,
    });
    if (write) transportRef.current?.write(write);
  }

  function selectAutocompleteIndex(index: number) {
    const ac = autocompleteRef.current;
    if (index < 0 || index >= ac.suggestions.length) return;
    ac.selected = index;
    ac.subPanels = [];
    ac.subFocus = -1;
    ac.subVersion += 1;
    previewAutocompleteCandidate(ac.suggestions[index].command);
    publishAutocomplete();
    void loadAutocompleteSubPanel(ac.suggestions[index], index);
    controllerRef.current?.term.focus();
  }

  /** 选中目录候选后预列其子目录（子面板每级 240 宽，逐级下钻）。 */
  async function loadAutocompleteSubPanel(
    suggestion: AutocompleteSuggestion,
    index: number,
  ) {
    const ac = autocompleteRef.current;
    if (suggestion.source !== "path" || suggestion.fileType !== "directory" || !suggestion.pathDir) {
      return;
    }
    const providerId = autocompletePathProviderId();
    if (!providerId) return;
    const version = ++ac.subVersion;
    const entries = await autocompletePathEntries(providerId, suggestion.pathDir).then(sortPathEntries);
    if (version !== ac.subVersion || ac.selected !== index) return;
    if (!entries.length) return;
    ac.subPanels = [{ dirPath: suggestion.pathDir, entries, selected: -1 }];
    ac.subFocus = -1;
    publishAutocomplete();
  }

  /** 子面板当前选中的条目。 */
  function autocompleteSubEntry(level: number): PathEntry | null {
    const panel = autocompleteRef.current.subPanels[level];
    if (!panel || panel.selected < 0) return null;
    return panel.entries[panel.selected] ?? null;
  }

  /** 子面板条目的完整命令行（把当前词替换成绝对路径）。 */
  function buildAutocompleteSubCommand(level: number): string | null {
    const ac = autocompleteRef.current;
    const panel = ac.subPanels[level];
    const entry = autocompleteSubEntry(level);
    if (!panel || !entry) return null;
    const suffix = entry.type === "directory" ? (autocompleteWindowsPaths ? "\\" : "/") : "";
    return replaceCommandWord(
      ac.typed,
      `${panel.dirPath}${entry.name}${suffix}`,
      autocompleteWindowsPaths,
    );
  }

  /** 接受子面板条目：写回输入行并关闭浮层（不直接执行，与 Netcatty 一致）。 */
  function acceptAutocompleteSubEntry(level: number): boolean {
    const ac = autocompleteRef.current;
    const command = buildAutocompleteSubCommand(level);
    if (!command) return false;
    if (ac.previewedCommand === null) {
      const tail = computeAutocompleteAcceptTail(ac.typed, command);
      if (tail) transportRef.current?.write(tail);
    }
    ac.typed = command;
    ac.reliable = true;
    inputBufferRef.current.line = command;
    dismissAutocomplete();
    return true;
  }

  /** 子面板内 ↑/↓：列表两端夹取，不回环。 */
  function moveAutocompleteSubSelection(delta: 1 | -1) {
    const ac = autocompleteRef.current;
    const level = ac.subFocus;
    const panel = ac.subPanels[level];
    if (!panel || !panel.entries.length) return;
    const base = panel.selected < 0 ? (delta === 1 ? 0 : panel.entries.length - 1) : panel.selected;
    const next = Math.max(0, Math.min(panel.entries.length - 1, base + (panel.selected < 0 ? 0 : delta)));
    ac.subVersion += 1;
    ac.subPanels = ac.subPanels.slice(0, level + 1);
    panel.selected = next;
    const command = buildAutocompleteSubCommand(level);
    if (command) previewAutocompleteCandidate(command);
    publishAutocomplete();
  }

  /** 点击子面板条目：选中并实时预览（普通 shell 会直接改写当前行）。 */
  function selectAutocompleteSubIndex(level: number, index: number) {
    const ac = autocompleteRef.current;
    const panel = ac.subPanels[level];
    if (!panel || index < 0 || index >= panel.entries.length) return;
    ac.subVersion += 1;
    ac.subFocus = level;
    ac.subPanels = ac.subPanels.slice(0, level + 1);
    panel.selected = index;
    const command = buildAutocompleteSubCommand(level);
    if (command) previewAutocompleteCandidate(command);
    publishAutocomplete();
    controllerRef.current?.term.focus();
  }

  /** 子面板内 →：目录项展开下一级（尾部 240 面板），文件项直接接受。 */
  async function expandAutocompleteSubPanel(level: number): Promise<boolean> {
    const ac = autocompleteRef.current;
    const entry = autocompleteSubEntry(level);
    const panel = ac.subPanels[level];
    if (!entry || !panel) return false;
    if (entry.type !== "directory") return acceptAutocompleteSubEntry(level);

    const providerId = autocompletePathProviderId();
    if (!providerId) return false;
    const dirPath = joinDirectoryPath(
      panel.dirPath,
      entry.name,
      autocompleteWindowsPaths ? "\\" : "/",
    );
    const version = ++ac.subVersion;
    const entries = await autocompletePathEntries(providerId, dirPath).then(sortPathEntries);
    if (version !== ac.subVersion) return true;
    if (!entries.length) return true;
    ac.subPanels = [
      ...ac.subPanels.slice(0, level + 1),
      { dirPath, entries, selected: -1 },
    ];
    ac.subFocus = level + 1;
    publishAutocomplete();
    return true;
  }

  /**
   * xterm onData 的补全拦截。返回 true 表示这次按键已被补全消费，
   * 不要再把原始字节写给终端；false 表示照常透传。
   */
  function handleAutocompleteInput(data: string): boolean {
    const settings = getSettings().terminal;
    const ac = autocompleteRef.current;
    if (!settings.autocompleteEnabled) {
      if (ac.timer !== null || ac.suggestions.length > 0) resetAutocomplete();
      return false;
    }
    const transport = transportRef.current;
    if (status !== "connected" || !transport) return false;

    const kind = classifyAutocompleteData(data);
    const popupOpen = settings.autocompletePopupMenu && ac.suggestions.length > 0;
    const ghostVisible =
      settings.autocompleteGhostText &&
      ac.selected < 0 &&
      computeAutocompleteGhost(ac.typed, ac.suggestions) !== "";

    if (kind === "other") {
      if (ac.previewedCommand !== null) restoreAutocompletePreview();
      ac.reliable = false;
      ac.unknownLine = true;
      ac.typed = "";
      ac.suggestions = [];
      ac.selected = -1;
      ac.subPanels = [];
      ac.subFocus = -1;
      ac.subVersion += 1;
      publishAutocomplete();
      return false;
    }

    // 子面板（逐级下钻目录）：↑/↓ 在面板内移动，→ 展开 / 接受文件，← 退一层，
    // Enter/Tab 接受当前项，Esc 关闭并回滚到原始输入。
    if (ac.subFocus >= 0 && ac.subPanels.length > 0) {
      if (kind === "up" || kind === "down") {
        moveAutocompleteSubSelection(kind === "down" ? 1 : -1);
        return true;
      }
      if (kind === "right") {
        void expandAutocompleteSubPanel(ac.subFocus);
        return true;
      }
      if (kind === "left") {
        ac.subVersion += 1;
        const level = ac.subFocus - 1;
        ac.subFocus = level;
        // 退回主列表时保留已列好的子面板，再按 → 可直接回到原层级。
        if (level >= 0) ac.subPanels = ac.subPanels.slice(0, level + 1);
        const command = level >= 0 ? buildAutocompleteSubCommand(level) : ac.suggestions[ac.selected]?.command;
        if (command) previewAutocompleteCandidate(command);
        else restoreAutocompletePreview();
        publishAutocomplete();
        return true;
      }
      if (kind === "enter" || kind === "tab") {
        if (autocompleteSubEntry(ac.subFocus)) return acceptAutocompleteSubEntry(ac.subFocus);
        // 面板里还没选中条目：按通用语义提交 / 放行，并关闭浮层。
        dismissAutocomplete();
        return false;
      }
      if (kind === "escape") {
        dismissAutocomplete({ restorePreview: true });
        return true;
      }
      // 继续输入 / 删除：退出子面板，走普通候选刷新。
      ac.subVersion += 1;
      ac.subPanels = [];
      ac.subFocus = -1;
    }

    // 主列表选中目录时 → 先聚焦子面板（再按 → 继续下钻）。
    if (
      kind === "right" &&
      popupOpen &&
      ac.selected >= 0 &&
      ac.suggestions[ac.selected]?.fileType === "directory" &&
      ac.subPanels.length > 0
    ) {
      ac.subFocus = 0;
      ac.subPanels[0].selected = 0;
      const command = buildAutocompleteSubCommand(0);
      if (command) previewAutocompleteCandidate(command);
      publishAutocomplete();
      return true;
    }

    const action = resolveAutocompleteKey({ kind, popupOpen, ghostVisible });

    if (action.kind === "navigate") {
      const next = moveAutocompleteSelection(ac.selected, ac.suggestions.length, action.delta);
      if (next === ac.selected) return true;
      ac.selected = next;
      ac.subPanels = [];
      ac.subFocus = -1;
      ac.subVersion += 1;
      if (next === -1) restoreAutocompletePreview();
      else {
        previewAutocompleteCandidate(ac.suggestions[next].command);
        void loadAutocompleteSubPanel(ac.suggestions[next], next);
      }
      publishAutocomplete();
      return true;
    }

    if (action.kind === "accept-ghost") {
      const tail = computeAutocompleteGhost(ac.typed, ac.suggestions);
      if (tail) {
        transport.write(tail);
        ac.typed += tail;
        // 预览 / 接受是直接写 PTY 的，同步脚本录制与命令历史用的行缓冲。
        inputBufferRef.current.line = ac.typed;
      }
      ac.suggestions = [];
      ac.selected = -1;
      publishAutocomplete();
      return true;
    }

    if (action.kind === "dismiss") {
      dismissAutocomplete({ restorePreview: action.restore });
      return true;
    }

    if (action.kind === "confirm") {
      // 实时预览已把候选写进行内，Enter 直接交给 Shell 执行；
      // 串口 / Telnet 没有预览，这里补写候选尾部。
      if (ac.selected >= 0 && ac.previewedCommand === null) {
        const candidate = ac.suggestions[ac.selected]?.command;
        const tail = candidate ? computeAutocompleteAcceptTail(ac.typed, candidate) : null;
        if (tail) {
          transport.write(tail);
          inputBufferRef.current.line = candidate!;
        }
      } else if (ac.previewedCommand !== null) {
        // 实时预览已把候选写进行内，按 Enter 执行的是候选而不是原始前缀。
        inputBufferRef.current.line = ac.previewedCommand;
      }
      syncSubmittedLineBeforeEnter();
      ac.previewedCommand = null;
      resetAutocomplete();
      return false;
    }

    if (action.kind === "release") {
      // Tab：保留行内已预览的候选，让 Shell 的原生补全 / 执行接管。
      if (ac.selected >= 0) {
        ac.typed = ac.suggestions[ac.selected].command;
        inputBufferRef.current.line = ac.typed;
      }
      ac.previewedCommand = null;
      ac.reliable = false;
      ac.suggestions = [];
      ac.selected = -1;
      publishAutocomplete();
      return false;
    }

    if (kind === "enter") {
      syncSubmittedLineBeforeEnter();
      resetAutocomplete();
      return false;
    }

    if (kind === "interrupt" || kind === "line-erase") {
      resetAutocomplete();
      return false;
    }

    if (kind === "word-erase") {
      if (ac.previewedCommand !== null) restoreAutocompletePreview();
      ac.typed = "";
      ac.reliable = false;
      ac.unknownLine = true;
      ac.suggestions = [];
      ac.selected = -1;
      publishAutocomplete();
      return false;
    }

    if (kind === "escape") {
      resetAutocomplete();
      return false;
    }

    if (kind === "backspace" || kind === "print") {
      if (ac.previewedCommand !== null) restoreAutocompletePreview();
      // 行内已有方向键 / Shell 补全等无法追踪的改动时，不再基于旧前缀给候选。
      if (ac.unknownLine) {
        ac.suggestions = [];
        ac.selected = -1;
        publishAutocomplete();
        return false;
      }
      if (kind === "backspace") {
        ac.typed = ac.typed.slice(0, -1);
      } else {
        ac.typed += data;
        ac.reliable = true;
      }
      ac.selected = -1;
      scheduleAutocompleteSuggestions();
      return false;
    }

    if (kind === "tab") {
      // 放行给 Shell 原生补全后，行内容不再等于 typed，本行停止给候选。
      ac.reliable = false;
      ac.unknownLine = true;
      ac.typed = "";
      ac.suggestions = [];
      ac.selected = -1;
      publishAutocomplete();
      return false;
    }

    // ↑/↓（Shell 历史）、←/→（移动光标）等：行内容不再等于 typed，停止补全。
    if (ac.previewedCommand !== null) restoreAutocompletePreview();
    ac.reliable = false;
    ac.unknownLine = true;
    ac.typed = "";
    ac.suggestions = [];
    ac.selected = -1;
    publishAutocomplete();
    return false;
  }

  /**
   * Enter 提交前用 buffer 校准待记录命令：方向键 / Tab 补全等改动不在按键流里，
   * 只靠 typed 会记错；密码 / 口令提示行直接跳过记录。
   */
  function syncSubmittedLineBeforeEnter() {
    const term = controllerRef.current?.term;
    if (!term) return;
    if (isSensitivePromptLine(term)) {
      inputBufferRef.current.line = "";
      return;
    }
    const line = readCurrentCommandLine();
    if (line === null) return;
    // bracketed paste 的多行内容：终端只显示最后一行，不能用单行覆盖整段，
    // 否则命令历史只会记下最后一行。
    const buffered = inputBufferRef.current.line;
    if (buffered.includes("\n")) {
      const parts = buffered.split("\n");
      const bufferedLast = parts[parts.length - 1] ?? "";
      // 末行可能因超宽被软换行，用逻辑行（跨续行拼接）校准。
      const candidate = readCurrentLogicalLine() ?? line;
      if (candidate.trim() === bufferedLast.trim()) return;
      parts[parts.length - 1] = candidate;
      inputBufferRef.current.line = parts.join("\n");
      return;
    }
    inputBufferRef.current.line = line;
  }

  /** 会话断开 / 未连接时不保留候选浮层（避免点击残留项写入已失效的传输）。 */
  useEffect(() => {
    if (status !== "connected") resetAutocomplete();
  }, [status]);

  /** 设置热更新：关闭补全立即隐藏；切换 ghost / 下拉时刷新现有浮层。 */
  useEffect(() => {
    return subscribeSettings(() => {
      const terminalSettings = getSettings().terminal;
      if (!terminalSettings.autocompleteEnabled) {
        resetAutocomplete();
        return;
      }
      const ac = autocompleteRef.current;
      if (ac.suggestions.length > 0 || ac.previewedCommand !== null) {
        publishAutocomplete();
      }
      // 来源范围 / 候选浮层等开关切换后重新取数，保证即时生效。
      if (ac.typed.trim()) scheduleAutocompleteSuggestions();
    });
  }, []);

  /** 终端输入：命令历史 + 脚本录制缓冲。 */
  function handleTerminalInput(data: string) {
    const submitted = appendKeystrokes(inputBufferRef.current, data, Date.now());
    if (submitted) {
      recordCommandHistory({
        command: submitted.command,
        hostId: historyHostId,
        hostLabel: tab.title,
        id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    }
    // 未录制时只保留最近 200 条，避免长时间使用会累积到内存。
    if (!scriptRec && inputBufferRef.current.steps.length > 200) {
      inputBufferRef.current.steps = inputBufferRef.current.steps.slice(-200);
    }
  }

  /**
   * 撰写栏发送（对照 Netcatty `executeSnippetCommand`）：换行归一为 LF，
   * 多行在 bracketed paste 模式下包裹后追加 `\r`；发送成功才记历史并清空草稿。
   */
  function sendCompose(text: string): boolean {
    if (status !== "connected" || !transportRef.current) return false;
    const bracketed = Boolean(controllerRef.current?.term.modes.bracketedPasteMode);
    const payload = buildComposePayload(text, bracketed);
    // 整段写入：绕过 SSH 输入兼容模式的逐字拆分，避免多字符命令乱序。
    (transportRef.current.writeBulk ?? writeToPane)(payload);
    setComposeHistory((prev) => appendComposeHistory(prev, text));
    recordCommandHistory({
      command: text,
      hostId: historyHostId,
      hostLabel: tab.title,
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return true;
  }

  /** 撰写草稿持久化（去抖 300ms）：临时终端 key 为 null，存取均为空操作。 */
  useEffect(() => {
    const timer = window.setTimeout(
      () => saveComposeDraft(composeDraftHostKey, composeText),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [composeDraftHostKey, composeText]);

  /** 追加命令到撰写栏草稿（片段插入 / 变量填值后插入共用）。 */
  function appendComposeCommand(command: string) {
    setComposeOpen(true);
    setComposeText((current) => insertSnippetIntoCompose(current, command).value);
  }

  /** 终端搜索（SearchAddon，对照 Netcatty SEARCH_OPTIONS / SEARCH_DECORATIONS）。 */
  function runSearch(direction: 1 | -1) {
    const search = controllerRef.current?.search;
    const query = searchQuery;
    if (!search || !query.trim()) {
      search?.clearDecorations();
      setSearchCount(0);
      setSearchIndex(0);
      return;
    }
    if (direction === 1) search.findNext(query, SEARCH_OPTIONS);
    else search.findPrevious(query, SEARCH_OPTIONS);
  }

  /** 搜索词变化即实时高亮全部匹配（Netcatty handleSearch 的 findNext 等价物）。 */
  useEffect(() => {
    const search = controllerRef.current?.search;
    if (!searchOpen) {
      search?.clearDecorations();
      setSearchCount(0);
      setSearchIndex(0);
      return;
    }
    if (!search || !searchQuery.trim()) {
      search?.clearDecorations();
      setSearchCount(0);
      setSearchIndex(0);
      return;
    }
    search.findNext(searchQuery, SEARCH_OPTIONS);
  }, [searchOpen, searchQuery]);

  /** 设置热更新：关键字高亮开关 / 规则改动后立即同步到已开窗格（无需重启）。 */
  useEffect(() => {
    return subscribeSettings(() => {
      const terminalSettings = getSettings().terminal;
      setHighlightEnabled(terminalSettings.keywordHighlightEnabled);
      setHighlightRules((prev) => {
        const next = cloneKeywordHighlightRules(terminalSettings.keywordHighlightRules);
        // 与高亮无关的设置变更也会触发订阅，这里按内容比对避免无谓重绘。
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    });
  }, []);

  /**
   * 工具栏浮层的目标规则集：仅 SSH 编辑主机级规则（主机级覆盖不回退）；
   * 本地终端 / 串口 / Telnet 没有主机级规则，直接编辑全局规则，
   * 着色仍走同一套 `effectiveHighlight`（与 SSH 完全一致）。
   */
  const highlightUiRules = sshProfileId ? hostHighlightRules : highlightRules;
  const highlightUiEnabled = sshProfileId ? hostHighlightEnabled : highlightEnabled;

  /**
   * 新增主机规则（对齐 Netcatty `addHostKeywordHighlightRule`）：
   * 名称 + 正则 + 颜色，正则先校验；新增后同时打开主机总开关。
   */
  function addHostHighlightRule() {
    const label = hostHighlightLabel.trim();
    const pattern = hostHighlightPattern.trim();
    if (!label || !pattern) return;
    try {
      new RegExp(pattern, "gi");
    } catch {
      setHostHighlightError("无效的正则表达式");
      return;
    }
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    persistHostKeywordHighlight({
      rules: [
        ...highlightUiRules,
        { id, label, patterns: [pattern], color: hostHighlightColor, enabled: true },
      ],
      enabled: true,
    });
    setHostHighlightLabel("");
    setHostHighlightPattern("");
    setHostHighlightError("");
  }

  /**
   * 主机级规则持久化（对齐 Netcatty HostKeywordHighlightPopover 的 onUpdateHost）：
   * 写回当前主机档案后，本终端按新规则立即重绘（本地 state 同步），
   * 无需重启、也无需重新连接；断开后仍由 status 门槛回落全局。
   */
  function persistHostKeywordHighlight(patch: {
    enabled?: boolean;
    rules?: KeywordHighlightRule[];
  }) {
    const profileId = sshProfileId;
    if (!profileId) {
      // 本地终端 / 串口 / Telnet：没有主机级规则，浮层直接改全局规则，
      // 与设置页共用同一份数据，改动即时同步到所有已开终端。
      const nextEnabled = patch.enabled ?? highlightEnabled;
      const nextRules = patch.rules ?? highlightRules;
      setHighlightEnabled(nextEnabled);
      setHighlightRules(nextRules);
      updateSettings({
        terminal: {
          ...getSettings().terminal,
          keywordHighlightEnabled: nextEnabled,
          keywordHighlightRules: nextRules,
        },
      });
      return;
    }
    const nextEnabled = patch.enabled ?? hostHighlightEnabled;
    const nextRules = patch.rules ?? hostHighlightRules;
    setHostHighlightEnabled(nextEnabled);
    setHostHighlightRules(nextRules);
    void api
      .getProfile(profileId)
      .then((p) =>
        api.updateProfile({
          ...p,
          keyword_highlight_enabled: nextEnabled,
          keyword_highlight_rules: nextRules.length > 0 ? nextRules : null,
        }),
      )
      .catch(() => {
        // 写库失败时回滚到档案里的真实值，避免 UI 与会话状态漂移。
        void api.getProfile(profileId).then((p) => {
          setHostHighlightEnabled(p.keyword_highlight_enabled === true);
          setHostHighlightRules(
            normalizeHostKeywordHighlightRules(p.keyword_highlight_rules ?? []),
          );
        });
      });
  }

  /**
   * 把已有规则填进编辑器草稿；列表条目的名称 / 正则区与色块都可点进来。
   */
  function beginEditHighlightRule(rule: KeywordHighlightRule) {
    setHostHighlightError("");
    setEditingRuleId(rule.id);
    setEditRuleLabel(rule.label);
    setEditRulePatterns(rule.patterns.join("\n"));
    setEditRuleColor(rule.color);
    setEditRuleEnabled(rule.enabled);
    setEditRuleError("");
  }

  function resetHighlightEditor() {
    setEditingRuleId(null);
    setEditRuleError("");
  }

  /**
   * 保存编辑：名称 / 逐行正则 / 颜色 / 启用状态一次性写回。
   * 写入走 persistHostKeywordHighlight，本终端随即重绘；下一次重载从档案重读。
   * 正则先整体校验，任一非法就不落库，避免把坏规则写进档案。
   */
  function saveEditedHighlightRule() {
    if (!editingRuleId) return;
    const label = editRuleLabel.trim();
    const patterns = editRulePatterns
      .split(/\r?\n/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    const error = validateKeywordRuleDraft(label, patterns);
    if (error) {
      setEditRuleError(error);
      return;
    }
    persistHostKeywordHighlight({
      rules: highlightUiRules.map((rule) =>
        rule.id === editingRuleId
          ? { ...rule, label, patterns, color: editRuleColor, enabled: editRuleEnabled }
          : rule,
      ),
    });
    setEditingRuleId(null);
    setEditRuleError("");
  }

  /**
   * 全局 + 主机规则合并（Netcatty 语义：主机追加、全局先匹配）；
   * 主机规则的开关随连接状态联动 —— 断开后回落全局。
   */
  const effectiveHighlight = useMemo(
    () =>
      mergeKeywordHighlightRules(
        highlightRules,
        highlightEnabled,
        hostHighlightRules,
        hostHighlightEnabled && status === "connected",
      ),
    [highlightRules, highlightEnabled, hostHighlightRules, hostHighlightEnabled, status],
  );

  /** 过滤模式与着色共用同一规则集；总开关关闭时视为无规则。 */
  useEffect(() => {
    filterRulesRef.current = effectiveHighlight.enabled
      ? compileKeywordRules(effectiveHighlight.rules)
      : [];
  }, [effectiveHighlight]);

  /** 关键字高亮：按设置里的规则给命中片段着色（xterm decoration foregroundColor）。 */
  useEffect(() => {
    const term = controllerRef.current?.term;
    if (!term) return;
    const compiled = effectiveHighlight.enabled
      ? compileKeywordRules(effectiveHighlight.rules)
      : [];
    if (compiled.length === 0) return;
    // registerMarker / registerDecoration 属于 proposed API。
    term.options.allowProposedApi = true;
    let disposed = false;
    let timer: number | null = null;
    let items: { decoration: { dispose: () => void }; marker: { dispose: () => void } }[] = [];
    const clear = () => {
      for (const item of items) {
        item.decoration.dispose();
        item.marker.dispose();
      }
      items = [];
    };
    // 只处理可视区：滚动/写入时重扫，避免长会话里给整个 scrollback 建 decoration。
    const paint = () => {
      clear();
      if (disposed) return;
      const buf = term.buffer.active;
      const cursorLine = buf.baseY + buf.cursorY;
      const top = buf.viewportY;
      const bottom = Math.min(top + term.rows, buf.length);
      for (let y = top; y < bottom; y += 1) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        const spans = findKeywordSpans(text, compiled);
        if (spans.length === 0) continue;
        const offsets = cellOffsets(line);
        for (const span of spans) {
          const startX = offsets[span.start];
          const endX = offsets[span.end - 1];
          if (startX === undefined || endX === undefined) continue;
          const marker = term.registerMarker(y - cursorLine);
          if (!marker) continue;
          const decoration = term.registerDecoration({
            marker,
            x: startX,
            width: endX - startX + 1,
            foregroundColor: span.color,
          });
          if (!decoration) {
            marker.dispose();
            continue;
          }
          items.push({ decoration, marker });
        }
      }
    };
    const schedule = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        paint();
      }, 80);
    };
    const subs = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onResize(schedule)];
    paint();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      for (const sub of subs) sub.dispose();
      clear();
    };
  }, [effectiveHighlight]);

  /** 脚本下拉菜单（终端工具栏「脚本」按钮）。 */
  const [scriptMenuOpen, setScriptMenuOpen] = useState(false);
  const scriptSnippets = snippets.filter(isScriptSnippet);

  /**
   * 终端工具栏浮层互斥（对齐 Netcatty Popover）：打开某个浮层前先收起其它浮层，
   * 点击浮层之外的任意位置（含其它工具栏按钮）全部关闭。
   */
  const closeAllToolbarPopovers = () => {
    setMoreOpen(false);
    setEncodingMenuOpen(false);
    setScriptMenuOpen(false);
    setHighlightOpen(false);
    setMonitorOpen(false);
  };
  const closeOtherToolbarPopovers = (
    keep: "more" | "scripts" | "highlight" | "monitor",
  ) => {
    if (keep !== "more") {
      setMoreOpen(false);
      setEncodingMenuOpen(false);
    }
    if (keep !== "scripts") setScriptMenuOpen(false);
    if (keep !== "highlight") setHighlightOpen(false);
    if (keep !== "monitor") setMonitorOpen(false);
  };
  useEffect(() => {
    if (!(moreOpen || scriptMenuOpen || highlightOpen || monitorOpen)) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".term-tool-more, .term-monitor-anchor")) return;
      closeAllToolbarPopovers();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen, scriptMenuOpen, highlightOpen, monitorOpen]);

  /** 右键菜单（位置相对窗格左上角）。 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    selection: string;
  } | null>(null);
  /** 右键长按弹菜单（Netcatty rightClickLongPressMenu）。 */
  const longPressOpenedRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);

  // ── 连接弹窗（认证重试）表单状态 ──────────────────────────
  const [hostInfo, setHostInfo] = useState<HostConnectionInfo>({
    label: tab.title,
    hostname: "",
    port: 22,
    protocol: "SSH",
  });
  /** 工具栏「复制主机地址」按钮的 tooltip（复制后短暂变为「已复制」）。 */
  const [copyHostTitle, setCopyHostTitle] = useState("复制主机地址");
  const [keys, setKeys] = useState<AuthKeyOption[]>([]);
  const [authMethod, setAuthMethod] = useState<TerminalAuthMethod>("password");
  const [authUsername, setAuthUsername] = useState("root");
  const [authPassword, setAuthPassword] = useState("");
  const [authKeyId, setAuthKeyId] = useState<string | null>(null);
  const [authPassphrase, setAuthPassphrase] = useState("");
  const [showAuthPassphrase, setShowAuthPassphrase] = useState(false);
  const [showAuthPassword, setShowAuthPassword] = useState(false);

  const paneRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  /**
   * 自动补全输入状态（不触发 React 重渲染的部分用 ref，保证 onData 同步读取）：
   * typed 是提示符后已输入内容；previewedCommand 非空代表当前行已被实时预览改写。
   */
  const autocompleteRef = useRef<{
    typed: string;
    reliable: boolean;
    /** 行内已有方向键 / 删除词 / Shell 补全等无法追踪的改动：本行不再给候选。 */
    unknownLine: boolean;
    suggestions: AutocompleteSuggestion[];
    selected: number;
    previewedCommand: string | null;
    timer: number | null;
    /** 子面板（逐级下钻目录）与当前焦点（-1 = 主列表）。 */
    subPanels: AutocompleteSubPanel[];
    subFocus: number;
    /** 子面板请求代数：选中项 / 目录变化后丢弃迟到结果。 */
    subVersion: number;
    /** 查询代数：Esc/关闭浮层后作废在途的预算回调。 */
    queryVersion: number;
  }>({
    typed: "",
    reliable: true,
    unknownLine: false,
    suggestions: [],
    selected: -1,
    previewedCommand: null,
    timer: null,
    subPanels: [],
    subFocus: -1,
    subVersion: 0,
    queryVersion: 0,
  });
  /** 路径目录缓存（sessionId + 目录，TTL 5s + in-flight 合并）。 */
  const autocompletePathCacheRef = useRef(createPathDirectoryCache());
  /** 自动补全专用的 SFTP 句柄：复用当前 SSH 会话，不在补全时新开连接。 */
  const autocompleteSftpRef = useRef<{ sessionId: string; promise: Promise<string> } | null>(
    null,
  );
  /** home 路径按 provider 缓存，避免每次 `~` 目录都多打一次远端请求。 */
  const autocompleteHomeRef = useRef<{ providerId: string; promise: Promise<string> } | null>(
    null,
  );
  const transportRef = useRef<TerminalTransport | null>(null);
  /**
   * 写入队列：输入兼容模式会把一次 onData 拆成多段 sshWrite，跨 onData 调用
   * 也必须串行（每次新建一条链会让相邻按键/撰写栏整段写入互相插队）。
   * 每段单独 catch，单段失败不影响后续输入。
   */
  const writeQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const unsubRef = useRef<UnlistenFn[]>([]);
  const promptUnsubRef = useRef<UnlistenFn[]>([]);
  const sidRef = useRef<string | null>(null);
  /** 正在脚本录制的会话 id（断线 / 卸载时按它释放全局录制槽）。 */
  const scriptRecSidRef = useRef<string | null>(null);
  /** 正在连接（尚未返回）时预生成的 sessionId，用于取消 / 超时。 */
  const connectSidRef = useRef<string | null>(null);
  /** 主机密钥 prompt 对应的 sessionId（响应时用）。 */
  const hostKeySessionRef = useRef<string | null>(null);
  /** 连接尝试代数：取消 / 超时后让仍在进行的旧尝试失效。 */
  const attemptRef = useRef(0);
  const listenersRef = useRef(new Set<(sid: string | null) => void>());
  /** cwd 镜像与订阅者：SFTP 面板经句柄读取最新目录，不能等 state 异步生效。 */
  const cwdRef = useRef<string | null>(null);
  const cwdListenersRef = useRef(new Set<(cwd: string | null) => void>());

  function applyCwd(next: string | null) {
    cwdRef.current = next;
    setCwd(next);
    cwdListenersRef.current.forEach((cb) => cb(next));
  }
  const pendingPromptRef = useRef<Prompt | null>(null);
  const aliveRef = useRef(true);
  const startedRef = useRef(false);
  /** 供标签右键「重连」使用的最新 connect 闭包（避免注册句柄时捕获旧实现）。 */
  const connectRef = useRef<() => Promise<void>>(() => Promise.resolve());
  /** ZMODEM 接管器（仅 SSH 会话创建）。 */
  const zmodemRef = useRef<ZmodemController | null>(null);
  /** 拖拽上传等待 rz 输出 ZRINIT 的超时计时器。 */
  const zmodemUploadTimerRef = useRef<number | null>(null);

  function notifySession(sid: string | null) {
    sidRef.current = sid;
    listenersRef.current.forEach((cb) => cb(sid));
  }

  function setPromptBoth(p: Prompt | null) {
    pendingPromptRef.current = p;
    setPrompt(p);
    if (!p) setAnswers([]);
  }

  function cancelPromptApi(p: Prompt) {
    if (p.kind === "auth") void api.sshAuthCancel(p.sessionId);
    else void api.sshPassphraseCancel(p.sessionId);
  }

  /** 拆掉本窗格会话的事件监听与传输（不重连）。 */
  function teardown() {
    clearPendingWrites();
    zmodemRef.current?.dispose();
    zmodemRef.current = null;
    if (zmodemUploadTimerRef.current !== null) {
      window.clearTimeout(zmodemUploadTimerRef.current);
      zmodemUploadTimerRef.current = null;
    }
    unsubRef.current.forEach((u) => u());
    unsubRef.current = [];
    promptUnsubRef.current.forEach((u) => u());
    promptUnsubRef.current = [];
    transportRef.current?.close();
    transportRef.current = null;
  }

  useEffect(() => {
    return () => {
      aliveRef.current = false;
      attemptRef.current += 1;
      clearPendingWrites();
      const recSid = scriptRecSidRef.current;
      if (recSid) {
        // 关标签时释放全局脚本录制槽，避免其它终端被永久互斥。
        endScriptRecording(recSid);
        scriptRecSidRef.current = null;
      }
      if (pendingPromptRef.current) cancelPromptApi(pendingPromptRef.current);
      pendingPromptRef.current = null;
      if (hostKeySessionRef.current) void api.sshHostKeyCancel(hostKeySessionRef.current);
      hostKeySessionRef.current = null;
      zmodemRef.current?.dispose();
      zmodemRef.current = null;
      if (zmodemUploadTimerRef.current !== null) {
        window.clearTimeout(zmodemUploadTimerRef.current);
        zmodemUploadTimerRef.current = null;
      }
      unsubRef.current.forEach((u) => u());
      unsubRef.current = [];
      promptUnsubRef.current.forEach((u) => u());
      promptUnsubRef.current = [];
      transportRef.current?.close();
      transportRef.current = null;
      if (connectSidRef.current) void api.sshDisconnect(connectSidRef.current);
      connectSidRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 注册句柄（工作区据此找到「当前活动窗格」）
  useEffect(() => {
    const handle: PaneHandle = {
      paneId,
      sshSessionId: () =>
        tab.connector.kind === "ssh" ? sidRef.current : null,
      subscribeSession: (cb) => {
        listenersRef.current.add(cb);
        cb(sidRef.current);
        return () => {
          listenersRef.current.delete(cb);
        };
      },
      cwd: () => cwdRef.current,
      subscribeCwd: (cb) => {
        cwdListenersRef.current.add(cb);
        cb(cwdRef.current);
        return () => {
          cwdListenersRef.current.delete(cb);
        };
      },
      reconnect: () => {
        if (aliveRef.current) void connectRef.current();
      },
      focus: () => {
        if (aliveRef.current) controllerRef.current?.term.focus();
      },
      connected: () => transportRef.current !== null,
      runSnippet: (snippet) => runSnippetRef.current(snippet),
      sendText: (text) => {
        if (!transportRef.current) return false;
        transportRef.current.write(text);
        return true;
      },
      interrupt: () => {
        if (!transportRef.current) return false;
        clearPendingWrites();
        transportRef.current.write("\u0003");
        return true;
      },
      suspend: () => {
        if (!transportRef.current) return false;
        transportRef.current.write("\u001a");
        return true;
      },
      resume: () => {
        if (!transportRef.current) return false;
        transportRef.current.write("fg\r");
        return true;
      },
      openSearch: () => {
        setSearchOpen(true);
        return true;
      },
      toggleCompose: () => {
        setComposeOpen((v) => !v);
        return true;
      },
      copySelection: () => {
        const term = controllerRef.current?.term;
        if (!term) return false;
        const text = readTerminalSelection(term, getSettings().terminal.normalizeTextOnCopy);
        if (!text) return false;
        void navigator.clipboard.writeText(text);
        return true;
      },
      pasteClipboard: () => {
        void pasteFromClipboard();
        return true;
      },
      selectAllText: () => {
        const term = controllerRef.current?.term;
        if (!term) return false;
        term.selectAll();
        return true;
      },
      clearBuffer: () => {
        const term = controllerRef.current?.term;
        if (!term) return false;
        term.clear();
        return true;
      },
    };
    onRegister(paneId, handle);
    return () => {
      onRegister(paneId, null);
      // 释放自动补全专用的 SFTP 子系统与目录缓存，避免会话切换后悬挂。
      const sftp = autocompleteSftpRef.current;
      autocompleteSftpRef.current = null;
      autocompleteHomeRef.current = null;
      autocompletePathCacheRef.current.invalidate();
      void sftp?.promise.then((sftpId) => api.sftpClose(sftpId)).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, tab.connector.kind]);

  useEffect(() => {
    if (active) controllerRef.current?.term.focus();
  }, [active]);

  // 非 SSH 会话也填充主机信息：串口用端口名、Telnet 用目标主机。
  // 对齐 Netcatty 状态栏「复制主机地址」（非本地且 hostname 非空才显示并可复制）。
  useEffect(() => {
    const connector = tab.connector;
    if (connector.kind === "serial") {
      setHostInfo({
        label: tab.title,
        hostname: connector.session.port,
        port: 0,
        protocol: "Serial",
      });
    } else if (connector.kind === "telnet") {
      setHostInfo({
        label: tab.title,
        hostname: connector.session.host,
        port: connector.session.port,
        protocol: "Telnet",
      });
    } else if (connector.kind === "pty") {
      setHostInfo({ label: tab.title, hostname: "", port: 0, protocol: "LOCAL" });
    }
  }, [tab.connector, tab.title]);

  // 取档案 / 初始凭据 / 可选密钥，供连接弹窗展示与认证重试。
  useEffect(() => {
    if (!sshProfileId) return;
    let cancelled = false;
    void (async () => {
      try {
        const profile = await api.getProfile(sshProfileId);
        if (cancelled) return;
        setHostInfo({
          label: profile.name || tab.title,
          hostname: profile.host,
          port: profile.port,
          protocol: "SSH",
        });
        const credential = await api.getCredential(profile.credential_id);
        if (cancelled) return;
        // 对齐 netcatty useTerminalAuthState：重试表单默认密码 tab，
        // 用户名预填 host.username || "root"，不预选密钥。
        setAuthUsername(credential.username || "root");
      } catch {
        // 档案读取失败不阻塞连接，弹窗使用 tab 标题兜底。
      }
      try {
        const all = await api.listCredentials();
        if (cancelled) return;
        setKeys(
          all.map((credential) => ({
            id: credential.id,
            label: credential.name || credential.username,
            type: credential.type,
            username: credential.username,
          })),
        );
      } catch {
        // 没有密钥列表时认证弹窗会提示「没有可用的 SSH 密钥凭据」。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sshProfileId, tab.title]);

  // ── 连接进度事件（ssh:progress:<sid>）────────────────────
  function handleProgress(p: SshProgressEvent) {
    const total = Math.max(1, p.total);
    const hop = Math.max(1, p.hop);

    if (total > 1) {
      setChainProgress({
        currentHop: hop,
        totalHops: total,
        currentHostLabel: p.label,
      });
    }

    const prefix = total > 1 ? `[${hop}/${total}] ` : "";
    // 逐跳日志行格式逐字对齐 netcatty createTerminalSessionStarters.ts：
    // zh-CN 下除 connected（已连接）外均为英文原文（i18n 缺省回落）。
    let logLine: string;
    switch (p.status) {
      case "connecting":
        logLine = `${prefix}Connecting to ${p.label}...`;
        break;
      case "tcp-connected":
        logLine = `${prefix}${p.label} - TCP connected`;
        break;
      case "authenticating":
        logLine = `${prefix}${p.label} - Key exchange complete`;
        break;
      case "auth-attempt":
        if (p.error?.endsWith("rejected")) {
          logLine = `${prefix}${p.label} - ✗ ${p.error}`;
        } else if (p.error === "all methods exhausted") {
          logLine = `${prefix}${p.label} - ✗ All authentication methods exhausted`;
        } else if (p.error === "waiting for user input..." || p.error === "user responded") {
          logLine = `${prefix}${p.label} - ${p.error}`;
        } else {
          logLine = `${prefix}${p.label} - Trying ${p.error}...`;
        }
        break;
      case "authenticated":
        logLine = `${prefix}${p.label} - Authenticated`;
        break;
      case "connected":
        logLine = `${prefix}${p.label} - 已连接`;
        break;
      case "forwarding":
        logLine = `${prefix}${p.label} - Forwarding...`;
        break;
      case "shell":
        logLine = `${prefix}Opening shell...`;
        break;
      case "error":
        logLine = `${prefix}${p.label} - Error${
          p.error ? `: ${userVisibleError(p.error)}` : ""
        }`;
        break;
      default:
        logLine = `${prefix}${p.label} - ${p.status}${
          p.error ? `: ${userVisibleError(p.error)}` : ""
        }`;
    }

    if (p.status === "connecting" || p.status === "forwarding") {
      setIsConnectionPastTcpDial(false);
    }
    if (hasConnectionPassedTcpDial(p.status)) {
      setIsConnectionPastTcpDial(true);
    }
    if (p.status === "auth-attempt" && p.error === "waiting for user input...") {
      setIsAwaitingUserInput(true);
    } else if (p.status === "auth-attempt" && p.error === "user responded") {
      setIsAwaitingUserInput(false);
    } else if (
      p.status === "authenticated" ||
      p.status === "connected" ||
      p.status === "shell" ||
      p.status === "error"
    ) {
      setIsAwaitingUserInput(false);
    }

    setProgressLogs((prev) => [...prev, logLine]);
    const hopProgress = resolveHopConnectionProgress(hop, total);
    setProgressValue((prev) => advanceMonotonicConnectionProgress(prev, hopProgress));
  }

  /** 追加到窗格级写入队列；链尾统一兜底，避免一次失败中断整串输入。 */
  function enqueueWrite(task: () => Promise<unknown>) {
    writeQueueRef.current = writeQueueRef.current.then(task).catch(() => {});
  }

  async function wire(domain: TerminalDomain, sid: string) {
    const transport: TerminalTransport = {
      kind: domain,
      write: (text) => {
        if (domain === "pty") {
          enqueueWrite(() => api.ptyWrite(sid, text));
          return;
        }
        // 输入兼容模式：一次 onData 拆成多次 sshWrite（控制序列仍成组），
        // 每段独立入队串行，避免并发 invoke 让远端收到的字符顺序错乱。
        if (inputCompatRef.current) {
          for (const chunk of splitCompatibleWrites(text)) {
            enqueueWrite(() => api.sshWrite(sid, chunk, encodingRef.current));
          }
          return;
        }
        enqueueWrite(() => api.sshWrite(sid, text, encodingRef.current));
      },
      // 撰写栏/脚本整段写入：不拆分，但仍接在同一队列尾部，保证不插队。
      writeBulk: (text) =>
        enqueueWrite(() =>
          domain === "pty"
            ? api.ptyWrite(sid, text)
            : api.sshWrite(sid, text, encodingRef.current),
        ),
      resize: (c, r) =>
        void (domain === "pty"
          ? api.ptyResize(sid, c, r)
          : api.sshResize(sid, c, r)),
      close: () =>
        void (domain === "pty"
          ? api.ptyClose(sid)
          : api.sshDisconnect(sid)),
    };
    transportRef.current = transport;
    // ZMODEM 接管：仅 SSH 会话。字节流先经 Sentry 分流，协议字节原样写回，
    // 其余字节继续进终端；检测到 rz/sz 后自动完成收发。
    if (domain === "ssh") {
      zmodemRef.current?.dispose();
      zmodemRef.current = createZmodemController({
        writeToTerminal: writeTerminalText,
        writeToRemote: (bytes) => {
          void api.sshWriteBytes(sid, bytes);
        },
        saveDownload: saveZmodemDownload,
        onEvent: handleZmodemEvent,
      });
    }
    setStatus("connected");
    setError(null);
    setChainProgress(null);
    setDisconnectedDismissed(false);
    notifySession(sid);

    unsubRef.current = [
      await api.onTerminalData(domain, sid, writeTerminalOutput),
      await api.onTerminalClose(domain, sid, (info: CloseInfo) => {
        transportRef.current = null;
        firedOutputRef.current = new Set();
        notifySession(null);
        const suffix = info.signal
          ? `被信号 ${info.signal} 终止`
          : typeof info.exit_code === "number"
            ? `退出码 ${info.exit_code}`
            : "已断开";
        setStatus("disconnected");
        setError(suffix);
        setProgressLogs((prev) => [...prev, suffix]);
        setDisconnectedDismissed(false);
        onStatus(`${tab.title} ${suffix}`);
        // 会话结束后自动关闭窗格 / 标签（Netcatty autoCloseOnExit）。
        if (getSettings().terminal.autoCloseOnExit) {
          window.setTimeout(() => onClosePane?.(), 0);
          return;
        }
        // 行为区「连接断开时」：终端内提示（不弹完整连接弹窗）。
        if (getSettings().terminal.disconnectedNoticeMode === "terminal") {
          controllerRef.current?.term.write(
            `\r\n\u001b[90m[连接已断开：${suffix} · 按 Enter 重新连接]\u001b[0m\r\n`,
          );
          setDisconnectedDismissed(true);
          controllerRef.current?.term.focus();
        }
      }),
    ];

    onStatus(`${tab.title} 已连接 (${sid})`);
    controllerRef.current?.fit.fit();
    controllerRef.current?.term.focus();
    maybeAutoOpenSidePanel();
    // 阶段 B：连接建立后执行 onConnect 脚本（仅当前主机目标命中时）。
    void runOnConnectScripts();
  }

  /** 连接成功后按设置自动打开侧边栏（支持 SFTP / 脚本 / 历史 / 笔记）。 */
  function maybeAutoOpenSidePanel() {
    const s = getSettings();
    if (!s.sidePanelAutoOpen) return;
    const pane = AUTO_OPEN_SIDE_PANEL_PANES[s.sidePanelAutoOpenPane];
    if (!pane) return;
    // SFTP 侧栏复用 SSH 通道，非 SSH 会话不打开（对齐 Netcatty sftpAvailable）。
    if (pane === "sftp" && tab.connector.kind !== "ssh") return;
    onOpenTool?.(pane);
  }

  // 每次渲染都刷新引用，句柄里的 reconnect 永远调用最新闭包。
  connectRef.current = () => connect();

  async function connect(authOverride?: AuthOverride) {
    const c = controllerRef.current;
    if (!c) return;
    const attempt = ++attemptRef.current;

    setStatus("connecting");
    setError(null);
    setNeedsAuth(false);
    setAuthRetryMessage(null);
    setChainProgress(null);
    setProgressValue(CONNECTION_PROGRESS_START);
    setProgressLogs([]);
    setDisconnectedDismissed(false);
    setIsConnectionPastTcpDial(false);
    setIsAwaitingUserInput(false);
    setIsCancelling(false);
    setHostKeyInfo(null);
    hostKeySessionRef.current = null;
    setPromptBoth(null);
    teardown();
    notifySession(null);

    if (tab.connector.kind === "serial") {
      const conn = tab.connector;
      const sid = api.newSessionId();
      const input = createSerialInput({
        lineMode: conn.session.lineMode,
        localEcho: conn.session.localEcho,
        backspaceBehavior: conn.session.backspaceBehavior,
        byteOrientedBackspace: conn.session.byteOrientedBackspace,
      });
      try {
        // 先注册监听再 open：串口 data 事件在 open 返回后即可能到达。
        // 逐条入栈（而不是数组字面量整体赋值）：第二个监听注册失败时，
        // 第一个也不会漏退订。
        const unsubs: UnlistenFn[] = [];
        unsubRef.current = unsubs;
        unsubs.push(
          await api.onSerialData(sid, (bytes) => writeSerialText(bytes)),
        );
        unsubs.push(
          await api.onSerialClose(sid, () => {
            // 旧连接关闭事件可能在重连 / 换端口之后才到，别污染新会话状态。
            if (!aliveRef.current || attempt !== attemptRef.current) return;
            transportRef.current = null;
            notifySession(null);
            setStatus("disconnected");
            setError("串口已断开");
            setDisconnectedDismissed(false);
            onStatus(`${tab.title} 串口已断开`);
          }),
        );
        const actual = await api.serialOpen(
          conn.session.port,
          conn.session.config,
          sid,
          // 仅从已保存主机打开的串口带 profileId；临时连接不自动记录日志。
          conn.profileId,
        );
        if (!aliveRef.current || attempt !== attemptRef.current) {
          void api.serialClose(actual);
          return;
        }
        transportRef.current = {
          kind: "serial",
          write: (text) => {
            const chunk = input.feed(text);
            if (chunk.echo) writeFilteredText(chunk.echo);
            if (chunk.wire) void api.serialWrite(actual, chunk.wire);
          },
          writeBulk: (text) => {
            const chunk = input.feed(text);
            if (chunk.echo) writeFilteredText(chunk.echo);
            if (chunk.wire) void api.serialWrite(actual, chunk.wire);
          },
          resize: () => {},
          close: () => {
            void api.serialClose(actual);
          },
        };
        setStatus("connected");
        setError(null);
        setChainProgress(null);
        setDisconnectedDismissed(false);
        notifySession(actual);
        onStatus(`${tab.title} 已连接串口 ${conn.session.port}`);
        controllerRef.current?.fit.fit();
        controllerRef.current?.term.focus();
      } catch (e) {
        if (!aliveRef.current || attempt !== attemptRef.current) return;
        const message = userVisibleError(String(e));
        unsubRef.current.forEach((u) => u());
        unsubRef.current = [];
        setStatus("disconnected");
        setError(message);
        onStatus(`${tab.title} 串口连接失败：${message}`);
      }
      return;
    }

    if (tab.connector.kind === "telnet") {
      const conn = tab.connector;
      const sid = api.newSessionId();
      const cols = c.term.cols;
      const rows = c.term.rows;
      // 服务端 WILL ECHO 时自己回显；否则本地回显（默认由服务端回显，
      // 与 Netcatty 的 telnetLocalEchoRef 初值一致）。
      const localEcho = { current: false };
      try {
        const unsubs: UnlistenFn[] = [];
        unsubRef.current = unsubs;
        unsubs.push(
          await api.onTelnetData(sid, writeTerminalOutput),
        );
        unsubs.push(
          await api.onTelnetEcho(sid, (remoteEcho) => {
            localEcho.current = !remoteEcho;
          }),
        );
        unsubs.push(
          await api.onTelnetClose(sid, () => {
            if (!aliveRef.current || attempt !== attemptRef.current) return;
            transportRef.current = null;
            notifySession(null);
            setStatus("disconnected");
            setError("Telnet 已断开");
            setDisconnectedDismissed(false);
            onStatus(`${tab.title} Telnet 已断开`);
          }),
        );
        unsubs.push(
          await api.onTelnetAutoLogin(sid, (autoStatus) => {
            if (!aliveRef.current || attempt !== attemptRef.current) return;
            if (autoStatus === "complete") {
              onStatus(`${tab.title} Telnet 自动登录完成`);
            } else if (autoStatus === "cancelled") {
              onStatus(`${tab.title} Telnet 自动登录已取消（检测到手动输入）`);
            } else {
              onStatus(`${tab.title} Telnet 自动登录未完成（等待人工输入）`);
            }
          }),
        );
        const credentials =
          conn.session.username !== undefined || conn.session.password !== undefined
            ? {
                username: conn.session.username ?? "",
                password: conn.session.password ?? "",
              }
            : null;
        const actual = await api.telnetOpen(
          conn.session.host,
          conn.session.port,
          cols,
          rows,
          conn.session.inputNewline,
          sid,
          credentials,
          // 仅从已保存主机打开的 Telnet 带 profileId；临时连接不自动记录日志。
          conn.session.profileId,
        );
        if (!aliveRef.current || attempt !== attemptRef.current) {
          void api.telnetClose(actual);
          return;
        }
        transportRef.current = {
          kind: "telnet",
          write: (text) => {
            if (localEcho.current) {
              const echo = formatTelnetLocalEcho(text);
              if (echo) writeFilteredText(echo);
            }
            void api.telnetWrite(actual, text, encodingRef.current);
          },
          resize: (nextCols, nextRows) => {
            void api.telnetResize(actual, nextCols, nextRows);
          },
          close: () => {
            void api.telnetClose(actual);
          },
        };
        setStatus("connected");
        setError(null);
        setChainProgress(null);
        setDisconnectedDismissed(false);
        notifySession(actual);
        onStatus(
          `${tab.title} 已连接 Telnet ${conn.session.host}:${conn.session.port}`,
        );
        controllerRef.current?.fit.fit();
        controllerRef.current?.term.focus();
        maybeAutoOpenSidePanel();
      } catch (e) {
        if (!aliveRef.current || attempt !== attemptRef.current) return;
        const message = userVisibleError(String(e));
        unsubRef.current.forEach((u) => u());
        unsubRef.current = [];
        setStatus("disconnected");
        setError(message);
        onStatus(`${tab.title} Telnet 连接失败：${message}`);
      }
      return;
    }

    if (!isSsh) {
      try {
        const localOpts =
          tab.connector.kind === "pty"
            ? {
                shell: tab.connector.shell,
                args: tab.connector.args,
                startDir: tab.connector.startDir,
              }
            : undefined;
        const sid = await api.ptySpawn(c.term.cols, c.term.rows, localOpts);
        if (!aliveRef.current || attempt !== attemptRef.current) {
          void api.ptyClose(sid);
          return;
        }
        await wire("pty", sid);
      } catch (e) {
        if (!aliveRef.current || attempt !== attemptRef.current) return;
        const message = userVisibleError(String(e));
        setStatus("disconnected");
        setError(message);
        onStatus(`${tab.title} 连接失败：${message}`);
      }
      return;
    }

    const profileId = sshProfileId;
    if (!profileId) return;
    const sid = api.newSessionId();
    connectSidRef.current = sid;

    // prompt 监听必须在 await sshConnect 之前注册，否则认证 pending 期间的
    // 事件会丢。
    promptUnsubRef.current = [
      await api.onSshProgress(sid, handleProgress),
      await api.onAuthPrompt(sid, (p) => {
        setIsAwaitingUserInput(true);
        setPromptBoth({ kind: "auth", sessionId: sid, payload: p });
      }),
      await api.onPassphrasePrompt(sid, (p) => {
        setIsAwaitingUserInput(true);
        setPromptBoth({ kind: "passphrase", sessionId: sid, payload: p });
      }),
      await api.onHostKeyPrompt(sid, (p) => {
        hostKeySessionRef.current = sid;
        setHostKeyInfo(toHostKeyInfo(p));
      }),
    ];

    // 输入兼容模式快照：在 sshConnect 之前读取。读取失败不阻断连接——
    // 保持上一次的值（初始 false，标准模式）继续用既有传输行为。
    try {
      const profile = await api.getProfile(profileId);
      inputCompatRef.current = resolveInputCompatibility(
        profile.ssh_input_compatibility,
      );
    } catch {
      // 主机档案读取失败只影响本会话的输入模式，连接照常进行。
    }

    try {
      const actual = await api.sshConnect(
        profileId,
        c.term.cols,
        c.term.rows,
        sid,
        authOverride ?? null,
      );
      if (!aliveRef.current || attempt !== attemptRef.current) {
        void api.sshDisconnect(actual);
        return;
      }
      promptUnsubRef.current.forEach((u) => u());
      promptUnsubRef.current = [];
      connectSidRef.current = null;
      setHostKeyInfo(null);
      hostKeySessionRef.current = null;
      setIsAwaitingUserInput(false);
      setPromptBoth(null);
      await wire("ssh", actual);
    } catch (e) {
      if (!aliveRef.current || attempt !== attemptRef.current) return;
      promptUnsubRef.current.forEach((u) => u());
      promptUnsubRef.current = [];
      connectSidRef.current = null;
      setPromptBoth(null);
      setHostKeyInfo(null);
      hostKeySessionRef.current = null;
      setIsAwaitingUserInput(false);
      setIsConnectionPastTcpDial(false);

      const raw = String(e);
      if (isAuthFailureMessage(raw)) {
        // netcatty：认证失败 → 留在 connecting + 弹认证重试表单。
        setChainProgress(null);
        setError(null);
        setNeedsAuth(true);
        setAuthRetryMessage(AUTH_RETRY_MESSAGE);
        setAuthPassword("");
        setProgressLogs((prev) => [...prev, "身份验证失败，请重试。"]);
        setStatus("connecting");
      } else {
        const message = userVisibleError(raw);
        setChainProgress(null);
        setNeedsAuth(false);
        setAuthRetryMessage(null);
        setError(message);
        setStatus("disconnected");
        onStatus(`${tab.title} 连接失败：${message}`);
        controllerRef.current?.term.write(`\r\n[Failed to start SSH: ${message}]\r\n`);
      }
    }
  }

  // ── 超时倒计时 / 自动进度（对照 netcatty useTerminalEffects）────────
  useEffect(() => {
    if (!isSsh) return;
    const timeoutState = {
      status,
      needsAuth,
      needsHostKeyVerification: Boolean(hostKeyInfo),
      isConnectionAwaitingUserInput: isAwaitingUserInput,
      isConnectionPastTcpDial,
      hasSshTcpConnectProgress: true,
    };
    if (!shouldRunConnectionTimeout(timeoutState)) return;

    const connectionTimeout = getConnectionTimeoutMs(timeoutState);
    setTimeLeft(connectionTimeout / 1000);
    const countdown = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    const timeout = setTimeout(() => {
      attemptRef.current += 1;
      const pendingSid = connectSidRef.current;
      connectSidRef.current = null;
      teardown();
      if (pendingSid) void api.sshDisconnect(pendingSid);
      notifySession(null);
      setError(PROGRESS_ATTEMPT_TIMEOUT_MESSAGE);
      setProgressLogs((prev) => [...prev, "连接超时。"]);
      setStatus("disconnected");
      setChainProgress(null);
      setDisconnectedDismissed(false);
    }, connectionTimeout);
    const progressTick = setInterval(() => {
      setProgressValue(advanceIndeterminateConnectionProgress);
    }, 200);

    return () => {
      clearInterval(countdown);
      clearTimeout(timeout);
      clearInterval(progressTick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, needsAuth, hostKeyInfo, isAwaitingUserInput, isConnectionPastTcpDial, isSsh]);

  // ── 交互 prompt 响应 ─────────────────────────────────────

  async function respondAuth() {
    if (!prompt || prompt.kind !== "auth") return;
    setBusy(true);
    await api.sshAuthRespond(prompt.sessionId, answers);
    setBusy(false);
    setIsAwaitingUserInput(false);
    setPromptBoth(null);
  }

  async function respondPassphrase() {
    if (!prompt || prompt.kind !== "passphrase") return;
    setBusy(true);
    await api.sshPassphraseRespond(prompt.sessionId, answers[0] ?? "");
    setBusy(false);
    setIsAwaitingUserInput(false);
    setPromptBoth(null);
  }

  async function cancelPrompt() {
    if (!prompt) return;
    cancelPromptApi(prompt);
    setIsAwaitingUserInput(false);
    setPromptBoth(null);
  }

  // ── 连接弹窗操作 ─────────────────────────────────────────

  /** 取消连接（netcatty handleCancelConnect：结束会话并关闭标签 / 窗格）。 */
  function handleCancelConnect() {
    const pendingSid = connectSidRef.current;
    if (hostKeySessionRef.current) {
      void api.sshHostKeyRespond(hostKeySessionRef.current, "no");
    }
    hostKeySessionRef.current = null;
    attemptRef.current += 1;
    teardown();
    connectSidRef.current = null;
    if (pendingSid) void api.sshDisconnect(pendingSid);
    notifySession(null);
    setNeedsAuth(false);
    setAuthRetryMessage(null);
    setHostKeyInfo(null);
    setIsAwaitingUserInput(false);
    setError("连接已取消");
    setProgressLogs((prev) => [...prev, "用户已取消。"]);
    setStatus("disconnected");
    setChainProgress(null);
    setDisconnectedDismissed(false);
    setIsCancelling(true);
    setTimeout(() => setIsCancelling(false), 600);
    onStatus(`${tab.title} 已取消连接`);
    onClosePane?.();
  }

  /** 断开当前会话：只拆掉传输与监听，保留标签页与窗格。 */
  function disconnect() {
    const wasConnecting = status === "connecting";
    const pendingSid = connectSidRef.current;
    attemptRef.current += 1;
    teardown();
    connectSidRef.current = null;
    if (wasConnecting && pendingSid) void api.sshDisconnect(pendingSid);
    notifySession(null);
    setPromptBoth(null);
    setHostKeyInfo(null);
    hostKeySessionRef.current = null;
    setNeedsAuth(false);
    setAuthRetryMessage(null);
    setIsAwaitingUserInput(false);
    setChainProgress(null);
    setError(null);
    setStatus("disconnected");
    setProgressLogs((prev) => [...prev, "用户已断开。"]);
    setDisconnectedDismissed(true);
    onStatus(`${tab.title} 已断开`);
  }

  /** 关闭断开后的会话（连接弹窗底部按钮）。 */
  function handleCloseSession() {
    const hadTransport = transportRef.current !== null;
    const pendingSid = connectSidRef.current;
    attemptRef.current += 1;
    teardown();
    connectSidRef.current = null;
    if (!hadTransport && pendingSid) void api.sshDisconnect(pendingSid);
    notifySession(null);
    onClosePane?.();
  }

  function handleDismissDisconnected() {
    setDisconnectedDismissed(true);
    window.setTimeout(() => controllerRef.current?.term.focus(), 0);
  }

  function answerHostKey(answer: "continue" | "yes" | "replace") {
    const sid = hostKeySessionRef.current;
    if (sid) void api.sshHostKeyRespond(sid, answer);
    hostKeySessionRef.current = null;
    setHostKeyInfo(null);
  }

  function handleHostKeyClose() {
    handleCancelConnect();
  }

  function handleHostKeyContinue() {
    answerHostKey("continue");
  }

  function handleHostKeyAddAndContinue() {
    answerHostKey(hostKeyInfo?.status === "changed" ? "replace" : "yes");
  }

  function submitAuth() {
    const username = authUsername.trim();
    const isValid =
      username.length > 0 &&
      (authMethod === "password" ? authPassword.length > 0 : Boolean(authKeyId));
    if (!isValid) return;
    const override: AuthOverride =
      authMethod === "password"
        ? { username, password: authPassword }
        : {
            username,
            credential_id: authKeyId ?? undefined,
            passphrase: authPassphrase || undefined,
          };
    void connect(override);
  }

  /**
   * 「继续并保存」（netcatty onSubmit → submit({ saveToHost: true })）：
   * 先按一次性覆盖发起连接，再把用户名 / 密码写回档案凭据。
   * 密钥方式换选了别的密钥时，档案改指新凭据（对齐 netcatty
   * buildSavedAuthHostUpdate 的 identityFileId 写回）。落库失败不阻塞连接。
   */
  function submitAuthAndSave() {
    const username = authUsername.trim();
    const isValid =
      username.length > 0 &&
      (authMethod === "password" ? authPassword.length > 0 : Boolean(authKeyId));
    if (!isValid) return;
    submitAuth();
    const profileId = sshProfileId;
    if (!profileId) return;
    void (async () => {
      try {
        const profile = await api.getProfile(profileId);
        if (authMethod === "key" && authKeyId && authKeyId !== profile.credential_id) {
          await api.updateProfile({ ...profile, credential_id: authKeyId });
          const cred = await api.getCredential(authKeyId);
          await api.updateCredential({ ...cred, username });
        } else {
          const cred = await api.getCredential(profile.credential_id);
          await api.updateCredential({
            ...cred,
            username,
            type: authMethod === "password" ? "password" : cred.type,
            secret: authMethod === "password" ? authPassword : cred.secret,
          });
        }
      } catch {
        // 落库失败不影响本次连接（一次性覆盖已生效）。
      }
    })();
  }

  const canDisconnect = status === "connected" || status === "connecting";
  const canReconnect = status !== "connecting";
  const transportKind = tab.connector.kind;
  const caps = deriveToolbarCapabilities(transportKind);
  // 右侧工具栏 / More 菜单条目均由 toolbarLayout 的 spec 派生（顺序与可见性唯一来源）。
  const toolbarActions = resolveTerminalToolbarActions(transportKind);
  const moreActions = resolveTerminalMoreActions(transportKind);
  // 系统监控只出现在远端 SSH 会话（netcatty isSystemSidebarEligible 排除本地 / 串口 / Telnet）
  const systemEligible = caps.systemMonitor;
  // 采样接口需要已建立的 SSH 会话 id；按钮只在已连接时启用，其余状态写明原因。
  const monitorSid = systemEligible && status === "connected" ? sidRef.current : null;
  const monitorDisabledReason = status !== "connected"
    ? "连接后可用"
    : !monitorSid
      ? "会话未就绪"
      : null;
  const canMonitor = monitorDisabledReason === null;

  /**
   * 「更多」菜单的可用条件与置灰原因（对照 Netcatty TerminalToolbar）：
   * 类型不支持的项目已按 `caps` 直接隐藏，这里只保留「连接后可用」这类状态原因。
   */
  const moreStatusReason = status !== "connected" ? "连接后可用" : null;
  /** 命令历史是本地持久化数据，未连接也可查看（对齐 Netcatty）。 */
  const moreHistoryReason = null;
  const moreOsc7Reason = moreStatusReason;
  const moreRecordingReason = moreStatusReason;
  const moreEncodingReason = moreStatusReason;

  const authValid =
    authUsername.trim().length > 0 &&
    (authMethod === "password" ? authPassword.length > 0 : Boolean(authKeyId));

  // netcatty shouldShowTerminalConnectionDialog：status !== connected
  // 且 disconnected 状态下未被用户 dismiss。
  const showConnectionDialog =
    isSsh &&
    status !== "connected" &&
    !(status === "disconnected" && disconnectedDismissed) &&
    (status !== "disconnected" || getSettings().terminal.disconnectedNoticeMode === "dialog");

  /** 终端右键菜单（对照 netcatty TerminalContextMenu；坐标相对窗格左上角）。 */
  function openContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".term-toolbar")) return;
    const s = getSettings();
    const term = controllerRef.current?.term;
    // 全屏 TUI 接管鼠标时，设置关闭则把右键交还给应用（Netcatty
    // showContextMenuOverFullscreenApps）。
    if (
      term &&
      term.modes.mouseTrackingMode !== "none" &&
      !s.terminal.showContextMenuOverFullscreenApps
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (longPressOpenedRef.current) return;
    if (s.terminal.rightClickBehavior === "paste") {
      void pasteFromClipboard();
      return;
    }
    if (s.terminal.rightClickBehavior === "select-word") {
      selectWordAt(e.clientX, e.clientY);
      return;
    }
    showContextMenu(e.clientX, e.clientY);
  }

  function showContextMenu(clientX: number, clientY: number) {
    const box = paneRef.current?.getBoundingClientRect();
    if (!box) return;
    const s = getSettings();
    const term = controllerRef.current?.term;
    const menuWidth = 240; // 与 .term-context-menu 的 min/max-width 对齐（实际宽度随内容）
    const menuHeight = 340;
    setMenu({
      x: Math.max(4, Math.min(clientX - box.left, box.width - menuWidth - 4)),
      y: Math.max(4, Math.min(clientY - box.top, Math.max(4, box.height - menuHeight))),
      selection: term ? readTerminalSelection(term, s.terminal.normalizeTextOnCopy) : "",
    });
  }

  /** 读取系统剪贴板并粘贴（多行确认 / 粘贴后滚动与 Netcatty 行为区一致）。 */
  async function pasteFromClipboard() {
    try {
      const text = await api.clipboardRead();
      if (!text) return;
      const s = getSettings();
      if (s.terminal.confirmBeforeMultilinePaste) {
        const lines = text.split(/\r\n|\r|\n/).length;
        if (
          lines >= s.terminal.multilinePasteConfirmMinLines &&
          !window.confirm(`即将粘贴 ${lines} 行 / ${text.length} 个字符，确认发送？`)
        ) {
          return;
        }
      }
      const term = controllerRef.current?.term;
      const bracketed = Boolean(term?.modes.bracketedPasteMode);
      const payload = buildPastePayload(text, bracketed);
      if (transportRef.current?.writeBulk) transportRef.current.writeBulk(payload);
      else transportRef.current?.write(payload);
      if (s.terminal.scrollOnPaste) term?.scrollToBottom();
      term?.focus();
    } catch {
      // 剪贴板无权限时静默失败（与 Netcatty 一致）。
    }
  }

  /** 右键「选择单词」：按 xterm 单元格坐标命中光标词并选中（Netcatty select-word）。 */
  function selectWordAt(clientX: number, clientY: number) {
    const term = controllerRef.current?.term;
    const el = term?.element;
    if (!term || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cellW = rect.width / Math.max(1, term.cols);
    const cellH = rect.height / Math.max(1, term.rows);
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((clientX - rect.left) / cellW)));
    const viewRow = Math.max(
      0,
      Math.min(term.rows - 1, Math.floor((clientY - rect.top) / cellH)),
    );
    const buffer = term.buffer.active;
    const row = buffer.viewportY + viewRow;
    const line = buffer.getLine(row);
    if (!line) return;
    // translateToString 返回的是字符序列，宽字符 / 组合字符会占多个单元格；
    // 直接拿字符下标当列用会让 CJK 行的选词整体偏移。这里按单元格宽度建立
    // 「字符 → 起始列」映射，选区长度也用单元格语义。
    const cells: { text: string; col: number; width: number }[] = [];
    for (let c = 0; c < line.length; ) {
      const cell = line.getCell(c);
      if (!cell) break;
      const width = cell.getWidth() || 1;
      cells.push({ text: cell.getChars(), col: c, width });
      c += width;
    }
    const separators = getSettings().terminal.wordSeparators;
    const isSeparator = (ch: string) => ch === "" || separators.includes(ch);
    const hit = cells.findIndex((cell) => col >= cell.col && col < cell.col + cell.width);
    if (hit < 0 || isSeparator(cells[hit].text)) {
      term.clearSelection();
      return;
    }
    let start = hit;
    let end = hit;
    while (start > 0 && !isSeparator(cells[start - 1].text)) start -= 1;
    while (end + 1 < cells.length && !isSeparator(cells[end + 1].text)) end += 1;
    const startCol = cells[start].col;
    const endCol = cells[end].col + cells[end].width;
    term.select(startCol, row, Math.max(1, endCol - startCol));
  }

  function closeMenu() {
    setMenu(null);
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  /** 中键行为（Netcatty middleClickBehavior：context-menu / paste / disabled）。 */
  function handleAuxClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button !== 1) return;
    if ((e.target as HTMLElement).closest(".term-toolbar")) return;
    const term = controllerRef.current?.term;
    if (term && term.modes.mouseTrackingMode !== "none") return;
    const mode = getSettings().terminal.middleClickBehavior;
    if (mode === "disabled") return;
    e.preventDefault();
    if (mode === "context-menu") showContextMenu(e.clientX, e.clientY);
    else void pasteFromClipboard();
  }

  /** ZMODEM 横幅文案（检测 / 进度 / 完成 / 错误）。 */
  function zmodemStatusText(event: ZmodemEvent): string {
    const dir = event.direction === "download" ? "下载" : "上传";
    const pct =
      event.total && event.total > 0
        ? ` ${Math.min(100, Math.floor(((event.transferred ?? 0) / event.total) * 100))}%`
        : "";
    switch (event.phase) {
      case "detect":
        return `ZMODEM ${dir}：${event.filename ?? ""}${pct}`;
      case "progress":
        return `ZMODEM ${dir}：${event.filename ?? ""}${pct}`;
      case "complete":
        return `ZMODEM ${dir}完成：${event.filename ?? ""}${
          event.savedPath ? ` → ${event.savedPath}` : ""
        }`;
      default:
        return `ZMODEM ${dir}失败：${event.message ?? "未知错误"}`;
    }
  }

  return (
    <div
      ref={paneRef}
      className={`pane${active ? " active" : ""}${
        zmodemDragActive ? " term-zmodem-dragging" : ""
      }`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!zmodemDragActive) setZmodemDragActive(true);
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        setZmodemDragActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setZmodemDragActive(false);
        handleZmodemDrop(Array.from(e.dataTransfer.files ?? []));
      }}
      onMouseDown={(e) => {
        // 每次按下都复位长按标记：长按弹菜单后的 contextmenu 事件可能落在
        // 遮罩上，不能让它把下一次正常右键吞掉。
        longPressOpenedRef.current = false;
        onActivate();
        controllerRef.current?.term.focus();
        const s = getSettings();
        if (
          e.button === 2 &&
          s.terminal.rightClickLongPressMenu &&
          s.terminal.rightClickBehavior !== "context-menu"
        ) {
          clearLongPressTimer();
          longPressTimerRef.current = window.setTimeout(() => {
            longPressOpenedRef.current = true;
            longPressTimerRef.current = null;
            showContextMenu(e.clientX, e.clientY);
          }, 450);
        }
      }}
      onMouseUp={() => clearLongPressTimer()}
      onMouseLeave={() => clearLongPressTimer()}
      onAuxClick={handleAuxClick}
      onContextMenu={openContextMenu}
      onKeyDownCapture={(e) => {
        // 撰写栏是窗格内的真实输入控件：Enter/Escape 归它自己处理，不能被
        // 断开重连提示或片段快捷键抢先拦截（对照 Netcatty capture 跳过 compose textarea）。
        const target = e.target as HTMLElement | null;
        if (target?.closest(".term-compose-bar")) return;
        // 终端内提示模式下按 Enter 重连（Netcatty disconnectedNoticeMode=terminal）。
        if (
          status === "disconnected" &&
          getSettings().terminal.disconnectedNoticeMode === "terminal" &&
          e.key === "Enter"
        ) {
          e.preventDefault();
          void connect();
          return;
        }
        // 逐片段快捷键（对照 Netcatty Snippet.shortkey）：仅命中本窗格焦点终端。
        if (status !== "connected" || snippets.length === 0) return;
        const hit = snippets.find((s) => {
          if (!s.shortkey.trim()) return false;
          const binding = parseShortkey(s.shortkey);
          return binding !== null && shortkeyMatches(binding, e);
        });
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();
        const vars = parseSnippetVariables(hit.command);
        if (vars.length > 0) {
          setSnippetVarPrompt({
            snippet: hit,
            values: Object.fromEntries(
              vars.map((v) => [v.name, v.defaultValue ?? ""]),
            ),
            mode: "send",
          });
          return;
        }
        insertSnippet(hit);
      }}
    >
      {/* 终端顶部工具栏（对照 netcatty TerminalToolbar / TerminalView 状态栏） */}
      <div
        className="term-toolbar"
        data-section="terminal-toolbar"
        data-session-id={sidRef.current ?? ""}
      >
        <div className="term-toolbar-left">
          <span className="term-toolbar-title" title={tab.title}>
            {tab.title}
          </span>
          {scriptRec && (
            <span
              className="term-recording-badge is-rec"
              title="脚本录制中：命令会被记录为脚本"
            >
              REC
            </span>
          )}
          {/* 图标集合与顺序来自 toolbarLayout（对照 Netcatty 状态栏）。 */}
          {resolveTerminalTitlebarActions(transportKind).map((action) => {
            switch (action) {
              case "copyHost":
                return (
                  <button
                    key={action}
                    className="term-tool-btn"
                    title={copyHostTitle}
                    disabled={!hostInfo.hostname}
                    onClick={() => {
                      void navigator.clipboard.writeText(hostInfo.hostname).then(() => {
                        setCopyHostTitle("已复制主机地址");
                        window.setTimeout(
                          () => setCopyHostTitle("复制主机地址"),
                          2000,
                        );
                      });
                    }}
                  >
                    <Icon name="copy" size={12} />
                  </button>
                );
              case "timestamps":
                return (
                  <button
                    key={action}
                    className={`term-tool-btn${showTimestamps ? " active" : ""}`}
                    title={showTimestamps ? "隐藏时间戳" : "显示时间戳"}
                    aria-pressed={showTimestamps}
                    onClick={() => {
                      const next = !showTimestamps;
                      setShowTimestamps(next);
                      persistShowTimestamps(next);
                    }}
                  >
                    <Icon name="clock" size={12} />
                  </button>
                );
              case "monitor":
                return systemEligible ? (
                  <div key={action} className="term-monitor-anchor">
                    <button
                      className={`term-tool-btn${monitorOpen ? " active" : ""}`}
                      disabled={!canMonitor}
                      title={
                        monitorDisabledReason
                          ? `系统监控（${monitorDisabledReason}）`
                          : "系统监控"
                      }
                      onClick={() => {
                        closeOtherToolbarPopovers("monitor");
                        setMonitorOpen((v) => !v);
                      }}
                    >
                      <Icon name="activity" size={12} />
                    </button>
                    {monitorOpen && monitorSid && (
                      <SessionMonitorPopover
                        sessionId={monitorSid}
                        onClose={() => setMonitorOpen(false)}
                      />
                    )}
                  </div>
                ) : null;
              case "disconnect":
                return (
                  <button
                    key={action}
                    className="term-tool-btn"
                    title="断开连接"
                    disabled={!canDisconnect}
                    onClick={() => disconnect()}
                  >
                    <Icon name="unplug" size={12} />
                  </button>
                );
              case "reconnect":
                return (
                  <button
                    key={action}
                    className="term-tool-btn"
                    title="重新连接当前会话"
                    disabled={!canReconnect}
                    onClick={() => {
                      void connect();
                    }}
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                );
              default:
                return null;
            }
          })}
        </div>
        <div className="term-toolbar-right">
          {/* 顺序与可见性全部来自 resolveTerminalToolbarActions，JSX 只按 id 渲染。 */}
          {toolbarActions.map((action) => {
            switch (action) {
              case "highlight":
                return (
                  <div key={action} className="term-tool-more">
                    <button
                      className="term-tool-btn"
                      title={TERMINAL_TOOLBAR_TEXT.highlight.title}
                      onClick={() => {
                        setHostHighlightError("");
                        setEditingRuleId(null);
                        setEditRuleError("");
                        closeOtherToolbarPopovers("highlight");
                        setHighlightOpen((v) => !v);
                      }}
                    >
                      <Icon name="highlighter" size={12} />
                    </button>
                    {highlightOpen && (
                      <div className="term-tool-menu term-highlight-menu">
                        <div className="term-highlight-header">
                          <span className="term-highlight-title">
                            {TERMINAL_TOOLBAR_TEXT.highlight.label}
                          </span>
                          <div className="term-highlight-switches">
                            <label className="term-highlight-enabled">
                              <span>{highlightUiEnabled ? "已启用" : "已禁用"}</span>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={highlightUiEnabled}
                                className={`term-highlight-toggle${highlightUiEnabled ? " on" : ""}`}
                                title="关键字高亮总开关"
                                onClick={() =>
                                  setHighlightMasterEnabled(!highlightUiEnabled)
                                }
                              >
                                <span />
                              </button>
                            </label>
                            <label className="term-highlight-enabled">
                              <span>仅显示匹配行</span>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={onlyMatchingLines && highlightUiEnabled}
                                disabled={!highlightUiEnabled}
                                className={`term-highlight-toggle${onlyMatchingLines && highlightUiEnabled ? " on" : ""}`}
                                title={
                                  highlightUiEnabled
                                    ? "类似 grep：只显示命中已启用规则的行（不影响日志录制）"
                                    : "先启用关键字高亮才能使用行过滤"
                                }
                                onClick={toggleOnlyMatchingLines}
                              >
                                <span />
                              </button>
                            </label>
                          </div>
                        </div>
                        {!sshProfileId && (
                          <div className="term-highlight-hint">
                            本类型终端没有主机级规则，这里编辑的是全局规则（同步到设置页）
                          </div>
                        )}
                        {editingRuleId ? (
                          <div className="term-highlight-editor">
                            <div className="term-highlight-editor-head">
                              <span className="term-highlight-editor-title">编辑规则</span>
                              <label className="term-highlight-enabled">
                                <span>{editRuleEnabled ? "启用" : "已停用"}</span>
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={editRuleEnabled}
                                  className={`term-highlight-toggle${editRuleEnabled ? " on" : ""}`}
                                  title={editRuleEnabled ? "点击停用该规则" : "点击启用该规则"}
                                  onClick={() => setEditRuleEnabled((v) => !v)}
                                >
                                  <span />
                                </button>
                              </label>
                            </div>
                            <input
                              className="term-highlight-edit-input"
                              value={editRuleLabel}
                              placeholder="规则名称"
                              onChange={(e) => {
                                setEditRuleLabel(e.target.value);
                                setEditRuleError("");
                              }}
                            />
                            <textarea
                              className={`term-highlight-edit-patterns${editRuleError ? " is-invalid" : ""}`}
                              value={editRulePatterns}
                              rows={3}
                              placeholder={"匹配内容（正则，每行一条）"}
                              onChange={(e) => {
                                setEditRulePatterns(e.target.value);
                                setEditRuleError("");
                              }}
                            />
                            <HighlightColorPicker
                              value={editRuleColor}
                              onChange={setEditRuleColor}
                            />
                            <HighlightRulePreview
                              label={editRuleLabel}
                              color={editRuleColor}
                              patterns={editRulePatterns
                                .split(/\r?\n/)
                                .map((pattern) => pattern.trim())
                                .filter(Boolean)}
                            />
                            {editRuleError && (
                              <div className="term-highlight-error">{editRuleError}</div>
                            )}
                            <div className="term-highlight-editor-actions">
                              <button
                                type="button"
                                className="term-highlight-cancel"
                                onClick={resetHighlightEditor}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="term-highlight-save"
                                onClick={saveEditedHighlightRule}
                              >
                                <Icon name="check" size={11} />
                                保存
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                        <div className="term-highlight-scroll">
                          {highlightUiRules.length === 0 ? (
                            <div className="term-highlight-empty">
                              {sshProfileId
                                ? "此主机未定义自定义高亮规则"
                                : "全局未定义高亮规则，可在下方添加"}
                            </div>
                          ) : (
                            highlightUiRules.map((rule) => (
                              <div
                                key={rule.id}
                                className={`term-highlight-row${rule.enabled ? "" : " is-off"}`}
                              >
                                <button
                                  type="button"
                                  role="checkbox"
                                  aria-checked={rule.enabled}
                                  className={`term-highlight-check${rule.enabled ? " on" : ""}`}
                                  title={rule.enabled ? "点击停用该规则" : "点击启用该规则"}
                                  onClick={() =>
                                    persistHostKeywordHighlight({
                                      rules: highlightUiRules.map((r) =>
                                        r.id === rule.id ? { ...r, enabled: !r.enabled } : r,
                                      ),
                                    })
                                  }
                                />
                                <button
                                  type="button"
                                  className="term-highlight-info"
                                  title="点击编辑名称、匹配内容、颜色与启用状态"
                                  onClick={() => beginEditHighlightRule(rule)}
                                >
                                  <span
                                    className="term-highlight-name"
                                    style={rule.enabled ? { color: rule.color } : undefined}
                                  >
                                    {rule.label}
                                  </span>
                                  <span className="term-highlight-pattern">
                                    {rule.patterns.join(", ")}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="term-highlight-edit"
                                  title="编辑该规则"
                                  onClick={() => beginEditHighlightRule(rule)}
                                >
                                  <Icon name="pencil" size={10} />
                                </button>
                                <button
                                  type="button"
                                  className="term-highlight-swatch"
                                  title={`编辑 ${rule.label} 的颜色`}
                                  aria-label={`编辑 ${rule.label} 的颜色`}
                                  onClick={() => beginEditHighlightRule(rule)}
                                >
                                  <span style={{ background: rule.color }} />
                                </button>
                                <button
                                  type="button"
                                  className="term-highlight-remove"
                                  title="移除该规则"
                                  onClick={() =>
                                    persistHostKeywordHighlight({
                                      rules: highlightUiRules.filter((r) => r.id !== rule.id),
                                    })
                                  }
                                >
                                  <Icon name="trash" size={10} />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                        <div className="term-highlight-add">
                          <div className="term-highlight-add-title">添加新规则</div>
                          <div className="term-highlight-add-row">
                            <input
                              value={hostHighlightLabel}
                              placeholder="标签（例如：错误）"
                              onChange={(e) => setHostHighlightLabel(e.target.value)}
                            />
                          </div>
                          <HighlightColorPicker
                            value={hostHighlightColor}
                            onChange={setHostHighlightColor}
                          />
                          <div className="term-highlight-add-row">
                            <input
                              value={hostHighlightPattern}
                              placeholder={"正则表达式（例如 \\bfailed\\b）"}
                              className={hostHighlightError ? "is-invalid" : undefined}
                              onChange={(e) => {
                                setHostHighlightPattern(e.target.value);
                                setHostHighlightError("");
                              }}
                            />
                            <button
                              type="button"
                              className="term-highlight-add-btn"
                              title="添加规则"
                              disabled={
                                !hostHighlightLabel.trim() || !hostHighlightPattern.trim()
                              }
                              onClick={addHostHighlightRule}
                            >
                              <Icon name="plus" size={12} />
                            </button>
                          </div>
                          <HighlightRulePreview
                            label={hostHighlightLabel}
                            color={hostHighlightColor}
                            patterns={hostHighlightPattern.trim() ? [hostHighlightPattern] : []}
                          />
                          {hostHighlightError && (
                            <div className="term-highlight-error">{hostHighlightError}</div>
                          )}
                        </div>
                          </>
                        )}
                        {highlightUiRules.length > 0 && (
                          <div className="term-highlight-footer">
                            <button
                              type="button"
                              className="term-highlight-clear"
                              onClick={() =>
                                persistHostKeywordHighlight({ rules: [], enabled: false })
                              }
                            >
                              <Icon name="rotate-ccw" size={10} />
                              清除全部
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              case "sftp":
                return (
                  <button
                    key={action}
                    className="term-tool-btn"
                    title={
                      status === "connected"
                        ? TERMINAL_TOOLBAR_TEXT.sftp.title
                        : "连接 SSH 后可用"
                    }
                    disabled={!onOpenTool || status !== "connected"}
                    onClick={() => onOpenTool?.("sftp")}
                  >
                    <Icon name="folder-input" size={12} />
                  </button>
                );
              case "panel":
                return (
                  <button
                    key={action}
                    className={`term-tool-btn${sidePanelOpen ? " active" : ""}`}
                    title={
                      sidePanelOpen
                        ? "收起主机右侧栏"
                        : TERMINAL_TOOLBAR_TEXT.panel.title
                    }
                    aria-pressed={sidePanelOpen}
                    disabled={!onToggleSidePanel}
                    onClick={() => onToggleSidePanel?.()}
                  >
                    <PanelRight size={12} />
                  </button>
                );
              case "compose":
                return (
                  <button
                    key={action}
                    className={`term-tool-btn${composeOpen ? " active" : ""}`}
                    title={TERMINAL_TOOLBAR_TEXT.compose.title}
                    aria-pressed={composeOpen}
                    onClick={() => setComposeOpen((v) => !v)}
                  >
                    <Icon name="text-cursor" size={12} />
                  </button>
                );
              case "search":
                return (
                  <button
                    key={action}
                    className={`term-tool-btn${searchOpen ? " active" : ""}`}
                    title={TERMINAL_TOOLBAR_TEXT.search.title}
                    disabled={status !== "connected"}
                    onClick={() => setSearchOpen((v) => !v)}
                  >
                    <Icon name="search" size={12} />
                  </button>
                );
              case "sessionLog": {
                const title = `${sessionLog ? "停止" : "开始"}${TERMINAL_TOOLBAR_TEXT.sessionLog.title}`;
                return (
                  // 四种传输都挂了文本日志槽：自动录制（.log）与手动日志共用同一槽。
                  <button
                    key={action}
                    className={`term-tool-btn${sessionLog ? " recording" : ""}`}
                    disabled={status !== "connected" || logBusy}
                    title={title}
                    aria-label={title}
                    aria-pressed={sessionLog !== null}
                    onClick={() => void toggleManualSessionLog()}
                  >
                    <Icon name="file-text" size={12} />
                    {sessionLog && (
                      <span className="term-log-dot" aria-hidden="true" />
                    )}
                  </button>
                );
              }
              case "scripts":
                return (
                  <div key={action} className="term-tool-more">
                    <button
                      className="term-tool-btn"
                      title={
                        scriptSnippets.length > 0
                          ? TERMINAL_TOOLBAR_TEXT.scripts.title
                          : "暂无脚本（到「脚本」页新建，类型选脚本）"
                      }
                      disabled={scriptSnippets.length === 0}
                      onClick={() => {
                        closeOtherToolbarPopovers("scripts");
                        setScriptMenuOpen((v) => !v);
                      }}
                    >
                      <Icon name="zap" size={12} />
                    </button>
                    {scriptMenuOpen && (
                      <div className="term-tool-menu term-snippet-menu">
                        <div className="term-menu-label">
                          {TERMINAL_TOOLBAR_TEXT.scripts.label}
                        </div>
                        {scriptSnippets.map((s) => (
                          <button
                            key={s.id || s.name}
                            title={s.description || s.command.split(/\r?\n/)[0]}
                            disabled={status !== "connected"}
                            onClick={() => {
                              insertSnippet(s);
                              setScriptMenuOpen(false);
                            }}
                          >
                            <Icon name="play" size={12} />
                            {s.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              default:
                return null;
            }
          })}
          <div className="term-tool-more">
            <button
              className="term-tool-btn"
              title="更多"
              onClick={() => {
                closeOtherToolbarPopovers("more");
                setMoreOpen((v) => {
                  // 每次重新打开都收起二级菜单，和 Netcatty 的 Popover 一致。
                  if (!v) setEncodingMenuOpen(false);
                  return !v;
                });
              }}
            >
              <Icon name="more-vertical" size={12} />
            </button>
            {moreOpen && (
              <div className="term-tool-menu term-more-menu">
                {/* 顺序与可见性由 resolveTerminalMoreActions 派生。 */}
                {moreActions.map((action) => {
                  switch (action) {
                    case "history":
                      return (
                        <button
                          key={action}
                          title={moreHistoryReason ?? TERMINAL_MORE_TEXT.history.title}
                          disabled={moreHistoryReason !== null}
                          onClick={() => {
                            setMoreOpen(false);
                            // 对齐 Netcatty handleOpenHistory：直接打开右侧栏 history 视图，
                            // 不再弹悬浮窗；已在该视图时保持打开（不关闭）。
                            onOpenTool?.("history");
                          }}
                        >
                          <Icon name="history" size={12} />
                          <span className="term-menu-text">
                            {TERMINAL_MORE_TEXT.history.label}
                          </span>
                          {moreHistoryReason !== null && (
                            <span className="term-menu-note">{moreHistoryReason}</span>
                          )}
                        </button>
                      );
                    case "osc7":
                      return (
                        <button
                          key={action}
                          title={
                            moreOsc7Reason !== null
                              ? `${TERMINAL_MORE_TEXT.osc7.title} · ${moreOsc7Reason}`
                              : cwdTracked
                                ? `${TERMINAL_MORE_TEXT.osc7.title}（已启用：${cwd ?? "未知目录"}）`
                                : TERMINAL_MORE_TEXT.osc7.title
                          }
                          disabled={moreOsc7Reason !== null}
                          onClick={() => {
                            setOsc7DialogOpen(true);
                            setMoreOpen(false);
                          }}
                        >
                          <Icon name="folder-sync" size={12} />
                          <span className="term-menu-text">
                            {TERMINAL_MORE_TEXT.osc7.label}
                          </span>
                          {moreOsc7Reason !== null ? (
                            <span className="term-menu-note">{moreOsc7Reason}</span>
                          ) : (
                            cwdTracked && <span className="term-menu-note">已启用</span>
                          )}
                        </button>
                      );
                    case "terminalSettings":
                      return (
                        <button
                          key={action}
                          title={
                            onOpenSettings
                              ? TERMINAL_MORE_TEXT.terminalSettings.title
                              : "终端设置暂不可用"
                          }
                          disabled={!onOpenSettings}
                          onClick={() => {
                            setMoreOpen(false);
                            onOpenSettings?.();
                          }}
                        >
                          <Icon name="palette" size={12} />
                          <span className="term-menu-text">
                            {TERMINAL_MORE_TEXT.terminalSettings.label}
                          </span>
                        </button>
                      );
                    case "recording": {
                      const recordingText = terminalRecordingText(scriptRec);
                      return (
                        <button
                          key={action}
                          title={moreRecordingReason ?? recordingText.title}
                          disabled={moreRecordingReason !== null || scriptRecBusy}
                          className={scriptRec ? "is-recording" : undefined}
                          onClick={() => {
                            setMoreOpen(false);
                            void toggleScriptRecording();
                          }}
                        >
                          <Icon name="circle" size={12} className="term-record-dot" />
                          <span className="term-menu-text">{recordingText.label}</span>
                          {moreRecordingReason !== null && (
                            <span className="term-menu-note">{moreRecordingReason}</span>
                          )}
                        </button>
                      );
                    }
                    case "encoding":
                      return (
                        <div
                          key={action}
                          className={`term-menu-sub${encodingMenuOpen ? " open" : ""}`}
                        >
                          <button
                            title={
                              moreEncodingReason !== null
                                ? `${TERMINAL_MORE_TEXT.encoding.title} · ${moreEncodingReason}`
                                : `${TERMINAL_MORE_TEXT.encoding.title}（当前 ${terminalEncodingLabel(encoding)}）`
                            }
                            disabled={moreEncodingReason !== null}
                            className={encodingMenuOpen ? "open" : undefined}
                            onClick={() => setEncodingMenuOpen((v) => !v)}
                          >
                            <Icon name="languages" size={12} />
                            <span className="term-menu-text">
                              {TERMINAL_MORE_TEXT.encoding.label}
                            </span>
                            {moreEncodingReason !== null ? (
                              <span className="term-menu-note">{moreEncodingReason}</span>
                            ) : (
                              <span className="term-menu-note">
                                {encoding === "utf-8" ? "UTF-8" : "GB18030"}
                              </span>
                            )}
                            {moreEncodingReason === null && (
                              <Icon
                                name={encodingMenuOpen ? "chevron-down" : "chevron-right"}
                                size={12}
                                className="term-menu-caret"
                              />
                            )}
                          </button>
                          {encodingMenuOpen && moreEncodingReason === null && (
                            <div className="term-menu-sub-list">
                              {(["utf-8", "gb18030"] as TerminalEncoding[]).map((value) => (
                                <button
                                  key={value}
                                  className={encoding === value ? "active" : undefined}
                                  title={
                                    value === "utf-8"
                                      ? "UTF-8（默认）"
                                      : "GB18030（GBK / GB2312 兼容）"
                                  }
                                  onClick={() => {
                                    setEncoding(value);
                                    setEncodingMenuOpen(false);
                                    setMoreOpen(false);
                                    controllerRef.current?.term.focus();
                                  }}
                                >
                                  <span className="term-menu-check">
                                    {encoding === value && <Icon name="check" size={12} />}
                                  </span>
                                  <span className="term-menu-text">
                                    {value === "utf-8" ? "UTF-8" : "GB18030"}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    default:
                      return null;
                  }
                })}
              </div>
            )}
          </div>
          <button
            className="term-tool-btn term-tool-close"
            title="关闭当前窗格"
            disabled={!onClosePane}
            onClick={() => onClosePane?.()}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="term-search-bar">
          <Icon name="search" size={12} />
          <input
            ref={searchInputRef}
            autoFocus
            value={searchQuery}
            placeholder="在终端中查找（Enter 下一个 / Shift+Enter 上一个）"
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") setSearchOpen(false);
            }}
          />
          <span className="term-search-count">
            {searchQuery
              ? searchCount === 0
                ? "无结果"
                : `${searchIndex} / ${searchCount}`
              : ""}
          </span>
          <button
            className="term-search-btn"
            title="上一个"
            onClick={() => runSearch(-1)}
          >
            上一个
          </button>
          <button
            className="term-search-btn"
            title="下一个"
            onClick={() => runSearch(1)}
          >
            下一个
          </button>
          <button
            className="term-search-btn"
            title="关闭搜索"
            onClick={() => setSearchOpen(false)}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      <TerminalView
        showTimestamps={showTimestamps}
        onFindShortcut={() => {
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
        }}
        onReady={(c) => {
          controllerRef.current = c;
          // SearchAddon 的命中数事件：驱动「第 n / 共 m 处」显示。
          c.search.onDidChangeResults(({ resultIndex, resultCount }) => {
            setSearchCount(resultCount);
            setSearchIndex(resultIndex >= 0 ? resultIndex + 1 : 0);
          });
          if (!startedRef.current) {
            startedRef.current = true;
            void connect();
          }
        }}
        onData={(data) => {
          const consumedByAutocomplete = handleAutocompleteInput(data);
          handleTerminalInput(data);
          if (!consumedByAutocomplete) transportRef.current?.write(data);
        }}
        onResize={(cols, rows) => transportRef.current?.resize(cols, rows)}
        onOsc7={handleOsc7}
      />

      {autocompleteUi?.popup && (() => {
        const { anchor, suggestions, selected, subPanels, subFocus } = autocompleteUi;
        const placement = computeAutocompletePopupPlacement({
          anchorTop: anchor.top,
          anchorBottom: anchor.top + anchor.cellH,
          anchorLeft: anchor.left,
          paneWidth: anchor.paneWidth,
          paneHeight: anchor.paneHeight,
          itemCount: suggestions.length,
          subPanelCount: subPanels.length,
        });
        const badgeFor = (suggestion: AutocompleteSuggestion) =>
          suggestion.source === "history" ? "h" : suggestion.source === "command" ? "c" : null;
        return (
          <div
            className={`term-autocomplete-popup${placement.renderUpward ? " upward" : ""}`}
            style={{ left: placement.left, top: placement.top }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div
              className="term-autocomplete-list"
              style={{ width: placement.width, maxHeight: placement.maxHeight }}
            >
              {suggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.source}-${suggestion.command}`}
                  type="button"
                  className={`term-autocomplete-row${
                    index === selected ? " selected" : ""
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectAutocompleteIndex(index);
                  }}
                >
                  {suggestion.source === "path" ? (
                    <span
                      className={`term-autocomplete-icon ${
                        suggestion.fileType ?? "file"
                      }`}
                    >
                      <Icon
                        name={
                          suggestion.fileType === "directory"
                            ? "folder"
                            : suggestion.fileType === "symlink"
                              ? "link"
                              : "file"
                        }
                        size={14}
                      />
                    </span>
                  ) : (
                    <span
                      className={`term-autocomplete-badge ${
                        suggestion.source === "history" ? "history" : "command"
                      }`}
                    >
                      {badgeFor(suggestion)}
                    </span>
                  )}
                  <span className="term-autocomplete-command">
                    {suggestion.display ?? suggestion.command}
                  </span>
                  {suggestion.description ? (
                    <span className="term-autocomplete-desc">{suggestion.description}</span>
                  ) : null}
                  {suggestion.fileType === "directory" ? (
                    <span className="term-autocomplete-arrow">
                      <Icon name="chevron-right" size={12} />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            {subPanels.map((panel, level) => (
              <div
                key={`${panel.dirPath}-${level}`}
                className={`term-autocomplete-list term-autocomplete-sub${
                  level === subFocus ? " focused" : ""
                }`}
                style={{
                  width: placement.subPanelWidth,
                  // 每级子面板按自身条目数取高度，避免主列表很短时子面板只剩一行。
                  maxHeight: Math.min(
                    placement.maxHeight,
                    Math.max(28, panel.entries.length * 28 + 8),
                  ),
                }}
              >
                {panel.entries.map((entry, index) => (
                  <button
                    key={entry.name}
                    type="button"
                    className={`term-autocomplete-row${
                      index === panel.selected ? " selected" : ""
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectAutocompleteSubIndex(level, index);
                    }}
                  >
                    <span className={`term-autocomplete-icon ${entry.type}`}>
                      <Icon
                        name={
                          entry.type === "directory"
                            ? "folder"
                            : entry.type === "symlink"
                              ? "link"
                              : "file"
                        }
                        size={14}
                      />
                    </span>
                    <span className="term-autocomplete-command">
                      {entry.name}
                      {entry.type === "directory" ? "/" : ""}
                    </span>
                    {entry.type === "directory" ? (
                      <span className="term-autocomplete-arrow">
                        <Icon name="chevron-right" size={12} />
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        );
      })()}

      {autocompleteUi?.ghost && (
        <div
          className="term-autocomplete-ghost"
          style={{
            left: autocompleteUi.anchor.left,
            top: autocompleteUi.anchor.top,
            height: autocompleteUi.anchor.cellH,
            lineHeight: `${autocompleteUi.anchor.cellH}px`,
            fontFamily: autocompleteUi.anchor.fontFamily,
            fontSize: autocompleteUi.anchor.fontSize,
          }}
          aria-hidden
        >
          {autocompleteUi.ghost}
        </div>
      )}

      {composeOpen && (
        <ComposeBar
          value={composeText}
          onChange={setComposeText}
          onSend={sendCompose}
          history={composeHistory}
          connected={status === "connected"}
          snippets={snippets}
          onRunSnippet={insertSnippet}
          onSnippetVariables={(snippet, mode) => {
            const vars = parseSnippetVariables(snippet.command);
            setSnippetVarPrompt({
              snippet,
              values: Object.fromEntries(
                vars.map((v) => [v.name, v.defaultValue ?? ""]),
              ),
              mode,
            });
          }}
          onClose={() => {
            setComposeOpen(false);
            controllerRef.current?.term.focus();
          }}
        />
      )}

      {zmodemDragActive && (
        <div className="term-zmodem-drop-mask">松开以上传文件（ZMODEM rz）</div>
      )}
      {zmodemState && (
        <div
          className={`term-zmodem-status${
            zmodemState.phase === "error" ? " error" : ""
          }`}
          role="status"
        >
          {zmodemStatusText(zmodemState)}
        </div>
      )}

      {osc7DialogOpen && (
        <div className="modal-mask" onClick={() => setOsc7DialogOpen(false)}>
          <div
            className="modal term-osc7-modal"
            role="dialog"
            aria-label="配置目录追踪"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>配置目录追踪</h3>
            <p className="term-osc7-desc">
              termX 会为当前远端用户添加 OSC 7 提示符配置，让终端持续上报当前目录。
              与 Netcatty 一致，写入后会立即重载 shell 钩子。
            </p>
            <div className="term-menu-label">可能写入的文件</div>
            <div className="term-osc7-targets">
              <span>~/.bashrc</span>
              <span>{"${ZDOTDIR:-~}/.zshrc"}</span>
              <span>~/.config/fish/config.fish</span>
            </div>
            <div className="term-menu-label">将执行的命令</div>
            <pre className="term-osc7-command">{buildOsc7SetupPlan().command}</pre>
            <div className="modal-actions">
              <button onClick={() => setOsc7DialogOpen(false)}>取消</button>
              <button
                className="term-osc7-run"
                disabled={osc7Busy}
                onClick={() => void runOsc7Setup()}
              >
                {osc7Busy ? "正在配置..." : "执行配置"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showConnectionDialog && (
        <TerminalConnectionDialog
          host={hostInfo}
          status={status}
          error={error}
          progressValue={progressValue}
          chainProgress={chainProgress}
          needsAuth={needsAuth}
          showLogs={showLogs}
          setShowLogs={setShowLogs}
          authProps={{
            authMethod,
            setAuthMethod,
            authUsername,
            setAuthUsername,
            authPassword,
            setAuthPassword,
            authKeyId,
            setAuthKeyId,
            authPassphrase,
            setAuthPassphrase,
            showAuthPassphrase,
            setShowAuthPassphrase,
            showAuthPassword,
            setShowAuthPassword,
            authRetryMessage,
            keys,
            onSubmit: submitAuthAndSave,
            onSubmitWithoutSave: submitAuth,
            onCancel: handleCancelConnect,
            isValid: authValid,
          }}
          onDismissDisconnected={handleDismissDisconnected}
          showEnterReconnectHint={status === "disconnected"}
          hostKeyVerification={
            hostKeyInfo
              ? {
                  hostKeyInfo,
                  onClose: handleHostKeyClose,
                  onContinue: handleHostKeyContinue,
                  onAddAndContinue: handleHostKeyAddAndContinue,
                }
              : undefined
          }
          progressProps={{
            timeLeft,
            isAwaitingUserInput,
            isCancelling,
            progressLogs,
            onCancelConnect: handleCancelConnect,
            onCloseSession: handleCloseSession,
            onRetry: () => void connect(),
          }}
        />
      )}

      {!isSsh && status === "connecting" && (
        <div className="pane-badge">连接中…</div>
      )}

      {!isSsh &&
        status === "disconnected" &&
        getSettings().terminal.disconnectedNoticeMode === "dialog" && (
          <div className="pane-overlay" onContextMenu={openContextMenu}>
            <div className="pane-overlay-title">会话已结束</div>
            {error && <div className="pane-overlay-detail">{error}</div>}
            <button onClick={() => void connect()} className="pane-reconnect">
              重连
            </button>
          </div>
        )}

      {/* 右键菜单（对照 netcatty TerminalContextMenu） */}
      {menu && (
        <>
          <div
            className="term-menu-mask"
            onMouseDown={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              // 长按刚弹过菜单时，松手产生的 contextmenu 落在遮罩上；此时
              // 不能立刻关闭，否则长按菜单一点就闪没。
              if (longPressOpenedRef.current) return;
              closeMenu();
            }}
          />
          <div
            className="term-context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* 菜单项与顺序由 contextMenuLayout 派生（对照 Netcatty TerminalContextMenu）。 */}
            {resolveTerminalContextMenu({
              connected: status === "connected",
              status,
              hasSelection: menu.selection.length > 0,
              showSftp: toolbarActions.includes("sftp"),
              canSplit: Boolean(onSplit),
              canClosePane: Boolean(onClosePane),
            }).map((spec) => {
              if (spec.kind === "separator") {
                return <div key={spec.id} className="term-menu-sep" />;
              }
              const onSelect = () => {
                switch (spec.action) {
                  case "copy":
                    void navigator.clipboard.writeText(menu.selection);
                    break;
                  case "paste":
                    void pasteFromClipboard();
                    break;
                  case "selectAll":
                    controllerRef.current?.term.selectAll();
                    break;
                  case "openSftp":
                    onOpenTool?.("sftp");
                    break;
                  case "reconnect":
                    void connect();
                    break;
                  case "splitHorizontal":
                    onSplit?.("horizontal");
                    break;
                  case "splitVertical":
                    onSplit?.("vertical");
                    break;
                  case "clearBuffer":
                    controllerRef.current?.term.clear();
                    break;
                  case "closeTerminal":
                    onClosePane?.();
                    break;
                }
                closeMenu();
              };
              return (
                <button
                  key={spec.action}
                  disabled={spec.disabled}
                  className={spec.danger ? "danger" : undefined}
                  onClick={onSelect}
                >
                  <Icon name={spec.icon} size={14} />
                  {TERMINAL_CONTEXT_MENU_TEXT[spec.action]}
                  {/* Netcatty 在此展示快捷键；termX 尚未分发这些绑定（仅列表/设置页展示），
                      按 Pr3 不渲染不生效的提示，待热键分发接线后恢复。 */}
                </button>
              );
            })}
          </div>
        </>
      )}

      {prompt && (
        <div className="modal-mask" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal">
            {prompt.kind === "auth" && (
              <>
                <h3>键盘交互认证</h3>
                {prompt.payload.name && (
                  <div className="prompt-name">{prompt.payload.name}</div>
                )}
                {prompt.payload.instructions && (
                  <pre className="prompt-instructions">
                    {prompt.payload.instructions}
                  </pre>
                )}
                {prompt.payload.prompts.map((p, i) => (
                  <label key={i}>
                    {p.prompt}
                    <input
                      type={p.echo ? "text" : "password"}
                      value={answers[i] ?? ""}
                      autoFocus={i === 0}
                      onChange={(e) =>
                        setAnswers((cur) => {
                          const next = [...cur];
                          next[i] = e.target.value;
                          return next;
                        })
                      }
                    />
                  </label>
                ))}
                <div className="modal-actions">
                  <button onClick={() => void respondAuth()} disabled={busy}>
                    确定
                  </button>
                  <button onClick={() => void cancelPrompt()} disabled={busy}>
                    取消
                  </button>
                </div>
              </>
            )}

            {prompt.kind === "passphrase" && (
              <>
                <h3>私钥口令</h3>
                <div className="prompt-instructions">{prompt.payload.prompt}</div>
                <label>
                  口令
                  <input
                    type="password"
                    autoFocus
                    value={answers[0] ?? ""}
                    onChange={(e) => setAnswers([e.target.value])}
                  />
                </label>
                <div className="modal-actions">
                  <button
                    onClick={() => void respondPassphrase()}
                    disabled={busy}
                  >
                    确定
                  </button>
                  <button onClick={() => void cancelPrompt()} disabled={busy}>
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {snippetVarPrompt && (
        <div className="modal-mask" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal">
            <h3>填写变量</h3>
            {Object.entries(snippetVarPrompt.values).map(([name, value], i) => (
              <label key={name}>
                {name}
                <input
                  type="text"
                  autoFocus={i === 0}
                  value={value}
                  onChange={(e) =>
                    setSnippetVarPrompt((cur) =>
                      cur
                        ? {
                            ...cur,
                            values: { ...cur.values, [name]: e.target.value },
                          }
                        : cur,
                    )
                  }
                />
              </label>
            ))}
            <div className="modal-actions">
              <button onClick={submitSnippetVarPrompt}>
                {snippetVarPrompt.mode === "insert" ? "插入" : "运行"}
              </button>
              <button onClick={() => setSnippetVarPrompt(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
