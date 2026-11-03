// SSH Agent 状态展示纯逻辑（钥匙串阶段 B）。
// 后端 `ssh_agent_status` 不抛错、永远返回状态对象；本层只把状态对象
// 翻成可直接渲染的中文文案，与钥匙串页现有文案风格一致。
import type { SshAgentStatus } from "../backend/client";

export interface AgentStatusText {
  /** 运行中 / 未运行。 */
  title: string;
  /** 状态点右侧的次级说明：kind + path；未运行时给简短原因。 */
  detail: string;
}

/** kind → 友好标签。 */
export function agentKindLabel(kind: SshAgentStatus["kind"]): string {
  switch (kind) {
    case "unix-socket":
      return "Unix Socket";
    case "named-pipe":
      return "命名管道";
    case "pageant":
      return "Pageant";
    case "none":
      return "无";
  }
}

export function describeAgentStatus(status: SshAgentStatus): AgentStatusText {
  if (status.running) {
    // pageant 运行时 path 恒为 "pageant"，再拼一遍重复。
    const detail =
      status.kind === "pageant"
        ? agentKindLabel("pageant")
        : `${agentKindLabel(status.kind)} · ${status.path}`;
    return { title: "运行中", detail };
  }
  if (status.error) {
    return { title: "未运行", detail: status.error };
  }
  return { title: "未运行", detail: "未发现可用的 SSH Agent" };
}
