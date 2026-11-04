/**
 * 应用锁遮罩（#23）。
 *
 * 行为（对照 Netcatty AppLock lifecycle）：
 * - 启动：`app_lock_state.enabled` 为 true 时立即锁定；口令正确才放下遮罩。
 * - 切回：窗口失焦/页面隐藏记录时间，回到前台后按「锁定超时」判定
 *   （0 分钟 = 立即）。
 * - 手动：设置中心「立即锁定」通过 `APP_LOCK_NOW_EVENT` 触发。
 *
 * 遮罩是 UI 门（非磁盘加密）；锁定时阻断应用快捷键，只放行遮罩内输入框。
 */

import { useEffect, useRef, useState } from "react";
import { decodeAppError } from "../domain/sshErrors";
import { settingsT } from "../settings/i18n";
import { useSettings } from "../settings/settingsStore";
import {
  APP_LOCK_NOW_EVENT,
  loadAppLock,
  shouldLockAfterReturn,
  unlockAppLock,
  useAppLock,
} from "./appLockState";

/**
 * 后端错误 → 遮罩文案。只映射应用锁自身 code；其余沿用后端原始信息，
 * 避免把登录类错误伪装成锁定错误。
 */
function lockErrorText(raw: string, t: (key: string) => string): string {
  const { code, message } = decodeAppError(raw);
  switch (code) {
    case "app_lock_incorrect_password":
      return t("appLock.error.incorrectPassword");
    case "app_lock_empty_password":
      return t("appLock.error.emptyPassword");
    case "app_lock_current_required":
      return t("appLock.error.currentRequired");
    default:
      return message || t("appLock.error.incorrectPassword");
  }
}

export function AppLockGate() {
  const settings = useSettings();
  const state = useAppLock();
  const t = (key: string) => settingsT(settings.language, key);

  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hiddenAt = useRef<number | null>(null);

  // 启动：读取持久化状态；启用时先锁住，再渲染内容。
  useEffect(() => {
    let cancelled = false;
    void loadAppLock().then((s) => {
      if (cancelled) return;
      if (s.enabled) setLocked(true);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 失焦/隐藏计时 + 手动锁定。
  useEffect(() => {
    if (!ready || !state.enabled) {
      hiddenAt.current = null;
      return;
    }
    const onHide = () => {
      if (hiddenAt.current === null) hiddenAt.current = Date.now();
    };
    const onShow = () => {
      if (
        shouldLockAfterReturn(
          hiddenAt.current,
          Date.now(),
          state.timeout_minutes,
          state.enabled,
        )
      ) {
        setLocked(true);
      }
      hiddenAt.current = null;
    };
    const onVisibility = () => {
      if (document.hidden) onHide();
      else onShow();
    };
    const onLockNow = () => setLocked(true);

    window.addEventListener("blur", onHide);
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(APP_LOCK_NOW_EVENT, onLockNow);
    return () => {
      window.removeEventListener("blur", onHide);
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(APP_LOCK_NOW_EVENT, onLockNow);
    };
  }, [ready, state.enabled, state.timeout_minutes]);

  // 锁定时吞掉遮罩之外的键盘事件，防止快捷键操作被挡住的应用。
  useEffect(() => {
    if (!locked) return;
    const swallow = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-app-lock-overlay]")) return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", swallow, true);
    window.addEventListener("keyup", swallow, true);
    return () => {
      window.removeEventListener("keydown", swallow, true);
      window.removeEventListener("keyup", swallow, true);
    };
  }, [locked]);

  useEffect(() => {
    if (locked) setError(null);
  }, [locked]);

  const submit = async () => {
    if (busy) return;
    if (!password) {
      setError(t("appLock.error.emptyPassword"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await unlockAppLock(password);
      if (ok) {
        setPassword("");
        setLocked(false);
      } else {
        setError(t("appLock.error.incorrectPassword"));
      }
    } catch (e) {
      setError(lockErrorText(String(e), t));
    } finally {
      setBusy(false);
    }
  };

  if (!ready || !locked) return null;

  return (
    <div className="nc-app-lock" data-app-lock-overlay role="dialog" aria-modal="true">
      <div className="nc-app-lock-card">
        <div className="nc-app-lock-brand">termX</div>
        <h2 className="nc-app-lock-title">{t("appLock.lockedTitle")}</h2>
        <p className="nc-app-lock-desc">{t("appLock.lockedDesc")}</p>
        <input
          className="nc-set-input nc-app-lock-input"
          type="password"
          autoFocus
          value={password}
          placeholder={t("appLock.passwordPlaceholder")}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          disabled={busy}
        />
        {error && <div className="nc-app-lock-error">{error}</div>}
        <button className="nc-set-btn nc-app-lock-submit" onClick={() => void submit()} disabled={busy}>
          {busy ? t("appLock.unlocking") : t("appLock.unlock")}
        </button>
      </div>
    </div>
  );
}
