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

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { TerminalView, type TerminalController } from "./Terminal";
import { Icon } from "./ui/icons";
import * as api from "./backend/client";
import {
  SNIPPETS_CHANGED_EVENT,
  isScriptSnippet,
  parseShortkey,
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
import { getSettings } from "./settings/settingsStore";
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
  supportsEncodingSwitch,
  terminalEncodingLabel,
  type TerminalDecoder,
  type TerminalEncoding,
} from "./terminal/terminalEncoding";
import {
  createZmodemController,
  type ZmodemController,
  type ZmodemEvent,
} from "./terminal/zmodem";

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

type PaneStatus = "connecting" | "connected" | "disconnected";

type Prompt =
  | { kind: "auth"; sessionId: string; payload: AuthPrompt }
  | { kind: "passphrase"; sessionId: string; payload: { prompt: string } };

/** 窗格对外的句柄：供工作区切换活动窗格并订阅读话状态。 */
export interface PaneHandle {
  paneId: string;
  /** 本窗格 SSH 会话 id；非 SSH 或未连接为 null。 */
  sshSessionId: () => string | null;
  /** 订阅 SSH 会话变化（连接 / 断开时回调）。 */
  subscribeSession: (cb: (sid: string | null) => void) => () => void;
  /** 重新连接当前窗格（对齐 Netcatty 标签右键「重连」）。 */
  reconnect: () => void;
  focus: () => void;
  /** 本窗格是否已连接（脚本页运行按钮据此置灰）。 */
  connected: () => boolean;
  /** 运行片段 / 脚本：复用终端右键插入同一发送链路；未连接返回 false。 */
  runSnippet: (snippet: api.Snippet) => boolean;
  /** 停止脚本：发送 Ctrl-C（SIGINT）并清空逐行待发送队列。 */
  interrupt: () => boolean;
  /** 暂停：发送 Ctrl-Z（SIGTSTP），仅对被 Ctrl-Z 挂起的前台任务有意义。 */
  suspend: () => boolean;
  /** 恢复：发送 fg + 回车。 */
  resume: () => boolean;
}

interface Props {
  tab: Tab;
  paneId: string;
  active: boolean;
  onActivate: () => void;
  onRegister: (paneId: string, handle: PaneHandle | null) => void;
  onStatus: (text: string) => void;
  /** 打开右侧工具面板（SFTP / 端口转发）。 */
  onOpenTool?: (tool: "sftp" | "forward") => void;
  /** 关闭当前窗格。 */
  onClosePane?: () => void;
  /** 分屏（在当前标签内）。 */
  onSplit?: (dir: "horizontal" | "vertical") => void;
  /** 打开设置中心（「更多」→ 终端设置）。 */
  onOpenSettings?: () => void;
}

const AUTH_RETRY_MESSAGE = "身份验证失败。请检查凭据后重试。";
const PROGRESS_ATTEMPT_TIMEOUT_MESSAGE = "连接超时，请重试。";

/** 会话日志默认文件名时间戳：对齐 Netcatty `YYYY-MM-DDTHH-mm-ss`。 */
function safeFileStem(title: string): string {
  const stem = title.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "");
  return stem || "session";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function timestampSuffix(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(
    now.getHours(),
  )}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
}

