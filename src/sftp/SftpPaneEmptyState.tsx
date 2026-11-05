/**
 * 空栏空态（对齐 Netcatty SftpPaneEmptyState 文案）：
 * 居中图标 + 粗体「先选择一个主机」+ 灰字「选择要浏览的本地或远端文件系统」
 * + 蓝色按钮「+ 选择主机」。连接进行中 / 失败时显示对应提示。
 */

import { Icon } from "../ui/icons";
import type { SftpSide } from "./sftpModel";

interface Props {
  side: SftpSide;
  busy: boolean;
  error: string;
  onSelectHost: () => void;
}

export function SftpPaneEmptyState({ side, busy, error, onSelectHost }: Props) {
  return (
    <div className="nc-sftp-empty">
      <div className="nc-sftp-empty-icon">
        <Icon name={side === "left" ? "monitor" : "hard-drive"} size={24} />
      </div>
      <div className="nc-sftp-empty-text">
        <div className="nc-sftp-empty-title">先选择一个主机</div>
        <div className="nc-sftp-empty-desc">
          选择要浏览的本地或远端文件系统
        </div>
      </div>
      {error && <div className="nc-sftp-empty-error">{error}</div>}
      <button
        className="nc-sftp-empty-btn"
        onClick={onSelectHost}
        disabled={busy}
      >
        {busy ? (
          "连接中..."
        ) : (
          <>
            <Icon name="plus" size={13} /> 选择主机
          </>
        )}
      </button>
    </div>
  );
}
