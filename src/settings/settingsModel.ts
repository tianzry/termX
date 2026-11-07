/**
 * 设置中心数据模型：类型 + 默认值 + normalize（纯函数，单测见 settings.test.ts）。
 *
 * 持久化：整个设置对象以 JSON 存 db settings 表 key `settings.center.v1`
 * （经 client.ts getSetting/setSetting，R1）。默认值对照 Netcatty
 * settingsStateDefaults.ts / terminalSettingsStore.ts。
 */

export type ThemeMode = "light" | "dark" | "system";
export type AccentMode = "theme" | "custom";
export type CursorShape = "block" | "bar" | "underline";
export type RightClickBehavior = "context-menu" | "paste" | "select-word";
export type MiddleClickBehavior = "context-menu" | "paste" | "disabled";
export type DisconnectedNoticeMode = "terminal" | "dialog";

import {
  INLINE_IMAGE_MAX_MEGAPIXELS_DEFAULT,
  INLINE_IMAGE_SEQUENCE_LIMIT_MB_DEFAULT,
  INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT,
  normalizeInlineImageMaxMegapixels,
  normalizeInlineImageSequenceLimitMb,
  normalizeInlineImageStorageLimitMb,
} from "../terminal/inlineImages";
export type TabDoubleClickBehavior = "duplicate" | "copy" | "disabled";
export type DynamicTabTitleMode = "off" | "agent" | "all";
export type OscNotificationMode = "always" | "unfocused" | "off";
export type Osc52ClipboardMode = "off" | "write-only" | "read-write" | "prompt";
export type LinkModifier = "none" | "ctrl" | "alt" | "meta";
export type LinkBrowser = "netcatty" | "system";
export type ProxyMode = "system" | "direct" | "custom";
export type SftpDoubleClickBehavior = "open" | "transfer";
export type AutocompleteHistoryScope = "host" | "global";
export type SessionLogFormat = "txt" | "raw" | "html";
export type HotkeyScheme = "mac" | "pc";
export type UiLanguage = "zh-CN" | "en";

/** 应用图标变体白名单（对齐 Netcatty domain/appIconVariant.ts APP_ICON_VARIANTS）。 */
export const APP_ICON_VARIANTS = [
  "original",
  "bright",
  "dark",
  "colorful",
  "high-contrast",
  "white-navy",
  "white-sky",
  "white-rose",
  "white-emerald",
  "white-amber",
  "white-violet",
  "rainbow",
] as const;
export type AppIconVariant = (typeof APP_ICON_VARIANTS)[number];

/** 关键字高亮规则（1:1 对齐 Netcatty domain/models/terminal.ts KeywordHighlightRule）。 */
export interface KeywordHighlightRule {
  id: string;
  /** 展示名（Netcatty：Error / Warning / OK …）。 */
  label: string;
  /** 逐条正则；按行匹配、忽略大小写。 */
  patterns: string[];
  /** #RRGGBB。 */
  color: string;
  enabled: boolean;
}

const STRICT_IPV4_OCTET_PATTERN = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const URL_HIGHLIGHT_PATTERN =
  "(?:\\bhttps?:\\/\\/\\[[0-9A-Fa-f:.]+\\](?::\\d+)?(?:[/?#][^\\s<>\"'`]*)?(?<![.,;:!?\\)}]))|\\b(?:https?:\\/\\/|www\\.)[^\\s<>\"'`]+(?<![.,;:!?\\])}])";
const IPV4_HIGHLIGHT_PATTERN = `(?<![\\w.])(?<!\\bver\\s)(?<!\\bversion\\s)(?:${STRICT_IPV4_OCTET_PATTERN}\\.){3}${STRICT_IPV4_OCTET_PATTERN}(?![\\w.])`;
const IPV6_HIGHLIGHT_PATTERN =
  "(?<![\\w:.])" +
  "(?:" +
  "(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}" +
  "|(?:[0-9A-Fa-f]{1,4}:){1,7}:" +
  "|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}" +
  "|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}" +
  "|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}" +
  "|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}" +
  "|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}" +
  "|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}" +
  "|::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}" +
  ")" +
  "(?![\\w:.])";
const MAC_ADDRESS_HIGHLIGHT_PATTERN = "\\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b";
const UNIX_PATH_HIGHLIGHT_PATTERN =
  "(?<=\")(?:/|~/)[^\"\\r\\n]+(?=\")|(?<=')(?:/|~/)[^'\\r\\n]+(?=')|(?<![\\w.:/\"'\\u0080-\\uFFFF])(?:/|~/)[^\\s\"']+";

