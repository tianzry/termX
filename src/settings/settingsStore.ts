/**
 * 设置中心运行态 store（模块级 + useSyncExternalStore）。
 *
 * 持久化：整个设置对象 JSON 存 db settings 表 key `settings.center.v1`。
 * 副作用（theme / 透明度 / UI 字体 / 自定义 CSS / 强调色）在
 * applySideEffects 里集中应用；终端选项由 Terminal.tsx 订阅转换。
 */

import { useSyncExternalStore } from "react";
import {
  getSetting,
  setAppIconVariant,
  setSetting,
  setWindowBackgroundBlur,
  setWindowOpacity,
  sftpTransferSetConcurrency,
} from "../backend/client";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  clampWindowOpacity,
  normalizeSettings,
} from "./settingsModel";
import { UI_FONTS } from "./uiFonts";
import { getUiThemeById } from "./uiThemes";

type Listener = () => void;

let current: AppSettings = DEFAULT_SETTINGS;
const listeners = new Set<Listener>();

export function getSettings(): AppSettings {
  return current;
}

export function subscribeSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

/** React hook：订阅设置对象。 */
export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}

let loadStarted = false;

/** 启动时从后端加载设置（幂等；损坏数据回落默认值）。 */
export async function loadSettings(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const raw = await getSetting(SETTINGS_STORAGE_KEY);
    let parsed: Record<string, unknown> | null = raw ? JSON.parse(raw) : null;
    // 旧版并发数存在独立 key（SFTP 队列面板写入），首次升级时迁移，避免被默认 6 覆盖。
    if (!parsed || parsed.sftpTransferConcurrency === undefined) {
      const legacy = await getSetting("sftp_transfer_concurrency");
      if (legacy) {
        parsed = { ...(parsed ?? {}), sftpTransferConcurrency: Number(legacy) };
      }
    }
    if (parsed) current = normalizeSettings(parsed);
  } catch {
    current = DEFAULT_SETTINGS;
  }
  applySideEffects(current);
  emit();
}

/** 更新设置（partial patch），立即应用副作用并异步持久化。 */
export function updateSettings(patch: Partial<AppSettings>): void {
  current = normalizeSettings({ ...current, ...patch });
  applySideEffects(current);
  emit();
  void persist(current);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist: AppSettings | null = null;

/** 持久化去抖 200ms：滑杆/取色器连续拖动时只写最后一次，避免 IPC 风暴。 */
function persist(s: AppSettings): void {
  pendingPersist = s;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = pendingPersist;
    pendingPersist = null;
    if (!snapshot) return;
    setSetting(SETTINGS_STORAGE_KEY, JSON.stringify(snapshot)).catch(() => {
      // 持久化失败不回滚 UI；下次启动回落默认值（与 Netcatty 本地优先一致）。
    });
  }, 200);
}

// ── 副作用应用 ────────────────────────────────────────────

let customCssEl: HTMLStyleElement | null = null;
let mediaQueryBound = false;

function resolvedTheme(s: AppSettings): "light" | "dark" {
  if (s.theme !== "system") return s.theme;
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 供 Terminal.tsx 取当前生效的明暗（终端配色跟随）。 */
export function resolvedThemeMode(s: AppSettings): "light" | "dark" {
  return resolvedTheme(s);
}

/** hex (#rrggbb) → HSL 分量三元组（"h s% l%"，供 hsl(var(--primary)) 消费）。 */
export function hexToHslTriplet(hex: string): string | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const rd = (x: number) => Math.round(x * 10) / 10;
  return `${rd(h)} ${rd(sat * 100)}% ${rd(l * 100)}%`;
}

/** 自定义强调色（hex 或 Netcatty 风格 HSL 三元组）→ 统一三元组；非法返回 null。 */
export function accentToHslTriplet(v: string): string | null {
  const t = v.trim();
  if (t.startsWith("#")) return hexToHslTriplet(t);
  return /^\d+(\.\d+)?(\s+\d+(\.\d+)?%){2}$/.test(t) ? t : null;
}

// ── 主题令牌应用（对照 Netcatty settingsStateDefaults.buildAppThemeCssVars）──

const CJK_FALLBACK_FONTS = [
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  "sans-serif",
];

