/**
 * 右侧 AsidePanel（对照 netcatty `components/ui/aside-panel.tsx` 的用法）。
 *
 * 统一头部：标题 + 关闭按钮；内容区独立滚动。所有侧栏工具
 * （SFTP / 串口 / Telnet / 端口转发）都套这一层，保证位置、宽度、
 * 边框与换页行为一致。
 */

import type { ReactNode } from "react";
import { Icon } from "./ui/icons";

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** 默认 380px，与 netcatty AsidePanel 默认宽度一致。 */
  width?: number;
}

export function AsidePanel({ title, subtitle, onClose, children, width = 380 }: Props) {
  return (
    <aside className="nc-aside" style={{ width }}>
      <header className="nc-aside-header">
        <div className="nc-aside-heading">
          <span className="nc-aside-title">{title}</span>
          {subtitle && <span className="nc-aside-subtitle">{subtitle}</span>}
        </div>
        <button className="nc-icon-btn" title="关闭面板" onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="nc-aside-body">{children}</div>
    </aside>
  );
}
