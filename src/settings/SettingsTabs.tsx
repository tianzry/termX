/**
 * 设置中心各 tab 组件（应用 / 外观 / 终端 / 快捷键 / 系统 + 占位）。
 *
 * 分区顺序、字段、默认值对照 Netcatty Settings*Tab.tsx 与 zh-CN 文案；
 * 未移植能力的控件保留但禁用 / 标注（范围决策见 changelogs 2026-11-03）。
 */

import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import {
  appVersion,
  checkUpdate,
  getAutoLaunch,
  listFonts,
  secretBackend,
  setAutoLaunch,
  setSetting,
  storageInfo,
  type FontInfo,
  type StorageInfo,
  type UpdateCheckResult,
} from "../backend/client";
import { Icon, type IconName } from "../ui/icons";
import {
  HighlightColorField,
  HighlightColorPicker,
} from "../terminal/HighlightColorPicker";
import { decodeAppError, userVisibleError } from "../domain/sshErrors";
import {
  disableAppLock,
  lockNow,
  setAppLockEnabled,
  setAppLockPassword,
  setAppLockTimeout,
  useAppLock,
} from "../appLock/appLockState";
import { settingsT } from "./i18n";
import {
  BINDING_CATEGORY_ORDER,
  DEFAULT_KEY_BINDINGS,
  captureBinding,
  effectiveBinding,
  type KeyBinding,
} from "./keyBindings";
import { beginHotkeyCapture, endHotkeyCapture } from "./hotkeyRuntime";
import type { AppIconVariant } from "./settingsModel";
import {
  DEFAULT_KEYWORD_HIGHLIGHT_RULES,
  MAX_KEYWORD_HIGHLIGHT_RULES,
  MAX_SFTP_TRANSFER_CONCURRENCY,
  MAX_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_SCROLLBACK,
  MIN_SFTP_TRANSFER_CONCURRENCY,
  MIN_TERMINAL_FONT_SIZE,
  clampCursorBarWidth,
  clampScrollback,
  type KeywordHighlightRule,
} from "./settingsModel";
import { resolvedThemeMode, updateSettings, useSettings } from "./settingsStore";
import {
  INLINE_IMAGE_MAX_MEGAPIXELS_MAX,
  INLINE_IMAGE_MAX_MEGAPIXELS_MIN,
  INLINE_IMAGE_SEQUENCE_LIMIT_MB_MAX,
  INLINE_IMAGE_SEQUENCE_LIMIT_MB_MIN,
  INLINE_IMAGE_STORAGE_LIMIT_MB_MAX,
  INLINE_IMAGE_STORAGE_LIMIT_MB_MIN,
} from "../terminal/inlineImages";
import { UI_FONTS } from "./uiFonts";
import { DARK_UI_THEMES, LIGHT_UI_THEMES } from "./uiThemes";

type TFn = (k: string, p?: Record<string, string | number>) => string;

/** Option+方向键仅在 macOS 生效（与 Terminal.tsx 的 IS_MAC_PLATFORM 门控一致）。 */
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);

/** 强调色色板（逐个对齐 Netcatty SettingsAppearanceTab ACCENT_COLORS）。 */
const ACCENT_COLORS = [
  { name: "Sky", value: "199 89% 48%" },
  { name: "Blue", value: "221.2 83.2% 53.3%" },
  { name: "Indigo", value: "234 89% 62%" },
  { name: "Violet", value: "262.1 83.3% 57.8%" },
  { name: "Purple", value: "271 81% 56%" },
  { name: "Fuchsia", value: "292 84% 61%" },
  { name: "Pink", value: "330 81% 60%" },
  { name: "Rose", value: "346.8 77.2% 49.8%" },
  { name: "Red", value: "0 84.2% 60.2%" },
  { name: "Orange", value: "24.6 95% 53.1%" },
  { name: "Amber", value: "38 92% 50%" },
  { name: "Yellow", value: "48 96% 53%" },
  { name: "Lime", value: "84 81% 44%" },
  { name: "Green", value: "142.1 76.2% 36.3%" },
  { name: "Emerald", value: "160 84% 39%" },
  { name: "Teal", value: "173 80% 40%" },
  { name: "Cyan", value: "189 94% 43%" },
  { name: "Slate", value: "215 16% 47%" },
];

/** 应用图标变体（对照 Netcatty appIconVariants.ts 资源路径与分组）。 */
const APP_ICON_VARIANT_ASSET_PATH: Record<string, string> = {
  original: "/icons/variants/original.png",
  bright: "/icons/variants/bright.png",
  dark: "/icons/variants/dark.png",
  colorful: "/icons/variants/colorful.png",
  "high-contrast": "/icons/variants/high-contrast.png",
  "white-navy": "/icons/variants/white-navy.png",
  "white-sky": "/icons/variants/white-sky.png",
  "white-rose": "/icons/variants/white-rose.png",
  "white-emerald": "/icons/variants/white-emerald.png",
  "white-amber": "/icons/variants/white-amber.png",
  "white-violet": "/icons/variants/white-violet.png",
  rainbow: "/icons/variants/rainbow.png",
};

const APP_ICON_VARIANT_I18N_KEY: Record<string, string> = {
  original: "settings.appearance.icon.appIconVariant.original",
  bright: "settings.appearance.icon.appIconVariant.bright",
  dark: "settings.appearance.icon.appIconVariant.dark",
  colorful: "settings.appearance.icon.appIconVariant.colorful",
  "high-contrast": "settings.appearance.icon.appIconVariant.highContrast",
  "white-navy": "settings.appearance.icon.whiteNavy",
  "white-sky": "settings.appearance.icon.whiteSky",
  "white-rose": "settings.appearance.icon.whiteRose",
  "white-emerald": "settings.appearance.icon.whiteEmerald",
  "white-amber": "settings.appearance.icon.whiteAmber",
  "white-violet": "settings.appearance.icon.whiteViolet",
  rainbow: "settings.appearance.icon.rainbow",
};

const APP_ICON_VARIANT_GROUPS: Array<{
  id: string;
  labelKey: string;
  variants: AppIconVariant[];
}> = [
  {
    id: "classic",
    labelKey: "settings.appearance.icon.group.classic",
    variants: ["original", "bright", "dark", "colorful", "high-contrast"],
  },
  {
    id: "white",
    labelKey: "settings.appearance.icon.group.white",
    variants: ["white-navy", "white-sky", "white-rose", "white-emerald", "white-amber", "white-violet"],
  },
  { id: "special", labelKey: "settings.appearance.icon.group.special", variants: ["rainbow"] },
];

/**
 * 搜索型字体下拉（对照 Netcatty FontSelect + Combobox）：
 * 触发器显示当前字体，弹层内含搜索框与过滤列表。
 */
