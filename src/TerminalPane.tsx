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
 * - 支持被串口 / Telnet 侧栏面板临时「接管」按键路由（外部传输优先）。
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
  shortkeyMatches,
  snippetWritePlan,
} from "./snippets/snippetsModel";
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
import {
  TerminalConnectionDialog,
  type ChainProgress,
  type HostConnectionInfo,
} from "./terminal/TerminalConnectionDialog";
import type { AuthKeyOption, TerminalAuthMethod } from "./terminal/TerminalAuthDialog";

type PaneStatus = "connecting" | "connected" | "disconnected";

type Prompt =
  | { kind: "auth"; sessionId: string; payload: AuthPrompt }
  | { kind: "passphrase"; sessionId: string; payload: { prompt: string } };

/** 窗格对外的句柄：供工作区取尺寸 / 写入 / 路由外部会话。 */
export interface PaneHandle {
  paneId: string;
  /** 写入终端（串口 / Telnet 下行字节）。 */
  write: (bytes: Uint8Array) => void;
  /** 当前行列（telnet_open 的 NAWS 初值等）。 */
  size: () => { cols: number; rows: number } | null;
  /** 接管（或解除）按键 / resize 路由；传 null 恢复本窗格自身会话。 */
  attachTransport: (t: TerminalTransport | null) => void;
  /** 本窗格 SSH 会话 id；非 SSH 或未连接为 null。 */
  sshSessionId: () => string | null;
  /** 订阅 SSH 会话变化（连接 / 断开时回调）。 */
  subscribeSession: (cb: (sid: string | null) => void) => () => void;
  focus: () => void;
}

interface Props {
  tab: Tab;
  paneId: string;
  active: boolean;
  onActivate: () => void;
  onRegister: (paneId: string, handle: PaneHandle | null) => void;
  onStatus: (text: string) => void;
  /** 打开右侧工具面板（SFTP / Telnet / 端口转发）。 */
  onOpenTool?: (tool: "sftp" | "telnet" | "forward") => void;
  /** 关闭当前窗格。 */
  onClosePane?: () => void;
  /** 分屏（在当前标签内）。 */
  onSplit?: (dir: "horizontal" | "vertical") => void;
}