/** 内置规则（与 Netcatty DEFAULT_KEYWORD_HIGHLIGHT_RULES 同 id / 同 pattern / 同色）。 */
export const DEFAULT_KEYWORD_HIGHLIGHT_RULES: KeywordHighlightRule[] = [
  {
    id: "error",
    label: "Error",
    patterns: ["\\[error\\]", "\\[err\\]", "\\berror\\b", "\\bfail(ed)?\\b", "\\bfatal\\b", "\\bcritical\\b", "\\bexception\\b"],
    color: "#F87171",
    enabled: true,
  },
  {
    id: "warning",
    label: "Warning",
    patterns: ["\\[warn(ing)?\\]", "\\bwarn(ing)?\\b", "\\bcaution\\b", "\\bdeprecated\\b"],
    color: "#FBBF24",
    enabled: true,
  },
  {
    id: "ok",
    label: "OK",
    patterns: ["\\[ok\\]", "\\bok\\b", "\\bsuccess(ful)?\\b", "\\bpassed\\b", "\\bcompleted\\b", "\\bdone\\b"],
    color: "#34D399",
    enabled: true,
  },
  {
    id: "info",
    label: "Info",
    patterns: ["\\[info\\]", "\\[notice\\]", "\\[note\\]", "\\bnotice\\b", "\\bnote\\b"],
    color: "#3B82F6",
    enabled: true,
  },
  {
    id: "debug",
    label: "Debug",
    patterns: ["\\[debug\\]", "\\[trace\\]", "\\[verbose\\]", "\\bdebug\\b", "\\btrace\\b", "\\bverbose\\b"],
    color: "#A78BFA",
    enabled: true,
  },
  {
    id: "ip-mac",
    label: "URL, IP & MAC",
    patterns: [URL_HIGHLIGHT_PATTERN, IPV4_HIGHLIGHT_PATTERN, IPV6_HIGHLIGHT_PATTERN, MAC_ADDRESS_HIGHLIGHT_PATTERN],
    color: "#EC4899",
    enabled: true,
  },
  { id: "unix-path", label: "Unix paths", patterns: [UNIX_PATH_HIGHLIGHT_PATTERN], color: "#A78BFA", enabled: true },
];

export const MAX_KEYWORD_HIGHLIGHT_RULES = 30;
const MAX_KEYWORD_PATTERNS_PER_RULE = 16;
const MAX_KEYWORD_PATTERN_LENGTH = 2000;

export function cloneKeywordHighlightRules(rules: KeywordHighlightRule[]): KeywordHighlightRule[] {
  return rules.map((rule) => ({ ...rule, patterns: [...rule.patterns] }));
}

/** 规则清洗：丢弃非法条目、限制数量与长度；全空则回落内置规则（对齐 Netcatty normalize）。 */
export function normalizeKeywordHighlightRules(raw: unknown): KeywordHighlightRule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return cloneKeywordHighlightRules(DEFAULT_KEYWORD_HIGHLIGHT_RULES);
  }
  const out = sanitizeKeywordHighlightRules(raw);
  return out.length > 0 ? out : cloneKeywordHighlightRules(DEFAULT_KEYWORD_HIGHLIGHT_RULES);
}

/**
 * 主机级规则清洗（对齐 Netcatty `Host.keywordHighlightRules`）：
 * 空 / 非法 = 没有主机规则（**不**回落到内置规则）。全局规则仍由
 * `normalizeKeywordHighlightRules` 负责，二者在终端侧按「全局 + 主机追加」合并。
 */
export function normalizeHostKeywordHighlightRules(raw: unknown): KeywordHighlightRule[] {
  if (!Array.isArray(raw)) return [];
  return sanitizeKeywordHighlightRules(raw);
}

function sanitizeKeywordHighlightRules(raw: unknown[]): KeywordHighlightRule[] {
  const out: KeywordHighlightRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rule = item as Record<string, unknown>;
    const id = typeof rule.id === "string" ? rule.id.trim() : "";
    const label = typeof rule.label === "string" ? rule.label.trim() : "";
    const color = typeof rule.color === "string" && /^#[0-9a-fA-F]{6}$/.test(rule.color) ? rule.color.toUpperCase() : "";
    const patterns = Array.isArray(rule.patterns)
      ? rule.patterns
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .slice(0, MAX_KEYWORD_PATTERNS_PER_RULE)
          .map((p) => p.slice(0, MAX_KEYWORD_PATTERN_LENGTH))
      : [];
    if (!id || !label || !color || patterns.length === 0) continue;
    if (out.some((r) => r.id === id)) continue;
    out.push({ id, label, patterns, color, enabled: rule.enabled !== false });
    if (out.length >= MAX_KEYWORD_HIGHLIGHT_RULES) break;
  }
  return out;
}

