import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";
import {
  BAUD_RATES,
  CHARSETS,
  isValidBaudRate,
  validatePortPath,
} from "./domain/serialValidate";
import type {
  SerialConfig,
  SerialPortInfo,
  TermBridge,
} from "./backend/client";

interface Props {
  bridge: TermBridge;
}

const AUTO_LOGIN_STATUS_TEXT: Record<string, string> = {
  complete: "自动登录完成",
  cancelled: "自动登录已取消（检测到手动输入）",
  incomplete: "自动登录未完成（超时或出现无法应答的提示符）",
};

/** 串口控制台侧栏：端口下拉（含厂商）+ 线路参数表单 + open/close + DTR/RTS/BREAK + 发送数据。 */
export function SerialPanel({ bridge }: Props) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [port, setPort] = useState("");
  const [manualPort, setManualPort] = useState(false);
  const [baudRate, setBaudRate] = useState("115200");
  const [customBaud, setCustomBaud] = useState(false);
  const [dataBits, setDataBits] = useState("8");
  const [parity, setParity] = useState("none");
  const [stopBits, setStopBits] = useState("1");
  const [flowControl, setFlowControl] = useState("none");
  const [charset, setCharset] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [sid, setSid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sendText, setSendText] = useState("");
  const [autoLoginStatus, setAutoLoginStatus] = useState("");

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
      setPort((cur) => cur || list[0]?.path || "");
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    const targetPort = port.trim();
    if (!targetPort) {
      setErr("请先刷新并选择串口（无硬件时列表为空属正常）");
      return;
    }
    const portErr = validatePortPath(targetPort);
    if (portErr) {
      setErr(portErr);
      return;
    }
    if (!isValidBaudRate(baudRate)) {
      setErr("波特率必须是正整数");
      return;
    }
    if (sid) return;
    const sessionId = api.newSessionId();
    const autoLogin = username.trim() !== "" || password !== "";
    const config: SerialConfig = {
      baud_rate: Number(baudRate),
      data_bits: Number(dataBits) || 8,
      parity,
      stop_bits: Number(stopBits) || 1,
      flow_control: flowControl,
      charset,
      ...(autoLogin ? { username: username.trim(), password } : {}),
    };
    setBusy(true);
    setErr("");
    setAutoLoginStatus("");
    try {
      // 先注册监听再 open：串口 data 事件在 open 返回后即可能到达。
      unsubRef.current = [
        await api.onSerialData(sessionId, (bytes) => bridge.receive(bytes)),
        await api.onSerialClose(sessionId, teardown),
        await api.onSerialAutoLogin(sessionId, (status) =>
          setAutoLoginStatus(AUTO_LOGIN_STATUS_TEXT[status] ?? status),
        ),
      ];
      const actualId = await api.serialOpen(targetPort, config, sessionId);
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
      setErr(userVisibleError(String(e)));
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
      setErr(userVisibleError(String(e)));
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
      setErr(userVisibleError(String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sftp-panel">
      {!sid ? (
        <div className="sftp-connect">
          <div className="sftp-row">
            {manualPort ? (
              <input
                className="sftp-path"
                placeholder="COM3 或 /dev/ttyUSB0"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            ) : (
              <select value={port} onChange={(e) => setPort(e.target.value)}>
                <option value="">选择串口…</option>
                {ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.manufacturer ? `${p.path}（${p.manufacturer}）` : p.path}
                  </option>
                ))}
              </select>
            )}
            <button onClick={refreshPorts} disabled={busy}>
              刷新
            </button>
            <button
              onClick={() => {
                setManualPort(!manualPort);
                setPort("");
              }}
              disabled={busy}
            >
              {manualPort ? "列表选择" : "手动输入"}
            </button>
          </div>
          <div className="sftp-row">
            <label>
              波特率
              <select
                value={customBaud ? "__custom__" : baudRate}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setCustomBaud(true);
                  } else {
                    setCustomBaud(false);
                    setBaudRate(e.target.value);
                  }
                }}
              >
                {BAUD_RATES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
                <option value="__custom__">自定义…</option>
              </select>
            </label>
            {customBaud && (
              <input
                className="sftp-path"
                placeholder="正整数"
                value={baudRate}
                onChange={(e) => setBaudRate(e.target.value)}
              />
            )}
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
                <option value="mark">mark</option>
                <option value="space">space</option>
              </select>
            </label>
          </div>
          <div className="sftp-row">
            <label>
              停止位
              <select value={stopBits} onChange={(e) => setStopBits(e.target.value)}>
                <option value="1">1</option>
                <option value="1.5">1.5</option>
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
                <option value="software">software（XON/XOFF）</option>
                <option value="hardware">hardware（RTS/CTS）</option>
              </select>
            </label>
            <label>
              字符集
              <select value={charset} onChange={(e) => setCharset(e.target.value)}>
                {CHARSETS.map((c) => (
                  <option key={c || "__passthrough__"} value={c}>
                    {c || "透传（不转码）"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(parity === "mark" || parity === "space") && (
            <div className="sftp-stat">
              mark/space：Windows 原生支持，Linux 走 CMSPAR，macOS 不支持。
            </div>
          )}
          {stopBits === "1.5" && (
            <div className="sftp-stat">
              1.5 停止位仅 Windows 支持，且通常仅与 5 数据位组合有效（其余组合系统会拒绝）；其他平台打开时会报错。
            </div>
          )}
          <div className="sftp-row">
            <label>
              自动登录用户名
              <input
                placeholder="留空则不启用"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                placeholder="可为空（空密码设备）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
          <div className="sftp-row">
            <button onClick={open} disabled={busy || !port.trim()}>
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
          {autoLoginStatus && <div className="sftp-stat">{autoLoginStatus}</div>}
        </div>
      )}
      {err && <div className="sftp-error">{err}</div>}
    </div>
  );
}
