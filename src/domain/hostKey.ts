/** 主机密钥校验载荷（对齐 netcatty/domain/hostKey.ts）。 */
export type HostKeyInfo = {
  hostname: string;
  port: number;
  keyType: string;
  fingerprint: string;
  publicKey?: string;
  status?: "unknown" | "changed";
  knownHostId?: string;
  knownFingerprint?: string;
};

/** 后端 `ssh:host_key_prompt` 原始载荷（Rust serde snake_case）。 */
export interface HostKeyPromptPayload {
  banner?: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  status?: "unknown" | "changed";
  known_fingerprint?: string;
}

export const toHostKeyInfo = (payload: HostKeyPromptPayload): HostKeyInfo => ({
  hostname: payload.host,
  port: payload.port ?? 22,
  keyType: payload.key_type,
  fingerprint: payload.fingerprint,
  status: payload.status,
  knownFingerprint: payload.known_fingerprint,
});
