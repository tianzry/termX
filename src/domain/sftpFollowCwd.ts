/**
 * SFTP 跟随终端目录的纯决策逻辑
 * （对照 Netcatty `domain/sftpFollowTerminalCwd.ts` 的 follow-sync 判定）。
 *
 * 只保留 termX 面板形态需要的最小集合：面板可见 → 已连接 → 无进行中的传输
 * → 终端 cwd 合法且尚未处理过。Netcatty 的 generation / 多窗格竞态守卫需要
 * 侧栏 portal + 多次切换的复杂生命周期，termX 里 SFTP 工具面板跟随活动
 * 窗格单一来源，用 handled/blocked 两个路径即可避免来回跳转。
 */

export interface SftpFollowCwdInput {
  followEnabled: boolean;
  isConnected: boolean;
  /** 有传输任务在跑时不要抢走用户当前浏览的目录。 */
  hasActiveWork: boolean;
  terminalCwd: string | null | undefined;
  currentPath: string | null | undefined;
  /** 已经跟随过的终端 cwd（成功进入后记录，避免用户手动浏览被打回）。 */
  handledPath?: string | null;
  /** 进入失败的终端 cwd（远端不存在 / 无权限），跳过直到 cwd 再次变化。 */
  blockedPath?: string | null;
}

/** cwd 是否是 SFTP 可导航的绝对路径（远端 Unix 或 Windows 盘符）。 */
export function isSftpFollowTargetPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** 展开提示符里的 `~`，避免把 `/~` 当成绝对路径导航。 */
export function resolveTerminalCwdForSftp(
  cwd: string,
  homeDir?: string | null,
  currentPath?: string | null,
): string {
  const home =
    homeDir && homeDir.startsWith("/")
      ? homeDir
      : guessUnixHomeDirFromPath(currentPath);
  if (cwd === "~") return home ?? cwd;
  if (cwd.startsWith("~/") && home) {
    return `${home.replace(/\/+$/, "")}/${cwd.slice(2)}`;
  }
  return cwd;
}

/** 从已打开的 SFTP 路径猜测 home（`~` 无法回显时的兜底）。 */
export function guessUnixHomeDirFromPath(path?: string | null): string | null {
  if (!path || !path.startsWith("/")) return null;
  if (path === "/root" || path.startsWith("/root/")) return "/root";
  const match = path.match(/^(\/home\/[^/]+)/);
  return match ? match[1] : null;
}

/** 本次渲染是否应该把 SFTP 导航到终端 cwd。 */
export function shouldFollowTerminalCwdNavigate(input: SftpFollowCwdInput): boolean {
  const { followEnabled, isConnected, hasActiveWork, terminalCwd, currentPath } = input;
  if (!followEnabled || !isConnected) return false;
  if (hasActiveWork) return false;
  const target = terminalCwd?.trim();
  if (!target) return false;
  if (input.handledPath === target || input.blockedPath === target) return false;
  if (target === currentPath) return false;
  return true;
}
