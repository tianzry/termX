/**
 * 主机协议派生：`profiles.protocol` → 连接器 kind + Telnet 会话参数。
 *
 * Netcatty 把 Telnet 当作 Host 的一种 protocol（`protocol: 'telnet'`），
 * 与 SSH 共用主机管理；termX 沿用同一语义：
 * - 老数据 protocol 缺失 / `ssh` → SSH 连接器（行为不变）；
 * - `telnet` → 走现有 telnet 后端（`Connector.kind = "telnet"`）；
 * - `local` / `serial` 走各自独立面板，不从这里派生。
 */

import type { Profile } from "../backend/client";
import type { TerminalEncoding } from "../terminal/terminalEncoding";
import type { TelnetSessionConfig } from "../workspaceModel";

/** 主机级协议（本地 shell / 串口主机只由独立面板创建）。 */
export type HostProtocol = "ssh" | "telnet" | "local" | "serial";

/** 只有显式 telnet 才走 Telnet 链路；缺失 / 未知值一律按 SSH（老数据兼容）。 */
export function hostProtocolOf(
  profile: Pick<Profile, "protocol">,
): HostProtocol {
  const raw = profile.protocol;
  if (raw === "telnet" || raw === "local" || raw === "serial") return raw;
  return "ssh";
}

export function isTelnetProfile(profile: Pick<Profile, "protocol">): boolean {
  return hostProtocolOf(profile) === "telnet";
}

/**
 * 由主机档案派生 Telnet 会话参数（端口复用 `profiles.port`，默认 23）。
 * 密码来自 SecretStore；没有用户名时忽略密码（无法自动登录）。
 */
export function telnetSessionFromProfile(
  profile: Pick<
    Profile,
    "host" | "port" | "telnet_username" | "telnet_charset"
  > & { id?: string },
  password: string | null,
): TelnetSessionConfig {
  const username = (profile.telnet_username ?? "").trim();
  const encoding: TerminalEncoding =
    profile.telnet_charset === "gb18030" ? "gb18030" : "utf-8";
  return {
    ...(profile.id ? { profileId: profile.id } : {}),
    host: profile.host,
    port: profile.port || 23,
    inputNewline: "crlf",
    ...(username ? { username, password: password ?? "" } : {}),
    encoding,
  };
}
