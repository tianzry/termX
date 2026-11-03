/**
 * Vault 侧「本地 shell 主机」（protocol = 'local'）域逻辑，
 * 对齐 Netcatty domain/localShellHost.ts + lib/useDiscoveredShells.ts 的
 * resolveShellSetting。纯函数、无平台依赖，可单测。
 *
 * 与 SSH 主机同列：同分组、同排序、同右键菜单；点击时走 PTY 链路，
 * 按主机保存的 shell 快照解析启动命令（见 resolveHostDefaultLocalShell）。
 */
import type { DiscoveredShell, Profile } from "../backend/client";

export const LOCAL_SHELL_HOST_TAG = "local";

export interface LocalShellHostInput {
  id?: string;
  /** 显示名（Netcatty 的 label） */
  name?: string;
  /** 发现的 shell id（如 "wsl-ubuntu"）或自定义命令；空 = 系统默认 Shell */
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
  startDir?: string;
  groupId?: string | null;
}

/** 照抄 Netcatty createLocalShellHost 语义：host 固定 localhost、
 * 名称回退 输入 → shell 显示名 → "Local Shell"、空 shell 存 undefined。
 * termX 的 tags 存 localStorage（VaultView TAGS_KEY），不入 Profile。 */
export const createLocalShellHost = (input: LocalShellHostInput): Profile => ({
  id: input.id ?? `local-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
  name: input.name?.trim() || input.shellName?.trim() || "Local Shell",
  host: "localhost",
  port: 22,
  credential_id: "",
  bastion_profile_id: null,
  init_command: null,
  group_id: input.groupId?.trim() || null,
  agent_forwarding: false,
  protocol: "local",
  local_shell: input.shell?.trim() || undefined,
  local_shell_args: input.shellArgs?.length ? input.shellArgs : undefined,
  local_shell_name: input.shellName?.trim() || undefined,
  local_shell_icon: input.shellIcon?.trim() || undefined,
  local_start_dir: input.startDir?.trim() || undefined,
});

/** 既有本地主机显示的 shell 名（副标题）。 */
export const getLocalShellHostSubtitle = (
  profile: Pick<Profile, "local_shell_name">,
  fallback = "本地终端",
): string => profile.local_shell_name?.trim() || fallback;

export interface VaultHostRowSubtitleOptions {
  /** 本地主机「系统默认 Shell」时的回退文案（已翻译）。 */
  localFallback?: string;
  /** SSH 主机副标题；termX 的用户名在凭据表里，由调用方查好后传入。 */
  sshSubtitle?: string;
}

/** Vault 卡 / 行共用的副标题。 */
export const getVaultHostRowSubtitle = (
  profile: Pick<Profile, "protocol" | "local_shell_name">,
  options?: VaultHostRowSubtitleOptions,
): string =>
  profile.protocol === "local"
    ? getLocalShellHostSubtitle(profile, options?.localFallback)
    : options?.sshSubtitle ?? "";

/**
 * 把 localShell 设置值解析成命令 + 参数（对齐 Netcatty resolveShellSetting）。
 * 值可以是发现的 shell id（"wsl-ubuntu" / "pwsh"），也可以是自定义路径 / 命令。
 * `customArgs` 是显式保存的启动参数，存在时优先于发现列表自带参数。
 * 空值返 null（= 系统默认，由后端兜底）。
 */
export function resolveShellSetting(
  localShell: string,
  discoveredShells: DiscoveredShell[],
  customArgs?: string[],
): { command: string; args?: string[] } | null {
  if (!localShell) return null;

  // 按发现的 shell id 匹配：参数用发现列表自带（如 WSL "-d Ubuntu"），
  // 除非显式配置了 customArgs。
  const shell = discoveredShells.find((s) => s.id === localShell);
  if (shell) {
    return {
      command: shell.command,
      args: customArgs?.length ? customArgs : shell.args,
    };
  }

  // 非 id = 自定义命令 / 路径，原样透传（含本机已不存在的陈旧 id，
  // 优雅降级到 OS 解析或可见的 spawn 错误）。无 customArgs 时不带参数，
  // 让后端默认行为（login 旗标等）继续生效。
  return { command: localShell, args: customArgs?.length ? customArgs : undefined };
}

export interface ResolveDefaultLocalShellContext {
  discoveredShells?: DiscoveredShell[];
  terminalSettings?: {
    localShell?: string;
    localShellArgs?: string[];
    localStartDir?: string;
  };
  resolveShellSetting?: (
    localShell: string,
    discoveredShells: DiscoveredShell[],
    customArgs?: string[],
  ) => { command: string; args?: string[] } | null;
}

/** 本地会话启动前把主机里「系统默认 Shell」解析成具体命令快照
 * （对齐 Netcatty resolveHostDefaultLocalShell）。 */
export const resolveHostDefaultLocalShell = (
  profile: Profile,
  ctx: ResolveDefaultLocalShellContext,
): Profile => {
  if (profile.protocol !== "local") return profile;
  const configuredShell =
    profile.local_shell || ctx.terminalSettings?.localShell || "";
  const customArgs = profile.local_shell
    ? profile.local_shell_args ?? undefined
    : configuredShell
      ? ctx.terminalSettings?.localShellArgs
      : undefined;
  const resolved = ctx.resolveShellSetting?.(
    configuredShell,
    ctx.discoveredShells ?? [],
    customArgs,
  );
  const matchedShell = ctx.discoveredShells?.find(
    (shell) => shell.id === configuredShell,
  );
  return {
    ...profile,
    // 空 = 后端默认，而不是之后 Vault/设置里的某个值。
    local_shell: resolved?.command || configuredShell || "",
    local_shell_args: resolved?.args ?? customArgs,
    local_shell_name: profile.local_shell
      ? profile.local_shell_name
      : matchedShell?.name,
    local_shell_icon: profile.local_shell
      ? profile.local_shell_icon
      : matchedShell?.icon,
    // `~` 由启动器展开为主目录；主机与设置都没给目录时显式固化 '~'，
    // 避免之后改全局设置影响已复制会话的原始启动目录。
    local_start_dir:
      profile.local_start_dir || ctx.terminalSettings?.localStartDir || "~",
  };
};
