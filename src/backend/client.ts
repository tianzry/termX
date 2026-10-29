import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * termX 前端 ↔ Tauri Rust 后端的统一桥接层（NFC 契约）。
 *
 * 目标形状对齐 netcatty 的 `window.netcatty` 服务面（session / sftp / ssh），
 * 但底层是 `invoke` + `listen`，供上层业务无感迁移。
 *
 * 关键约定（务必记牢，来自 rssh 后端）：
 * - 顶层 invoke 参数用 camelCase（Tauri 自动映射到 Rust snake_case）；
 *   但「嵌套 struct」（credential / profile）内部字段走 serde 原样 snake_case / 别名，不转换。
 * - 终端字节流「下行」（后端→前端）统一走 base64 文本事件 `<domain>:data:<id>`，收包要 atob 解码；
 *   「上行」（前端→后端 write）走 JSON number 数组（Uint8Array → Vec<u8>）。
 * - 交互 prompt（keyboard-interactive / passphrase / host_key）各自有独立事件与 respond 命令，
 *   key 统一是连接时的 `sessionId`（即 tab_id / prompt_id）。
 */

export type TerminalDomain = "pty" | "ssh";
export type CredentialType = "password" | "key" | "interactive" | "agent" | "none";

export interface Credential {
  id: string;
  name: string;
  username: string;
  /** serde 别名：Rust `Credential.credential_type` 序列化为 `type`。 */
  type: CredentialType;
  secret: string | null;
  save_to_remote: boolean;
}

export interface SshAlgorithms {
  kex: string[];
  key: string[];
  cipher: string[];
  mac: string[];
  compression: string[];
}

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  credential_id: string;
  bastion_profile_id: string | null;
  init_command: string | null;
  group_id: string | null;
  algorithms?: SshAlgorithms;
}

export interface RemoteEntry {
  name: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  /** unix epoch seconds；0 = 服务端未提供 mtime */
  mtime: number;
}

export interface FileStat {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  uid?: number;
  gid?: number;
  user?: string;
  group?: string;
  /** 权限位（u32，如 0o755），非 netcatty 的 "rwxr-xr-x" 字符串。 */
  permissions?: number;
}

/** keyboard-interactive 提示载荷。 */
export interface AuthPrompt {
  name: string;
  instructions: string;
  prompts: Array<{ prompt: string; echo: boolean }>;
}

/** 会话退出信息（ssh:close / pty:close 事件载荷）。 */
export interface CloseInfo {
  exit_code?: number;
  signal?: string;
}

// ── 字节编解码 ────────────────────────────────────────────

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

export function bytesToText(data: number[]): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(
    Uint8Array.from(data),
  );
}

// ── 凭据 / 主机档案 ───────────────────────────────────────

export function createCredential(credential: Credential): Promise<void> {
  return invoke("create_credential", { credential });
}

export function createProfile(profile: Profile): Promise<void> {
  return invoke("create_profile", { profile });
}

// ── SSH 会话 ──────────────────────────────────────────────

/** 生成一个 sessionId，供前端在 `sshConnect` 之前注册 prompt 监听。 */
export function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * 经 profile_id 建立 SSH 连接。客户端先自生成 sessionId 传进去，
 * 后端会用它同时作为：真实 session_id、prompt_id（三个交互 prompt 的 key）。
 *
 * `sessionId` 可注入：调用方在 await 之前就要用同一个 id 注册
 * keyboard-interactive / passphrase / host_key 三个 prompt 监听，
 * 否则 `ssh_connect` 在认证 pending 期间发出的 prompt 事件会丢。
 */
export function sshConnect(
  profileId: string,
  cols: number,
  rows: number,
  sessionId?: string,
): Promise<string> {
  const sid = sessionId ?? crypto.randomUUID();
  return invoke<string>("ssh_connect", {
    profileId,
    logSessionId: sid,
    cols,
    rows,
    sessionId: sid,
  });
}

export function sshWrite(sessionId: string, text: string): Promise<void> {
  return invoke("ssh_write", { sessionId, data: toBytes(text) });
}

export function sshResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("ssh_resize", { sessionId, cols, rows });
}

export function sshDisconnect(sessionId: string): Promise<void> {
  return invoke("ssh_disconnect", { sessionId, tabId: null });
}

// ── SSH 交互 prompt（keyboard-interactive / passphrase / host_key） ──

export function sshAuthRespond(
  promptId: string,
  responses: string[],
): Promise<void> {
  return invoke("ssh_auth_respond", { tabId: promptId, responses });
}

export function sshAuthCancel(promptId: string): Promise<void> {
  return invoke("ssh_auth_cancel", { tabId: promptId });
}

export function sshPassphraseRespond(
  promptId: string,
  passphrase: string,
): Promise<void> {
  return invoke("ssh_passphrase_respond", { tabId: promptId, passphrase });
}