/** Windows 上系统字体缺少国旗 emoji 字形，需前置 emoji 字体（对照 withWindowsEmojiFallback）。 */
function withWindowsEmojiFallback(family: string): string {
  const isWindows = typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent);
  if (!isWindows) return family;
  if (family.includes("Segoe UI Emoji")) return family;
  return `"Segoe UI Emoji", ${family}, "Segoe UI Symbol"`;
}

/** UI 字体 id → 完整回退链（system / local-<family>，对照 Netcatty uiFontStore + withUiCjkFallback）。 */
export function uiFontCss(id: string): string {
  const preset = UI_FONTS.find((f) => f.id === id);
  if (preset) return withWindowsEmojiFallback(preset.family);
  const family =
    !id || id === "system"
      ? 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Mona Sans"'
      : id.startsWith("local-")
        ? `"${id.slice(6)}"`
        : `"${id}"`;
  // 已带 CJK 回退链的 family 不再重复追加。
  return withWindowsEmojiFallback(
    CJK_FALLBACK_FONTS.some((f) => family.includes(f.replace(/"/g, "")))
      ? family
      : `${family}, ${CJK_FALLBACK_FONTS.join(", ")}`,
  );
}

function parseHslTriplet(value: string): { h: number; s: number; l: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/.exec(value);
  if (!m) return null;
  const [h, s, l] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![h, s, l].every(Number.isFinite)) return null;
  return { h: ((h % 360) + 360) % 360, s: Math.min(100, Math.max(0, s)) / 100, l: Math.min(100, Math.max(0, l)) / 100 };
}

/** 相对亮度（WCAG），用于强调色前景自动取黑/白。 */
function relativeLuminance(triplet: string): number | null {
  const p = parseHslTriplet(triplet);
  if (!p) return null;
  let r: number;
  let g: number;
  let b: number;
  if (p.s === 0) {
    r = g = b = p.l;
  } else {
    const c = (1 - Math.abs(2 * p.l - 1)) * p.s;
    const hp = p.h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    [r, g, b] =
      hp < 1 ? [c, x, 0] :
      hp < 2 ? [x, c, 0] :
      hp < 3 ? [0, c, x] :
      hp < 4 ? [0, x, c] :
      hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = p.l - c / 2;
    r += m;
    g += m;
    b += m;
  }
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 对照 Netcatty resolveReadableForegroundForHsl：按对比度返回黑或白。 */
export function readableForeground(hsl: string, fallback = "0 0% 100%"): string {
  const lum = relativeLuminance(hsl);
  if (lum == null) return fallback;
  // WCAG 对比度：黑字 = (L+0.05)/0.05，白字 = 1.05/(L+0.05)，取对比度更大者。
  const black = (lum + 0.05) / 0.05;
  const white = 1.05 / (lum + 0.05);
  return white >= black ? "0 0% 100%" : "0 0% 0%";
}

const THEME_VARS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
] as const;

function applyThemeTokens(s: AppSettings, mode: "light" | "dark"): void {
  const preset = getUiThemeById(mode, mode === "dark" ? s.darkUiThemeId : s.lightUiThemeId);
  const t = preset.tokens;
  const accent =
    s.accentMode === "custom" ? accentToHslTriplet(s.customAccent) ?? t.accent : t.accent;
  const accentFg = readableForeground(accent, t.primaryForeground);
  const values: Record<(typeof THEME_VARS)[number], string> = {
    background: t.background,
    foreground: t.foreground,
    card: t.card,
    "card-foreground": t.cardForeground,
    popover: t.popover,
    "popover-foreground": t.popoverForeground,
    primary: accent,
    "primary-foreground": accentFg,
    secondary: t.secondary,
    "secondary-foreground": t.secondaryForeground,
    muted: t.muted,
    "muted-foreground": t.mutedForeground,
    accent: accent,
    "accent-foreground": accentFg,
    destructive: t.destructive,
    "destructive-foreground": t.destructiveForeground,
    border: t.border,
    input: t.input,
    ring: accent,
  };
  const root = document.documentElement;
  for (const key of THEME_VARS) root.style.setProperty(`--${key}`, values[key]);
}

/** 上次下发的 SFTP 并发（哨兵 -1 = 未下发）；相同则跳过。 */
let sftpConcurrencyApplied = -1;

/** SFTP 设置即时生效：并发上限同步到后端传输中心（后端会把值持久化到 db）。 */
function applySftpSettings(s: AppSettings): void {
  if (sftpConcurrencyApplied === s.sftpTransferConcurrency) return;
  const target = s.sftpTransferConcurrency;
  sftpConcurrencyApplied = target;
  void sftpTransferSetConcurrency(target).catch(() => {
    // 无传输中心（单测 / headless）时保持哨兵可重试。
    if (sftpConcurrencyApplied === target) sftpConcurrencyApplied = -1;
  });
}

export function applySideEffects(s: AppSettings): void {
  applySftpSettings(s);
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // 主题（data-theme + .dark/.light class + 全量调色令牌）
  const mode = resolvedTheme(s);
  root.dataset.theme = mode;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
  applyThemeTokens(s, mode);
  if (s.theme === "system" && !mediaQueryBound && window.matchMedia) {
    mediaQueryBound = true;
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        applySideEffects(getSettings());
        emit();
      });
  }

  // 窗口透明度：原生窗口（Windows 分层窗口 alpha，等效 Electron setOpacity）。
  void applyNativeWindowChrome(s);

  // UI 字体
  root.style.setProperty("--termx-ui-font", uiFontCss(s.uiFontFamilyId));

  // 自定义 CSS（即时注入，对照 Netcatty applyCustomCssToDocument）
  if (!customCssEl) {
    customCssEl = document.createElement("style");
    customCssEl.id = "termx-custom-css";
    document.head.appendChild(customCssEl);
  }
  customCssEl.textContent = s.customCSS;
}

