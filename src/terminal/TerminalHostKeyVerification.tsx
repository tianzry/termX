/**
 * 主机密钥校验（移植自 netcatty/components/terminal/TerminalHostKeyVerification.tsx）。
 *
 * unknown：首次连接（黄）；
 * changed：指纹变更（红，展示旧指纹）；
 * 操作：关闭 / 仅本次继续 / 加入并继续（changed 时为“更新并继续”）。
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
            {isChanged ? "主机密钥已变更" : "未知的主机密钥"}
          </div>
          <p>
            {isChanged
              ? `主机 ${hostKeyInfo.hostname} 的密钥与已保存记录不一致。`
              : `首次连接主机 ${hostKeyInfo.hostname}，请确认指纹可信。`}
          </p>
        </div>
      </div>

      <div className="conn-hostkey-details">
        <div className="conn-hostkey-label">指纹（{hostKeyInfo.keyType}）</div>
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
            ? "仅在确认服务器已被重装或运维变更后，才更新并继续。"
            : "请与服务器管理员提供的指纹核对后再继续。"}
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
            {isChanged ? "更新并继续" : "加入并继续"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TerminalHostKeyVerification;