/** 终端行为设置（字段名对齐 Netcatty domain/models/terminal.ts TerminalSettings）。 */
export interface TerminalSettings {
  scrollback: number;
  terminalEmulationType: string;
  fontLigatures: boolean;
  fontSmoothing: boolean;
  fontWeight: number;
  fontWeightBold: number;
  linePadding: number;
  /** CJK 回退字体（Netcatty TerminalCjkFontSelect；空 = auto）。 */
  fallbackFont: string;
  cursorShape: CursorShape;
  cursorBlink: boolean;
  cursorBarWidth: number;
  highlightCursorLine: boolean;
  /** 关键字高亮总开关（Netcatty keywordHighlightEnabled，默认开）。 */
  keywordHighlightEnabled: boolean;
  /** 关键字高亮规则（设置页与终端工具栏浮层共享同一份，改后已开终端即时生效）。 */
  keywordHighlightRules: KeywordHighlightRule[];
  altAsMeta: boolean;
  /** macOS：Option+←/→ 发送 Meta-b / Meta-f，让 Shell 按单词跳转。 */
  optionArrowWordJump: boolean;
  scrollOnInput: boolean;
  scrollOnOutput: boolean;
  scrollOnKeyPress: boolean;
  scrollOnPaste: boolean;
  smoothScrolling: boolean;
  rightClickBehavior: RightClickBehavior;
  rightClickLongPressMenu: boolean;
  showContextMenuOverFullscreenApps: boolean;
  middleClickBehavior: MiddleClickBehavior;
  copyOnSelect: boolean;
  normalizeTextOnCopy: boolean;
  wordSeparators: string;
  disableBracketedPaste: boolean;
  autoUploadClipboardImageOnPaste: boolean;
  confirmBeforeMultilinePaste: boolean;
  multilinePasteConfirmMinLines: number;
  autoCloseOnExit: boolean;
  disconnectedNoticeMode: DisconnectedNoticeMode;
  shiftEnterNewlineEnabled: boolean;
  shiftEnterNewlineText: string;
  shiftEnterForceText: boolean;
  clearWipesScrollback: boolean;
  preserveSelectionOnInput: boolean;
  forcePromptNewLine: boolean;
  tabDoubleClickBehavior: TabDoubleClickBehavior;
  dynamicTabTitleMode: DynamicTabTitleMode;
  oscNotifications: OscNotificationMode;
  osc52Clipboard: Osc52ClipboardMode;
  linkModifier: LinkModifier;
  linkBrowser: LinkBrowser;
  /** 终端主题跟随应用主题；关闭后终端固定深色（Netcatty settings.terminal.theme.followApp）。 */
  followAppTheme: boolean;
  /** 自动补全总开关（Netcatty autocompleteEnabled，默认开启）。 */
  autocompleteEnabled: boolean;
  /** 输入时显示内联 ghost text 建议（Netcatty autocompleteGhostText，默认关闭）。 */
  autocompleteGhostText: boolean;
  /** 输入时显示候选下拉（Netcatty autocompletePopupMenu，默认开启）。 */
  autocompletePopupMenu: boolean;
  /** 候选历史范围：仅本主机 / 全部主机（Netcatty autocompleteHistoryScope）。 */
  autocompleteHistoryScope: AutocompleteHistoryScope;
  /** 内嵌图片总开关（Netcatty inlineImagesEnabled，默认关闭）。 */
  inlineImagesEnabled: boolean;
  /** Kitty graphics protocol（APC G）；需 inlineImagesEnabled。 */
  inlineImageKittyEnabled: boolean;
  /** SIXEL（DCS q）；需 inlineImagesEnabled。 */
  inlineImageSixelEnabled: boolean;
  /** iTerm 内嵌图片协议（OSC 1337 File=）；需 inlineImagesEnabled。 */
  inlineImageIipEnabled: boolean;
  /** 单终端图片缓存上限（MB）。 */
  inlineImageStorageLimitMb: number;
  /** 单张图解码像素上限（MP）。 */
  inlineImageMaxMegapixels: number;
  /** 单条图片转义序列上限（MB）。 */
  inlineImageSequenceLimitMb: number;
}

export interface NetworkProxySettings {
  mode: ProxyMode;
  url: string;
  bypass: string;
}

export interface SessionLogsSettings {
  /** 旧 Netcatty 自动保存开关；termX 改为「按主机档案」控制，恒为 false。 */
  enabled: boolean;
  format: SessionLogFormat;
  timestamps: boolean;
  /** 自动日志目录；空串 = 默认 `<data_dir>/logs`。 */
  directory: string;
  /**
   * 日志命名模板，支持 `{host}` / `{title}` / `{protocol}` / `{date}`
   * / `{time}` / `{datetime}`；非法字符由后端清洗，重名自动加序号。
   */
  nameTemplate: string;
}

