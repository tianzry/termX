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
export type RightClickBehavior = "paste" | "menu" | "none";
export type MiddleClickBehavior = "paste" | "copy" | "none";
export type ProxyMode = "system" | "direct" | "custom";
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
  altAsMeta: boolean;
  scrollOnInput: boolean;
  scrollOnOutput: boolean;
  rightClickBehavior: RightClickBehavior;
  middleClickBehavior: MiddleClickBehavior;
  copyOnSelect: boolean;
  wordSeparators: string;
  autoCloseOnExit: boolean;
  disconnectPrompt: boolean;
  shiftEnterNewlineEnabled: boolean;
  shiftEnterNewlineText: string;
  /** 终端主题跟随应用主题；关闭后终端固定深色（Netcatty settings.terminal.theme.followApp）。 */
  followAppTheme: boolean;
}

export interface NetworkProxySettings {
  mode: ProxyMode;
  url: string;
  bypass: string;
}

export interface SessionLogsSettings {
  enabled: boolean;
  format: SessionLogFormat;
  timestamps: boolean;
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
}

export const SETTINGS_STORAGE_KEY = "settings.center.v1";

export const DEFAULT_WORD_SEPARATORS = "`~!@#$%^&*()-=+[]{}\\|;:'\",.<>/?";

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  scrollback: 10000,
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
  altAsMeta: false,
  scrollOnInput: true,
  scrollOnOutput: true,
  rightClickBehavior: "paste",
  middleClickBehavior: "paste",
  copyOnSelect: false,
  wordSeparators: DEFAULT_WORD_SEPARATORS,
  autoCloseOnExit: false,
  disconnectPrompt: true,
  shiftEnterNewlineEnabled: false,
  shiftEnterNewlineText: "\\x1b\\r",
  followAppTheme: true,
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
  sidePanelAutoOpenPane: "sftp",
  localShellSidePanelAutoOpen: false,
  localShellSidePanelAutoOpenPane: "files",
  verifyHostKeys: true,
  networkProxy: { mode: "system", url: "", bypass: "" },
  sessionLogs: { enabled: false, format: "txt", timestamps: false },
  sshDebugLogsEnabled: false,
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

function normalizeTerminal(raw: unknown): TerminalSettings {
  const d = DEFAULT_TERMINAL_SETTINGS;
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    scrollback: pickNum(r.scrollback, d.scrollback),
    terminalEmulationType: pickStr(r.terminalEmulationType, d.terminalEmulationType),
    fontLigatures: pickBool(r.fontLigatures, d.fontLigatures),
    fontSmoothing: pickBool(r.fontSmoothing, d.fontSmoothing),
    fontWeight: pickNum(r.fontWeight, d.fontWeight),
    fontWeightBold: pickNum(r.fontWeightBold, d.fontWeightBold),
    linePadding: pickNum(r.linePadding, d.linePadding),
    fallbackFont: pickStr(r.fallbackFont, d.fallbackFont),
    cursorShape: pickOne(r.cursorShape, ["block", "bar", "underline"] as const, d.cursorShape),
    cursorBlink: pickBool(r.cursorBlink, d.cursorBlink),
    cursorBarWidth: pickNum(r.cursorBarWidth, d.cursorBarWidth),
    highlightCursorLine: pickBool(r.highlightCursorLine, d.highlightCursorLine),
    altAsMeta: pickBool(r.altAsMeta, d.altAsMeta),
    scrollOnInput: pickBool(r.scrollOnInput, d.scrollOnInput),
    scrollOnOutput: pickBool(r.scrollOnOutput, d.scrollOnOutput),
    rightClickBehavior: pickOne(r.rightClickBehavior, ["paste", "menu", "none"] as const, d.rightClickBehavior),
    middleClickBehavior: pickOne(r.middleClickBehavior, ["paste", "copy", "none"] as const, d.middleClickBehavior),
    copyOnSelect: pickBool(r.copyOnSelect, d.copyOnSelect),
    wordSeparators: pickStr(r.wordSeparators, d.wordSeparators),
    autoCloseOnExit: pickBool(r.autoCloseOnExit, d.autoCloseOnExit),
    disconnectPrompt: pickBool(r.disconnectPrompt, d.disconnectPrompt),
    shiftEnterNewlineEnabled: pickBool(r.shiftEnterNewlineEnabled, d.shiftEnterNewlineEnabled),
    shiftEnterNewlineText: pickStr(r.shiftEnterNewlineText, d.shiftEnterNewlineText),
    followAppTheme: pickBool(r.followAppTheme, d.followAppTheme),
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
    terminalFontSize: Math.min(32, Math.max(8, pickNum(r.terminalFontSize, d.terminalFontSize))),
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
    },
    sshDebugLogsEnabled: pickBool(r.sshDebugLogsEnabled, d.sshDebugLogsEnabled),
  };
}
