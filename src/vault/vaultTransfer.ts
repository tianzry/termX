// 主机库导入 / 导出（P1：Vault「新建 → 导入 / 导出」）。
// 格式是 termX 自己的版本化 JSON：只迁移非敏感档案字段，
// 密码 / 私钥内容 / 凭据 secret 一律不落文件（导出端白名单）。
// 纯逻辑、无 IO；单测见 vaultTransfer.test.ts。
import type {
  Credential,
  CredentialType,
  Group,
  Profile,
} from "../backend/client";

export const VAULT_EXPORT_VERSION = 1 as const;
export const VAULT_EXPORT_KIND = "termx.vault" as const;

export type VaultExportGroup = {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  terminal_waves_enabled?: boolean;
};

/** 主机导出项：仅 Profile 上可安全迁移的字段 + 凭据的用户名 / 登录方式元数据。 */
export type VaultExportHost = {
  id: string;
  name: string;
  host: string;
  port: number;
  group_id: string | null;
  username?: string;
  /** 登录方式（password / key / interactive / agent / none），仅作导入时建凭据提示。 */
  auth_method?: string;
  protocol?: string;
  init_command?: string | null;
  icon_source?: string | null;
  icon_color?: string | null;
  sftp_protocol?: string | null;
  sftp_sudo?: boolean;
  sftp_encoding?: string | null;
  totp_auto_submit?: boolean;
  totp_regex?: string | null;
  agent_forwarding?: boolean;
  ssh_input_compatibility?: boolean | null;
  local_shell?: string | null;
  local_shell_args?: string[] | null;
  local_shell_name?: string | null;
  local_shell_icon?: string | null;
  local_start_dir?: string | null;
  /** 串口主机（protocol === "serial"）的非敏感参数快照。 */
  serial_port?: string | null;
  serial_baud?: number | null;
  serial_data_bits?: number | null;
  serial_parity?: string | null;
  serial_stop_bits?: number | null;
  serial_flow?: string | null;
  serial_local_echo?: boolean | null;
  serial_line_mode?: boolean | null;
  serial_backspace?: string | null;
  serial_byte_backspace?: boolean | null;
  serial_charset?: string | null;
  /** Telnet 主机（protocol === "telnet"）的自动登录用户名 / 字符集（不含密码）。 */
  telnet_username?: string | null;
  telnet_charset?: string | null;
  tags?: string[];
};

