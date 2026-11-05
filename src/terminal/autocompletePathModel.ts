/**
 * 终端路径自动补全的纯逻辑（对照 Netcatty
 * `components/terminal/autocomplete/remotePathCompleter.ts`）。
 *
 * 取值由调用方注入（SSH 走 `sftp_list`、本地走 `local_list_dir`），本模块只负责：
 * - 判断当前命令位置是否需要路径补全（命令白名单 / 直接输入路径片段）；
 * - 把当前词拆成「待列目录 + 过滤前缀 + 展示前缀」（支持 `~` / 相对 / 绝对 /
 *   Windows 盘符，保留引号）；
 * - 目录结果按「目录 → 符号链接 → 文件」排序，目录补尾随 `/`；
 * - `sessionId + 绝对目录` 维度的 5s 缓存 + in-flight 合并 + 150ms 软预算；
 * - 任何取数失败都返回空数组（静默降级）。
 *
 * 无 React、无副作用，便于单测。
 */
import type { AutocompleteSuggestion } from "./autocompleteModel";

export type PathEntryType = "file" | "directory" | "symlink";

export interface PathEntry {
  name: string;
  type: PathEntryType;
}

/** Netcatty `PATH_COMPLETION_BUDGET_MS`：本地 provider 先出结果，远端迟到回填。 */
export const PATH_COMPLETION_BUDGET_MS = 150;
export const PATH_CACHE_TTL_MS = 5000;
export const PATH_CACHE_MAX_ENTRIES = 30;

/** 可接受路径实参的命令（Netcatty `PATH_COMMANDS` 子集；不含 docker/kubectl 等子命令工具）。 */
const PATH_COMMANDS = new Set([
  "cd", "pushd", "ls", "ll", "la", "dir", "tree", "exa", "eza", "lsd",
  "cat", "less", "more", "head", "tail", "bat", "tac", "nl", "tee",
  "vim", "vi", "nvim", "nano", "emacs", "code", "subl", "micro", "hx",
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "ln", "install", "shred",
  "chmod", "chown", "chgrp", "stat", "file", "lsattr", "chattr",
  "find", "rg", "grep", "egrep", "fgrep", "ag", "fd", "locate",
  "wc", "sort", "uniq", "cut", "awk", "sed",
  "tar", "zip", "unzip", "gzip", "gunzip", "bzip2", "xz", "zstd", "7z", "rar",
  "scp", "rsync", "diff", "cmp", "patch",
  "source", "bash", "sh", "zsh", "fish", "python", "python3", "node", "ruby",
  "perl", "php", "gcc", "g++", "deno", "bun",
  "du", "df", "chroot",
  "realpath", "readlink", "basename", "dirname", "md5sum", "sha256sum", "xxd",
  "hexdump", "xdg-open", "open", "start",
]);

const FOLDER_ONLY_COMMANDS = new Set(["cd", "mkdir", "rmdir", "pushd"]);

export type PathSeparator = "/" | "\\";

/** 按空格切分命令行，保留引号内的空格与空尾 token（`cd ` → ["cd",""]）。 */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (ch === " " && !inSingleQuote && !inDoubleQuote) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  tokens.push(current);
  return tokens;
}

/** 光标所在词（最后一个 token）。 */
export function currentWordOf(line: string): string {
  const tokens = tokenizeCommandLine(line);
  return tokens[tokens.length - 1] ?? "";
}

/** 当前词之前的命令前缀（含分隔空格），用于拼回完整候选行。 */
export function commandPrefixOf(line: string): string {
  const tokens = tokenizeCommandLine(line);
  const wordIndex = tokens.length - 1;
  if (wordIndex <= 0) return "";
  return `${tokens.slice(0, wordIndex).join(" ")} `;
}

/** 用替换词重拼完整命令行。 */
export function replaceCommandWord(line: string, replacement: string): string {
  const tokens = tokenizeCommandLine(line);
  const wordIndex = tokens.length - 1;
  if (wordIndex < 0) return replacement;
  tokens[wordIndex] = replacement;
  return tokens.join(" ");
}

