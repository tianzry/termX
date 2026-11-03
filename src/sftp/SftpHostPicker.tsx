/**
 * 主机选择弹窗（对齐 Netcatty SftpHostPicker 的布局与文案）：
 * 头 = 搜索图标 + 输入（placeholder「搜索主机...」）+ 侧位 chip（左侧/右侧）+ × 关闭；
 * 分区：本地（本地文件系统行 + 右侧灰字「浏览本地文件」）→ 已连接（绿点 + 名称 +
 * user@host）→ 主机（保存的 SSH 主机）；无匹配显示「没有匹配的主机」；键盘 ↑↓ Enter。
 * 虚拟列表在大主机量阶段再加，骨架先全量渲染。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icons";
import {
  flattenPickerItems,
  osIconName,
  PICKER_LABELS,
  type PickerItem,
  type PickerSection,
  type SftpSide,
} from "./sftpModel";

interface Props {
  open: boolean;
  side: SftpSide;
  term: string;
  onTermChange: (value: string) => void;
  sections: PickerSection[];
  onClose: () => void;
  onPick: (item: PickerItem) => void;
}

/** 保存主机行的右侧灰字：host[:port]（username 在凭据里，骨架阶段不联查）。 */
function hostMeta(host: string, port: number): string {
  return port && port !== 22 ? `${host}:${port}` : host;
}

export function SftpHostPicker({
  open,
  side,
  term,
  onTermChange,
  sections,
  onClose,
  onPick,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(0);
  const items = useMemo(() => flattenPickerItems(sections), [sections]);

  useEffect(() => {
    if (!open) return;
    setSelected(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open, term]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pick = (item: PickerItem) => onPick(item);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((prev) => (items.length ? (prev + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((prev) =>
        items.length ? (prev - 1 + items.length) % items.length : 0,
      );
    } else if (e.key === "Enter" && items.length > 0) {
      e.preventDefault();
      const item = items[Math.min(selected, items.length - 1)];
      if (item) pick(item);
    }
  };

  // 扁平索引 → 行渲染用
  let flatIndex = -1;

  return (
    <div
      className="nc-sftp-picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="选择主机"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nc-sftp-picker">
        <div className="nc-sftp-picker-header">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={term}
            onChange={(e) => onTermChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索主机..."
            aria-label="搜索主机"
          />
          <span className="nc-sftp-picker-side-chip">
            {side === "left" ? "左侧" : "右侧"}
          </span>
          <button
            className="nc-sftp-picker-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="nc-sftp-picker-list">
          {sections.map((section) => (
            <div key={section.key} className="nc-sftp-picker-section">
              <div className="nc-sftp-picker-section-label">
                {section.label}
              </div>
              {section.items.length === 0 && section.emptyHint && (
                <div className="nc-sftp-picker-empty">{section.emptyHint}</div>
              )}
              {section.items.map((item) => {
                flatIndex += 1;
                const isSelected = flatIndex === selected;
                if (item.type === "local") {
                  return (
                    <div
                      key={item.id}
                      className={`nc-sftp-picker-row${isSelected ? " selected" : ""}`}
                      onClick={() => pick(item)}
                      onMouseEnter={() => setSelected(flatIndex)}
                    >
                      <span className="nc-sftp-picker-row-main">
                        <Icon name="monitor" size={16} />
                        <span className="nc-sftp-picker-row-title">
                          {PICKER_LABELS.localTitle}
                        </span>
                      </span>
                      <span className="nc-sftp-picker-row-meta">
                        {PICKER_LABELS.localDesc}
                      </span>
                    </div>
                  );
                }
                if (item.type === "connected") {
                  const osIcon = item.entry.os
                    ? osIconName(item.entry.os)
                    : null;
                  return (
                    <div
                      key={item.id}
                      className={`nc-sftp-picker-row${isSelected ? " selected" : ""}`}
                      onClick={() => pick(item)}
                      onMouseEnter={() => setSelected(flatIndex)}
                    >
                      <span className="nc-sftp-picker-row-main">
                        {osIcon ? (
                          <Icon name={osIcon} size={16} />
                        ) : (
                          <span className="nc-sftp-picker-status-dot" />
                        )}
                        <span className="nc-sftp-picker-row-title">
                          {item.entry.label}
                        </span>
                      </span>
                      <span className="nc-sftp-picker-row-meta">
                        {item.entry.meta}
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={item.id}
                    className={`nc-sftp-picker-row${isSelected ? " selected" : ""}`}
                    onClick={() => pick(item)}
                    onMouseEnter={() => setSelected(flatIndex)}
                  >
                    <span className="nc-sftp-picker-row-main">
                      <Icon name="server" size={16} />
                      <span className="nc-sftp-picker-row-title">
                        {item.profile.name}
                      </span>
                    </span>
                    <span className="nc-sftp-picker-row-meta">
                      {hostMeta(item.profile.host, item.profile.port)}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
