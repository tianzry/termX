/**
 * 主机密钥校验（移植自 netcatty/components/terminal/TerminalHostKeyVerification.tsx）。
 *
 * unknown：首次连接（黄）「确认主机指纹」；
 * changed：指纹变更（红）「主机指纹已变化」，展示已保存指纹；
 * 操作：关闭 / 继续 / 记住并继续（changed 时为「更新并继续」）。
 */
import { Icon } from "../ui/icons";
import type { HostKeyInfo } from "../domain/hostKey";
import { TerminalConnectionLogList } from "./TerminalConnectionProgress";

export interface TerminalHostKeyVerificationProps {
  hostKeyInfo: HostKeyInfo;
  showLogs: boolean;
  progressLogs: string[];
  onClose: () => void;
  onContinue: () => void;
  onAddAndContinue: () => void;
}

export function TerminalHostKeyVerification({
  hostKeyInfo,
  showLogs,
  progressLogs,
  onClose,
  onContinue,
  onAddAndContinue,
}: TerminalHostKeyVerificationProps) {
  const isChanged = hostKeyInfo.status === "changed";

  return (
    <div className="conn-hostkey">
      <div className={isChanged ? "conn-hostkey-banner danger" : "conn-hostkey-banner warn"}>
        <div className="conn-hostkey-icon">
          <Icon name={isChanged ? "alert-triangle" : "fingerprint"} size={15} />
        </div>
        <div className="conn-hostkey-copy">
          <div className="conn-hostkey-title">
            {isChanged ? "主机指纹已变化" : "确认主机指纹"}
          </div>
          <p>
            {isChanged
              ? `${hostKeyInfo.hostname} 的已保存指纹与当前服务器不一致。`
              : `尚未确认 ${hostKeyInfo.hostname} 的真实性。`}
          </p>
        </div>
      </div>

      <div className="conn-hostkey-details">
        <div className="conn-hostkey-label">{hostKeyInfo.keyType} 指纹为 SHA256：</div>
        <div className="conn-hostkey-fingerprint">
          <code>{hostKeyInfo.fingerprint}</code>
        </div>
        {isChanged && hostKeyInfo.knownFingerprint && (
          <div className="conn-hostkey-fingerprint known">
            <div className="conn-hostkey-known-label">已保存的指纹</div>
            <code>{hostKeyInfo.knownFingerprint}</code>
          </div>
        )}
        <p className="conn-hostkey-hint">
          {isChanged
            ? "只有在你确认这台主机确实变更过时才继续。"
            : "如果这个指纹属于你预期连接的服务器，可以记住它。"}
        </p>
      </div>

      {showLogs && <TerminalConnectionLogList progressLogs={progressLogs} />}

      <div className="conn-dialog-footer">
        <div className="conn-footer-actions">
          <button type="button" className="conn-btn conn-btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="conn-btn" onClick={onContinue}>
            继续
          </button>
          <button type="button" className="conn-btn conn-btn-primary" onClick={onAddAndContinue}>
            {isChanged ? "更新并继续" : "记住并继续"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TerminalHostKeyVerification;
