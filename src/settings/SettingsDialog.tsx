/**
 * 设置中心外壳：全屏 overlay 承载（Netcatty 为独立窗口，形态差异已记录）。
 * 结构 1:1 对照 Netcatty SettingsPage.tsx：标题 + 关闭、左侧导航
 * （搜索控件 + 纵向 TabsList）、右侧内容区。
 *
 * plugins tab 在 Netcatty 里仅当 pluginRuntimeAvailable 时渲染；termX 无
 * 插件运行时，等价于不渲染。file-associations / ai / sync 为占位 tab。
 */

import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../ui/icons";
import { settingsT } from "./i18n";
import { useSettings } from "./settingsStore";
import {
  AppearanceTab,
  ApplicationTab,
  PlaceholderTab,
  ShortcutsTab,
  SystemTab,
  TerminalTab,
} from "./SettingsTabs";

export type SettingsTabId =
  | "application"
  | "appearance"
  | "terminal"
  | "shortcuts"
  | "file-associations"
  | "ai"
  | "sync"
  | "system";

interface TabDef {
  id: SettingsTabId;
  icon: IconName;
  disabled?: boolean;
}

/** 顺序对照 Netcatty SettingsPage TABS（plugins 条件不满足不渲染）。 */
const TABS: TabDef[] = [
  { id: "application", icon: "monitor" },
  { id: "appearance", icon: "palette" },
  { id: "terminal", icon: "terminal-square" },
  { id: "shortcuts", icon: "keyboard" },
  { id: "file-associations", icon: "file-type", disabled: true },
  { id: "ai", icon: "sparkles", disabled: true },
  { id: "sync", icon: "cloud", disabled: true },
  { id: "system", icon: "hard-drive" },
];

export function SettingsDialog({
  onClose,
  initialTab = "application",
}: {
  onClose: () => void;
  /** 打开时定位到某个 tab（终端工具栏「终端设置」用 appearance）。 */
  initialTab?: SettingsTabId;
}) {
  const s = useSettings();
  const t = (k: string, p?: Record<string, string | number>) => settingsT(s.language, k, p);
  const [tab, setTab] = useState<SettingsTabId>(initialTab);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // 搜索目录：本轮只做到 tab 级定位（Netcatty 可定位 section/anchor，差距已记录）。
  const catalog = useMemo(
    () => TABS.filter((td) => !td.disabled).map((td) => ({ id: td.id, label: t(`settings.tab.${td.id}`) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.language],
  );
  const q = query.trim().toLowerCase();
  const results = q ? catalog.filter((c) => c.label.toLowerCase().includes(q)) : [];

  return (
    <div className="nc-settings-overlay" role="dialog" aria-label={t("settings.title")}>
      <div className="nc-settings-header">
        <span className="nc-settings-title">{t("settings.title")}</span>
        <button className="nc-icon-btn" onClick={onClose} aria-label={t("settings.title")}>
          <Icon name="x" />
        </button>
      </div>
      <div className="nc-settings-body">
        <nav className="nc-settings-nav">
          {searchOpen ? (
            <div className="nc-settings-search">
              <Icon name="search" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.search.placeholder")}
              />
            </div>
          ) : (
            <button
              className="nc-settings-search-collapsed"
              onClick={() => setSearchOpen(true)}
              title={t("settings.search.open")}
            >
              <Icon name="search" />
              <span>{t("settings.search.open")}</span>
            </button>
          )}
          {searchOpen && q && (
            <div className="nc-settings-search-results" role="listbox">
              {results.length === 0 && (
                <div className="nc-settings-search-empty">{t("settings.search.noResults")}</div>
              )}
              {results.map((r) => (
                <button
                  key={r.id}
                  role="option"
                  aria-selected="false"
                  onClick={() => {
                    setTab(r.id);
                    setQuery("");
                    setSearchOpen(false);
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <div className="nc-settings-tabs" role="tablist" aria-orientation="vertical">
            {TABS.map((td) => (
              <button
                key={td.id}
                role="tab"
                aria-selected={tab === td.id}
                disabled={td.disabled}
                title={td.disabled ? t("settings.tab.disabled") : undefined}
                className={"nc-settings-tab" + (tab === td.id ? " is-active" : "")}
                onClick={() => !td.disabled && setTab(td.id)}
              >
                <Icon name={td.icon} />
                <span>{t(`settings.tab.${td.id}`)}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="nc-settings-content">
          {tab === "application" && <ApplicationTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "terminal" && <TerminalTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
          {tab === "system" && <SystemTab />}
          {(tab === "file-associations" || tab === "ai" || tab === "sync") && <PlaceholderTab tab={tab} />}
        </div>
      </div>
    </div>
  );
}
