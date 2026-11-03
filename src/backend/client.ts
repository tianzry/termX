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
  /** SFTP 文件协议：`auto` / `sftp` / `scp`；null/undefined = auto */
  sftp_protocol?: string | null;
  sftp_sudo?: boolean;
  /** 文件名编码：`auto` / `utf-8` / `gb18030` */
  sftp_encoding?: string | null;
  /** 图标来源：`auto` / `custom` */
  icon_source?: string | null;
  icon_color?: string | null;
  /** TOTP 自动提交，默认 true */
  totp_auto_submit?: boolean;
  totp_regex?: string | null;
  /** 连接时把本机 SSH Agent 转发给远端（serde 默认 false） */
  agent_forwarding: boolean;
  /** 协议类型：`ssh`（默认）/ `local`（本地 shell 主机，走 PTY） */
  protocol?: string;
  /** 本地主机：选中的 shell 命令；空 = 跟随 设置 → 终端 的默认本地 Shell */
  local_shell?: string | null;
  /** 本地主机：shell 启动参数快照；null = 按 shell 默认行为 */
  local_shell_args?: string[] | null;
  /** 本地主机：shell 显示名快照 */
  local_shell_name?: string | null;
  /** 本地主机：shell 图标快照 */
  local_shell_icon?: string | null;
  /** 本地主机：启动目录（`~` 由后端展开为主目录） */
  local_start_dir?: string | null;
}