function FontCombo({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const previewFamily = value.startsWith("local-") ? `"${value.slice(6)}"` : undefined;

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // 点击外部 / Esc 关闭（对照 Netcatty Combobox Popover 行为）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="nc-set-combo" ref={rootRef}>
      <button
        type="button"
        className="nc-set-combo-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.label ?? value}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={previewFamily ? { fontFamily: previewFamily } : undefined}>
          {current?.label ?? value}
        </span>
        <Icon name="chevron-down" />
      </button>
      {open && (
        <div className="nc-set-combo-pop" role="listbox">
          <div className="nc-set-combo-search">
            <Icon name="search" />
            <input
              autoFocus
              value={query}
              placeholder={t("settings.appearance.fonts.searchPlaceholder")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
            />
          </div>
          <div className="nc-set-combo-list">
            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={"nc-set-combo-item" + (o.value === value ? " is-active" : "")}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span
                  style={
                    o.value.startsWith("local-") ? { fontFamily: `"${o.value.slice(6)}"` } : undefined
                  }
                >
                  {o.label}
                </span>
                {o.value === value && <Icon name="check" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="nc-set-combo-empty">{t("settings.appearance.fonts.noMatch")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function useT(): TFn {
  const s = useSettings();
  return (k, p) => settingsT(s.language, k, p);
}

// ── 共享控件 ──────────────────────────────────────────────

/**
 * 分区：标题（Netcatty SectionHeader, text-sm font-semibold）+ 卡片
 * （SettingCard, rounded-lg border bg-card px-4），提示放在卡片外。
 */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="nc-set-section">
      <h3 className="nc-set-section-title">{title}</h3>
      <div className="nc-set-card">{children}</div>
      {hint && <p className="nc-set-hint">{hint}</p>}
    </section>
  );
}

function Row({
  title,
  desc,
  className,
  children,
}: {
  title: string;
  desc?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={"nc-set-row" + (className ? ` ${className}` : "")}>
      <div className="nc-set-row-text">
        <div className="nc-set-row-title">{title}</div>
        {desc && <div className="nc-set-row-desc">{desc}</div>}
      </div>
      {children && <div className="nc-set-row-control">{children}</div>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={"nc-set-toggle" + (checked ? " is-on" : "")}
      onClick={() => onChange(!checked)}
    >
      <span className="nc-set-toggle-knob" />
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      className="nc-set-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Stepper({
  value,
  onChange,
  min,
  max,
  suffix,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <div className="nc-set-stepper" aria-disabled={disabled}>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={disabled || value <= min}
      >
        −
      </button>
      <span>
        {value}
        {suffix}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={disabled || value >= max}
      >
        ＋
      </button>
    </div>
  );
}

/** 系统字体列表（后端 list_fonts，fontdb）。失败返回空列表。 */
function useFontList(): FontInfo[] {
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  useEffect(() => {
    let alive = true;
    listFonts()
      .then((fs) => {
        if (alive) setFonts(fs);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return fonts;
}

// ── 应用 ──────────────────────────────────────────────────

const APP_LINKS: Array<{ key: string; url: string }> = [
  { key: "reportProblem", url: "https://github.com/tianzry/termX/issues/new" },
  { key: "community", url: "https://github.com/tianzry/termX/discussions" },
  { key: "github", url: "https://github.com/tianzry/termX" },
  { key: "whatsNew", url: "https://github.com/tianzry/termX/releases" },
];

export function ApplicationTab() {
  const t = useT();
  const [version, setVersion] = useState("—");
  const [copied, setCopied] = useState<string | null>(null);
  const [checkState, setCheckState] = useState<{
    status: "idle" | "checking" | "done" | "error";
    result?: UpdateCheckResult;
    error?: string;
  }>({ status: "idle" });

  useEffect(() => {
    appVersion()
      .then(setVersion)
      .catch(() => setVersion("—"));
  }, []);

  const check = async () => {
    setCheckState({ status: "checking" });
    try {
      const result = await checkUpdate(null, version);
      setCheckState({ status: "done", result });
    } catch (e) {
      setCheckState({
        status: "error",
        error: userVisibleError(e instanceof Error ? e.message : String(e)),
      });
    }
  };

  const copy = (key: string, url: string) => {
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {});
  };

  const updateStatus =
    checkState.status === "done" && checkState.result
      ? checkState.result.available
        ? `${t("settings.update.available")} · v${checkState.result.latest_version}`
        : t("settings.update.upToDate")
      : null;

  return (
    <div className="nc-set-app">
      {/* 左栏：Logo + 版本 + 检查更新（对照 Netcatty lg:w-[320px]） */}
      <div className="nc-set-app-side">
        <div className="nc-set-app-brand">
          <img className="nc-set-app-logo" src="/icons/variants/original.png" alt="" />
          <div>
            <div className="nc-set-app-name">termX</div>
            <div className="nc-set-app-version">{version}</div>
          </div>
        </div>

        <button
          className="nc-set-btn is-secondary"
          disabled={checkState.status === "checking" || version === "—"}
          onClick={() => void check()}
        >
          <Icon
            name={
              checkState.status === "checking"
                ? "loader"
                : checkState.status === "done" && checkState.result && !checkState.result.available
                  ? "check"
                  : "refresh"
            }
            size={16}
          />
          {checkState.status === "checking"
            ? t("settings.update.checking")
            : t("settings.application.checkUpdates")}
        </button>

        {updateStatus && (
          <div className="nc-set-app-status">
            <span>{updateStatus}</span>
            {checkState.result && (
              <span>
                {t("settings.update.platform")}: <strong>{checkState.result.platform}</strong>
                {!checkState.result.platform_supported && ` · ${t("settings.update.noPlatform")}`}
              </span>
            )}
            {checkState.result?.notes && <span>{checkState.result.notes}</span>}
          </div>
        )}
        {checkState.status === "error" && (
          <div className="nc-set-app-status">
            <span>{t("settings.update.checkFailed")}</span>
            <strong>{checkState.error}</strong>
          </div>
        )}

        <div className="nc-set-app-status">
          <span>{t("settings.update.installMissing")}</span>
        </div>

        <button className="nc-set-btn" disabled>
          <Icon name="download" size={16} />
          {t("settings.update.install")}
        </button>
      </div>

      {/* 右栏：ActionRow 列表（保持既有复制链接行为） */}
      <div className="nc-set-app-links">
        {APP_LINKS.map((l) => (
          <button
            key={l.key}
            className="nc-set-action-row"
            title={t("settings.application.copyLink")}
            onClick={() => copy(l.key, l.url)}
          >
            <span className="nc-set-action-icon">
              <Icon
                name={
                  l.key === "reportProblem"
                    ? "bug"
                    : l.key === "community"
                      ? "message-circle"
                      : l.key === "github"
                        ? "github"
                        : "newspaper"
                }
                size={18}
              />
            </span>
            <span className="nc-set-action-text">
              <span className="nc-set-action-title" style={{ display: "block" }}>
                {t(`settings.application.${l.key}`)}
              </span>
              <span className="nc-set-action-subtitle" style={{ display: "block" }}>
                {t(`settings.application.${l.key}.subtitle`)}
              </span>
            </span>
            <span className="nc-set-action-trailing">
              {copied === l.key ? t("settings.application.copied") : "→"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 外观 ──────────────────────────────────────────────────

const FONT_WEIGHTS: Array<{ value: number; key: string }> = [
  { value: 100, key: "thin" },
  { value: 200, key: "extraLight" },
  { value: 300, key: "light" },
  { value: 400, key: "normal" },
  { value: 500, key: "medium" },
  { value: 600, key: "semiBold" },
  { value: 700, key: "bold" },
  { value: 800, key: "extraBold" },
  { value: 900, key: "black" },
];

export function AppearanceTab() {
  const s = useSettings();
  const t = useT();
  const fonts = useFontList();
  const fontOptions = [
    ...UI_FONTS.map((f) => ({ value: f.id, label: f.name })),
    ...fonts.map((f) => ({ value: `local-${f.family}`, label: f.family })),
  ];
  /** Netcatty 在 Windows/Linux 不渲染背景模糊（macOS vibrancy 专属）。 */
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
  const resolved = resolvedThemeMode(s);
  const activeThemes = resolved === "dark" ? DARK_UI_THEMES : LIGHT_UI_THEMES;
  const activeThemeId = resolved === "dark" ? s.darkUiThemeId : s.lightUiThemeId;
  const setActiveThemeId = (id: string) =>
    updateSettings(resolved === "dark" ? { darkUiThemeId: id } : { lightUiThemeId: id });
  const isCustomAccentPicked = ACCENT_COLORS.some((c) => c.value === s.customAccent);

  return (
    <div className="nc-set-page">
      {/* 语言 + 界面字体同卡片（对照 Netcatty appearance language 分组） */}
      <Section title={t("settings.appearance.section.language")}>
        <Row title={t("settings.appearance.language.label")} desc={t("settings.appearance.language.desc")}>
          <Select
            value={s.language}
            onChange={(v) => updateSettings({ language: v === "en" ? "en" : "zh-CN" })}
            options={[
              { value: "zh-CN", label: t("settings.appearance.language.zhCN") },
              { value: "en", label: t("settings.appearance.language.en") },
            ]}
          />
        </Row>
        <Row title={t("settings.appearance.fonts.uiFontFamily")} desc={t("settings.appearance.fonts.uiFontFamily.desc")}>
          <FontCombo
            value={s.uiFontFamilyId}
            options={fontOptions}
            onChange={(v) => updateSettings({ uiFontFamilyId: v })}
          />
        </Row>
      </Section>

      <Section title={t("settings.appearance.section.window")}>
        <Row title={t("settings.appearance.window.opacity")} desc={t("settings.appearance.window.opacity.desc")}>
          {/* 对照 Netcatty：滑杆 + 右侧数值在上，预设胶囊在下 */}
          <div className="nc-set-slider is-stacked">
            <div className="nc-set-slider-line">
              <input
                type="range"
                min={50}
                max={100}
                value={Math.round(s.windowOpacity * 100)}
                onChange={(e) => updateSettings({ windowOpacity: Number(e.target.value) / 100 })}
              />
              <span className="nc-set-value">{Math.round(s.windowOpacity * 100)}%</span>
            </div>
            <div className="nc-set-slider-presets">
              {[100, 85, 70].map((p) => (
                <button
                  key={p}
                  type="button"
                  className={"nc-set-preset" + (Math.round(s.windowOpacity * 100) === p ? " is-active" : "")}
                  onClick={() => updateSettings({ windowOpacity: p / 100 })}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>
        </Row>
        {isMac && (
          <Row
            title={t("settings.appearance.window.backgroundBlur")}
            desc={t("settings.appearance.window.backgroundBlur.desc")}
          >
            <Toggle
              checked={s.windowBackgroundBlur}
              onChange={(v) => updateSettings({ windowBackgroundBlur: v })}
            />
          </Row>
        )}
      </Section>

      <Section title={t("settings.appearance.section.theme")}>
        <Row title={t("settings.appearance.theme.mode")}>
          <div className="nc-set-theme-cards" role="radiogroup">
            {(["light", "system", "dark"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={s.theme === m}
                className={"nc-set-theme-card" + (s.theme === m ? " is-active" : "")}
                onClick={() => updateSettings({ theme: m })}
              >
                <Icon name={m === "light" ? "sun" : m === "dark" ? "moon" : "monitor"} />
                {t(`settings.appearance.theme.${m}`)}
              </button>
            ))}
          </div>
        </Row>
        <Row
          title={t(resolved === "dark" ? "settings.appearance.theme.darkTheme" : "settings.appearance.theme.lightTheme")}
        >
          <div className="nc-set-swatches" role="radiogroup">
            {activeThemes.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={activeThemeId === preset.id}
                title={preset.name}
                className={"nc-set-swatch" + (activeThemeId === preset.id ? " is-active" : "")}
                style={{ backgroundColor: `hsl(${preset.tokens.background})` }}
                onClick={() => setActiveThemeId(preset.id)}
              >
                {activeThemeId === preset.id && <Icon name="check" />}
              </button>
            ))}
          </div>
        </Row>
        <Row
          title={t("settings.appearance.accent.useCustom")}
          desc={t("settings.appearance.accent.useCustom.desc")}
        >
          <Toggle
            checked={s.accentMode === "custom"}
            onChange={(v) => updateSettings({ accentMode: v ? "custom" : "theme" })}
          />
        </Row>
        {s.accentMode === "custom" && (
          <div className="nc-set-accent-block">
            <div className="nc-set-row-title">{t("settings.appearance.accent.customColor")}</div>
            <div className="nc-set-swatches">
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.name}
                  className={"nc-set-swatch" + (s.customAccent === c.value ? " is-active" : "")}
                  style={{ backgroundColor: `hsl(${c.value})` }}
                  onClick={() => updateSettings({ customAccent: c.value })}
                >
                  {s.customAccent === c.value && <Icon name="check" />}
                </button>
              ))}
              <label
                className={"nc-set-swatch nc-set-swatch-custom" + (isCustomAccentPicked ? "" : " is-active")}
                title={t("settings.appearance.accent.customColor")}
              >
                <input
                  type="color"
                  className="nc-set-color-hidden"
                  value={/^#[0-9a-fA-F]{6}$/.test(s.customAccent) ? s.customAccent : "#3b82f6"}
                  onChange={(e) => updateSettings({ customAccent: e.target.value })}
                />
                <Icon name={isCustomAccentPicked ? "palette" : "check"} />
              </label>
            </div>
          </div>
        )}
      </Section>

      <Section title={t("settings.appearance.section.icon")}>
        <div className="nc-set-icon-desc">{t("settings.appearance.icon.appIconVariant.desc")}</div>
        <div className="nc-set-icon-groups">
          {APP_ICON_VARIANT_GROUPS.map((group) => (
            <div key={group.id} className="nc-set-icon-group">
              <span className="nc-set-icon-group-label">{t(group.labelKey)}</span>
              <div className="nc-set-icon-row">
                {group.variants.map((variant) => (
                  <button
                    key={variant}
                    type="button"
                    title={t(APP_ICON_VARIANT_I18N_KEY[variant])}
                    className={"nc-set-icon-tile" + (s.appIconVariant === variant ? " is-active" : "")}
                    onClick={() => updateSettings({ appIconVariant: variant })}
                  >
                    <img src={APP_ICON_VARIANT_ASSET_PATH[variant]} alt="" draggable={false} />
                    {s.appIconVariant === variant && (
                      <span className="nc-set-icon-check">
                        <Icon name="check" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t("settings.vault.title")}>
        <Row title={t("settings.vault.showRecentHosts")} desc={t("settings.vault.showRecentHostsDesc")}>
          <Toggle checked={s.showRecentHosts} onChange={(v) => updateSettings({ showRecentHosts: v })} />
        </Row>
        <Row title={t("settings.vault.selectBeforeConnect")} desc={t("settings.vault.selectBeforeConnectDesc")}>
          <Toggle
            checked={s.hostClickBehavior === "select"}
            onChange={(v) => updateSettings({ hostClickBehavior: v ? "select" : "connect" })}
          />
        </Row>
        <Row
          title={t("settings.vault.showOnlyUngroupedHostsInRoot")}
          desc={t("settings.vault.showOnlyUngroupedHostsInRootDesc")}
        >
          <Toggle
            checked={s.showOnlyUngroupedHostsInRoot}
            onChange={(v) => updateSettings({ showOnlyUngroupedHostsInRoot: v })}
          />
        </Row>
        <Row title={t("settings.vault.showSftpTab")} desc={t("settings.vault.showSftpTabDesc")}>
          <Toggle checked={s.showSftpTab} onChange={(v) => updateSettings({ showSftpTab: v })} />
        </Row>
        <Row title={t("settings.vault.showHostTreeSidebar")} desc={t("settings.vault.showHostTreeSidebarDesc")}>
          <Toggle checked={s.showHostTreeSidebar} onChange={(v) => updateSettings({ showHostTreeSidebar: v })} />
        </Row>
        <Row
          title={t("settings.vault.autoImportSystemKnownHosts")}
          desc={`${t("settings.vault.autoImportSystemKnownHostsDesc")} ${t(
            "settings.vault.autoImportSystemKnownHostsDisabled",
          )}`}
        >
          {/* termX 的主机列表本身就是系统 known_hosts 文件，导入无意义 → 保留条目但禁用。 */}
          <Toggle
            checked={s.autoImportSystemKnownHosts}
            onChange={(v) => updateSettings({ autoImportSystemKnownHosts: v })}
            disabled
          />
        </Row>
      </Section>

      <Section title={t("settings.appearance.section.customCSS")}>
        <Row title={t("settings.appearance.section.customCSS")} desc={t("settings.appearance.customCSS.desc")}>
          <textarea
            className="nc-set-textarea"
            rows={6}
            value={s.customCSS}
            onChange={(e) => updateSettings({ customCSS: e.target.value })}
          />
        </Row>
      </Section>
    </div>
  );
}

// ── 关键字高亮规则编辑器 ────────────────────────────────

const DEFAULT_NEW_RULE_COLOR = "#F87171";

/** 内置规则的标签 / 正则被用户改过时显示「恢复」入口（颜色不参与比较，对照 Netcatty）。 */
function isBuiltInRuleModified(rule: KeywordHighlightRule): boolean {
  const def = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === rule.id);
  if (!def) return false;
  return rule.label !== def.label || rule.patterns.join("\n") !== def.patterns.join("\n");
}

/** 新增 / 编辑规则弹窗（对照 Netcatty AddCustomRuleDialog）。 */
function KeywordRuleDialog({
  rule,
  builtIn,
  onCancel,
  onSave,
  t,
}: {
  rule: KeywordHighlightRule | null;
  builtIn: boolean;
  onCancel: () => void;
  onSave: (rule: KeywordHighlightRule) => void;
  t: TFn;
}) {
  const [label, setLabel] = useState(rule?.label ?? "");
  const [patternsText, setPatternsText] = useState(rule?.patterns.join("\n") ?? "");
  const [color, setColor] = useState(rule?.color ?? DEFAULT_NEW_RULE_COLOR);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = label.trim().length > 0 && patternsText.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    const patterns = patternsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 16);
    for (const p of patterns) {
      try {
        new RegExp(p, "gi");
      } catch {
        setError(t("settings.terminal.keywordHighlight.invalidPattern"));
        return;
      }
    }
    onSave({
      id: rule?.id ?? `custom-${Date.now().toString(36)}`,
      label: label.trim(),
      patterns,
      color: color.toUpperCase(),
      enabled: rule?.enabled ?? true,
    });
  };

  return (
    <div className="modal-mask" onMouseDown={onCancel}>
      <div className="nc-set-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nc-set-modal-title">
          {rule
            ? builtIn
              ? t("settings.terminal.keywordHighlight.editBuiltIn")
              : t("settings.terminal.keywordHighlight.editCustom")
            : t("settings.terminal.keywordHighlight.addCustom")}
        </div>
        <div className="nc-set-field">
          <span className="nc-set-field-label">{t("settings.terminal.keywordHighlight.labelField")}</span>
          <div className="nc-set-field-row">
            <input
              className="nc-set-input"
              value={label}
              placeholder={t("settings.terminal.keywordHighlight.labelPlaceholder")}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="nc-set-field-row">
            <HighlightColorPicker
              value={color}
              onChange={(next) => setColor(next.toUpperCase())}
            />
          </div>
        </div>
        <div className="nc-set-field">
          <span className="nc-set-field-label">{t("settings.terminal.keywordHighlight.patternField")}</span>
          <textarea
            className={"nc-set-textarea" + (error ? " is-invalid" : "")}
            rows={Math.max(3, Math.min(10, patternsText.split("\n").length + 1))}
            value={patternsText}
            placeholder={t("settings.terminal.keywordHighlight.patternPlaceholder")}
            onChange={(e) => {
              setPatternsText(e.target.value);
              if (error) setError(null);
            }}
          />
          <span className="nc-set-field-hint">
            {t("settings.terminal.keywordHighlight.patternHint")}
          </span>
          {error && <span className="nc-set-field-error">{error}</span>}
        </div>
        {label.trim() && patternsText.trim() && !error && (
          <div className="nc-set-rule-preview">
            <span className="nc-set-field-hint">{t("settings.terminal.keywordHighlight.preview")}:</span>
            <span style={{ color: color.toUpperCase() }}>{label}</span>
          </div>
        )}
        <div className="nc-set-modal-actions">
          <button type="button" className="nc-set-btn is-secondary" onClick={onCancel}>
            {t("settings.terminal.keywordHighlight.cancel")}
          </button>
          <button type="button" className="nc-set-btn is-primary" disabled={!canSubmit} onClick={submit}>
            {rule
              ? t("settings.terminal.keywordHighlight.save")
              : t("settings.terminal.keywordHighlight.add")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 规则列表：色块 + 标签 + 开关 + 内置/自定义的编辑、恢复、删除（对照 Netcatty KeywordHighlightRulesEditor）。 */
export function KeywordHighlightRulesEditor({
  rules,
  onChange,
  t,
}: {
  rules: KeywordHighlightRule[];
  onChange: (rules: KeywordHighlightRule[]) => void;
  t: TFn;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<KeywordHighlightRule | null>(null);
  /** 同一时间只开一个行内选色浮层。 */
  const [openColorRuleId, setOpenColorRuleId] = useState<string | null>(null);

  const isBuiltIn = (id: string) => DEFAULT_KEYWORD_HIGHLIGHT_RULES.some((r) => r.id === id);
  const canAdd = rules.length < MAX_KEYWORD_HIGHLIGHT_RULES;

  const updateRule = (id: string, patch: Partial<KeywordHighlightRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingRule(null);
  };

  return (
    <>
      <div className="nc-set-rule-list">
        {rules.map((rule) => {
          const builtIn = isBuiltIn(rule.id);
          const modified = builtIn && isBuiltInRuleModified(rule);
          return (
            <div key={rule.id} className="nc-set-rule-row">
              <span
                className={"nc-set-rule-label" + (rule.enabled ? "" : " is-off")}
                style={rule.enabled ? { color: rule.color } : undefined}
                title={rule.patterns.join("  ·  ")}
              >
                {rule.label}
              </span>
              <button
                type="button"
                className="nc-set-icon-btn"
                title={
                  builtIn
                    ? t("settings.terminal.keywordHighlight.editBuiltIn")
                    : t("settings.terminal.keywordHighlight.editCustom")
                }
                onClick={() => {
                  setEditingRule(rule);
                  setDialogOpen(true);
                }}
              >
                <Icon name="pencil" size={12} />
              </button>
              {modified && (
                <button
                  type="button"
                  className="nc-set-icon-btn"
                  title={t("settings.terminal.keywordHighlight.resetBuiltIn")}
                  onClick={() => {
                    const def = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === rule.id);
                    if (def) updateRule(rule.id, { label: def.label, patterns: [...def.patterns] });
                  }}
                >
                  <Icon name="refresh" size={12} />
                </button>
              )}
              {!builtIn && (
                <button
                  type="button"
                  className="nc-set-icon-btn is-danger"
                  title={t("settings.terminal.keywordHighlight.delete")}
                  onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
                >
                  <Icon name="trash" size={12} />
                </button>
              )}
              <HighlightColorField
                value={rule.color}
                onChange={(color) => updateRule(rule.id, { color })}
                open={openColorRuleId === rule.id}
                onOpenChange={(open) =>
                  setOpenColorRuleId(open ? rule.id : null)
                }
                title={t("settings.terminal.keywordHighlight.labelField")}
              />
              <Toggle checked={rule.enabled} onChange={(v) => updateRule(rule.id, { enabled: v })} />
            </div>
          );
        })}
      </div>
      <div className="nc-set-rule-footer">
        <button
          type="button"
          className="nc-set-link-btn"
          disabled={!canAdd}
          onClick={() => {
            setEditingRule(null);
            setDialogOpen(true);
          }}
        >
          <Icon name="plus" size={14} />
          {t("settings.terminal.keywordHighlight.addCustom")}
        </button>
        <button
          type="button"
          className="nc-set-link-btn"
          onClick={() =>
            onChange(
              rules.map((rule) => {
                const def = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((r) => r.id === rule.id);
                return def ? { ...def, patterns: [...def.patterns], enabled: rule.enabled } : rule;
              }),
            )
          }
        >
          <Icon name="refresh" size={14} />
          {t("settings.terminal.keywordHighlight.resetDefaults")}
        </button>
      </div>
      {dialogOpen && (
        <KeywordRuleDialog
          rule={editingRule}
          builtIn={editingRule ? isBuiltIn(editingRule.id) : false}
          onCancel={closeDialog}
          onSave={(rule) => {
            if (editingRule) {
              onChange(rules.map((r) => (r.id === editingRule.id ? rule : r)));
            } else {
              onChange([...rules, rule]);
            }
            closeDialog();
          }}
          t={t}
        />
      )}
    </>
  );
}

// ── 终端 ──────────────────────────────────────────────────

export function TerminalTab() {
  const s = useSettings();
  const t = useT();
  const fonts = useFontList();
  const term = s.terminal;
  const patch = (p: Partial<typeof term>) => updateSettings({ terminal: { ...term, ...p } });

  const fontOptions = [
    { value: "auto", label: t("settings.terminal.font.auto") },
    ...fonts.map((f) => ({ value: f.family, label: f.family + (f.monospaced ? "" : " ·") })),
  ];
  const cjkOptions = [
    { value: "", label: t("settings.terminal.font.cjk.option.auto") },
    ...fonts.map((f) => ({ value: f.family, label: f.family })),
  ];
  const weightOptions = FONT_WEIGHTS.map((w) => ({
    value: String(w.value),
    label: `${w.value} - ${t(`settings.terminal.font.weight.${w.key}`)}`,
  }));

  /** 滑杆行（对照 Netcatty 终端字号 / 连字内边距 / 光标粗细的 range + 数值）。 */
  const sliderRow = (
    title: string,
    desc: string | undefined,
    value: number,
    min: number,
    max: number,
    suffix: string,
    onChange: (value: number) => void,
  ) => (
    <Row title={title} desc={desc}>
      <div className="nc-set-slider">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="nc-set-value">
          {value}
          {suffix}
        </span>
      </div>
    </Row>
  );

  return (
    <div className="nc-set-page">
      {/* 终端主题（对照 Netcatty settings.terminal.theme.followApp） */}
      <Section
        title={t("settings.terminal.section.theme")}
        hint={!term.followAppTheme ? t("settings.terminal.theme.fixedDarkHint") : undefined}
      >
        <Row
          title={t("settings.terminal.theme.followApp")}
          desc={t("settings.terminal.theme.followApp.desc")}
        >
          <Toggle checked={term.followAppTheme} onChange={(v) => patch({ followAppTheme: v })} />
        </Row>
      </Section>

      {/* 内嵌图片（对照 Netcatty inlineImages：Kitty / SIXEL / iTerm IIP） */}
      <Section
        title={t("settings.terminal.section.inlineImages")}
        hint={term.inlineImagesEnabled ? t("settings.terminal.inlineImages.hibernateNote") : undefined}
      >
        <Row
          title={t("settings.terminal.inlineImages.enabled")}
          desc={t("settings.terminal.inlineImages.enabled.desc")}
        >
          <Toggle
            checked={term.inlineImagesEnabled}
            onChange={(v) => patch({ inlineImagesEnabled: v })}
          />
        </Row>
        {term.inlineImagesEnabled && (
          <>
            <Row
              title={t("settings.terminal.inlineImages.kitty")}
              desc={t("settings.terminal.inlineImages.kitty.desc")}
            >
              <Toggle
                checked={term.inlineImageKittyEnabled}
                onChange={(v) => patch({ inlineImageKittyEnabled: v })}
              />
            </Row>
            <Row
              title={t("settings.terminal.inlineImages.sixel")}
              desc={t("settings.terminal.inlineImages.sixel.desc")}
            >
              <Toggle
                checked={term.inlineImageSixelEnabled}
                onChange={(v) => patch({ inlineImageSixelEnabled: v })}
              />
            </Row>
            <Row
              title={t("settings.terminal.inlineImages.iip")}
              desc={t("settings.terminal.inlineImages.iip.desc")}
            >
              <Toggle
                checked={term.inlineImageIipEnabled}
                onChange={(v) => patch({ inlineImageIipEnabled: v })}
              />
            </Row>
            <Row
              title={t("settings.terminal.inlineImages.storageLimit")}
              desc={t("settings.terminal.inlineImages.storageLimit.desc")}
            >
              <Stepper
                value={term.inlineImageStorageLimitMb}
                onChange={(v) => patch({ inlineImageStorageLimitMb: v })}
                min={INLINE_IMAGE_STORAGE_LIMIT_MB_MIN}
                max={INLINE_IMAGE_STORAGE_LIMIT_MB_MAX}
                suffix="MB"
              />
            </Row>
            <Row
              title={t("settings.terminal.inlineImages.maxMegapixels")}
              desc={t("settings.terminal.inlineImages.maxMegapixels.desc")}
            >
              <Stepper
                value={term.inlineImageMaxMegapixels}
                onChange={(v) => patch({ inlineImageMaxMegapixels: v })}
                min={INLINE_IMAGE_MAX_MEGAPIXELS_MIN}
                max={INLINE_IMAGE_MAX_MEGAPIXELS_MAX}
                suffix="MP"
              />
            </Row>
            <Row
              title={t("settings.terminal.inlineImages.sequenceLimit")}
              desc={t("settings.terminal.inlineImages.sequenceLimit.desc")}
            >
              <Stepper
                value={term.inlineImageSequenceLimitMb}
                onChange={(v) => patch({ inlineImageSequenceLimitMb: v })}
                min={INLINE_IMAGE_SEQUENCE_LIMIT_MB_MIN}
                max={INLINE_IMAGE_SEQUENCE_LIMIT_MB_MAX}
                suffix="MB"
              />
            </Row>
          </>
        )}
      </Section>

      <Section title={t("settings.terminal.section.font")}>
        <Row title={t("settings.terminal.font.family")} desc={t("settings.terminal.font.family.desc")}>
          <FontCombo
            value={s.terminalFontFamilyId}
            onChange={(v) => updateSettings({ terminalFontFamilyId: v })}
            options={fontOptions}
          />
        </Row>
        <Row title={t("settings.terminal.font.cjk")} desc={t("settings.terminal.font.cjk.desc")}>
          <FontCombo value={term.fallbackFont} onChange={(v) => patch({ fallbackFont: v })} options={cjkOptions} />
        </Row>
        <Row title={t("settings.terminal.font.size")} desc={t("settings.terminal.font.size.desc")}>
          <Stepper
            value={s.terminalFontSize}
            onChange={(v) => updateSettings({ terminalFontSize: v })}
            min={MIN_TERMINAL_FONT_SIZE}
            max={MAX_TERMINAL_FONT_SIZE}
            suffix="px"
          />
        </Row>
        <Row title={t("settings.terminal.font.weight")} desc={t("settings.terminal.font.weight.desc")}>
          <Select
            value={String(term.fontWeight)}
            onChange={(v) => patch({ fontWeight: Number(v) })}
            options={weightOptions}
          />
        </Row>
        <Row title={t("settings.terminal.font.weightBold")} desc={t("settings.terminal.font.weightBold.desc")}>
          <Select
            value={String(term.fontWeightBold)}
            onChange={(v) => patch({ fontWeightBold: Number(v) })}
            options={weightOptions}
          />
        </Row>
        <Row title={t("settings.terminal.font.smoothing")} desc={t("settings.terminal.font.smoothing.desc")}>
          <Toggle checked={term.fontSmoothing} onChange={(v) => patch({ fontSmoothing: v })} />
        </Row>
        <Row title={t("settings.terminal.font.ligatures")} desc={t("settings.terminal.font.ligatures.desc")}>
          <Toggle checked={term.fontLigatures} onChange={(v) => patch({ fontLigatures: v })} />
        </Row>
        {sliderRow(
          t("settings.terminal.font.linePadding"),
          t("settings.terminal.font.linePadding.desc"),
          term.linePadding,
          0,
          10,
          "px",
          (v) => patch({ linePadding: v }),
        )}
        <Row title={t("settings.terminal.font.emulationType")}>
          <Select
            value={term.terminalEmulationType}
            onChange={(v) => patch({ terminalEmulationType: v })}
            options={[
              { value: "xterm-256color", label: "xterm-256color" },
              { value: "xterm-16color", label: "xterm-16color" },
              { value: "xterm", label: "xterm" },
            ]}
          />
        </Row>
      </Section>

      <Section title={t("settings.terminal.section.cursor")}>
        <Row title={t("settings.terminal.cursor.style")}>
          <Select
            value={term.cursorShape}
            onChange={(v) => patch({ cursorShape: v as typeof term.cursorShape })}
            options={[
              { value: "block", label: t("settings.terminal.cursor.style.block") },
              { value: "bar", label: t("settings.terminal.cursor.style.bar") },
              { value: "underline", label: t("settings.terminal.cursor.style.underline") },
            ]}
          />
        </Row>
        {sliderRow(
          t("settings.terminal.cursor.barWidth"),
          t("settings.terminal.cursor.barWidth.desc"),
          term.cursorBarWidth,
          1,
          4,
          "px",
          (v) => patch({ cursorBarWidth: clampCursorBarWidth(v) }),
        )}
        <Row title={t("settings.terminal.cursor.blink")}>
          <Toggle checked={term.cursorBlink} onChange={(v) => patch({ cursorBlink: v })} />
        </Row>
        <Row title={t("settings.terminal.cursor.highlightLine")} desc={t("settings.terminal.cursor.highlightLine.desc")}>
          <Toggle checked={term.highlightCursorLine} onChange={(v) => patch({ highlightCursorLine: v })} />
        </Row>
      </Section>

      <Section
        title={t("settings.terminal.section.keywordHighlight")}
        hint={
          term.keywordHighlightEnabled
            ? t("settings.terminal.keywordHighlight.hint")
            : undefined
        }
      >
        <Row
          title={t("settings.terminal.keywordHighlight.enabled")}
          desc={t("settings.terminal.keywordHighlight.enabled.desc")}
        >
          <Toggle
            checked={term.keywordHighlightEnabled}
            onChange={(v) => patch({ keywordHighlightEnabled: v })}
          />
        </Row>
        {term.keywordHighlightEnabled && (
          <KeywordHighlightRulesEditor
            rules={term.keywordHighlightRules}
            onChange={(rules) => patch({ keywordHighlightRules: rules })}
            t={t}
          />
        )}
      </Section>

      <Section title={t("settings.terminal.section.keyboard")}>
        <Row title={t("settings.terminal.keyboard.altAsMeta")} desc={t("settings.terminal.keyboard.altAsMeta.desc")}>
          <Toggle checked={term.altAsMeta} onChange={(v) => patch({ altAsMeta: v })} />
        </Row>
        <Row
          title={t("settings.terminal.keyboard.optionArrowWordJump")}
          desc={`${t("settings.terminal.keyboard.optionArrowWordJump.desc")}${
            IS_MAC ? "" : ` ${t("settings.terminal.keyboard.macOnly")}`
          }`}
        >
          <Toggle
            checked={term.optionArrowWordJump}
            onChange={(v) => patch({ optionArrowWordJump: v })}
          />
        </Row>
        <Row title={t("settings.terminal.keyboard.kittyProtocol")} desc={`${t("settings.terminal.keyboard.kittyProtocol.desc")} ${t("settings.terminal.unsupported.kitty")}`}>
          <Toggle disabled checked={false} onChange={() => {}} />
        </Row>
      </Section>

      <Section title={t("settings.terminal.section.autocomplete")}>
        <Row
          title={t("settings.terminal.autocomplete.enabled")}
          desc={t("settings.terminal.autocomplete.enabled.desc")}
        >
          <Toggle
            checked={term.autocompleteEnabled}
            onChange={(v) => patch({ autocompleteEnabled: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.autocomplete.ghostText")}
          desc={t("settings.terminal.autocomplete.ghostText.desc")}
        >
          <Toggle
            disabled={!term.autocompleteEnabled}
            checked={term.autocompleteGhostText}
            onChange={(v) => patch({ autocompleteGhostText: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.autocomplete.popupMenu")}
          desc={t("settings.terminal.autocomplete.popupMenu.desc")}
        >
          <Toggle
            disabled={!term.autocompleteEnabled}
            checked={term.autocompletePopupMenu}
            onChange={(v) => patch({ autocompletePopupMenu: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.autocomplete.historyScope")}
          desc={t("settings.terminal.autocomplete.historyScope.desc")}
        >
          <Select
            value={term.autocompleteHistoryScope}
            disabled={!term.autocompleteEnabled}
            onChange={(v) =>
              patch({ autocompleteHistoryScope: v as typeof term.autocompleteHistoryScope })
            }
            options={[
              { value: "host", label: t("settings.terminal.autocomplete.historyScope.host") },
              { value: "global", label: t("settings.terminal.autocomplete.historyScope.global") },
            ]}
          />
        </Row>
      </Section>

      <Section title={t("settings.terminal.section.behavior")}>
        <Row title={t("settings.terminal.behavior.autoCloseOnExit")} desc={t("settings.terminal.behavior.autoCloseOnExit.desc")}>
          <Toggle checked={term.autoCloseOnExit} onChange={(v) => patch({ autoCloseOnExit: v })} />
        </Row>
        <Row
          title={t("settings.terminal.behavior.disconnectedNotice")}
          desc={t("settings.terminal.behavior.disconnectedNotice.desc")}
        >
          <Select
            value={term.disconnectedNoticeMode}
            onChange={(v) => patch({ disconnectedNoticeMode: v as typeof term.disconnectedNoticeMode })}
            options={[
              { value: "terminal", label: t("settings.terminal.behavior.disconnectedNotice.terminal") },
              { value: "dialog", label: t("settings.terminal.behavior.disconnectedNotice.dialog") },
            ]}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.rightClick")} desc={t("settings.terminal.behavior.rightClick.desc")}>
          <Select
            value={term.rightClickBehavior}
            onChange={(v) => patch({ rightClickBehavior: v as typeof term.rightClickBehavior })}
            options={[
              { value: "context-menu", label: t("settings.terminal.behavior.rightClick.menu") },
              { value: "paste", label: t("settings.terminal.behavior.rightClick.paste") },
              { value: "select-word", label: t("settings.terminal.behavior.rightClick.selectWord") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.rightClick.longPressMenu")}
          desc={t("settings.terminal.behavior.rightClick.longPressMenu.desc")}
        >
          <Toggle
            disabled={term.rightClickBehavior === "context-menu"}
            checked={term.rightClickLongPressMenu}
            onChange={(v) => patch({ rightClickLongPressMenu: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.rightClick.fullscreenMenu")}
          desc={t("settings.terminal.behavior.rightClick.fullscreenMenu.desc")}
        >
          <Toggle
            checked={term.showContextMenuOverFullscreenApps}
            onChange={(v) => patch({ showContextMenuOverFullscreenApps: v })}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.middleClick")} desc={t("settings.terminal.behavior.middleClick.desc")}>
          <Select
            value={term.middleClickBehavior}
            onChange={(v) => patch({ middleClickBehavior: v as typeof term.middleClickBehavior })}
            options={[
              { value: "context-menu", label: t("settings.terminal.behavior.middleClick.menu") },
              { value: "paste", label: t("settings.terminal.behavior.middleClick.paste") },
              { value: "disabled", label: t("settings.terminal.behavior.middleClick.disabled") },
            ]}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.copyOnSelect")} desc={t("settings.terminal.behavior.copyOnSelect.desc")}>
          <Toggle checked={term.copyOnSelect} onChange={(v) => patch({ copyOnSelect: v })} />
        </Row>
        <Row
          title={t("settings.terminal.behavior.normalizeTextOnCopy")}
          desc={t("settings.terminal.behavior.normalizeTextOnCopy.desc")}
        >
          <Toggle checked={term.normalizeTextOnCopy} onChange={(v) => patch({ normalizeTextOnCopy: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.wordSeparators")} desc={t("settings.terminal.behavior.wordSeparators.desc")}>
          <input
            className="nc-set-input"
            value={term.wordSeparators}
            onChange={(e) => patch({ wordSeparators: e.target.value })}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.bracketedPaste")} desc={t("settings.terminal.behavior.bracketedPaste.desc")}>
          <Toggle checked={!term.disableBracketedPaste} onChange={(v) => patch({ disableBracketedPaste: !v })} />
        </Row>
        <Row
          title={t("settings.terminal.behavior.autoUploadClipboardImage")}
          desc={`${t("settings.terminal.behavior.autoUploadClipboardImage.desc")} ${t("settings.terminal.unsupported.imageUpload")}`}
        >
          <Toggle disabled checked={false} onChange={() => {}} />
        </Row>
        <Row
          title={t("settings.terminal.behavior.confirmMultilinePaste")}
          desc={t("settings.terminal.behavior.confirmMultilinePaste.desc")}
        >
          <Toggle
            checked={term.confirmBeforeMultilinePaste}
            onChange={(v) => patch({ confirmBeforeMultilinePaste: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.confirmMultilinePasteMinLines")}
          desc={t("settings.terminal.behavior.confirmMultilinePasteMinLines.desc")}
        >
          <Stepper
            value={term.multilinePasteConfirmMinLines}
            min={1}
            max={1000}
            disabled={!term.confirmBeforeMultilinePaste}
            onChange={(v) => patch({ multilinePasteConfirmMinLines: v })}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.shiftEnterNewline")} desc={t("settings.terminal.behavior.shiftEnterNewline.desc")}>
          <Toggle
            checked={term.shiftEnterNewlineEnabled}
            onChange={(v) => patch({ shiftEnterNewlineEnabled: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.shiftEnterNewlineText")}
          desc={t("settings.terminal.behavior.shiftEnterNewlineText.desc")}
        >
          <input
            className="nc-set-input"
            disabled={!term.shiftEnterNewlineEnabled}
            value={term.shiftEnterNewlineText}
            onChange={(e) => patch({ shiftEnterNewlineText: e.target.value })}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.shiftEnterForceText")}
          desc={`${t("settings.terminal.behavior.shiftEnterForceText.desc")} ${t("settings.terminal.unsupported.win32")}`}
        >
          <Toggle
            disabled
            checked={false}
            onChange={() => {}}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.clearWipesScrollback")}
          desc={`${t("settings.terminal.behavior.clearWipesScrollback.desc")} ${t("settings.terminal.unsupported.clearScrollback")}`}
        >
          <Toggle disabled checked={term.clearWipesScrollback} onChange={() => {}} />
        </Row>
        <Row
          title={t("settings.terminal.behavior.preserveSelectionOnInput")}
          desc={t("settings.terminal.behavior.preserveSelectionOnInput.desc")}
        >
          <Toggle
            checked={term.preserveSelectionOnInput}
            onChange={(v) => patch({ preserveSelectionOnInput: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.forcePromptNewLine")}
          desc={`${t("settings.terminal.behavior.forcePromptNewLine.desc")} ${t("settings.terminal.unsupported.promptNewLine")}`}
        >
          <Toggle disabled checked={false} onChange={() => {}} />
        </Row>
        <Row title={t("settings.terminal.behavior.tabDoubleClick")} desc={t("settings.terminal.behavior.tabDoubleClick.desc")}>
          <Select
            value={term.tabDoubleClickBehavior}
            onChange={(v) => patch({ tabDoubleClickBehavior: v as typeof term.tabDoubleClickBehavior })}
            options={[
              { value: "duplicate", label: t("settings.terminal.behavior.tabDoubleClick.duplicate") },
              { value: "copy", label: t("settings.terminal.behavior.tabDoubleClick.copy") },
              { value: "disabled", label: t("settings.terminal.behavior.tabDoubleClick.disabled") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.dynamicTabTitle")}
          desc={`${t("settings.terminal.behavior.dynamicTabTitle.desc")} ${t("settings.terminal.unsupported.dynamicTitle")}`}
        >
          <Select
            disabled
            value={term.dynamicTabTitleMode}
            onChange={() => {}}
            options={[
              { value: "off", label: t("settings.terminal.behavior.dynamicTabTitle.off") },
              { value: "agent", label: t("settings.terminal.behavior.dynamicTabTitle.agent") },
              { value: "all", label: t("settings.terminal.behavior.dynamicTabTitle.all") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.oscNotifications")}
          desc={t("settings.terminal.behavior.oscNotifications.desc")}
        >
          <Select
            value={term.oscNotifications}
            onChange={(v) => patch({ oscNotifications: v as typeof term.oscNotifications })}
            options={[
              { value: "always", label: t("settings.terminal.behavior.oscNotifications.always") },
              { value: "unfocused", label: t("settings.terminal.behavior.oscNotifications.unfocused") },
              { value: "off", label: t("settings.terminal.behavior.oscNotifications.off") },
            ]}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.osc52Clipboard")} desc={t("settings.terminal.behavior.osc52Clipboard.desc")}>
          <Select
            value={term.osc52Clipboard}
            onChange={(v) => patch({ osc52Clipboard: v as typeof term.osc52Clipboard })}
            options={[
              { value: "off", label: t("settings.terminal.behavior.osc52Clipboard.off") },
              { value: "write-only", label: t("settings.terminal.behavior.osc52Clipboard.writeOnly") },
              { value: "read-write", label: t("settings.terminal.behavior.osc52Clipboard.readWrite") },
              { value: "prompt", label: t("settings.terminal.behavior.osc52Clipboard.prompt") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.linkBrowser")}
          desc={`${t("settings.terminal.behavior.linkBrowser.desc")} ${t("settings.terminal.unsupported.linkBrowser")}`}
        >
          <Select
            disabled
            value={term.linkBrowser}
            onChange={() => {}}
            options={[
              { value: "netcatty", label: t("settings.terminal.behavior.linkBrowser.netcatty") },
              { value: "system", label: t("settings.terminal.behavior.linkBrowser.system") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.terminal.behavior.linkModifier")}
          desc={t("settings.terminal.behavior.linkModifier.desc")}
        >
          <Select
            value={term.linkModifier}
            onChange={(v) => patch({ linkModifier: v as typeof term.linkModifier })}
            options={[
              { value: "none", label: t("settings.terminal.behavior.linkModifier.none") },
              { value: "ctrl", label: t("settings.terminal.behavior.linkModifier.ctrl") },
              { value: "alt", label: t("settings.terminal.behavior.linkModifier.alt") },
              { value: "meta", label: t("settings.terminal.behavior.linkModifier.meta") },
            ]}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.scrollOnInput")} desc={t("settings.terminal.behavior.scrollOnInput.desc")}>
          <Toggle checked={term.scrollOnInput} onChange={(v) => patch({ scrollOnInput: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.scrollOnOutput")} desc={t("settings.terminal.behavior.scrollOnOutput.desc")}>
          <Toggle checked={term.scrollOnOutput} onChange={(v) => patch({ scrollOnOutput: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.scrollOnKeyPress")} desc={t("settings.terminal.behavior.scrollOnKeyPress.desc")}>
          <Toggle checked={term.scrollOnKeyPress} onChange={(v) => patch({ scrollOnKeyPress: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.scrollOnPaste")} desc={t("settings.terminal.behavior.scrollOnPaste.desc")}>
          <Toggle checked={term.scrollOnPaste} onChange={(v) => patch({ scrollOnPaste: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.smoothScrolling")} desc={t("settings.terminal.behavior.smoothScrolling.desc")}>
          <Toggle checked={term.smoothScrolling} onChange={(v) => patch({ smoothScrolling: v })} />
        </Row>
      </Section>

      <Section title={t("settings.terminal.section.scrollback")}>
        <Row title={t("settings.terminal.scrollback.rows")} desc={t("settings.terminal.scrollback.desc")}>
          <input
            className="nc-set-input nc-set-input-num"
            type="number"
            min={0}
            max={MAX_TERMINAL_SCROLLBACK}
            value={term.scrollback}
            onChange={(e) => patch({ scrollback: clampScrollback(e.target.value) })}
          />
        </Row>
      </Section>

      <Section title={t("settings.terminal.section.sidePanel")} hint={t("settings.terminal.sidePanel.unavailableHint")}>
        <Row title={t("settings.terminal.sidePanel.autoOpen")} desc={t("settings.terminal.sidePanel.autoOpen.desc")}>
          <Toggle checked={s.sidePanelAutoOpen} onChange={(v) => updateSettings({ sidePanelAutoOpen: v })} />
        </Row>
        <Row title={t("settings.terminal.sidePanel.autoOpenPane")} desc={t("settings.terminal.sidePanel.autoOpenPane.desc")}>
          <Select
            disabled={!s.sidePanelAutoOpen}
            value={s.sidePanelAutoOpenPane}
            onChange={(v) => updateSettings({ sidePanelAutoOpenPane: v })}
            options={["sftp", "scripts", "history", "theme", "system", "notes", "ai", "browser"].map((p) => ({
              value: p,
              label: t(`settings.terminal.sidePanel.pane.${p}`),
            }))}
          />
        </Row>
      </Section>

      <Section
        title={t("settings.terminal.section.localShellSidePanel")}
        hint={t("settings.terminal.localShellSidePanel.unavailableHint")}
      >
        <Row
          title={t("settings.terminal.localShellSidePanel.autoOpen")}
          desc={t("settings.terminal.localShellSidePanel.autoOpen.desc")}
        >
          <Toggle
            disabled
            checked={s.localShellSidePanelAutoOpen}
            onChange={(v) => updateSettings({ localShellSidePanelAutoOpen: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.localShellSidePanel.autoOpenPane")}
          desc={t("settings.terminal.localShellSidePanel.autoOpenPane.desc")}
        >
          <Select
            disabled
            value={s.localShellSidePanelAutoOpenPane}
            onChange={(v) => updateSettings({ localShellSidePanelAutoOpenPane: v })}
            options={[{ value: "files", label: t("settings.terminal.localShellSidePanel.pane.files") }]}
          />
        </Row>
      </Section>

      <Section title={t("settings.terminal.section.connection")}>
        <Row
          title={t("settings.terminal.connection.verifyHostKeys")}
          desc={t("settings.terminal.connection.verifyHostKeys.desc")}
        >
          <Toggle checked={s.verifyHostKeys} onChange={(v) => updateSettings({ verifyHostKeys: v })} />
        </Row>
      </Section>

      <Section title={t("settings.sessionLogs.title")} hint={t("settings.sessionLogs.hint")}>
        <Row title={t("settings.sessionLogs.description")} desc={t("settings.sessionLogs.autoPerHost")} />
        <Row
          title={t("settings.sessionLogs.directory")}
          desc={t("settings.sessionLogs.directoryDesc")}
        >
          <div className="nc-set-inline">
            <input
              className="nc-set-input"
              style={{ flex: "1 1 0", minWidth: 0, width: 260 }}
              value={s.sessionLogs.directory}
              placeholder={t("settings.sessionLogs.directoryPlaceholder")}
              onChange={(e) =>
                updateSettings({
                  sessionLogs: { ...s.sessionLogs, directory: e.target.value },
                })
              }
            />
            <button
              type="button"
              className="nc-set-btn"
              onClick={() => {
                void open({ directory: true, multiple: false })
                  .then((picked) => {
                    if (typeof picked === "string" && picked) {
                      updateSettings({
                        sessionLogs: { ...s.sessionLogs, directory: picked },
                      });
                    }
                  })
                  .catch(() => {});
              }}
            >
              <Icon name="folder" size={16} />
              {t("settings.sessionLogs.directoryPick")}
            </button>
          </div>
        </Row>
        <Row
          title={t("settings.sessionLogs.nameTemplate")}
          desc={t("settings.sessionLogs.nameTemplateDesc")}
        >
          <input
            className="nc-set-input"
            style={{ width: 260 }}
            value={s.sessionLogs.nameTemplate}
            placeholder="{host}_{date}_{time}"
            onChange={(e) =>
              updateSettings({
                sessionLogs: { ...s.sessionLogs, nameTemplate: e.target.value },
              })
            }
          />
        </Row>
        <Row title={t("settings.sessionLogs.format")} desc={t("settings.sessionLogs.formatDesc")}>
          <Select
            value={s.sessionLogs.format}
            onChange={(v) =>
              updateSettings({ sessionLogs: { ...s.sessionLogs, format: v as typeof s.sessionLogs.format } })
            }
            options={[
              { value: "txt", label: t("settings.sessionLogs.formatTxt") },
              { value: "raw", label: t("settings.sessionLogs.formatRaw") },
              { value: "html", label: t("settings.sessionLogs.formatHtml") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.sessionLogs.timestamps")}
          desc={`${t("settings.sessionLogs.timestampsDesc")} ${t("settings.sessionLogs.timestampsUnsupported")}`}
        >
          <Toggle disabled checked={false} onChange={() => {}} />
        </Row>
        <Row title={t("settings.sessionLogs.clearAll")} desc={t("settings.sessionLogs.clearAllDesc")}>
          <button className="nc-set-btn is-danger" disabled>
            <Icon name="trash" size={16} />
            {t("settings.sessionLogs.clearAll")}
          </button>
        </Row>
      </Section>
    </div>
  );
}

// ── 快捷键 ────────────────────────────────────────────────

/**
 * SFTP tab：逐项对照 Netcatty SettingsFileAssociationsTab。
 * 能落地的项（双击行为 / 隐藏文件 / 侧栏自动打开 / 传输并发）即时生效并持久化；
 * 其余项保留控件并置灰，desc 追加未实现原因。
 */
export function SftpTab() {
  const s = useSettings();
  const t = useT();
  const unsupported = t("settings.sftp.unsupported");
  const withReason = (desc: string) => `${desc} ${unsupported}`;

  return (
    <div className="nc-set-page">
      <Section title={t("settings.sftp.doubleClickBehavior")}>
        <Row
          title={t("settings.sftp.doubleClickBehavior")}
          desc={t("settings.sftp.doubleClickBehavior.desc")}
        >
          <Select
            value={s.sftpDoubleClickBehavior}
            onChange={(v) =>
              updateSettings({ sftpDoubleClickBehavior: v as "open" | "transfer" })
            }
            options={[
              { value: "open", label: t("settings.sftp.doubleClickBehavior.open") },
              { value: "transfer", label: t("settings.sftp.doubleClickBehavior.transfer") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.sftp.defaultViewMode")}
          desc={withReason(t("settings.sftp.defaultViewMode.desc"))}
        >
          <Select
            value="list"
            onChange={() => {}}
            disabled
            options={[
              { value: "list", label: t("settings.sftp.defaultViewMode.list") },
              { value: "tree", label: t("settings.sftp.defaultViewMode.tree") },
            ]}
          />
        </Row>
      </Section>

      <Section title={t("settings.sftp.showHiddenFiles")}>
        <Row
          title={t("settings.sftp.showHiddenFiles")}
          desc={t("settings.sftp.showHiddenFiles.desc")}
        >
          <Toggle
            checked={s.sftpShowHiddenFiles}
            onChange={(v) => updateSettings({ sftpShowHiddenFiles: v })}
          />
        </Row>
      </Section>

      <Section title={t("settings.sftp.autoSync")}>
        <Row title={t("settings.sftp.autoSync")} desc={withReason(t("settings.sftp.autoSync.desc"))}>
          <Toggle checked={false} onChange={() => {}} disabled />
        </Row>
        <Row
          title={t("settings.sftp.compressedUpload")}
          desc={withReason(t("settings.sftp.compressedUpload.desc"))}
        >
          <Toggle checked={true} onChange={() => {}} disabled />
        </Row>
        <Row
          title={t("settings.sftp.followTerminalCwd")}
          desc={t("settings.sftp.followTerminalCwd.desc")}
        >
          <Toggle
            checked={s.sftpFollowTerminalCwd}
            onChange={(v) => updateSettings({ sftpFollowTerminalCwd: v })}
          />
        </Row>
        <Row
          title={t("settings.sftp.autoOpenSidebar")}
          desc={t("settings.sftp.autoOpenSidebar.desc")}
        >
          <Toggle disabled checked={false} onChange={() => {}} />
        </Row>
      </Section>

      <Section title={t("settings.sftp.transferConcurrency")}>
        <Row
          title={t("settings.sftp.transferConcurrency")}
          desc={t("settings.sftp.transferConcurrency.desc")}
        >
          <div className="nc-set-slider">
            <input
              type="range"
              min={MIN_SFTP_TRANSFER_CONCURRENCY}
              max={MAX_SFTP_TRANSFER_CONCURRENCY}
              value={s.sftpTransferConcurrency}
              onChange={(e) =>
                updateSettings({ sftpTransferConcurrency: Number(e.target.value) })
              }
            />
            <span className="nc-set-value">{s.sftpTransferConcurrency}</span>
          </div>
        </Row>
        <Row
          title={t("settings.sftp.skipUnchanged")}
          desc={withReason(t("settings.sftp.skipUnchanged.desc"))}
        >
          <Toggle checked={true} onChange={() => {}} disabled />
        </Row>
        <Row
          title={t("settings.ssh.transportIdleTtl")}
          desc={withReason(t("settings.ssh.transportIdleTtl.desc"))}
        >
          <Select
            value="5m"
            onChange={() => {}}
            disabled
            options={[
              { value: "1m", label: t("settings.ssh.transportIdleTtl.1m") },
              { value: "5m", label: t("settings.ssh.transportIdleTtl.5m") },
              { value: "15m", label: t("settings.ssh.transportIdleTtl.15m") },
              { value: "30m", label: t("settings.ssh.transportIdleTtl.30m") },
              { value: "never", label: t("settings.ssh.transportIdleTtl.never") },
            ]}
          />
        </Row>
      </Section>

      <Section title={t("settings.sftpFileAssociations.title")}>
        <Row
          title={t("settings.sftp.defaultOpener")}
          desc={withReason(t("settings.sftp.defaultOpener.desc"))}
        >
          <Select
            value="ask"
            onChange={() => {}}
            disabled
            options={[
              { value: "ask", label: t("settings.sftp.defaultOpener.ask") },
              { value: "builtin", label: t("settings.sftp.defaultOpener.builtin") },
            ]}
          />
        </Row>
        <Row
          title={t("settings.sftpFileAssociations.title")}
          desc={withReason(t("settings.sftpFileAssociations.desc"))}
        >
          <span className="nc-set-empty-row">
            <Icon name="file-type" size={14} />
            {t("settings.sftpFileAssociations.noAssociations")}
          </span>
        </Row>
      </Section>
    </div>
  );
}

export function ShortcutsTab() {
  const s = useSettings();
  const t = useT();
  const [recording, setRecording] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    beginHotkeyCapture();
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const b = captureBinding(e, s.hotkeyScheme);
      if (!b) return;
      updateSettings({
        customKeyBindings: {
          ...s.customKeyBindings,
          [recording]: { ...s.customKeyBindings[recording], [s.hotkeyScheme]: b },
        },
      });
      setRecording(null);
    };
    window.addEventListener("keydown", h, true);
    return () => {
      window.removeEventListener("keydown", h, true);
      endHotkeyCapture();
    };
  }, [recording, s.hotkeyScheme, s.customKeyBindings]);

  const disabledSet = new Set(s.disabledKeyBindings);
  const toggleDisabled = (id: string) => {
    const next = disabledSet.has(id)
      ? s.disabledKeyBindings.filter((x) => x !== id)
      : [...s.disabledKeyBindings, id];
    updateSettings({ disabledKeyBindings: next });
  };
  const resetOne = (b: KeyBinding) => {
    const cb = { ...s.customKeyBindings };
    delete cb[b.id];
    updateSettings({
      customKeyBindings: cb,
      disabledKeyBindings: s.disabledKeyBindings.filter((x) => x !== b.id),
    });
  };
  const resetAll = () => updateSettings({ customKeyBindings: {}, disabledKeyBindings: [] });

  return (
    <div className="nc-set-page">
      <Section title={t("settings.shortcuts.section.scheme")}>
        <Row
          title={t("settings.shortcuts.scheme.label")}
          desc={t("settings.shortcuts.scheme.desc")}
        >
          <div className="nc-set-theme-cards" role="radiogroup">
            {(["mac", "pc"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={s.hotkeyScheme === m}
                className={"nc-set-theme-card" + (s.hotkeyScheme === m ? " is-active" : "")}
                onClick={() => updateSettings({ hotkeyScheme: m })}
              >
                {t(`settings.shortcuts.scheme.${m}`)}
              </button>
            ))}
          </div>
        </Row>
        <Row
          title={t("settings.shortcuts.disableTerminalFontZoom")}
          desc={t("settings.shortcuts.disableTerminalFontZoom.desc")}
        >
          <Toggle
            checked={s.disableTerminalFontZoom}
            onChange={(v) => updateSettings({ disableTerminalFontZoom: v })}
          />
        </Row>
        <Row
          title={t("settings.shortcuts.shellOnlyTabNumberShortcuts")}
          desc={t("settings.shortcuts.shellOnlyTabNumberShortcuts.desc")}
        >
          <Toggle
            checked={s.shellOnlyTabNumberShortcuts}
            onChange={(v) => updateSettings({ shellOnlyTabNumberShortcuts: v })}
          />
        </Row>
        <Row
          title={t("settings.shortcuts.showTabNumberBadges")}
          desc={t("settings.shortcuts.showTabNumberBadges.desc")}
        >
          <Toggle
            checked={s.showTabNumberBadges}
            onChange={(v) => updateSettings({ showTabNumberBadges: v })}
          />
        </Row>
      </Section>

      {/* 自定义快捷键：标题 + 右侧 ghost「全部重置」，每个分类一张卡片（对照 Netcatty） */}
      <div className="nc-set-custom">
        <div className="nc-set-custom-head">
          <h3 className="nc-set-section-title">{t("settings.shortcuts.section.custom")}</h3>
          <button className="nc-set-btn is-ghost is-sm" onClick={resetAll}>
            <Icon name="rotate-ccw" size={12} />
            {t("settings.shortcuts.resetAll")}
          </button>
        </div>
        {BINDING_CATEGORY_ORDER.map((cat) => {
          const rows = DEFAULT_KEY_BINDINGS.filter((b) => b.category === cat);
          if (rows.length === 0) return null;
          return (
            <div key={cat} className="nc-set-section">
              <h4 className="nc-set-cat-title">{t(`settings.shortcuts.category.${cat}`)}</h4>
              <div className="nc-set-card">
                {rows.map((b) => {
                  const isDisabled = disabledSet.has(b.id);
                  const binding = effectiveBinding(b, s, s.hotkeyScheme);
                  // 绑定标签优先用 i18n（Netcatty zh-CN 为中文），缺键回落英文原标签。
                  const i18nKey = `settings.shortcuts.binding.${b.id}`;
                  const localized = t(i18nKey);
                  const label = localized === i18nKey ? b.label : localized;
                  const specialSuffix = binding.includes("[1...9]")
                    ? "[1...9]"
                    : binding.includes("arrows")
                      ? "arrows"
                      : null;
                  const modifierPrefix = specialSuffix
                    ? binding.replace(specialSuffix, "").trim().replace(/\+\s*$/, "").trim()
                    : null;
                  const recordingThis = recording === b.id;
                  const keycapText = recordingThis
                    ? t("settings.shortcuts.captureHint")
                    : isDisabled
                      ? t("settings.shortcuts.disabled")
                      : specialSuffix
                        ? modifierPrefix || t("settings.shortcuts.none")
                        : binding;
                  return (
                    <Row key={b.id} title={label} className="is-compact">
                      <div className="nc-set-inline">
                        {specialSuffix ? (
                          <>
                            <button
                              className={"nc-set-keycap" + (recordingThis ? " is-recording" : "")}
                              disabled={isDisabled}
                              onClick={() => setRecording(recordingThis ? null : b.id)}
                            >
                              {keycapText}
                            </button>
                            <span className="nc-set-keycap-plus">+</span>
                            <span className="nc-set-keycap-suffix">{specialSuffix}</span>
                          </>
                        ) : (
                          <button
                            className={"nc-set-keycap" + (recordingThis ? " is-recording" : "")}
                            disabled={isDisabled}
                            onClick={() => setRecording(recordingThis ? null : b.id)}
                          >
                            {keycapText}
                          </button>
                        )}
                        {!specialSuffix && (
                          <button
                            className="nc-set-icon-action"
                            title={
                              isDisabled
                                ? t("settings.shortcuts.setEnabled")
                                : t("settings.shortcuts.setDisabled")
                            }
                            aria-label={
                              isDisabled
                                ? t("settings.shortcuts.setEnabled")
                                : t("settings.shortcuts.setDisabled")
                            }
                            onClick={() => toggleDisabled(b.id)}
                          >
                            <Icon name="ban" size={12} />
                          </button>
                        )}
                        <button
                          className="nc-set-icon-action"
                          title={t("settings.shortcuts.resetToDefault")}
                          aria-label={t("settings.shortcuts.resetToDefault")}
                          onClick={() => resetOne(b)}
                        >
                          <Icon name="rotate-ccw" size={12} />
                        </button>
                      </div>
                    </Row>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 应用锁定（#23） ─────────────────────────────────────

type AppLockFormMode = "setup" | "change" | "disable" | null;

/**
 * 系统 tab 的应用锁定区（对照 Netcatty AppLockSettingsSection）。
 * 口令档位已移植；系统凭据（Touch ID / Windows Hello）无原生桥，置灰写明原因。
 */
function AppLockSection() {
  const t = useT();
  const lock = useAppLock();
  const [mode, setMode] = useState<AppLockFormMode>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode(null);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  };

  const errText = (e: unknown): string => {
    const { code } = decodeAppError(String(e));
    switch (code) {
      case "app_lock_incorrect_password":
        return t("settings.appLock.error.incorrect");
      case "app_lock_current_required":
        return t("settings.appLock.error.currentRequired");
      case "app_lock_password_required":
        return t("settings.appLock.error.empty");
      default:
        return t("settings.appLock.error.failed");
    }
  };

  const submitPassword = async () => {
    if (!next.trim()) {
      setError(t("settings.appLock.error.empty"));
      return;
    }
    if (next !== confirm) {
      setError(t("settings.appLock.error.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setAppLockPassword(lock.has_password ? current : null, next);
      reset();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitDisable = async () => {
    if (!current.trim()) {
      setError(t("settings.appLock.error.currentRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await disableAppLock(current);
      reset();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const status = !lock.has_password
    ? t("settings.appLock.status.noPassword")
    : lock.enabled
      ? t("settings.appLock.status.enabled")
      : t("settings.appLock.status.disabled");

  return (
    <Section title={t("settings.appLock.title")}>
      <Row title={t("settings.appLock.enabled")} desc={`${t("settings.appLock.enabledDesc")} · ${status}`}>
        <Toggle
          checked={lock.enabled}
          onChange={(v) => {
            setError(null);
            if (v && !lock.has_password) {
              setMode("setup");
              return;
            }
            if (v) {
              void setAppLockEnabled(true).catch((e) => setError(errText(e)));
            } else {
              setMode("disable");
            }
          }}
        />
      </Row>

      <Row title={t("settings.appLock.timeout")} desc={t("settings.appLock.timeoutDesc")}>
        <Select
          value={String(lock.timeout_minutes)}
          disabled={!lock.enabled}
          onChange={(v) => void setAppLockTimeout(Number(v)).catch((e) => setError(errText(e)))}
          options={[0, 1, 5, 15, 30, 60].map((m) => ({
            value: String(m),
            label: t(`settings.appLock.timeout.${m}`),
          }))}
        />
      </Row>

      <Row title={t("settings.appLock.currentPassword")} desc={status}>
        <div className="nc-set-inline">
          <button
            className="nc-set-btn"
            onClick={() => {
              setError(null);
              setMode(lock.has_password ? "change" : "setup");
            }}
          >
            {lock.has_password
              ? t("settings.appLock.changePassword")
              : t("settings.appLock.setPassword")}
          </button>
          <button
            className="nc-set-btn"
            disabled={!lock.enabled}
            onClick={() => lockNow()}
          >
            {t("settings.appLock.lockNow")}
          </button>
        </div>
      </Row>

      {mode !== null && (
        <div className="nc-applock-form">
          {mode !== "setup" && (
            <input
              className="nc-set-input"
              type="password"
              placeholder={t("settings.appLock.currentPassword")}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
          {mode !== "disable" && (
            <>
              <input
                className="nc-set-input"
                type="password"
                placeholder={t("settings.appLock.newPassword")}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              <input
                className="nc-set-input"
                type="password"
                placeholder={t("settings.appLock.confirmPassword")}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </>
          )}
          {error && <div className="nc-app-lock-error">{error}</div>}
          <div className="nc-set-inline">
            <button
              className={`nc-set-btn ${mode === "disable" ? "is-danger-solid" : "is-primary"}`}
              disabled={busy}
              onClick={() => void (mode === "disable" ? submitDisable() : submitPassword())}
            >
              {mode === "disable" ? t("settings.appLock.enabled") : t("settings.appLock.save")}
            </button>
            <button className="nc-set-btn" disabled={busy} onClick={reset}>
              {t("settings.appLock.cancel")}
            </button>
          </div>
        </div>
      )}

      <Row title={t("settings.appLock.systemUnlock")} desc={t("settings.appLock.systemUnlock.unsupported")}>
        <div className="nc-set-inline">
          <Toggle checked={false} disabled onChange={() => {}} />
          <span className="nc-set-value">{t("settings.appLock.systemUnlock.desc")}</span>
        </div>
      </Row>
    </Section>
  );
}

// ── 系统 ──────────────────────────────────────────────────

export function SystemTab() {
  const s = useSettings();
  const t = useT();
  const [autoLaunch, setAutoLaunchState] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [version, setVersion] = useState("—");
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  const refreshSecret = () => {
    secretBackend()
      .then(setSecret)
      .catch(() => setSecret(null));
  };
  const refreshStorage = () => {
    storageInfo()
      .then(setStorage)
      .catch(() => setStorage(null));
  };

  useEffect(() => {
    getAutoLaunch()
      .then(setAutoLaunchState)
      .catch(() => setAutoLaunchState({ supported: false, enabled: false }));
    refreshSecret();
    refreshStorage();
    appVersion()
      .then(setVersion)
      .catch(() => setVersion("—"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const secretStatus =
    secret === null
      ? t("settings.system.credentials.unavailable")
      : secret === "db"
        ? `${t("settings.system.credentials.availableDb")} · ${secret}`
        : `${t("settings.system.credentials.available")} · ${secret}`;

  return (
    <div className="nc-set-page">
      {/* 软件更新（对照 Netcatty 系统 tab 首节；更新器未移植） */}
      <Section
        title={t("settings.update.title")}
        hint={`${t("settings.update.notPorted")} · ${t("settings.update.source")}`}
      >
        <Row title={t("settings.update.currentVersion")}>
          <span className="nc-set-value">{version}</span>
        </Row>
        <Row title={t("settings.update.autoUpdate")} desc={t("settings.update.autoUpdate.desc")}>
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
        <div className="nc-set-actions">
          <button className="nc-set-btn" disabled title={t("settings.update.notPorted")}>
            <Icon name="refresh" size={16} />
            {t("settings.application.checkUpdates")}
          </button>
        </div>
      </Section>

      <Section title={t("settings.autoLaunch.title")}>
        <Row
          title={t("settings.autoLaunch.enabled")}
          desc={autoLaunch?.supported ? t("settings.autoLaunch.enabledDesc") : t("settings.autoLaunch.unsupportedDesc")}
        >
          <Toggle
            checked={autoLaunch?.enabled ?? false}
            disabled={!autoLaunch?.supported}
            onChange={(v) => {
              setAutoLaunch(v)
                .then(setAutoLaunchState)
                // 后端拒绝（注册表写失败 / headless）时回读真实状态，避免开关停错位置。
                .catch(() => getAutoLaunch().then(setAutoLaunchState).catch(() => {}));
            }}
          />
        </Row>
      </Section>

      <Section title={t("settings.system.networkProxy.title")} hint={t("settings.system.networkProxy.hint")}>
        <Row
          title={t("settings.system.networkProxy.mode")}
          desc={t("settings.system.networkProxy.description")}
        >
          <Select
            value={s.networkProxy.mode}
            onChange={(v) =>
              updateSettings({ networkProxy: { ...s.networkProxy, mode: v as typeof s.networkProxy.mode } })
            }
            options={[
              { value: "system", label: t("settings.system.networkProxy.mode.system") },
              { value: "direct", label: t("settings.system.networkProxy.mode.direct") },
              { value: "custom", label: t("settings.system.networkProxy.mode.custom") },
            ]}
          />
        </Row>
        {s.networkProxy.mode === "custom" && (
          <>
            <Row title={t("settings.system.networkProxy.url")} desc={t("settings.system.networkProxy.url.desc")}>
              <input
                className="nc-set-input"
                placeholder={t("settings.system.networkProxy.url.placeholder")}
                value={s.networkProxy.url}
                onChange={(e) => updateSettings({ networkProxy: { ...s.networkProxy, url: e.target.value } })}
              />
            </Row>
            <Row title={t("settings.system.networkProxy.bypass")} desc={t("settings.system.networkProxy.bypass.desc")}>
              <input
                className="nc-set-input"
                placeholder={t("settings.system.networkProxy.bypass.placeholder")}
                value={s.networkProxy.bypass}
                onChange={(e) => updateSettings({ networkProxy: { ...s.networkProxy, bypass: e.target.value } })}
              />
            </Row>
          </>
        )}
      </Section>

      <Section title={t("settings.system.credentials.title")}>
        <Row title={t("settings.system.credentials.desc")}>
          <div className="nc-set-inline">
            <span className="nc-set-value">{secretStatus}</span>
            <button className="nc-set-btn" onClick={refreshSecret}>
              {t("settings.system.credentials.refresh")}
            </button>
          </div>
        </Row>
      </Section>

      <Section title={t("settings.system.storage.title")} hint={t("settings.system.storage.hint")}>
        <Row title={t("settings.system.storage.dataDir")}>
          <div className="nc-set-inline">
            <span className="nc-set-value" title={storage?.data_dir}>
              {storage?.data_dir ?? "—"}
            </span>
            <button className="nc-set-btn" onClick={refreshStorage}>
              {t("settings.system.storage.refresh")}
            </button>
          </div>
        </Row>
        <Row title={t("settings.system.storage.dbPath")}>
          <span className="nc-set-value" title={storage?.db_path}>
            {storage?.db_path ?? "—"}
          </span>
        </Row>
      </Section>

      <Section title={t("settings.system.crashLogs.title")} hint={t("settings.system.crashLogs.notPorted")}>
        <p className="nc-set-card-text">{t("settings.system.crashLogs.description")}</p>
        <p className="nc-set-empty">{t("settings.system.crashLogs.noLogs")}</p>
      </Section>

      <Section title={t("settings.sessionRestore.title")}>
        <Row title={t("settings.sessionRestore.startupLanding")}>
          <span className="nc-set-value">{t("settings.sessionRestore.startupLandingDesc")}</span>
        </Row>
        <Row
          title={t("settings.sessionRestore.restorePreviousSession")}
          desc={t("settings.sessionRestore.restorePreviousSessionDesc")}
        >
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
        <Row
          title={t("settings.sessionRestore.restoreTerminalCwd")}
          desc={t("settings.sessionRestore.restoreTerminalCwdDesc")}
        >
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
      </Section>

      <Section title={t("settings.sshDeepLink.title")}>
        <Row title={t("settings.sshDeepLink.enable")} desc={t("settings.sshDeepLink.enableDesc")}>
          <Toggle checked disabled onChange={() => {}} />
        </Row>
      </Section>

      <Section title={t("settings.jmsDeepLink.title")}>
        <Row title={t("settings.jmsDeepLink.enable")} desc={t("settings.jmsDeepLink.enableDesc")}>
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
      </Section>

      <Section title={t("settings.explorerContextMenu.title")}>
        <Row title={t("settings.explorerContextMenu.enable")} desc={t("settings.explorerContextMenu.enableDesc")}>
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
      </Section>

      <Section title={t("settings.sshDebugLogs.title")}>
        <Row title={t("settings.sshDebugLogs.enable")} desc={t("settings.sshDebugLogs.enableDesc")}>
          <Toggle
            checked={s.sshDebugLogsEnabled}
            onChange={(v) => {
              updateSettings({ sshDebugLogsEnabled: v });
              // 后端读取 db 键 verbose_log 决定是否记录 SSH 调试日志，需同步写入。
              void setSetting("verbose_log", v ? "true" : "false").catch(() => {});
            }}
          />
        </Row>
      </Section>

      <Section title={t("settings.globalHotkey.title")}>
        <Row title={t("settings.globalHotkey.enabled")} desc={t("settings.globalHotkey.enabledDesc")}>
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
        <Row title={t("settings.globalHotkey.closeToTray")} desc={t("settings.globalHotkey.closeToTrayDesc")}>
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
        <Row title={t("settings.globalHotkey.showTrayIcon")} desc={t("settings.globalHotkey.showTrayIconDesc")}>
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
      </Section>

      <Section title={t("settings.system.tempDir.title")} hint={t("settings.system.tempDir.notPorted")}>
        <Row title={t("settings.system.tempDir.openFolder")} desc={t("settings.system.tempDir.openFolderDesc")}>
          <button className="nc-set-btn" disabled>
            <Icon name="folder-open" size={16} />
            {t("settings.system.tempDir.openFolder")}
          </button>
        </Row>
      </Section>

      {/* 应用锁定（#23；对照 Netcatty 系统 tab AppLockSettingsSection） */}
      <AppLockSection />
    </div>
  );
}

// ── 同步与云 ──────────────────────────────────────────────

/** 同步能力本体在 Vault「同步」页；设置中心只做说明与跳转。 */
export function SyncTab({ onOpenSync }: { onOpenSync?: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon="cloud"
      title={t("settings.tab.sync")}
      desc={t("settings.sync.desc")}
      action={
        <button className="nc-set-btn is-primary" disabled={!onOpenSync} onClick={onOpenSync}>
          <Icon name="cloud" size={16} />
          {t("settings.sync.open")}
        </button>
      }
    />
  );
}

// ── 占位 ──────────────────────────────────────────────────

/** 空状态：对照 Netcatty LazyTab 的居中空态（图标 + 标题 + 说明 + 操作）。 */
function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: IconName;
  title: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="nc-set-empty-state">
      <div className="nc-set-empty-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="nc-set-empty-title">{title}</div>
      {desc && <p className="nc-set-empty-desc">{desc}</p>}
      {action && <div className="nc-set-empty-actions">{action}</div>}
    </div>
  );
}

export function PlaceholderTab({ tab }: { tab: "ai" }) {
  const t = useT();
  return (
    <EmptyState
      icon="sparkles"
      title={t("settings.tab.ai")}
      desc={t(`settings.placeholder.${tab}`)}
    />
  );
}
