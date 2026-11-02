/**
 * SFTP 栏内会话标签栏（对齐 Netcatty SftpTabBar 的可见行为子集）：
 * 本地=显示器图标 / 远端=服务器图标 + 名称 + ×；活动 tab 底部 accent
 * 2px 下划线；右端 + 按钮（tooltip「新建标签页」）；中键关闭。
 * 拖拽重排 / 跨栏移动 / 右键复制留到后续阶段。
 */

import { Icon } from "../ui/icons";
import type { SftpPaneTab, SftpSide } from "./sftpModel";

interface Props {
  side: SftpSide;
  tabs: SftpPaneTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onAdd: () => void;
}

export function SftpTabBar({
  side,
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onAdd,
}: Props) {
  return (
    <div
      className="nc-sftp-tabbar"
      data-side={side}
      role="tablist"
      aria-label={side === "left" ? "左侧会话标签" : "右侧会话标签"}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={`nc-sftp-tab${active ? " active" : ""}`}
            onClick={() => onSelect(tab.id)}
            onMouseDown={(e) => {
              // 中键关闭（对齐 Netcatty）
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            <Icon
              name={tab.connection.kind === "local" ? "monitor" : "server"}
              size={12}
            />
            <span className="nc-sftp-tab-label">{tab.connection.label}</span>
            <button
              className="nc-sftp-tab-close"
              aria-label="关闭标签页"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        );
      })}
      <button
        className="nc-sftp-tabbar-add"
        title="新建标签页"
        aria-label="新建标签页"
        onClick={onAdd}
      >
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}