export type VaultExportPayload = {
  kind: typeof VAULT_EXPORT_KIND;
  version: typeof VAULT_EXPORT_VERSION;
  exportedAt: string;
  groups: VaultExportGroup[];
  hosts: VaultExportHost[];
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const trimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** 凭据类型 → 导出登录方式（secret 不参与）。 */
function authMethodOf(cred: Credential | undefined): string {
  if (!cred) return "none";
  return cred.type;
}

const toExportGroup = (g: Group): VaultExportGroup => ({
  id: g.id,
  name: g.name,
  color: g.color,
  sort_order: g.sort_order,
  ...(g.terminal_waves_enabled ? { terminal_waves_enabled: true } : {}),
});

const toExportHost = (
  p: Profile,
  cred: Credential | undefined,
  tags: string[],
): VaultExportHost => ({
  id: p.id,
  name: p.name,
  host: p.host,
  port: p.port,
  group_id: p.group_id ?? null,
  ...(cred?.username ? { username: cred.username } : {}),
  auth_method: authMethodOf(cred),
  ...(p.protocol && p.protocol !== "ssh" ? { protocol: p.protocol } : {}),
  ...(p.init_command ? { init_command: p.init_command } : {}),
  ...(p.icon_source ? { icon_source: p.icon_source } : {}),
  ...(p.icon_color ? { icon_color: p.icon_color } : {}),
  ...(p.sftp_protocol ? { sftp_protocol: p.sftp_protocol } : {}),
  ...(p.sftp_sudo ? { sftp_sudo: true } : {}),
  ...(p.sftp_encoding ? { sftp_encoding: p.sftp_encoding } : {}),
  ...(p.totp_auto_submit === false ? { totp_auto_submit: false } : {}),
  ...(p.totp_regex ? { totp_regex: p.totp_regex } : {}),
  ...(p.agent_forwarding ? { agent_forwarding: true } : {}),
  ...(p.ssh_input_compatibility !== undefined && p.ssh_input_compatibility !== null
    ? { ssh_input_compatibility: p.ssh_input_compatibility }
    : {}),
  ...(p.local_shell ? { local_shell: p.local_shell } : {}),
  ...(p.local_shell_args?.length ? { local_shell_args: p.local_shell_args } : {}),
  ...(p.local_shell_name ? { local_shell_name: p.local_shell_name } : {}),
  ...(p.local_shell_icon ? { local_shell_icon: p.local_shell_icon } : {}),
  ...(p.local_start_dir ? { local_start_dir: p.local_start_dir } : {}),
  ...(p.protocol === "serial"
    ? {
        serial_port: p.serial_port ?? p.host,
        serial_baud: p.serial_baud ?? null,
        serial_data_bits: p.serial_data_bits ?? null,
        serial_parity: p.serial_parity ?? null,
        serial_stop_bits: p.serial_stop_bits ?? null,
        serial_flow: p.serial_flow ?? null,
        serial_local_echo: p.serial_local_echo ?? false,
        serial_line_mode: p.serial_line_mode ?? false,
        serial_backspace: p.serial_backspace ?? null,
        serial_byte_backspace: p.serial_byte_backspace ?? false,
        serial_charset: p.serial_charset ?? null,
      }
    : {}),
  ...(p.protocol === "telnet"
    ? {
        telnet_username: p.telnet_username ?? null,
        telnet_charset: p.telnet_charset ?? null,
      }
    : {}),
  ...(tags.length ? { tags } : {}),
});

/**
 * 生成导出 JSON。`options.credentials` 只用来带上用户名 / 登录方式，
 * `options.tags` 来自 Vault 的本地标签表；两者都不包含任何 secret。
 */
export function buildVaultExport(
  profiles: Profile[],
  groups: Group[],
  options: {
    credentials?: Credential[];
    tags?: Record<string, string[]>;
  } = {},
  exportedAt = new Date().toISOString(),
): string {
  const credById = new Map(
    (options.credentials ?? []).map((c) => [c.id, c]),
  );
  const tags = options.tags ?? {};
  const payload: VaultExportPayload = {
    kind: VAULT_EXPORT_KIND,
    version: VAULT_EXPORT_VERSION,
    exportedAt,
    groups: groups.map(toExportGroup),
    hosts: profiles.map((p) =>
      toExportHost(p, credById.get(p.credential_id), tags[p.id] ?? []),
    ),
  };
  return JSON.stringify(payload, null, 2);
}

export type VaultImportGroup = {
  id: string;
  name: string;
  color: string;
  sort_order: number;
};

export type VaultImportHost = {
  id: string;
  name: string;
  host: string;
  port: number;
  group_id: string | null;
  username: string;
  auth_method: string;
  protocol: string;
  init_command: string | null;
  icon_source: string | null;
  icon_color: string | null;
  sftp_protocol: string | null;
  sftp_sudo: boolean;
  sftp_encoding: string | null;
  totp_auto_submit: boolean;
  totp_regex: string | null;
  agent_forwarding: boolean;
  ssh_input_compatibility: boolean | null;
  local_shell: string | null;
  local_shell_args: string[] | null;
  local_shell_name: string | null;
  local_shell_icon: string | null;
  local_start_dir: string | null;
  serial_port: string | null;
  serial_baud: number | null;
  serial_data_bits: number | null;
  serial_parity: string | null;
  serial_stop_bits: number | null;
  serial_flow: string | null;
  serial_local_echo: boolean | null;
  serial_line_mode: boolean | null;
  serial_backspace: string | null;
  serial_byte_backspace: boolean | null;
  serial_charset: string | null;
  telnet_username: string | null;
  telnet_charset: string | null;
  tags: string[];
};

export type VaultParseResult = {
  ok: boolean;
  errors: string[];
  groups: VaultImportGroup[];
  hosts: VaultImportHost[];
};

function parsePort(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n >= 1 && n <= 65535 ? n : null;
  }
  return null;
}

