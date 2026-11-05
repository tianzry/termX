/**
 * 主机级 known-host 校验策略（profile.host_key_policy）。
 *
 * - `default`（存 null）：跟随设置中心的全局 `verifyHostKeys`，老数据行为不变。
 * - `verify`：该主机始终校验主机密钥。
 * - `skip`：该主机跳过校验（仅限可信网络 / 自建环境）。
 */

export type HostKeyPolicy = "default" | "verify" | "skip";

export const HOST_KEY_POLICIES: Array<{
  value: HostKeyPolicy;
  label: string;
}> = [
  { value: "default", label: "跟随全局" },
  { value: "verify", label: "始终校验" },
  { value: "skip", label: "跳过校验" },
];

/** DB / Profile 里的可空值 → 编辑器枚举；未知值一律回落「跟随全局」。 */
export function hostKeyPolicyFromProfile(
  raw: string | null | undefined,
): HostKeyPolicy {
  return raw === "verify" || raw === "skip" ? raw : "default";
}

/** 编辑器枚举 → Profile / DB 列值；「跟随全局」落 null。 */
export function hostKeyPolicyToProfile(
  policy: HostKeyPolicy,
): "verify" | "skip" | null {
  return policy === "default" ? null : policy;
}

/** 一行式展示文案（全局值只在「跟随全局」时附注）。 */
export function hostKeyPolicyLabel(
  policy: HostKeyPolicy,
  globalVerify: boolean,
): string {
  if (policy === "default") {
    return `跟随全局（当前${globalVerify ? "校验" : "跳过"}）`;
  }
  return policy === "verify" ? "始终校验" : "跳过校验";
}
