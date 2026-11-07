/**
 * 终端态左侧主机树（对照 netcatty `TerminalHostTreeSidebar`）。
 *
 * 结构：36px 工具条（新建 / 搜索 / 标签 / 本地终端 / 更多 / 收起）+
 * 可展开搜索行 + 28px 紧凑树行（分组可折叠）。默认宽度 220px，
 * 与 netcatty `TERMINAL_HOST_TREE_DEFAULT_WIDTH` 一致。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Group, Profile } from "./backend/client";
import { placeAnchoredPopover } from "./domain/popoverPosition";
import { Icon } from "./ui/icons";
import {
  collectHostTags,
  matchesHostTags,
  readHostTags,
} from "./vault/vaultTags";
import {
  deriveHostContextMenuItems,
  HOST_CONTEXT_MENU_ICON,
} from "./hosts/hostContextMenuModel";

interface Props {
  profiles: Profile[];
  groups: Group[];
  onConnect: (profile: Profile) => void;
  onLocal: () => void;
  onOpenManager: () => void;
  onClose?: () => void;
  /** 「更多 → 刷新列表」：由 App 传入 loadData。 */
  onRefresh?: () => void;
}

function avatarText(profile: Profile): string {
  return (profile.name.trim()[0] ?? "?").toUpperCase();
}

