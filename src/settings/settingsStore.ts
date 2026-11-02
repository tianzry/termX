/**
 * 设置中心运行态 store（模块级 + useSyncExternalStore）。
 *
 * 持久化：整个设置对象 JSON 存 db settings 表 key `settings.center.v1`。
 * 副作用（theme / 透明度 / UI 字体 / 自定义 CSS / 强调色）在
 * applySideEffects 里集中应用；终端选项由 Terminal.tsx 订阅转换。
 */

import { useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../backend/client";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  clampWindowOpacity,
  normalizeSettings,
} from "./settingsModel";

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
    if (raw) current = normalizeSettings(JSON.parse(raw));
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

async function persist(s: AppSettings): Promise<void> {
  try {
    await setSetting(SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 持久化失败不回滚 UI；下次启动回落默认值（与 Netcatty 本地优先一致）。
  }
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

function uiFontCss(id: string): string {
  if (!id || id === "system") {
    return "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  }
  if (id.startsWith("local-")) return `'${id.slice(6)}', system-ui, sans-serif`;
  return `'${id}', system-ui, sans-serif`;
}

export function applySideEffects(s: AppSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // 主题（data-theme + .dark/.light class，对照 Netcatty applyThemeMode）
  const mode = resolvedTheme(s);
  root.dataset.theme = mode;
  root.classList.toggle("dark", mode === "dark");
  root.classList.toggle("light", mode === "light");
  if (s.theme === "system" && !mediaQueryBound && window.matchMedia) {
    mediaQueryBound = true;
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => applySideEffects(getSettings()));
  }

  // 窗口透明度（CSS 变量，.nc-shell 消费；原生窗口透明未移植，见 changelogs）
  root.style.setProperty("--termx-window-opacity", String(clampWindowOpacity(s.windowOpacity)));

  // UI 字体
  root.style.setProperty("--termx-ui-font", uiFontCss(s.uiFontFamilyId));

  // 强调色：覆写 --primary/--accent（HSL 三元组，全站 hsl(var(--primary)) 消费）；
  // 移除内联覆写即回落到主题自带值。
  const accentTriplet =
    s.accentMode === "custom" && s.customAccent ? accentToHslTriplet(s.customAccent) : null;
  if (accentTriplet) {
    root.style.setProperty("--primary", accentTriplet);
    root.style.setProperty("--accent", accentTriplet);
  } else {
    root.style.removeProperty("--primary");
    root.style.removeProperty("--accent");
  }

  // 自定义 CSS
  if (!customCssEl) {
    customCssEl = document.createElement("style");
    customCssEl.id = "termx-custom-css";
    document.head.appendChild(customCssEl);
  }
  customCssEl.textContent = s.customCSS;
}
