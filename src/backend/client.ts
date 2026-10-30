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

/**
 * 生成一个 sessionId，供前端在 `sshConnect` 之前注册 prompt 监听。
 * `crypto.randomUUID()` 只在安全上下文可用，浏览器 HTTP 调试时回退。
 */
export function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

// ── 阶段 2：串口 / Telnet / 端口转发 ────────────────────────

/** 连接类型全集（比 TerminalDomain 多了 serial / telnet，无域名事件）。 */
export type ConnKind = "pty" | "ssh" | "serial" | "telnet";

/** 终端面板与主终端的传输绑定：按键上行 / resize / close 三句柄。 */
export interface TerminalTransport {
  kind: ConnKind;
  write: (text: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

/**
 * 主终端 ↔ 侧栏面板（串口 / Telnet）的桥：面板持会话，主终端负责渲染与按键。
 * - receive：会话下行字节写入主终端；
 * - attach / detach：把主终端的按键与 resize 路由到该会话，或解除路由；
 * - size：读主终端当前尺寸（telnet_open 需要 cols/rows 作为 NAWS 初值）。
 */
export interface TermBridge {
  receive: (bytes: Uint8Array) => void;
  attach: (transport: TerminalTransport) => void;
  detach: () => void;
  size: () => { cols: number; rows: number } | null;
}

// ── 串口 ──────────────────────────────────────────────────

export interface SerialConfig {
  baud_rate: number;
  data_bits?: number; // 默认 8
  parity?: string; // none | odd | even
  stop_bits?: number; // 1 | 2
  flow_control?: string; // none | software | hardware
  xany?: boolean;
}

export function serialListPorts(): Promise<string[]> {
  return invoke<string[]>("serial_list_ports");
}

/**
 * 打开串口。`sessionId` 可注入：调用方在 await 之前用同一个 id 注册
 * data/close 监听，避免 open 返回后首个数据包与监听注册之间的竞态丢包。
 * `config` 是嵌套 struct，其内部字段走 serde 原样 snake_case，不转换。
 */
export function serialOpen(
  port: string,
  config: SerialConfig,
  sessionId?: string,
): Promise<string> {
  return invoke<string>("serial_open", { port, config, sessionId });
}

/** 串口写入：终端按键文本 → UTF-8 字节。 */
export function serialWrite(sessionId: string, text: string): Promise<void> {
  return invoke("serial_write", { sessionId, data: toBytes(text) });
}

export function serialSetDtr(
  sessionId: string,
  level: boolean,
): Promise<void> {
  return invoke("serial_set_dtr", { sessionId, level });
}

export function serialSetRts(
  sessionId: string,
  level: boolean,
): Promise<void> {
  return invoke("serial_set_rts", { sessionId, level });
}

export function serialSendBreak(sessionId: string): Promise<void> {
  return invoke("serial_send_break", { sessionId });
}

export function serialClose(sessionId: string): Promise<void> {
  return invoke("serial_close", { sessionId });
}

export function onSerialData(
  sessionId: string,
  cb: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<string>(`serial:data:${sessionId}`, (ev) =>
    cb(decodeBase64(ev.payload)),
  );
}

/** 串口关闭事件载荷为 unit（序列化为 null），故回调无参。 */
export function onSerialClose(
  sessionId: string,
  cb: () => void,
): Promise<UnlistenFn> {
  return listen<null>(`serial:close:${sessionId}`, () => cb());
}

// ── Telnet ────────────────────────────────────────────────

export function telnetOpen(
  host: string,
  port: number,
  cols: number,
  rows: number,
  inputNewline: string | null,
  sessionId?: string,
): Promise<string> {
  return invoke<string>("telnet_open", {
    host,
    port,
    cols,
    rows,
    inputNewline,
    sessionId,
  });
}

/** 终端按键文本 → UTF-8 字节（Telnet NVT 原始字节流）。 */
export function telnetWrite(sessionId: string, text: string): Promise<void> {
  return invoke("telnet_write", { sessionId, data: toBytes(text) });
}

/** 发送一行并附换行（换行风格由 open 时的 inputNewline 决定）。 */
export function telnetWriteLine(
  sessionId: string,
  text: string,
): Promise<void> {
  return invoke("telnet_write_line", { sessionId, text });
}

export function telnetResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("telnet_resize", { sessionId, cols, rows });
}

export function telnetClose(sessionId: string): Promise<void> {
  return invoke("telnet_close", { sessionId });
}

export function onTelnetData(
  sessionId: string,
  cb: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<string>(`telnet:data:${sessionId}`, (ev) =>
    cb(decodeBase64(ev.payload)),
  );
}

/** RFC 854 ECHO 协商结果：服务端是否要求本地回显。 */
export function onTelnetEcho(
  sessionId: string,
  cb: (enabled: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>(`telnet:echo:${sessionId}`, (ev) => cb(ev.payload));
}

export function onTelnetClose(
  sessionId: string,
  cb: () => void,
): Promise<UnlistenFn> {
  return listen<null>(`telnet:close:${sessionId}`, () => cb());
}

// ── 端口转发 ─────────────────────────────────────────────

export type ForwardType = "local" | "remote" | "dynamic";

export interface ForwardRule {
  /** serde 别名：Rust `ForwardRule.forward_type` 序列化为 `type`。 */
  type: ForwardType;
  local_port: number;
  remote_host: string;
  remote_port: number;
}

export interface Forward {
  id: string;
  name: string;
  profile_id: string;
  group_id: string | null;
  rules: ForwardRule[];
}

export type ForwardRuleStatus =
  | "starting"
  | "active"
  | "stopped"
  | "error"
  | "stopping_error";

export interface ForwardRuleStats {
  index: number;
  rule: ForwardRule;
  status: ForwardRuleStatus;
  bytes_tx: number;
  bytes_rx: number;
  connections: number;
  effective_port: number | null;
  error: string | null;
}

export interface ForwardStats {
  bytes_tx: number;
  bytes_rx: number;
  connections: number;
  connected: boolean;
  rules: ForwardRuleStats[];
}

export function listProfiles(): Promise<Profile[]> {
  return invoke<Profile[]>("list_profiles");
}

export function listForwards(): Promise<Forward[]> {
  return invoke<Forward[]>("list_forwards");
}

export function getForward(id: string): Promise<Forward> {
  return invoke<Forward>("get_forward", { id });
}

export function createForward(forward: Forward): Promise<void> {
  return invoke("create_forward", { forward });
}

export function updateForward(forward: Forward): Promise<void> {
  return invoke("update_forward", { forward });
}

export function deleteForward(id: string): Promise<void> {
  return invoke("delete_forward", { id });
}

/** 启动一个转发条目，返回分配到的活跃会话 active_id。 */
export function forwardStart(forwardId: string): Promise<string> {
  return invoke<string>("forward_start", { forwardId });
}

export function forwardStop(activeId: string): Promise<void> {
  return invoke("forward_stop", { activeId });
}

export function forwardStats(activeId: string): Promise<ForwardStats> {
  return invoke<ForwardStats>("forward_stats", { activeId });
}

export function forwardRuleStart(
  activeId: string,
  ruleIndex: number,
): Promise<void> {
  return invoke("forward_rule_start", { activeId, ruleIndex });
}

export function forwardRuleStop(
  activeId: string,
  ruleIndex: number,
): Promise<void> {
  return invoke("forward_rule_stop", { activeId, ruleIndex });
}

/** 递归遍历结果：`rel_path` 统一用 '/'，`size` 为字节数。 */
export interface WalkEntry {
  rel_path: string;
  size: number;
}

export interface TransferProgress {
  transferred: number;
  total: number;
}

// ── SFTP 增强：流式传输 / 递归 / 原生选择框 ────────────────

/** 递归列出远端目录下的全部文件（符号链接到目录会被跳过以防环）。 */
export function sftpWalkRemote(
  sftpId: string,
  remoteRoot: string,
): Promise<WalkEntry[]> {
  return invoke<WalkEntry[]>("sftp_walk_remote_dir", { sftpId, remoteRoot });
}

/** 递归列出本地目录下的全部文件（`rel_path` 用 '/'）。 */
export function walkLocalDir(localRoot: string): Promise<WalkEntry[]> {
  return invoke<WalkEntry[]>("walk_local_dir", { localRoot });
}

/**
 * 流式下载到指定本地路径。`transferId` 同时是进度事件
 * `sftp:progress:{transferId}` 的 key；父目录不存在会自动创建。
 */
export function sftpDownloadTo(
  sftpId: string,
  remotePath: string,
  localPath: string,
  transferId: string,
): Promise<void> {
  return invoke("sftp_download_to", {
    sftpId,
    remotePath,
    localPath,
    transferId,
  });
}

/** 流式上传指定本地文件（远端父目录会自动 mkdir -p）。 */
export function sftpUploadFrom(
  sftpId: string,
  localPath: string,
  remotePath: string,
  transferId: string,
): Promise<void> {
  return invoke("sftp_upload_from", {
    sftpId,
    localPath,
    remotePath,
    transferId,
  });
}

/** 取消某个传输：后端把 cancel flag 置位，循环在下一 chunk 退出。 */
export function sftpCancelTransfer(transferId: string): Promise<void> {
  return invoke("sftp_cancel_transfer", { transferId });
}

export function sftpPickSavePath(defaultName: string): Promise<string | null> {
  return invoke<string | null>("sftp_pick_save_path", { defaultName });
}

export function sftpPickOpenPath(): Promise<string | null> {
  return invoke<string | null>("sftp_pick_open_path");
}

/** 选目录（既作多选下载的目标根，也作递归上传的源根）。 */
export function sftpPickFolder(): Promise<string | null> {
  return invoke<string | null>("sftp_pick_folder");
}

/** 多选文件（上传）。 */
export function sftpPickOpenFiles(): Promise<string[] | null> {
  return invoke<string[] | null>("sftp_pick_open_files");
}

export function onSftpProgress(
  transferId: string,
  cb: (p: TransferProgress) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgress>(`sftp:progress:${transferId}`, (ev) =>
    cb(ev.payload),
  );
}

// ── 连接管理器：档案 / 凭据 / 分组 CRUD ────────────────────

export interface Group {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  terminal_waves_enabled?: boolean;
}

export function listGroups(): Promise<Group[]> {
  return invoke<Group[]>("list_groups");
}

export function createGroup(group: Group): Promise<void> {
  return invoke("create_group", { group });
}

export function updateGroup(group: Group): Promise<void> {
  return invoke("update_group", { group });
}

export function deleteGroup(id: string): Promise<void> {
  return invoke("delete_group", { id });
}

export function getProfile(id: string): Promise<Profile> {
  return invoke<Profile>("get_profile", { id });
}

export function updateProfile(profile: Profile): Promise<void> {
  return invoke("update_profile", { profile });
}

export function deleteProfile(id: string): Promise<void> {
  return invoke("delete_profile", { id });
}

/** 列表不返回 secret（避免无谓 keychain 查询）；编辑时用 getCredential 取全量。 */
export function listCredentials(): Promise<Credential[]> {
  return invoke<Credential[]>("list_credentials");
}

export function getCredential(id: string): Promise<Credential> {
  return invoke<Credential>("get_credential", { id });
}

export function updateCredential(credential: Credential): Promise<void> {
  return invoke("update_credential", { credential });
}

export function deleteCredential(id: string): Promise<void> {
  return invoke("delete_credential", { id });
}

/** 读 `~/.ssh/<name>` 原文（后端白名单，仅 id_rsa / id_ed25519）。 */
export function readDefaultKeyFile(name: "id_rsa" | "id_ed25519"): Promise<string> {
  return invoke<string>("read_default_key_file", { name });
}