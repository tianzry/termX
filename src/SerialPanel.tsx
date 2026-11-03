import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./backend/client";
import { userVisibleError } from "./domain/sshErrors";
import {
  SERIAL_BAUD_RATES,
  SERIAL_BACKSPACE_OPTIONS,
  SERIAL_CHARSET_SUGGESTIONS,
  SERIAL_DATA_BITS,
  SERIAL_FLOW_CONTROL_OPTIONS,
  SERIAL_PARITY_OPTIONS,
  SERIAL_STOP_BITS,
  SERIAL_TEXT,
  isCustomBaudRate,
  isSerialConnectDisabled,
  isWindowsNamedPipePath,
  resolveSerialForm,
  serialFormErrors,
  serialPortDisplayName,
  toSerialConfig,
} from "./domain/serialFormConfig";
import type { SerialFormValues } from "./domain/serialFormConfig";
import { createSerialInput } from "./domain/serialInput";
import type { SerialInputController } from "./domain/serialInput";
import type {
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

const sectionLabelStyle = { display: "block", flex: 1, minWidth: 0 } as const;
const checkRowStyle = {
  alignItems: "center",
  justifyContent: "space-between",
} as const;
const checkboxStyle = { flex: "0 0 auto", width: 16, height: 16 } as const;

/**
 * 串口控制台侧栏：配置驱动渲染（字段顺序/标签/默认值/提示对齐 Netcatty
 * SerialConnectModal + SerialHostDetailsPanel），连接后保留 termX 的
 * 发送框与 DTR/RTS/BREAK 控制。
 *
 * 取舍：termX 无 host 模型，故不复刻「保存配置为主机」一组；自动登录字段来自
 * Netcatty 的主机编辑面板（连接弹窗没有），按其在编辑面板中的位置放在波特率
 * 之后、高级之前。命名管道后端 crate 不支持，明确报错而非假入口。
 */
export function SerialPanel({ bridge }: Props) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [form, setForm] = useState<SerialFormValues>(() => resolveSerialForm());
  const [baudRateText, setBaudRateText] = useState("115200");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [sid, setSid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [err, setErr] = useState("");
  const [sendText, setSendText] = useState("");
  const [autoLoginStatus, setAutoLoginStatus] = useState("");

  const unsubRef = useRef<UnlistenFn[]>([]);
  const inputRef = useRef<SerialInputController | null>(null);
  const sidRef = useRef<string | null>(null);

  const errors = serialFormErrors(form);
  const namedPipe = isWindowsNamedPipePath(form.port.trim());
  const connectDisabled = isSerialConnectDisabled(form);

  function patch(values: Partial<SerialFormValues>) {
    setForm((cur) => ({ ...cur, ...values }));
  }

  function teardown() {
    unsubRef.current.forEach((u) => u());
    unsubRef.current = [];
    inputRef.current?.reset();
    sidRef.current = null;
    bridge.detach();
    setSid(null);
  }

  useEffect(() => {
    void refreshPorts();
    // 卸载时释放监听与串口句柄，避免面板关闭后会话残留
    return () => {
      unsubRef.current.forEach((u) => u());
      if (sidRef.current) void api.serialClose(sidRef.current);
      inputRef.current?.reset();
      sidRef.current = null;
      bridge.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshPorts() {
    setLoadingPorts(true);
    setErr("");
    try {
      const list = await api.serialListPorts();
      setPorts(list);
      setForm((cur) => ({
        ...cur,
        port: cur.port || list[0]?.path || "",
      }));
    } catch (e) {
      setErr(userVisibleError(String(e)));
    } finally {
      setLoadingPorts(false);
    }
  }

  async function open() {
    if (errors.port) {
      setErr(errors.port);
      return;
    }
    if (errors.baudRate) {
      setErr(errors.baudRate);
      return;
    }
    if (sid) return;
    const sessionId = api.newSessionId();
    const config = toSerialConfig(form, { username, password });
    const input = createSerialInput({
      lineMode: form.lineMode,
      localEcho: form.localEcho,
      backspaceBehavior: form.backspaceBehavior,
      byteOrientedBackspace: form.byteOrientedBackspace,
    });
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
      const actualId = await api.serialOpen(form.port.trim(), config, sessionId);
      inputRef.current = input;
      bridge.attach({
        kind: "serial",
        write: (text) => {
          const chunk = input.feed(text);
          if (chunk.echo) {
            bridge.receive(new TextEncoder().encode(chunk.echo));
          }
          if (chunk.wire) void api.serialWrite(actualId, chunk.wire);
        },
        resize: () => {},
        close: () => {
          void api.serialClose(actualId);
        },
      });
      setSid(actualId);
      sidRef.current = actualId;
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
        <div className="sftp-connect serial-form">
          {/* ① 串口：标签 + 右侧刷新，Combobox 可手输，下方固定提示 + 非法红字 */}
          <div className="sftp-row" style={checkRowStyle}>
            <label htmlFor="serial-port" style={sectionLabelStyle}>
              {SERIAL_TEXT.port}
            </label>
            <button
              type="button"
              onClick={refreshPorts}
              disabled={loadingPorts || busy}
              style={{ flex: "0 0 auto" }}
            >
              {SERIAL_TEXT.refresh}
            </button>
          </div>
          <input
            id="serial-port"
            className="sftp-path"
            list="serial-port-options"
            placeholder={SERIAL_TEXT.selectPort}
            value={form.port}
            onChange={(e) => patch({ port: e.target.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="serial-port-options">
            {ports.map((p) => (
              <option key={p.path} value={p.path}>
                {p.manufacturer ? `${p.path}（${p.manufacturer}）` : p.path}
              </option>
            ))}
          </datalist>
          <div className="sftp-stat">{SERIAL_TEXT.namedPipeHint}</div>
          {ports.length === 0 && !loadingPorts && (
            <div className="sftp-stat">{SERIAL_TEXT.noPorts}</div>
          )}
          {errors.port && <div className="sftp-error">{errors.port}</div>}

          {/* ② 波特率：命名管道时隐藏；可自定义；非标准值提示 */}
          {!namedPipe && (
            <>
              <label htmlFor="serial-baud" style={sectionLabelStyle}>
                {SERIAL_TEXT.baudRate}
              </label>
              <input
                id="serial-baud"
                className="sftp-path"
                list="serial-baud-options"
                placeholder={SERIAL_TEXT.baudRatePlaceholder}
                value={baudRateText}
                onChange={(e) => {
                  const text = e.target.value;
                  setBaudRateText(text);
                  const n = Number.parseInt(text, 10);
                  patch({ baudRate: Number.isNaN(n) ? 0 : n });
                }}
                autoComplete="off"
                inputMode="numeric"
              />
              <datalist id="serial-baud-options">
                {SERIAL_BAUD_RATES.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
              {isCustomBaudRate(form.baudRate) && (
                <div className="sftp-stat">{SERIAL_TEXT.customBaudRate}</div>
              )}
              {errors.baudRate && <div className="sftp-error">{errors.baudRate}</div>}
            </>
          )}

          {/* ③ 自动登录：位置对齐 Netcatty 主机编辑面板（波特率之后、高级之前） */}
          <div className="sftp-row">
            <label style={sectionLabelStyle}>
              {SERIAL_TEXT.autoLoginUsername}
              <input
                placeholder={SERIAL_TEXT.autoLoginUsernamePlaceholder}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label style={sectionLabelStyle}>
              {SERIAL_TEXT.autoLoginPassword}
              <input
                type="password"
                placeholder={SERIAL_TEXT.autoLoginPasswordPlaceholder}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
          </div>

          {/* ④ 高级（默认收起）：硬件帧参数 + 终端选项 */}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="serial-advanced"
          >
            <span>{SERIAL_TEXT.advanced}</span>
            <span aria-hidden="true">{showAdvanced ? "▴" : "▾"}</span>
          </button>

          {showAdvanced && (
            <>
              {!namedPipe && (
                <>
                  <div className="sftp-row">
                    <label htmlFor="serial-data-bits" style={sectionLabelStyle}>
                      {SERIAL_TEXT.dataBits}
                      <select
                        id="serial-data-bits"
                        value={form.dataBits}
                        onChange={(e) =>
                          patch({ dataBits: Number(e.target.value) as 5 | 6 | 7 | 8 })
                        }
                      >
                        {SERIAL_DATA_BITS.map((bits) => (
                          <option key={bits} value={bits}>
                            {bits}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label htmlFor="serial-stop-bits" style={sectionLabelStyle}>
                      {SERIAL_TEXT.stopBits}
                      <select
                        id="serial-stop-bits"
                        value={form.stopBits}
                        onChange={(e) =>
                          patch({ stopBits: Number(e.target.value) as 1 | 1.5 | 2 })
                        }
                      >
                        {SERIAL_STOP_BITS.map((bits) => (
                          <option key={bits} value={bits}>
                            {bits}
                          </option>
                        ))}
                      </select>
                      {form.stopBits === 1.5 && (
                        <span className="sftp-stat" style={{ color: "#b8860b" }}>
                          {SERIAL_TEXT.stopBits15Warning}
                        </span>
                      )}
                    </label>
                  </div>

                  <label htmlFor="serial-parity" style={sectionLabelStyle}>
                    {SERIAL_TEXT.parity}
                    <select
                      id="serial-parity"
                      value={form.parity}
                      onChange={(e) =>
                        patch({ parity: e.target.value as SerialFormValues["parity"] })
                      }
                    >
                      {SERIAL_PARITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label htmlFor="serial-flow" style={sectionLabelStyle}>
                    {SERIAL_TEXT.flowControl}
                    <select
                      id="serial-flow"
                      value={form.flowControl}
                      onChange={(e) =>
                        patch({
                          flowControl: e.target.value as SerialFormValues["flowControl"],
                        })
                      }
                    >
                      {SERIAL_FLOW_CONTROL_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}

              {/* 终端选项（分隔线后的分组） */}
              <div style={{ borderTop: "1px solid #d6dce4", paddingTop: 8 }}>
                <label htmlFor="serial-backspace" style={sectionLabelStyle}>
                  {SERIAL_TEXT.backspaceBehavior}
                  <select
                    id="serial-backspace"
                    value={form.backspaceBehavior}
                    onChange={(e) =>
                      patch({
                        backspaceBehavior:
                          e.target.value === "ctrl-h" ? "ctrl-h" : "default",
                      })
                    }
                  >
                    {SERIAL_BACKSPACE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sftp-stat">{SERIAL_TEXT.backspaceBehaviorDesc}</div>

                <div className="sftp-row" style={checkRowStyle}>
                  <div style={{ flex: 1 }}>
                    <label htmlFor="serial-byte-backspace">
                      {SERIAL_TEXT.byteOrientedBackspace}
                    </label>
                    <div className="sftp-stat">
                      {SERIAL_TEXT.byteOrientedBackspaceDesc}
                    </div>
                  </div>
                  <input
                    id="serial-byte-backspace"
                    type="checkbox"
                    style={checkboxStyle}
                    checked={form.byteOrientedBackspace}
                    onChange={(e) => patch({ byteOrientedBackspace: e.target.checked })}
                  />
                </div>

                <div className="sftp-row" style={checkRowStyle}>
                  <div style={{ flex: 1 }}>
                    <label htmlFor="serial-local-echo">{SERIAL_TEXT.localEcho}</label>
                    <div className="sftp-stat">{SERIAL_TEXT.localEchoDesc}</div>
                  </div>
                  <input
                    id="serial-local-echo"
                    type="checkbox"
                    style={checkboxStyle}
                    checked={form.localEcho}
                    onChange={(e) => patch({ localEcho: e.target.checked })}
                  />
                </div>

                <div className="sftp-row" style={checkRowStyle}>
                  <div style={{ flex: 1 }}>
                    <label htmlFor="serial-line-mode">{SERIAL_TEXT.lineMode}</label>
                    <div className="sftp-stat">{SERIAL_TEXT.lineModeDesc}</div>
                  </div>
                  <input
                    id="serial-line-mode"
                    type="checkbox"
                    style={checkboxStyle}
                    checked={form.lineMode}
                    onChange={(e) => patch({ lineMode: e.target.checked })}
                  />
                </div>

                <label htmlFor="serial-charset" style={sectionLabelStyle}>
                  {SERIAL_TEXT.charset}
                  <input
                    id="serial-charset"
                    list="serial-charset-options"
                    placeholder={SERIAL_TEXT.charsetPlaceholder}
                    value={form.charset}
                    onChange={(e) => patch({ charset: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <datalist id="serial-charset-options">
                  {SERIAL_CHARSET_SUGGESTIONS.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            </>
          )}

          <div className="sftp-row">
            <button className="serial-primary" onClick={open} disabled={busy || connectDisabled}>
              {SERIAL_TEXT.connect}
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
            已打开 {serialPortDisplayName(form.port)} @ {form.baudRate}（{sid}）
          </div>
          {autoLoginStatus && <div className="sftp-stat">{autoLoginStatus}</div>}
        </div>
      )}
      {err && <div className="sftp-error">{err}</div>}
    </div>
  );
}
