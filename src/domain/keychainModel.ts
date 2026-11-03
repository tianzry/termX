// 钥匙串（~/.ssh 文件密钥）纯逻辑：生成选项、名称校验、类型标签。
// 名称校验与后端 commands/profile.rs `is_plain_file_name` 同规则，
// 前端先拦一道，减少无谓 IPC 往返；最终裁定仍在后端。

export const SSH_KEY_ALGORITHMS = ["ED25519", "ECDSA", "RSA"] as const;
export type SshKeyAlgorithm = (typeof SSH_KEY_ALGORITHMS)[number];

/** RSA 位宽选项（对齐 netcatty GenerateStandardPanel；1024 过弱不提供）。 */
export const RSA_BIT_OPTIONS = [4096, 2048] as const;
/** ECDSA 曲线选项（256/384/521 → P-256/384/521）。 */
export const ECDSA_CURVE_OPTIONS = [256, 384, 521] as const;

/** 与后端 is_plain_file_name 同规则：单层文件名，无分隔符 / .. / 控制字符。 */
export function isValidSshKeyName(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  for (const ch of name) {
    if (ch.charCodeAt(0) < 0x20) return false;
  }
  return true;
}

/** 算法名 → 友好标签；空串（无法判定情形，如传统 PEM 无 .pub）→「未知」。 */
export function keyTypeLabel(keyType: string): string {
  switch (keyType) {
    case "ssh-ed25519":
      return "Ed25519";
    case "ssh-rsa":
      return "RSA";
    case "ecdsa-sha2-nistp256":
      return "ECDSA P-256";
    case "ecdsa-sha2-nistp384":
      return "ECDSA P-384";
    case "ecdsa-sha2-nistp521":
      return "ECDSA P-521";
    case "ssh-dss":
      return "DSA";
    case "":
      return "未知";
    default:
      return keyType;
  }
}

/** 新密钥的缺省文件名（OpenSSH 惯例）。 */
export function defaultKeyName(algorithm: SshKeyAlgorithm): string {
  switch (algorithm) {
    case "ED25519":
      return "id_ed25519";
    case "ECDSA":
      return "id_ecdsa";
    case "RSA":
      return "id_rsa";
  }
}
