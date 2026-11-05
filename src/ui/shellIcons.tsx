/**
 * 本地 Shell 图标来源（对照 Netcatty `lib/useDiscoveredShells.ts`）。
 *
 * 发行版图标是单色黑 SVG，暗色主题需要反色；其余 shell 图标本身带色，
 * 未知 id 统一回退到终端图标。
 */

export const DISTRO_ICON_IDS = [
  "ubuntu",
  "debian",
  "kali",
  "alpine",
  "opensuse",
  "fedora",
  "arch",
  "oracle",
  "linux",
] as const;

const DISTRO_ICON_SET: ReadonlySet<string> = new Set(DISTRO_ICON_IDS);

/** `public/shells/*.svg` 的已知 id；其余（如 wsl-xxx）没有对应资源。 */
const SHELL_ICON_IDS: ReadonlySet<string> = new Set([
  "bash",
  "cmd",
  "cygwin",
  "fish",
  "git-bash",
  "nushell",
  "powershell",
  "pwsh",
  "zsh",
  "terminal",
]);

const FALLBACK_ICON = "/shells/terminal.svg";

export function shellIconSrc(id?: string | null): string {
  if (!id) return FALLBACK_ICON;
  if (DISTRO_ICON_SET.has(id)) return `/distro/${id}.svg`;
  if (SHELL_ICON_IDS.has(id)) return `/shells/${id}.svg`;
  return FALLBACK_ICON;
}

/** 发行版图标为单色黑，暗色主题下需要 `filter: invert(1)`。 */
export function isMonochromeShellIcon(id?: string | null): boolean {
  return !!id && DISTRO_ICON_SET.has(id);
}
