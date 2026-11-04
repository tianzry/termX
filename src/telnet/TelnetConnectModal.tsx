/**
 * Telnet 连接弹窗。
 *
 * Netcatty 的 Telnet 不是独立弹窗：它是 host 的协议之一，经由
 * QuickConnectWizard（模态三步：协议卡片 → 用户名 → 认证）连接。termX 保留
 * 独立「Telnet」入口，因此复用串口弹窗的壳（同一套 Netcatty 对话框骨架：
 * 标题 + 描述、字段、可折叠高级、底部取消 / 连接），单步完成 host / port。
 * 用户名 / 密码对齐 Netcatty host 表单的凭据字段（可留空；留空则在终端内
 * 交互登录），非空时后端检测提示符并自动应答。
 */

import { useEffect, useState } from "react";
import { Icon } from "../ui/icons";
import type { TelnetSessionConfig } from "../workspaceModel";
import {
  TELNET_NEWLINE_OPTIONS,
  TELNET_TEXT,
  isTelnetConnectDisabled,
  resolveTelnetForm,
  telnetFormErrors,
  toTelnetSession,
} from "./telnetFormConfig";
import type { TelnetFormValues } from "./telnetFormConfig";
import "../serial/serial.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onConnect: (session: TelnetSessionConfig) => void;
}

export function TelnetConnectModal({ open, onClose, onConnect }: Props) {
  const [form, setForm] = useState<TelnetFormValues>(() => resolveTelnetForm());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);

  const errors = telnetFormErrors(form);
  const connectDisabled = isTelnetConnectDisabled(form);

  function patch(values: Partial<TelnetFormValues>) {
    setForm((cur) => ({ ...cur, ...values }));
  }

  useEffect(() => {
    if (!open) return;
    setTouched(false);
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
    setTouched(true);
    if (connectDisabled) return;
    onConnect(toTelnetSession(form));
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
        aria-labelledby="telnet-modal-title"
      >
        <header className="serial-modal-head">
          <h2 id="telnet-modal-title">
            <Icon name="network" size={18} />
            {TELNET_TEXT.title}
          </h2>
          <button
            type="button"
            className="serial-modal-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </button>
          <p className="serial-modal-desc">{TELNET_TEXT.description}</p>
        </header>

        <div className="serial-modal-body">
          <div className="serial-field">
            <label htmlFor="telnet-host">{TELNET_TEXT.host}</label>
            <div className="serial-combo">
              <Icon name="globe" size={14} />
              <input
                id="telnet-host"
                type="text"
                placeholder={TELNET_TEXT.hostPlaceholder}
                value={form.host}
                onChange={(e) => {
                  setTouched(true);
                  patch({ host: e.target.value });
                }}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            {touched && errors.host && <p className="serial-error">{errors.host}</p>}
          </div>

          <div className="serial-field">
            <label htmlFor="telnet-port">{TELNET_TEXT.port}</label>
            <div className="serial-combo">
              <input
                id="telnet-port"
                type="text"
                inputMode="numeric"
                placeholder={TELNET_TEXT.portPlaceholder}
                value={form.port}
                onChange={(e) => {
                  setTouched(true);
                  patch({ port: e.target.value });
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {touched && errors.port && <p className="serial-error">{errors.port}</p>}
          </div>

          <div className="serial-field">
            <label htmlFor="telnet-username">{TELNET_TEXT.username}</label>
            <div className="serial-combo">
              <Icon name="user" size={14} />
              <input
                id="telnet-username"
                type="text"
                placeholder={TELNET_TEXT.usernamePlaceholder}
                value={form.username}
                onChange={(e) => patch({ username: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="serial-field">
            <label htmlFor="telnet-password">{TELNET_TEXT.password}</label>
            <div className="serial-combo">
              <Icon name="lock" size={14} />
              <input
                id="telnet-password"
                type="password"
                placeholder={TELNET_TEXT.passwordPlaceholder}
                value={form.password}
                onChange={(e) => patch({ password: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="serial-hint">{TELNET_TEXT.credentialsHint}</p>
          </div>

          <div className="serial-advanced">
            <button
              type="button"
              className="serial-advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span>{TELNET_TEXT.advanced}</span>
              <Icon
                name="chevron-down"
                size={14}
                className={showAdvanced ? "serial-chevron-up" : undefined}
              />
            </button>

            {showAdvanced && (
              <div className="serial-advanced-body">
                <div className="serial-field">
                  <label htmlFor="telnet-newline">{TELNET_TEXT.newline}</label>
                  <select
                    id="telnet-newline"
                    value={form.inputNewline}
                    onChange={(e) =>
                      patch({
                        inputNewline: e.target.value as TelnetFormValues["inputNewline"],
                      })
                    }
                  >
                    {TELNET_NEWLINE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="serial-hint">{TELNET_TEXT.newlineDesc}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <footer className="serial-modal-foot">
          <button type="button" className="serial-cancel" onClick={onClose}>
            {TELNET_TEXT.cancel}
          </button>
          <button
            type="button"
            className="serial-connect"
            disabled={connectDisabled}
            onClick={commit}
          >
            <Icon name="network" size={14} />
            {TELNET_TEXT.connect}
          </button>
        </footer>
      </div>
    </div>
  );
}