export interface AppSettings {
  language: UiLanguage;
  theme: ThemeMode;
  lightUiThemeId: string;
  darkUiThemeId: string;
  accentMode: AccentMode;
  customAccent: string;
  uiFontFamilyId: string;
  windowOpacity: number;
  windowBackgroundBlur: boolean;
  appIconVariant: AppIconVariant;
  customCSS: string;
  showRecentHosts: boolean;
  /** connect = 单击直接连接（默认）；select = 先选中再连接。 */
  hostClickBehavior: "connect" | "select";
  showOnlyUngroupedHostsInRoot: boolean;
  showSftpTab: boolean;
  showHostTreeSidebar: boolean;
  autoImportSystemKnownHosts: boolean;
  /** 终端主字体；"auto" = 跟随本地默认。 */
  terminalFontFamilyId: string;
  terminalFontSize: number;
  terminal: TerminalSettings;
  hotkeyScheme: HotkeyScheme;
  /** 快捷键自定义覆盖：id → { mac?, pc? }。 */
  customKeyBindings: Record<string, { mac?: string; pc?: string }>;
  disabledKeyBindings: string[];
  disableTerminalFontZoom: boolean;
  shellOnlyTabNumberShortcuts: boolean;
  showTabNumberBadges: boolean;
  sidePanelAutoOpen: boolean;
  sidePanelAutoOpenPane: string;
  localShellSidePanelAutoOpen: boolean;
  localShellSidePanelAutoOpenPane: string;
  verifyHostKeys: boolean;
  networkProxy: NetworkProxySettings;
  sessionLogs: SessionLogsSettings;
  sshDebugLogsEnabled: boolean;
  /** SFTP 双击行为（对照 Netcatty settings.sftp.doubleClickBehavior）。 */
  sftpDoubleClickBehavior: SftpDoubleClickBehavior;
  /** SFTP 默认显示隐藏文件（对照 Netcatty settings.sftp.showHiddenFiles）。 */
  sftpShowHiddenFiles: boolean;
  /** 同一目标同时传输的文件数上限（对照 Netcatty settings.sftp.transferConcurrency）。 */
  sftpTransferConcurrency: number;
  /** SFTP 跟随终端目录（对照 Netcatty settings.sftpFollowTerminalCwd）。 */
  sftpFollowTerminalCwd: boolean;
}

export const SETTINGS_STORAGE_KEY = "settings.center.v1";

/** 终端字号范围（对照 Netcatty infrastructure/config/fonts.ts MIN/MAX_FONT_SIZE）。 */
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 32;
/** 回滚行数：0 = 不限（映射到 50000 行上限），上限 100000（对照 Netcatty resolveXTermScrollback）。 */
export const MAX_TERMINAL_SCROLLBACK = 100000;
export const UNLIMITED_SCROLLBACK_CAP = 50000;

export const DEFAULT_WORD_SEPARATORS = "`~!@#$%^&*()-=+[]{}\\|;:'\",.<>/?";

/** SFTP 传输并发：1–16，默认 6（对照 Netcatty domain/sftpTransferConcurrency.ts）。 */
export const MIN_SFTP_TRANSFER_CONCURRENCY = 1;
export const MAX_SFTP_TRANSFER_CONCURRENCY = 16;
export const DEFAULT_SFTP_TRANSFER_CONCURRENCY = 6;

