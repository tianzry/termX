/**
 * 单个终端窗格：自持 xterm、会话、事件订阅与交互 prompt 弹窗。
 *
 * 与旧版 App 单会话的区别：
 * - 每格独立一个 sessionId 与传输对象，互不影响；
 * - 断线后保留终端内容，叠一层「重连」遮罩；
 * - 支持被串口 / Telnet 侧栏面板临时「接管」按键路由（外部传输优先）。
 */

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { TerminalView, type TerminalController } from "./Terminal";
import { Icon } from "./ui/icons";
import * as api from "./backend/client";
import type {
  AuthPrompt,
  CloseInfo,
  TerminalDomain,
  TerminalTransport,
} from "./backend/client";
import type { Tab } from "./workspaceModel";

type PaneStatus = "connecting" | "connected" | "closed" | "error";

type Prompt =
  | { kind: "auth"; sessionId: string; payload: AuthPrompt }
  | { kind: "passphrase"; sessionId: string; payload: { prompt: string } }
  | { kind: "hostkey"; sessionId: string; payload: { banner: string } };

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
  /** 打开右侧工具面板（SFTP / 串口 / Telnet / 端口转发）。 */
  onOpenTool?: (tool: "sftp" | "serial" | "telnet" | "forward") => void;
  /** 关闭当前窗格。 */
  onClosePane?: () => void;
  /** 分屏（在当前标签内）。 */
  onSplit?: (dir: "horizontal" | "vertical") => void;
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
}: Props) {
  const [status, setStatus] = useState<PaneStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 右键菜单（位置相对窗格左上角）。 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    selection: string;
  } | null>(null);

  const paneRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const transportRef = useRef<TerminalTransport | null>(null);
  const externalRef = useRef<TerminalTransport | null>(null);
  const unsubRef = useRef<UnlistenFn[]>([]);
  const promptUnsubRef = useRef<UnlistenFn[]>([]);
  const sidRef = useRef<string | null>(null);
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
    else if (p.kind === "passphrase") void api.sshPassphraseCancel(p.sessionId);
    else void api.sshHostKeyCancel(p.sessionId);
  }

  /** 拆掉本窗格会话的监听与连接（不重连）。 */
  function teardown() {
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
      if (pendingPromptRef.current) cancelPromptApi(pendingPromptRef.current);
      pendingPromptRef.current = null;
      unsubRef.current.forEach((u) => u());
      unsubRef.current = [];
      promptUnsubRef.current.forEach((u) => u());
      promptUnsubRef.current = [];
      transportRef.current?.close();
      transportRef.current = null;
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
    notifySession(sid);

    unsubRef.current = [
      await api.onTerminalData(domain, sid, (bytes) =>
        controllerRef.current?.term.write(bytes),
      ),
      await api.onTerminalClose(domain, sid, (info: CloseInfo) => {
        transportRef.current = null;
        notifySession(null);
        setStatus("closed");
        const suffix = info.signal
          ? `被信号 ${info.signal} 终止`
          : typeof info.exit_code === "number"
            ? `退出码 ${info.exit_code}`
            : "已断开";
        setDetail(suffix);
        onStatus(`${tab.title} ${suffix}`);
      }),
    ];

    onStatus(`${tab.title} 已连接 (${sid})`);
    controllerRef.current?.fit.fit();
    controllerRef.current?.term.focus();
  }

  async function connect() {
    const c = controllerRef.current;
    if (!c) return;
    setStatus("connecting");
    setDetail("");
    teardown();
    notifySession(null);
    setPromptBoth(null);

    try {
      if (tab.connector.kind === "ssh") {
        const profileId = tab.connector.profileId;
        // prompt 监听的 key 必须与 sshConnect 的 sessionId 一致，
        // 且必须在 await 之前注册，否则认证 pending 期间的 prompt 会丢。
        const sid = api.newSessionId();
        promptUnsubRef.current = [
          await api.onAuthPrompt(sid, (p) =>
            setPromptBoth({ kind: "auth", sessionId: sid, payload: p }),
          ),
          await api.onPassphrasePrompt(sid, (p) =>
            setPromptBoth({ kind: "passphrase", sessionId: sid, payload: p }),
          ),
          await api.onHostKeyPrompt(sid, (p) =>
            setPromptBoth({ kind: "hostkey", sessionId: sid, payload: p }),
          ),
        ];
        const actual = await api.sshConnect(
          profileId,
          c.term.cols,
          c.term.rows,
          sid,
        );
        if (!aliveRef.current) {
          void api.sshDisconnect(actual);
          return;
        }
        promptUnsubRef.current.forEach((u) => u());
        promptUnsubRef.current = [];
        setPromptBoth(null);
        await wire("ssh", actual);
      } else {
        const sid = await api.ptySpawn(c.term.cols, c.term.rows);
        if (!aliveRef.current) {
          void api.ptyClose(sid);
          return;
        }
        await wire("pty", sid);
      }
    } catch (e) {
      if (!aliveRef.current) return;
      promptUnsubRef.current.forEach((u) => u());
      promptUnsubRef.current = [];
      setPromptBoth(null);
      setStatus("error");
      setDetail(String(e));
      onStatus(`${tab.title} 连接失败：${String(e)}`);
    }
  }

  // ── 交互 prompt 响应 ─────────────────────────────────────

  async function respondAuth() {
    if (!prompt || prompt.kind !== "auth") return;
    setBusy(true);
    await api.sshAuthRespond(prompt.sessionId, answers);
    setBusy(false);
    setPromptBoth(null);
  }

  async function respondPassphrase() {
    if (!prompt || prompt.kind !== "passphrase") return;
    setBusy(true);
    await api.sshPassphraseRespond(prompt.sessionId, answers[0] ?? "");
    setBusy(false);
    setPromptBoth(null);
  }

  async function respondHostKey(accept: boolean) {
    if (!prompt || prompt.kind !== "hostkey") return;
    setBusy(true);
    await api.sshHostKeyRespond(prompt.sessionId, accept ? "yes" : "no");
    setBusy(false);
    setPromptBoth(null);
  }

  async function cancelPrompt() {
    if (!prompt) return;
    cancelPromptApi(prompt);
    setPromptBoth(null);
  }

  /** 断开当前会话：只拆掉传输与监听，保留标签页与窗格。 */
  function disconnect() {
    teardown();
    notifySession(null);
    setPromptBoth(null);
    setStatus("closed");
    setDetail("会话已断开");
    onStatus(`${tab.title} 已断开`);
  }

  const canDisconnect = status === "connected" || status === "connecting";
  const canReconnect =
    status === "connected" || status === "closed" || status === "error";
  // 系统监控只出现在远端 SSH 会话（netcatty isSystemSidebarEligible 排除本地 / 串口 / Telnet）
  const systemEligible = tab.connector.kind === "ssh";

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
            title="断开当前会话，但保留标签页"
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
          <button
            className="term-tool-btn"
            disabled
            title="脚本（尚未实现）"
          >
            <Icon name="zap" size={12} />
          </button>
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

      {status === "connecting" && (
        <div className="pane-badge">连接中…</div>
      )}

      {(status === "closed" || status === "error") && (
        <div className="pane-overlay" onContextMenu={openContextMenu}>
          <div className="pane-overlay-title">
            {status === "error" ? "连接失败" : "会话已结束"}
          </div>
          {detail && <div className="pane-overlay-detail">{detail}</div>}
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

            {prompt.kind === "hostkey" && (
              <>
                <h3>确认主机指纹</h3>
                <pre className="prompt-instructions">{prompt.payload.banner}</pre>
                <div className="modal-actions">
                  <button
                    onClick={() => void respondHostKey(true)}
                    disabled={busy}
                  >
                    信任并继续
                  </button>
                  <button
                    onClick={() => void respondHostKey(false)}
                    disabled={busy}
                  >
                    拒绝
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
