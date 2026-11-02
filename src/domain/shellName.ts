/**
 * 本地终端卡显示名：把后端 `default_shell` 返回的命令 / 路径翻译成
 * 人类可读的 shell 名（对齐 Netcatty 本地卡的「Git Bash / Git Bash」）。
 * 纯函数，无平台依赖，可单测。
 */
export function shellDisplayName(shell: string): string {
  const s = shell.trim();
  if (!s) return "本地终端";
  const cleaned = s.replace(/^"(.*)"$/, "$1");
  const seg = cleaned.split(/[\\/]/).pop() ?? cleaned;
  const base = seg.replace(/\.(exe|com|bat|cmd)$/i, "").toLowerCase();
  const lowerPath = cleaned.toLowerCase();
  switch (base) {
    case "cmd":
      return "CMD";
    case "pwsh":
      return "PowerShell 7";
    case "powershell":
      return "Windows PowerShell";
    case "wsl":
      return "WSL";
    case "bash":
      if (lowerPath.includes("\\git\\") || lowerPath.includes("/git/"))
        return "Git Bash";
      if (lowerPath.includes("cygwin")) return "Cygwin";
      return "Bash";
    default:
      return seg.replace(/\.(exe|com|bat|cmd)$/i, "");
  }
}
