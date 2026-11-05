/**
 * 工作区持久化（对标 netcatty 的 localStorageAdapter）。
 *
 * 只落盘「标签 + 分屏布局 + 连接器」，不落盘任何会话/终端内容：
 * 下次启动先弹恢复横幅，用户点「恢复」才重建布局并建立连接，
 * 避免无感自动重连远端主机。
 */

import type { Connector, PaneNode } from "../workspaceModel";

const KEY = "termx.workspace.v1";
const VERSION = 1;

export interface SavedTab {
  id: string;
  title: string;
  layout: PaneNode;
  connector: Connector;
}

export interface SavedWorkspace {
  version: number;
  tabs: SavedTab[];
  activeTabId: string | null;
}

function isConnector(v: unknown): v is Connector {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.kind === "pty") return true;
  if (c.kind === "serial") {
    const s = c.session as Record<string, unknown> | undefined;
    return (
      !!s &&
      typeof s.port === "string" &&
      !!s.config &&
      typeof s.config === "object" &&
      typeof s.lineMode === "boolean" &&
      typeof s.localEcho === "boolean" &&
      typeof s.byteOrientedBackspace === "boolean"
    );
  }
  if (c.kind === "telnet") {
    const s = c.session as Record<string, unknown> | undefined;
    return (
      !!s &&
      typeof s.host === "string" &&
      typeof s.port === "number" &&
      (s.inputNewline === "crlf" || s.inputNewline === "lf" || s.inputNewline === "cr")
    );
  }
  return (
    c.kind === "ssh" &&
    typeof c.profileId === "string" &&
    typeof c.name === "string"
  );
}

function isPaneNode(v: unknown): v is PaneNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  if (n.type === "leaf") return typeof n.id === "string";
  if (n.type === "split") {
    return (
      typeof n.id === "string" &&
      (n.dir === "horizontal" || n.dir === "vertical") &&
      typeof n.ratio === "number" &&
      isPaneNode(n.a) &&
      isPaneNode(n.b)
    );
  }
  return false;
}

/** 读取上次工作区；无记录或结构损坏时返回 null。 */
export function loadWorkspace(key: string = KEY): SavedWorkspace | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedWorkspace>;
    if (parsed.version !== VERSION || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter(
      (t): t is SavedTab =>
        !!t &&
        typeof t.id === "string" &&
        typeof t.title === "string" &&
        isPaneNode(t.layout) &&
        isConnector(t.connector),
    );
    if (tabs.length === 0) return null;
    const activeTabId =
      typeof parsed.activeTabId === "string" &&
      tabs.some((t) => t.id === parsed.activeTabId)
        ? parsed.activeTabId
        : tabs[0].id;
    return { version: VERSION, tabs, activeTabId };
  } catch {
    return null;
  }
}

/** 落盘前剥离 Telnet 自动登录密码；恢复时按 profileId 从 SecretStore 重新取。 */
export function sanitizeConnectorForStorage(connector: Connector): Connector {
  if (connector.kind !== "telnet" || !connector.session.password) return connector;
  const session = { ...connector.session };
  delete session.password;
  return { ...connector, session };
}

export function saveWorkspace(state: SavedWorkspace, key: string = KEY): void {
  try {
    const tabs = state.tabs.map((tab) => ({
      ...tab,
      connector: sanitizeConnectorForStorage(tab.connector),
    }));
    localStorage.setItem(key, JSON.stringify({ ...state, tabs }));
  } catch {
    /* 隐私模式或配额满时静默失败，不影响会话 */
  }
}

export function clearWorkspace(key: string = KEY): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
