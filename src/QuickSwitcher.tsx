/**
 * 快速切换器（对照 netcatty `components/QuickSwitcher.tsx`）。
 *
 * 顶部「+」与 Ctrl+J 共用一个入口：搜索框聚焦，下方按
 * 「主机 → 标签页 → 本地 Shell」分组列出可打开的内容
 * （顺序对齐 Netcatty 的 pushHeader 顺序：hosts → tabs → shells）；
 * ↑↓ 选择、Enter 打开、Esc/点击外部关闭。
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { DiscoveredShell, Group, Profile } from "./backend/client";
import type { Tab } from "./workspaceModel";
import { Icon, type IconName } from "./ui/icons";
import { avatarStyle, initial } from "./VaultView";

interface Props {
  open: boolean;
  profiles: Profile[];
  groups: Group[];
  tabs: Tab[];
  shells: DiscoveredShell[];
  showSftpTab: boolean;
  onClose: () => void;
  onOpenVault: () => void;
  onOpenSftp: () => void;
  onActivateTab: (id: string) => void;
  onConnect: (profile: Profile) => void;
  onLocalShell: (shell: DiscoveredShell) => void;
}

type Item =
  | { kind: "vault"; key: string; label: string; icon: IconName }
  | { kind: "sftp"; key: string; label: string; icon: IconName }
  | { kind: "tab"; key: string; label: string; icon: IconName; tabId: string }
  | { kind: "host"; key: string; label: string; icon: IconName; profile: Profile; meta: string }
  | {
      kind: "shell";
      key: string;
      label: string;
      icon: IconName;
      shell: DiscoveredShell;
      isDefault: boolean;
    };

/** 主机在切换器右侧显示的归属路径（对齐 Netcatty `Personal / 分组`）。 */
function groupPath(groups: Group[], groupId: string | null | undefined): string {
  const g = groupId ? groups.find((x) => x.id === groupId) : undefined;
  return g ? `Personal / ${g.name}` : "Personal";
}

export function QuickSwitcher({
  open,
  profiles,
  groups,
  tabs,
  shells,
  showSftpTab,
  onClose,
  onOpenVault,
  onOpenSftp,
  onActivateTab,
  onConnect,
  onLocalShell,
}: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();

  const sections = useMemo(() => {
    const hit = (...parts: Array<string | null | undefined>) =>
      !q || parts.some((p) => p?.toLowerCase().includes(q));

    const tabItems: Item[] = [];
    if (hit("Vaults", "vault")) {
      tabItems.push({ kind: "vault", key: "surface:vault", label: "Vaults", icon: "folder" });
    }
    if (showSftpTab && hit("SFTP", "sftp")) {
      tabItems.push({ kind: "sftp", key: "surface:sftp", label: "SFTP", icon: "folder" });
    }
    for (const t of tabs) {
      if (!hit(t.title)) continue;
      tabItems.push({
        kind: "tab",
        key: `tab:${t.id}`,
        label: t.title,
        icon: t.connector.kind === "ssh" ? "server" : "terminal",
        tabId: t.id,
      });
    }

    const hostItems: Item[] = profiles
      .filter((p) => hit(p.name, p.host))
      .slice(0, 40)
      .map((p) => ({
        kind: "host" as const,
        key: `host:${p.id}`,
        label: p.name,
        icon: p.protocol === "serial" ? "network" : "terminal",
        profile: p,
        meta: groupPath(groups, p.group_id),
      }));

    const shellItems: Item[] = shells
      .filter((s) => hit(s.name))
      .map((s) => ({
        kind: "shell" as const,
        key: `shell:${s.id}`,
        label: s.name,
        icon: "terminal" as const,
        shell: s,
        isDefault: s.is_default,
      }));

    return { tabItems, hostItems, shellItems };
  }, [profiles, groups, tabs, shells, q, showSftpTab]);

  const flat = useMemo(
    () => [...sections.hostItems, ...sections.tabItems, ...sections.shellItems],
    [sections],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-qs-index="${selected}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);

  if (!open) return null;

  const run = (item: Item) => {
    onClose();
    switch (item.kind) {
      case "vault":
        onOpenVault();
        break;
      case "sftp":
        onOpenSftp();
        break;
      case "tab":
        onActivateTab(item.tabId);
        break;
      case "host":
        onConnect(item.profile);
        break;
      case "shell":
        onLocalShell(item.shell);
        break;
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && flat[selected]) {
      e.preventDefault();
      run(flat[selected]);
    }
  };

  let index = -1;
  const row = (item: Item, extra?: ReactNode, leading?: ReactNode) => {
    index += 1;
    const i = index;
    const active = i === selected;
    return (
      <button
        key={item.key}
        data-qs-index={i}
        className={`qs-row${active ? " active" : ""}`}
        onMouseEnter={() => setSelected(i)}
        onClick={() => run(item)}
      >
        {leading ?? <Icon name={item.icon} size={16} className="qs-row-icon" />}
        <span className="qs-row-label">{item.label}</span>
        {extra}
      </button>
    );
  };

  return (
    <div className="qs-mask" onMouseDown={onClose}>
      <div
        className="qs-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="qs-head">
          <Icon name="search" size={16} className="qs-head-icon" />
          <input
            ref={inputRef}
            className="qs-input"
            placeholder="搜索主机或标签页"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="qs-kbd">Ctrl+J</span>
        </div>

        <div className="qs-jump">
          <span className="qs-jump-label">跳转到</span>
          <span className="qs-kbd">Ctrl+J</span>
          <span className="qs-workspace" title="termX 暂无工作区功能">
            <Icon name="plus" size={13} />
            新建工作区
            <span className="qs-unavailable">暂未支持</span>
          </span>
        </div>

        <div className="qs-list" ref={listRef}>
          {sections.hostItems.length > 0 && (
            <>
              <div className="qs-section">主机</div>
              {sections.hostItems.map((item) => {
                const p = item.kind === "host" ? item.profile : null;
                const leading = p ? (
                  p.protocol === "local" ? (
                    <span className="nc-avatar sm local">
                      <Icon name="terminal" size={14} />
                    </span>
                  ) : p.protocol === "serial" ? (
                    <span className="nc-avatar sm serial" title="串口主机">
                      <Icon name="usb" size={14} />
                    </span>
                  ) : (
                    <span className="nc-avatar sm" style={avatarStyle(p.name)}>
                      {initial(p.name)}
                    </span>
                  )
                ) : undefined;
                return row(
                  item,
                  item.kind === "host" ? (
                    <span className="qs-row-meta">{item.meta}</span>
                  ) : null,
                  leading,
                );
              })}
            </>
          )}

          {sections.tabItems.length > 0 && (
            <>
              <div className="qs-section">标签页</div>
              {sections.tabItems.map((item) => row(item))}
            </>
          )}

          {sections.shellItems.length > 0 && (
            <>
              <div className="qs-section">本地 Shell</div>
              {sections.shellItems.map((item) =>
                row(
                  item,
                  item.kind === "shell" && item.isDefault ? (
                    <span className="qs-badge">默认</span>
                  ) : null,
                ),
              )}
            </>
          )}

          {flat.length === 0 && <div className="qs-empty">没有匹配的内容</div>}
        </div>
      </div>
    </div>
  );
}