function clockLabel(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

export function TerminalPane({
  tab,
  paneId,
  active,
  onActivate,
  onRegister,
  onStatus,
  onOpenTool,
  onClosePane,
  onSplit,
  onOpenSettings,
}: Props) {
  const isSsh = tab.connector.kind === "ssh";
  const sshProfileId = tab.connector.kind === "ssh" ? tab.connector.profileId : null;

  const [status, setStatus] = useState<PaneStatus>("connecting");
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
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** ZMODEM 传输提示（检测 / 进度 / 完成 / 错误），空闲为 null。 */
  const [zmodemState, setZmodemState] = useState<ZmodemEvent | null>(null);
  /** 文件拖拽悬停在终端上时显示投放蒙层。 */
  const [zmodemDragActive, setZmodemDragActive] = useState(false);
  /**
   * 终端编码（Netcatty `encoding`）：按主机记住选择，输出用 TextDecoder
   * 解码、输入交给后端重编码。与日志/录制无关，独立于会话生命周期。
   */
  const [encoding, setEncoding] = useState<TerminalEncoding>(() =>
    loadTerminalEncoding(sshProfileId),
  );
  const encodingRef = useRef<TerminalEncoding>(encoding);
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
   * 手动文本会话日志（Netcatty `sessionLog`）：后端把输出写进用户选的文本文件。
   * 与「开始录制」（脚本录制）是两套独立能力，互不共享状态与产物。
   */
  const [sessionLog, setSessionLog] = useState<api.ManualSessionLogStatus | null>(
    null,
  );
  const [logBusy, setLogBusy] = useState(false);
  /** 脚本录制（Netcatty `recording`）：记录输入命令，停止后生成脚本片段。 */
  const [scriptRec, setScriptRec] = useState(false);
  const [scriptRecBusy, setScriptRecBusy] = useState(false);
  /** 本会话已提交的命令（命令历史 popover）。 */
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 撰写栏 / 终端搜索 / 主机关键词高亮。 */
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCount, setSearchCount] = useState(0);
  const [searchIndex, setSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const [highlightDraft, setHighlightDraft] = useState("");
  const [highlightRules, setHighlightRules] = useState<
    { id: string; keyword: string; color: string }[]
  >([]);
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
   * 连接建立后拉取一次「手动文本会话日志」状态。它与 asciicast 自动录制
   * （settings.recording_enabled）无关：自动录制仍写 .cast 进「日志」页，
   * 手动会话日志写用户选择的文本文件。断开即清空，并结束脚本录制。
   */
  useEffect(() => {
    const sid = status === "connected" && isSsh ? sidRef.current : null;
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
    saveTerminalEncoding(sshProfileId, encoding);
  }, [encoding, sshProfileId]);

  /** 「更多」菜单点外部关闭（对齐 Netcatty Popover 的 dismiss 行为）。 */
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".term-tool-more")) return;
      setMoreOpen(false);
      setEncodingMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  /** 目录追踪只在活动 SSH 会话上有意义；断开后清空。 */
  useEffect(() => {
    if (status !== "connected") {
      setCwd(null);
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
    setCwd(path);
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

  /** 直通字节 → 终端（ZMODEM 非协议输出、串口原始字节共用）。 */
  function writeTerminalText(bytes: Uint8Array) {
    const term = controllerRef.current?.term;
    if (!term) return;
    if (transportRef.current?.kind === "serial") {
      term.write(bytes);
      return;
    }
    const text = decoderRef.current.decode(bytes);
    if (text) {
      term.write(text);
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

  /** 输入缓冲：命令历史与脚本录制共用；开始录制时清空步数。 */
  const inputBufferRef = useRef<ScriptRecordingBuffer>(createScriptRecordingBuffer());

  /**
   * 工具栏「会话日志」（file-text）：Netcatty 语义 = 手动文本日志。
   * 未录制时先弹保存对话框选目标路径，再开始写；录制中点击则停止。
   * 与「开始录制」（脚本录制）完全独立，不再共享录制槽。
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
      // Netcatty 默认：格式 txt（去 ANSI）、时间戳关闭、扩展名 .txt。
      const defaultName = `${safeFileStem(tab.title)}_${timestampSuffix(new Date())}.txt`;
      const path = await api.pickManualSessionLogPath(defaultName, "txt");
      if (!path) return;
      const rec = await api.startManualSessionLog(sid, path, "txt", false);
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

  /** 终端输入：命令历史 + 脚本录制缓冲。 */
  function handleTerminalInput(data: string) {
    const submitted = appendKeystrokes(inputBufferRef.current, data, Date.now());
    if (submitted) {
      setCommandHistory((prev) => [...prev, submitted.command].slice(-200));
    }
    // 未录制时只保留最近 200 条，避免长时间使用会累积到内存。
    if (!scriptRec && inputBufferRef.current.steps.length > 200) {
      inputBufferRef.current.steps = inputBufferRef.current.steps.slice(-200);
    }
  }

  /** 撰写栏发送：整段写入当前会话，末尾补回车。 */
  function sendCompose() {
    if (status !== "connected") return;
    const text = composeText.replace(/\r\n/g, "\n");
    if (!text.trim()) return;
    writeToPane(`${text}\r`);
    setComposeText("");
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

  /** 关键词高亮：在写入解析后扫描新增行，用 xterm decoration 铺底色。 */
  useEffect(() => {
    const term = controllerRef.current?.term;
    if (!term || highlightRules.length === 0) return;
    // registerDecoration 属于 proposed API。
    term.options.allowProposedApi = true;
    // 首次扫描当前缓冲区全部行；之后只扫新增行（lastLine 始终是未扫描的
    // 起点），避免每轮重扫末行造成同一行重复注册 decoration。
    let lastLine = 0;
    const decorations: { dispose: () => void }[] = [];
    const scan = () => {
      const buf = term.buffer.active;
      const cursorLine = buf.baseY + buf.cursorY;
      for (let y = lastLine; y < buf.length; y += 1) {
        const text = buf.getLine(y)?.translateToString(true) ?? "";
        const rule = highlightRules.find((r) =>
          text.toLowerCase().includes(r.keyword.toLowerCase()),
        );
        if (!rule) continue;
        const marker = term.registerMarker(y - cursorLine);
        if (!marker) continue;
        const decoration = term.registerDecoration({
          marker,
          width: term.cols,
          backgroundColor: rule.color,
        });
        decorations.push({
          dispose: () => {
            decoration?.dispose();
            marker.dispose();
          },
        });
      }
      lastLine = buf.length;
      // 长会话里行数无限增长，限定保留最近 500 个装饰器，超出即释放最旧的。
      while (decorations.length > 500) {
        decorations.shift()?.dispose();
      }
    };
    const sub = term.onWriteParsed(scan);
    scan();
    return () => {
      sub.dispose();
      decorations.forEach((d) => d.dispose());
    };
  }, [highlightRules]);

  /** 脚本下拉菜单（终端工具栏「脚本」按钮）。 */
  const [scriptMenuOpen, setScriptMenuOpen] = useState(false);
  const scriptSnippets = snippets.filter(isScriptSnippet);

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
  const transportRef = useRef<TerminalTransport | null>(null);
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
      reconnect: () => {
        if (aliveRef.current) void connectRef.current();
      },
      focus: () => {
        if (aliveRef.current) controllerRef.current?.term.focus();
      },
      connected: () => transportRef.current !== null,
      runSnippet: (snippet) => runSnippetRef.current(snippet),
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
    };
    onRegister(paneId, handle);
    return () => {
      onRegister(paneId, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, tab.connector.kind]);

  useEffect(() => {
    if (active) controllerRef.current?.term.focus();
  }, [active]);

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

  async function wire(domain: TerminalDomain, sid: string) {
    const transport: TerminalTransport = {
      kind: domain,
      write: (text) =>
        void (domain === "pty"
          ? api.ptyWrite(sid, text)
          : api.sshWrite(sid, text, encodingRef.current)),
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

  /** 连接成功后按设置自动打开侧边栏（termX 目前仅支持 SFTP 面板）。 */
  function maybeAutoOpenSidePanel() {
    const s = getSettings();
    if (!s.sidePanelAutoOpen) return;
    if (s.sidePanelAutoOpenPane === "sftp") onOpenTool?.("sftp");
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
          await api.onSerialData(sid, (bytes) =>
            controllerRef.current?.term.write(bytes),
          ),
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
        const actual = await api.serialOpen(conn.session.port, conn.session.config, sid);
        if (!aliveRef.current || attempt !== attemptRef.current) {
          void api.serialClose(actual);
          return;
        }
        transportRef.current = {
          kind: "serial",
          write: (text) => {
            const chunk = input.feed(text);
            if (chunk.echo) {
              controllerRef.current?.term.write(new TextEncoder().encode(chunk.echo));
            }
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
              if (echo) {
                controllerRef.current?.term.write(new TextEncoder().encode(echo));
              }
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
  // 系统监控只出现在远端 SSH 会话（netcatty isSystemSidebarEligible 排除本地 / 串口 / Telnet）
  const systemEligible = tab.connector.kind === "ssh";

  /**
   * 「更多」菜单的可用条件与置灰原因（对照 Netcatty TerminalToolbar）：
   * - 命令历史：SSH 且已连接（Netcatty 排除本地 / 串口 / Telnet）；
   * - 目录追踪：SSH 且已连接（依赖 OSC 7 + exec 通道）；
   * - 终端设置：始终可用（设置中心入口）；
   * - 录制：SSH 且已连接（脚本录制读取 SSH 会话输入）；
   * - 终端编码：SSH / Telnet 且已连接；串口在连接表单中固定、本地沿用系统编码。
   * 做不出的项不删除，只置灰并在行内 + 悬停写明原因。
   */
  const transportKind = tab.connector.kind;
  const moreHistoryReason =
    transportKind !== "ssh"
      ? "仅 SSH 会话"
      : status !== "connected"
        ? "连接后可用"
        : null;
  const moreOsc7Reason = moreHistoryReason;
  const moreRecordingReason = moreHistoryReason;
  const moreEncodingReason =
    !supportsEncodingSwitch(transportKind)
      ? transportKind === "serial"
        ? "连接表单内配置"
        : "沿用系统编码"
      : status !== "connected"
        ? "连接后可用"
        : null;

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
    const menuWidth = 200;
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
      const text = await navigator.clipboard.readText();
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
      term?.paste(text);
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
        insertSnippet(hit);
      }}
    >
      {/* 终端顶部工具栏（对照 netcatty TerminalToolbar / TerminalView 状态栏） */}
      <div className="term-toolbar" data-section="terminal-toolbar">
        <div className="term-toolbar-left">
          <span className="term-toolbar-title" title={tab.title}>
            {tab.title}
          </span>
          {sessionLog && (
            <span
              className="term-recording-badge is-log"
              title={`会话日志录制中：${sessionLog.path}`}
            >
              LOG
            </span>
          )}
          {scriptRec && (
            <span
              className="term-recording-badge is-rec"
              title="脚本录制中：命令会被记录为脚本"
            >
              REC
            </span>
          )}
          <div className="term-tool-more">
            <button
              className={`term-tool-btn${historyOpen ? " active" : ""}`}
              title="命令历史"
              disabled={status !== "connected"}
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <Icon name="clock" size={12} />
            </button>
            {historyOpen && (
              <div className="term-tool-menu term-history-menu">
                <div className="term-menu-label">命令历史</div>
                {commandHistory.length === 0 ? (
                  <div className="term-menu-empty">本会话还没有命令</div>
                ) : (
                  [...commandHistory]
                    .reverse()
                    .slice(0, 30)
                    .map((cmd, index) => (
                      <button
                        key={`${cmd}-${index}`}
                        title={cmd}
                        onClick={() => {
                          writeToPane(cmd);
                          setHistoryOpen(false);
                          controllerRef.current?.term.focus();
                        }}
                      >
                        <Icon name="terminal" size={12} />
                        <span className="term-history-cmd">{cmd}</span>
                      </button>
                    ))
                )}
              </div>
            )}
          </div>
          {systemEligible && (
            <button
              className="term-tool-btn"
              disabled
              title="系统监控（尚未实现）"
            >
              <Icon name="activity" size={12} />
            </button>
          )}
          <button
            className="term-tool-btn"
            title="断开连接"
            disabled={!canDisconnect}
            onClick={() => disconnect()}
          >
            <Icon name="unplug" size={12} />
          </button>
          <button
            className="term-tool-btn"
            title="重新连接当前会话"
            disabled={!canReconnect}
            onClick={() => {
              void connect();
            }}
          >
            <Icon name="refresh" size={12} />
          </button>
          <button
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
          <button
            className="term-tool-btn"
            disabled
            title="广播模式尚未移植"
          >
            <Icon name="radio" size={12} />
          </button>
        </div>
        <div className="term-toolbar-right">
          <div className="term-tool-more">
            <button
              className={`term-tool-btn${highlightOpen || highlightRules.length > 0 ? " active" : ""}`}
              title="主机关键词高亮"
              onClick={() => setHighlightOpen((v) => !v)}
            >
              <Icon name="highlighter" size={12} />
            </button>
            {highlightOpen && (
              <div className="term-tool-menu term-highlight-menu">
                <div className="term-menu-label">关键词高亮</div>
                <div className="term-highlight-form">
                  <input
                    autoFocus
                    value={highlightDraft}
                    placeholder="输入关键词后回车"
                    onChange={(e) => setHighlightDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && highlightDraft.trim()) {
                        setHighlightRules((prev) => [
                          ...prev,
                          {
                            id: `${Date.now().toString(36)}-${prev.length}`,
                            keyword: highlightDraft.trim(),
                            color: "#f6e05e",
                          },
                        ]);
                        setHighlightDraft("");
                      }
                    }}
                  />
                </div>
                {highlightRules.length === 0 ? (
                  <div className="term-menu-empty">尚无高亮规则</div>
                ) : (
                  highlightRules.map((rule) => (
                    <button
                      key={rule.id}
                      title="点击移除该规则"
                      onClick={() =>
                        setHighlightRules((prev) =>
                          prev.filter((r) => r.id !== rule.id),
                        )
                      }
                    >
                      <span
                        className="term-highlight-dot"
                        style={{ background: rule.color }}
                      />
                      <span className="term-history-cmd">{rule.keyword}</span>
                      <Icon name="x" size={12} className="term-menu-caret" />
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            className="term-tool-btn"
            title={
              onOpenTool ? "打开 SFTP" : "SFTP 面板不可用"
            }
            disabled={!onOpenTool}
            onClick={() => onOpenTool?.("sftp")}
          >
            <Icon name="folder-input" size={12} />
          </button>
          <button
            className="term-tool-btn"
            title={onOpenTool ? "打开端口转发" : "端口转发面板不可用"}
            disabled={!onOpenTool}
            onClick={() => onOpenTool?.("forward")}
          >
            <Icon name="transfer" size={12} />
          </button>
          <button
            className="term-tool-btn"
            disabled
            title="主机浏览器（尚未实现）"
          >
            <Icon name="globe" size={12} />
          </button>
          <button
            className={`term-tool-btn${composeOpen ? " active" : ""}`}
            title="撰写栏"
            disabled={status !== "connected"}
            onClick={() => setComposeOpen((v) => !v)}
          >
            <Icon name="text-cursor" size={12} />
          </button>
          <button
            className={`term-tool-btn${searchOpen ? " active" : ""}`}
            title="终端搜索"
            disabled={status !== "connected"}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Icon name="search" size={12} />
          </button>
          <button
            className={`term-tool-btn${sessionLog ? " recording" : ""}`}
            disabled={!isSsh || status !== "connected" || logBusy}
            title={
              sessionLog
                ? `会话日志录制中：${sessionLog.path}（点击停止）`
                : "开始记录会话日志（先选择保存路径）"
            }
            onClick={() => void toggleManualSessionLog()}
          >
            <Icon name="file-text" size={12} />
          </button>
          <div className="term-tool-more">
            <button
              className="term-tool-btn"
              title={
                scriptSnippets.length > 0
                  ? "运行脚本（发送到当前会话）"
                  : "暂无脚本（到「脚本」页新建，类型选脚本）"
              }
              disabled={scriptSnippets.length === 0}
              onClick={() => setScriptMenuOpen((v) => !v)}
            >
              <Icon name="zap" size={12} />
            </button>
            {scriptMenuOpen && (
              <div className="term-tool-menu term-snippet-menu">
                <div className="term-menu-label">运行脚本</div>
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
          <div className="term-tool-more">
            <button
              className="term-tool-btn"
              title="更多"
              onClick={() =>
                setMoreOpen((v) => {
                  // 每次重新打开都收起二级菜单，和 Netcatty 的 Popover 一致。
                  if (!v) setEncodingMenuOpen(false);
                  return !v;
                })
              }
            >
              <Icon name="more-vertical" size={12} />
            </button>
            {moreOpen && (
              <div className="term-tool-menu term-more-menu">
                <button
                  title={moreHistoryReason ?? "命令历史"}
                  disabled={moreHistoryReason !== null}
                  onClick={() => {
                    setMoreOpen(false);
                    setHistoryOpen(true);
                  }}
                >
                  <Icon name="history" size={12} />
                  <span className="term-menu-text">命令历史</span>
                  {moreHistoryReason !== null && (
                    <span className="term-menu-note">{moreHistoryReason}</span>
                  )}
                </button>
                <button
                  title={
                    moreOsc7Reason !== null
                      ? `配置目录追踪 · ${moreOsc7Reason}`
                      : cwdTracked
                        ? `配置目录追踪（已启用：${cwd ?? "未知目录"}）`
                        : "配置目录追踪"
                  }
                  disabled={moreOsc7Reason !== null}
                  onClick={() => {
                    setOsc7DialogOpen(true);
                    setMoreOpen(false);
                  }}
                >
                  <Icon name="folder-sync" size={12} />
                  <span className="term-menu-text">配置目录追踪</span>
                  {moreOsc7Reason !== null ? (
                    <span className="term-menu-note">{moreOsc7Reason}</span>
                  ) : (
                    cwdTracked && <span className="term-menu-note">已启用</span>
                  )}
                </button>
                <button
                  title={
                    onOpenSettings
                      ? "终端设置（外观 / 字体 / 行为）"
                      : "终端设置暂不可用"
                  }
                  disabled={!onOpenSettings}
                  onClick={() => {
                    setMoreOpen(false);
                    onOpenSettings?.();
                  }}
                >
                  <Icon name="palette" size={12} />
                  <span className="term-menu-text">终端设置</span>
                </button>
                <button
                  title={
                    moreRecordingReason ??
                    (scriptRec ? "停止录制并保存到脚本库" : "开始录制脚本")
                  }
                  disabled={
                    moreRecordingReason !== null || scriptRecBusy
                  }
                  className={scriptRec ? "is-recording" : undefined}
                  onClick={() => {
                    setMoreOpen(false);
                    void toggleScriptRecording();
                  }}
                >
                  <Icon name="circle" size={12} className="term-record-dot" />
                  <span className="term-menu-text">
                    {scriptRec ? "停止录制" : "开始录制"}
                  </span>
                  {moreRecordingReason !== null && (
                    <span className="term-menu-note">{moreRecordingReason}</span>
                  )}
                </button>
                <div
                  className={`term-menu-sub${encodingMenuOpen ? " open" : ""}`}
                >
                  <button
                    title={
                      moreEncodingReason !== null
                        ? `终端编码 · ${moreEncodingReason}`
                        : `终端编码（当前 ${terminalEncodingLabel(encoding)}）`
                    }
                    disabled={moreEncodingReason !== null}
                    className={encodingMenuOpen ? "open" : undefined}
                    onClick={() => setEncodingMenuOpen((v) => !v)}
                  >
                    <Icon name="languages" size={12} />
                    <span className="term-menu-text">终端编码</span>
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

      {composeOpen && (
        <div className="term-compose-bar">
          <textarea
            autoFocus
            value={composeText}
            placeholder="撰写多行内容，Ctrl+Enter 发送"
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                sendCompose();
              }
              if (e.key === "Escape") setComposeOpen(false);
            }}
          />
          <div className="term-compose-actions">
            <button
              className="term-search-btn"
              disabled={status !== "connected" || !composeText.trim()}
              onClick={sendCompose}
            >
              发送
            </button>
            <button
              className="term-search-btn"
              onClick={() => setComposeOpen(false)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        </div>
      )}

      <TerminalView
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
          handleTerminalInput(data);
          transportRef.current?.write(data);
        }}
        onResize={(cols, rows) => transportRef.current?.resize(cols, rows)}
        onOsc7={handleOsc7}
      />

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
            <button
              disabled={!menu.selection}
              onClick={() => {
                void navigator.clipboard.writeText(menu.selection);
                closeMenu();
              }}
            >
              <Icon name="copy" size={14} />
              复制
            </button>
            <button
              onClick={() => {
                void pasteFromClipboard();
                closeMenu();
              }}
            >
              <Icon name="clipboard-paste" size={14} />
              粘贴
            </button>
            <button
              onClick={() => {
                controllerRef.current?.term.selectAll();
                closeMenu();
              }}
            >
              <Icon name="terminal" size={14} />
              全选
            </button>
            {snippets.length > 0 && (
              <>
                {snippets.some((s) => !isScriptSnippet(s)) && (
                  <>
                    <div className="term-menu-sep" />
                    <div className="term-menu-label">插入片段</div>
                    <div className="term-snippet-list">
                      {snippets
                        .filter((s) => !isScriptSnippet(s))
                        .map((s) => (
                          <button
                            key={s.id || s.name}
                            disabled={status !== "connected"}
                            title={s.shortkey ? `快捷键：${s.shortkey}` : s.command}
                            onClick={() => {
                              insertSnippet(s);
                              closeMenu();
                            }}
                          >
                            <Icon name="file-code" size={14} />
                            {s.name}
                          </button>
                        ))}
                    </div>
                  </>
                )}
                {scriptSnippets.length > 0 && (
                  <>
                    <div className="term-menu-sep" />
                    <div className="term-menu-label">运行脚本</div>
                    <div className="term-snippet-list">
                      {scriptSnippets.map((s) => (
                        <button
                          key={s.id || s.name}
                          disabled={status !== "connected"}
                          title={s.shortkey ? `快捷键：${s.shortkey}` : s.command}
                          onClick={() => {
                            insertSnippet(s);
                            closeMenu();
                          }}
                        >
                          <Icon name="play" size={14} />
                          {s.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <div className="term-menu-sep" />
            <button disabled title="主机浏览器（尚未实现）">
              <Icon name="globe" size={14} />
              浏览器
            </button>
            <div className="term-menu-sep" />
            <button
              disabled={!canReconnect}
              onClick={() => {
                closeMenu();
                void connect();
              }}
            >
              <Icon name="refresh" size={14} />
              重新连接
            </button>
            <div className="term-menu-sep" />
            <button
              disabled={!onSplit}
              onClick={() => {
                closeMenu();
                onSplit?.("horizontal");
              }}
            >
              <Icon name="columns" size={14} />
              水平分屏
            </button>
            <button
              disabled={!onSplit}
              onClick={() => {
                closeMenu();
                onSplit?.("vertical");
              }}
            >
              <Icon name="rows" size={14} />
              垂直分屏
            </button>
            <div className="term-menu-sep" />
            <button
              onClick={() => {
                controllerRef.current?.term.clear();
                closeMenu();
              }}
            >
              <Icon name="trash" size={14} />
              清空缓冲区
            </button>
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
    </div>
  );
}