// ── 原生窗口外观（透明度 / 背景模糊 / 应用图标）────────────

/** blur 用 null 表示「尚未下发过」，避免 false 默认值被误当成已应用。 */
interface NativeChrome {
  opacity: number;
  blur: boolean | null;
  icon: string;
}

/** 最近一次成功下发的值（哨兵 = 全部未下发）；相同则跳过，避免重复 IPC。 */
let nativeApplied: NativeChrome = { opacity: -1, blur: null, icon: "" };
/** 最新期望值；连续变更时由串行 drain 只下发最终态。 */
let nativeDesired: NativeChrome | null = null;
let nativeDrain: Promise<void> | null = null;

function sameNativeChrome(a: NativeChrome | null, b: NativeChrome | null): boolean {
  return (
    !!a &&
    !!b &&
    a.opacity === b.opacity &&
    a.blur === b.blur &&
    a.icon === b.icon
  );
}

function applyNativeWindowChrome(s: AppSettings): void {
  nativeDesired = {
    opacity: clampWindowOpacity(s.windowOpacity),
    blur: Boolean(s.windowBackgroundBlur),
    icon: s.appIconVariant,
  };
  if (nativeDrain || sameNativeChrome(nativeApplied, nativeDesired)) return;
  startNativeDrain();
}

function startNativeDrain(): void {
  nativeDrain = drainNativeChrome().then(
    (ok) => {
      nativeDrain = null;
      // drain 期间又有新期望值（且本次未失败）→ 继续下发最终态。
      if (ok && nativeDesired && !sameNativeChrome(nativeApplied, nativeDesired)) {
        startNativeDrain();
      }
    },
    () => {
      nativeDrain = null;
    },
  );
}

/** 串行下发：只发与已应用值不同的项，成功后更新基准。返回 false 表示失败。 */
async function drainNativeChrome(): Promise<boolean> {
  while (!sameNativeChrome(nativeApplied, nativeDesired)) {
    const target = nativeDesired!;
    try {
      if (nativeApplied.opacity !== target.opacity) {
        await setWindowOpacity(target.opacity);
        nativeApplied = { ...nativeApplied, opacity: target.opacity };
      }
      if (nativeApplied.blur !== target.blur) {
        await setWindowBackgroundBlur(Boolean(target.blur));
        nativeApplied = { ...nativeApplied, blur: target.blur };
      }
      if (nativeApplied.icon !== target.icon) {
        await setAppIconVariant(target.icon);
        nativeApplied = { ...nativeApplied, icon: target.icon };
      }
    } catch {
      // 无窗口环境（headless server / 单测）或旧二进制：停止本次 drain，等下次变更重试。
      return false;
    }
  }
  return true;
}