export function stripWrappingQuotes(value: string): string {
  let text = value;
  if (text.startsWith('"') || text.startsWith("'")) text = text.slice(1);
  if (text.endsWith('"') || text.endsWith("'")) text = text.slice(0, -1);
  return text;
}

function leadingQuote(value: string): string {
  return value.startsWith('"') || value.startsWith("'") ? value[0] : "";
}

function trailingQuote(value: string, quotePrefix: string): string {
  return quotePrefix && value.endsWith(quotePrefix) ? quotePrefix : "";
}

/** 当前命令是否处在需要路径补全的位置（对照 `shouldDoPathCompletion`）。 */
export function shouldCompletePath(line: string): {
  complete: boolean;
  foldersOnly: boolean;
} {
  const tokens = tokenizeCommandLine(line);
  const wordIndex = tokens.length - 1;
  const currentWord = stripWrappingQuotes(tokens[wordIndex] ?? "");
  const commandName = (tokens[0] ?? "").toLowerCase();

  const foldersOnly = FOLDER_ONLY_COMMANDS.has(commandName);

  // 直接输入路径片段：无论命令是什么都补全。
  if (
    currentWord.startsWith("/") ||
    currentWord.startsWith("./") ||
    currentWord.startsWith("../") ||
    currentWord.startsWith("~/") ||
    currentWord === "." ||
    currentWord === ".." ||
    currentWord === "~" ||
    (currentWord.includes("\\") && currentWord.length > 1)
  ) {
    return { complete: true, foldersOnly };
  }

  // 命令位之后的实参位置：命令在路径白名单内，且当前词不是选项。
  if (wordIndex >= 1 && PATH_COMMANDS.has(commandName) && !currentWord.startsWith("-")) {
    return { complete: true, foldersOnly };
  }

  return { complete: false, foldersOnly: false };
}

export interface PathLookup {
  /** 待列目录（`~` / 绝对 / 相对，交给 loader 展开）。 */
  dirToList: string;
  /** 当前目录下要过滤的前缀。 */
  filterPrefix: string;
  /** 展示用前缀（含前导引号与已输入目录部分）。 */
  pathPrefix: string;
  quotePrefix: string;
  quoteSuffix: string;
  separator: PathSeparator;
  /** 该目录是否是路径风格（用于命令拼接时保留分隔符）。 */
  quoted: boolean;
}

function detectSeparator(word: string, windows: boolean, cwd?: string): PathSeparator {
  if (!windows) return "/";
  if (word.includes("\\")) return "\\";
  if (/^[A-Za-z]:[\\/]/.test(word)) return "\\";
  // 当前词没有分隔符时按 cwd 判断：Windows 本地 Shell 的 cwd 是盘符绝对路径，
  // 拼接时必须用 `\`，否则 cmd 会把路径里的 `/` 当成开关。
  if (cwd && /^[A-Za-z]:[\\/]/.test(cwd)) return "\\";
  return "/";
}

/** `~` 统一成 `~/` 形式，交给 loader 用 home 展开。 */
function normalizePath(input: string, separator: PathSeparator): string {
  if (!input) return ".";
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\")) {
    const rest = input.slice(1).replace(/^[\\/]+/, "");
    return rest ? `~/${rest.split(/[\\/]/).filter(Boolean).join("/")}` : "~";
  }

  const drive = /^([A-Za-z]:)[\\/]/.exec(input);
  const prefix = drive ? drive[1] : input.startsWith("/") ? "/" : "";
  const body = drive ? input.slice(2) : prefix === "/" ? input.slice(1) : input;
  const parts = body.split(/[\\/]/);
  const out: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!prefix) out.push("..");
      continue;
    }
    out.push(part);
  }

  const joined = out.join(separator);
  if (prefix === "/") return `/${joined}`;
  if (drive) return `${prefix}${separator}${joined}`;
  return joined || ".";
}