/** 串口主机 port 固定 0，允许 0–65535；其它协议仍走 parsePort（1–65535）。 */
function parseSerialPort(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n >= 0 && n <= 65535 ? n : null;
  }
  return null;
}

function optionalInt(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function optionalBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}

function optionalString(value: unknown): string | null {
  const s = trimmed(value);
  return s ? s : null;
}

function sanitizeGroup(value: unknown): VaultImportGroup | null {
  if (!isObjectRecord(value)) return null;
  const name = trimmed(value.name);
  if (!name) return null;
  return {
    id: trimmed(value.id) || name,
    name,
    color: trimmed(value.color),
    sort_order:
      typeof value.sort_order === "number" && Number.isFinite(value.sort_order)
        ? value.sort_order
        : 0,
  };
}

function sanitizeHost(value: unknown): VaultImportHost | null {
  if (!isObjectRecord(value)) return null;
  const name = trimmed(value.name);
  const host = trimmed(value.host);
  const rawProtocol = trimmed(value.protocol);
  const protocol =
    rawProtocol === "local" || rawProtocol === "serial" || rawProtocol === "telnet"
      ? rawProtocol
      : "ssh";
  const port =
    protocol === "serial" ? parseSerialPort(value.port) : parsePort(value.port);
  if (!name || !host || port === null) return null;
  return {
    id: trimmed(value.id) || `${name}@${host}:${port}`,
    name,
    host,
    port,
    group_id: optionalString(value.group_id),
    username: trimmed(value.username),
    auth_method: trimmed(value.auth_method) || "none",
    protocol,
    init_command: optionalString(value.init_command),
    icon_source: optionalString(value.icon_source),
    icon_color: optionalString(value.icon_color),
    sftp_protocol: optionalString(value.sftp_protocol),
    sftp_sudo: value.sftp_sudo === true,
    sftp_encoding: optionalString(value.sftp_encoding),
    totp_auto_submit: value.totp_auto_submit !== false,
    totp_regex: optionalString(value.totp_regex),
    agent_forwarding: value.agent_forwarding === true,
    ssh_input_compatibility:
      typeof value.ssh_input_compatibility === "boolean"
        ? value.ssh_input_compatibility
        : null,
    local_shell: optionalString(value.local_shell),
    local_shell_args:
      Array.isArray(value.local_shell_args)
        ? stringArray(value.local_shell_args)
        : null,
    local_shell_name: optionalString(value.local_shell_name),
    local_shell_icon: optionalString(value.local_shell_icon),
    local_start_dir: optionalString(value.local_start_dir),
    serial_port: optionalString(value.serial_port),
    serial_baud: optionalInt(value.serial_baud, 1, 4_000_000),
    serial_data_bits: optionalInt(value.serial_data_bits, 5, 8),
    serial_parity: optionalString(value.serial_parity),
    serial_stop_bits:
      typeof value.serial_stop_bits === "number" &&
      Number.isFinite(value.serial_stop_bits) &&
      value.serial_stop_bits > 0
        ? value.serial_stop_bits
        : null,
    serial_flow: optionalString(value.serial_flow),
    serial_local_echo: optionalBool(value.serial_local_echo),
    serial_line_mode: optionalBool(value.serial_line_mode),
    serial_backspace: optionalString(value.serial_backspace),
    serial_byte_backspace: optionalBool(value.serial_byte_backspace),
    serial_charset: optionalString(value.serial_charset),
    telnet_username: optionalString(value.telnet_username),
    telnet_charset: optionalString(value.telnet_charset),
    tags: stringArray(value.tags),
  };
}

/**
 * 解析导入文本。只接受版本 1 的对象格式；逐条校验必填字段，
 * 未知字段丢弃，返回用户可读的中文错误列表。
 */