export function clampSftpTransferConcurrency(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_SFTP_TRANSFER_CONCURRENCY;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SFTP_TRANSFER_CONCURRENCY;
  return Math.min(
    MAX_SFTP_TRANSFER_CONCURRENCY,
    Math.max(MIN_SFTP_TRANSFER_CONCURRENCY, Math.round(n)),
  );
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  scrollback: 3000,
  terminalEmulationType: "xterm-256color",
  fontLigatures: true,
  fontSmoothing: true,
  fontWeight: 400,
  fontWeightBold: 700,
  linePadding: 0,
  fallbackFont: "",
  cursorShape: "block",
  cursorBlink: true,
  cursorBarWidth: 2,
  highlightCursorLine: false,
  keywordHighlightEnabled: true,
  keywordHighlightRules: cloneKeywordHighlightRules(DEFAULT_KEYWORD_HIGHLIGHT_RULES),
  altAsMeta: false,
  optionArrowWordJump: false,
  scrollOnInput: true,
  scrollOnOutput: false,
  scrollOnKeyPress: false,
  scrollOnPaste: true,
  smoothScrolling: false,
  rightClickBehavior: "context-menu",
  rightClickLongPressMenu: false,
  showContextMenuOverFullscreenApps: false,
  middleClickBehavior: "paste",
  copyOnSelect: false,
  normalizeTextOnCopy: true,
  wordSeparators: DEFAULT_WORD_SEPARATORS,
  disableBracketedPaste: false,
  autoUploadClipboardImageOnPaste: false,
  confirmBeforeMultilinePaste: false,
  multilinePasteConfirmMinLines: 2,
  autoCloseOnExit: false,
  disconnectedNoticeMode: "terminal",
  shiftEnterNewlineEnabled: true,
  shiftEnterNewlineText: "\\e\\r",
  shiftEnterForceText: false,
  clearWipesScrollback: true,
  preserveSelectionOnInput: false,
  forcePromptNewLine: false,
  tabDoubleClickBehavior: "duplicate",
  dynamicTabTitleMode: "agent",
  oscNotifications: "always",
  osc52Clipboard: "write-only",
  linkModifier: "none",
  linkBrowser: "netcatty",
  followAppTheme: true,
  // 对齐 Netcatty terminalSettingsDefaults：补全默认开，ghost 默认关、下拉默认开、范围本主机。
  autocompleteEnabled: true,
  autocompleteGhostText: false,
  autocompletePopupMenu: true,
  autocompleteHistoryScope: "host",
  // 对齐 Netcatty：图片默认关闭；开启后三类协议默认全开。
  inlineImagesEnabled: false,
  inlineImageKittyEnabled: true,
  inlineImageSixelEnabled: true,
  inlineImageIipEnabled: true,
  inlineImageStorageLimitMb: INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT,
  inlineImageMaxMegapixels: INLINE_IMAGE_MAX_MEGAPIXELS_DEFAULT,
  inlineImageSequenceLimitMb: INLINE_IMAGE_SEQUENCE_LIMIT_MB_DEFAULT,
};

export const DEFAULT_SETTINGS: AppSettings = {
  language: "zh-CN",
  theme: "system",
  lightUiThemeId: "snow",
  darkUiThemeId: "midnight",
  accentMode: "theme",
  customAccent: "221.2 83.2% 53.3%",
  uiFontFamilyId: "mona-sans",
  windowOpacity: 1,
  windowBackgroundBlur: false,
  appIconVariant: "original",
  customCSS: "",
  showRecentHosts: true,
  hostClickBehavior: "connect",
  showOnlyUngroupedHostsInRoot: false,
  showSftpTab: true,
  showHostTreeSidebar: true,
  autoImportSystemKnownHosts: true,
  terminalFontFamilyId: "auto",
  terminalFontSize: 14,
  terminal: { ...DEFAULT_TERMINAL_SETTINGS },
  hotkeyScheme:
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)
      ? "mac"
      : "pc",
  customKeyBindings: {},
  disabledKeyBindings: [],
  disableTerminalFontZoom: false,
  shellOnlyTabNumberShortcuts: false,
  showTabNumberBadges: true,
  sidePanelAutoOpen: false,
  sidePanelAutoOpenPane: "scripts",
  localShellSidePanelAutoOpen: false,
  localShellSidePanelAutoOpenPane: "files",
  verifyHostKeys: true,
  networkProxy: { mode: "system", url: "", bypass: "" },
  sessionLogs: {
    enabled: false,
    format: "txt",
    timestamps: false,
    directory: "",
    nameTemplate: "{host}_{date}_{time}",
  },
  sshDebugLogsEnabled: false,
  sftpDoubleClickBehavior: "open",
  sftpShowHiddenFiles: false,
  sftpTransferConcurrency: DEFAULT_SFTP_TRANSFER_CONCURRENCY,
  sftpFollowTerminalCwd: false,
};

/** 窗口透明度 clamp 到 [0.5, 1]（对照 Netcatty clampWindowOpacity）。 */
export function clampWindowOpacity(opacity: unknown): number {
  const value = Number(opacity);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.5, value));
}

function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function pickNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function pickStr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function pickOne<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** 终端行数输入 clamp：0 = 不限（运行期映射 50000），上限 100000。 */
export function clampScrollback(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SETTINGS.scrollback;
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(0, Math.round(n)));
}

/** xterm 实际使用的回滚行数（0 → 50000，对照 Netcatty resolveXTermScrollback）。 */
export function resolveXtermScrollback(value: number): number {
  return value === 0 ? UNLIMITED_SCROLLBACK_CAP : value;
}

export function clampCursorBarWidth(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SETTINGS.cursorBarWidth;
  return Math.min(4, Math.max(1, Math.round(n)));
}

export function clampLinePadding(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SETTINGS.linePadding;
  return Math.min(10, Math.max(0, Math.round(n)));
}

