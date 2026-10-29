import { useRef, useState } from "react";
import { TerminalView, type TerminalController } from "./Terminal";
import { SftpPanel } from "./SftpPanel";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./backend/client";
import type { AuthPrompt, CredentialType, TerminalDomain } from "./backend/client";

type Mode = "idle" | "pty" | "ssh";
type AuthType = "password" | "key" | "interactive";

type Prompt =
  | { kind: "auth"; sessionId: string; payload: AuthPrompt }
  | { kind: "passphrase"; sessionId: string; payload: { prompt: string } }
  | { kind: "hostkey"; sessionId: string; payload: { banner: string } };

interface Transport {
  domain: TerminalDomain;
  write: (text: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

export default function App() {
  const controllerRef = useRef<TerminalController | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const unsubRef = useRef<UnlistenFn[]>([]);
  const promptUnsubRef = useRef<UnlistenFn[]>([]);

  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("待命：点击「本地终端」或配置 SSH 后连接");
  const [sshSessionId, setSshSessionId] = useState<string | null>(null);
  const [showSftp, setShowSftp] = useState(false);

  // SSH 表单（三种认证）
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [authType, setAuthType] = useState<AuthType>("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  // 交互 prompt 弹窗
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptAnswers, setPromptAnswers] = useState<string[]>([]);

  function cleanup() {
    unsubRef.current.forEach((u) => u());
    unsubRef.current = [];
    transportRef.current = null;
  }

  function cleanupPrompts() {
    promptUnsubRef.current.forEach((u) => u());
    promptUnsubRef.current = [];
  }

  async function wired(domain: TerminalDomain, sid: string): Promise<void> {
    transportRef.current = {
      domain,
      write: (text) =>
        domain === "pty" ? api.ptyWrite(sid, text) : api.sshWrite(sid, text),
      resize: (cols, rows) =>
        domain === "pty"
          ? api.ptyResize(sid, cols, rows)
          : api.sshResize(sid, cols, rows),
      close: () => (domain === "pty" ? api.ptyClose(sid) : api.sshDisconnect(sid)),
    };
    unsubRef.current = [
      await api.onTerminalData(domain, sid, (bytes) =>
        controllerRef.current?.term.write(bytes),
      ),
      await api.onTerminalClose(domain, sid, (info) => {
        if (transportRef.current?.domain !== domain) return;
        cleanup();
        setMode("idle");
        setSshSessionId(null);
        const suffix = info.signal
          ? `被信号 ${info.signal} 终止`
          : typeof info.exit_code === "number"
            ? `退出码 ${info.exit_code}`
            : "已断开";
        setStatus(`${domain === "pty" ? "本地终端" : "SSH"} ${suffix} (${sid})`);
      }),
    ];
  }

  async function openPty() {
    const c = controllerRef.current;
    if (!c) return;
    setBusy(true);
    setStatus("启动本地终端…");
    cleanup();
    cleanupPrompts();
    setPrompt(null);
    try {
      const sid = await api.ptySpawn(c.term.cols, c.term.rows);
      await wired("pty", sid);
      setMode("pty");
      setSshSessionId(null);
      setStatus(`本地终端已启动 (${sid})`);
    } catch (e) {
      cleanup();
      setStatus(`本地终端启动失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function openSsh() {
    const c = controllerRef.current;
    if (!c) return;
    if (!host.trim() || !user.trim()) {
      setStatus("请填写 host 和用户名");
      return;
    }
    if (authType === "key" && !privateKey.trim()) {
      setStatus("请粘贴私钥内容");
      return;
    }
    setBusy(true);
    setStatus("连接 SSH…");
    cleanup();
    cleanupPrompts();
    setPrompt(null);

    // 关键：先在 await sshConnect 之前用同一个 sessionId 注册三个 prompt 监听，
    // 否则认证 pending 期间后端发出的 prompt 事件会丢。
    const sid = api.newSessionId();
    try {
      promptUnsubRef.current = [
        await api.onAuthPrompt(sid, (p) =>
          setPrompt({ kind: "auth", sessionId: sid, payload: p }),
        ),
        await api.onPassphrasePrompt(sid, (p) =>
          setPrompt({ kind: "passphrase", sessionId: sid, payload: p }),
        ),
        await api.onHostKeyPrompt(sid, (p) =>
          setPrompt({ kind: "hostkey", sessionId: sid, payload: p }),
        ),
      ];

      // POC 最小流程：临时新建 credential + profile，再走 ssh_connect。
      const credId = crypto.randomUUID();
      const profileId = crypto.randomUUID();
      const credType: CredentialType = authType;
      const secret =
        authType === "password" ? password : authType === "key" ? privateKey : null;
      await api.createCredential({
        id: credId,
        name: `${user}@${host}`,
        username: user,
        type: credType,
        secret,
        save_to_remote: false,
      });
      await api.createProfile({
        id: profileId,
        name: `${user}@${host}`,
        host,
        port: Number(port) || 22,
        credential_id: credId,
        bastion_profile_id: null,
        init_command: null,
        group_id: null,
      });

      const actualSid = await api.sshConnect(profileId, c.term.cols, c.term.rows, sid);
      cleanupPrompts();
      setPrompt(null);
      await wired("ssh", actualSid);
      setMode("ssh");
      setSshSessionId(actualSid);
      setStatus(`SSH 已连接 (${actualSid})`);
    } catch (e) {
      cleanupPrompts();
      setPrompt(null);
      cleanup();
      setStatus(`SSH 连接失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function closeCurrent() {
    transportRef.current?.close();
    cleanup();
    cleanupPrompts();
    setPrompt(null);
    setMode("idle");
    setSshSessionId(null);
    setStatus("已关闭");
  }

  // ── 交互 prompt 响应 ─────────────────────────────────────

  async function respondAuth() {
    if (!prompt || prompt.kind !== "auth") return;
    await api.sshAuthRespond(prompt.sessionId, promptAnswers);
    setPrompt(null);
    setPromptAnswers([]);
  }

  async function respondPassphrase() {
    if (!prompt || prompt.kind !== "passphrase") return;
    await api.sshPassphraseRespond(prompt.sessionId, promptAnswers[0] ?? "");
    setPrompt(null);
    setPromptAnswers([]);
  }

  async function respondHostKey(accept: boolean) {
    if (!prompt || prompt.kind !== "hostkey") return;
    await api.sshHostKeyRespond(prompt.sessionId, accept ? "yes" : "no");
    setPrompt(null);
  }

  async function cancelPrompt() {
    if (!prompt) return;
    if (prompt.kind === "auth") await api.sshAuthCancel(prompt.sessionId);
    else if (prompt.kind === "passphrase")
      await api.sshPassphraseCancel(prompt.sessionId);
    else await api.sshHostKeyCancel(prompt.sessionId);
    setPrompt(null);
    setPromptAnswers([]);
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button onClick={openPty} disabled={busy || mode === "pty"}>
          本地终端 (PTY)
        </button>
        <button onClick={openSsh} disabled={busy}>
          SSH 连接
        </button>
        {(mode === "pty" || mode === "ssh") && (
          <button onClick={closeCurrent} disabled={busy}>
            关闭
          </button>
        )}
        <button
          onClick={() => setShowSftp((v) => !v)}
          disabled={busy}
          className={showSftp ? "active" : ""}
        >
          文件传输 (SFTP)
        </button>
        <span className="status">{status}</span>
      </header>

      {mode === "idle" && (
        <form
          className="ssh-form"
          onSubmit={(e) => {
            e.preventDefault();
            openSsh();
          }}
        >
          <label>
            host
            <input value={host} onChange={(e) => setHost(e.target.value)} />
          </label>
          <label>
            port
            <input value={port} onChange={(e) => setPort(e.target.value)} />
          </label>
          <label>
            用户名
            <input value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <label>
            认证方式
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value as AuthType)}
            >
              <option value="password">密码</option>
              <option value="key">私钥</option>
              <option value="interactive">键盘交互</option>
            </select>
          </label>
          {authType === "password" && (
            <label>
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          {authType === "key" && (
            <label>
              私钥（粘贴 PEM 内容）
              <input
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
              />
            </label>
          )}
          {authType === "interactive" && (
            <span className="hint">连接后按服务端提示回答（keyboard-interactive）</span>
          )}
          <button type="submit" disabled={busy}>
            连接
          </button>
        </form>
      )}

      <div className="main">
        <div className="terminal-wrap">
          <TerminalView
            onReady={(c) => {
              controllerRef.current = c;
            }}
            onData={(data) => transportRef.current?.write(data)}
            onResize={(cols, rows) => transportRef.current?.resize(cols, rows)}
          />
        </div>
        {showSftp && <SftpPanel sshSessionId={sshSessionId} />}
      </div>

      {/* 交互 prompt 弹窗 */}
      {prompt && (
        <div className="modal-mask">
          <div className="modal">
            {prompt.kind === "auth" && (
              <>
                <h3>键盘交互认证</h3>
                {prompt.payload.name && <div className="prompt-name">{prompt.payload.name}</div>}
                {prompt.payload.instructions && (
                  <pre className="prompt-instructions">{prompt.payload.instructions}</pre>
                )}
                {prompt.payload.prompts.map((p, i) => (
                  <label key={i}>
                    {p.prompt}
                    <input
                      type={p.echo ? "text" : "password"}
                      value={promptAnswers[i] ?? ""}
                      onChange={(e) =>
                        setPromptAnswers((cur) => {
                          const next = [...cur];
                          next[i] = e.target.value;
                          return next;
                        })
                      }
                    />
                  </label>
                ))}
                <div className="modal-actions">
                  <button onClick={respondAuth} disabled={busy}>
                    确定
                  </button>
                  <button onClick={cancelPrompt} disabled={busy}>
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
                    value={promptAnswers[0] ?? ""}
                    onChange={(e) => setPromptAnswers([e.target.value])}
                  />
                </label>
                <div className="modal-actions">
                  <button onClick={respondPassphrase} disabled={busy}>
                    确定
                  </button>
                  <button onClick={cancelPrompt} disabled={busy}>
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
                  <button onClick={() => respondHostKey(true)} disabled={busy}>
                    信任并继续
                  </button>
                  <button onClick={() => respondHostKey(false)} disabled={busy}>
                    拒绝
                  </button>
                  <button onClick={cancelPrompt} disabled={busy}>
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