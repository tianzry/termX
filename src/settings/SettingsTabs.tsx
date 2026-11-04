/**
 * 设置中心各 tab 组件（应用 / 外观 / 终端 / 快捷键 / 系统 + 占位）。
 *
 * 分区顺序、字段、默认值对照 Netcatty Settings*Tab.tsx 与 zh-CN 文案；
 * 未移植能力的控件保留但禁用 / 标注（范围决策见 changelogs 2026-11-03）。
 */

import { useEffect, useRef, useState } from "react";
import {
  appVersion,
  checkUpdate,
  getAutoLaunch,
  listFonts,
  secretBackend,
  setAutoLaunch,
  setSetting,
  type FontInfo,
  type UpdateCheckResult,
} from "../backend/client";
import { Icon } from "../ui/icons";
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
import type { AppIconVariant } from "./settingsModel";
import {
  MAX_SFTP_TRANSFER_CONCURRENCY,
  MAX_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_SCROLLBACK,
  MIN_SFTP_TRANSFER_CONCURRENCY,
  MIN_TERMINAL_FONT_SIZE,
  clampCursorBarWidth,
  clampScrollback,
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="nc-set-section">
      <h3 className="nc-set-section-title">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="nc-set-row">
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
    <div>
      <Section title={t("settings.update.title")}>
        <Row title={t("settings.update.currentVersion")}>
          <span className="nc-set-value">{version}</span>
        </Row>
        <Row title={t("settings.application.checkUpdates")} desc={updateStatus ?? undefined}>
          <button
            className="nc-set-btn"
            disabled={checkState.status === "checking" || version === "—"}
            onClick={() => void check()}
          >
            {checkState.status === "checking"
              ? t("settings.update.checking")
              : t("settings.application.checkUpdates")}
          </button>
        </Row>
        {checkState.status === "done" && checkState.result && (
          <>
            <Row title={t("settings.update.latestVersion")}>
              <span className="nc-set-value">v{checkState.result.latest_version}</span>
            </Row>
            <Row
              title={t("settings.update.platform")}
              desc={
                checkState.result.platform_supported
                  ? undefined
                  : t("settings.update.noPlatform")
              }
            >
              <span className="nc-set-value">{checkState.result.platform}</span>
            </Row>
            {checkState.result.notes && (
              <Row title={t("settings.update.notes")}>
                <span className="nc-set-value">{checkState.result.notes}</span>
              </Row>
            )}
          </>
        )}
        {checkState.status === "error" && (
          <Row title={t("settings.update.checkFailed")} desc={checkState.error}>
            <span />
          </Row>
        )}
        <Row
          title={t("settings.update.install")}
          desc={t("settings.update.installMissing")}
        >
          <button className="nc-set-btn" disabled>
            {t("settings.update.install")}
          </button>
        </Row>
      </Section>
      <Section title={t("settings.tab.application")}>
        {APP_LINKS.map((l) => (
          <Row
            key={l.key}
            title={t(`settings.application.${l.key}`)}
            desc={t(`settings.application.${l.key}.subtitle`)}
          >
            <button
              className="nc-set-btn"
              title={t("settings.application.copyLink")}
              onClick={() => copy(l.key, l.url)}
            >
              {copied === l.key ? t("settings.application.copied") : "→"}
            </button>
          </Row>
        ))}
      </Section>
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
    <div>
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
      </Section>

      <Section title={t("settings.appearance.section.fonts")}>
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
          <div className="nc-set-slider">
            <input
              type="range"
              min={50}
              max={100}
              value={Math.round(s.windowOpacity * 100)}
              onChange={(e) => updateSettings({ windowOpacity: Number(e.target.value) / 100 })}
            />
            <span className="nc-set-value">{Math.round(s.windowOpacity * 100)}%</span>
            {/* 快捷预设（对照 Netcatty 透明度行 100% / 85% / 70% 按钮） */}
            {[100, 85, 70].map((p) => (
              <button
                key={p}
                type="button"
                className="nc-set-btn"
                onClick={() => updateSettings({ windowOpacity: p / 100 })}
              >
                {p}%
              </button>
            ))}
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
      </Section>

      <Section title={t("settings.appearance.section.accent")}>
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
    <div>
      {/* 终端主题（对照 Netcatty settings.terminal.theme.followApp） */}
      <Section title={t("settings.terminal.section.theme")}>
        <Row
          title={t("settings.terminal.theme.followApp")}
          desc={t("settings.terminal.theme.followApp.desc")}
        >
          <Toggle checked={term.followAppTheme} onChange={(v) => patch({ followAppTheme: v })} />
        </Row>
        {!term.followAppTheme && <Row title={t("settings.terminal.theme.fixedDarkHint")} />}
      </Section>

      {/* 内嵌图片（对照 Netcatty inlineImages：Kitty / SIXEL / iTerm IIP） */}
      <Section title={t("settings.terminal.section.inlineImages")}>
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
            <Row title={t("settings.terminal.inlineImages.hibernateNote")} />
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

      <Section title={t("settings.terminal.section.keyboard")}>
        <Row title={t("settings.terminal.keyboard.altAsMeta")} desc={t("settings.terminal.keyboard.altAsMeta.desc")}>
          <Toggle checked={term.altAsMeta} onChange={(v) => patch({ altAsMeta: v })} />
        </Row>
        <Row title={t("settings.terminal.keyboard.optionArrowWordJump")} desc={t("settings.terminal.keyboard.optionArrowWordJump.desc")}>
          <Toggle
            checked={term.optionArrowWordJump}
            onChange={(v) => patch({ optionArrowWordJump: v })}
          />
        </Row>
        <Row title={t("settings.terminal.keyboard.kittyProtocol")} desc={`${t("settings.terminal.keyboard.kittyProtocol.desc")} ${t("settings.terminal.unsupported.kitty")}`}>
          <Toggle disabled checked={false} onChange={() => {}} />
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

      <Section title={t("settings.terminal.section.sidePanel")}>
        <Row title={t("settings.terminal.sidePanel.autoOpen")} desc={t("settings.terminal.sidePanel.autoOpen.desc")}>
          <Toggle checked={s.sidePanelAutoOpen} onChange={(v) => updateSettings({ sidePanelAutoOpen: v })} />
        </Row>
        <Row title={t("settings.terminal.sidePanel.autoOpenPane")} desc={t("settings.terminal.sidePanel.autoOpenPane.desc")}>
          <Select
            value={s.sidePanelAutoOpenPane}
            onChange={(v) => updateSettings({ sidePanelAutoOpenPane: v })}
            options={["sftp", "scripts", "history", "theme", "system", "notes", "ai", "browser"].map((p) => ({
              value: p,
              label: t(`settings.terminal.sidePanel.pane.${p}`),
            }))}
          />
        </Row>
        <Row title={t("settings.terminal.sidePanel.unavailableHint")} />
      </Section>

      <Section title={t("settings.terminal.section.localShellSidePanel")}>
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
        <Row title={t("settings.terminal.localShellSidePanel.unavailableHint")} />
      </Section>

      <Section title={t("settings.terminal.section.connection")}>
        <Row
          title={t("settings.terminal.connection.verifyHostKeys")}
          desc={t("settings.terminal.connection.verifyHostKeys.desc")}
        >
          <Toggle checked={s.verifyHostKeys} onChange={(v) => updateSettings({ verifyHostKeys: v })} />
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
    <div>
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
          <Toggle
            checked={s.sidePanelAutoOpen}
            onChange={(v) => updateSettings({ sidePanelAutoOpen: v })}
          />
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
          <span className="nc-set-row-desc">
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
    return () => window.removeEventListener("keydown", h, true);
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
    <div>
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

      <Section title={t("settings.shortcuts.section.custom")}>
        <Row title={t("settings.shortcuts.resetAll")}>
          <button className="nc-set-btn" onClick={resetAll}>
            {t("settings.shortcuts.resetAll")}
          </button>
        </Row>
        {BINDING_CATEGORY_ORDER.map((cat) => {
          const rows = DEFAULT_KEY_BINDINGS.filter((b) => b.category === cat);
          if (rows.length === 0) return null;
          return (
            <div key={cat}>
              <div className="nc-set-group-title">{t(`settings.shortcuts.category.${cat}`)}</div>
              {rows.map((b) => {
                const isDisabled = disabledSet.has(b.id);
                const binding = effectiveBinding(b, s, s.hotkeyScheme);
                // 绑定标签优先用 i18n（Netcatty zh-CN 为中文），缺键回落英文原标签。
                const i18nKey = `settings.shortcuts.binding.${b.id}`;
                const localized = t(i18nKey);
                const label = localized === i18nKey ? b.label : localized;
                return (
                  <Row key={b.id} title={label}>
                    <div className="nc-set-inline">
                      <button
                        className={"nc-set-keycap" + (recording === b.id ? " is-recording" : "")}
                        disabled={isDisabled}
                        onClick={() => setRecording(recording === b.id ? null : b.id)}
                      >
                        {recording === b.id
                          ? t("settings.shortcuts.captureHint")
                          : isDisabled
                            ? t("settings.shortcuts.disabled")
                            : binding}
                      </button>
                      <button className="nc-set-btn" onClick={() => toggleDisabled(b.id)}>
                        {isDisabled
                          ? t("settings.shortcuts.setEnabled")
                          : t("settings.shortcuts.setDisabled")}
                      </button>
                      <button className="nc-set-btn" onClick={() => resetOne(b)}>
                        {t("settings.shortcuts.resetToDefault")}
                      </button>
                    </div>
                  </Row>
                );
              })}
            </div>
          );
        })}
      </Section>
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
              className="nc-set-btn"
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

  const refreshSecret = () => {
    secretBackend()
      .then(setSecret)
      .catch(() => setSecret(null));
  };

  useEffect(() => {
    getAutoLaunch()
      .then(setAutoLaunchState)
      .catch(() => setAutoLaunchState({ supported: false, enabled: false }));
    refreshSecret();
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
    <div>
      {/* 软件更新（对照 Netcatty 系统 tab 首节；更新器未移植） */}
      <Section title={t("settings.update.title")}>
        <Row title={t("settings.update.currentVersion")}>
          <div className="nc-set-inline">
            <span className="nc-set-value">{version}</span>
            <button className="nc-set-btn" disabled title={t("settings.update.notPorted")}>
              {t("settings.application.checkUpdates")}
            </button>
          </div>
        </Row>
        <Row title={t("settings.update.autoUpdate")} desc={t("settings.update.autoUpdate.desc")}>
          <Toggle checked={false} disabled onChange={() => {}} />
        </Row>
        <Row title={t("settings.update.source")} />
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

      <Section title={t("settings.system.networkProxy.title")}>
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
        <Row title={t("settings.system.networkProxy.hint")} />
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

      <Section title={t("settings.system.crashLogs.title")}>
        <Row title={t("settings.system.crashLogs.description")}>
          <span className="nc-set-value">{t("settings.system.crashLogs.noLogs")}</span>
        </Row>
        <Row title={t("settings.system.crashLogs.notPorted")} />
      </Section>

      <Section title={t("settings.sessionLogs.title")}>
        <Row title={t("settings.sessionLogs.description")} />
        <Row title={t("settings.sessionLogs.enableAutoSave")} desc={t("settings.sessionLogs.enableAutoSaveDesc")}>
          <Toggle
            checked={s.sessionLogs.enabled}
            onChange={(v) => {
              updateSettings({ sessionLogs: { ...s.sessionLogs, enabled: v } });
              // termX 的会话记录由后端 asciicast 录制实现，同步既有开关键。
              void setSetting("recording_enabled", v ? "true" : "false").catch(() => {});
            }}
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
        <Row title={t("settings.sessionLogs.timestamps")} desc={t("settings.sessionLogs.timestampsDesc")}>
          <Toggle
            checked={s.sessionLogs.timestamps}
            onChange={(v) => updateSettings({ sessionLogs: { ...s.sessionLogs, timestamps: v } })}
          />
        </Row>
        <Row title={t("settings.sessionLogs.hint")} />
        <Row title={t("settings.sessionLogs.directory")}>
          <span className="nc-set-value">{t("settings.sessionLogs.directoryDesc")}</span>
        </Row>
        <Row title={t("settings.sessionLogs.clearAll")} desc={t("settings.sessionLogs.clearAllDesc")}>
          <button className="nc-set-btn" disabled>
            {t("settings.sessionLogs.clearAll")}
          </button>
        </Row>
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
          <Toggle checked={s.sshDebugLogsEnabled} onChange={(v) => updateSettings({ sshDebugLogsEnabled: v })} />
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

      <Section title={t("settings.system.tempDir.title")}>
        <Row title={t("settings.system.tempDir.notPorted")} />
        <Row title={t("settings.system.tempDir.openFolder")} desc={t("settings.system.tempDir.openFolderDesc")}>
          <button className="nc-set-btn" disabled>
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
    <div className="nc-set-placeholder">
      <p>{t("settings.sync.desc")}</p>
      <button className="nc-set-btn" disabled={!onOpenSync} onClick={onOpenSync}>
        <Icon name="cloud" size={14} />
        {t("settings.sync.open")}
      </button>
    </div>
  );
}

// ── 占位 ──────────────────────────────────────────────────

export function PlaceholderTab({ tab }: { tab: "ai" }) {
  const t = useT();
  return (
    <div className="nc-set-placeholder">
      <p>{t(`settings.placeholder.${tab}`)}</p>
    </div>
  );
}