/** 本机发现的可用 shell（后端 `discover_shells`，对齐 Netcatty 形状）。 */
export interface DiscoveredShell {
  id: string;
  name: string;
  command: string;
  args: string[];
  icon: string;
  is_default: boolean;
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
  is_symlink: boolean;
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

/** 主机密钥提示载荷（后端 `ssh:host_key_prompt`）。 */
export interface HostKeyPrompt {
  banner?: string;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  status?: "unknown" | "changed";
  known_fingerprint?: string;
}

/** 连接进度事件（后端 `ssh:progress:<sessionId>`）。 */
export interface SshProgressEvent {
  hop: number;
  total: number;
  label: string;
  /** connecting | tcp-connected | authenticating | auth-attempt | authenticated | forwarding | shell | connected | error */
  status: string;
  error: string | null;
}

/** 一次性认证覆盖（连接弹窗认证失败后重试，不写回 DB）。 */
export interface AuthOverride {
  username?: string;
  password?: string;
  credential_id?: string;
  /** 私钥 passphrase（仅 key 凭据；后端写入本次进程缓存，不落库）。 */
  passphrase?: string;
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
  authOverride?: AuthOverride | null,
): Promise<string> {
  const sid = sessionId ?? crypto.randomUUID();
  return invoke<string>("ssh_connect", {
    profileId,
    logSessionId: sid,
    cols,
    rows,
    sessionId: sid,
    authOverride: authOverride ?? null,
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

/** 本地会话启动参数（本地 shell 主机 / 快速终端共用）。
 * 全部可选：缺省时后端按 设置 → 默认 shell 兜底。 */
export interface PtySpawnOptions {
  /** shell 命令或发现列表里的 shell 解析结果 */
  shell?: string;
  /** shell 启动参数快照（发现列表元数据） */
  args?: string[];
  /** 启动目录（`~` 后端展开为主目录） */
  startDir?: string;
}

export function ptySpawn(
  cols: number,
  rows: number,
  opts?: PtySpawnOptions,
): Promise<string> {
  return invoke<string>("pty_spawn", {
    cols,
    rows,
    sessionId: null,
    shell: opts?.shell ?? null,
    args: opts?.args ?? null,
    startDir: opts?.startDir ?? null,
  });
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

/** 本机默认 shell（与 pty_spawn 同一套解析：local_shell 设置优先）。 */
export function defaultShell(): Promise<string> {
  return invoke<string>("default_shell");
}

/** 本机发现的可用 shell 列表（本地终端主机面板的 Shell 下拉）。 */
export function discoverShells(): Promise<DiscoveredShell[]> {
  return invoke<DiscoveredShell[]>("discover_shells");
}

/** 读设置项（不存在 = null）。 */
export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

/** 写设置项。 */
export function setSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
}

// ── 设置中心支撑命令 ─────────────────────────────────────

/** 系统字体条目（后端 `list_fonts`，fontdb 枚举）。 */
export interface FontInfo {
  family: string;
  monospaced: boolean;
}

// --- Snippets（P0 #5 阶段 A；字段对齐 Netcatty Snippet 子集，snake_case 镜像 serde） ---

export interface Snippet {
  /** 稳定 id；旧数据可能为空，前端用 ensureSnippetIds 补齐。 */
  id: string;
  name: string;
  /** 命令内容（可多行）。 */
  command: string;
  description: string;
  /** 分组（package 路径，如 "ops/db"）；空 = 未分组。 */
  package: string;
  tags: string[];
  /** 快捷键，如 "F1" / "Ctrl + Shift + F1"；空 = 未绑定。 */
  shortkey: string;
  /** true = 仅插入、不追加回车执行。 */
  no_auto_run: boolean;
  /** "snippet" | "script"（对齐 Netcatty snippet.kind）；空 = 片段。 */
  kind: string;
  /** 多行发送方式："paste"（默认一次性）| "lineDelay"（逐行）。 */
  multi_line_run_mode: string;
}

export function loadSnippets(): Promise<Snippet[]> {
  return invoke<Snippet[]>("load_snippets");
}

export function saveSnippets(snippets: Snippet[]): Promise<void> {
  return invoke("save_snippets", { snippets });
}

export function listFonts(): Promise<FontInfo[]> {
  return invoke<FontInfo[]>("list_fonts");
}

/** 当前 secret 存储后端名（如 windows-credential-manager / db）。 */
export function secretBackend(): Promise<string> {
  return invoke<string>("secret_backend");
}

export interface AutoLaunchStatus {
  supported: boolean;
  enabled: boolean;
}

export function getAutoLaunch(): Promise<AutoLaunchStatus> {
  return invoke<AutoLaunchStatus>("get_auto_launch");
}

export function setAutoLaunch(enabled: boolean): Promise<AutoLaunchStatus> {
  return invoke<AutoLaunchStatus>("set_auto_launch", { enabled });
}

/** 应用版本号（Tauri app API；权限缺失时由调用方兜底）。 */
export async function appVersion(): Promise<string> {
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
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
  cb: (payload: HostKeyPrompt) => void,
): Promise<UnlistenFn> {
  return listen<HostKeyPrompt>(
    `ssh:host_key_prompt:${sessionId}`,
    (ev) => cb(ev.payload),
  );
}

export function onSshProgress(
  sessionId: string,
  cb: (payload: SshProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<SshProgressEvent>(`ssh:progress:${sessionId}`, (ev) =>
    cb(ev.payload),
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

/** 远端 lstat：不跟随符号链接（`is_symlink` 可信）。 */
export function sftpLstat(sftpId: string, path: string): Promise<FileStat> {
  return invoke<FileStat>("sftp_lstat", { sftpId, path });
}

/** 远端 realpath：把 "." / 相对路径 / 符号链接解析为绝对路径。 */
export function sftpRealpath(sftpId: string, path: string): Promise<string> {
  return invoke<string>("sftp_realpath", { sftpId, path });
}

// ── 本地文件系统（SFTP 双栏本地侧）─────────────────────────

/** 本地目录条目（对齐后端 `LocalEntry`）。 */
export interface LocalEntry {
  name: string;
  /** "file" | "directory" | "symlink" */
  kind: "file" | "directory" | "symlink";
  size: number;
  /** unix epoch 秒；0 = 不可用 */
  mtime: number;
  /** 符号链接目标的类型；断链为 undefined。 */
  link_target?: "file" | "directory";
  hidden: boolean;
}

export function localHome(): Promise<string> {
  return invoke<string>("local_home");
}

/** Windows 盘符列表（A:-Z: 探测）；非 Windows 返回空数组。 */
export function localListDrives(): Promise<string[]> {
  return invoke<string[]>("local_list_drives");
}

export function localListDir(path: string): Promise<LocalEntry[]> {
  return invoke<LocalEntry[]>("local_list_dir", { path });
}

/** `follow` 缺省 true（跟随符号链接）；false = lstat 语义。 */
export function localStat(
  path: string,
  follow?: boolean,
): Promise<LocalEntry> {
  return invoke<LocalEntry>("local_stat", { path, follow: follow ?? null });
}

export function localRealpath(path: string): Promise<string> {
  return invoke<string>("local_realpath", { path });
}

export function localMkdir(path: string): Promise<void> {
  return invoke("local_mkdir", { path });
}

export function localRename(oldPath: string, newPath: string): Promise<void> {
  return invoke("local_rename", { oldPath, newPath });
}

/**
 * 删除文件 / 目录树。`expectedType` 必传（守卫恒传）：前端列表里的类型与
 * 后端 lstat 不符时报 `local_type_stale`（列表过期，刷新后重试），避免误删。
 */
export function localRemove(
  path: string,
  expectedType: "file" | "directory" | "symlink",
): Promise<void> {
  return invoke("local_remove", { path, expectedType });
}

/** 读本地文件；`maxBytes` 缺省读全文，给值时读文件尾部（大文件预览）。 */
export function localReadFile(
  path: string,
  maxBytes?: number,
): Promise<number[]> {
  return invoke<number[]>("local_read_file", {
    path,
    maxBytes: maxBytes ?? null,
  });
}

export function localWriteFile(
  path: string,
  data: Uint8Array,
): Promise<void> {
  return invoke("local_write_file", { path, data: Array.from(data) });
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

/**
 * 内置编辑器整体读取远端文件（全文，非尾部截断）。
 * `maxBytes` 缺省 10 MiB（后端 DEFAULT_EDITOR_READ_CAP），超限报
 * `sftp_file_too_large`。
 */
export function sftpReadFile(
  sftpId: string,
  path: string,
  maxBytes?: number,
): Promise<number[]> {
  return invoke<number[]>("sftp_read_file", {
    sftpId,
    path,
    maxBytes: maxBytes ?? null,
  });
}

/** 内置编辑器保存回写：整体覆盖远端文件。 */
export function sftpWriteFile(
  sftpId: string,
  path: string,
  data: Uint8Array,
): Promise<void> {
  return invoke("sftp_write_file", { sftpId, path, data: Array.from(data) });
}

/** 用系统默认程序打开本地文件（外部编辑器入口，Netcatty openPath 等价）。 */
export function localOpenPath(path: string): Promise<void> {
  return invoke("local_open_path", { path });
}

/**
 * 用外部编辑器打开远端文件：下载到临时目录后以系统默认程序打开
 * （Netcatty downloadToTempAndOpen 等价）。返回临时文件路径，
 * 调用方记录供后续「保存后回传」或提示。
 */
export function sftpOpenExternal(
  sftpId: string,
  path: string,
): Promise<string> {
  return invoke<string>("sftp_open_external", { sftpId, path });
}

// ── 阶段 2：串口 / Telnet / 端口转发 ────────────────────────

/** 连接类型全集（比 TerminalDomain 多了 serial / telnet，无域名事件）。 */
export type ConnKind = "pty" | "ssh" | "serial" | "telnet";

/**
 * 主终端传输绑定（按键上行 / resize / close），由 TerminalPane 自持。
 */
export interface TerminalTransport {
  kind: ConnKind;
  write: (text: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

// ── 串口 ──────────────────────────────────────────────────

export interface SerialConfig {
  baud_rate: number;
  data_bits?: number; // 默认 8
  parity?: string; // none | odd | even | mark | space（mark/space：Win 原生 / Linux CMSPAR / macOS 不支持）
  stop_bits?: number; // 1 | 1.5 | 2，默认 1（1.5 仅 Windows）
  flow_control?: string; // none | software | hardware
  xany?: boolean;
  charset?: string; // WHATWG 字符集标签（如 GBK）；空/缺省 = 字节透传
  username?: string; // 自动登录用户名（与 password 任一非空即启用；仅会话级，不落库）
  password?: string; // 自动登录密码（可为空串 = 空密码设备）
}

/** 串口枚举信息（对齐 serialport::SerialPortInfo）。 */
export interface SerialPortInfo {
  path: string;
  manufacturer: string | null;
  serial_number: string | null;
  vendor_id: number | null;
  product_id: number | null;
  /** usb | pci | bluetooth | ""（未知） */
  port_type: string;
}

export function serialListPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>("serial_list_ports");
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

/** 自动登录状态：complete | cancelled | incomplete。 */
export function onSerialAutoLogin(
  sessionId: string,
  cb: (status: string) => void,
): Promise<UnlistenFn> {
  return listen<{ status: string }>(`serial:auto_login:${sessionId}`, (ev) =>
    cb(ev.payload.status),
  );
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

// ── SFTP 传输队列（transfer_center，阶段 A 后端 / 阶段 B 前端） ──

export type TransferDirection = "upload" | "download";
export type TransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "conflict"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";
export type TransferPriority = "low" | "normal" | "high";
export type TransferConflictAction = "replace" | "skip" | "rename";

/** 队列项（后端 `TransferItem`，字段 snake_case 原样）。 */
export interface TransferItem {
  id: string;
  sftp_id: string;
  /** 一次 enqueue 一个批次；冲突"应用到全部"按批次生效。 */
  batch_id: string;
  direction: TransferDirection;
  local_path: string;
  remote_path: string;
  /** 0 = 未知（进度条不定长）。 */
  size: number;
  status: TransferStatus;
  priority: TransferPriority;
  seq: number;
  overwrite: boolean;
  /** 失败时的 i18n code（R5，前端经 sshErrors 映射中文）。 */
  error: string | null;
  created_at: number;
}

/** 入队请求。嵌套 struct 字段走 serde 原样 snake_case（R3）。 */
export interface NewTransferRequest {
  sftp_id: string;
  direction: TransferDirection;
  local_path: string;
  remote_path: string;
  size?: number;
  priority?: TransferPriority;
}

export function sftpTransferEnqueue(
  items: NewTransferRequest[],
): Promise<TransferItem[]> {
  return invoke<TransferItem[]>("sftp_transfer_enqueue", { items });
}

export function sftpTransferList(): Promise<TransferItem[]> {
  return invoke<TransferItem[]>("sftp_transfer_list");
}

export function sftpTransferPause(transferId: string): Promise<void> {
  return invoke("sftp_transfer_pause", { transferId });
}

export function sftpTransferResume(transferId: string): Promise<void> {
  return invoke("sftp_transfer_resume", { transferId });
}

export function sftpTransferCancel(transferId: string): Promise<void> {
  return invoke("sftp_transfer_cancel", { transferId });
}

export function sftpTransferSetPriority(
  transferId: string,
  priority: TransferPriority,
): Promise<void> {
  return invoke("sftp_transfer_set_priority", { transferId, priority });
}

/** 全局并发（后端 clamp 到 [1, 8] 并持久化到 settings）。 */
export function sftpTransferSetConcurrency(concurrency: number): Promise<void> {
  return invoke("sftp_transfer_set_concurrency", { concurrency });
}

/** 冲突答复；`applyToAll` 时策略按批次记忆（阶段 C 对话框调用）。 */
export function sftpResolveConflict(
  transferId: string,
  action: TransferConflictAction,
  applyToAll: boolean,
): Promise<void> {
  return invoke("sftp_transfer_resolve_conflict", {
    transferId,
    action,
    applyToAll,
  });
}

export function sftpTransferClearFinished(): Promise<void> {
  return invoke("sftp_transfer_clear_finished");
}

/** 单条传输状态变化事件（payload = 最新 TransferItem）。 */
export function onSftpTransferUpdated(
  transferId: string,
  cb: (item: TransferItem) => void,
): Promise<UnlistenFn> {
  return listen<TransferItem>(`sftp:transfer_updated:${transferId}`, (ev) =>
    cb(ev.payload),
  );
}

/** 队列全量快照事件（入队 / 优先级变更 / 清空已结束）。 */
export function onSftpQueueChanged(
  cb: (items: TransferItem[]) => void,
): Promise<UnlistenFn> {
  return listen<TransferItem[]>("sftp:queue_changed", (ev) => cb(ev.payload));
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

/** 读 `~/.ssh/<name>` 私钥原文（后端校验单层文件名 + 私钥内容嗅探）。 */
export function readDefaultKeyFile(name: string): Promise<string> {
  return invoke<string>("read_default_key_file", { name });
}

/** 列出 `~/.ssh` 下的私钥文件名（只给名字，不给内容）。 */
export function listSshKeyFiles(): Promise<string[]> {
  return invoke<string[]>("list_ssh_key_files");
}

// ── 钥匙串：~/.ssh 文件密钥管理（阶段 A） ─────────────────────────
// 后端保证：私钥内容不出后端——列表只回元数据与公钥行，
// 生成/导入只回写入条目的元数据。字段为 Rust serde 原样 snake_case（R3）。
export interface SshFileKeyEntry {
  name: string;
  /** 展示路径 `~/.ssh/<name>`。 */
  path: string;
  /** `ssh-ed25519` / `ssh-rsa` / …；无法判定（如传统 PEM 且无 .pub）为空串。 */
  key_type: string;
  /** `SHA256:...` 指纹；无法判定为空串。 */
  fingerprint: string;
  /** 公钥行；无法判定为 null。 */
  public_key: string | null;
  /** 私钥是否 passphrase 加密。 */
  encrypted: boolean;
  /** 是否当前默认密钥。 */
  is_default: boolean;
}

export function keychainListFileKeys(): Promise<SshFileKeyEntry[]> {
  return invoke<SshFileKeyEntry[]>("keychain_list_file_keys");
}

export function keychainGenerateFileKey(
  name: string,
  algorithm: string,
  bits?: number | null,
  passphrase?: string | null,
): Promise<SshFileKeyEntry> {
  return invoke<SshFileKeyEntry>("keychain_generate_file_key", {
    name,
    algorithm,
    bits: bits ?? null,
    passphrase: passphrase ?? null,
  });
}

export function keychainImportFileKey(
  name: string,
  privateKey: string,
  publicKey?: string | null,
): Promise<SshFileKeyEntry> {
  return invoke<SshFileKeyEntry>("keychain_import_file_key", {
    name,
    privateKey,
    publicKey: publicKey ?? null,
  });
}

export function keychainDeleteFileKey(name: string): Promise<void> {
  return invoke<void>("keychain_delete_file_key", { name });
}

export function keychainSetDefaultKey(name: string): Promise<void> {
  return invoke<void>("keychain_set_default_key", { name });
}

/** 当前默认密钥名（后端缺省回落 id_ed25519）。 */
export function keychainGetDefaultKey(): Promise<string> {
  return invoke<string>("keychain_get_default_key");
}

// ── 已知主机管理 ─────────────────────────────────────────

export interface KnownHostEntry {
  host: string;
  port: number;
  key_type: string;
  public_key: string;
  /** `SHA256:...` 指纹。 */
  fingerprint: string;
  /** `|1|...` 哈希条目：明文主机名不可恢复。 */
  hashed: boolean;
}

/** 解析 `~/.ssh/known_hosts` 为结构化条目（坏行跳过）。 */
export function knownHostsList(): Promise<KnownHostEntry[]> {
  return invoke<KnownHostEntry[]>("known_hosts_list");
}

/** 删除 host:port 的全部 known_hosts 条目，返回删除条数。 */
export function knownHostsRemove(host: string, port: number): Promise<number> {
  return invoke<number>("known_hosts_remove", { host, port });
}

/** 「扫描系统」：重读 `~/.ssh/known_hosts`；null = 文件不存在，否则返回条数。 */
export function knownHostsScanSystem(): Promise<number | null> {
  return invoke<number | null>("known_hosts_scan_system");
}

/** 「导入文件」：外部 known_hosts 去重合并进系统文件，返回新增条数。 */
export function knownHostsImportFile(path: string): Promise<number> {
  return invoke<number>("known_hosts_import_file", { path });
}

// ── SSH Agent 状态（钥匙串阶段 B）────────────────────────
// 后端 `ssh_agent_status` 不抛错，永远返回状态对象：
// 不可达时 running=false，error 给原因（无 error = 未发现任何 agent）。
// 字段为 serde 原样 snake_case（R3）。

export type SshAgentKind = "unix-socket" | "named-pipe" | "pageant" | "none";

export interface SshAgentStatus {
  /** 本机 SSH agent 是否可达。 */
  running: boolean;
  kind: SshAgentKind;
  /** socket 路径 / `\\.\pipe\openssh-ssh-agent` / "pageant"；none 时为空。 */
  path: string;
  /** 已加载身份数。 */
  identity_count: number;
  error: string | null;
}

export function sshAgentStatus(): Promise<SshAgentStatus> {
  return invoke<SshAgentStatus>("ssh_agent_status");
}

// ── 钥匙串（密钥生成 / 导入）─────────────────────────────
// 钥匙串条目复用 credentials 表（type=key）：secret=OpenSSH 私钥走 SecretStore，
// username 字段存公钥行（内部约定，见后端 commands/keychain.rs 模块头）。

/** 生成 SSH 密钥对并入库。algorithm：`ED25519` | `ECDSA` | `RSA`。 */
export function keychainGenerateKey(
  label: string,
  algorithm: string,
  bits?: number,
  passphrase?: string,
): Promise<Credential> {
  return invoke<Credential>("keychain_generate_key", {
    label,
    algorithm,
    bits: bits ?? null,
    passphrase: passphrase ?? null,
  });
}

/** 导入已有私钥（校验 + 落库）；publicKey 缺省时后端从私钥推导。 */
export function keychainImportKey(
  label: string,
  privateKey: string,
  publicKey?: string,
): Promise<Credential> {
  return invoke<Credential>("keychain_import_key", {
    label,
    privateKey,
    publicKey: publicKey ?? null,
  });
}

/** 读取主机的 TOTP 密钥（SecretStore，`totp:<profile_id>`）；未设置 → null。 */
export function getProfileTotp(profileId: string): Promise<string | null> {
  return invoke<string | null>("profile_totp_get", { profileId });
}

/** 写入 / 移除主机 TOTP 密钥；secret 传 null = 移除验证器。 */
export function setProfileTotp(
  profileId: string,
  secret: string | null,
): Promise<void> {
  return invoke("profile_totp_set", { profileId, secret });
}