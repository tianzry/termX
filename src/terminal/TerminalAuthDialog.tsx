/**
 * 连接认证重试弹窗（移植自 netcatty/components/terminal/TerminalAuthDialog.tsx）。
 *
 * 对齐要点：
 * - 密码 / SSH Key 两个 tab；
 * - 认证失败提示条（authRetryMessage）；
 * - 用户名、密码、密钥选择、密码短语；
 * - Enter 与主按钮「继续」走 onSubmitWithoutSave ?? onSubmit；
 * - caret 下拉「继续并保存」走 onSubmit（写回凭据）；
 * - 「关闭」取消连接。
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
  /** 不写回凭据的提交（netcatty onSubmitWithoutSave）；「继续」主按钮与 Enter 使用。 */
  onSubmitWithoutSave?: () => void;
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
  onSubmitWithoutSave,
  onCancel,
  isValid,
}: TerminalAuthDialogProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [submitOptionsOpen, setSubmitOptionsOpen] = useState(false);
  const selectedKey = authKeyId ? keys.find((k) => k.id === authKeyId) ?? null : null;
  const selectableKeys = keys.filter((k) => k.type === "key");

  // netcatty：主按钮「继续」与 Enter 走 onSubmitWithoutSave ?? onSubmit，
  // caret 下拉「继续并保存」才走 onSubmit。
  const handleContinue = onSubmitWithoutSave ?? onSubmit;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && isValid) {
      e.preventDefault();
      handleContinue();
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
          SSH Key
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
            placeholder="root"
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
                placeholder="输入密码"
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
                <div className="conn-empty">暂无密钥，请先在钥匙串中添加。</div>
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
                      <span className="conn-key-placeholder">选择 SSH密钥</span>
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
              <span>密码短语</span>
              <div className="conn-input-wrap">
                <input
                  type={showAuthPassphrase ? "text" : "password"}
                  value={authPassphrase}
                  onChange={(e) => setAuthPassphrase(e.target.value)}
                  placeholder="可选：所选私钥的密码短语"
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
        <div className="conn-btn-split">
          <button
            type="button"
            className="conn-btn conn-btn-primary conn-btn-split-main"
            disabled={!isValid}
            onClick={handleContinue}
          >
            继续
          </button>
          <button
            type="button"
            className="conn-btn conn-btn-primary conn-btn-split-caret"
            disabled={!isValid}
            aria-label="继续并保存"
            aria-haspopup="menu"
            aria-expanded={submitOptionsOpen}
            onClick={() => setSubmitOptionsOpen((v) => !v)}
          >
            <Icon name="chevron-down" size={13} />
          </button>
          {submitOptionsOpen && (
            <div className="conn-save-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={!isValid}
                onClick={() => {
                  setSubmitOptionsOpen(false);
                  onSubmit();
                }}
              >
                继续并保存
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default TerminalAuthDialog;
