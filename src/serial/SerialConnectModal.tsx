/**
 * 串口连接弹窗（1:1 对齐 Netcatty `components/SerialConnectModal.tsx`）：
 * 标题「连接串口」+ 描述、串口选择（刷新 / 可手输 / 清除）、波特率、
 * 「高级」折叠组（数据位 / 停止位 / 校验位 / 流控制 / 终端选项 / 字符编码）、
 * 底部取消 + 连接。
 *
 * 与 Netcatty 的取舍：
 * - 「保存为主机」已支持：勾选后连接前写入串口主机档案（protocol="serial"），
 *   可从 Vault 主机列表重新打开；保存失败只提示、不阻断本次连接。
 * - 自动登录属于 Netcatty 主机编辑面板，不在连接弹窗内；termX 同样不放入。
 * - 命名管道后端 crate 无法打开，这里仍明确禁用 / 报错。
 */

import { useEffect, useRef, useState } from "react";
import * as api from "../backend/client";
import { Icon } from "../ui/icons";
import { userVisibleError } from "../domain/sshErrors";
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
  serialProfileSnapshot,
  toSerialConfig,
} from "../domain/serialFormConfig";
import type {
  SerialFormValues,
  SerialProfileSnapshot,
} from "../domain/serialFormConfig";
import type { SerialSessionConfig } from "../workspaceModel";
import "./serial.css";

interface Props {
  open: boolean;
  onClose: () => void;
  /** saveHost 存在 = 用户勾选「保存为主机」，连接前先建凭据 / 档案。 */
  onConnect: (
    session: SerialSessionConfig,
    saveHost?: { name: string; snapshot: SerialProfileSnapshot },
  ) => void;
}

