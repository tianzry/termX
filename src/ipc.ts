import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * termX NFC 桥接层（前端 ↔ Tauri Rust 后端）。
 *
 * 关键约定（从 rssh 后端摸清）：
 * - 终端字节流统一走 base64 文本事件 `<domain>:data:<sessionId>`，收包要 atob 解码；
 * - 写入走 `domain_write`，dat 字段是 JSON number 数组（TextEncoder → Array.from）；
 * - 顶层 invoke 参数走 camelCase（Tauri 自动映射 Rust snake_case），
 *   但嵌套 struct（credential / profile）内部字段是 serde 的 snake_case，不转换。
 */

export type Domain = "pty" | "ssh";

/** base64 → Uint8Array（后端终端数据统一编码） */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** UTF-8 文本 → 数字数组，作为 Vec<u8> 传给后端 */
function toBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

// —— 本地 PTY ——
export function ptySpawn(cols: number, rows: number): Promise<string> {
  return invoke<string>("pty_spawn", { cols, rows, sessionId: null });
}
export function ptyWrite(sessionId: string, text: string): Promise<void> {
  return invoke("pty_write", { sessionId, data: toBytes(text) });
}
export function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { sessionId, cols, rows });
}
export function ptyClose(sessionId: string): Promise<void> {
  return invoke("pty_close", { sessionId });
}

// —— SSH ——
// 嵌套对象字段用 snake_case（serde 字段名），区别于顶层 camelCase 参数名。
export interface CredentialPayload {
  id: string;
  name: string;
  username: string;
  type: string; // "password" | "key" | "interactive" | "agent" | "none"
  secret: string;
  save_to_remote: boolean;
}

export interface ProfilePayload {
  id: string;
  name: string;
  host: string;
  port: number;
  credential_id: string;
  bastion_profile_id: string | null;
  init_command: string | null;
  group_id: string | null;
  algorithms?: {
    kex: string[];
    key: string[];
    cipher: string[];
    mac: string[];
    compression: string[];
  };
}

export function createCredential(credential: CredentialPayload): Promise<void> {
  return invoke("create_credential", { credential });
}
export function createProfile(profile: ProfilePayload): Promise<void> {
  return invoke("create_profile", { profile });
}
export function sshConnect(profileId: string, cols: number, rows: number): Promise<string> {
  return invoke<string>("ssh_connect", {
    profileId,
    logSessionId: null,
    cols,
    rows,
    sessionId: null,
  });
}
export function sshWrite(sessionId: string, text: string): Promise<void> {
  return invoke("ssh_write", { sessionId, data: toBytes(text) });
}
export function sshResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("ssh_resize", { sessionId, cols, rows });
}
export function sshDisconnect(sessionId: string): Promise<void> {
  return invoke("ssh_disconnect", { sessionId, tabId: null });
}

// —— 事件订阅 ——
export function onData(
  domain: Domain,
  sessionId: string,
  cb: (bytes: Uint8Array) => void
): Promise<UnlistenFn> {
  return listen<string>(`${domain}:data:${sessionId}`, (ev) => cb(decodeBase64(ev.payload)));
}

export function onClose(
  domain: Domain,
  sessionId: string,
  cb: () => void
): Promise<UnlistenFn> {
  return listen(`${domain}:close:${sessionId}`, () => cb());
}