function resolveDirLookup(
  token: string,
  cwd: string | undefined,
  separator: PathSeparator,
): string {
  const normalizedToken = token.replace(/[\\/]+$/, "");
  if (!normalizedToken) return cwd ? normalizePath(cwd, separator) : "~";
  if (normalizedToken.startsWith("/") || /^[A-Za-z]:/.test(normalizedToken)) {
    return normalizePath(normalizedToken, separator);
  }
  if (normalizedToken === "~" || normalizedToken.startsWith("~/") || normalizedToken.startsWith("~\\")) {
    return normalizePath(normalizedToken, separator);
  }
  const base = cwd && cwd.length > 0 ? cwd : "~";
  return normalizePath(`${base}${separator}${normalizedToken}`, separator);
}

/** 把当前词拆成「待列目录 + 过滤前缀 + 展示前缀」（对照 `resolvePathComponents`）。 */
export function resolvePathLookup(input: {
  currentWord: string;
  cwd?: string | null;
  windows?: boolean;
}): PathLookup {
  const quotePrefix = leadingQuote(input.currentWord);
  const quoteSuffix = trailingQuote(input.currentWord, quotePrefix);
  const word = stripWrappingQuotes(input.currentWord);
  const separator = detectSeparator(word, input.windows === true, input.cwd ?? undefined);
  const cwd = input.cwd ?? undefined;

  if (!word || word === "." || word === "~" || word === "..") {
    const dirToList = word === ".."
      ? resolveDirLookup("../", cwd, separator)
      : resolveDirLookup(word, cwd, separator);
    const prefixText = word
      ? `${word}${word === ".." ? separator : ""}`
      : "";
    return {
      dirToList,
      filterPrefix: "",
      pathPrefix: `${quotePrefix}${prefixText}`,
      quotePrefix,
      quoteSuffix,
      separator,
      quoted: quotePrefix !== "",
    };
  }

  const slashIndex = word.lastIndexOf("/");
  const backslashIndex = separator === "\\" ? word.lastIndexOf("\\") : -1;
  const lastSeparator = Math.max(slashIndex, backslashIndex);

  if (lastSeparator >= 0) {
    const dirPart = word.slice(0, lastSeparator + 1);
    return {
      dirToList: resolveDirLookup(dirPart, cwd, separator),
      filterPrefix: word.slice(lastSeparator + 1),
      pathPrefix: `${quotePrefix}${dirPart}`,
      quotePrefix,
      quoteSuffix,
      separator,
      quoted: quotePrefix !== "",
    };
  }

  return {
    dirToList: resolveDirLookup("", cwd, separator),
    filterPrefix: word,
    pathPrefix: quotePrefix,
    quotePrefix,
    quoteSuffix,
    separator,
    quoted: quotePrefix !== "",
  };
}

/** 子面板要列的子目录（保留尾随分隔符）。 */
export function joinDirectoryPath(
  parent: string,
  name: string,
  separator: PathSeparator,
): string {
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}${separator}`;
}

/** 目录项排序：目录 → 符号链接 → 文件，同类按名称（忽略大小写）。 */
export function sortPathEntries(entries: readonly PathEntry[]): PathEntry[] {
  const rank = (entry: PathEntry): number =>
    entry.type === "directory" ? 0 : entry.type === "symlink" ? 1 : 2;
  return [...entries].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

function shellEscape(name: string): string {
  if (/[\\$'"|!<>;#~` ]/.test(name)) {
    return `'${name.replace(/'/g, "'\\''")}'`;
  }
  return name;
}

/**
 * 把目录条目转成路径候选（完整命令行 + 展示名 + 文件类型）。
 * 目录补尾随 `/`（本地 Windows 用 `\`），文件不补。
 */
