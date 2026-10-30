import { useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./backend/client";
import type { TermBridge } from "./backend/client";

interface Props {
  bridge: TermBridge;
}

/** Telnet 侧栏：host/port/换行风格 + open/close + 发送一行 + 回显状态。 */
export function TelnetPanel({ bridge }: Props) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("23");
  const [inputNewline, setInputNewline] = useState("crlf");

  const [sid, setSid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [echo, setEcho] = useState(false);
  const [lineText, setLineText] = useState("");

  const unsubRef = useRef<UnlistenFn[]>([]);

  function teardown() {
    unsubRef.current.forEach((u) => u());
    unsubRef.current = [];
    bridge.detach();
    setSid(null);
    setEcho(false);
  }

  async function open() {
    if (!host.trim()) {
      setErr("请填写 host");
      return;
    }
    if (sid) return;
    const size = bridge.size() ?? { cols: 80, rows: 24 };
    const sessionId = api.newSessionId();
    setBusy(true);
    setErr("");
    try {
      // 先注册监听再 open：telnet 握手期间的 echo/数据事件才不丢。
      unsubRef.current = [
        await api.onTelnetData(sessionId, (bytes) => bridge.receive(bytes)),
        await api.onTelnetEcho(sessionId, (enabled) => setEcho(enabled)),
        await api.onTelnetClose(sessionId, teardown),
      ];
      const actualId = await api.telnetOpen(
        host.trim(),
        Number(port) || 23,
        size.cols,
        size.rows,
        inputNewline,
        sessionId,
      );
      bridge.attach({
        kind: "telnet",
        write: (text) => {
          void api.telnetWrite(actualId, text);
        },
        resize: (cols, rows) => {
          void api.telnetResize(actualId, cols, rows);
        },
        close: () => {
          void api.telnetClose(actualId);
        },
      });
      setSid(actualId);
    } catch (e) {
      teardown();
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!sid) return;
    try {
      await api.telnetClose(sid);
    } catch {
      /* 忽略关闭失败 */
    }
    teardown();
  }

  async function sendLine() {
    if (!sid || !lineText) return;
    setBusy(true);
    setErr("");
    try {
      await api.telnetWriteLine(sid, lineText);
      setLineText("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sftp-panel">
      {!sid ? (
        <div className="sftp-connect">
          <div className="sftp-row">
            <input
              placeholder="host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
            <input
              placeholder="port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <div className="sftp-row">
            <label>
              换行风格
              <select
                value={inputNewline}
                onChange={(e) => setInputNewline(e.target.value)}
              >
                <option value="crlf">crlf</option>
                <option value="lf">lf</option>
                <option value="cr">cr</option>
              </select>
            </label>
          </div>
          <div className="sftp-row">
            <button onClick={open} disabled={busy || !host.trim()}>
              连接 Telnet
            </button>
          </div>
        </div>
      ) : (
        <div className="sftp-body">
          <div className="sftp-toolbar">
            <input
              className="sftp-path"
              placeholder="发送一行（自动附换行）"
              value={lineText}
              onChange={(e) => setLineText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendLine()}
            />
            <button onClick={sendLine} disabled={busy || !lineText}>
              发送
            </button>
          </div>
          <div className="sftp-toolbar">
            <button onClick={close} disabled={busy}>
              关闭
            </button>
          </div>
          <div className="sftp-stat">
            已连接 {host}:{port} · 本地回显 {echo ? "开" : "关"}（{sid}）
          </div>
        </div>
      )}
      {err && <div className="sftp-error">{err}</div>}
    </div>
  );
}