export function sshPassphraseCancel(promptId: string): Promise<void> {
  return invoke("ssh_passphrase_cancel", { tabId: promptId });
}

export function sshHostKeyRespond(
  promptId: string,
  answer: string,
): Promise<void> {
  return invoke("ssh_host_key_respond", { tabId: promptId, answer });
}

export function sshHostKeyCancel(promptId: string): Promise<void> {
  return invoke("ssh_host_key_cancel", { tabId: promptId });
}

// ── 本地 PTY ──────────────────────────────────────────────

export function ptySpawn(cols: number, rows: number): Promise<string> {
  return invoke<string>("pty_spawn", { cols, rows, sessionId: null });
}

export function ptyWrite(sessionId: string, text: string): Promise<void> {
  return invoke("pty_write", { sessionId, data: toBytes(text) });
}

export function ptyResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("pty_resize", { sessionId, cols, rows });
}

export function ptyClose(sessionId: string): Promise<void> {
  return invoke("pty_close", { sessionId });
}

// ── 事件订阅 ──────────────────────────────────────────────

export function onTerminalData(
  domain: TerminalDomain,
  sessionId: string,
  cb: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<string>(`${domain}:data:${sessionId}`, (ev) =>
    cb(decodeBase64(ev.payload)),
  );
}

export function onTerminalClose(
  domain: TerminalDomain,
  sessionId: string,
  cb: (info: CloseInfo) => void,
): Promise<UnlistenFn> {
  return listen<CloseInfo>(`${domain}:close:${sessionId}`, (ev) =>
    cb(ev.payload),
  );
}

export function onAuthPrompt(
  sessionId: string,
  cb: (payload: AuthPrompt) => void,
): Promise<UnlistenFn> {
  return listen<AuthPrompt>(`ssh:auth_prompt:${sessionId}`, (ev) =>
    cb(ev.payload),
  );
}

export function onPassphrasePrompt(
  sessionId: string,
  cb: (payload: { prompt: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ prompt: string }>(
    `ssh:passphrase_prompt:${sessionId}`,
    (ev) => cb(ev.payload),
  );
}

export function onHostKeyPrompt(
  sessionId: string,
  cb: (payload: { banner: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ banner: string }>(
    `ssh:host_key_prompt:${sessionId}`,
    (ev) => cb(ev.payload),
  );
}

// ── SFTP ─────────────────────────────────────────────────

/** 独立 TCP 建 SFTP（host/port/username + auth_type/secret）。 */
export function sftpConnect(
  host: string,
  port: number,
  username: string,
  authType: CredentialType,
  secret: string | null,
): Promise<string> {
  return invoke<string>("sftp_connect", {
    host,
    port,
    username,
    authType,
    secret,
  });
}

/** 复用已连上的 SSH 会话建 SFTP（无需二次认证）。 */
export function sftpConnectSession(sessionId: string): Promise<string> {
  return invoke<string>("sftp_connect_session", { sessionId });
}

export function sftpHome(sftpId: string): Promise<string> {
  return invoke<string>("sftp_home", { sftpId });
}

export function sftpList(
  sftpId: string,
  path: string,
): Promise<RemoteEntry[]> {
  return invoke<RemoteEntry[]>("sftp_list", { sftpId, path });
}

/** 读远端文件（内存 Vec<u8> → number[]）。 */
export function sftpDownload(
  sftpId: string,
  path: string,
): Promise<number[]> {
  return invoke<number[]>("sftp_download", { sftpId, path });
}

export function sftpUpload(
  sftpId: string,
  path: string,
  data: Uint8Array,
): Promise<void> {
  return invoke("sftp_upload", { sftpId, path, data: Array.from(data) });
}

export function sftpMkdir(sftpId: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { sftpId, path });
}

export function sftpRemove(sftpId: string, path: string): Promise<void> {
  return invoke("sftp_remove", { sftpId, path });
}

export function sftpRename(
  sftpId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke("sftp_rename", { sftpId, oldPath, newPath });
}

export function sftpStat(sftpId: string, path: string): Promise<FileStat> {
  return invoke<FileStat>("sftp_stat", { sftpId, path });
}

export function sftpClose(sftpId: string): Promise<void> {
  return invoke("sftp_close", { sftpId });
}

// ── 远程命令执行 / chmod ───────────────────────────────────

/**
 * 在已建立的 SSH 会话上跑一次性远程命令，返回 stdout/stderr/exitCode。
 * `timeoutMs` 缺省 10s（后端 clamp 到 [1s, 60s]）。
 */
export function sshExec(
  sessionId: string,
  command: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exit_code: number | null }> {
  return invoke("ssh_exec", { sessionId, command, timeoutMs });
}

/** 修改远端文件权限位（`mode` 传十进制，如 0o755 → 493）。 */
export function sftpChmod(
  sftpId: string,
  path: string,
  mode: number,
): Promise<void> {
  return invoke("sftp_chmod", { sftpId, path, mode });
}