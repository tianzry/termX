/**
 * SSH 错误分类与展示（对齐 netcatty createTerminalSessionStarters 的
 * `isAuthFailureMessage`；R5：用户可见错误必须经本模块解析成中文）。
 *
 * termX 后端把 AppError 序列化成 `__termx_err__|{"code":...,"params":...}`
 * 信封字符串；前端先解码出 code + params，再映射为中文文案。任何情况下
 * 都不把原始信封直接展示给用户。
 */

/** `__rssh_err__|` 是改名前的旧信封；旧后端/旧日志仍可能带出，双前缀兼容。 */
const ERROR_MARKERS = ["__termx_err__|", "__rssh_err__|"] as const;

export function decodeAppError(raw: string): { code?: string; params?: Record<string, unknown>; message: string } {
  const marker = ERROR_MARKERS.find((candidate) => raw.startsWith(candidate));
  if (marker) {
    try {
      const parsed = JSON.parse(raw.slice(marker.length)) as {
        code?: string;
        params?: Record<string, unknown>;
      };
      return { code: parsed.code, params: parsed.params, message: raw };
    } catch {
      return { message: raw };
    }
  }
  return { message: raw };
}

const AUTH_CODES = new Set([
  "ssh_password_auth_failed",
  "ssh_pubkey_auth_failed",
  "ssh_auth_failed",
  "ssh_interactive_requires_terminal",
]);

export function isAuthFailureMessage(raw: string): boolean {
  const { code, message } = decodeAppError(raw);
  if (code && AUTH_CODES.has(code)) return true;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all configured authentication methods failed") ||
    normalized.includes("authentication failed") ||
    normalized.includes("too many authentication failures") ||
    /permission denied\s*\(/.test(normalized) ||
    normalized.includes("no authentication methods available")
  );
}

function str(params: Record<string, unknown> | undefined, key: string): string {
  const v = params?.[key];
  return v === undefined || v === null ? "" : String(v);
}