/** 旧版右键 / 中键枚举迁移到 Netcatty 现行取值。 */
function migrateRightClick(raw: Record<string, unknown>): RightClickBehavior {
  if (raw.rightClickBehavior === "menu") return "context-menu";
  if (raw.rightClickBehavior === "none") return "context-menu";
  return pickOne(
    raw.rightClickBehavior,
    ["context-menu", "paste", "select-word"] as const,
    DEFAULT_TERMINAL_SETTINGS.rightClickBehavior,
  );
}

function migrateMiddleClick(raw: Record<string, unknown>): MiddleClickBehavior {
  if (raw.middleClickBehavior === "menu") return "context-menu";
  if (raw.middleClickBehavior === "copy") return "paste";
  if (raw.middleClickBehavior === "none") return "disabled";
  return pickOne(
    raw.middleClickBehavior,
    ["context-menu", "paste", "disabled"] as const,
    DEFAULT_TERMINAL_SETTINGS.middleClickBehavior,
  );
}

/** 旧版布尔 disconnectPrompt → 现行 disconnectedNoticeMode。 */
function migrateDisconnectedNotice(raw: Record<string, unknown>): DisconnectedNoticeMode {
  if (raw.disconnectedNoticeMode === "terminal" || raw.disconnectedNoticeMode === "dialog") {
    return raw.disconnectedNoticeMode;
  }
  if (typeof raw.disconnectPrompt === "boolean") {
    return raw.disconnectPrompt ? "dialog" : "terminal";
  }
  return DEFAULT_TERMINAL_SETTINGS.disconnectedNoticeMode;
}

