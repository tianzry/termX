/**
 * 端口转发条目草稿的纯逻辑：可用档案过滤与提交前校验。
 * 与 UI 无关，便于单测（表单本身只管字段状态）。
 */

import type { ForwardRule, Profile } from "../backend/client";

export interface ForwardDraft {
  name: string;
  profile_id: string;
  rules: ForwardRule[];
  /** 应用启动后自动拉起。 */
  auto_start: boolean;
  /** 三态：null = 跟随 auto_start（Netcatty autoReconnect ?? autoStart）。 */
  auto_reconnect: boolean | null;
}

/** 本地 shell 档案无法建立 SSH 转发，过滤掉。 */
export function sshProfiles(profiles: Profile[]): Profile[] {
  return profiles.filter((p) => p.protocol !== "local");
}

/** 校验草稿；返回 null 表示通过。本地端口 0 = 由系统自动分配（有效端口见统计）。 */
export function validateForwardDraft(draft: ForwardDraft): string | null {
  if (!draft.name.trim()) return "请填写转发名称";
  if (!draft.profile_id) return "请选择 SSH 会话档案";
  if (!draft.rules.length) return "请至少添加一条转发规则";
  for (let i = 0; i < draft.rules.length; i += 1) {
    const r = draft.rules[i];
    if (!Number.isInteger(r.local_port) || r.local_port < 0 || r.local_port > 65535) {
      return `规则 ${i + 1}：本地端口需在 0-65535（0 = 自动分配）`;
    }
    const bind = (r.bind_address ?? "").trim();
    // 监听地址允许为空（默认），也允许 IPv4/IPv6/主机名；只挡明显非法的空格/斜杠。
    if (/[\s/]/.test(bind)) return `规则 ${i + 1}：监听地址不能包含空白或斜杠`;
    if (r.type !== "dynamic") {
      if (!(r.remote_host ?? "").trim()) return `规则 ${i + 1}：请填写远端主机`;
      if (!Number.isInteger(r.remote_port) || r.remote_port < 1 || r.remote_port > 65535) {
        return `规则 ${i + 1}：远端端口需在 1-65535`;
      }
    }
  }
  return null;
}
