/**
 * 单个终端窗格：自持 xterm、会话、事件订阅与交互 prompt 弹窗。
 *
 * 与旧版 App 单会话的区别：
 * - 每格独立一个 sessionId 与传输对象，互不影响；
 * - 断线后保留终端内容，叠一层「重连」遮罩；
 * - 支持被串口 / Telnet 侧栏面板临时「接管」按键路由（外部传输优先）。
 */

import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { TerminalView, type TerminalController } from "./Terminal";
import * as api from "./backend/client";
import type {
  AuthPrompt,
  CloseInfo,
  TerminalDomain,
  TerminalTransport,
} from "./backend/client";
import type { Tab } from "./workspace";

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
}

export function TerminalPane({
  tab,
  paneId,
  active,
  onActivate,
  onRegister,
  onStatus,
}: Props) {
  const [status, setStatus] = useState<PaneStatus>("connecting");
  const [detail, setDetail] = useState("");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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

  return (
    <div
      className={`pane${active ? " active" : ""}`}
      onMouseDown={() => {
        onActivate();
        controllerRef.current?.term.focus();
      }}
    >
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
        <div className="pane-overlay">
          <div className="pane-overlay-title">
            {status === "error" ? "连接失败" : "会话已结束"}
          </div>
          {detail && <div className="pane-overlay-detail">{detail}</div>}
          <button onClick={() => void connect()} className="pane-reconnect">
            重连
          </button>
        </div>
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
