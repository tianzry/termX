/**
 * Vault「端口转发」总览的纯逻辑：按目标主机分组、规则文案、字节格式化。
 *
 * termX 的 Forward 是「条目 + 多条规则」（对照 Netcatty 的单条规则模型）；
 * 运行态来自后端 forward_active_list（active_id / forward_id / 每规则 stats）。
 */

import type { ActiveForwardInfo, Forward, Profile } from "../backend/client";

export interface ForwardHostGroup {
  profileId: string;
  /** 档案被删时回退显示「未知主机」。 */
  profileName: string;
  host: string;
  port: number;
  forwards: Forward[];
  /** 该主机下正在运行的转发条目数。 */
  activeCount: number;
}

const TYPE_LABEL: Record<string, string> = {
  local: "本地",
  remote: "远程",
  dynamic: "SOCKS5",
};

export function ruleLabel(rule: Forward["rules"][number]): string {
  const type = TYPE_LABEL[rule.type] ?? rule.type;
  // 自定义监听地址（Netcatty bindAddress）直接展示；空 = 默认 loopback / sshd 默认。
  const bind = rule.bind_address?.trim() || "127.0.0.1";
  if (rule.type === "dynamic") return `${type} · ${bind}:${rule.local_port}`;
  if (rule.type === "remote") {
    return `${type} · 远端 ${bind}:${rule.local_port} → ${rule.remote_host}:${rule.remote_port}`;
  }
  return `${type} · ${bind}:${rule.local_port} → ${rule.remote_host}:${rule.remote_port}`;
}

/** 按 profile_id 分组；无档案的归入「未知主机」，组内与组间都按名称排序。 */
export function groupForwardsByHost(
  forwards: Forward[],
  profiles: Pick<Profile, "id" | "name" | "host" | "port">[],
  active: Pick<ActiveForwardInfo, "forward_id">[],
): ForwardHostGroup[] {
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const activeIds = new Set(active.map((a) => a.forward_id));
  const groups = new Map<string, ForwardHostGroup>();

  for (const f of forwards) {
    let group = groups.get(f.profile_id);
    if (!group) {
      const p = profileById.get(f.profile_id);
      group = {
        profileId: f.profile_id,
        profileName: p?.name ?? "未知主机",
        host: p?.host ?? "",
        port: p?.port ?? 0,
        forwards: [],
        activeCount: 0,
      };
      groups.set(f.profile_id, group);
    }
    group.forwards.push(f);
    if (activeIds.has(f.id)) group.activeCount += 1;
  }

  const list = [...groups.values()];
  for (const g of list) g.forwards.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  list.sort((a, b) => a.profileName.localeCompare(b.profileName, "zh-CN"));
  return list;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // 整数去掉多余的 ".0"（5.0 MB → 5 MB），非整数保留一位。
  const text = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[i]}`;
}

/** 条目级摘要：连接数 + 上下行；未运行时返回空串。 */
export function forwardSummary(info: ActiveForwardInfo | undefined): string {
  if (!info) return "";
  return `${info.stats.connections} 连接 · ↑${formatBytes(info.stats.bytes_tx)} ↓${formatBytes(
    info.stats.bytes_rx,
  )}`;
}

export function activeFor(
  active: ActiveForwardInfo[],
  forwardId: string,
): ActiveForwardInfo | undefined {
  return active.find((a) => a.forward_id === forwardId);
}
