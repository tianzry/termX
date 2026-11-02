/**
 * 连接认证重试弹窗（移植自 netcatty/components/terminal/TerminalAuthDialog.tsx）。
 *
 * 对齐要点：
 * - 密码 / SSH 密钥两个 tab；
 * - 认证失败提示条（authRetryMessage）；
 * - 用户名、密码、密钥选择、passphrase；
 * - Enter 直接提交，“继续”是主操作，“关闭”取消连接。
 */
import { useState, type KeyboardEvent } from "react";
import { Icon } from "../ui/icons";

export type TerminalAuthMethod = "password" | "key";

/** 可选的已保存密钥凭据（termX 侧把 credential 直接当作 netcatty 的 SSHKey）。 */
export interface AuthKeyOption {
  id: string;
  label: string;
  type: string;
  username: string;
}

export interface TerminalAuthDialogProps {
  authMethod: TerminalAuthMethod;
  setAuthMethod: (method: TerminalAuthMethod) => void;
  authUsername: string;
  setAuthUsername: (username: string) => void;
  authPassword: string;
  setAuthPassword: (password: string) => void;
  authKeyId: string | null;
  setAuthKeyId: (keyId: string | null) => void;
  authPassphrase: string;
  setAuthPassphrase: (passphrase: string) => void;
  showAuthPassphrase: boolean;
  setShowAuthPassphrase: (show: boolean) => void;
  showAuthPassword: boolean;
  setShowAuthPassword: (show: boolean) => void;
  authRetryMessage: string | null;
  keys: AuthKeyOption[];
  onSubmit: () => void;
  onCancel: () => void;
  isValid: boolean;
}

export function TerminalAuthDialog({
  authMethod,
  setAuthMethod,
  authUsername,
  setAuthUsername,
  authPassword,
  setAuthPassword,
  authKeyId,
  setAuthKeyId,
  authPassphrase,
  setAuthPassphrase,
  showAuthPassphrase,
  setShowAuthPassphrase,
  showAuthPassword,
  setShowAuthPassword,
  authRetryMessage,
  keys,
  onSubmit,
  onCancel,
  isValid,
}: TerminalAuthDialogProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const selectedKey = authKeyId ? keys.find((k) => k.id === authKeyId) ?? null : null;
  const selectableKeys = keys.filter((k) => k.type === "key");

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && isValid) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <>
      <div className="conn-auth-tabs">
        <button
          type="button"
          className={authMethod === "password" ? "active" : ""}
          onClick={() => setAuthMethod("password")}
        >
          <Icon name="lock" size={13} />
          密码
        </button>
        <button
          type="button"
          className={authMethod === "key" ? "active" : ""}
          onClick={() => setAuthMethod("key")}
        >
          <Icon name="key" size={13} />
          SSH 密钥
        </button>
      </div>

      {authRetryMessage && (
        <div className="conn-auth-retry">
          <div className="conn-auth-retry-icon">
            <Icon name="unplug" size={11} />
          </div>
          <div className="conn-auth-retry-text">{authRetryMessage}</div>
        </div>
      )}

      <div className="conn-auth-fields">
        <label className="conn-field">
          <span>用户名</span>
          <input
            value={authUsername}
            onChange={(e) => setAuthUsername(e.target.value)}
            placeholder="用户名"
          />
        </label>

        {authMethod === "password" ? (
          <label className="conn-field">
            <span>密码</span>
            <div className="conn-input-wrap">
              <input
                type={showAuthPassword ? "text" : "password"}
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="密码"
                className={authRetryMessage ? "invalid" : ""}
                autoFocus={Boolean(authRetryMessage)}
                onKeyDown={handleKeyDown}
              />
              <button
                type="button"
                className="conn-eye"
                onClick={() => setShowAuthPassword(!showAuthPassword)}
              >
                <Icon name={showAuthPassword ? "eye-off" : "eye"} size={16} />
              </button>
            </div>
          </label>
        ) : (
          <>
            <div className="conn-field">
              <span>选择密钥</span>
              {selectableKeys.length === 0 ? (
                <div className="conn-empty">没有可用的 SSH 密钥凭据</div>
              ) : (
                <div className="conn-key-picker">
                  <button
                    type="button"
                    className={selectedKey ? "conn-key-trigger selected" : "conn-key-trigger"}
                    onClick={() => setDropdownOpen((v) => !v)}
                  >
                    {selectedKey ? (
                      <>
                        <span className="conn-key-icon">
                          <Icon name="key" size={14} />
                        </span>
                        <span className="conn-key-body">
                          <span className="conn-key-label">{selectedKey.label}</span>
                          <span className="conn-key-meta">{selectedKey.type}</span>
                        </span>
                      </>
                    ) : (
                      <span className="conn-key-placeholder">选择密钥</span>
                    )}
                    <Icon name="chevron-down" size={16} />
                  </button>
                  {dropdownOpen && (
                    <div className="conn-key-menu">
                      {selectableKeys.map((key) => (
                        <button
                          type="button"
                          key={key.id}
                          className={authKeyId === key.id ? "selected" : ""}
                          onClick={() => {
                            setAuthKeyId(key.id);
                            setAuthPassphrase("");
                            setDropdownOpen(false);
                          }}
                        >
                          <span className="conn-key-icon">
                            <Icon name="key" size={12} />
                          </span>
                          <span className="conn-key-body">
                            <span className="conn-key-label">{key.label}</span>
                            <span className="conn-key-meta">{key.type}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <label className="conn-field">
              <span>私钥口令（可选）</span>
              <div className="conn-input-wrap">
                <input
                  type={showAuthPassphrase ? "text" : "password"}
                  value={authPassphrase}
                  onChange={(e) => setAuthPassphrase(e.target.value)}
                  placeholder="私钥口令"
                  disabled={!selectedKey}
                  onKeyDown={handleKeyDown}
                />
                <button
                  type="button"
                  className="conn-eye"
                  onClick={() => setShowAuthPassphrase(!showAuthPassphrase)}
                  disabled={!selectedKey}
                >
                  <Icon name={showAuthPassphrase ? "eye-off" : "eye"} size={16} />
                </button>
              </div>
            </label>
          </>
        )}
      </div>

      <div className="conn-dialog-actions">
        <button type="button" className="conn-btn" onClick={onCancel}>
          关闭
        </button>
        <button
          type="button"
          className="conn-btn conn-btn-primary"
          disabled={!isValid}
          onClick={onSubmit}
        >
          继续
        </button>
      </div>
    </>
  );
}

export default TerminalAuthDialog;