function avatarHue(profile: Profile): number {
  let n = 0;
  for (const ch of profile.name) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

/**
 * 工具条浮层：portal 到 body + fixed 定位。
 *
 * 工具条按钮贴着窗口左缘，就地 absolute 的右对齐菜单会向左溢出，被
 * `.nc-shell` 的 overflow:hidden 裁掉。所以浮层必须脱离侧栏祖先链，
 * 坐标由 placeAnchoredPopover 收拢进视口；侧栏/窗口滚动与尺寸变化时重算。
 */
function AnchoredMenu({
  anchor,
  className,
  children,
}: {
  anchor: HTMLElement | null;
  className: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const appliedKey = useRef("");
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  const place = useCallback(() => {
    const menu = menuRef.current;
    if (!menu || !anchor) return;
    const a = anchor.getBoundingClientRect();
    // scrollHeight 取内容自然高度：内联 maxHeight 生效后 offsetHeight 会缩水，
    // 用它判断上翻/限高会导致反复翻转。
    const pos = placeAnchoredPopover(
      { top: a.top, left: a.left, right: a.right, bottom: a.bottom },
      { width: menu.offsetWidth, height: menu.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    const key = `${pos.left}|${pos.top}|${pos.maxHeight ?? ""}`;
    if (appliedKey.current === key) return;
    appliedKey.current = key;
    setStyle({
      left: pos.left,
      top: pos.top,
      maxHeight: pos.maxHeight ?? undefined,
      overflowY: pos.maxHeight === null ? undefined : "auto",
      visibility: "visible",
    });
  }, [anchor]);

  useLayoutEffect(() => {
    place();
    const menu = menuRef.current;
    const observer = menu ? new ResizeObserver(place) : null;
    if (menu) observer?.observe(menu);
    window.addEventListener("resize", place);
    // capture：侧栏内部滚动容器也会触发，保证浮层跟手不跑位。
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      style={{ position: "fixed", right: "auto", bottom: "auto", ...style }}
      // 阻止冒泡到 window 的关闭监听，否则 mousedown 先卸载菜单，click 不触发。
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function HostSidebar({
  profiles,
  groups,
  onConnect,
  onLocal,
  onOpenManager,
  onClose,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [tagMenu, setTagMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const tagButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  /** 主机行右键菜单（按协议派生条目，对齐 Netcatty 主机树）。 */
  const [ctx, setCtx] = useState<{ profile: Profile; x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    if (!tagMenu && !moreMenu && !ctx) return;
    const close = () => {
      setTagMenu(false);
      setMoreMenu(false);
      setCtx(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [tagMenu, moreMenu, ctx]);

  // 与 Vault 主机页共用同一份 localStorage 标签表。
  const hostTags = readHostTags();
  const availableTags = collectHostTags(
    hostTags,
    profiles.map((p) => p.id),
  );

  const keyword = query.trim().toLowerCase();
  const filtered = profiles.filter((p) => {
    if (!matchesHostTags(hostTags, p.id, selectedTags)) return false;
    if (!keyword) return true;
    return (
      p.name.toLowerCase().includes(keyword) ||
      p.host.toLowerCase().includes(keyword) ||
      String(p.port).includes(keyword)
    );
  });

  const groupById = new Map(groups.map((g) => [g.id, g]));
  const sections: Array<{ id: string; name: string; hosts: Profile[] }> = [];

  for (const g of groups) {
    const hosts = filtered.filter((p) => p.group_id === g.id);
    if (hosts.length > 0) sections.push({ id: g.id, name: g.name, hosts });
  }
  const ungrouped = filtered.filter(
    (p) => !p.group_id || !groupById.has(p.group_id),
  );
  if (ungrouped.length > 0) {
    sections.push({ id: "__ungrouped", name: "未分组", hosts: ungrouped });
  }

  return (
    <aside className="nc-sidebar" data-section="terminal-host-tree">
      <div className="nc-sidebar-toolbar" data-section="terminal-host-tree-toolbar">
        <button className="nc-tree-tool" title="新建主机" onClick={onOpenManager}>
          <Icon name="plus" size={14} />
        </button>
        <button
          className={`nc-tree-tool${searchOpen || query ? " active" : ""}`}
          title="搜索主机"
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon name="search" size={14} />
        </button>
        <button
          ref={tagButtonRef}
          className={`nc-tree-tool${selectedTags.length > 0 ? " active" : ""}`}
          title="标签筛选"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            setMoreMenu(false);
            setTagMenu((v) => !v);
          }}
        >
          <Icon name="tag" size={14} />
        </button>
        {tagMenu && (
          <AnchoredMenu
            anchor={tagButtonRef.current}
            className="vault-view-menu vault-tag-menu"
          >
            {availableTags.length === 0 ? (
              <div className="vault-tag-empty">当前主机还没有标签</div>
            ) : (
              availableTags.map((tag) => (
                <div className="vault-tag-row" key={tag}>
                  <label className="vault-tag-check">
                    <input
                      type="checkbox"
                      checked={selectedTags.includes(tag)}
                      onChange={() =>
                        setSelectedTags((prev) =>
                          prev.includes(tag)
                            ? prev.filter((t) => t !== tag)
                            : [...prev, tag],
                        )
                      }
                    />
                    <span>{tag}</span>
                  </label>
                </div>
              ))
            )}
            {selectedTags.length > 0 && (
              <button
                className="vault-tag-clear"
                onClick={() => setSelectedTags([])}
              >
                <Icon name="x" size={12} />
                清空筛选
              </button>
            )}
          </AnchoredMenu>
        )}
        <button className="nc-tree-tool" title="本地终端" onClick={onLocal}>
          <Icon name="terminal" size={14} />
        </button>
        <button
          ref={moreButtonRef}
          className={`nc-tree-tool${moreMenu ? " active" : ""}`}
          title="更多"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            setTagMenu(false);
            setMoreMenu((v) => !v);
          }}
        >
          <Icon name="chevron-down" size={14} />
        </button>
        {moreMenu && (
          <AnchoredMenu
            anchor={moreButtonRef.current}
            className="vault-view-menu nc-tree-more-menu"
          >
            <button
              onClick={() => {
                setMoreMenu(false);
                onOpenManager();
              }}
            >
              <Icon name="server" size={14} />
              管理主机
            </button>
            <button
              onClick={() => {
                setMoreMenu(false);
                onRefresh?.();
              }}
            >
              <Icon name="refresh" size={14} />
              刷新列表
            </button>
            {onClose && (
              <button
                onClick={() => {
                  setMoreMenu(false);
                  onClose();
                }}
              >
                <Icon name="x" size={14} />
                收起侧栏
              </button>
            )}
          </AnchoredMenu>
        )}
        <span className="nc-tree-tool-spacer" />
        {onClose && (
          <button className="nc-tree-tool" title="收起主机侧栏" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>

      {searchOpen && (
        <div className="nc-sidebar-search-panel">
          <div className="nc-sidebar-search">
            <Icon name="search" size={12} className="nc-search-icon" />
            <input
              autoFocus
              value={query}
              placeholder="搜索主机"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="nc-tree-tool" title="清空" onClick={() => setQuery("")}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="nc-sidebar-scroll">
        <button className="nc-tree-row" onClick={onLocal}>
          <span className="nc-tree-avatar local">
            <Icon name="terminal" size={11} />
          </span>
          <span className="nc-tree-label">本地终端</span>
        </button>

        {sections.map((section) => {
          const isCollapsed = collapsed[section.id] ?? false;
          return (
            <div className="nc-tree-group" key={section.id}>
              <button
                className="nc-tree-row nc-tree-group-head"
                onClick={() =>
                  setCollapsed((m) => ({ ...m, [section.id]: !isCollapsed }))
                }
              >
                <Icon
                  name={isCollapsed ? "chevron-right" : "chevron-down"}
                  size={12}
                />
                <Icon name="folder" size={12} />
                <span className="nc-tree-label">{section.name}</span>
                <span className="nc-tree-count">{section.hosts.length}</span>
              </button>
              {!isCollapsed &&
                section.hosts.map((p) => (
                  <button
                    className="nc-tree-row nc-tree-host"
                    key={p.id}
                    title={`${p.name} · ${
                      p.protocol === "serial"
                        ? p.serial_port ?? p.host
                        : `${p.host}:${p.port}`
                    }`}
                    onClick={() => onConnect(p)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtx({
                        profile: p,
                        x: Math.min(e.clientX, window.innerWidth - 216),
                        y: Math.min(e.clientY, window.innerHeight - 200),
                      });
                    }}
                  >
                    {p.protocol === "local" ? (
                      <span className="nc-tree-avatar local">
                        <Icon name="terminal" size={11} />
                      </span>
                    ) : p.protocol === "serial" ? (
                      <span className="nc-tree-avatar serial" title="串口主机">
                        <Icon name="usb" size={11} />
                      </span>
                    ) : (
                      <span
                        className="nc-tree-avatar"
                        style={{ "--nc-avatar-hue": avatarHue(p) } as CSSProperties}
                      >
                        {avatarText(p)}
                      </span>
                    )}
                    <span className="nc-tree-label">{p.name}</span>
                  </button>
                ))}
            </div>
          );
        })}

        {profiles.length === 0 && (
          <div className="nc-sidebar-empty">
            <span>还没有主机</span>
            <button onClick={onOpenManager}>新建主机</button>
          </div>
        )}
        {profiles.length > 0 && filtered.length === 0 && (
          <div className="nc-sidebar-empty">没有匹配的主机</div>
        )}
      </div>

      {ctx && (
        <div
          className="term-context-menu vault-context-menu vault-popmenu"
          style={{ left: ctx.x, top: ctx.y }}
          // 阻止冒泡到 window 的关闭监听，否则 mousedown 先卸载菜单，click 不触发。
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 与主机页同一套按协议派生的条目；主机树只提供连接 / 编辑（进入
              主机管理页）/ 复制地址，其余动作留给主机页卡片菜单。 */}
          {deriveHostContextMenuItems({
            protocol: ctx.profile.protocol,
            host: ctx.profile.host,
          })
            .filter((item) =>
              ["connect", "edit", "copy-hostname"].includes(item.id),
            )
            .map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  const p = ctx.profile;
                  setCtx(null);
                  if (item.id === "connect") onConnect(p);
                  else if (item.id === "edit") onOpenManager();
                  else void navigator.clipboard.writeText(p.host).catch(() => {});
                }}
              >
                <Icon name={HOST_CONTEXT_MENU_ICON[item.id]} size={14} />
                {item.label}
              </button>
            ))}
        </div>
      )}
    </aside>
  );
}