function num(params: Record<string, unknown> | undefined, key: string): number {
  const v = params?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 字节数 → 人类可读（KiB/MiB），仅错误文案用。 */
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/** code → 中文文案（params 插值）。与 src-tauri/src/error.rs 的 code 对齐。 */
const ERROR_MESSAGES: Record<
  string,
  (params: Record<string, unknown> | undefined) => string
> = {
  // ── SSH 连接 ──
  ssh_connect_failed: (p) => `SSH 连接失败：${str(p, "err")}`,
  ssh_connect_timeout: (p) =>
    `连接 ${str(p, "host")}:${str(p, "port")} 超时（${str(p, "secs")} 秒）。请检查网络或端口。`,
  ssh_handshake_timeout: (p) =>
    `与 ${str(p, "host")}:${str(p, "port")} 的 SSH 握手超时。`,
  ssh_host_key_changed: (p) =>
    `${str(p, "host")}:${str(p, "port")} 的主机密钥与记录不符，可能已被更换。`,
  ssh_task_cancelled: () => "连接已取消。",
  ssh_session_closed: () => "会话已关闭。",
  ssh_disconnected: () => "已与主机断开连接。",
  ssh_open_channel_failed: (p) => `打开通道失败：${str(p, "err")}`,
  ssh_pty_request_failed: (p) => `请求终端（PTY）失败：${str(p, "err")}`,
  ssh_shell_request_failed: (p) => `启动 Shell 失败：${str(p, "err")}`,
  ssh_bastion_tunnel_failed: () => "堡垒机隧道建立失败。",
  ssh_bastion_tunnel_timeout: () => "堡垒机隧道超时。",
  plugin_exec_failed: (p) => `插件执行失败：${str(p, "err")}`,
  // ── 认证 ──
  ssh_auth_rejected: () => "认证被服务器拒绝。",
  ssh_password_auth_failed: (p) => `密码认证失败：${str(p, "err")}`,
  ssh_pubkey_auth_failed: () => "公钥认证失败。",
  ssh_auth_failed: (p) =>
    str(p, "err") ? `认证失败：${str(p, "err")}` : "认证失败。",
  ssh_interactive_requires_terminal: () => "交互式认证需要终端输入。",
  ssh_privkey_encrypted_no_ctx: () => "私钥已加密，但未提供解密上下文。",
  ssh_passphrase_too_many: () => "私钥口令尝试次数过多。",
  ssh_privkey_missing: () => "未找到私钥。",
  ssh_rsa_sigalg_failed: (p) => `RSA 签名算法协商失败：${str(p, "err")}`,
  ssh_agent_pageant_failed: (p) => `Pageant 不可用：${str(p, "err")}`,
  ssh_agent_list_failed: (p) => `读取代理身份列表失败：${str(p, "err")}`,
  ssh_agent_no_identity: () => "代理中没有可用身份。",
  ssh_agent_all_rejected: () => "代理中的所有身份均被服务器拒绝。",
  ssh_default_keys_not_found: () => "未在 ~/.ssh 找到默认密钥。",
  ssh_kbi_start_failed: (p) => `启动交互式认证失败：${str(p, "err")}`,
  ssh_kbi_response_failed: (p) => `交互式认证应答失败：${str(p, "err")}`,
  ssh_user_cancelled_passphrase: () => "已取消输入私钥口令。",
  ssh_user_cancelled_hostkey: () => "已取消主机密钥确认。",
  // ── 堡垒机 ──
  bastion_cycle: () => "堡垒机链路中检测到循环。",
  bastion_too_many_hops: () => "堡垒机跳数过多。",
  bastion_profile_not_found: (p) => `未找到堡垒机档案：${str(p, "id")}`,
  bastion_cred_not_found: (p) => `未找到堡垒机凭据：${str(p, "name")}`,
  // ── 资源缺失 ──
  profile_not_found: (p) => `未找到主机档案：${str(p, "id")}`,
  profile_cred_not_found: () => "未找到主机关联的凭据。",
  credential_not_found: (p) => `未找到凭据：${str(p, "id")}`,
  session_not_found: (p) => `会话不存在：${str(p, "id")}`,
  ssh_session_not_found: () => "SSH 会话不存在或已结束。",
  ssh_session_not_found_msg: () => "SSH 会话不存在或已结束。",
  pty_not_found: () => "本地终端会话不存在。",
  fwd_not_found: () => "端口转发会话不存在。",
  fwd_profile_not_found: () => "未找到端口转发档案。",
  fwd_cred_not_found: () => "未找到端口转发凭据。",
  // ── 本地文件系统 ──
  local_home_unavailable: () => "无法获取主目录。",
  local_io_failed: (p) => `本地文件操作失败：${str(p, "err")}`,
  local_type_stale: (p) =>
    `“${str(p, "path")}”的类型已变化，请刷新列表后重试。`,
  local_extract_unsupported: (p) =>
    `不支持的压缩格式：${str(p, "path") || "未知文件"}。支持 .tar / .tar.gz / .tgz / .tar.bz2 / .tar.xz / .tar.zst / .zip / .gz / .bz2 / .xz。`,
  local_extract_failed: (p) =>
    str(p, "exitCode")
      ? `解压失败（退出码 ${str(p, "exitCode")}）：${str(p, "stderr") || "解压器未返回错误信息"}`
      : `解压失败：${str(p, "err") || str(p, "stderr") || "未知错误"}`,
  local_extract_binary_missing: (p) =>
    `系统缺少解压工具 ${str(p, "binary") || ""}，请安装后重试。`,
  // ── SFTP ──
  sftp_session_not_found: () => "SFTP 会话不存在或已关闭。",
  sftp_extract_no_ssh: () =>
    "独立 SFTP 连接没有 SSH 命令通道，无法执行远程解压；请通过主机档案连接后再试。",
  sftp_extract_unsupported: (p) =>
    `不支持的压缩格式：${str(p, "path") || "未知文件"}。支持 .tar / .tar.gz / .tgz / .tar.bz2 / .tar.xz / .tar.zst / .zip / .gz / .bz2 / .xz。`,
  sftp_extract_failed: (p) =>
    `解压失败（退出码 ${str(p, "exitCode")}）：${str(p, "stderr") || "远端未返回错误信息"}`,
  sftp_extract_invalid_path: () => "归档路径无效，无法确定解压目录。",
  sftp_transfer_not_found: (p) => `未找到传输任务：${str(p, "id")}`,
  sftp_transfer_state_invalid: () => "传输任务当前状态不允许该操作。",
  sftp_io_failed: (p) => `SFTP 操作失败（${str(p, "op")}）：${str(p, "err")}`,
  sftp_tree_too_deep: (p) =>
    `“${str(p, "path")}”目录层级过深（上限 ${str(p, "limit")} 层）。`,
  sftp_invalid_filename: () => "文件名非法。",
  sftp_file_too_large: (p) =>
    str(p, "limit")
      ? `文件过大（${fmtBytes(num(p, "size"))}），超出编辑器上限 ${fmtBytes(num(p, "limit"))}，请下载后用其他应用打开。`
      : "文件过大。",
  // ── 串口 ──
  serial_not_found: () => "串口会话已关闭或不存在",
  serial_open_failed: (p) => `打开串口 ${str(p, "port")} 失败：${str(p, "err")}`,
  serial_op_failed: (p) => `串口操作失败：${str(p, "err")}`,
  serial_feature_unsupported: (p) => {
    const feature = str(p, "feature");
    const name =
      feature === "stop_bits_1_5"
        ? "1.5 停止位（仅 Windows 支持）"
        : feature === "mark_space_parity"
          ? "mark/space 校验位（当前平台不支持）"
          : feature;
    return `当前平台不支持该串口特性：${name}`;
  },
  serial_charset_unsupported: (p) => `不支持的串口字符集：${str(p, "charset")}`,
  // ── Telnet ──
  telnet_not_found: () => "Telnet 会话已关闭或不存在",
  telnet_open_failed: (p) => `连接 Telnet ${str(p, "peer")} 失败：${str(p, "err")}`,
  telnet_op_failed: (p) => `Telnet 操作失败：${str(p, "err")}`,
  // ── Notes ──
  note_id_required: () => "笔记缺少 id，无法保存",
  note_not_found: (p) => `笔记不存在或已删除：${str(p, "id")}`,
  // ── 会话日志（阶段 A）──
  session_log_not_found: () => "会话日志不存在或已被删除。",
  session_log_read_failed: (p) => `读取会话日志失败：${str(p, "err")}`,
  session_log_format_invalid: (p) => `不支持的日志格式：${str(p, "format")}`,
  session_log_delete_failed: (p) => `删除会话日志失败：${str(p, "err")}`,
  session_log_path_invalid: () => "保存路径无效或目录不存在，请重新选择。",
  session_log_already_recording: () => "当前会话已在记录日志。",
  session_log_not_recording: () => "当前会话没有进行中的日志记录。",
  // ── 主机连接代理（阶段 A）──
  proxy_type_invalid: (p) => `不支持的代理类型：${str(p, "value")}`,
  proxy_url_invalid: (p) => `代理地址格式不正确：${str(p, "url")}（示例 http://127.0.0.1:7890）`,
  proxy_host_required: () => "请填写代理主机。",
  proxy_host_invalid: (p) => `代理主机非法：${str(p, "host")}`,
  proxy_port_invalid: (p) => `代理端口非法：${str(p, "port")}`,
  proxy_connect_failed: (p) =>
    `连接代理 ${str(p, "host")}:${str(p, "port")} 失败：${str(p, "err")}`,
  proxy_connect_timeout: (p) =>
    `连接代理 ${str(p, "host")}:${str(p, "port")} 超时（${str(p, "secs")}s）。`,
  proxy_handshake_failed: (p) => `代理握手失败：${str(p, "err")}`,
  proxy_auth_required: () => "代理需要认证：请检查用户名 / 密码。",
  proxy_auth_failed: (p) => `代理认证失败（SOCKS5 状态 ${str(p, "status")}）。`,
  proxy_http_status: (p) => `代理拒绝了连接请求（HTTP ${str(p, "status")}）。`,
  proxy_socks5_failed: (p) => `SOCKS5 代理连接失败：${str(p, "err")}`,
  // ── 通用 ──
  db_error: (p) => `数据库错误：${str(p, "err")}`,
  io_error: (p) => `读写错误：${str(p, "err")}`,
  lock_poisoned: () => "内部锁异常，请重试。",
  name_empty: () => "名称不能为空。",
  pty_op_failed: (p) => `本地终端操作失败：${str(p, "err")}`,
  key_generation_failed: (p) => `生成密钥失败：${str(p, "error")}`,
  label_required: () => "标签不能为空。",
  private_key_required: () => "私钥内容不能为空。",
  invalid_private_key: (p) => `无效的私钥：${str(p, "error")}`,
  // ── 钥匙串（~/.ssh 文件密钥，阶段 A）──
  invalid_key_name: (p) => `密钥名「${str(p, "name")}」非法：只能是单层文件名。`,
  key_file_exists: (p) => `~/.ssh/${str(p, "name")} 已存在，拒绝覆盖，请更换密钥名。`,
  key_write_failed: (p) => `写入密钥文件 ~/.ssh/${str(p, "name")} 失败。`,
  key_file_not_found: (p) => `未找到密钥 ~/.ssh/${str(p, "name")}。`,
  home_dir_unavailable: () => "无法获取主目录。",
  crypto_password_or_corrupted: () => "口令错误或数据已损坏。",
  secret_decrypt_failed_or_wrong_key: () => "解密失败：口令错误或数据已损坏。",
  serde_failed: (p) => `数据解析失败：${str(p, "err")}`,
  fwd_session_closed: () => "端口转发会话已关闭。",
  fwd_rule_stopped_unexpectedly: () => "端口转发规则意外停止。",
  // ── 更新检查 ──
  update_invalid_endpoint: () => "更新源地址无效（需要 http/https URL）。",
  update_http_failed: () => "无法访问更新源，请检查网络或地址。",
  update_http_status: () => "更新源返回错误状态码。",
  update_invalid_json: () => "更新源返回的 latest.json 格式无效。",
  update_missing_version: () => "latest.json 缺少版本号。",
};

/**
 * 裸错误码 → 中文文案（队列项 `TransferItem.error` 存的是 code 而非信封）。
 * 未知 code 回退 params.err / 泛化文案。
 */
export function errorMessageFor(
  code: string,
  params?: Record<string, unknown>,
): string {
  const render = ERROR_MESSAGES[code];
  if (render) return render(params);
  const detail = str(params, "err") || str(params, "error");
  return detail ? `操作失败：${detail}` : "操作失败，请重试。";
}

/**
 * 取给用户看的错误文本（R5）：
 * - 信封 → 按 code 映射中文；未知 code 回退 params.err/泛化文案；
 * - 非信封 → 原样返回（前端本地文案或服务器原文）。
 */
export function userVisibleError(raw: string): string {
  const { code, params, message } = decodeAppError(raw);
  if (!code) return message;
  return errorMessageFor(code, params);
}