export function parseVaultImport(text: string): VaultParseResult {
  const empty: VaultParseResult = {
    ok: false,
    errors: [],
    groups: [],
    hosts: [],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...empty, errors: ["文件不是合法 JSON"] };
  }
  if (!isObjectRecord(parsed)) {
    return { ...empty, errors: ["文件内容不是主机导出格式"] };
  }
  if (parsed.version !== VAULT_EXPORT_VERSION) {
    return {
      ...empty,
      errors: [`不支持的导入版本：${String(parsed.version)}（仅支持 ${VAULT_EXPORT_VERSION}）`],
    };
  }
  if (!Array.isArray(parsed.hosts)) {
    return { ...empty, errors: ["导入文件没有 hosts 列表"] };
  }

  const errors: string[] = [];
  const groups: VaultImportGroup[] = [];
  if (Array.isArray(parsed.groups)) {
    parsed.groups.forEach((raw, index) => {
      const g = sanitizeGroup(raw);
      if (g) {
        groups.push(g);
      } else {
        errors.push(`第 ${index + 1} 个分组缺少有效名称`);
      }
    });
  } else if (parsed.groups !== undefined) {
    errors.push("groups 必须是数组");
  }

  const hosts: VaultImportHost[] = [];
  parsed.hosts.forEach((raw, index) => {
    const h = sanitizeHost(raw);
    if (h) {
      hosts.push(h);
    } else {
      errors.push(
        `第 ${index + 1} 台主机无效：名称 / 主机不能为空，端口需在 1–65535 之间`,
      );
    }
  });
  if (hosts.length === 0 && errors.length === 0) {
    errors.push("导入文件没有可用的主机");
  }

  return {
    ok: errors.length === 0 && hosts.length > 0,
    errors,
    groups,
    hosts,
  };
}

export type VaultHostConflict = {
  host: VaultImportHost;
  existing: Profile;
};

/** 冲突判定键：name + host + port（忽略大小写）。 */
export function hostConflictKey(
  host: Pick<VaultImportHost, "name" | "host" | "port">,
): string {
  return `${host.name.trim().toLowerCase()}|${host.host.trim().toLowerCase()}|${host.port}`;
}

/** 找出与现有档案同名同地址同端口的主机。 */
export function findConflicts(
  hosts: VaultImportHost[],
  existingProfiles: Profile[],
): VaultHostConflict[] {
  const existingByKey = new Map(
    existingProfiles.map((p) => [hostConflictKey(p), p]),
  );
  return hosts.flatMap((host) => {
    const existing = existingByKey.get(hostConflictKey(host));
    return existing ? [{ host, existing }] : [];
  });
}

/** 登录方式 → 凭据类型；未知值回落 none（导入不会带 secret）。 */
export function credentialTypeFor(authMethod: string): CredentialType {
  switch (authMethod) {
    case "password":
    case "key":
    case "interactive":
    case "agent":
    case "none":
      return authMethod;
    default:
      return "none";
  }
}

/** 导入主机 → 新凭据（只有用户名 / 类型，secret 永远为 null）。 */
export function credentialFromImportedHost(
  host: VaultImportHost,
  id: string,
): Credential {
  return {
    id,
    name: `${host.name} (${host.host})`,
    username: host.username,
    type: credentialTypeFor(host.auth_method),
    secret: null,
    save_to_remote: false,
  };
}