function normalizeTerminal(raw: unknown): TerminalSettings {
  const d = DEFAULT_TERMINAL_SETTINGS;
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    scrollback: clampScrollback(pickNum(r.scrollback, d.scrollback)),
    terminalEmulationType: pickOne(
      r.terminalEmulationType,
      ["xterm-256color", "xterm-16color", "xterm"] as const,
      d.terminalEmulationType,
    ),
    fontLigatures: pickBool(r.fontLigatures, d.fontLigatures),
    fontSmoothing: pickBool(r.fontSmoothing, d.fontSmoothing),
    fontWeight: pickNum(r.fontWeight, d.fontWeight),
    fontWeightBold: pickNum(r.fontWeightBold, d.fontWeightBold),
    linePadding: clampLinePadding(r.linePadding),
    fallbackFont: pickStr(r.fallbackFont, d.fallbackFont),
    cursorShape: pickOne(r.cursorShape, ["block", "bar", "underline"] as const, d.cursorShape),
    cursorBlink: pickBool(r.cursorBlink, d.cursorBlink),
    cursorBarWidth: clampCursorBarWidth(r.cursorBarWidth),
    highlightCursorLine: pickBool(r.highlightCursorLine, d.highlightCursorLine),
    keywordHighlightEnabled: pickBool(r.keywordHighlightEnabled, d.keywordHighlightEnabled),
    keywordHighlightRules: normalizeKeywordHighlightRules(r.keywordHighlightRules),
    altAsMeta: pickBool(r.altAsMeta, d.altAsMeta),
    optionArrowWordJump: pickBool(r.optionArrowWordJump, d.optionArrowWordJump),
    scrollOnInput: pickBool(r.scrollOnInput, d.scrollOnInput),
    scrollOnOutput: pickBool(r.scrollOnOutput, d.scrollOnOutput),
    scrollOnKeyPress: pickBool(r.scrollOnKeyPress, d.scrollOnKeyPress),
    scrollOnPaste: pickBool(r.scrollOnPaste, d.scrollOnPaste),
    smoothScrolling: pickBool(r.smoothScrolling, d.smoothScrolling),
    rightClickBehavior: migrateRightClick(r),
    rightClickLongPressMenu: pickBool(r.rightClickLongPressMenu, d.rightClickLongPressMenu),
    showContextMenuOverFullscreenApps: pickBool(
      r.showContextMenuOverFullscreenApps,
      d.showContextMenuOverFullscreenApps,
    ),
    middleClickBehavior: migrateMiddleClick(r),
    copyOnSelect: pickBool(r.copyOnSelect, d.copyOnSelect),
    normalizeTextOnCopy: pickBool(r.normalizeTextOnCopy, d.normalizeTextOnCopy),
    wordSeparators: pickStr(r.wordSeparators, d.wordSeparators),
    disableBracketedPaste: pickBool(r.disableBracketedPaste, d.disableBracketedPaste),
    autoUploadClipboardImageOnPaste: pickBool(
      r.autoUploadClipboardImageOnPaste,
      d.autoUploadClipboardImageOnPaste,
    ),
    confirmBeforeMultilinePaste: pickBool(
      r.confirmBeforeMultilinePaste,
      d.confirmBeforeMultilinePaste,
    ),
    multilinePasteConfirmMinLines: Math.min(
      1000,
      Math.max(1, Math.round(pickNum(r.multilinePasteConfirmMinLines, d.multilinePasteConfirmMinLines))),
    ),
    autoCloseOnExit: pickBool(r.autoCloseOnExit, d.autoCloseOnExit),
    disconnectedNoticeMode: migrateDisconnectedNotice(r),
    shiftEnterNewlineEnabled: pickBool(r.shiftEnterNewlineEnabled, d.shiftEnterNewlineEnabled),
    shiftEnterNewlineText: pickStr(r.shiftEnterNewlineText, d.shiftEnterNewlineText),
    shiftEnterForceText: pickBool(r.shiftEnterForceText, d.shiftEnterForceText),
    clearWipesScrollback: pickBool(r.clearWipesScrollback, d.clearWipesScrollback),
    preserveSelectionOnInput: pickBool(r.preserveSelectionOnInput, d.preserveSelectionOnInput),
    forcePromptNewLine: pickBool(r.forcePromptNewLine, d.forcePromptNewLine),
    tabDoubleClickBehavior: pickOne(
      r.tabDoubleClickBehavior,
      ["duplicate", "copy", "disabled"] as const,
      d.tabDoubleClickBehavior,
    ),
    dynamicTabTitleMode: pickOne(
      r.dynamicTabTitleMode,
      ["off", "agent", "all"] as const,
      d.dynamicTabTitleMode,
    ),
    oscNotifications: pickOne(
      r.oscNotifications,
      ["always", "unfocused", "off"] as const,
      d.oscNotifications,
    ),
    osc52Clipboard: pickOne(
      r.osc52Clipboard,
      ["off", "write-only", "read-write", "prompt"] as const,
      d.osc52Clipboard,
    ),
    linkModifier: pickOne(
      r.linkModifier,
      ["none", "ctrl", "alt", "meta"] as const,
      d.linkModifier,
    ),
    linkBrowser: pickOne(r.linkBrowser, ["netcatty", "system"] as const, d.linkBrowser),
    followAppTheme: pickBool(r.followAppTheme, d.followAppTheme),
    autocompleteEnabled: pickBool(r.autocompleteEnabled, d.autocompleteEnabled),
    autocompleteGhostText: pickBool(r.autocompleteGhostText, d.autocompleteGhostText),
    autocompletePopupMenu: pickBool(r.autocompletePopupMenu, d.autocompletePopupMenu),
    autocompleteHistoryScope: pickOne(
      r.autocompleteHistoryScope,
      ["host", "global"] as const,
      d.autocompleteHistoryScope,
    ),
    inlineImagesEnabled: pickBool(r.inlineImagesEnabled, d.inlineImagesEnabled),
    inlineImageKittyEnabled: pickBool(r.inlineImageKittyEnabled, d.inlineImageKittyEnabled),
    inlineImageSixelEnabled: pickBool(r.inlineImageSixelEnabled, d.inlineImageSixelEnabled),
    inlineImageIipEnabled: pickBool(r.inlineImageIipEnabled, d.inlineImageIipEnabled),
    inlineImageStorageLimitMb: normalizeInlineImageStorageLimitMb(r.inlineImageStorageLimitMb),
    inlineImageMaxMegapixels: normalizeInlineImageMaxMegapixels(r.inlineImageMaxMegapixels),
    inlineImageSequenceLimitMb: normalizeInlineImageSequenceLimitMb(r.inlineImageSequenceLimitMb),
  };
}

