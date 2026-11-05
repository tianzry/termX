/**
 * 终端自动补全的纯逻辑（对照 Netcatty `components/terminal/autocomplete/*`）。
 *
 * Netcatty 取证要点：
 * - 来源：当前行输入前缀 → 命令历史（按主机 / 全部）+ 常见命令；路径补全与
 *   @withfig 规范需要远端 `ls` / 进程查询，本版先覆盖命令级候选；
 * - 交互：候选下拉 ↑/↓ 切换并实时预览（选中项直接改写命令行）；点击行内
 *   候选同样进入预览；Tab 不拦截（让 Shell 原生补全 / 执行已预览的命令）；
 *   Enter 执行；Esc 取消并恢复原行；内联 ghost text 仅由 →（右方向键）接受；
 * - 匹配：大小写不敏感的 `startsWith`，历史按执行次数 / 时间优先，
 *   常见命令兜底；最少 1 个字符，最多 50 条（Netcatty 默认值）；
 * - 串口 / Telnet（网络设备 CLI）不做 live preview：Ctrl-U 会被当作会话终止，
 *   Netcatty 只在那里关闭预览改写，候选项仍然显示。
 *
 * 本模块无 React、无副作用，便于单测。
 */
import type { CommandHistoryEntry } from "./commandHistoryModel";

/** 候选历史范围（设置层用 global；历史模块内部叫 all）。 */
export type AutocompleteHistoryScope = "host" | "global";

/** Netcatty `terminalSettingsDefaults`：minChars 1、maxSuggestions 50、debounce 100ms。 */
export const AUTOCOMPLETE_MIN_CHARS = 1;
export const AUTOCOMPLETE_MAX_SUGGESTIONS = 50;
export const AUTOCOMPLETE_DEBOUNCE_MS = 100;

/** Netcatty 常见命令兜底（命令位置、无历史时的候选来源）。 */
export const COMMON_COMMANDS: readonly string[] = [
  "ls",
  "cd",
  "pwd",
  "cat",
  "less",
  "more",
  "tail",
  "head",
  "grep",
  "find",
  "awk",
  "sed",
  "ps",
  "top",
  "kill",
  "killall",
  "df",
  "du",
  "free",
  "uptime",
  "whoami",
  "uname",
  "date",
  "history",
  "mkdir",
  "rmdir",
  "rm",
  "cp",
  "mv",
  "ln",
  "chmod",
  "chown",
  "tar",
  "gzip",
  "unzip",
  "ssh",
  "scp",
  "rsync",
  "curl",
  "wget",
  "ping",
  "ss",
  "netstat",
  "ip",
  "ifconfig",
  "systemctl",
  "journalctl",
  "service",
  "docker",
  "kubectl",
  "git",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "sudo",
  "su",
  "echo",
  "export",
  "source",
  "vim",
  "nano",
  "crontab",
  "mount",
  "umount",
  "lsblk",
  "clear",
  "exit",
];

export interface AutocompleteSuggestion {
  command: string;
  source: "history" | "command";
  /** 历史候选的执行次数（用于排序 / 展示）。 */
  count?: number;
}

export function deriveAutocompleteSuggestions(input: {
  typed: string;
  history: readonly CommandHistoryEntry[];
  scope: AutocompleteHistoryScope;
  hostId: string;
  max?: number;
  minChars?: number;
}): AutocompleteSuggestion[] {
  const typed = input.typed;
  const minChars = input.minChars ?? AUTOCOMPLETE_MIN_CHARS;
  const max = Math.max(1, input.max ?? AUTOCOMPLETE_MAX_SUGGESTIONS);
  if (typed.length < minChars) return [];
  if (/[\r\n]/.test(typed)) return [];

  const prefix = typed.toLowerCase();
  const seen = new Set<string>();
  const historyMatches: AutocompleteSuggestion[] = [];
  for (const entry of input.history) {
    if (input.scope === "host" && entry.hostId !== input.hostId) continue;
    if (!entry.command.toLowerCase().startsWith(prefix)) continue;
    const key = entry.command;
    if (seen.has(key)) continue;
    seen.add(key);
    historyMatches.push({ command: entry.command, source: "history", count: entry.count });
  }
  historyMatches.sort(
    (a, b) => (b.count ?? 0) - (a.count ?? 0) || b.command.length - a.command.length,
  );

  const commandMatches: AutocompleteSuggestion[] = [];
  const commandPosition = !/\s/.test(typed);
  if (commandPosition) {
    for (const command of COMMON_COMMANDS) {
      if (!command.startsWith(prefix)) continue;
      if (seen.has(command)) continue;
      seen.add(command);
      commandMatches.push({ command, source: "command" });
    }
  }

  return [...historyMatches, ...commandMatches].slice(0, max);
}