export function SerialConnectModal({ open, onClose, onConnect }: Props) {
  const [ports, setPorts] = useState<api.SerialPortInfo[]>([]);
  const [form, setForm] = useState<SerialFormValues>(() => resolveSerialForm());
  const [baudText, setBaudText] = useState("115200");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saveHost, setSaveHost] = useState(false);
  const [hostName, setHostName] = useState("");
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [err, setErr] = useState("");
  const aliveRef = useRef(true);

  const errors = serialFormErrors(form);
  const namedPipe = isWindowsNamedPipePath(form.port.trim());
  const connectDisabled = isSerialConnectDisabled(form);

  function patch(values: Partial<SerialFormValues>) {
    setForm((cur) => ({ ...cur, ...values }));
  }

  async function refreshPorts() {
    setLoadingPorts(true);
    setErr("");
    try {
      const list = await api.serialListPorts();
      if (!aliveRef.current) return;
      setPorts(list);
      setForm((cur) => ({
        ...cur,
        port: cur.port || list[0]?.path || "",
      }));
    } catch (e) {
      if (aliveRef.current) setErr(userVisibleError(String(e)));
    } finally {
      if (aliveRef.current) setLoadingPorts(false);
    }
  }

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setSaveHost(false);
    setHostName("");
    void refreshPorts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function commit() {
    if (connectDisabled) {
      setErr(errors.port ?? errors.baudRate ?? "请检查串口参数");
      return;
    }
    const port = form.port.trim();
    const trimmedHostName = hostName.trim();
    onConnect(
      {
        port,
        config: toSerialConfig(form),
        lineMode: form.lineMode,
        localEcho: form.localEcho,
        backspaceBehavior: form.backspaceBehavior,
        byteOrientedBackspace: form.byteOrientedBackspace,
      },
      saveHost
        ? {
            name: trimmedHostName || `串口 ${port}`,
            snapshot: serialProfileSnapshot(form),
          }
        : undefined,
    );
  }

  return (
    <div
      className="serial-modal-mask"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="serial-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="serial-modal-title"
      >
        <header className="serial-modal-head">
          <h2 id="serial-modal-title">
            <Icon name="usb" size={18} />
            {SERIAL_TEXT.title}
          </h2>
          <button
            type="button"
            className="serial-modal-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </button>
          <p className="serial-modal-desc">{SERIAL_TEXT.description}</p>
        </header>

        <div className="serial-modal-body">
          <div className="serial-field">
            <div className="serial-field-head">
              <label htmlFor="serial-port">{SERIAL_TEXT.port}</label>
              <button
                type="button"
                className="serial-refresh"
                onClick={() => void refreshPorts()}
                disabled={loadingPorts}
              >
                <Icon name="refresh" size={12} />
                {SERIAL_TEXT.refresh}
              </button>
            </div>
            <div className="serial-combo">
              <Icon name="usb" size={14} />
              <input
                id="serial-port"
                list="serial-port-options"
                placeholder={SERIAL_TEXT.selectPort}
                value={form.port}
                onChange={(e) => patch({ port: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              {form.port && (
                <button
                  type="button"
                  className="serial-combo-clear"
                  aria-label="清除串口"
                  onClick={() => patch({ port: "" })}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
              <Icon name="chevron-down" size={14} />
            </div>
            <datalist id="serial-port-options">
              {ports.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.manufacturer ? `${p.path}（${p.manufacturer}）` : p.path}
                </option>
              ))}
            </datalist>
            <p className="serial-hint">{SERIAL_TEXT.namedPipeHint}</p>
            {ports.length === 0 && !loadingPorts && (
              <p className="serial-hint">{SERIAL_TEXT.noPorts}</p>
            )}
            {errors.port && <p className="serial-error">{errors.port}</p>}
          </div>

          {!namedPipe && (
            <div className="serial-field">
              <label htmlFor="serial-baud">{SERIAL_TEXT.baudRate}</label>
              <div className="serial-combo">
                <input
                  id="serial-baud"
                  type="text"
                  inputMode="numeric"
                  list="serial-baud-options"
                  placeholder={SERIAL_TEXT.baudRatePlaceholder}
                  value={baudText}
                  onChange={(e) => {
                    const text = e.target.value;
                    setBaudText(text);
                    const parsed = parseInt(text, 10);
                    patch({ baudRate: Number.isNaN(parsed) ? 0 : parsed });
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                {baudText && (
                  <button
                    type="button"
                    className="serial-combo-clear"
                    aria-label="清除波特率"
                    onClick={() => {
                      setBaudText("");
                      patch({ baudRate: 0 });
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
                <Icon name="chevron-down" size={14} />
              </div>
              <datalist id="serial-baud-options">
                {SERIAL_BAUD_RATES.map((rate) => (
                  <option key={rate} value={String(rate)} />
                ))}
              </datalist>
              {isCustomBaudRate(form.baudRate) && !errors.baudRate && (
                <p className="serial-hint">{SERIAL_TEXT.customBaudRate}</p>
              )}
              {errors.baudRate && <p className="serial-error">{errors.baudRate}</p>}
            </div>
          )}

          <div className="serial-advanced">
            <button
              type="button"
              className="serial-advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span>{SERIAL_TEXT.advanced}</span>
              <Icon
                name="chevron-down"
                size={14}
                className={showAdvanced ? "serial-chevron-up" : undefined}
              />
            </button>

            {showAdvanced && (
              <div className="serial-advanced-body">
                {!namedPipe && (
                  <>
                    <div className="serial-grid2">
                      <div className="serial-field">
                        <label htmlFor="serial-data-bits">{SERIAL_TEXT.dataBits}</label>
                        <select
                          id="serial-data-bits"
                          value={String(form.dataBits)}
                          onChange={(e) =>
                            patch({
                              dataBits: parseInt(e.target.value, 10) as 5 | 6 | 7 | 8,
                            })
                          }
                        >
                          {SERIAL_DATA_BITS.map((bits) => (
                            <option key={bits} value={String(bits)}>
                              {bits}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="serial-field">
                        <label htmlFor="serial-stop-bits">{SERIAL_TEXT.stopBits}</label>
                        <select
                          id="serial-stop-bits"
                          value={String(form.stopBits)}
                          onChange={(e) =>
                            patch({
                              stopBits: parseFloat(e.target.value) as 1 | 1.5 | 2,
                            })
                          }
                        >
                          {SERIAL_STOP_BITS.map((bits) => (
                            <option key={bits} value={String(bits)}>
                              {bits}
                            </option>
                          ))}
                        </select>
                        {form.stopBits === 1.5 && (
                          <p className="serial-warn">{SERIAL_TEXT.stopBits15Warning}</p>
                        )}
                      </div>
                    </div>

                    <div className="serial-field">
                      <label htmlFor="serial-parity">{SERIAL_TEXT.parity}</label>
                      <select
                        id="serial-parity"
                        value={form.parity}
                        onChange={(e) =>
                          patch({ parity: e.target.value as SerialFormValues["parity"] })
                        }
                      >
                        {SERIAL_PARITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="serial-field">
                      <label htmlFor="serial-flow">{SERIAL_TEXT.flowControl}</label>
                      <select
                        id="serial-flow"
                        value={form.flowControl}
                        onChange={(e) =>
                          patch({
                            flowControl: e.target.value as SerialFormValues["flowControl"],
                          })
                        }
                      >
                        {SERIAL_FLOW_CONTROL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                <div className="serial-terminal-options">
                  <div className="serial-field">
                    <label htmlFor="serial-backspace">{SERIAL_TEXT.backspaceBehavior}</label>
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
                      {SERIAL_BACKSPACE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="serial-hint">{SERIAL_TEXT.backspaceBehaviorDesc}</p>
                  </div>

                  <div className="serial-check-row">
                    <div>
                      <label htmlFor="serial-byte-backspace">
                        {SERIAL_TEXT.byteOrientedBackspace}
                      </label>
                      <p className="serial-hint">{SERIAL_TEXT.byteOrientedBackspaceDesc}</p>
                    </div>
                    <input
                      type="checkbox"
                      id="serial-byte-backspace"
                      checked={form.byteOrientedBackspace}
                      onChange={(e) => patch({ byteOrientedBackspace: e.target.checked })}
                    />
                  </div>

                  <div className="serial-check-row">
                    <div>
                      <label htmlFor="serial-local-echo">{SERIAL_TEXT.localEcho}</label>
                      <p className="serial-hint">{SERIAL_TEXT.localEchoDesc}</p>
                    </div>
                    <input
                      type="checkbox"
                      id="serial-local-echo"
                      checked={form.localEcho}
                      onChange={(e) => patch({ localEcho: e.target.checked })}
                    />
                  </div>

                  <div className="serial-check-row">
                    <div>
                      <label htmlFor="serial-line-mode">{SERIAL_TEXT.lineMode}</label>
                      <p className="serial-hint">{SERIAL_TEXT.lineModeDesc}</p>
                    </div>
                    <input
                      type="checkbox"
                      id="serial-line-mode"
                      checked={form.lineMode}
                      onChange={(e) => patch({ lineMode: e.target.checked })}
                    />
                  </div>

                  <div className="serial-field">
                    <label htmlFor="serial-charset">{SERIAL_TEXT.charset}</label>
                    <input
                      id="serial-charset"
                      type="text"
                      list="serial-charset-options"
                      placeholder={SERIAL_TEXT.charsetPlaceholder}
                      value={form.charset}
                      onChange={(e) => patch({ charset: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <datalist id="serial-charset-options">
                      {SERIAL_CHARSET_SUGGESTIONS.map((charset) => (
                        <option key={charset} value={charset} />
                      ))}
                    </datalist>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="serial-save-host">
            <div className="serial-check-row">
              <div>
                <label htmlFor="serial-save-host">{SERIAL_TEXT.saveHost}</label>
                <p className="serial-hint">{SERIAL_TEXT.saveHostDesc}</p>
              </div>
              <input
                type="checkbox"
                id="serial-save-host"
                checked={saveHost}
                onChange={(e) => setSaveHost(e.target.checked)}
              />
            </div>
            {saveHost && (
              <div className="serial-field">
                <label htmlFor="serial-host-name">{SERIAL_TEXT.hostName}</label>
                <input
                  id="serial-host-name"
                  type="text"
                  placeholder={SERIAL_TEXT.hostNamePlaceholder}
                  value={hostName}
                  onChange={(e) => setHostName(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
          </div>

          {err && <p className="serial-error">{err}</p>}
        </div>

        <footer className="serial-modal-foot">
          <button type="button" className="serial-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="serial-connect"
            disabled={connectDisabled}
            onClick={commit}
          >
            <Icon name={saveHost ? "save" : "cpu"} size={14} />
            {saveHost ? SERIAL_TEXT.connectAndSave : SERIAL_TEXT.connect}
          </button>
        </footer>
      </div>
    </div>
  );
}