/**
 * 把存储里的 partial JSON 合并进默认值。schema 演进时新字段自动回落默认，
 * 旧数据不炸（对照 Netcatty normalizeTerminalSettings 的意图）。
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  const r = (raw ?? {}) as Record<string, unknown>;
  const proxyRaw = (r.networkProxy ?? {}) as Record<string, unknown>;
  const logsRaw = (r.sessionLogs ?? {}) as Record<string, unknown>;
  let customKeyBindings: AppSettings["customKeyBindings"] = {};
  if (r.customKeyBindings && typeof r.customKeyBindings === "object") {
    for (const [id, v] of Object.entries(r.customKeyBindings as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const entry: { mac?: string; pc?: string } = {};
        if (typeof o.mac === "string") entry.mac = o.mac;
        if (typeof o.pc === "string") entry.pc = o.pc;
        if (entry.mac !== undefined || entry.pc !== undefined) customKeyBindings[id] = entry;
      }
    }
  }
  return {
    language: pickOne(r.language, ["zh-CN", "en"] as const, d.language),
    theme: pickOne(r.theme, ["light", "dark", "system"] as const, d.theme),
    lightUiThemeId: pickStr(r.lightUiThemeId, d.lightUiThemeId),
    darkUiThemeId: pickStr(r.darkUiThemeId, d.darkUiThemeId),
    accentMode: pickOne(r.accentMode, ["theme", "custom"] as const, d.accentMode),
    customAccent: pickStr(r.customAccent, d.customAccent),
    uiFontFamilyId: pickStr(r.uiFontFamilyId, d.uiFontFamilyId),
    windowOpacity: clampWindowOpacity(r.windowOpacity),
    windowBackgroundBlur: pickBool(r.windowBackgroundBlur, d.windowBackgroundBlur),
    appIconVariant: pickOne(r.appIconVariant, APP_ICON_VARIANTS, d.appIconVariant),
    customCSS: pickStr(r.customCSS, d.customCSS),
    showRecentHosts: pickBool(r.showRecentHosts, d.showRecentHosts),
    hostClickBehavior: pickOne(r.hostClickBehavior, ["connect", "select"] as const, d.hostClickBehavior),
    showOnlyUngroupedHostsInRoot: pickBool(r.showOnlyUngroupedHostsInRoot, d.showOnlyUngroupedHostsInRoot),
    showSftpTab: pickBool(r.showSftpTab, d.showSftpTab),
    showHostTreeSidebar: pickBool(r.showHostTreeSidebar, d.showHostTreeSidebar),
    autoImportSystemKnownHosts: pickBool(r.autoImportSystemKnownHosts, d.autoImportSystemKnownHosts),
    terminalFontFamilyId: pickStr(r.terminalFontFamilyId, d.terminalFontFamilyId),
    terminalFontSize: Math.min(
      MAX_TERMINAL_FONT_SIZE,
      Math.max(MIN_TERMINAL_FONT_SIZE, pickNum(r.terminalFontSize, d.terminalFontSize)),
    ),
    terminal: normalizeTerminal(r.terminal),
    hotkeyScheme: pickOne(r.hotkeyScheme, ["mac", "pc"] as const, d.hotkeyScheme),
    customKeyBindings,
    disabledKeyBindings: Array.isArray(r.disabledKeyBindings)
      ? (r.disabledKeyBindings as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    disableTerminalFontZoom: pickBool(r.disableTerminalFontZoom, d.disableTerminalFontZoom),
    shellOnlyTabNumberShortcuts: pickBool(r.shellOnlyTabNumberShortcuts, d.shellOnlyTabNumberShortcuts),
    showTabNumberBadges: pickBool(r.showTabNumberBadges, d.showTabNumberBadges),
    sidePanelAutoOpen: pickBool(r.sidePanelAutoOpen, d.sidePanelAutoOpen),
    sidePanelAutoOpenPane: pickStr(r.sidePanelAutoOpenPane, d.sidePanelAutoOpenPane),
    localShellSidePanelAutoOpen: pickBool(r.localShellSidePanelAutoOpen, d.localShellSidePanelAutoOpen),
    localShellSidePanelAutoOpenPane: pickStr(r.localShellSidePanelAutoOpenPane, d.localShellSidePanelAutoOpenPane),
    verifyHostKeys: pickBool(r.verifyHostKeys, d.verifyHostKeys),
    networkProxy: {
      mode: pickOne(proxyRaw.mode, ["system", "direct", "custom"] as const, d.networkProxy.mode),
      url: pickStr(proxyRaw.url, ""),
      bypass: pickStr(proxyRaw.bypass, ""),
    },
    sessionLogs: {
      enabled: pickBool(logsRaw.enabled, d.sessionLogs.enabled),
      format: pickOne(logsRaw.format, ["txt", "raw", "html"] as const, d.sessionLogs.format),
      timestamps: pickBool(logsRaw.timestamps, d.sessionLogs.timestamps),
      directory: pickStr(logsRaw.directory, d.sessionLogs.directory),
      nameTemplate: pickStr(logsRaw.nameTemplate, d.sessionLogs.nameTemplate),
    },
    sshDebugLogsEnabled: pickBool(r.sshDebugLogsEnabled, d.sshDebugLogsEnabled),
    sftpDoubleClickBehavior: pickOne(
      r.sftpDoubleClickBehavior,
      ["open", "transfer"] as const,
      d.sftpDoubleClickBehavior,
    ),
    sftpShowHiddenFiles: pickBool(r.sftpShowHiddenFiles, d.sftpShowHiddenFiles),
    sftpTransferConcurrency: clampSftpTransferConcurrency(r.sftpTransferConcurrency),
    sftpFollowTerminalCwd: pickBool(r.sftpFollowTerminalCwd, d.sftpFollowTerminalCwd),
  };
}
