/**
 * 主机条目右键菜单项（按连接协议派生）。
 *
 * 对照 Netcatty `components/host/HostTreeContextMenus.tsx` +
 * `TerminalContextMenu.tsx` 的可见性条件：
 * - 「打开 SFTP」仅 SSH（`canOpenDualPaneSftp` / `onOpenSftp` 只对 SSH 传入）；
 * - 「复制主机地址」「复制账密信息」对本地终端无意义（本地主机没有远端地址/凭据）；
 * - 串口 / Telnet 保留复制地址（串口路径、Telnet 主机），但同样没有 SFTP；
 * - 连接 / 编辑 / 复制 / 置顶 / 删除对所有协议都可用。
 *
 * 纯函数，供主机页卡片与终端页左侧主机树共用，便于单测。
 */

import type { IconName } from "../ui/icons";

export type HostContextMenuId =
  | "connect"
  | "sftp"
  | "edit"
  | "duplicate"
  | "copy-hostname"
  | "copy-credentials"
  | "pin"
  | "delete";

export type HostKind = "ssh" | "local" | "serial" | "telnet";

export interface HostContextMenuEntry {
  id: HostContextMenuId;
  label: string;
  /** 危险操作（删除）使用红色样式。 */
  danger?: boolean;
}

export interface HostContextMenuInput {
  protocol?: string | null;
  host?: string | null;
  /** 该主机当前是否已置顶（决定「置顶 / 取消置顶」文案）。 */
  pinned?: boolean;
}

/** 归一协议：未知值按 SSH 处理（历史数据 protocol 缺省即 SSH）。 */
export function resolveHostKind(protocol?: string | null): HostKind {
  if (protocol === "local" || protocol === "serial" || protocol === "telnet") {
    return protocol;
  }
  return "ssh";
}

export function deriveHostContextMenuItems(
  input: HostContextMenuInput,
): HostContextMenuEntry[] {
  const kind = resolveHostKind(input.protocol);
  const hasHostAddress = kind !== "local" && Boolean((input.host ?? "").trim());

  const items: HostContextMenuEntry[] = [
    { id: "connect", label: "连接" },
  ];
  if (kind === "ssh") items.push({ id: "sftp", label: "打开 SFTP" });
  items.push({ id: "edit", label: "编辑" });
  items.push({ id: "duplicate", label: "复制" });
  if (hasHostAddress) {
    items.push({ id: "copy-hostname", label: "复制主机地址" });
    items.push({ id: "copy-credentials", label: "复制账密信息" });
  }
  items.push({
    id: "pin",
    label: input.pinned ? "取消置顶" : "置顶",
  });
  items.push({ id: "delete", label: "删除", danger: true });
  return items;
}

/** 条目图标（与 `src/ui/icons.tsx` 的 name 对应）。 */
export const HOST_CONTEXT_MENU_ICON: Record<HostContextMenuId, IconName> = {
  connect: "plug",
  sftp: "columns",
  edit: "pencil",
  duplicate: "copy",
  "copy-hostname": "copy",
  "copy-credentials": "clipboard-paste",
  pin: "pin",
  delete: "trash",
};