const AUTH_RETRY_MESSAGE = "身份验证失败。请检查凭据后重试。";
const PROGRESS_ATTEMPT_TIMEOUT_MESSAGE = "连接超时，请重试。";

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
  /** 片段 / 脚本列表（P0 #5）：右键插入与快捷键，均只写入本窗格自己的会话。 */
  const [snippets, setSnippets] = useState<api.Snippet[]>([]);
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

  /** 逐行发送的待执行定时器（断开 / 卸载时必须清掉，避免写入错误会话）。 */
  const pendingWritesRef = useRef<number[]>([]);
  function clearPendingWrites() {
    pendingWritesRef.current.forEach((id) => window.clearTimeout(id));
    pendingWritesRef.current = [];
  }

  function writeToPane(text: string) {
    (externalRef.current ?? transportRef.current)?.write(text);
  }

  /**
   * 插入片段 / 运行脚本：仅当前窗格会话，禁止跨会话发送；未连接时不动作。
   * 多行方式对齐 Netcatty：paste 整段 + 末尾单回车；lineDelay 逐行 250ms。
   * 脚本（kind=script）走同一链路——把脚本文本发送到活动 shell，输出在本终端回显。
   * （Netcatty 的 nct.* JS 运行时未移植，见 todo/changelogs 留档。）
   */
  const insertSnippet = (s: api.Snippet) => {
    if (status !== "connected") return;
    clearPendingWrites();
    const plan = snippetWritePlan(s.command, s.no_auto_run, s.multi_line_run_mode);
    if (plan.delayMs <= 0 || plan.chunks.length === 1) {
      writeToPane(plan.chunks[0] ?? "");
      return;
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
  };

  /** 脚本下拉菜单（终端工具栏「脚本」按钮）。 */
  const [scriptMenuOpen, setScriptMenuOpen] = useState(false);
  const scriptSnippets = snippets.filter(isScriptSnippet);

  /** 右键菜单（位置相对窗格左上角）。 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    selection: string;
  } | null>(null);

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
  const externalRef = useRef<TerminalTransport | null>(null);
  const unsubRef = useRef<UnlistenFn[]>([]);
  const promptUnsubRef = useRef<UnlistenFn[]>([]);
  const sidRef = useRef<string | null>(null);
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
      if (pendingPromptRef.current) cancelPromptApi(pendingPromptRef.current);
      pendingPromptRef.current = null;
      if (hostKeySessionRef.current) void api.sshHostKeyCancel(hostKeySessionRef.current);
      hostKeySessionRef.current = null;
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
      write: (bytes) => {
        if (aliveRef.current) controllerRef.current?.term.write(bytes);
      },
      size: () =>
        controllerRef.current
          ? {
              cols: controllerRef.current.term.cols,
              rows: controllerRef.current.term.rows,
            }
          : null,
      attachTransport: (t) => {
        externalRef.current = t;
      },
      sshSessionId: () =>
        tab.connector.kind === "ssh" ? sidRef.current : null,
      subscribeSession: (cb) => {
        listenersRef.current.add(cb);
        cb(sidRef.current);
        return () => {
          listenersRef.current.delete(cb);
        };
      },
      focus: () => {
        if (aliveRef.current) controllerRef.current?.term.focus();
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
          : api.sshWrite(sid, text)),
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
    setStatus("connected");
    setError(null);
    setChainProgress(null);
    setDisconnectedDismissed(false);
    notifySession(sid);

    unsubRef.current = [
      await api.onTerminalData(domain, sid, (bytes) =>
        controllerRef.current?.term.write(bytes),
      ),
      await api.onTerminalClose(domain, sid, (info: CloseInfo) => {
        transportRef.current = null;
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
      }),
    ];

    onStatus(`${tab.title} 已连接 (${sid})`);
    controllerRef.current?.fit.fit();
    controllerRef.current?.term.focus();
  }

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
        unsubRef.current = [
          await api.onSerialData(sid, (bytes) =>
            controllerRef.current?.term.write(bytes),
          ),
          await api.onSerialClose(sid, () => {
            transportRef.current = null;
            notifySession(null);
            setStatus("disconnected");
            setError("串口已断开");
            setDisconnectedDismissed(false);
            onStatus(`${tab.title} 串口已断开`);
          }),
        ];
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

  const authValid =
    authUsername.trim().length > 0 &&
    (authMethod === "password" ? authPassword.length > 0 : Boolean(authKeyId));

  // netcatty shouldShowTerminalConnectionDialog：status !== connected
  // 且 disconnected 状态下未被用户 dismiss。
  const showConnectionDialog =
    isSsh && status !== "connected" && !(status === "disconnected" && disconnectedDismissed);

  /** 终端右键菜单（对照 netcatty TerminalContextMenu；坐标相对窗格左上角）。 */
  function openContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".term-toolbar")) return;
    e.preventDefault();
    e.stopPropagation();
    const box = paneRef.current?.getBoundingClientRect();
    if (!box) return;
    const menuWidth = 200;
    const menuHeight = 340;
    setMenu({
      x: Math.max(4, Math.min(e.clientX - box.left, box.width - menuWidth - 4)),
      y: Math.max(
        4,
        Math.min(e.clientY - box.top, Math.max(4, box.height - menuHeight)),
      ),
      selection: controllerRef.current?.term.getSelection() ?? "",
    });
  }

  function closeMenu() {
    setMenu(null);
  }

  return (
    <div
      ref={paneRef}
      className={`pane${active ? " active" : ""}`}
      onMouseDown={() => {
        onActivate();
        controllerRef.current?.term.focus();
      }}
      onContextMenu={openContextMenu}
      onKeyDownCapture={(e) => {
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
          <button
            className="term-tool-btn"
            disabled
            title="行时间戳（尚未实现）"
          >
            <Icon name="clock" size={12} />
          </button>
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
          <button
            className="term-tool-btn"
            disabled
            title="主机关键词高亮（尚未实现）"
          >
            <Icon name="highlighter" size={12} />
          </button>
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
            disabled
            title="主机浏览器（尚未实现）"
          >
            <Icon name="globe" size={12} />
          </button>
          <button
            className="term-tool-btn"
            disabled
            title="输入框（尚未实现）"
          >
            <Icon name="text-cursor" size={12} />
          </button>
          <button
            className="term-tool-btn"
            disabled
            title="终端搜索（尚未实现）"
          >
            <Icon name="search" size={12} />
          </button>
          <button
            className="term-tool-btn"
            disabled
            title="会话日志（尚未实现）"
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
              onClick={() => setMoreOpen((v) => !v)}
            >
              <Icon name="more-vertical" size={12} />
            </button>
            {moreOpen && (
              <div className="term-tool-menu">
                {systemEligible && (
                  <>
                    <button disabled title="命令历史（尚未实现）">
                      <Icon name="history" size={12} />
                      命令历史
                    </button>
                    <button disabled title="配置目录追踪（尚未实现）">
                      <Icon name="folder-sync" size={12} />
                      配置目录追踪
                    </button>
                  </>
                )}
                <button disabled title="终端设置（尚未实现）">
                  <Icon name="palette" size={12} />
                  终端设置
                </button>
                <button disabled title="开始录制（尚未实现）">
                  <Icon name="circle" size={12} className="term-record-dot" />
                  开始录制
                </button>
                {systemEligible && (
                  <button disabled title="终端编码（尚未实现）">
                    <Icon name="languages" size={12} />
                    终端编码
                    <Icon
                      name="chevron-right"
                      size={12}
                      className="term-menu-caret"
                    />
                  </button>
                )}
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

      <TerminalView
        onReady={(c) => {
          controllerRef.current = c;
          if (!startedRef.current) {
            startedRef.current = true;
            void connect();
          }
        }}
        onData={(data) =>
          (externalRef.current ?? transportRef.current)?.write(data)
        }
        onResize={(cols, rows) =>
          (externalRef.current ?? transportRef.current)?.resize(cols, rows)
        }
      />

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

      {!isSsh && status === "disconnected" && (
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
                void navigator.clipboard
                  .readText()
                  .then((text) => controllerRef.current?.term.paste(text))
                  .catch(() => {});
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
