/**
 * OSC 7 当前目录追踪（对照 Netcatty `components/terminal/osc7Setup.ts`）。
 *
 * Netcatty 用一段较长的安装器脚本把 shell 钩子写进 rc 文件，之后 shell 每次
 * 出提示符就发 `OSC 7 ; file://host/path`，终端据此知道远端 cwd。这里保留
 * 同样的三段式流程（写入 rc → 立即触发一次 → 解析上报），钩子脚本做了精简：
 * 不含百分号转义（termX 的消费者只处理本地路径，原样字符串即可）。
 */

export const OSC7_MARKER_START = "# >>> termX osc7 >>>";
export const OSC7_MARKER_END = "# <<< termX osc7 <<<";

const BASH_HOOK = [
  OSC7_MARKER_START,
  "__termx_osc7_cwd() { printf '\\033]7;file://%s%s\\007' \"${HOSTNAME:-localhost}\" \"$PWD\"; }",
  'case ";$PROMPT_COMMAND;" in *__termx_osc7_cwd*) ;; *) PROMPT_COMMAND="__termx_osc7_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac',
  // 只在交互 shell 里立即上报一次：sshd 的 Subsystem（如 sftp-server）也会经
  // `bash -c` 加载 .bashrc，无守卫的 printf 会把 OSC 7 字节混进 SFTP 通道，
  // 导致协议解析卡死（表现为 SFTP 初始化 Timeout）。
  "case $- in *i*) __termx_osc7_cwd ;; esac",
  OSC7_MARKER_END,
].join("\n");

const ZSH_HOOK = [
  OSC7_MARKER_START,
  "__termx_osc7_cwd() { printf '\\033]7;file://%s%s\\007' \"${HOSTNAME:-localhost}\" \"$PWD\"; }",
  "autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __termx_osc7_cwd 2>/dev/null",
  // 与 bash/fish 同款守卫：保持三种钩子里「裸调用 __termx_osc7_cwd」只出现在旧版本，
  // 安装器以此识别并升级历史无守卫块。
  "[[ -o interactive ]] && __termx_osc7_cwd",
  OSC7_MARKER_END,
].join("\n");

const FISH_HOOK = [
  OSC7_MARKER_START,
  "function __termx_osc7_cwd --on-event fish_prompt",
  "    set -l h (hostname 2>/dev/null)",
  '    test -n "$h"; or set h localhost',
  "    printf '\\033]7;file://%s%s\\007' \"$h\" \"$PWD\"",
  "end",
  // config.fish 在非交互 `fish -c`（含 sshd Subsystem 执行）时也会加载，需守卫。
  "status is-interactive; and __termx_osc7_cwd",
  OSC7_MARKER_END,
].join("\n");

/** 单引号安全转义：脚本里没有单引号，仍按 POSIX 规则处理一遍。 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface Osc7SetupPlan {
  /** 通过 SSH exec 通道执行的安装命令（不污染交互会话的历史）。 */
  command: string;
}

/**
 * 生成安装计划。检测顺序与 Netcatty 一致：优先 `$SHELL` 的 basename，
 * 未知 shell 回退 bash。
 */
export function buildOsc7SetupPlan(): Osc7SetupPlan {
  const blocks = [
    `[ "$shell_name" = bash ] && hook=${shQuote(BASH_HOOK)}`,
    `[ "$shell_name" = zsh ] && hook=${shQuote(ZSH_HOOK)}`,
    `[ "$shell_name" = fish ] && hook=${shQuote(FISH_HOOK)}`,
  ].join("\n");
  const command = [
    "set -u",
    'shell_name="${SHELL##*/}"',
    'case "$shell_name" in bash|zsh|fish) ;; *) shell_name=bash ;; esac',
    'case "$shell_name" in',
    '  zsh) cfg="${ZDOTDIR:-$HOME}/.zshrc" ;;',
    '  fish) cfg="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;',
    '  *) cfg="$HOME/.bashrc" ;;',
    "esac",
    "hook=''",
    blocks,
    'mkdir -p "$(dirname "$cfg")" 2>/dev/null || true',
    'touch "$cfg" 2>/dev/null || true',
    // 升级旧版无守卫钩子：旧块里有整行裸调用 __termx_osc7_cwd（非交互 shell 也会
    // 打印 OSC 7，污染 sshd Subsystem/SFTP 通道）；整块删除后按新模板重写。
    `if grep -Fxq '__termx_osc7_cwd' "$cfg" 2>/dev/null && grep -Fq ${shQuote(OSC7_MARKER_END)} "$cfg" 2>/dev/null; then sed -i.termx-osc7-old '/>>> termX osc7 >>>/,/<<< termX osc7 <<</d' "$cfg" && rm -f "$cfg.termx-osc7-old"; fi`,
    `if ! grep -Fq ${shQuote(OSC7_MARKER_START)} "$cfg" 2>/dev/null; then printf '%s\\n' "$hook" >> "$cfg"; fi`,
    `printf '__TERMX_OSC7_SHELL__=%s\\n' "$shell_name"`,
    `printf '__TERMX_OSC7_CONFIG__=%s\\n' "$cfg"`,
  ].join("\n");
  return { command };
}

/** 从安装脚本的 stdout 元数据里取出 shell 与写入的配置文件。 */
export function parseOsc7SetupResult(stdout: string): {
  shell: string | null;
  config: string | null;
} {
  const shell = /__TERMX_OSC7_SHELL__=([^\r\n]+)/.exec(stdout)?.[1]?.trim() ?? null;
  const config =
    /__TERMX_OSC7_CONFIG__=([^\r\n]+)/.exec(stdout)?.[1]?.trim() ?? null;
  return { shell, config };
}

/** 安装完成后，按实际 shell 选择重载命令。 */
export function osc7ReloadCommand(shell: string | null): string {
  const commandByShell: Record<string, string> = {
    bash: 'source "$HOME/.bashrc" >/dev/null 2>&1; __termx_osc7_cwd',
    zsh: 'source "${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1; __termx_osc7_cwd',
    fish: 'source "$HOME/.config/fish/config.fish" >/dev/null 2>&1; __termx_osc7_cwd',
  };
  return commandByShell[shell ?? "bash"] ?? commandByShell.bash;
}

/**
 * 解析 OSC 7 负载：`file://host/path`。返回解码后的绝对路径；非法负载返回
 * null。兼容未做百分号转义的原始路径（termX 精简钩子的产物）。
 */
export function parseOsc7Cwd(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(trimmed);
  if (!match) return null;
  const rawPath = match[1];
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}
