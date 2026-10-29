import { useRef, useState } from "react";
import { TerminalView, type TerminalController } from "./Terminal";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  createCredential,
  createProfile,
  onClose,
  onData,
  ptyClose,
  ptyResize,
  ptySpawn,
  ptyWrite,
  sshConnect,
  sshDisconnect,
  sshResize,
  sshWrite,
  type Domain,
} from "./ipc";

type Mode = "idle" | "pty" | "ssh";

interface Transport {
  write: (text: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  domain: Domain;
}

export default function App() {
  const controllerRef = useRef<TerminalController | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const unsubRef = useRef<UnlistenFn[]>([]);

  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("待命：点击「本地终端」或「SSH」开始");

  // SSH 表单
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  function cleanup() {
    unsubRef.current.forEach((u) => u());
    unsubRef.current = [];
    transportRef.current = null;
  }

  async function wired(domain: Domain, sid: string): Promise<void> {
    transportRef.current = {
      domain,
      write: (text) =>
        (domain === "pty" ? ptyWrite(sid, text) : sshWrite(sid, text)),
      resize: (cols, rows) =>
        (domain === "pty"
          ? ptyResize(sid, cols, rows)
          : sshResize(sid, cols, rows)),
      close: () => (domain === "pty" ? ptyClose(sid) : sshDisconnect(sid)),
    };
    unsubRef.current = [
      await onData(domain, sid, (bytes) => controllerRef.current?.term.write(bytes)),
      await onClose(domain, sid, () => {
        if (transportRef.current?.domain !== domain) return;
        cleanup();
        setMode("idle");
        setStatus(`已断开：${domain === "pty" ? "本地终端" : "SSH"} (${sid})`);
      }),
    ];
  }

  async function openPty() {
    const c = controllerRef.current;
    if (!c) return;
    setBusy(true);
    setStatus("启动本地终端…");
    cleanup();
    try {
      const sid = await ptySpawn(c.term.cols, c.term.rows);
      await wired("pty", sid);
      setMode("pty");
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
    setBusy(true);
    setStatus("连接 SSH…");
    cleanup();
    try {
      // POC 最小流程：临时新建 credential + profile，再走 ssh_connect。
      const credId = crypto.randomUUID();
      const profileId = crypto.randomUUID();
      await createCredential({
        id: credId,
        name: `${user}@${host}`,
        username: user,
        type: "password",
        secret: password,
        save_to_remote: false,
      });
      await createProfile({
        id: profileId,
        name: `${user}@${host}`,
        host,
        port: Number(port) || 22,
        credential_id: credId,
        bastion_profile_id: null,
        init_command: null,
        group_id: null,
      });
      const sid = await sshConnect(profileId, c.term.cols, c.term.rows);
      await wired("ssh", sid);
      setMode("ssh");
      setStatus(`SSH 已连接 (${sid})`);
    } catch (e) {
      cleanup();
      setStatus(`SSH 连接失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function closeCurrent() {
    transportRef.current?.close();
    cleanup();
    setMode("idle");
    setStatus("已关闭");
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
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            连接
          </button>
        </form>
      )}

      <div className="terminal-wrap">
        <TerminalView
          onReady={(c) => {
            controllerRef.current = c;
          }}
          onData={(data) => transportRef.current?.write(data)}
          onResize={(cols, rows) => transportRef.current?.resize(cols, rows)}
        />
      </div>
    </div>
  );
}