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
export type TabDoubleClickBehavior = "duplicate" | "copy" | "disabled";
export type DynamicTabTitleMode = "off" | "agent" | "all";
export type OscNotificationMode = "always" | "unfocused" | "off";
export type Osc52ClipboardMode = "off" | "write-only" | "read-write" | "prompt";
export type LinkModifier = "none" | "ctrl" | "alt" | "meta";
export type LinkBrowser = "netcatty" | "system";
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

/** 终端字号范围（对照 Netcatty infrastructure/config/fonts.ts MIN/MAX_FONT_SIZE）。 */
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 32;
/** 回滚行数：0 = 不限（映射到 50000 行上限），上限 100000（对照 Netcatty resolveXTermScrollback）。 */
export const MAX_TERMINAL_SCROLLBACK = 100000;
export const UNLIMITED_SCROLLBACK_CAP = 50000;

export const DEFAULT_WORD_SEPARATORS = "`~!@#$%^&*()-=+[]{}\\|;:'\",.<>/?";

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
  altAsMeta: false,
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
    altAsMeta: pickBool(r.altAsMeta, d.altAsMeta),
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
    },
    sshDebugLogsEnabled: pickBool(r.sshDebugLogsEnabled, d.sshDebugLogsEnabled),
  };
}
