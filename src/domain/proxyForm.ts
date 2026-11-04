/**
 * 主机级连接代理表单的纯逻辑（Vault 主机编辑器与连接管理器共用）。
 *
 * 对照 Netcatty components/host-details/ProxyPanel.tsx：单主机内联 HTTP / SOCKS5
 * 代理；密码不进 Profile，落 SecretStore（`proxy:<profile_id>`）。后端
 * db/profile.rs 会再次校验 host/port，这里提前给出可读错误。
 */

import type { Profile } from "../backend/client";

export type ProxyDraftType = "none" | "http" | "socks5";

export interface ProxyDraft {
  type: ProxyDraftType;
  host: string;
  /** 输入框字符串；保存时转 number。 */
  port: string;
  username: string;
  /** 明文输入框；编辑已有代理时留空 = 保持原密码。 */
  password: string;
  /** 逗号分隔的不走代理主机（域名 / IP / host:port）。 */
  noProxy: string;
}

export const EMPTY_PROXY_DRAFT: ProxyDraft = {
  type: "none",
  host: "",
  port: "",
  username: "",
  password: "",
  noProxy: "",
};

export function proxyDraftFromProfile(
  p: Pick<
    Profile,
    "proxy_type" | "proxy_host" | "proxy_port" | "proxy_username" | "proxy_no_proxy"
  >,
): ProxyDraft {
  const type = p.proxy_type === "http" || p.proxy_type === "socks5" ? p.proxy_type : "none";
  if (type === "none") return { ...EMPTY_PROXY_DRAFT };
  return {
    type,
    host: p.proxy_host ?? "",
    port: p.proxy_port ? String(p.proxy_port) : "",
    username: p.proxy_username ?? "",
    password: "",
    noProxy: p.proxy_no_proxy ?? "",
  };
}

/** 返回可读错误；合法则 null。type=none 时忽略其余字段。 */
export function proxyDraftError(d: ProxyDraft): string | null {
  if (d.type === "none") return null;
  if (!d.host.trim()) return "请填写代理主机";
  const port = Number(d.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "代理端口需在 1–65535 之间";
  }
  if (d.password && !d.username.trim()) {
    return "填写代理密码时请同时填写用户名";
  }
  return null;
}

/** 表单 → Profile 的代理字段（type=none 时全部清空）。 */
export function proxyProfileFields(
  d: ProxyDraft,
): Pick<
  Profile,
  "proxy_type" | "proxy_host" | "proxy_port" | "proxy_username" | "proxy_no_proxy"
> {
  if (d.type === "none") {
    return {
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_no_proxy: null,
    };
  }
  return {
    proxy_type: d.type,
    proxy_host: d.host.trim(),
    proxy_port: Number(d.port),
    proxy_username: d.username.trim() || null,
    proxy_no_proxy: d.noProxy.trim() || null,
  };
}

/**
 * 保存代理密码的策略：
 * - type=none 或没有用户名 → 清除；
 * - 新输入了密码 → 覆盖；
 * - 编辑时留空且原来有密码 → 保持不变（不调用 SecretStore）。
 * 返回 null 表示不需要改动 SecretStore。
 */
export function proxyPasswordToSave(
  d: ProxyDraft,
  hadSavedPassword: boolean,
): string | null | undefined {
  if (d.type === "none" || !d.username.trim()) return null;
  const entered = d.password.trim();
  if (entered) return d.password;
  return hadSavedPassword ? undefined : null;
}
