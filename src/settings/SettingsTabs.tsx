/**
 * 设置中心各 tab 组件（应用 / 外观 / 终端 / 快捷键 / 系统 + 占位）。
 *
 * 分区顺序、字段、默认值对照 Netcatty Settings*Tab.tsx 与 zh-CN 文案；
 * 未移植能力的控件保留但禁用 / 标注（范围决策见 changelogs 2026-11-03）。
 */

import { useEffect, useState } from "react";
import {
  appVersion,
  getAutoLaunch,
  listFonts,
  secretBackend,
  setAutoLaunch,
  setSetting,
  type FontInfo,
} from "../backend/client";
import { settingsT } from "./i18n";
import {
  BINDING_CATEGORY_ORDER,
  DEFAULT_KEY_BINDINGS,
  captureBinding,
  effectiveBinding,
  type KeyBinding,
} from "./keyBindings";
import { updateSettings, useSettings } from "./settingsStore";

type TFn = (k: string, p?: Record<string, string | number>) => string;

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
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <div className="nc-set-stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>
        −
      </button>
      <span>
        {value}
        {suffix}
      </span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>
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

  useEffect(() => {
    appVersion()
      .then(setVersion)
      .catch(() => setVersion("—"));
  }, []);

  const copy = (key: string, url: string) => {
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {});
  };

  return (
    <div>
      <Section title={t("settings.update.title")}>
        <Row title={t("settings.update.currentVersion")}>
          <span className="nc-set-value">{version}</span>
        </Row>
        <Row title={t("settings.application.checkUpdates")}>
          <button className="nc-set-btn" disabled title={t("settings.update.notPorted")}>
            {t("settings.application.checkUpdates")}
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
    { value: "system", label: t("settings.appearance.fonts.systemFont") },
    ...fonts.map((f) => ({ value: `local-${f.family}`, label: f.family })),
  ];

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
          <Select
            value={s.uiFontFamilyId}
            onChange={(v) => updateSettings({ uiFontFamilyId: v })}
            options={fontOptions}
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
          </div>
        </Row>
        <Row
          title={t("settings.appearance.window.backgroundBlur")}
          desc={t("settings.appearance.window.backgroundBlur.desc")}
        >
          <Toggle
            checked={s.windowBackgroundBlur}
            onChange={(v) => updateSettings({ windowBackgroundBlur: v })}
          />
        </Row>
      </Section>

      <Section title={t("settings.appearance.section.theme")}>
        <Row title={t("settings.appearance.theme.mode")}>
          <div className="nc-set-theme-cards" role="radiogroup">
            {(["light", "dark", "system"] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={s.theme === m}
                className={"nc-set-theme-card" + (s.theme === m ? " is-active" : "")}
                onClick={() => updateSettings({ theme: m })}
              >
                {t(`settings.appearance.theme.${m}`)}
              </button>
            ))}
          </div>
        </Row>
        <Row title={t("settings.appearance.theme.lightTheme")} desc={t("settings.appearance.theme.notPorted")}>
          <Select
            value={s.lightUiThemeId}
            onChange={(v) => updateSettings({ lightUiThemeId: v })}
            options={[{ value: "snow", label: "Snow" }]}
          />
        </Row>
        <Row title={t("settings.appearance.theme.darkTheme")} desc={t("settings.appearance.theme.notPorted")}>
          <Select
            value={s.darkUiThemeId}
            onChange={(v) => updateSettings({ darkUiThemeId: v })}
            options={[{ value: "midnight", label: "Midnight" }]}
          />
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
          <Row title={t("settings.appearance.accent.customColor")}>
            <input
              type="color"
              className="nc-set-color"
              value={/^#[0-9a-fA-F]{6}$/.test(s.customAccent) ? s.customAccent : "#3b82f6"}
              onChange={(e) => updateSettings({ customAccent: e.target.value })}
            />
          </Row>
        )}
      </Section>

      <Section title={t("settings.appearance.section.icon")}>
        <Row
          title={t("settings.appearance.icon.appIconVariant")}
          desc={`${t("settings.appearance.icon.appIconVariant.desc")} ${t("settings.appearance.icon.notPorted")}`}
        >
          <Select
            value={s.appIconVariant}
            onChange={(v) => updateSettings({ appIconVariant: v })}
            options={(["original", "bright", "dark", "colorful", "highContrast"] as const).map((v) => ({
              value: v,
              label: t(`settings.appearance.icon.appIconVariant.${v}`),
            }))}
          />
        </Row>
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
          desc={t("settings.vault.autoImportSystemKnownHostsDesc")}
        >
          <Toggle
            checked={s.autoImportSystemKnownHosts}
            onChange={(v) => updateSettings({ autoImportSystemKnownHosts: v })}
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
    label: `${w.value} · ${t(`settings.terminal.font.weight.${w.key}`)}`,
  }));

  return (
    <div>
      <Section title={t("settings.terminal.section.font")}>
        <Row title={t("settings.terminal.font.family")} desc={t("settings.terminal.font.family.desc")}>
          <Select
            value={s.terminalFontFamilyId}
            onChange={(v) => updateSettings({ terminalFontFamilyId: v })}
            options={fontOptions}
          />
        </Row>
        <Row title={t("settings.terminal.font.cjk")} desc={t("settings.terminal.font.cjk.desc")}>
          <Select value={term.fallbackFont} onChange={(v) => patch({ fallbackFont: v })} options={cjkOptions} />
        </Row>
        <Row title={t("settings.terminal.font.size")} desc={t("settings.terminal.font.size.desc")}>
          <Stepper
            value={s.terminalFontSize}
            onChange={(v) => updateSettings({ terminalFontSize: v })}
            min={8}
            max={32}
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
        <Row title={t("settings.terminal.font.linePadding")} desc={t("settings.terminal.font.linePadding.desc")}>
          <Stepper value={term.linePadding} onChange={(v) => patch({ linePadding: v })} min={0} max={10} />
        </Row>
        <Row title={t("settings.terminal.font.emulationType")}>
          <Select
            value={term.terminalEmulationType}
            onChange={(v) => patch({ terminalEmulationType: v })}
            options={[
              { value: "xterm-256color", label: "xterm-256color" },
              { value: "xterm", label: "xterm" },
              { value: "vt100", label: "vt100" },
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
        <Row title={t("settings.terminal.cursor.barWidth")} desc={t("settings.terminal.cursor.barWidth.desc")}>
          <Stepper value={term.cursorBarWidth} onChange={(v) => patch({ cursorBarWidth: v })} min={1} max={4} />
        </Row>
        <Row title={t("settings.terminal.cursor.blink")}>
          <Toggle checked={term.cursorBlink} onChange={(v) => patch({ cursorBlink: v })} />
        </Row>
        <Row title={t("settings.terminal.cursor.highlightLine")} desc={t("settings.terminal.cursor.highlightLine.desc")}>
          <Toggle checked={term.highlightCursorLine} onChange={(v) => patch({ highlightCursorLine: v })} />
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
            value={term.disconnectPrompt ? "dialog" : "terminal"}
            onChange={(v) => patch({ disconnectPrompt: v === "dialog" })}
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
              { value: "paste", label: t("settings.terminal.behavior.rightClick.paste") },
              { value: "menu", label: t("settings.terminal.behavior.rightClick.menu") },
              { value: "none", label: t("settings.terminal.behavior.middleClick.disabled") },
            ]}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.middleClick")} desc={t("settings.terminal.behavior.middleClick.desc")}>
          <Select
            value={term.middleClickBehavior}
            onChange={(v) => patch({ middleClickBehavior: v as typeof term.middleClickBehavior })}
            options={[
              { value: "paste", label: t("settings.terminal.behavior.middleClick.paste") },
              { value: "copy", label: t("settings.terminal.behavior.copyOnSelect") },
              { value: "none", label: t("settings.terminal.behavior.middleClick.disabled") },
            ]}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.copyOnSelect")} desc={t("settings.terminal.behavior.copyOnSelect.desc")}>
          <Toggle checked={term.copyOnSelect} onChange={(v) => patch({ copyOnSelect: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.wordSeparators")} desc={t("settings.terminal.behavior.wordSeparators.desc")}>
          <input
            className="nc-set-input"
            value={term.wordSeparators}
            onChange={(e) => patch({ wordSeparators: e.target.value })}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.scrollback")} desc={t("settings.terminal.behavior.scrollback.desc")}>
          <input
            className="nc-set-input nc-set-input-num"
            type="number"
            min={100}
            max={1000000}
            value={term.scrollback}
            onChange={(e) => patch({ scrollback: Math.max(100, Number(e.target.value) || 10000) })}
          />
        </Row>
        <Row title={t("settings.terminal.behavior.altAsMeta")} desc={t("settings.terminal.behavior.altAsMeta.desc")}>
          <Toggle checked={term.altAsMeta} onChange={(v) => patch({ altAsMeta: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.scrollOnInput")}>
          <Toggle checked={term.scrollOnInput} onChange={(v) => patch({ scrollOnInput: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.scrollOnOutput")}>
          <Toggle checked={term.scrollOnOutput} onChange={(v) => patch({ scrollOnOutput: v })} />
        </Row>
        <Row title={t("settings.terminal.behavior.shiftEnter")} desc={t("settings.terminal.behavior.shiftEnter.desc")}>
          <div className="nc-set-inline">
            <Toggle
              checked={term.shiftEnterNewlineEnabled}
              onChange={(v) => patch({ shiftEnterNewlineEnabled: v })}
            />
            <input
              className="nc-set-input"
              disabled={!term.shiftEnterNewlineEnabled}
              value={term.shiftEnterNewlineText}
              onChange={(e) => patch({ shiftEnterNewlineText: e.target.value })}
            />
          </div>
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
            options={["sftp", "scripts", "history", "theme", "system", "notes", "ai"].map((p) => ({
              value: p,
              label: t(`settings.terminal.sidePanel.pane.${p}`),
            }))}
          />
        </Row>
      </Section>

      <Section title={t("settings.terminal.section.localShellSidePanel")}>
        <Row
          title={t("settings.terminal.localShellSidePanel.autoOpen")}
          desc={t("settings.terminal.localShellSidePanel.autoOpen.desc")}
        >
          <Toggle
            checked={s.localShellSidePanelAutoOpen}
            onChange={(v) => updateSettings({ localShellSidePanelAutoOpen: v })}
          />
        </Row>
        <Row
          title={t("settings.terminal.localShellSidePanel.autoOpenPane")}
          desc={t("settings.terminal.localShellSidePanel.autoOpenPane.desc")}
        >
          <Select
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
    </div>
  );
}

// ── 快捷键 ────────────────────────────────────────────────

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
      <Section title={t("settings.tab.shortcuts")}>
        <Row title={t("settings.shortcuts.scheme")}>
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
        <Row title={t("settings.shortcuts.disableTerminalFontZoom")}>
          <Toggle
            checked={s.disableTerminalFontZoom}
            onChange={(v) => updateSettings({ disableTerminalFontZoom: v })}
          />
        </Row>
        <Row title={t("settings.shortcuts.shellOnlyTabNumberShortcuts")}>
          <Toggle
            checked={s.shellOnlyTabNumberShortcuts}
            onChange={(v) => updateSettings({ shellOnlyTabNumberShortcuts: v })}
          />
        </Row>
        <Row title={t("settings.shortcuts.showTabNumberBadges")}>
          <Toggle
            checked={s.showTabNumberBadges}
            onChange={(v) => updateSettings({ showTabNumberBadges: v })}
          />
        </Row>
        <Row title={t("settings.shortcuts.resetAll")}>
          <button className="nc-set-btn" onClick={resetAll}>
            {t("settings.shortcuts.resetAll")}
          </button>
        </Row>
      </Section>

      {BINDING_CATEGORY_ORDER.map((cat) => {
        const rows = DEFAULT_KEY_BINDINGS.filter((b) => b.category === cat);
        if (rows.length === 0) return null;
        return (
          <Section key={cat} title={t(`settings.shortcuts.category.${cat}`)}>
            {rows.map((b) => {
              const isDisabled = disabledSet.has(b.id);
              const binding = effectiveBinding(b, s, s.hotkeyScheme);
              return (
                <Row key={b.id} title={b.label}>
                  <div className="nc-set-inline">
                    <button
                      className={"nc-set-keycap" + (recording === b.id ? " is-recording" : "")}
                      disabled={isDisabled}
                      onClick={() => setRecording(recording === b.id ? null : b.id)}
                    >
                      {recording === b.id ? t("settings.shortcuts.captureHint") : isDisabled ? t("settings.shortcuts.disabled") : binding}
                    </button>
                    <Toggle checked={!isDisabled} onChange={() => toggleDisabled(b.id)} />
                    <button className="nc-set-btn" onClick={() => resetOne(b)} title={t("settings.shortcuts.resetToDefault")}>
                      ↺
                    </button>
                  </div>
                </Row>
              );
            })}
          </Section>
        );
      })}
    </div>
  );
}

// ── 系统 ──────────────────────────────────────────────────

export function SystemTab() {
  const s = useSettings();
  const t = useT();
  const [autoLaunch, setAutoLaunchState] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

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
                .catch(() => {});
            }}
          />
        </Row>
      </Section>

      <Section title={t("settings.system.networkProxy.title")}>
        <Row title={t("settings.system.networkProxy.description")}>
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
      </Section>

      <Section title={t("settings.sshDebugLogs.title")}>
        <Row title={t("settings.sshDebugLogs.enable")} desc={t("settings.sshDebugLogs.enableDesc")}>
          <Toggle checked={s.sshDebugLogsEnabled} onChange={(v) => updateSettings({ sshDebugLogsEnabled: v })} />
        </Row>
      </Section>

      <Section title={t("settings.system.tempDir.title")}>
        <Row title={t("settings.system.tempDir.notPorted")} />
      </Section>

      <Section title={t("settings.appLock.title")}>
        <Row title={t("settings.appLock.notPorted")} />
      </Section>
    </div>
  );
}

// ── 占位 ──────────────────────────────────────────────────

export function PlaceholderTab({ tab }: { tab: "file-associations" | "ai" | "sync" }) {
  const t = useT();
  return (
    <div className="nc-set-placeholder">
      <p>{t(`settings.placeholder.${tab === "file-associations" ? "fileAssociations" : tab}`)}</p>
    </div>
  );
}