/** 导入主机 → 新 Profile。凭据 id 由调用方决定（本地终端可为空）。 */
export function importedHostToProfile(
  host: VaultImportHost,
  credentialId: string,
  groupId: string | null,
  id: string,
): Profile {
  return {
    id,
    name: host.name,
    host: host.host,
    port: host.port,
    credential_id: credentialId,
    bastion_profile_id: null,
    init_command: host.init_command,
    group_id: groupId,
    ...(host.protocol === "local" ||
    host.protocol === "serial" ||
    host.protocol === "telnet"
      ? { protocol: host.protocol }
      : {}),
    ...(host.icon_source ? { icon_source: host.icon_source } : {}),
    ...(host.icon_color ? { icon_color: host.icon_color } : {}),
    ...(host.sftp_protocol ? { sftp_protocol: host.sftp_protocol } : {}),
    ...(host.sftp_sudo ? { sftp_sudo: true } : {}),
    ...(host.sftp_encoding ? { sftp_encoding: host.sftp_encoding } : {}),
    totp_auto_submit: host.totp_auto_submit,
    totp_regex: host.totp_regex,
    agent_forwarding: host.agent_forwarding,
    ...(host.ssh_input_compatibility !== null
      ? { ssh_input_compatibility: host.ssh_input_compatibility }
      : {}),
    ...(host.local_shell ? { local_shell: host.local_shell } : {}),
    ...(host.local_shell_args?.length
      ? { local_shell_args: host.local_shell_args }
      : {}),
    ...(host.local_shell_name ? { local_shell_name: host.local_shell_name } : {}),
    ...(host.local_shell_icon ? { local_shell_icon: host.local_shell_icon } : {}),
    ...(host.local_start_dir ? { local_start_dir: host.local_start_dir } : {}),
    ...(host.protocol === "serial"
      ? {
          serial_port: host.serial_port ?? host.host,
          serial_baud: host.serial_baud,
          serial_data_bits: host.serial_data_bits,
          serial_parity: host.serial_parity,
          serial_stop_bits: host.serial_stop_bits,
          serial_flow: host.serial_flow,
          serial_local_echo: host.serial_local_echo,
          serial_line_mode: host.serial_line_mode,
          serial_backspace: host.serial_backspace,
          serial_byte_backspace: host.serial_byte_backspace,
          serial_charset: host.serial_charset,
        }
      : {}),
    ...(host.protocol === "telnet"
      ? {
          telnet_username: host.telnet_username,
          telnet_charset: host.telnet_charset,
        }
      : {}),
  };
}

/** 覆盖已有主机：沿用本地 id / 凭据 / 堡垒链，只刷新导入的可迁移字段。 */
export function applyImportedHost(
  existing: Profile,
  host: VaultImportHost,
  groupId: string | null,
): Profile {
  return {
    ...existing,
    name: host.name,
    host: host.host,
    port: host.port,
    group_id: groupId,
    init_command: host.init_command,
    ...(host.protocol === "local"
      ? {
          protocol: "local",
          local_shell: host.local_shell,
          local_shell_args: host.local_shell_args,
          local_shell_name: host.local_shell_name,
          local_shell_icon: host.local_shell_icon,
          local_start_dir: host.local_start_dir,
        }
      : {}),
    ...(host.protocol === "telnet"
      ? {
          protocol: "telnet" as const,
          // Telnet 主机不挂 SSH 凭据；导入覆盖时一并清掉旧 credential_id。
          credential_id: "",
          telnet_username: host.telnet_username,
          telnet_charset: host.telnet_charset,
        }
      : {}),
    ...(host.icon_source ? { icon_source: host.icon_source } : {}),
    ...(host.icon_color ? { icon_color: host.icon_color } : {}),
    ...(host.sftp_protocol ? { sftp_protocol: host.sftp_protocol } : {}),
    ...(host.sftp_sudo ? { sftp_sudo: true } : {}),
    ...(host.sftp_encoding ? { sftp_encoding: host.sftp_encoding } : {}),
    totp_auto_submit: host.totp_auto_submit,
    totp_regex: host.totp_regex,
    agent_forwarding: host.agent_forwarding,
    ...(host.ssh_input_compatibility !== null
      ? { ssh_input_compatibility: host.ssh_input_compatibility }
      : {}),
    ...(host.protocol === "serial"
      ? {
          protocol: "serial" as const,
          serial_port: host.serial_port ?? host.host,
          serial_baud: host.serial_baud,
          serial_data_bits: host.serial_data_bits,
          serial_parity: host.serial_parity,
          serial_stop_bits: host.serial_stop_bits,
          serial_flow: host.serial_flow,
          serial_local_echo: host.serial_local_echo,
          serial_line_mode: host.serial_line_mode,
          serial_backspace: host.serial_backspace,
          serial_byte_backspace: host.serial_byte_backspace,
          serial_charset: host.serial_charset,
        }
      : {}),
  };
}