export function buildPathSuggestions(input: {
  line: string;
  lookup: PathLookup;
  entries: readonly PathEntry[];
  foldersOnly?: boolean;
}): AutocompleteSuggestion[] {
  const { line, lookup, entries } = input;
  const foldersOnly = input.foldersOnly === true;
  const prefix = commandPrefixOf(line);
  const suggestions: AutocompleteSuggestion[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (foldersOnly && entry.type !== "directory") continue;
    const suffix = entry.type === "directory" ? lookup.separator : "";
    const name = lookup.quoted ? entry.name : shellEscape(entry.name);
    const command = `${prefix}${lookup.pathPrefix}${name}${suffix}${lookup.quoteSuffix}`;
    if (seen.has(command)) continue;
    seen.add(command);
    suggestions.push({
      command,
      display: `${entry.name}${suffix}`,
      description:
        entry.type === "directory"
          ? "目录"
          : entry.type === "symlink"
            ? "符号链接"
            : "文件",
      source: "path",
      score: 750,
      fileType: entry.type,
      pathDir:
        entry.type === "directory"
          ? joinDirectoryPath(lookup.dirToList, entry.name, lookup.separator)
          : undefined,
    });
  }

  return suggestions;
}

/** 按前缀过滤目录条目（不区分大小写）。 */
export function filterPathEntries(
  entries: readonly PathEntry[],
  filterPrefix: string,
  limit = 100,
): PathEntry[] {
  const prefix = filterPrefix.toLowerCase();
  if (!prefix) return [...entries].slice(0, limit);
  const out: PathEntry[] = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase().startsWith(prefix)) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface PathDirectoryCache {
  /** 命中缓存直接返回；相同 key 的并发请求合并；失败返回空数组并清掉 in-flight。 */
  get(cacheKey: string, loader: () => Promise<PathEntry[]>): Promise<PathEntry[]>;
  invalidate(cacheKey?: string): void;
  size(): number;
}

export function createPathDirectoryCache(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): PathDirectoryCache {
  const ttlMs = options.ttlMs ?? PATH_CACHE_TTL_MS;
  const maxEntries = Math.max(1, options.maxEntries ?? PATH_CACHE_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { entries: PathEntry[]; timestamp: number }>();
  const inFlight = new Map<string, Promise<PathEntry[]>>();

  const evictOldest = () => {
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    get(cacheKey, loader) {
      const cached = cache.get(cacheKey);
      if (cached && now() - cached.timestamp < ttlMs) {
        return Promise.resolve(cached.entries);
      }

      const pending = inFlight.get(cacheKey);
      if (pending) return pending;

      const request = (async (): Promise<PathEntry[]> => {
        try {
          const entries = await loader();
          cache.set(cacheKey, { entries, timestamp: now() });
          evictOldest();
          return entries;
        } catch {
          return [];
        } finally {
          inFlight.delete(cacheKey);
        }
      })();

      inFlight.set(cacheKey, request);
      return request;
    },
    invalidate(cacheKey) {
      if (cacheKey === undefined) {
        cache.clear();
        inFlight.clear();
        return;
      }
      cache.delete(cacheKey);
      inFlight.delete(cacheKey);
    },
    size() {
      return cache.size;
    },
  };
}

/**
 * 软预算：到点先返回已就绪结果，请求继续在后台跑；迟到结果通过
 * `onLateResult` 回填（相对路径走缓存时也可直接预热缓存）。
 */
export async function withPathBudget(
  request: Promise<PathEntry[]>,
  budgetMs: number,
  onLateResult?: (entries: PathEntry[]) => void,
): Promise<PathEntry[]> {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) return request;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    request.then(
      (entries) => ({ kind: "entries" as const, entries }),
      () => ({ kind: "entries" as const, entries: [] as PathEntry[] }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), budgetMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome.kind === "entries") return outcome.entries;

  void request.then(
    (entries) => {
      if (entries.length > 0) onLateResult?.(entries);
    },
    () => {
      // 迟到失败静默丢弃。
    },
  );
  return [];
}
