/**
 * 串口主机编辑面板（对齐 Netcatty SerialHostDetailsPanel 的串口字段部分）。
 *
 * 只编辑名称与串口参数：协议固定 serial、host = 串口路径、port 固定 0，
 * 凭据 / 分组 / 其它 SSH 字段沿用旧档案。新建串口主机仍走连接弹窗的
 * 「保存为主机」，这里不提供独立新建入口（不新增独立页面）。
 */
import { useEffect, useState } from "react";
import * as api from "../backend/client";
import type { Profile } from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  SERIAL_BAUD_RATES,
  SERIAL_BACKSPACE_OPTIONS,
  SERIAL_CHARSET_SUGGESTIONS,
  SERIAL_DATA_BITS,
  SERIAL_FLOW_CONTROL_OPTIONS,
  SERIAL_PARITY_OPTIONS,
  SERIAL_STOP_BITS,
  isCustomBaudRate,
  serialFormErrors,
  serialFormFromProfile,
  serialProfileSnapshot,
} from "../domain/serialFormConfig";
import type { SerialFormValues } from "../domain/serialFormConfig";
import { Icon } from "../ui/icons";
import "./serial.css";

interface Props {
  initial: Profile;
  onClose: () => void;
  onSaved: (profile: Profile) => void;
}

export function SerialHostPanel({ initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial.name);
  const [form, setForm] = useState<SerialFormValues>(() =>
    serialFormFromProfile(initial),
  );
  const [baudText, setBaudText] = useState(String(initial.serial_baud ?? 115200));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const errors = serialFormErrors(form);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function patch(values: Partial<SerialFormValues>) {
    setForm((cur) => ({ ...cur, ...values }));
  }

  async function save() {
    if (busy) return;
    const port = form.port.trim();
    const error = !name.trim()
      ? "请输入名称"
      : errors.port ?? errors.baudRate;
    if (error) {
      setErr(error);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const next: Profile = {
        ...initial,
        name: name.trim(),
        host: port,
        port: 0,
        protocol: "serial",
        ...serialProfileSnapshot(form),
      };
      await api.updateProfile(next);
      onSaved(next);
    } catch (e) {
      setErr(userVisibleError(String(e)));
      setBusy(false);
    }
  }

  return (
    <aside
      className="vault-composer serial-host-panel"
      data-section="serial-host-panel"
    >
      <header className="vault-composer-head">
        <div className="vault-composer-heading">
          <span className="vault-composer-title">编辑串口主机</span>
          <span className="vault-composer-sub">{initial.name}</span>
        </div>
        <div className="vault-composer-head-actions">
          <button className="nc-icon-btn" title="关闭面板" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <div className="vault-composer-body">
        {err && <div className="vault-composer-err">{err}</div>}

        <div className="serial-panel-fields">
          <div className="serial-field">
            <label htmlFor="serial-panel-name">名称</label>
            <input
              id="serial-panel-name"
              value={name}
              placeholder={`串口 ${form.port.trim()}`}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="serial-field">
            <label htmlFor="serial-panel-port">串口</label>
            <input
              id="serial-panel-port"
              value={form.port}
              placeholder="例如 COM3 或 /dev/ttyUSB0"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ port: e.target.value })}
            />
            {errors.port && <p className="serial-error">{errors.port}</p>}
          </div>

          <div className="serial-field">
            <label htmlFor="serial-panel-baud">波特率</label>
            <input
              id="serial-panel-baud"
              type="text"
              inputMode="numeric"
              list="serial-panel-baud-options"
              value={baudText}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                const text = e.target.value;
                setBaudText(text);
                const parsed = parseInt(text, 10);
                patch({ baudRate: Number.isNaN(parsed) ? 0 : parsed });
              }}
            />
            <datalist id="serial-panel-baud-options">
              {SERIAL_BAUD_RATES.map((rate) => (
                <option key={rate} value={String(rate)} />
              ))}
            </datalist>
            {isCustomBaudRate(form.baudRate) && !errors.baudRate && (
              <p className="serial-hint">使用自定义波特率</p>
            )}
            {errors.baudRate && <p className="serial-error">{errors.baudRate}</p>}
          </div>

          <div className="serial-grid2">
            <div className="serial-field">
              <label htmlFor="serial-panel-data-bits">数据位</label>
              <select
                id="serial-panel-data-bits"
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
              <label htmlFor="serial-panel-stop-bits">停止位</label>
              <select
                id="serial-panel-stop-bits"
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
            </div>
          </div>

          <div className="serial-field">
            <label htmlFor="serial-panel-parity">校验位</label>
            <select
              id="serial-panel-parity"
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
            <label htmlFor="serial-panel-flow">流控制</label>
            <select
              id="serial-panel-flow"
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

          <div className="serial-field">
            <label htmlFor="serial-panel-backspace">回退键</label>
            <select
              id="serial-panel-backspace"
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
          </div>

          <div className="serial-check-row">
            <label htmlFor="serial-panel-byte-backspace">按字节退格</label>
            <input
              type="checkbox"
              id="serial-panel-byte-backspace"
              checked={form.byteOrientedBackspace}
              onChange={(e) =>
                patch({ byteOrientedBackspace: e.target.checked })
              }
            />
          </div>

          <div className="serial-check-row">
            <label htmlFor="serial-panel-local-echo">强制本地回显</label>
            <input
              type="checkbox"
              id="serial-panel-local-echo"
              checked={form.localEcho}
              onChange={(e) => patch({ localEcho: e.target.checked })}
            />
          </div>

          <div className="serial-check-row">
            <label htmlFor="serial-panel-line-mode">行模式</label>
            <input
              type="checkbox"
              id="serial-panel-line-mode"
              checked={form.lineMode}
              onChange={(e) => patch({ lineMode: e.target.checked })}
            />
          </div>

          <div className="serial-field">
            <label htmlFor="serial-panel-charset">字符编码</label>
            <input
              id="serial-panel-charset"
              type="text"
              list="serial-panel-charset-options"
              placeholder="字符集（例如 UTF-8）"
              value={form.charset}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ charset: e.target.value })}
            />
            <datalist id="serial-panel-charset-options">
              {SERIAL_CHARSET_SUGGESTIONS.map((charset) => (
                <option key={charset} value={charset} />
              ))}
            </datalist>
          </div>
        </div>
      </div>

      <footer className="vault-composer-foot">
        <button
          className="vault-secondary-btn"
          disabled={busy}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="vault-new-btn"
          disabled={busy}
          onClick={() => void save()}
        >
          <Icon name="save" size={14} />
          保存
        </button>
      </footer>
    </aside>
  );
}
