import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./backend/client";
import type { SerialConfig, TermBridge } from "./backend/client";

interface Props {
  bridge: TermBridge;
}

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/** 串口控制台侧栏：端口下拉 + 线路参数表单 + open/close + DTR/RTS/BREAK + 发送数据。 */
export function SerialPanel({ bridge }: Props) {
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [baudRate, setBaudRate] = useState("115200");
  const [dataBits, setDataBits] = useState("8");
  const [parity, setParity] = useState("none");
  const [stopBits, setStopBits] = useState("1");
  const [flowControl, setFlowControl] = useState("none");

  const [sid, setSid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sendText, setSendText] = useState("");

  const unsubRef = useRef<UnlistenFn[]>([]);

  function teardown() {
    unsubRef.current.forEach((u) => u());
    unsubRef.current = [];
    bridge.detach();
    setSid(null);
  }

  useEffect(() => {
    void refreshPorts();
    // 组件卸载时清理监听并解除终端路由
    return () => unsubRef.current.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshPorts() {
    setBusy(true);
    setErr("");
    try {
      const list = await api.serialListPorts();
      setPorts(list);
      setPort((cur) => cur || list[0] || "");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    if (!port) {
      setErr("请先刷新并选择串口（无硬件时列表为空属正常）");
      return;
    }
    if (sid) return;
    const sessionId = api.newSessionId();
    const config: SerialConfig = {
      baud_rate: Number(baudRate) || 115200,
      data_bits: Number(dataBits) || 8,
      parity,
      stop_bits: Number(stopBits) || 1,
      flow_control: flowControl,
    };
    setBusy(true);
    setErr("");
    try {
      // 先注册监听再 open：串口 data 事件在 open 返回后即可能到达。
      unsubRef.current = [
        await api.onSerialData(sessionId, (bytes) => bridge.receive(bytes)),
        await api.onSerialClose(sessionId, teardown),
      ];
      const actualId = await api.serialOpen(port, config, sessionId);
      bridge.attach({
        kind: "serial",
        write: (text) => {
          void api.serialWrite(actualId, text);
        },
        resize: () => {},
        close: () => {
          void api.serialClose(actualId);
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
      await api.serialClose(sid);
    } catch {
      /* 忽略关闭失败 */
    }
    teardown();
  }

  async function send() {
    if (!sid || !sendText) return;
    setBusy(true);
    setErr("");
    try {
      const text = sendText.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      await api.serialWrite(sid, text);
      setSendText("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function control(fn: () => Promise<void>) {
    if (!sid) return;
    setBusy(true);
    setErr("");
    try {
      await fn();
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
            <select value={port} onChange={(e) => setPort(e.target.value)}>
              <option value="">选择串口…</option>
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button onClick={refreshPorts} disabled={busy}>
              刷新
            </button>
          </div>
          <div className="sftp-row">
            <label>
              波特率
              <select
                value={baudRate}
                onChange={(e) => setBaudRate(e.target.value)}
              >
                {BAUDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label>
              数据位
              <select value={dataBits} onChange={(e) => setDataBits(e.target.value)}>
                {[5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              校验
              <select value={parity} onChange={(e) => setParity(e.target.value)}>
                <option value="none">none</option>
                <option value="odd">odd</option>
                <option value="even">even</option>
              </select>
            </label>
          </div>
          <div className="sftp-row">
            <label>
              停止位
              <select value={stopBits} onChange={(e) => setStopBits(e.target.value)}>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </label>
            <label>
              流控
              <select
                value={flowControl}
                onChange={(e) => setFlowControl(e.target.value)}
              >
                <option value="none">none</option>
                <option value="software">software</option>
                <option value="hardware">hardware</option>
              </select>
            </label>
          </div>
          <div className="sftp-row">
            <button onClick={open} disabled={busy || !port}>
              打开串口
            </button>
          </div>
        </div>
      ) : (
        <div className="sftp-body">
          <div className="sftp-toolbar">
            <input
              className="sftp-path"
              placeholder="发送数据（\\n 转回车）"
              value={sendText}
              onChange={(e) => setSendText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <button onClick={send} disabled={busy || !sendText}>
              发送
            </button>
          </div>
          <div className="sftp-toolbar">
            <button onClick={() => control(() => api.serialSetDtr(sid, true))} disabled={busy}>
              DTR 高
            </button>
            <button onClick={() => control(() => api.serialSetDtr(sid, false))} disabled={busy}>
              DTR 低
            </button>
            <button onClick={() => control(() => api.serialSetRts(sid, true))} disabled={busy}>
              RTS 高
            </button>
            <button onClick={() => control(() => api.serialSetRts(sid, false))} disabled={busy}>
              RTS 低
            </button>
            <button onClick={() => control(() => api.serialSendBreak(sid))} disabled={busy}>
              BREAK
            </button>
            <button onClick={close} disabled={busy}>
              关闭
            </button>
          </div>
          <div className="sftp-stat">
            已打开 {port} @ {baudRate}（{sid}）
          </div>
        </div>
      )}
      {err && <div className="sftp-error">{err}</div>}
    </div>
  );
}