/** 内联 ghost text：首个候选相对已输入前缀的尾部；无候选返回空串。 */
export function computeAutocompleteGhost(
  typed: string,
  suggestions: readonly AutocompleteSuggestion[],
): string {
  const first = suggestions[0];
  if (!first) return "";
  if (!first.command.toLowerCase().startsWith(typed.toLowerCase())) return "";
  if (first.command === typed) return "";
  return first.command.slice(typed.length);
}

/** 接受候选时写入终端的尾部；候选不以已输入内容开头说明不可接受 → null。 */
export function computeAutocompleteAcceptTail(
  typed: string,
  candidate: string,
): string | null {
  if (!candidate.toLowerCase().startsWith(typed.toLowerCase())) return null;
  return candidate.slice(typed.length);
}

/**
 * 实时预览改写：把当前行变成候选。
 * - 候选是当前行的延伸：只补尾部；
 * - 否则清行后整行写入（POSIX 用 Ctrl-U，Windows 用退格）。
 */
export function computeLivePreviewWrite(input: {
  currentLine: string;
  candidate: string;
  /** Windows Shell（PowerShell / cmd）不认 Ctrl-U，用退格。 */
  useBackspaceClear: boolean;
}): string {
  const { currentLine, candidate, useBackspaceClear } = input;
  if (candidate === currentLine) return "";
  if (candidate.startsWith(currentLine)) return candidate.slice(currentLine.length);
  const clear = useBackspaceClear ? "\b".repeat(currentLine.length) : "\x15";
  return clear + candidate;
}

export type AutocompleteKeyKind =
  | "print"
  | "enter"
  | "tab"
  | "backspace"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "line-erase"
  | "word-erase"
  | "interrupt"
  | "other";

/** 把 xterm onData 的一次输入归类为补全可识别的按键。 */
export function classifyAutocompleteData(data: string): AutocompleteKeyKind {
  if (data === "\r" || data === "\n") return "enter";
  if (data === "\t") return "tab";
  if (data === "\x7f" || data === "\b") return "backspace";
  if (data === "\x1b[A" || data === "\x1bOA") return "up";
  if (data === "\x1b[B" || data === "\x1bOB") return "down";
  if (data === "\x1b[C" || data === "\x1bOC") return "right";
  if (data === "\x1b[D" || data === "\x1bOD") return "left";
  if (data === "\x1b") return "escape";
  if (data === "\x15") return "line-erase";
  if (data === "\x17") return "word-erase";
  if (data === "\x03") return "interrupt";
  // 单字符可打印（含中文）：计入已输入前缀。
  if (data.length === 1 && data >= " " && data !== "\x7f") return "print";
  if (
    data.length > 1 &&
    !/[\x00-\x1f\x7f]/.test(data) &&
    !data.startsWith("\x1b")
  ) {
    // 粘贴／输入法一次性输入的多字符文本。
    return "print";
  }
  return "other";
}

export type AutocompleteKeyAction =
  | { kind: "ignore" }
  | { kind: "navigate"; delta: 1 | -1 }
  | { kind: "accept-ghost" }
  | { kind: "dismiss"; restore: boolean }
  | { kind: "confirm" }
  | { kind: "release" };

/**
 * 候选可见时的按键语义（逐项对照 Netcatty `terminalAutocompleteKeyEvent.ts`）。
 * `release` 表示处理完状态后仍需把原始字节交给终端（Tab / Enter）。
 */
export function resolveAutocompleteKey(input: {
  kind: AutocompleteKeyKind;
  popupOpen: boolean;
  ghostVisible: boolean;
}): AutocompleteKeyAction {
  const { kind, popupOpen, ghostVisible } = input;
  if (kind === "up" || kind === "down") {
    if (popupOpen) return { kind: "navigate", delta: kind === "down" ? 1 : -1 };
    return { kind: "ignore" };
  }
  if (kind === "right") {
    if (ghostVisible) return { kind: "accept-ghost" };
    return { kind: "ignore" };
  }
  if (kind === "escape") {
    if (popupOpen) return { kind: "dismiss", restore: true };
    if (ghostVisible) return { kind: "dismiss", restore: false };
    return { kind: "ignore" };
  }
  if (kind === "tab") {
    if (popupOpen || ghostVisible) return { kind: "release" };
    return { kind: "ignore" };
  }
  if (kind === "enter") {
    if (popupOpen || ghostVisible) return { kind: "confirm" };
    return { kind: "ignore" };
  }
  return { kind: "ignore" };
}

/** 移动选中项：-1 代表「回到原始输入」，列表两端不循环（Netcatty 同样夹取）。 */
export function moveAutocompleteSelection(
  selected: number,
  total: number,
  delta: 1 | -1,
): number {
  if (total <= 0) return -1;
  if (selected === -1) return delta === 1 ? 0 : total - 1;
  const next = selected + delta;
  if (next < -1) return -1;
  if (next >= total) return total - 1;
  return next;
}
