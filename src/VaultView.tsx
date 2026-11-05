/**
 * Vault 首页（对照 netcatty `components/vault/VaultViewLayout.tsx` 与
 * `vault/VaultHostListSection.tsx`）。
 *
 * 结构：
 * - 左侧导航栏：Logo + 主机 / 监控 / 密钥串 / 代理 / 端口转发 / 脚本 /
 *   笔记 / 已知主机 / 日志；底部为设置入口（对齐 Netcatty VaultViewLayout），
 *   同步不占导航项，由设置中心「同步与云」进入；导航可拖拽调宽。
 * - 顶部 56px 工具栏：搜索（支持快速连接）/ 连接 / 视图 / 标签 / 排序 /
 *   多选 / 新建主机（分体按钮）/ 终端 / 串口。
 * - 内容区：「全部主机」面包屑（树视图隐藏）→ 已置顶 → 最近连接 →
 *   分组 → 主机（排除已置顶 / 最近；剩余为空时回退全部主机，
 *   仅当确实没有主机才整节隐藏）。
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as api from "./backend/client";
import { updateSettings, useSettings } from "./settings/settingsStore";
import type {
  Credential,
  CredentialType,
  DiscoveredShell,
  EnvVar,
  Group,
  KnownHostEntry,
  Profile,
} from "./backend/client";
import { newId } from "./workspaceModel";
import {
  loadTerminalEncoding,
  saveTerminalEncoding,
  type TerminalEncoding,
} from "./terminal/terminalEncoding";
import { userVisibleError } from "./domain/sshErrors";
import { shellDisplayName } from "./domain/shellName";
import {
  rootHostsForDisplay,
  shouldHideRootHostsSection,
} from "./vault/rootHostsModel";
import {
  EMPTY_PROXY_DRAFT,
  proxyDraftError,
  proxyDraftFromProfile,
  proxyPasswordToSave,
  proxyProfileFields,
  type ProxyDraft,
} from "./domain/proxyForm";
import { KeychainView } from "./keychain/KeychainView";
import { SnippetsView } from "./snippets/SnippetsView";
import type { PaneHandle } from "./TerminalPane";
import { NotesView } from "./notes/NotesView";
import { SessionLogsView } from "./sessionLogs/SessionLogsView";
import {
  getVaultHostRowSubtitle,
  LOCAL_SHELL_HOST_TAG,
} from "./domain/localShellHost";
import {
  Activity,
  BookMarked,
  FileCode,
  Gauge,
  Globe,
  Key,
  LayoutGrid,
  NotebookText,
  Plug,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { Icon, type IconName } from "./ui/icons";
import { DistroAvatar } from "./ui/DistroAvatar";
import { LocalShellPanel } from "./LocalShellPanel";
import { SerialHostPanel } from "./serial/SerialHostPanel";
import { ForwardOverview } from "./ForwardOverview";
import { MonitorView } from "./monitor/MonitorView";
import { SyncView } from "./sync/SyncView";
import { ProxyProfilesView } from "./ProxyProfilesView";
import { useVaultHostMarquee } from "./useVaultHostMarquee";
import {
  applyImportedHost,
  buildVaultExport,
  credentialFromImportedHost,
  findConflicts,
  hostConflictKey,
  importedHostToProfile,
  parseVaultImport,
  type VaultImportHost,
} from "./vault/vaultTransfer";
import {
  VAULT_TAGS_KEY,
  readHostTags,
} from "./vault/vaultTags";
import {
  deriveHostContextMenuItems,
  HOST_CONTEXT_MENU_ICON,
} from "./hosts/hostContextMenuModel";

interface Props {
  profiles: Profile[];
  groups: Group[];
  credentials: Credential[];
  /** 最近连接过的条目 id（SSH 档案 id 或 "__local"）。 */
  recentIds: string[];
  onConnect: (profile: Profile) => void;
  onLocal: () => void;
  onSerial: () => void;
  onTelnet: () => void;
  /** 主机右键「打开 SFTP」：打开 SFTP 视图并把该主机定位到右栏。 */
  onOpenSftp: (profile: Profile) => void;
  /** 新建 / 删除后刷新 App 侧列表。 */
  onDataChanged: () => void;
  /** 侧栏底部「设置」入口（对齐 Netcatty VaultViewLayout 的 onOpenSettings）。 */
  onOpenSettings: () => void;
  /** 当前活动终端窗格（脚本页运行链路使用；Vault 态下终端仍常驻隐藏挂载）。 */
  activeHandle?: PaneHandle | null;
  /** 外部入口（顶栏「云端同步」/ 设置中心）请求定位到的 Vault 子页。 */
  focusView?: string | null;
  /** 与 focusView 配套的自增序号，保证重复点击也能重新定位。 */
  focusNonce?: number;
}

type ViewMode = "grid" | "list" | "tree";
type SortMode =
  | "manual"
  | "az"
  | "za"
  | "newest"
  | "oldest"
  | "group"
  | "ip";
type ClickBehavior = "connect" | "select";

const VIEW_KEY = "termx.vault.view.v1";
const SORT_KEY = "termx.vault.sort.v1";
const PINNED_KEY = "termx.pinned.v1";
const SIDEBAR_W_KEY = "termx.vault.sidebar.v1";
const ORDER_KEY = "termx.vault.order.v1";
const TAGS_KEY = VAULT_TAGS_KEY;
const HOST_PANEL_W_KEY = "termx.vault.hostpanel.v1";
const KH_VIEW_KEY = "termx.vault.khView.v1";
const KC_VIEW_KEY = "termx.vault.kcView.v1";

/** 已知主机页排序（对齐 netcatty SortDropdown 的五种模式）。 */
type KhSortMode = "manual" | "az" | "za" | "newest" | "oldest";
const KH_SORT_LABEL: Record<KhSortMode, string> = {
  manual: "手动顺序",
  az: "A-z",
  za: "Z-a",
  newest: "从新到旧",
  oldest: "从旧到新",
};
/** 对齐 netcatty RENDER_LIMIT：超出部分只提示、不渲染。 */
const KH_RENDER_LIMIT = 100;
const SIDEBAR_MIN = 208;
const SIDEBAR_MAX = 320;
const HOST_PANEL_MIN = 320;
const HOST_PANEL_MAX = 520;

type GroupTile = {
  id: string;
  name: string;
  count: number;
  proxy_profile_id?: string | null;
};

/** 登录方式（对齐 netcatty HostDetailsConnectionSections 的四个选项）。 */
type AuthMethod = "auto" | "password" | "key" | "certificate";

const AUTH_METHODS: Array<{
  value: AuthMethod;
  label: string;
  hint: string;
  enabled: boolean;
}> = [
  {
    value: "auto",
    label: "自动选择",
    hint: "先尝试系统密钥和本地密钥，最后使用已保存的密码。",
    enabled: true,
  },
  {
    value: "password",
    label: "仅密码",
    hint: "只使用已保存的密码和交互式密码提示。",
    enabled: true,
  },
  {
    value: "key",
    label: "密钥",
    hint: "使用选中的密钥；如果同时保存了密码，可在失败后尝试密码。",
    enabled: true,
  },
  {
    value: "certificate",
    label: "证书",
    hint: "使用选中的 SSH 证书；termX 尚未移植证书认证。",
    enabled: false,
  },
];

const MFA_HINT = "适用于必须通过 keyboard-interactive 输入密码和 MFA 的服务器。";

/** 凭据选择器类型（对齐 netcatty「+ 密钥 / 证书 / 本地密钥」菜单）。 */
type CredPick = "key" | "certificate" | "localKeyFile" | null;

type ComposerDraft = {
  /** 新建时预生成的 id（TOTP 等按 profile_id 落 SecretStore 需要稳定 id）。 */
  id: string;
  name: string;
  host: string;
  port: string;
  credential_id: string;
  group_id: string;
  /** 逗号分隔，落 localStorage 的标签表。 */
  tags: string;
  auth_method: AuthMethod;
  username: string;
  /** 明文密码输入框内容；编辑已有凭据时留空 = 保持原 secret 不变。 */
  password: string;
  /** 关闭时密码只用于本次保存不入库（secret 传 null）。 */
  save_password: boolean;
  /** 打开 = keyboard-interactive 优先（MFA 服务器）。 */
  mfa: boolean;
  /** `~/.ssh` 下的私钥文件名（auth_method=key 时生效）。 */
  key_file: string;
  /** 主机级环境变量（SSH SetEnv，需远端 AcceptEnv 放行）。 */
  env_vars: EnvVar[];
  /** 终端编码 / 字符集（对齐 Netcatty Host.charset）；按主机存本机偏好。 */
  terminal_encoding: TerminalEncoding;
  init_command: string;
  /** 转发本机 SSH Agent（对齐 Netcatty agentForwarding）。 */
  agent_forwarding: boolean;
  /** 输入兼容模式：null = 老数据（SSH 视为开启）；新主机默认 false。 */
  ssh_input_compatibility: boolean | null;
  // ── Netcatty 1:1 对齐新增（schema v33）──
  sftp_protocol: "auto" | "sftp" | "scp";
  sftp_sudo: boolean;
  sftp_encoding: "auto" | "utf-8" | "gb18030";
  icon_source: "auto" | "custom";
  /** ICON_COLORS 的 value；"" = 自动。 */
  icon_color: string;
  totp_auto_submit: boolean;
  totp_regex: string;
  /** 主机级连接代理（密码单独落 SecretStore）。 */
  proxy: ProxyDraft;
  /** 引用代理库条目；非空时以库配置为准，上面的内联 proxy 仅作回退。 */
  proxy_profile_id: string;
};

/** 登录方式 + MFA → termX Credential 类型。auto→agent（先系统密钥再本地密钥）。 */
function effectiveCredType(d: ComposerDraft): CredentialType {
  if (d.mfa) return "interactive";
  switch (d.auth_method) {
    case "password":
      return "password";
    case "key":
      return "key";
    default:
      return "agent";
  }
}

function authMethodOfCredential(c: Credential): {
  auth: AuthMethod;
  mfa: boolean;
} {
  switch (c.type) {
    case "password":
      return { auth: "password", mfa: false };
    case "key":
      return { auth: "key", mfa: false };
    case "interactive":
      return { auth: "password", mfa: true };
    default:
      return { auth: "auto", mfa: false };
  }
}

const navItems: Array<{
  id: string;
  label: string;
  icon: LucideIcon;
  enabled?: boolean;
}> = [
  { id: "hosts", label: "主机", icon: LayoutGrid, enabled: true },
  { id: "monitor", label: "监控", icon: Gauge, enabled: true },
  { id: "keys", label: "钥匙串", icon: Key, enabled: true },
  { id: "proxies", label: "代理", icon: Globe, enabled: true },
  { id: "port", label: "端口转发", icon: Plug, enabled: true },
  { id: "snippets", label: "脚本", icon: FileCode, enabled: true },
  { id: "notes", label: "笔记", icon: NotebookText, enabled: true },
  { id: "known-hosts", label: "已知主机", icon: BookMarked, enabled: true },
  { id: "logs", label: "日志", icon: Activity, enabled: true },
];

/** 新建主机下拉（对齐 Netcatty：本地终端 (CMD)/新建分组/导入/导出）。 */
const newHostMenu: Array<{ label: string; icon: IconName; enabled?: boolean }> = [
  { label: "本地终端 (CMD)", icon: "terminal-square", enabled: true },
  { label: "新建分组", icon: "folder", enabled: true },
  { label: "导入", icon: "upload", enabled: true },
  { label: "导出", icon: "download", enabled: true },
];

/** 主机编辑器里的轻量文本按钮（环境变量增删）。 */
const ENV_BTN_STYLE: CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  borderRadius: 6,
  border: "1px solid hsl(var(--border))",
  background: "transparent",
  color: "hsl(var(--muted-foreground))",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const SORT_LABEL: Record<SortMode, string> = {
  manual: "手动顺序",
  az: "名称 A → Z",
  za: "名称 Z → A",
  newest: "从新到旧",
  oldest: "从旧到新",
  group: "按分组",
  ip: "按 IP",
};

function clampWidth(n: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_W_KEY));
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : SIDEBAR_MIN;
  } catch {
    return SIDEBAR_MIN;
  }
}

function readView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "tree" ? v : "grid";
  } catch {
    return "grid";
  }
}

function readKhView(): "grid" | "list" {
  try {
    return localStorage.getItem(KH_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function readKcView(): "grid" | "list" {
  try {
    return localStorage.getItem(KC_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/** 从公钥行首段推导密钥类型显示名（对齐 netcatty getKeyTypeDisplay）。 */
function kcTypeOf(publicLine: string): string {
  const head = publicLine.trim().split(/\s+/)[0] ?? "";
  switch (head) {
    case "ssh-ed25519":
      return "ED25519";
    case "ssh-rsa":
      return "RSA";
    case "ecdsa-sha2-nistp256":
      return "ECDSA P-256";
    case "ecdsa-sha2-nistp384":
      return "ECDSA P-384";
    case "ecdsa-sha2-nistp521":
      return "ECDSA P-521";
    case "ssh-dss":
      return "DSA";
    case "sk-ssh-ed25519@openssh.com":
      return "ED25519-SK";
    case "sk-ecdsa-sha2-nistp256@openssh.com":
      return "ECDSA-SK";
    default:
      return head ? head.toUpperCase() : "KEY";
  }
}

/** 钥匙串侧滑面板模式（对齐 netcatty panelStack 的四种密钥面板）。 */
type KcMode = "import" | "generate" | "view" | "edit";
const KC_PANEL_TITLE: Record<KcMode, string> = {
  import: "新建密钥",
  generate: "生成密钥",
  view: "密钥详情",
  edit: "编辑密钥",
};

interface KcDraft {
  label: string;
  privateKey: string;
  publicKey: string;
  passphrase: string;
  savePassphrase: boolean;
  algorithm: "ED25519" | "ECDSA" | "RSA";
  /** RSA 位宽 / ECDSA 曲率（256/384/521）。 */
  bits: number;
}

const KC_EMPTY_DRAFT: KcDraft = {
  label: "",
  privateKey: "",
  publicKey: "",
  passphrase: "",
  savePassphrase: false,
  algorithm: "ED25519",
  bits: 4096,
};

function readSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === "name-asc") return "az";
    if (v === "name-desc") return "za";
    if (v === "host-asc" || v === "host-desc") return "ip";
    return v && v in SORT_LABEL ? (v as SortMode) : "az";
  } catch {
    return "az";
  }
}

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function readOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

type TagMap = Record<string, string[]>;

// 单击行为由设置中心「外观 · 主机库」统一管理（settings.center.v1）。

function clampPanelWidth(n: number): number {
  return Math.min(HOST_PANEL_MAX, Math.max(HOST_PANEL_MIN, n));
}

/** 主机详情面板默认宽 420（对齐 Netcatty HostDetailsPanel w-[420px]）。 */
function readPanelWidth(): number {
  try {
    const n = Number(localStorage.getItem(HOST_PANEL_W_KEY));
    return Number.isFinite(n) && n > 0 ? clampPanelWidth(n) : 420;
  } catch {
    return 420;
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 忽略持久化失败 */
  }
}

/**
 * 快速连接语法：
 * - `user@host`
 * - `ssh user@host`
 * - `ssh -p 2222 user@host`
 * 返回 null 时按普通搜索处理。
 */
function parseQuickConnect(raw: string): {
  host: string;
  port: number;
  username?: string;
} | null {
  let text = raw.trim();
  if (!text) return null;
  let port = 22;
  if (/^ssh(?:\s|$)/i.test(text)) {
    text = text.slice(3).trim();
    const portMatch = /^-p\s*(\d+)(?:\s+|$)/.exec(text);
    if (portMatch) {
      port = Number(portMatch[1]);
      text = text.slice(portMatch[0].length).trim();
    }
    if (!text) return null;
  } else if (!text.includes("@")) {
    return null;
  }
  const token = text.split(/\s+/)[0] ?? "";
  const at = token.lastIndexOf("@");
  const username = at >= 0 ? token.slice(0, at) : undefined;
  const host = at >= 0 ? token.slice(at + 1) : token;
  const hostPattern = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9][A-Za-z0-9._-]*)$/;
  if (!hostPattern.test(host)) return null;
  if (username !== undefined && !/^[A-Za-z0-9._-]+$/.test(username)) return null;
  if (port < 1 || port > 65535) return null;
  return { host, port, username };
}

function viewIcon(mode: ViewMode): IconName {
  return mode === "grid" ? "grid" : mode === "list" ? "list" : "network";
}

/** 分组删除确认（对齐 Netcatty HostTreeGroupDeleteDialog：可勾选同时删除组内主机）。 */
function GroupDeleteDialog({
  bulk,
  names,
  hostCount,
  onCancel,
  onConfirm,
}: {
  bulk: boolean;
  names: string[];
  hostCount: number;
  onCancel: () => void;
  onConfirm: (withHosts: boolean) => void;
}) {
  const [withHosts, setWithHosts] = useState(false);
  return (
    <div className="modal-mask" onMouseDown={onCancel}>
      <div className="modal kh-delete-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="kh-delete-title">
          <Icon name="alert-triangle" size={18} />
          {bulk ? "删除所选分组" : "删除分组"}
        </h3>
        <p className="kh-delete-desc">
          {bulk
            ? "这将永久删除所选分组，并把其中的主机移动到根级别。"
            : "这将永久删除该分组并将所有主机移动到根级别。"}
        </p>
        {!bulk && names[0] && (
          <p className="kh-delete-desc">
            分组：<span className="vault-delete-path">{names[0]}</span>
          </p>
        )}
        {hostCount > 0 && (
          <label className="vault-delete-check">
            <input
              type="checkbox"
              checked={withHosts}
              onChange={(e) => setWithHosts(e.target.checked)}
            />
            <span>
              {bulk ? "同时删除所选分组下的所有主机" : "同时删除该分组下的所有主机"}
            </span>
          </label>
        )}
        <div className="modal-actions">
          <button onClick={onCancel}>取消</button>
          <button className="danger" onClick={() => onConfirm(withHosts)}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

export function VaultView({
  profiles,
  groups,
  credentials,
  recentIds,
  onConnect,
  onLocal,
  onSerial,
  onTelnet,
  onOpenSftp,
  onDataChanged,
  onOpenSettings,
  activeHandle,
  focusView,
  focusNonce,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const [panelResizing, setPanelResizing] = useState(false);
  const panelResizeStart = useRef<{ x: number; width: number } | null>(null);

  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(readView);
  const [sort, setSort] = useState<SortMode>(readSort);
  const [viewMenu, setViewMenu] = useState(false);
  const [sortMenu, setSortMenu] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const settings = useSettings();
  const clickBehavior = settings.hostClickBehavior;
  const setClickBehavior = (v: ClickBehavior) => updateSettings({ hostClickBehavior: v });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [tagRename, setTagRename] = useState<{ from: string; value: string } | null>(
    null,
  );

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>(readPinned);
  const [order, setOrder] = useState<string[]>(readOrder);
  const [tags, setTags] = useState<TagMap>(() => readHostTags());
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{
    profile: Profile;
    x: number;
    y: number;
  } | null>(null);
  const [groupCtx, setGroupCtx] = useState<{
    group: GroupTile;
    x: number;
    y: number;
  } | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupDialog, setGroupDialog] = useState<{
    id: string | null;
    name: string;
    proxy_profile_id: string | null;
  } | null>(null);
  const [moveMenu, setMoveMenu] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);
  /** 本机默认 shell 命令（default_shell 命令，与 pty_spawn 同源），供本地卡显示名。 */
  const [localShellCmd, setLocalShellCmd] = useState("");
  /** 本机发现的 shell（本地终端面板 Shell 下拉 + 本地卡名解析）。 */
  const [discoveredShells, setDiscoveredShells] = useState<DiscoveredShell[]>(
    [],
  );
  /** 设置项 local_shell（发现的 shell id 或自定义命令）；空 = 系统默认。 */
  const [localShellSetting, setLocalShellSetting] = useState("");
  /** 本地终端面板：null = 关闭；"new" = 新建；否则为编辑目标。 */
  const [localPanel, setLocalPanel] = useState<Profile | "new" | null>(null);
  /** 串口主机编辑面板：null = 关闭；否则为编辑目标。 */
  const [serialPanel, setSerialPanel] = useState<Profile | null>(null);

  const {
    marqueeRect,
    onPointerDown: onMarqueePointerDown,
    onClickCapture: onMarqueeClickCapture,
  } = useVaultHostMarquee({
    containerRef: contentRef,
    viewMode: view,
    isMultiSelectMode: selectMode,
    selectedHostIds: selected,
    setIsMultiSelectMode: setSelectMode,
    setSelectedHostIds: setSelected,
  });

  const [composer, setComposer] = useState<ComposerDraft | null>(null);
  // 「转发 Agent」开关可用性探测（与 ConnectionManager 同款警告）。
  const [composerAgentRunning, setComposerAgentRunning] = useState<
    boolean | null
  >(null);
  function probeComposerAgent() {
    api
      .sshAgentStatus()
      .then((st) => setComposerAgentRunning(st.running))
      .catch(() => setComposerAgentRunning(false));
  }
  // 打开已开启转发的档案时探测一次；开关拨动由 onClick 自行探测。
  useEffect(() => {
    if (composer?.agent_forwarding) probeComposerAgent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer?.id]);
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerErr, setComposerErr] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  /** 编辑态：已保存密码以掩码 ••••• 展示，明文不进 input（对齐 Netcatty HostDetails）。 */
  const [passMasked, setPassMasked] = useState(false);
  const [keyFiles, setKeyFiles] = useState<string[]>([]);
  /** 绑定凭据的原始 secret（getCredential 取回）；密码框留空时原样回填，避免误删。 */
  const composerSecretRef = useRef<string | null>(null);
  const composerProxySecretRef = useRef(false);
  /** 「+ 密钥 / 证书 / 本地密钥」菜单与当前选择器类型。 */
  const [credMenu, setCredMenu] = useState(false);
  const [credPick, setCredPick] = useState<CredPick>(null);
  const [credSearch, setCredSearch] = useState("");
  /** 当前 composer 主机是否已配置 TOTP（secret 在 SecretStore，不落库）。 */
  const [totpConfigured, setTotpConfigured] = useState(false);
  const [totpDialog, setTotpDialog] = useState<{
    secret: string;
    autoSubmit: boolean;
    regex: string;
  } | null>(null);
  /** 测试连接对话框状态（对齐 netcatty HostConnectionTestDialog 文案）。 */
  const [testState, setTestState] = useState<{
    status: "connecting" | "success" | "failed";
    seconds: number;
    error: string;
  } | null>(null);
  const testCleanupRef = useRef<(() => void) | null>(null);

  const [activeNav, setActiveNav] = useState("hosts");
  /** 代理库列表（主机表单选择引用 + 「代理」页展示）。 */
  const [proxyProfiles, setProxyProfiles] = useState<api.ProxyProfile[]>([]);
  const [knownHosts, setKnownHosts] = useState<KnownHostEntry[]>([]);
  const [khLoading, setKhLoading] = useState(false);
  const [khErr, setKhErr] = useState("");
  const [khQuery, setKhQuery] = useState("");
  const [khView, setKhView] = useState<"grid" | "list">(readKhView);
  const [khSort, setKhSort] = useState<KhSortMode>("manual");
  const [khViewMenu, setKhViewMenu] = useState(false);
  const [khSortMenu, setKhSortMenu] = useState(false);
  const [khScanning, setKhScanning] = useState(false);
  /** 删除确认对话框目标（对齐 netcatty VaultDeleteConfirmDialog）。 */
  const [khDelete, setKhDelete] = useState<KnownHostEntry | null>(null);
  /** 主机删除确认（对齐 Netcatty ConfirmDialog：应用内模态，不用原生 confirm）。 */
  const [hostDelete, setHostDelete] = useState<Profile | null>(null);
  /** 分组删除确认（对齐 Netcatty HostTreeGroupDeleteDialog：可勾选同时删主机）。 */
  const [groupDelete, setGroupDelete] = useState<{
    ids: string[];
    names: string[];
    hostIds: string[];
  } | null>(null);
  /** 卡片右键菜单（两项：转换为主机 / 删除）。 */
  const [khCtx, setKhCtx] = useState<{
    entry: KnownHostEntry;
    x: number;
    y: number;
  } | null>(null);

  // ── 钥匙串页状态 ────────────────────────────────────────
  const [kcView, setKcView] = useState<"grid" | "list">(readKcView);
  const [kcQuery, setKcQuery] = useState("");
  const [kcNewMenu, setKcNewMenu] = useState(false);
  const [kcViewMenu, setKcViewMenu] = useState(false);
  /** 侧滑面板：null = 关闭；id 仅 view/edit 模式携带。 */
  const [kcPanel, setKcPanel] = useState<{ mode: KcMode; id: string | null } | null>(null);
  const [kcDraft, setKcDraft] = useState<KcDraft>(KC_EMPTY_DRAFT);
  const [kcShowPass, setKcShowPass] = useState(false);
  const [kcBusy, setKcBusy] = useState(false);
  const [kcErr, setKcErr] = useState("");
  /** 删除确认对话框目标（对齐 netcatty VaultDeleteConfirmDialog）。 */
  const [kcDelete, setKcDelete] = useState<Credential | null>(null);
  /** 卡片右键菜单（复制公钥 / 编辑 / 删除）。 */
  const [kcCtx, setKcCtx] = useState<{
    cred: Credential;
    x: number;
    y: number;
  } | null>(null);
  /** 详情面板「复制公钥」后的 2s 勾选反馈（对齐 netcatty ViewKeyPanel）。 */
  const [kcCopied, setKcCopied] = useState(false);
  const kcFileRef = useRef<HTMLInputElement | null>(null);

  // ── 持久化 ──────────────────────────────────────────────

  useEffect(() => {
    persist(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    persist(KH_VIEW_KEY, khView);
  }, [khView]);

  useEffect(() => {
    persist(KC_VIEW_KEY, kcView);
  }, [kcView]);

  useEffect(() => {
    persist(SORT_KEY, sort);
  }, [sort]);

  useEffect(() => {
    persist(PINNED_KEY, JSON.stringify(pinnedIds));
  }, [pinnedIds]);

  useEffect(() => {
    persist(ORDER_KEY, JSON.stringify(order));
  }, [order]);

  useEffect(() => {
    persist(TAGS_KEY, JSON.stringify(tags));
  }, [tags]);

  // 顶栏 / 设置中心的「打开同步页」入口：定位到 Vault 子页后清掉浮层。
  useEffect(() => {
    if (!focusView) return;
    setActiveNav(focusView);
    setComposer(null);
    setCtxMenu(null);
    setNewMenu(false);
  }, [focusView, focusNonce]);



  useEffect(() => {
    if (!collapsed) persist(SIDEBAR_W_KEY, String(sidebarWidth));
  }, [sidebarWidth, collapsed]);

  useEffect(() => {
    persist(HOST_PANEL_W_KEY, String(panelWidth));
  }, [panelWidth]);

  // 新出现的主机自动补进手动顺序表尾，保证「手动顺序 / 从新到旧」可用。
  useEffect(() => {
    setOrder((prev) => {
      const known = new Set(prev);
      const missing = profiles.map((p) => p.id).filter((id) => !known.has(id));
      return missing.length ? [...prev, ...missing] : prev;
    });
  }, [profiles]);

  // 本地终端卡显示真实默认 shell 名（对齐 Netcatty「Git Bash / Git Bash」）。
  useEffect(() => {
    let alive = true;
    api
      .defaultShell()
      .then((s) => {
        if (alive) setLocalShellCmd(s);
      })
      .catch(() => {});
    api
      .discoverShells()
      .then((s) => {
        if (alive) setDiscoveredShells(s);
      })
      .catch(() => {});
    api
      .getSetting("local_shell")
      .then((s) => {
        if (alive) setLocalShellSetting(s ?? "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // ── 侧栏拖拽调宽 ────────────────────────────────────────

  useEffect(() => {
    if (!resizing) return;
    function onMove(e: PointerEvent) {
      const start = resizeStart.current;
      if (!start) return;
      setSidebarWidth(clampWidth(start.width + e.clientX - start.x));
    }
    function stop() {
      resizeStart.current = null;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);

  function startResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    resizeStart.current = { x: e.clientX, width: sidebarWidth };
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // ── 右侧主机面板拖拽调宽 ────────────────────────────────

  useEffect(() => {
    if (!panelResizing) return;
    function onMove(e: PointerEvent) {
      const start = panelResizeStart.current;
      if (!start) return;
      setPanelWidth(clampPanelWidth(start.width - e.clientX + start.x));
    }
    function stop() {
      panelResizeStart.current = null;
      setPanelResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [panelResizing]);

  function startPanelResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    panelResizeStart.current = { x: e.clientX, width: panelWidth };
    setPanelResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // ── 弹出层关闭 ──────────────────────────────────────────

  const popupOpen =
    viewMenu ||
    sortMenu ||
    newMenu ||
    tagMenu ||
    moveMenu ||
    khViewMenu ||
    khSortMenu ||
    kcNewMenu ||
    kcViewMenu ||
    Boolean(ctxMenu) ||
    Boolean(groupCtx) ||
    Boolean(khCtx) ||
    Boolean(kcCtx);

  useEffect(() => {
    if (!popupOpen) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Element | null;
      if (target?.closest(".vault-popmenu")) return;
      setViewMenu(false);
      setSortMenu(false);
      setNewMenu(false);
      setTagMenu(false);
      setMoveMenu(false);
      setKhViewMenu(false);
      setKhSortMenu(false);
      setKcNewMenu(false);
      setKcViewMenu(false);
      setCtxMenu(null);
      setGroupCtx(null);
      setKhCtx(null);
      setKcCtx(null);
      setTagRename(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setViewMenu(false);
      setSortMenu(false);
      setNewMenu(false);
      setTagMenu(false);
      setMoveMenu(false);
      setKhViewMenu(false);
      setKhSortMenu(false);
      setKcNewMenu(false);
      setKcViewMenu(false);
      setCtxMenu(null);
      setGroupCtx(null);
      setKhCtx(null);
      setKcCtx(null);
      setTagRename(null);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [popupOpen]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2200);
  }

  // ── 数据派生 ────────────────────────────────────────────

  const credById = new Map(credentials.map((c) => [c.id, c]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const keyword = query.trim().toLowerCase();
  const quick = parseQuickConnect(query);

  function subtitle(p: Profile): string {
    const username = credById.get(p.credential_id)?.username;
    return getVaultHostRowSubtitle(p, {
      sshSubtitle: `${username ? `${username}@` : ""}${p.host}`,
    });
  }

  function fullSubtitle(p: Profile): string {
    if (p.protocol === "local" || p.protocol === "serial") return subtitle(p);
    return `${subtitle(p)}:${p.port}`;
  }

  function orderRank(id: string): number {
    const i = order.indexOf(id);
    if (i >= 0) return i;
    return 100000 + profiles.findIndex((p) => p.id === id);
  }

  function ipRank(host: string): number {
    const parts = host.split(".");
    if (parts.length === 4 && parts.every((x) => /^\d{1,3}$/.test(x))) {
      return parts.reduce((acc, x) => acc * 256 + Number(x), 0);
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function sortHosts(list: Profile[]): Profile[] {
    const out = [...list];
    switch (sort) {
      case "za":
        return out.sort((a, b) => b.name.localeCompare(a.name, "zh-Hans-CN"));
      case "newest":
        return out.sort((a, b) => orderRank(b.id) - orderRank(a.id));
      case "oldest":
        return out.sort((a, b) => orderRank(a.id) - orderRank(b.id));
      case "group": {
        const groupName = (p: Profile) =>
          (p.group_id ? groupById.get(p.group_id)?.name : "") ?? "未分组";
        return out.sort(
          (a, b) =>
            groupName(a).localeCompare(groupName(b), "zh-Hans-CN") ||
            a.name.localeCompare(b.name, "zh-Hans-CN"),
        );
      }
      case "ip":
        return out.sort(
          (a, b) =>
            ipRank(a.host) - ipRank(b.host) || a.host.localeCompare(b.host),
        );
      case "manual":
        return out.sort((a, b) => orderRank(a.id) - orderRank(b.id));
      default:
        return out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    }
  }

  const allTagNames = Array.from(
    new Set(Object.values(tags).flatMap((list) => list)),
  ).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  // 识别为快速连接时，关键字不参与过滤：列表保持完整，另在顶部给出直连建议行。
  const filterKeyword = quick ? "" : keyword;
  const visible = profiles.filter((p) => {
    if (selectedTags.length) {
      const own = tags[p.id] ?? [];
      if (!selectedTags.every((t) => own.includes(t))) return false;
    }
    if (!filterKeyword) return true;
    const username = credById.get(p.credential_id)?.username?.toLowerCase() ?? "";
    return (
      p.name.toLowerCase().includes(filterKeyword) ||
      p.host.toLowerCase().includes(filterKeyword) ||
      String(p.port).includes(filterKeyword) ||
      username.includes(filterKeyword) ||
      (tags[p.id] ?? []).some((t) => t.toLowerCase().includes(filterKeyword))
    );
  });

  const activeGroupName =
    activeGroupId === null
      ? ""
      : activeGroupId === "__ungrouped"
        ? "未分组"
        : (groupById.get(activeGroupId)?.name ?? "未分组");

  const scopedHosts =
    activeGroupId === null
      ? sortHosts(visible)
      : sortHosts(
          visible.filter((p) =>
            activeGroupId === "__ungrouped"
              ? !p.group_id || !groupById.has(p.group_id)
              : p.group_id === activeGroupId,
          ),
        );

  // 对齐 Netcatty：空分组也要展示（否则新建后无法重命名/删除）。
  const groupTiles: GroupTile[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    count: visible.filter((p) => p.group_id === g.id).length,
    proxy_profile_id: g.proxy_profile_id ?? null,
  }));
  const ungroupedCount = visible.filter(
    (p) => !p.group_id || !groupById.has(p.group_id),
  ).length;
  if (ungroupedCount > 0) {
    groupTiles.push({ id: "__ungrouped", name: "未分组", count: ungroupedCount });
  }

  const treeSections = [
    ...groups.map((g) => ({
      id: g.id,
      name: g.name,
      hosts: sortHosts(visible.filter((p) => p.group_id === g.id)),
    })),
    {
      id: "__ungrouped",
      name: "未分组",
      hosts: sortHosts(
        visible.filter((p) => !p.group_id || !groupById.has(p.group_id)),
      ),
    },
    // 对齐 Netcatty：树视图同样保留空分组节点；「未分组」仅在确有主机时出现。
  ].filter((s) => (s.id === "__ungrouped" ? s.hosts.length > 0 : true));

  // 最近连接：按记录顺序，排除已置顶（避免与「已置顶」重复），最多 6 条。
  const recentProfiles = settings.showRecentHosts
    ? recentIds
        .filter((id) => id !== "__local" && !pinnedIds.includes(id))
        .map((id) => visible.find((p) => p.id === id))
        .filter((p): p is Profile => Boolean(p))
        .slice(0, 6)
    : [];
  const showLocalRecently =
    settings.showRecentHosts &&
    recentIds.includes("__local") &&
    (!keyword || "local".includes(keyword));

  const pinnedHosts = sortHosts(
    pinnedIds
      .map((id) => visible.find((p) => p.id === id))
      .filter((p): p is Profile => Boolean(p)),
  );

  const atRoot = activeGroupId === null;

  // 对齐 Netcatty useVaultHostCollections：根部「主机」分区排除「已置顶」与
  // 「最近连接」里已出现的条目（visibleDisplayedHosts）；剩余为空且其它分区
  // 有内容时整节隐藏（shouldHideEmptyRootHostsSection）。
  const recentIdSet = new Set(recentProfiles.map((p) => p.id));
  const rootRemaining =
    atRoot && !keyword
      ? scopedHosts.filter(
          (p) =>
            !pinnedIds.includes(p.id) &&
            !recentIdSet.has(p.id) &&
            (!settings.showOnlyUngroupedHostsInRoot || !p.group_id),
        )
      : scopedHosts;
  const hideRootHostsSection = shouldHideRootHostsSection({
    atRoot,
    view,
    keyword,
    hostCount: scopedHosts.length,
  });

  const switcherHosts = sortHosts(visible).filter((p) => {
    const q = switcherQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      (credById.get(p.credential_id)?.username ?? "").toLowerCase().includes(q)
    );
  });

  // ── 选择 / 置顶 / 删除 ──────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroupSelect(id: string) {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected(new Set(scopedHosts.map((p) => p.id)));
    setSelectedGroups(
      new Set(
        atRoot && view !== "tree"
          ? groupTiles.filter((g) => g.id !== "__ungrouped").map((g) => g.id)
          : [],
      ),
    );
  }

  function clearSelection() {
    setSelected(new Set());
    setSelectedGroups(new Set());
  }

  function exitSelectMode() {
    setSelectMode(false);
    clearSelection();
  }

  function togglePin(id: string) {
    setPinnedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
    setCtxMenu(null);
  }

  async function performDeleteHost(p: Profile) {
    try {
      await api.deleteProfile(p.id);
      setPinnedIds((prev) => prev.filter((x) => x !== p.id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
      onDataChanged();
    } catch {
      /* 删除失败时保持原状，等待后端错误提示 */
    }
  }

  async function deleteSelected() {
    if (selected.size === 0 && selectedGroups.size === 0) return;
    if (selectedGroups.size > 0) {
      // 对齐 Netcatty：选了分组 → 弹分组删除确认（可勾选同时删除组内主机）。
      const ids = Array.from(selectedGroups);
      setGroupDelete({
        ids,
        names: groups.filter((g) => selectedGroups.has(g.id)).map((g) => g.name),
        hostIds: [
          ...profiles.filter((p) => p.group_id && selectedGroups.has(p.group_id)).map((p) => p.id),
          ...Array.from(selected),
        ],
      });
      return;
    }
    // 对齐 Netcatty：只选主机时直接批量删除，不再弹确认。
    const ids = Array.from(selected);
    try {
      for (const id of ids) await api.deleteProfile(id);
    } catch {
      /* 忽略单条失败，后续统一刷新 */
    }
    setPinnedIds((prev) => prev.filter((id) => !selected.has(id)));
    setTags((prev) => {
      const next = { ...prev };
      for (const id of selected) delete next[id];
      return next;
    });
    exitSelectMode();
    onDataChanged();
  }

  function duplicateHost(p: Profile) {
    const copy: Profile = {
      ...p,
      id: newId(),
      // 本地终端主机用带括号版「(副本)」（对齐 Netcatty），SSH 主机保持「副本」。
      name: p.protocol === "local" ? `${p.name} (副本)` : `${p.name} 副本`,
    };
    void api
      .createProfile(copy)
      .then(() => {
        setOrder((prev) => [...prev, copy.id]);
        const originTags = tags[p.id];
        if (originTags?.length) {
          setTags((prev) => ({ ...prev, [copy.id]: [...originTags] }));
        }
        onDataChanged();
        showToast("已创建主机副本");
      })
      .catch(() => showToast("复制失败"));
  }

  function copyHostname(p: Profile) {
    void navigator.clipboard?.writeText(p.host).catch(() => undefined);
    showToast("主机名已复制");
  }

  async function copyCredentials(p: Profile) {
    const cred = credById.get(p.credential_id);
    if (!cred) {
      showToast("该主机没有绑定凭据");
      return;
    }
    const username = cred.username || "(未设置用户名)";
    const secret =
      cred.type === "password" && cred.secret ? `\n密码：${cred.secret}` : "";
    try {
      await navigator.clipboard.writeText(
        `${username}@${p.host}:${p.port}${secret}`,
      );
      showToast("账密信息已复制");
    } catch {
      showToast("复制失败");
    }
  }

  function handleCardClick(p: Profile) {
    if (selectMode) {
      toggleSelect(p.id);
      return;
    }
    if (clickBehavior === "select" && focusId !== p.id) {
      setFocusId(p.id);
      return;
    }
    onConnect(p);
  }

  function handleCardKey(e: ReactKeyboardEvent<HTMLDivElement>, p: Profile) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (selectMode) toggleSelect(p.id);
    else onConnect(p);
  }

  function openContextMenu(e: ReactMouseEvent<HTMLDivElement>, p: Profile) {
    e.preventDefault();
    setCtxMenu({
      profile: p,
      x: Math.min(e.clientX, window.innerWidth - 216),
      y: Math.min(e.clientY, window.innerHeight - 380),
    });
  }

  function openGroupMenu(e: ReactMouseEvent<HTMLDivElement>, g: GroupTile) {
    e.preventDefault();
    if (g.id === "__ungrouped") return;
    setGroupCtx({
      group: g,
      x: Math.min(e.clientX, window.innerWidth - 216),
      y: Math.min(e.clientY, window.innerHeight - 200),
    });
  }

  async function moveHostsTo(ids: string[], groupId: string | null) {
    const targets = profiles.filter((p) => ids.includes(p.id));
    try {
      for (const p of targets) {
        await api.updateProfile({ ...p, group_id: groupId });
      }
      showToast(
        groupId
          ? `已移动 ${targets.length} 台主机到「${
              groupById.get(groupId)?.name ?? "分组"
            }」`
          : `已将 ${targets.length} 台主机移出分组`,
      );
    } catch {
      showToast("移动失败");
    }
    onDataChanged();
  }

  async function saveGroupDialog() {
    const d = groupDialog;
    if (!d) return;
    const name = d.name.trim();
    if (!name) return;
    try {
      if (d.id) {
        const target = groups.find((g) => g.id === d.id);
        if (target) {
          await api.updateGroup({
            ...target,
            name,
            proxy_profile_id: d.proxy_profile_id || null,
          });
        }
      } else {
        await api.createGroup({
          id: newId(),
          name,
          color: "#6ea8fe",
          sort_order: groups.length,
          proxy_profile_id: d.proxy_profile_id || null,
        });
      }
      setGroupDialog(null);
      onDataChanged();
    } catch {
      showToast("保存分组失败");
    }
  }

  function requestGroupDelete(id: string, name: string) {
    setGroupDelete({
      ids: [id],
      names: [name],
      hostIds: profiles.filter((p) => p.group_id === id).map((p) => p.id),
    });
  }

  async function confirmGroupDelete(deleteHosts: boolean) {
    const target = groupDelete;
    setGroupDelete(null);
    if (!target) return;
    const ids = new Set(target.ids);
    try {
      if (deleteHosts) {
        for (const hostId of target.hostIds) await api.deleteProfile(hostId);
      }
      for (const id of ids) await api.deleteGroup(id);
    } catch {
      showToast("删除分组失败");
      onDataChanged();
      return;
    }
    if (activeGroupId && ids.has(activeGroupId)) setActiveGroupId(null);
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (deleteHosts) {
      const removed = new Set(target.hostIds);
      setPinnedIds((prev) => prev.filter((id) => !removed.has(id)));
      setTags((prev) => {
        const next = { ...prev };
        for (const id of removed) delete next[id];
        return next;
      });
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of removed) next.delete(id);
        return next;
      });
    }
    exitSelectMode();
    onDataChanged();
  }

  function setHostTags(id: string, next: string[]) {
    setTags((prev) => {
      const copy = { ...prev };
      if (next.length) copy[id] = next;
      else delete copy[id];
      return copy;
    });
  }

  function renameTag(from: string, to: string) {
    const name = to.trim();
    if (!name || name === from) {
      setTagRename(null);
      return;
    }
    setTags((prev) => {
      const next: TagMap = {};
      for (const [id, list] of Object.entries(prev)) {
        const replaced = list.map((t) => (t === from ? name : t));
        next[id] = Array.from(new Set(replaced));
      }
      return next;
    });
    setSelectedTags((prev) =>
      prev.map((t) => (t === from ? name : t)),
    );
    setTagRename(null);
  }

  function removeTag(tag: string) {
    setTags((prev) => {
      const next: TagMap = {};
      for (const [id, list] of Object.entries(prev)) {
        const rest = list.filter((t) => t !== tag);
        if (rest.length) next[id] = rest;
      }
      return next;
    });
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  }

  // ── 快速切换器 / 快速连接向导 ────────────────────────────

  function openQuickSwitcher() {
    setSwitcherQuery("");
    setSwitcher(true);
  }

  function connectFromSwitcher(p: Profile) {
    setSwitcher(false);
    onConnect(p);
  }

  function runQuickConnect() {
    if (!quick) {
      openQuickSwitcher();
      return;
    }
    // 对齐 Netcatty 运行版：快速连接 = 打开 composer「主机详情」预填，
    // 不再有独立「快速连接」模态。
    openComposer();
    setComposer((d) =>
      d
        ? {
            ...d,
            name: quick.username
              ? `${quick.username}@${quick.host}`
              : quick.host,
            host: quick.host,
            port: String(quick.port),
            username: quick.username || d.username,
          }
        : d,
    );
    setQuery("");
  }

  // ── 拖拽归组 / 框选 / 键盘导航 ───────────────────────────

  function startHostDrag(
    e: React.DragEvent<HTMLElement>,
    p: Profile,
  ) {
    if (selectMode) {
      e.preventDefault();
      return;
    }
    const ids = selected.has(p.id) ? Array.from(selected) : [p.id];
    setDragIds(ids);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ids.join(","));
  }

  function endHostDrag() {
    setDragIds([]);
    setDropGroupId(null);
  }

  function allowDrop(e: React.DragEvent<HTMLElement>, groupId: string | null) {
    if (dragIds.length === 0) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropGroupId(groupId ?? "__root");
  }

  function dropOnGroup(e: React.DragEvent<HTMLElement>, groupId: string | null) {
    e.preventDefault();
    if (dragIds.length === 0) return;
    const ids = dragIds;
    endHostDrag();
    void moveHostsTo(ids, groupId);
  }

  function handleContentKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && selectMode) {
      exitSelectMode();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") {
      return;
    }
    const content = contentRef.current;
    if (!content) return;
    const cards = Array.from(
      content.querySelectorAll<HTMLElement>(".vault-host-card"),
    );
    if (cards.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const index = active ? cards.indexOf(active) : -1;
    e.preventDefault();
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const next = cards[Math.max(0, Math.min(cards.length - 1, index + step))] ?? cards[0];
    next.focus();
  }


  function openComposer() {
    setComposerErr("");
    setShowPassword(false);
    setPassMasked(false);
    composerSecretRef.current = null;
    composerProxySecretRef.current = false;
    setCredMenu(false);
    setCredPick(null);
    setCredSearch("");
    setTotpConfigured(false);
    setComposer({
      id: newId(),
      name: "",
      host: "",
      port: "22",
      credential_id: "",
      group_id: activeGroupId && activeGroupId !== "__ungrouped" ? activeGroupId : "",
      tags: "",
      auth_method: "auto",
      username: "root",
      password: "",
      save_password: true,
      mfa: false,
      key_file: "",
      env_vars: [],
      terminal_encoding: "utf-8",
      init_command: "",
      agent_forwarding: false,
      ssh_input_compatibility: false,
      sftp_protocol: "auto",
      sftp_sudo: false,
      sftp_encoding: "auto",
      icon_source: "auto",
      icon_color: "",
      totp_auto_submit: true,
      totp_regex: "",
      proxy: { ...EMPTY_PROXY_DRAFT },
      proxy_profile_id: "",
    });
    setNewMenu(false);
  }

  function openComposerForEdit(p: Profile) {
    setComposerErr("");
    setShowPassword(false);
    setPassMasked(false);
    composerSecretRef.current = null;
    composerProxySecretRef.current = false;
    setCredMenu(false);
    setCredSearch("");
    const cred = credentials.find((c) => c.id === p.credential_id);
    const { auth, mfa } = cred
      ? authMethodOfCredential(cred)
      : { auth: "auto" as AuthMethod, mfa: false };
    // 编辑既有主机：凭据选择器按已绑凭据类型展开（密钥）。
    setCredPick(cred?.type === "key" ? "key" : null);
    setComposer({
      id: p.id,
      name: p.name,
      host: p.host,
      port: String(p.port),
      credential_id: cred ? p.credential_id : "",
      group_id: p.group_id ?? "",
      tags: (tags[p.id] ?? []).join(", "),
      auth_method: auth,
      username: cred?.username ?? "",
      password: "",
      save_password: true,
      mfa,
      key_file: "",
      env_vars: [],
      terminal_encoding: loadTerminalEncoding(p.id),
      init_command: p.init_command ?? "",
      agent_forwarding: p.agent_forwarding ?? false,
      ssh_input_compatibility: p.ssh_input_compatibility ?? null,
      sftp_protocol:
        p.sftp_protocol === "sftp" || p.sftp_protocol === "scp"
          ? p.sftp_protocol
          : "auto",
      sftp_sudo: p.sftp_sudo ?? false,
      sftp_encoding:
        p.sftp_encoding === "utf-8" || p.sftp_encoding === "gb18030"
          ? p.sftp_encoding
          : "auto",
      icon_source: p.icon_source === "custom" ? "custom" : "auto",
      icon_color: p.icon_color ?? "",
      totp_auto_submit: p.totp_auto_submit ?? true,
      totp_regex: p.totp_regex ?? "",
      proxy: proxyDraftFromProfile(p),
      proxy_profile_id: p.proxy_profile_id ?? "",
    });
    // 环境变量在独立表中，异步补齐（避免打开编辑器被 DB 查询阻塞）。
    void api
      .listProfileEnv(p.id)
      .then((vars) => {
        setComposer((prev) =>
          prev && prev.id === p.id ? { ...prev, env_vars: vars } : prev,
        );
      })
      .catch(() => {});
    if (cred) {
      // 取回原 secret：密码框留空时原样回填；已有保存密码则显示掩码（D7）。
      void api
        .getCredential(cred.id)
        .then((full) => {
          composerSecretRef.current = full.secret;
          if (
            (cred.type === "password" || cred.type === "interactive") &&
            full.secret
          ) {
            setPassMasked(true);
          }
        })
        .catch(() => {});
    }
    // TOTP 配置状态（secret 本体不进前端，除非打开设置对话框）。
    void api
      .getProfileTotp(p.id)
      .then((s) => setTotpConfigured(Boolean(s)))
      .catch(() => setTotpConfigured(false));
    void api
      .getProfileProxyPassword(p.id)
      .then((s) => {
        composerProxySecretRef.current = Boolean(s);
      })
      .catch(() => {
        composerProxySecretRef.current = false;
      });
    setCtxMenu(null);
  }

  /** 清除已绑定身份：保留用户名，改走「新建凭据」路径。 */
  function clearComposerIdentity() {
    composerSecretRef.current = null;
    setPassMasked(false);
    setComposer((d) => (d ? { ...d, credential_id: "", password: "" } : d));
  }

  function bindComposerCredential(id: string) {
    const cred = credentials.find((c) => c.id === id);
    if (!cred) return;
    const { auth, mfa } = authMethodOfCredential(cred);
    composerSecretRef.current = null;
    setPassMasked(false);
    setComposer((d) =>
      d
        ? {
            ...d,
            credential_id: id,
            username: cred.username,
            auth_method: auth,
            mfa,
            password: "",
          }
        : d,
    );
    void api
      .getCredential(id)
      .then((full) => {
        composerSecretRef.current = full.secret;
      })
      .catch(() => {});
  }

  function parseTags(raw: string): string[] {
    return Array.from(
      new Set(
        raw
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ).slice(0, 12);
  }

  /**
   * 校验并落库当前草稿，返回保存后的 Profile；失败返回 null（错误写 composerErr）。
   * 「保存」与「测试连接」共用，保证两条路径的校验 / 凭据 upsert 完全一致。
   */
  async function persistComposerDraft(
    d: ComposerDraft,
  ): Promise<Profile | null> {
    if (!d.name.trim() || !d.host.trim()) {
      setComposerErr("名称与主机为必填");
      return null;
    }
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setComposerErr("端口需在 1–65535 之间");
      return null;
    }
    if (d.auth_method === "certificate") {
      setComposerErr("证书认证尚未移植，请选择其他登录方式");
      return null;
    }
    const proxyErr = d.proxy_profile_id ? null : proxyDraftError(d.proxy);
    if (proxyErr) {
      setComposerErr(proxyErr);
      return null;
    }
    const effType = effectiveCredType(d);
    const username = d.username.trim();
    if (!d.credential_id && !username) {
      setComposerErr("请填写用户名");
      return null;
    }
    if (effType === "key" && !d.key_file && !composerSecretRef.current) {
      setComposerErr("请选择本地密钥");
      return null;
    }
    setComposerBusy(true);
    setComposerErr("");
    try {
      // ── 凭据 upsert（先于 Profile，保证连接能解析到新凭据）──
      let secret: string | null = null;
      if (effType === "password" || effType === "interactive") {
        if (d.password) secret = d.save_password ? d.password : null;
        else secret = d.save_password ? composerSecretRef.current : null; // 关「保存密码」= 删除已存口令
      } else if (effType === "key") {
        secret = d.key_file
          ? await api.readDefaultKeyFile(d.key_file)
          : composerSecretRef.current;
      }
      let credentialId = d.credential_id;
      if (!credentialId) {
        credentialId = newId();
        await api.createCredential({
          id: credentialId,
          name: `${username}@${d.host.trim()}`,
          username,
          type: effType,
          secret,
          save_to_remote: false,
        });
      } else {
        const existing = credentials.find((c) => c.id === credentialId);
        await api.updateCredential({
          id: credentialId,
          name: existing?.name ?? d.name.trim(),
          username: username || existing?.username || "",
          type: effType,
          secret,
          save_to_remote: existing?.save_to_remote ?? false,
        });
      }
      const parsedTags = parseTags(d.tags);
      const base: Profile = {
        id: d.id,
        name: d.name.trim(),
        host: d.host.trim(),
        port,
        credential_id: credentialId,
        bastion_profile_id: null,
        init_command: d.init_command.trim() || null,
        group_id: d.group_id || null,
        sftp_protocol: d.sftp_protocol,
        sftp_sudo: d.sftp_sudo,
        sftp_encoding: d.sftp_encoding,
        icon_source: d.icon_source,
        icon_color: d.icon_color || null,
        totp_auto_submit: d.totp_auto_submit,
        totp_regex: d.totp_regex.trim() || null,
        agent_forwarding: d.agent_forwarding,
        ssh_input_compatibility: d.ssh_input_compatibility,
        ...proxyProfileFields(d.proxy_profile_id ? EMPTY_PROXY_DRAFT : d.proxy),
        proxy_profile_id: d.proxy_profile_id || null,
      };
      const isEdit = profiles.some((p) => p.id === d.id);
      if (isEdit) {
        const existing = profiles.find((p) => p.id === d.id);
        await api.updateProfile({
          ...base,
          bastion_profile_id: existing?.bastion_profile_id ?? null,
          algorithms: existing?.algorithms,
        });
      } else {
        await api.createProfile(base);
        setOrder((prev) => [...prev, base.id]);
      }
      // 代理密码不落 Profile：引用代理库时清掉主机级密码（库条目自己存）；
      // 否则沿用 `proxy:<profile_id>`；undefined = 编辑时留空且原来有密码。
      if (d.proxy_profile_id) {
        await api.setProfileProxyPassword(base.id, null);
        composerProxySecretRef.current = false;
      } else {
        const proxySecret = proxyPasswordToSave(d.proxy, composerProxySecretRef.current);
        if (proxySecret !== undefined) {
          await api.setProfileProxyPassword(base.id, proxySecret);
          composerProxySecretRef.current = proxySecret !== null;
        }
      }
      await api.saveProfileEnv(
        base.id,
        d.env_vars.filter((v) => v.name.trim()),
      );
      // 终端编码与终端「更多 → 编码」共用同一份按主机偏好（Netcatty Host.charset）。
      saveTerminalEncoding(base.id, d.terminal_encoding);
      setHostTags(base.id, parsedTags);
      return base;
    } catch (e) {
      setComposerErr(userVisibleError(String(e)));
      return null;
    } finally {
      setComposerBusy(false);
    }
  }

  async function saveComposer() {
    const d = composer;
    if (!d) return;
    const saved = await persistComposerDraft(d);
    if (!saved) return;
    setComposer(null);
    onDataChanged();
  }

  // ── 测试连接（对齐 netcatty HostConnectionTestDialog）─────────────

  function stopConnectionTest() {
    testCleanupRef.current?.();
    testCleanupRef.current = null;
    setTestState(null);
  }

  /** 先落库草稿（新建 / 更新），再走真实 ssh_connect，进度事件驱动状态机。 */
  async function startConnectionTest() {
    const d = composer;
    if (!d || testState) return;
    const saved = await persistComposerDraft(d);
    if (!saved) return;
    onDataChanged();
    const sessionId = newId();
    let settled = false;
    let seconds = 0;
    let unlistenFn: (() => void) | null = null;
    setTestState({ status: "connecting", seconds: 0, error: "" });
    // 对齐 netcatty hostConnectionTest 默认 deadline：
    // TEST_TCP_CONNECT_TIMEOUT_MS(8s) + TEST_AUTH_READY_TIMEOUT_MS(15s) + TEST_DEADLINE_GRACE_MS(2s)。
    const timer = window.setInterval(() => {
      seconds += 1;
      setTestState((s) =>
        s && s.status === "connecting" ? { ...s, seconds } : s,
      );
      if (seconds >= 25) fail("连接超时");
    }, 1000);
    function finish(status: "success" | "failed", error: string) {
      if (settled) return;
      settled = true;
      window.clearInterval(timer);
      unlistenFn?.();
      void api.sshDisconnect(sessionId).catch(() => {});
      setTestState({ status, seconds, error });
    }
    function fail(error: string) {
      finish("failed", error);
    }
    unlistenFn = await api
      .onSshProgress(sessionId, (ev) => {
        if (ev.status === "error")
          fail(userVisibleError(ev.error ?? "连接失败。"));
        else if (ev.status === "connected" || ev.status === "shell")
          finish("success", "");
      })
      .catch(() => () => {});
    testCleanupRef.current = () => {
      window.clearInterval(timer);
      unlistenFn?.();
      void api.sshDisconnect(sessionId).catch(() => {});
    };
    try {
      await api.sshConnect(saved.id, 80, 24, sessionId);
    } catch (e) {
      fail(userVisibleError(String(e)));
    }
  }

  // ── TOTP 验证器（对齐 netcatty「设置验证器」对话框）──────────────

  function openTotpDialog() {
    const d = composer;
    if (!d) return;
    setTotpDialog({
      secret: "",
      autoSubmit: d.totp_auto_submit,
      regex: d.totp_regex,
    });
    if (totpConfigured) {
      // 已配置：回填现有密钥便于查看 / 替换。
      void api
        .getProfileTotp(d.id)
        .then((s) =>
          setTotpDialog((cur) => (cur ? { ...cur, secret: s ?? "" } : cur)),
        )
        .catch(() => {});
    }
  }

  /** 从 otpauth URI 提取 secret 参数；非 URI 原样返回（视为 Base32 密钥）。 */
  function parseTotpInput(raw: string): string | null {
    const text = raw.trim();
    if (!text) return null;
    if (/^otpauth:\/\//i.test(text)) {
      if (/\/hotp\//i.test(text)) return null; // HOTP 不支持
      const m = /[?&]secret=([a-z2-7=]+)/i.exec(text);
      return m ? (m[1] ?? "") : null;
    }
    return text;
  }

  async function saveTotpDialog() {
    const d = composer;
    const dlg = totpDialog;
    if (!d || !dlg) return;
    const secret = parseTotpInput(dlg.secret);
    if (!secret) {
      setComposerErr("无法从该内容读取 TOTP 密钥。");
      return;
    }
    try {
      await api.setProfileTotp(d.id, secret);
      setComposer({
        ...d,
        totp_auto_submit: dlg.autoSubmit,
        totp_regex: dlg.regex,
      });
      setTotpConfigured(true);
      setComposerErr("");
      setTotpDialog(null);
    } catch (e) {
      setComposerErr(userVisibleError(String(e)));
    }
  }

  async function removeTotp() {
    const d = composer;
    if (!d) return;
    if (!window.confirm("移除验证器？这台主机将不再保存这个 TOTP 密钥。"))
      return;
    try {
      await api.setProfileTotp(d.id, null);
      setTotpConfigured(false);
      setComposer({ ...d, totp_regex: "" });
    } catch (e) {
      setComposerErr(userVisibleError(String(e)));
    }
  }

  // ── 已知主机管理 ────────────────────────────────────────

  function loadKnownHosts() {
    setKhLoading(true);
    setKhErr("");
    api
      .knownHostsList()
      .then(setKnownHosts)
      .catch((e) => setKhErr(userVisibleError(String(e))))
      .finally(() => setKhLoading(false));
  }

  useEffect(() => {
    if (activeNav === "known-hosts") loadKnownHosts();
    if (activeNav === "hosts" || activeNav === "proxies") {
      api.listProxyProfiles().then(setProxyProfiles).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav]);

  const composerOpen = composer !== null;
  /** composer 是否为编辑既有主机（标题 / 身份 chip 显隐据此）。 */
  const isEditComposer =
    composer !== null && profiles.some((p) => p.id === composer.id);
  /** 已绑定凭据类型：绑定密钥时隐藏内联密码框（证书凭据尚未移植）。 */
  const boundCredType = composer?.credential_id
    ? credentials.find((c) => c.id === composer.credential_id)?.type
    : undefined;
  const composerPasswordVisible = boundCredType !== "key";
  useEffect(() => {
    if (!composerOpen) return;
    let alive = true;
    api
      .listSshKeyFiles()
      .then((f) => {
        if (alive) setKeyFiles(f);
      })
      .catch(() => {
        if (alive) setKeyFiles([]);
      });
    return () => {
      alive = false;
    };
  }, [composerOpen]);

  /** 删除走确认对话框（对齐 netcatty VaultDeleteConfirmDialog），不用 window.confirm。 */
  function confirmDeleteKnownHost() {
    const entry = khDelete;
    if (!entry) return;
    setKhDelete(null);
    api
      .knownHostsRemove(entry.host, entry.port)
      .then((n) => {
        showToast(n > 0 ? `已移除 ${n} 条记录` : "没有找到匹配条目");
        loadKnownHosts();
      })
      .catch((e) => setKhErr(userVisibleError(String(e))));
  }

  /** 「扫描系统」：重读 ~/.ssh/known_hosts（列表本身即系统文件）。 */
  async function scanSystemKnownHosts() {
    setKhScanning(true);
    try {
      const count = await api.knownHostsScanSystem();
      if (count === null) showToast("未找到系统 known_hosts 文件。");
      else if (count === 0) showToast("known_hosts 中没有可用条目。");
      else showToast(`已扫描系统 known_hosts，共 ${count} 条。`);
      loadKnownHosts();
    } catch (e) {
      showToast(`扫描系统 known_hosts 失败：${userVisibleError(String(e))}`);
    } finally {
      setKhScanning(false);
    }
  }

  /** 「导入文件」：选外部 known_hosts 去重合并进系统文件。 */
  async function importKnownHostsFile() {
    let path: string | null = null;
    try {
      path = await api.sftpPickOpenPath();
    } catch (e) {
      setKhErr(userVisibleError(String(e)));
      return;
    }
    if (!path) return;
    try {
      const n = await api.knownHostsImportFile(path);
      showToast(n > 0 ? `已导入 ${n} 个新主机。` : "没有发现新的主机。");
      loadKnownHosts();
    } catch (e) {
      setKhErr(userVisibleError(String(e)));
    }
  }

  /** 对齐 netcatty「转换为 host」：label=主机名、用户名留空、自动认证。 */
  function convertKnownHostToProfile(entry: KnownHostEntry) {
    const credId = newId();
    const profile: Profile = {
      id: newId(),
      name: entry.host,
      host: entry.host,
      port: entry.port,
      credential_id: credId,
      bastion_profile_id: null,
      init_command: null,
      group_id: null,
      agent_forwarding: false,
      ssh_input_compatibility: false,
    };
    api
      .createCredential({
        id: credId,
        name: `${entry.host}（已知主机）`,
        username: "",
        type: "agent",
        secret: null,
        save_to_remote: false,
      })
      .then(() => api.createProfile(profile))
      .then(() => {
        setOrder((prev) => [...prev, profile.id]);
        onDataChanged();
        showToast("已转换为主机档案");
      })
      .catch((e) => setKhErr(userVisibleError(String(e))));
  }

  // ── 主机库导入 / 导出 ─────────────────────────────────────

  /** 导出主机库：版本化 JSON；密码 / 私钥 / 凭据 secret 永不写入。 */
  async function exportVaultHosts() {
    try {
      const text = buildVaultExport(profiles, groups, { credentials, tags });
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await api.pickVaultExportFile(`termx-vault-${stamp}.json`);
      if (!path) return;
      await api.localWriteFile(path, new TextEncoder().encode(text));
      showToast(`已导出 ${profiles.length} 台主机`);
    } catch (e) {
      showToast(`导出失败：${userVisibleError(String(e))}`);
    }
  }

  /** 导入主机库：分组按名称去重；冲突统一选择覆盖或跳过（apply-to-all）。 */
  async function importVaultHosts() {
    try {
      const path = await api.pickVaultImportFile();
      if (!path) return;
      const bytes = await api.localReadFile(path, 8 * 1024 * 1024);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(
        Uint8Array.from(bytes),
      );
      const parsed = parseVaultImport(text);
      if (!parsed.ok) {
        showToast(`导入失败：${parsed.errors[0] ?? "文件内容无效"}`);
        return;
      }

      // 分组按 name 去重：已有分组直接复用，缺失的创建。
      const groupIdByName = new Map(
        groups.map((g) => [g.name.trim().toLowerCase(), g.id]),
      );
      const importedGroupId = new Map<string, string>();
      let createdGroups = 0;
      for (const g of parsed.groups) {
        const key = g.name.trim().toLowerCase();
        const existing = groupIdByName.get(key);
        if (existing) {
          importedGroupId.set(g.id, existing);
          continue;
        }
        const id = newId();
        await api.createGroup({
          id,
          name: g.name,
          color: g.color,
          sort_order: groups.length + createdGroups,
        });
        importedGroupId.set(g.id, id);
        groupIdByName.set(key, id);
        createdGroups += 1;
      }
      const resolveGroup = (host: VaultImportHost): string | null =>
        host.group_id ? importedGroupId.get(host.group_id) ?? null : null;

      const conflicts = findConflicts(parsed.hosts, profiles);
      let overwrite = false;
      if (conflicts.length > 0) {
        overwrite = window.confirm(
          `发现 ${conflicts.length} 台冲突主机（同名 / 同地址 / 同端口）。\n确定：全部覆盖；取消：全部跳过。`,
        );
      }
      const existingByKey = new Map(
        conflicts.map((c) => [hostConflictKey(c.host), c.existing]),
      );

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      const nextTags = { ...tags };
      for (const host of parsed.hosts) {
        const existing = existingByKey.get(hostConflictKey(host));
        if (existing) {
          if (!overwrite) {
            skipped += 1;
            continue;
          }
          try {
            await api.updateProfile(
              applyImportedHost(existing, host, resolveGroup(host)),
            );
            if (host.tags.length) nextTags[existing.id] = host.tags;
            updated += 1;
          } catch {
            failed += 1;
          }
          continue;
        }
        try {
          let credentialId = "";
          if (host.protocol !== "local") {
            credentialId = newId();
            await api.createCredential(
              credentialFromImportedHost(host, credentialId),
            );
          }
          const profileId = newId();
          await api.createProfile(
            importedHostToProfile(host, credentialId, resolveGroup(host), profileId),
          );
          if (host.tags.length) nextTags[profileId] = host.tags;
          created += 1;
        } catch {
          failed += 1;
        }
      }
      if (created + updated > 0) setTags(nextTags);
      onDataChanged();
      showToast(
        `导入完成：新增 ${created}，覆盖 ${updated}，跳过 ${skipped}${
          failed ? `，失败 ${failed}` : ""
        }`,
      );
    } catch (e) {
      showToast(`导入失败：${userVisibleError(String(e))}`);
    }
  }

  // ── 钥匙串页动作（对齐 netcatty KeychainManager） ─────────

  function openKcImport() {
    setKcDraft({ ...KC_EMPTY_DRAFT });
    setKcShowPass(false);
    setKcErr("");
    setKcPanel({ mode: "import", id: null });
  }

  function openKcGenerate() {
    setKcDraft({ ...KC_EMPTY_DRAFT });
    setKcShowPass(false);
    setKcErr("");
    setKcPanel({ mode: "generate", id: null });
  }

  function openKcView(cred: Credential) {
    setKcErr("");
    setKcCopied(false);
    setKcPanel({ mode: "view", id: cred.id });
  }

  /** 编辑需要私钥全文（列表接口不返回 secret），用 getCredential 补全。 */
  function openKcEdit(cred: Credential) {
    setKcErr("");
    setKcDraft({ ...KC_EMPTY_DRAFT, label: cred.name, publicKey: cred.username });
    setKcPanel({ mode: "edit", id: cred.id });
    api
      .getCredential(cred.id)
      .then((full) =>
        setKcDraft((prev) => ({ ...prev, privateKey: full.secret ?? "" })),
      )
      .catch((e) => setKcErr(userVisibleError(String(e))));
  }

  function closeKcPanel() {
    setKcPanel(null);
    setKcDraft(KC_EMPTY_DRAFT);
    setKcShowPass(false);
    setKcErr("");
  }

  /** 导入面板读文件：内容进私钥框，文件名（去扩展名）做默认 Label。 */
  function kcReadFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content =
        typeof e.target?.result === "string" ? e.target.result : "";
      if (!content) return;
      const label = file.name.replace(/\.(pem|key|pub|ppk)$/i, "");
      setKcDraft((prev) => ({
        ...prev,
        privateKey: content,
        label: prev.label || label,
      }));
    };
    reader.readAsText(file);
  }

  async function saveKcImport() {
    const label = kcDraft.label.trim();
    const privateKey = kcDraft.privateKey.trim();
    if (!label || !privateKey) {
      setKcErr("Label 和私钥为必填项");
      return;
    }
    setKcBusy(true);
    setKcErr("");
    try {
      const publicKey = kcDraft.publicKey.trim();
      await api.keychainImportKey(label, privateKey, publicKey || undefined);
      onDataChanged();
      showToast("密钥已保存");
      closeKcPanel();
    } catch (e) {
      setKcErr(userVisibleError(String(e)));
    } finally {
      setKcBusy(false);
    }
  }

  async function runKcGenerate() {
    const label = kcDraft.label.trim();
    if (!label) {
      setKcErr("请填写密钥的 Label");
      return;
    }
    setKcBusy(true);
    setKcErr("");
    try {
      const bits = kcDraft.algorithm === "ED25519" ? undefined : kcDraft.bits;
      await api.keychainGenerateKey(
        label,
        kcDraft.algorithm,
        bits,
        kcDraft.passphrase || undefined,
      );
      onDataChanged();
      showToast("密钥已生成");
      closeKcPanel();
    } catch (e) {
      setKcErr(userVisibleError(String(e)));
    } finally {
      setKcBusy(false);
    }
  }

  async function saveKcEdit() {
    const id = kcPanel?.id;
    if (!id) return;
    const cred = credentials.find((c) => c.id === id);
    if (!cred) return;
    const label = kcDraft.label.trim();
    const privateKey = kcDraft.privateKey.trim();
    if (!label || !privateKey) {
      setKcErr("Label 和私钥为必填项");
      return;
    }
    setKcBusy(true);
    setKcErr("");
    try {
      await api.updateCredential({
        ...cred,
        name: label,
        username: kcDraft.publicKey.trim(),
        secret: privateKey,
      });
      onDataChanged();
      showToast("修改已保存");
      closeKcPanel();
    } catch (e) {
      setKcErr(userVisibleError(String(e)));
    } finally {
      setKcBusy(false);
    }
  }

  function confirmKcDeleteKey() {
    const cred = kcDelete;
    if (!cred) return;
    setKcDelete(null);
    api
      .deleteCredential(cred.id)
      .then(() => {
        if (kcPanel?.id === cred.id) closeKcPanel();
        onDataChanged();
        showToast("密钥已删除");
      })
      .catch((e) => setKcErr(userVisibleError(String(e))));
  }

  function copyKcPublicKey(cred: Credential) {
    if (!cred.username) return;
    navigator.clipboard
      .writeText(cred.username)
      .then(() => showToast("公钥已复制"))
      .catch(() => showToast("复制失败"));
  }

  /** 单张已知主机卡片（网格 / 列表共用，对齐 netcatty HostItem）。 */
  function khCard(e: KnownHostEntry, index: number, convertedSet: Set<string>) {
    const converted = convertedSet.has(`${e.host}:${e.port}`);
    return (
      <div
        key={`${e.host}-${e.port}-${index}`}
        className={`kh-card${khView === "list" ? " list" : ""}${
          converted ? " converted" : ""
        }`}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setKhCtx({
            entry: e,
            x: Math.min(ev.clientX, window.innerWidth - 216),
            y: Math.min(ev.clientY, window.innerHeight - 140),
          });
        }}
      >
        <span className="kh-card-icon">
          <Icon name="server" size={18} />
        </span>
        <span
          className="kh-card-name"
          title={e.port !== 22 ? `${e.host}:${e.port}` : e.host}
        >
          {e.host}
        </span>
        <span className="kh-card-actions">
          {!converted && (
            <button
              className="nc-icon-btn"
              title="转换为主机"
              onClick={() => convertKnownHostToProfile(e)}
            >
              <Icon name="arrow-right" size={14} />
            </button>
          )}
          <button
            className="nc-icon-btn danger"
            title="删除"
            onClick={() => setKhDelete(e)}
          >
            <Icon name="trash" size={14} />
          </button>
        </span>
      </div>
    );
  }

  function knownHostsPanel() {
    // 按主机名去重、保留文件里靠后的条目（更晚写入 = 更新），对齐 netcatty。
    const deduped: KnownHostEntry[] = [];
    {
      const byHost = new Map<string, number>();
      knownHosts.forEach((e, i) => byHost.set(e.host, i));
      knownHosts.forEach((e, i) => {
        if (byHost.get(e.host) === i) deduped.push(e);
      });
    }
    const keyword = khQuery.trim().toLowerCase();
    const filtered0 = keyword
      ? deduped.filter(
          (e) =>
            e.host.toLowerCase().includes(keyword) ||
            e.key_type.toLowerCase().includes(keyword),
        )
      : deduped;
    const orderOf = (e: KnownHostEntry) => deduped.indexOf(e);
    const filtered = [...filtered0].sort((a, b) => {
      switch (khSort) {
        case "az":
          return a.host.localeCompare(b.host);
        case "za":
          return b.host.localeCompare(a.host);
        case "newest":
          return orderOf(b) - orderOf(a);
        case "oldest":
          return orderOf(a) - orderOf(b);
        default:
          return 0;
      }
    });
    const displayed = filtered.slice(0, KH_RENDER_LIMIT);
    // 已存在同 host:port 的主机档案 → 视为已转换（卡片降透明、隐藏转换按钮）。
    const convertedSet = new Set(profiles.map((p) => `${p.host}:${p.port}`));
    return (
      <div className="vault-known-hosts">
        <div className="kh-toolbar">
          <div className="vault-search kh-search">
            <Icon name="search" size={14} className="nc-search-icon" />
            <input
              value={khQuery}
              placeholder="搜索已知主机..."
              onChange={(e) => setKhQuery(e.target.value)}
            />
          </div>
          <div className="kh-toolbar-tools">
            <div className="vault-view-wrap">
              <button
                className="vault-icon-btn"
                title="切换视图"
                onClick={() => {
                  setKhViewMenu((v) => !v);
                  setKhSortMenu(false);
                }}
              >
                <Icon name={khView === "grid" ? "grid" : "list"} size={16} />
                <Icon name="chevron-down" size={10} />
              </button>
              {khViewMenu && (
                <div className="vault-view-menu vault-popmenu">
                  <button
                    className={khView === "grid" ? "active" : ""}
                    onClick={() => {
                      setKhView("grid");
                      setKhViewMenu(false);
                    }}
                  >
                    <Icon name="grid" size={14} />
                    网格
                  </button>
                  <button
                    className={khView === "list" ? "active" : ""}
                    onClick={() => {
                      setKhView("list");
                      setKhViewMenu(false);
                    }}
                  >
                    <Icon name="list" size={14} />
                    列表
                  </button>
                </div>
              )}
            </div>
            <div className="vault-view-wrap">
              <button
                className="vault-icon-btn"
                title={`排序：${KH_SORT_LABEL[khSort]}`}
                onClick={() => {
                  setKhSortMenu((v) => !v);
                  setKhViewMenu(false);
                }}
              >
                <Icon name="sort" size={16} />
                <Icon name="chevron-down" size={10} />
              </button>
              {khSortMenu && (
                <div className="vault-view-menu vault-popmenu">
                  {(Object.keys(KH_SORT_LABEL) as KhSortMode[]).map((m) => (
                    <button
                      key={m}
                      className={khSort === m ? "active" : ""}
                      onClick={() => {
                        setKhSort(m);
                        setKhSortMenu(false);
                      }}
                    >
                      <Icon name="sort" size={14} />
                      {KH_SORT_LABEL[m]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="kh-toolbar-sep" />
          <button
            className="kh-action-btn"
            onClick={scanSystemKnownHosts}
            disabled={khScanning}
          >
            <Icon
              name="refresh"
              size={14}
              className={khScanning ? "kh-spin" : undefined}
            />
            扫描系统
          </button>
          <button className="kh-action-btn" onClick={importKnownHostsFile}>
            <Icon name="import" size={14} />
            导入文件
          </button>
        </div>
        {khErr && <div className="vault-composer-err">{khErr}</div>}
        <div className={khView === "grid" ? "kh-grid" : "kh-list"}>
          {displayed.length === 0 && !khLoading ? (
            keyword ? (
              <div className="vault-empty kh-empty-full">
                <span className="vault-empty-icon">
                  <Icon name="search" size={26} />
                </span>
                <h2>没有匹配的已知主机</h2>
                <p>换个关键词试试。</p>
              </div>
            ) : (
              <div className="kh-empty">
                <span className="kh-empty-icon">
                  <Icon name="shield" size={32} />
                </span>
                <h3>暂无已知主机</h3>
                <p>
                  Known Hosts 是你之前连接过的 SSH
                  server。导入系统的 known_hosts 文件以开始。
                </p>
                <div className="kh-empty-actions">
                  <button
                    className="kh-action-btn"
                    onClick={scanSystemKnownHosts}
                    disabled={khScanning}
                  >
                    <Icon
                      name="refresh"
                      size={14}
                      className={khScanning ? "kh-spin" : undefined}
                    />
                    扫描系统
                  </button>
                  <button
                    className="kh-action-btn outline"
                    onClick={importKnownHostsFile}
                  >
                    <Icon name="folder-open" size={14} />
                    浏览文件
                  </button>
                </div>
              </div>
            )
          ) : (
            displayed.map((e, i) => khCard(e, i, convertedSet))
          )}
          {filtered.length > KH_RENDER_LIMIT && (
            <div className="kh-limit-note">
              显示 {displayed.length}/{filtered.length} 个主机。使用搜索查找特定主机。
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── 钥匙串页（对齐 netcatty KeychainManager / KeyCard） ────

  /** 单张密钥卡片（网格 / 列表共用，对齐 netcatty KeyCard）。 */
  function kcCard(cred: Credential) {
    const active =
      kcPanel !== null &&
      (kcPanel.mode === "view" || kcPanel.mode === "edit") &&
      kcPanel.id === cred.id;
    return (
      <div
        key={cred.id}
        className={`kc-card${kcView === "list" ? " list" : ""}${
          active ? " selected" : ""
        }`}
        onClick={() => openKcView(cred)}
        onContextMenu={(ev) => {
          ev.preventDefault();
          setKcCtx({
            cred,
            x: Math.min(ev.clientX, window.innerWidth - 200),
            y: Math.min(ev.clientY, window.innerHeight - 150),
          });
        }}
      >
        <span className="kc-card-icon">
          <Icon name="key" size={16} />
        </span>
        <span className="kc-card-main">
          <span className="kc-card-label" title={cred.name}>
            {cred.name}
          </span>
          <span className="kc-card-type">Type {kcTypeOf(cred.username)}</span>
        </span>
        <span className="kc-card-actions">
          <button
            className="nc-icon-btn"
            title="编辑"
            onClick={(e) => {
              e.stopPropagation();
              openKcEdit(cred);
            }}
          >
            <Icon name="pencil" size={14} />
          </button>
        </span>
      </div>
    );
  }

  /** 钥匙串侧滑面板（对齐 netcatty AsidePanel + 四种密钥面板）。 */
  function kcPanelAside() {
    if (!kcPanel) return null;
    const panel = kcPanel;
    const current =
      panel.id !== null
        ? credentials.find((c) => c.id === panel.id) ?? null
        : null;
    const passInput = (
      <div className="kc-pass-wrap">
        <input
          className="kc-input"
          type={kcShowPass ? "text" : "password"}
          value={kcDraft.passphrase}
          placeholder="Passphrase（可选）"
          disabled={kcBusy}
          onChange={(e) =>
            setKcDraft({ ...kcDraft, passphrase: e.target.value })
          }
        />
        <button
          className="nc-icon-btn kc-pass-eye"
          title={kcShowPass ? "隐藏密码短语" : "显示密码短语"}
          onClick={() => setKcShowPass(!kcShowPass)}
        >
          <Icon name={kcShowPass ? "eye-off" : "eye"} size={14} />
        </button>
      </div>
    );
    const savePassRow = (
      <label className="kc-check-row">
        <input
          type="checkbox"
          checked={kcDraft.savePassphrase}
          disabled={kcBusy}
          onChange={(e) =>
            setKcDraft({ ...kcDraft, savePassphrase: e.target.checked })
          }
        />
        <span>保存 Passphrase</span>
      </label>
    );
    return (
      <aside className="kc-panel" data-section="keychain-panel">
        <header className="kc-panel-head">
          <span className="kc-panel-title">{KC_PANEL_TITLE[panel.mode]}</span>
          <div className="kc-panel-head-actions">
            {panel.mode === "view" && current && (
              <>
                <button
                  className="nc-icon-btn"
                  title="复制公钥"
                  disabled={!current.username}
                  onClick={() => {
                    copyKcPublicKey(current);
                    setKcCopied(true);
                    window.setTimeout(() => setKcCopied(false), 2000);
                  }}
                >
                  <Icon name={kcCopied ? "check" : "copy"} size={15} />
                </button>
                <button
                  className="nc-icon-btn"
                  title="编辑"
                  onClick={() => openKcEdit(current)}
                >
                  <Icon name="pencil" size={15} />
                </button>
                <button
                  className="nc-icon-btn danger"
                  title="删除"
                  onClick={() => setKcDelete(current)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </>
            )}
            <button
              className="nc-icon-btn"
              title="关闭面板"
              onClick={closeKcPanel}
            >
              <Icon name="x" size={15} />
            </button>
          </div>
        </header>
        <div className="kc-panel-body">
          {kcErr && <div className="vault-composer-err">{kcErr}</div>}

          {panel.mode === "import" && (
            <>
              <div className="kc-field">
                <span className="kc-label">名称</span>
                <input
                  className="kc-input"
                  value={kcDraft.label}
                  placeholder="密钥 Label"
                  onChange={(e) =>
                    setKcDraft({ ...kcDraft, label: e.target.value })
                  }
                />
              </div>
              <div className="kc-field">
                <span className="kc-label">私钥 *</span>
                <textarea
                  className="kc-textarea"
                  value={kcDraft.privateKey}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  onChange={(e) =>
                    setKcDraft({ ...kcDraft, privateKey: e.target.value })
                  }
                />
              </div>
              <div className="kc-field">
                <span className="kc-label">公钥</span>
                <textarea
                  className="kc-textarea short"
                  value={kcDraft.publicKey}
                  placeholder="ssh-ed25519 AAAAC3... user@host"
                  onChange={(e) =>
                    setKcDraft({ ...kcDraft, publicKey: e.target.value })
                  }
                />
              </div>
              <div className="kc-field">
                <span className="kc-label">密码短语</span>
                {passInput}
              </div>
              {savePassRow}
              <div
                className="kc-dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) kcReadFile(file);
                }}
              >
                <div className="kc-dropzone-hint">
                  <Icon name="upload" size={16} />
                  <span>将密钥文件拖到这里</span>
                </div>
                <button
                  className="kh-action-btn kc-block"
                  onClick={() => kcFileRef.current?.click()}
                >
                  从文件导入
                </button>
              </div>
              <button
                className="kc-primary-btn kc-block kc-btn-lg"
                disabled={
                  kcBusy ||
                  !kcDraft.label.trim() ||
                  !kcDraft.privateKey.trim()
                }
                onClick={() => void saveKcImport()}
              >
                保存密钥
              </button>
            </>
          )}

          {panel.mode === "generate" && (
            <>
              <div className="kc-field">
                <span className="kc-label">名称</span>
                <input
                  className="kc-input"
                  value={kcDraft.label}
                  placeholder="密钥 Label"
                  disabled={kcBusy}
                  onChange={(e) =>
                    setKcDraft({ ...kcDraft, label: e.target.value })
                  }
                />
              </div>
              <div className="kc-field">
                <span className="kc-label">密钥类型</span>
                <select
                  className="kc-select"
                  value={kcDraft.algorithm}
                  disabled={kcBusy}
                  onChange={(e) => {
                    const algorithm = e.target.value as KcDraft["algorithm"];
                    setKcDraft({
                      ...kcDraft,
                      algorithm,
                      bits:
                        algorithm === "RSA"
                          ? 4096
                          : algorithm === "ECDSA"
                            ? 256
                            : kcDraft.bits,
                    });
                  }}
                >
                  <optgroup label="标准密钥">
                    <option value="ED25519">ED25519</option>
                    <option value="ECDSA">ECDSA</option>
                    <option value="RSA">RSA</option>
                  </optgroup>
                  <optgroup label="安全密钥 · FIDO2">
                    <option value="ED25519-SK" disabled>
                      ED25519-SK
                    </option>
                    <option value="ECDSA-SK" disabled>
                      ECDSA-SK
                    </option>
                  </optgroup>
                </select>
              </div>
              {kcDraft.algorithm !== "ED25519" && (
                <div className="kc-field">
                  <span className="kc-label">密钥长度</span>
                  <select
                    className="kc-select"
                    value={String(kcDraft.bits)}
                    disabled={kcBusy}
                    onChange={(e) =>
                      setKcDraft({ ...kcDraft, bits: Number(e.target.value) })
                    }
                  >
                    {(kcDraft.algorithm === "RSA"
                      ? [4096, 2048, 1024]
                      : [256, 384, 521]
                    ).map((size) => (
                      <option key={size} value={String(size)}>
                        {kcDraft.algorithm === "RSA"
                          ? `${size} bits`
                          : `P-${size}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="kc-field">
                <span className="kc-label">密码短语</span>
                {passInput}
              </div>
              {savePassRow}
              <button
                className="kc-primary-btn kc-block kc-btn-lg"
                disabled={kcBusy || !kcDraft.label.trim()}
                onClick={() => void runKcGenerate()}
              >
                {kcBusy ? "正在生成…" : "生成并保存"}
              </button>
            </>
          )}

          {panel.mode === "view" && current && (
            <>
              <div className="kc-field">
                <span className="kc-label">名称</span>
                <p className="kc-view-value">{current.name}</p>
              </div>
              {current.username && (
                <div className="kc-field">
                  <span className="kc-label">公钥</span>
                  <div className="kc-pub-box">
                    <div className="kc-pub-text">{current.username}</div>
                    <div className="kc-pub-side">
                      <button
                        className="nc-icon-btn"
                        title="复制公钥"
                        onClick={() => {
                          copyKcPublicKey(current);
                          setKcCopied(true);
                          window.setTimeout(() => setKcCopied(false), 2000);
                        }}
                      >
                        <Icon name={kcCopied ? "check" : "copy"} size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <div className="kc-field">
                <span className="kc-label">类型</span>
                <p className="kc-view-value">{kcTypeOf(current.username)}</p>
              </div>
            </>
          )}

          {panel.mode === "edit" && (
            <>
              <div className="kc-field">
                <span className="kc-label">Label *</span>
                <input
                  className="kc-input"
                  value={kcDraft.label}
                  placeholder="密钥 Label"
                  onChange={(e) =>
                    setKcDraft({ ...kcDraft, label: e.target.value })
                  }
                />
              </div>
              <div className="kc-field">
                <span className="kc-label">私钥 *</span>
                <textarea
                  className="kc-textarea tall"
                  value={kcDraft.privateKey}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  onChange={(e) =>
                    setKcDraft({ ...kcDraft, privateKey: e.target.value })
                  }
                />
              </div>
              <div className="kc-field">
                <span className="kc-label">公钥</span>
                <textarea
                  className="kc-textarea short"
                  value={kcDraft.publicKey}
                  placeholder="ssh-ed25519 AAAA..."
                  onChange={(e) =>
                    setKcDraft({ ...kcDraft, publicKey: e.target.value })
                  }
                />
              </div>
              <div className="kc-field">
                <span className="kc-label">密码短语</span>
                {passInput}
              </div>
              {savePassRow}
              <button
                className="kc-primary-btn kc-block kc-btn-lg"
                disabled={
                  kcBusy ||
                  !kcDraft.label.trim() ||
                  !kcDraft.privateKey.trim()
                }
                onClick={() => void saveKcEdit()}
              >
                保存修改
              </button>
            </>
          )}
        </div>
      </aside>
    );
  }

  function keysPanel() {
    const allKeys = credentials.filter((c) => c.type === "key");
    const q = kcQuery.trim().toLowerCase();
    const filtered = q
      ? allKeys.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            kcTypeOf(c.username).toLowerCase().includes(q) ||
            c.username.toLowerCase().includes(q),
        )
      : allKeys;
    return (
      <div className={`vault-keychain${kcPanel ? " panel-open" : ""}`}>
        <input
          ref={kcFileRef}
          type="file"
          className="kc-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) kcReadFile(file);
            e.target.value = "";
          }}
        />
        <div className="kc-body">
          <div className="kc-toolbar">
            <div className="kc-toolbar-actions">
              <div className="kc-split">
                <button className="kc-split-main" onClick={openKcImport}>
                  <Icon name="plus" size={14} />
                  新建密钥
                </button>
                <button
                  className="kc-split-caret"
                  title="更多新建方式"
                  onClick={() => setKcNewMenu((v) => !v)}
                >
                  <Icon name="chevron-down" size={14} />
                </button>
                {kcNewMenu && (
                  <div className="vault-view-menu vault-new-menu vault-popmenu">
                    <button
                      onClick={() => {
                        setKcNewMenu(false);
                        openKcGenerate();
                      }}
                    >
                      <Icon name="key" size={14} />
                      生成密钥
                    </button>
                  </div>
                )}
              </div>
              <button className="kh-action-btn" onClick={openKcImport}>
                <Icon name="badge-check" size={14} />
                导入证书
              </button>
              <button
                className="kh-action-btn"
                disabled
                title="身份存储尚未移植"
              >
                <Icon name="user" size={14} />
                新建身份
              </button>
            </div>
            <div className="kc-toolbar-right">
              {!kcPanel && (
                <div className="vault-search kc-search">
                  <Icon name="search" size={14} className="nc-search-icon" />
                  <input
                    value={kcQuery}
                    placeholder="搜索..."
                    onChange={(e) => setKcQuery(e.target.value)}
                  />
                </div>
              )}
              <div className="vault-view-wrap">
                <button
                  className="vault-icon-btn"
                  title="切换视图"
                  onClick={() => setKcViewMenu((v) => !v)}
                >
                  <Icon name={kcView === "grid" ? "grid" : "list"} size={16} />
                  <Icon name="chevron-down" size={10} />
                </button>
                {kcViewMenu && (
                  <div className="vault-view-menu vault-popmenu">
                    <button
                      className={kcView === "grid" ? "active" : ""}
                      onClick={() => {
                        setKcView("grid");
                        setKcViewMenu(false);
                      }}
                    >
                      <Icon name="grid" size={14} />
                      网格
                    </button>
                    <button
                      className={kcView === "list" ? "active" : ""}
                      onClick={() => {
                        setKcView("list");
                        setKcViewMenu(false);
                      }}
                    >
                      <Icon name="list" size={14} />
                      列表
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="kc-section">
            <div className="kc-section-head">
              <h3 className="vault-section-title">密钥</h3>
              <span className="kc-section-count">{filtered.length} 项</span>
            </div>
            {allKeys.length === 0 ? (
              <div className="kc-empty">
                <span className="kc-empty-icon">
                  <Icon name="shield" size={32} />
                </span>
                <h3>设置密钥</h3>
                <p>导入或生成 SSH 密钥用于安全认证。</p>
                <div className="kc-empty-actions">
                  <button className="kh-action-btn" onClick={openKcImport}>
                    <Icon name="upload" size={14} />
                    导入
                  </button>
                  <button className="kc-primary-btn" onClick={openKcGenerate}>
                    <Icon name="plus" size={14} />
                    生成
                  </button>
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <div className="kc-no-results">没有匹配结果</div>
            ) : (
              <div className={kcView === "grid" ? "kc-grid" : "kc-list"}>
                {filtered.map((c) => kcCard(c))}
              </div>
            )}
          </div>
        </div>
        {kcPanelAside()}
      </div>
    );
  }

  // ── 卡片 ────────────────────────────────────────────────

  function hostCard(p: Profile) {
    const compact = view !== "grid";
    const isSelected = selected.has(p.id);
    const isPinned = pinnedIds.includes(p.id);
    const ownTags = tags[p.id] ?? [];
    return (
      <div
        key={p.id}
        data-nav-id={p.id}
        data-host-id={p.id}
        className={`vault-host-card${compact ? " list" : ""}${
          isSelected ? " selected" : ""
        }${focusId === p.id ? " focused" : ""}`}
        role={selectMode ? "checkbox" : "button"}
        aria-checked={selectMode ? isSelected : undefined}
        tabIndex={0}
        draggable={!selectMode}
        onDragStart={(e) => startHostDrag(e, p)}
        onDragEnd={endHostDrag}
        onFocus={() => setFocusId(p.id)}
        onClick={() => handleCardClick(p)}
        onKeyDown={(e) => handleCardKey(e, p)}
        onContextMenu={(e) => openContextMenu(e, p)}
        title={`${p.name} · ${fullSubtitle(p)}${
          ownTags.length ? ` · 标签：${ownTags.join("、")}` : ""
        }`}
      >
        {selectMode && (
          <span className="vault-host-check">
            <Icon name={isSelected ? "check-square" : "square"} size={18} />
          </span>
        )}
        {!selectMode && view === "grid" && isPinned && (
          <span className="vault-host-star" title="已置顶">
            <Icon name="pin" size={12} />
          </span>
        )}
        <DistroAvatar profile={p} size="lg" />
        <span className="vault-host-card-main">
          <strong>{p.name}</strong>
          <span className="vault-host-card-sub">{subtitle(p)}</span>
          {ownTags.length > 0 && (
            <span className="vault-host-tags">
              {ownTags.slice(0, 3).map((t) => (
                <span key={t} className="vault-host-tag">
                  {t}
                </span>
              ))}
            </span>
          )}
        </span>
        {!selectMode && (
          <button
            className="vault-host-edit"
            title={`Edit ${p.name}`}
            onClick={(e) => {
              e.stopPropagation();
              if (p.protocol === "local") setLocalPanel(p);
              else if (p.protocol === "serial") setSerialPanel(p);
              else openComposerForEdit(p);
            }}
          >
            <Icon name="pencil" size={13} />
          </button>
        )}
        <span className="vault-host-card-go">
          <Icon name="terminal" size={14} />
        </span>
      </div>
    );
  }

  // 本地卡显示名：设置 local_shell → 发现列表名 / 命令名；空设置回退默认 shell。
  const localMatchedShell = discoveredShells.find(
    (s) => s.id === localShellSetting,
  );
  const localName = localShellSetting
    ? (localMatchedShell?.name ?? shellDisplayName(localShellSetting))
    : shellDisplayName(localShellCmd);
  const localCard = (compact = false) => (
    <div
      key="__local"
      className={`vault-host-card${compact ? " list" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onLocal()}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onLocal();
      }}
      title="新建本地终端"
    >
      <span className="nc-avatar lg local">
        <Icon name="terminal" size={20} />
      </span>
      <span className="vault-host-card-main">
        <strong>{localName}</strong>
        <span className="vault-host-card-sub">{localName}</span>
      </span>
      <span className="vault-host-card-go">
        <Icon name="terminal" size={14} />
      </span>
    </div>
  );

  function groupCard(g: GroupTile) {
    const compact = view !== "grid";
    const isSelected = selectedGroups.has(g.id);
    const isDropTarget = dropGroupId === g.id;
    const editable = g.id !== "__ungrouped";
    return (
      <div
        key={g.id}
        data-nav-id={`group:${g.id}`}
        data-group-path={g.id}
        className={`vault-host-card vault-group-card${compact ? " list" : ""}${
          isSelected ? " selected" : ""
        }${isDropTarget ? " drop-target" : ""}`}
        role={selectMode ? "checkbox" : "button"}
        aria-checked={selectMode ? isSelected : undefined}
        tabIndex={0}
        onDragOver={editable ? (e) => allowDrop(e, g.id) : undefined}
        onDragLeave={() => setDropGroupId(null)}
        onDrop={editable ? (e) => dropOnGroup(e, g.id) : undefined}
        onClick={() => {
          if (selectMode) {
            if (editable) toggleGroupSelect(g.id);
            return;
          }
          setActiveGroupId(g.id);
          clearSelection();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          if (selectMode) {
            if (editable) toggleGroupSelect(g.id);
            return;
          }
          setActiveGroupId(g.id);
          clearSelection();
        }}
        onContextMenu={(e) => openGroupMenu(e, g)}
        title={`进入分组 ${g.name}`}
      >
        {selectMode && editable && (
          <span className="vault-host-check">
            <Icon name={isSelected ? "check-square" : "square"} size={18} />
          </span>
        )}
        <span className="nc-avatar lg group">
          <Icon name="folder" size={20} />
        </span>
        <span className="vault-host-card-main">
          <strong>{g.name}</strong>
          <span className="vault-host-card-sub">{g.count} 台主机</span>
        </span>
        {!selectMode && editable && (
          <button
            className="vault-host-edit"
            title="重命名分组"
            onClick={(e) => {
              e.stopPropagation();
              setGroupDialog({
                id: g.id,
                name: g.name,
                proxy_profile_id: g.proxy_profile_id ?? null,
              });
            }}
          >
            <Icon name="pencil" size={13} />
          </button>
        )}
        <span className="vault-host-card-go">
          <Icon name="chevron-right" size={14} />
        </span>
      </div>
    );
  }

  function hostCollection(hosts: Profile[]) {
    return (
      <div className={view === "grid" ? "vault-grid" : "vault-list"}>
        {hosts.map((p) => hostCard(p))}
      </div>
    );
  }

  return (
    <section className="vault-shell" data-section="vault-view">
      <aside
        className={`vault-sidebar${collapsed ? " collapsed" : ""}${
          resizing ? " resizing" : ""
        }`}
        data-section="vault-sidebar"
        style={collapsed ? undefined : { width: sidebarWidth }}
      >
        <div className="vault-sidebar-brand">
          <button
            className="vault-logo"
            title={collapsed ? "展开导航" : "收起导航"}
            onClick={() => setCollapsed((v) => !v)}
          >
            <Icon name="terminal" size={19} />
          </button>
          {!collapsed && <span className="vault-wordmark">termX</span>}
          {!collapsed && (
            <button
              className="vault-collapse-btn"
              title="收起导航"
              onClick={() => setCollapsed(true)}
            >
              <Icon name="chevron-right" size={14} />
            </button>
          )}
        </div>

        <nav className="vault-nav">
          {navItems.map((item) => {
            const enabled = Boolean(item.enabled);
            return (
              <button
                key={item.id}
                className={`vault-nav-item${
                  item.id === activeNav ? " active" : ""
                }${collapsed ? " collapsed" : ""}`}
                disabled={!enabled}
                title={enabled ? item.label : `${item.label}（尚未实现）`}
                onClick={() => {
                  if (!enabled) return;
                  setActiveNav(item.id);
                  setComposer(null);
                  setCtxMenu(null);
                  if (item.id !== "hosts") {
                    setSelectMode(false);
                    setSelected(new Set());
                  }
                }}
              >
                <item.icon size={16} />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="vault-sidebar-foot">
          {/* 对齐 Netcatty VaultViewLayout：设置入口固定在侧栏底部（顶栏齿轮保留）。 */}
          <button
            className={`vault-nav-item${collapsed ? " collapsed" : ""}`}
            title="设置"
            onClick={onOpenSettings}
          >
            <Settings size={16} />
            {!collapsed && <span>设置</span>}
          </button>
          {!collapsed && <span className="vault-version">termX 0.0.1</span>}
        </div>
      </aside>

      {!collapsed && (
        <div
          className="vault-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整导航宽度"
          onPointerDown={startResize}
        />
      )}

      <div className="vault-stage" data-section="vault-stage">
        <div className="vault-surface" data-section="vault-surface">
          {/* 对齐 Netcatty VaultPageHeader：主机工具栏只在「主机」section 显示，其它 section 整行隐藏（不做过渡动画）。 */}
          <header
            className={`vault-header${activeNav === "hosts" ? "" : " is-hidden"}`}
          >
            <div className={`vault-search${quick ? " quick" : ""}`}>
              <Icon name="search" size={14} className="nc-search-icon" />
              <input
                value={query}
                placeholder="查找主机或 ssh user@hostname / ssh -p 2222 user@hostname…"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && quick) runQuickConnect();
                }}
              />
              {quick && (
                <span className="vault-quick-tag" title="识别为快速连接">
                  <Icon name="zap" size={14} />
                </span>
              )}
            </div>
            <button
              className={`vault-connect-btn${quick ? " primary" : ""}`}
              title={
                quick
                  ? `快速连接 ${quick.host}:${quick.port}`
                  : "打开快速切换器，按名称 / 主机快速定位主机"
              }
              onClick={runQuickConnect}
            >
              连接
            </button>

            <div className="vault-header-tools">
              <div className="vault-view-wrap">
                <button
                  className="vault-icon-btn"
                  title="切换视图"
                  onClick={() => {
                    setViewMenu((v) => !v);
                    setSortMenu(false);
                  }}
                >
                  <Icon name={viewIcon(view)} size={16} />
                  <Icon name="chevron-down" size={10} />
                </button>
                {viewMenu && (
                  <div className="vault-view-menu vault-popmenu">
                    {(["grid", "list", "tree"] as ViewMode[]).map((m) => (
                      <button
                        key={m}
                        className={view === m ? "active" : ""}
                        onClick={() => {
                          setView(m);
                          if (m === "tree") setActiveGroupId(null);
                          clearSelection();
                          setViewMenu(false);
                        }}
                      >
                        <Icon name={viewIcon(m)} size={14} />
                        {m === "grid" ? "网格" : m === "list" ? "列表" : "树形"}
                      </button>
                    ))}
                    <div className="term-menu-sep" />
                    <button
                      className={clickBehavior === "connect" ? "active" : ""}
                      onClick={() => {
                        setClickBehavior("connect");
                        setViewMenu(false);
                      }}
                    >
                      <Icon name="terminal" size={14} />
                      单击直接连接
                    </button>
                    <button
                      className={clickBehavior === "select" ? "active" : ""}
                      onClick={() => {
                        setClickBehavior("select");
                        setViewMenu(false);
                      }}
                    >
                      <Icon name="check-square" size={14} />
                      单击先选中
                    </button>
                  </div>
                )}
              </div>
              <div className="vault-view-wrap">
                <button
                  className={`vault-icon-btn${selectedTags.length ? " active" : ""}`}
                  title={
                    selectedTags.length
                      ? `标签筛选：${selectedTags.join("、")}`
                      : "标签筛选"
                  }
                  onClick={() => {
                    setTagMenu((v) => !v);
                    setViewMenu(false);
                    setSortMenu(false);
                  }}
                >
                  <Icon name="tag" size={16} />
                  <Icon name="chevron-down" size={10} />
                </button>
                {tagMenu && (
                  <div className="vault-view-menu vault-tag-menu vault-popmenu">
                    <div className="vault-tag-search">
                      <Icon name="search" size={13} />
                      <input
                        value={tagQuery}
                        placeholder="搜索标签…"
                        onChange={(e) => setTagQuery(e.target.value)}
                      />
                    </div>
                    {(() => {
                      const filtered = allTagNames.filter((t) =>
                        t.toLowerCase().includes(tagQuery.trim().toLowerCase()),
                      );
                      if (filtered.length === 0) {
                        return (
                          <div className="vault-tag-empty">
                            暂无标签；可在主机右键「编辑」的标签字段里添加
                          </div>
                        );
                      }
                      return filtered.map((t) => (
                        <div className="vault-tag-row" key={t}>
                          {tagRename?.from === t ? (
                            <input
                              className="vault-tag-rename"
                              autoFocus
                              value={tagRename.value}
                              onChange={(e) =>
                                setTagRename({ from: t, value: e.target.value })
                              }
                              onBlur={() => renameTag(t, tagRename.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") renameTag(t, tagRename.value);
                                if (e.key === "Escape") setTagRename(null);
                              }}
                            />
                          ) : (
                            <>
                              <label className="vault-tag-check">
                                <input
                                  type="checkbox"
                                  checked={selectedTags.includes(t)}
                                  onChange={() =>
                                    setSelectedTags((prev) =>
                                      prev.includes(t)
                                        ? prev.filter((x) => x !== t)
                                        : [...prev, t],
                                    )
                                  }
                                />
                                <span>{t}</span>
                              </label>
                              <button
                                className="vault-tag-act"
                                title="重命名标签"
                                onClick={() => setTagRename({ from: t, value: t })}
                              >
                                <Icon name="pencil" size={12} />
                              </button>
                              <button
                                className="vault-tag-act"
                                title="删除标签"
                                onClick={() => removeTag(t)}
                              >
                                <Icon name="trash" size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      ));
                    })()}
                    {selectedTags.length > 0 && (
                      <button
                        className="vault-tag-clear"
                        onClick={() => setSelectedTags([])}
                      >
                        清空筛选（{selectedTags.length}）
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="vault-view-wrap">
                <button
                  className="vault-icon-btn"
                  title={`排序：${SORT_LABEL[sort]}`}
                  onClick={() => {
                    setSortMenu((v) => !v);
                    setViewMenu(false);
                  }}
                >
                  <Icon name="sort" size={16} />
                  <Icon name="chevron-down" size={10} />
                </button>
                {sortMenu && (
                  <div className="vault-view-menu vault-popmenu">
                    {(Object.keys(SORT_LABEL) as SortMode[]).map((m) => (
                      <button
                        key={m}
                        className={sort === m ? "active" : ""}
                        onClick={() => {
                          setSort(m);
                          setSortMenu(false);
                        }}
                      >
                        <Icon name="sort" size={14} />
                        {SORT_LABEL[m]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className={`vault-icon-btn${selectMode ? " active" : ""}`}
                title={selectMode ? "退出多选" : "多选"}
                onClick={() => {
                  if (selectMode) exitSelectMode();
                  else {
                    setSelectMode(true);
                    clearSelection();
                  }
                }}
              >
                <Icon name="check-square" size={16} />
              </button>
            </div>

            {/* 新建主机：主按钮 + 下拉（分体）；打开右侧面板时这组操作折叠 */}
            <div
              className={`vault-header-actions${
                composer || localPanel ? " collapsed" : ""
              }`}
            >
              <div className="vault-new-split">
                <button className="vault-new-btn" onClick={openComposer}>
                  <Icon name="plus" size={14} />
                  新建主机
                </button>
                <button
                  className="vault-new-btn-caret"
                  title="更多新建方式"
                  onClick={() => setNewMenu((v) => !v)}
                >
                  <Icon name="chevron-down" size={14} />
                </button>
                {newMenu && (
                  <div className="vault-view-menu vault-new-menu vault-popmenu">
                    {newHostMenu.map((item) => (
                      <button
                        key={item.label}
                        className={item.enabled ? "" : "disabled"}
                        disabled={!item.enabled}
                        onClick={() => {
                          if (!item.enabled) return;
                          setNewMenu(false);
                          if (item.label === "新建分组") {
                            setGroupDialog({
                              id: null,
                              name: "",
                              proxy_profile_id: null,
                            });
                          } else if (item.label === "本地终端 (CMD)") {
                            setLocalPanel("new");
                          } else if (item.label === "导入") {
                            void importVaultHosts();
                          } else if (item.label === "导出") {
                            void exportVaultHosts();
                          } else {
                            onLocal();
                          }
                        }}
                        title={
                          item.enabled ? item.label : `${item.label}（尚未实现）`
                        }
                      >
                        <Icon name={item.icon} size={14} />
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button className="vault-secondary-btn" onClick={() => onLocal()}>
                <Icon name="terminal-square" size={14} />
                终端
              </button>
              <button className="vault-secondary-btn" onClick={onSerial}>
                <Icon name="usb" size={14} />
                串口
              </button>
              <button className="vault-secondary-btn" onClick={onTelnet}>
                <Icon name="network" size={14} />
                Telnet
              </button>
            </div>
          </header>

          {selectMode && activeNav === "hosts" && (
            <div className="vault-select-bar">
              <span className="vault-select-count">
                已选 {selected.size} 台主机
                {selectedGroups.size > 0 && `和 ${selectedGroups.size} 个分组`}
              </span>
              <span className="vault-select-spacer" />
              <button onClick={selectAllVisible}>全选</button>
              <button onClick={clearSelection}>取消全选</button>
              <button
                disabled={selected.size === 0}
                onClick={() => {
                  profiles
                    .filter((p) => selected.has(p.id))
                    .forEach((p) => onConnect(p));
                }}
              >
                连接（{selected.size}）
              </button>
              <div className="vault-view-wrap">
                <button
                  disabled={selected.size === 0}
                  onClick={() => setMoveMenu((v) => !v)}
                >
                  移动到分组（{selected.size}）
                </button>
                {moveMenu && (
                  <div className="vault-view-menu vault-move-menu vault-popmenu">
                    <button
                      onClick={() => {
                        const ids = Array.from(selected);
                        setMoveMenu(false);
                        void moveHostsTo(ids, null);
                      }}
                    >
                      未分组
                    </button>
                    {groups.map((g) => (
                      <button
                        key={g.id}
                        onClick={() => {
                          const ids = Array.from(selected);
                          setMoveMenu(false);
                          void moveHostsTo(ids, g.id);
                        }}
                      >
                        <Icon name="folder" size={14} />
                        {g.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="danger"
                disabled={selected.size === 0 && selectedGroups.size === 0}
                onClick={() => void deleteSelected()}
              >
                删除（{selected.size + selectedGroups.size}）
              </button>
              <button className="vault-select-close" title="关闭" onClick={exitSelectMode}>
                <Icon name="x" size={14} />
              </button>
            </div>
          )}

          {activeNav === "hosts" ? (
          <div
            className={`vault-content${marqueeRect ? " selecting" : ""}`}
            ref={contentRef}
            onPointerDown={onMarqueePointerDown}
            onClickCapture={onMarqueeClickCapture}
            onKeyDown={handleContentKeyDown}
          >
            {marqueeRect && (
              <div
                data-vault-marquee="true"
                aria-hidden="true"
                className="vault-marquee"
                style={{
                  left: marqueeRect.left,
                  top: marqueeRect.top,
                  width: marqueeRect.right - marqueeRect.left,
                  height: marqueeRect.bottom - marqueeRect.top,
                }}
              />
            )}
            {/* 面包屑：树视图隐藏；根节点同时作为拖拽归组的投放点 */}
            {view !== "tree" && (
              <div className="vault-breadcrumb">
                <button
                  className={`vault-all-hosts${
                    dropGroupId === "__root" ? " drop-target" : ""
                  }`}
                  title="全部主机（可拖拽主机到此移出分组）"
                  onClick={() => {
                    setActiveGroupId(null);
                    clearSelection();
                  }}
                  onDragOver={(e) => allowDrop(e, null)}
                  onDragLeave={() => setDropGroupId(null)}
                  onDrop={(e) => dropOnGroup(e, null)}
                >
                  全部主机
                </button>
                {activeGroupId !== null && (
                  <>
                    <span className="vault-crumb-sep">›</span>
                    <button className="vault-crumb-current" title={activeGroupName}>
                      {activeGroupName}
                    </button>
                  </>
                )}
              </div>
            )}

            {quick && (
              <button
                className="vault-quick-suggest"
                title="直接连接，不保存为新主机"
                onClick={runQuickConnect}
              >
                <span className="vault-quick-suggest-icon">
                  <Icon name="zap" size={16} />
                </span>
                <span className="vault-quick-suggest-text">
                  直接连接{" "}
                  <strong>
                    {quick.username ? `${quick.username}@` : ""}
                    {quick.host}:{quick.port}
                  </strong>
                </span>
                <span className="vault-quick-suggest-hint">Enter</span>
              </button>
            )}

            {atRoot && view !== "tree" && pinnedHosts.length > 0 && (
              <section className="vault-section">
                <h3 className="vault-section-title">
                  <Icon name="pin" size={14} />
                  已置顶
                </h3>
                {hostCollection(pinnedHosts)}
              </section>
            )}

            {atRoot &&
              view !== "tree" &&
              (recentProfiles.length > 0 || showLocalRecently) && (
                <section className="vault-section">
                  <h3 className="vault-section-title">
                    <Icon name="clock" size={14} />
                    最近连接
                  </h3>
                  {view === "grid" ? (
                    <div className="vault-grid">
                      {showLocalRecently && localCard()}
                      {recentProfiles.map((p) => hostCard(p))}
                    </div>
                  ) : (
                    <div className="vault-list">
                      {showLocalRecently && localCard(true)}
                      {recentProfiles.map((p) => hostCard(p))}
                    </div>
                  )}
                </section>
              )}

            {atRoot && view !== "tree" && groupTiles.length > 0 && (
              <section className="vault-section">
                <h3 className="vault-section-title">
                  <Icon name="folder" size={14} />
                  分组
                </h3>
                {view === "grid" ? (
                  <div className="vault-grid">{groupTiles.map((g) => groupCard(g))}</div>
                ) : (
                  <div className="vault-list">{groupTiles.map((g) => groupCard(g))}</div>
                )}
              </section>
            )}

            {!hideRootHostsSection && (
            <section className="vault-section">
              <div className="vault-section-head">
                <h3 className="vault-section-title">主机</h3>
                <div className="vault-section-meta">
                  {view === "tree" && atRoot && treeSections.length > 0 && (
                    <div className="vault-tree-tools">
                      <button
                        className="vault-tree-tool"
                        title="展开全部"
                        onClick={() => setCollapsedGroups(new Set())}
                      >
                        <Icon name="chevron-down" size={13} />
                      </button>
                      <button
                        className="vault-tree-tool"
                        title="折叠全部"
                        onClick={() =>
                          setCollapsedGroups(
                            new Set(treeSections.map((s) => s.id)),
                          )
                        }
                      >
                        <Icon name="chevron-right" size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {view === "tree" ? (
                atRoot ? (
                  <div className="vault-tree">
                    {treeSections.map((section) => {
                      const isFolded = collapsedGroups.has(section.id);
                      return (
                        <div className="vault-tree-group" key={section.id}>
                          <div
                            className={`vault-tree-head${
                              dropGroupId === section.id ? " drop-target" : ""
                            }${
                              isFolded ? " folded" : ""
                            }`}
                            onClick={() =>
                              setCollapsedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(section.id)) next.delete(section.id);
                                else next.add(section.id);
                                return next;
                              })
                            }
                            onDragOver={
                              section.id !== "__ungrouped"
                                ? (e) => allowDrop(e, section.id)
                                : undefined
                            }
                            onDragLeave={() => setDropGroupId(null)}
                            onDrop={
                              section.id !== "__ungrouped"
                                ? (e) => dropOnGroup(e, section.id)
                                : undefined
                            }
                          >
                            <Icon
                              name={isFolded ? "chevron-right" : "chevron-down"}
                              size={12}
                            />
                            <Icon name="folder" size={14} />
                            <span>{section.name}</span>
                            <span className="nc-count">{section.hosts.length}</span>
                          </div>
                          {!isFolded && section.hosts.map((p) => hostCard(p))}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="vault-tree">
                    {scopedHosts.map((p) => hostCard(p))}
                  </div>
                )
              ) : (
                hostCollection(
                  rootHostsForDisplay(
                    scopedHosts,
                    rootRemaining,
                    settings.showOnlyUngroupedHostsInRoot,
                  ),
                )
              )}

              {profiles.length === 0 && (
                <div className="vault-empty">
                  <span className="vault-empty-icon">
                    <Icon name="grid" size={26} />
                  </span>
                  <h2>设置你的主机</h2>
                  <p>保存主机以快速连接到你的服务器、虚拟机和容器。</p>
                  <button className="vault-new-btn" onClick={openComposer}>
                    <Icon name="plus" size={14} />
                    新建主机
                  </button>
                </div>
              )}

              {profiles.length > 0 && scopedHosts.length === 0 && !quick && (
                <div className="vault-empty">
                  <span className="vault-empty-icon">
                    <Icon name={keyword ? "search" : "folder"} size={26} />
                  </span>
                  <h2>{keyword ? "没有匹配的主机" : "这个分组还没有主机"}</h2>
                  <p>
                    {keyword ? "换个关键词试试。" : "可在连接管理器中把主机移入此分组。"}
                  </p>
                </div>
              )}
            </section>
            )}
          </div>
          ) : activeNav === "known-hosts" ? (
            knownHostsPanel()
          ) : activeNav === "keys" ? (
            // 对齐 Netcatty KeychainManager：密钥 / 身份单页分区，无 tab 切换。
            <div className="kc-tabbed kc-single-page">
              {keysPanel()}
              <KeychainView />
            </div>
          ) : activeNav === "sync" ? (
            <SyncView onAfterPull={onDataChanged} />
          ) : activeNav === "monitor" ? (
            <MonitorView profiles={profiles} onOpenHost={onConnect} />
          ) : activeNav === "port" ? (
            <ForwardOverview />
          ) : activeNav === "proxies" ? (
            <ProxyProfilesView
              profiles={profiles}
              groups={groups}
              credentials={credentials}
              onDataChanged={() => {
                api.listProxyProfiles().then(setProxyProfiles).catch(() => {});
                onDataChanged();
              }}
            />
          ) : activeNav === "snippets" ? (
            <SnippetsView activeHandle={activeHandle} />
          ) : activeNav === "notes" ? (
            <NotesView
              profiles={profiles}
              credentials={credentials}
              onOpenHost={onConnect}
            />
          ) : activeNav === "logs" ? (
            <SessionLogsView />
          ) : null}
        </div>

        {composer && (
          <>
            <div
              className="vault-composer-resizer"
              role="separator"
              aria-orientation="vertical"
              title="拖拽调整面板宽度"
              style={{ right: panelWidth }}
              onPointerDown={startPanelResize}
            />
            <aside
              className={`vault-composer${panelResizing ? " resizing" : ""}`}
              data-section="vault-composer"
              style={{ width: panelWidth }}
            >
            <header className="vault-composer-head">
              <div className="vault-composer-heading">
                <span className="vault-composer-title">
                  {profiles.some((p) => p.id === composer.id)
                    ? "主机详情"
                    : "新建主机"}
                </span>
              </div>
              <div className="vault-composer-head-actions">
                <button
                  className="nc-icon-btn"
                  title="测试连接"
                  disabled={
                    composerBusy ||
                    !composer.name.trim() ||
                    !composer.host.trim()
                  }
                  onClick={() => void startConnectionTest()}
                >
                  <Icon name="zap" size={16} />
                </button>
                <button
                  className="nc-icon-btn"
                  title="保存"
                  disabled={
                    composerBusy ||
                    !composer.name.trim() ||
                    !composer.host.trim()
                  }
                  onClick={() => void saveComposer()}
                >
                  <Icon name="check" size={16} />
                </button>
                <button
                  className="nc-icon-btn"
                  title="关闭面板"
                  onClick={() => setComposer(null)}
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
            </header>

            <div className="vault-composer-body">
              {composerErr && <div className="vault-composer-err">{composerErr}</div>}

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="sliders" size={13} />
                  <span>通用</span>
                </div>
                <input
                  value={composer.name}
                  placeholder="名称（例如：Production Server）"
                  onChange={(e) =>
                    setComposer({ ...composer, name: e.target.value })
                  }
                />
                {/* 对齐 Netcatty：分组 / 标签行各带 40px 图标方块 + 清除按钮。 */}
                <div className="host-icon-row">
                  <span className="host-icon-box">
                    <Icon name="folder" size={16} />
                  </span>
                  <select
                    className="host-icon-row-field"
                    value={composer.group_id}
                    onChange={(e) =>
                      setComposer({ ...composer, group_id: e.target.value })
                    }
                  >
                    <option value="">父级 Group</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  {composer.group_id !== "" && (
                    <button
                      type="button"
                      className="nc-icon-btn"
                      title="清除分组"
                      onClick={() => setComposer({ ...composer, group_id: "" })}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </div>
                <div className="host-icon-row">
                  <span className="host-icon-box">
                    <Icon name="tag" size={16} />
                  </span>
                  <input
                    className="host-icon-row-field"
                    value={composer.tags}
                    placeholder="Add tags..."
                    onChange={(e) =>
                      setComposer({ ...composer, tags: e.target.value })
                    }
                  />
                  {composer.tags !== "" && (
                    <button
                      type="button"
                      className="nc-icon-btn"
                      title="清除标签"
                      onClick={() => setComposer({ ...composer, tags: "" })}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </div>
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="server" size={13} />
                  <span>地址</span>
                </div>
                <input
                  value={composer.host}
                  placeholder="IP 或 主机名"
                  onChange={(e) =>
                    setComposer({ ...composer, host: e.target.value })
                  }
                />
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="key" size={13} />
                  <span>端口与凭据</span>
                </div>
                <div className="host-port-line">
                  <span className="host-port-line-prefix">SSH on</span>
                  <input
                    className="host-port-line-input"
                    type="number"
                    min={1}
                    max={65535}
                    value={composer.port}
                    inputMode="numeric"
                    aria-label="端口"
                    onChange={(e) =>
                      setComposer({ ...composer, port: e.target.value })
                    }
                  />
                  <span className="host-port-line-suffix">端口</span>
                </div>

                <div className="host-setting-row">
                  <span className="host-setting-label">登录方式</span>
                  <select
                    value={composer.auth_method}
                    onChange={(e) =>
                      setComposer({
                        ...composer,
                        auth_method: e.target.value as AuthMethod,
                      })
                    }
                  >
                    {AUTH_METHODS.map((m) => (
                      <option
                        key={m.value}
                        value={m.value}
                        disabled={!m.enabled}
                      >
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="host-setting-hint">
                  {
                    (
                      AUTH_METHODS.find(
                        (m) => m.value === composer.auth_method,
                      ) ?? AUTH_METHODS[0]
                    ).hint
                  }
                </p>

                <div className="host-setting-row">
                  <span
                    className="host-setting-label"
                    title={MFA_HINT}
                  >
                    优先交互式认证
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={composer.mfa}
                    className={`host-switch${composer.mfa ? " on" : ""}`}
                    onClick={() =>
                      setComposer({ ...composer, mfa: !composer.mfa })
                    }
                  >
                    <span className="host-switch-knob" />
                  </button>
                </div>
                <p className="host-setting-hint">{MFA_HINT}</p>

                <div className="host-setting-row">
                  <span className="host-setting-label">转发 Agent</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={composer.agent_forwarding}
                    className={`host-switch${composer.agent_forwarding ? " on" : ""}`}
                    onClick={() => {
                      const next = !composer.agent_forwarding;
                      setComposer({ ...composer, agent_forwarding: next });
                      if (next) probeComposerAgent();
                      else setComposerAgentRunning(null);
                    }}
                  >
                    <span className="host-switch-knob" />
                  </button>
                </div>
                {composer.agent_forwarding && composerAgentRunning === false && (
                  <p className="host-setting-hint">
                    未检测到运行中的 SSH Agent，转发将不可用
                  </p>
                )}

                <div className="host-setting-row">
                  <span className="host-setting-label">输入兼容模式：逐字发送</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={composer.ssh_input_compatibility ?? true}
                    className={`host-switch${(composer.ssh_input_compatibility ?? true) ? " on" : ""}`}
                    onClick={() =>
                      setComposer({
                        ...composer,
                        ssh_input_compatibility: !(
                          composer.ssh_input_compatibility ?? true
                        ),
                      })
                    }
                  >
                    <span className="host-switch-knob" />
                  </button>
                </div>
                <p className="host-setting-hint">
                  中文输入或短粘贴出现丢字时尝试开启。
                </p>
                <p className="host-setting-hint">保存后重新连接生效。</p>

                <div className="host-setting-row">
                  <span className="host-setting-label">用户名</span>
                  <input
                    value={composer.username}
                    placeholder="用户名"
                    onChange={(e) =>
                      setComposer({ ...composer, username: e.target.value })
                    }
                  />
                </div>

                {composerPasswordVisible && (
                  <>
                    <div className="host-setting-row">
                      <span className="host-setting-label">密码</span>
                      <span className="host-pass-wrap">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={
                            passMasked && composer.password === ""
                              ? "•••••"
                              : composer.password
                          }
                          placeholder="登录密码"
                          onFocus={(e) => {
                            // 掩码态：全选便于直接输入替换。
                            if (passMasked && composer.password === "")
                              e.target.select();
                          }}
                          onChange={(e) => {
                            if (passMasked) {
                              setPassMasked(false);
                              setComposer({
                                ...composer,
                                password: e.target.value.replaceAll("•", ""),
                              });
                            } else {
                              setComposer({
                                ...composer,
                                password: e.target.value,
                              });
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="host-eye-btn"
                          title={showPassword ? "隐藏密码" : "显示密码"}
                          onClick={() => setShowPassword((v) => !v)}
                        >
                          <Icon
                            name={showPassword ? "eye-off" : "eye"}
                            size={14}
                          />
                        </button>
                      </span>
                    </div>
                    {(composer.password !== "" || passMasked) && (
                      <div className="host-setting-row">
                        <span className="host-setting-label">保存密码</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={composer.save_password}
                          className={`host-switch${composer.save_password ? " on" : ""}`}
                          onClick={() =>
                            setComposer({
                              ...composer,
                              save_password: !composer.save_password,
                            })
                          }
                        >
                          <span className="host-switch-knob" />
                        </button>
                      </div>
                    )}
                  </>
                )}

                {composer.credential_id && !isEditComposer ? (
                  <div className="host-identity-row">
                    <Icon name="user" size={13} />
                    <span className="host-identity-name">
                      {(() => {
                        const c = credentials.find(
                          (x) => x.id === composer.credential_id,
                        );
                        return c ? c.name : "已选身份";
                      })()}
                    </span>
                    <button
                      className="nc-icon-btn"
                      title="取消选择，改用下方内联凭据"
                      onClick={() => {
                        clearComposerIdentity();
                        setCredPick(null);
                      }}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                ) : credPick === null ? (
                  <div className="host-cred-link-row">
                    <button
                      type="button"
                      className="host-link-btn"
                      onClick={() => setCredMenu((v) => !v)}
                    >
                      <Icon name="plus" size={12} />
                      密钥 / 证书 / 本地密钥
                    </button>
                    {credMenu && (
                      <div className="vault-view-menu vault-popmenu host-cred-menu">
                        {(
                          [
                            { v: "key", label: "密钥", icon: "key" },
                            {
                              v: "certificate",
                              label: "证书",
                              icon: "shield",
                            },
                            {
                              v: "localKeyFile",
                              label: "本地密钥文件",
                              icon: "file-text",
                            },
                          ] as Array<{
                            v: Exclude<CredPick, null>;
                            label: string;
                            icon: IconName;
                          }>
                        ).map((item) => (
                          <button
                            key={item.v}
                            onClick={() => {
                              setCredPick(item.v);
                              setCredSearch("");
                              setCredMenu(false);
                            }}
                          >
                            <Icon name={item.icon} size={14} />
                            {item.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : credPick === "localKeyFile" ? (
                  <div className="host-setting-row">
                    <span className="host-setting-label">本地密钥文件</span>
                    <span className="host-localkey-wrap">
                      <select
                        value={composer.key_file}
                        onChange={(e) => {
                          const v = e.target.value;
                          setComposer({
                            ...composer,
                            key_file: v,
                            auth_method: v ? "key" : composer.auth_method,
                          });
                        }}
                      >
                        <option value="">~/.ssh/id_ed25519</option>
                        {keyFiles.map((k) => (
                          <option key={k} value={k}>
                            ~/.ssh/{k}
                          </option>
                        ))}
                      </select>
                      <button
                        className="nc-icon-btn"
                        title="取消本地密钥"
                        onClick={() => {
                          setCredPick(null);
                          setComposer({ ...composer, key_file: "" });
                        }}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </span>
                  </div>
                ) : (
                  (() => {
                    const isCert = credPick === "certificate";
                    const pool = credentials.filter(
                      (c) => c.type === (isCert ? "certificate" : "key"),
                    );
                    const kw = credSearch.trim().toLowerCase();
                    const filtered = kw
                      ? pool.filter(
                          (c) =>
                            c.name.toLowerCase().includes(kw) ||
                            c.username.toLowerCase().includes(kw),
                        )
                      : pool;
                    return (
                      <div className="host-key-combo">
                        <div className="host-key-combo-search">
                          <Icon name="search" size={13} />
                          <input
                            autoFocus
                            value={credSearch}
                            placeholder={
                              isCert ? "搜索证书…" : "搜索密钥…"
                            }
                            onChange={(e) => setCredSearch(e.target.value)}
                          />
                          <button
                            className="nc-icon-btn"
                            title="取消"
                            onClick={() => {
                              setCredPick(null);
                              setCredSearch("");
                            }}
                          >
                            <Icon name="x" size={13} />
                          </button>
                        </div>
                        {filtered.length === 0 ? (
                          <div className="host-key-combo-empty">
                            {isCert ? "暂无证书" : "暂无密钥"}
                          </div>
                        ) : (
                          filtered.map((c) => (
                            <button
                              key={c.id}
                              className="host-key-combo-item"
                              onClick={() => {
                                bindComposerCredential(c.id);
                                setCredSearch("");
                              }}
                            >
                              <Icon name="key" size={13} />
                              <span>{c.name}</span>
                              {c.username && (
                                <span className="host-key-combo-user">
                                  {c.username}
                                </span>
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    );
                  })()
                )}
              </section>

              {/* SFTP 设置（对齐 Netcatty HostDetailsSection sftp：文件协议 / sudo / 编码）。 */}
              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="folder" size={13} />
                  <span>SFTP 设置</span>
                </div>
                <div className="host-setting-row">
                  <span className="host-setting-label">文件协议</span>
                  <select
                    value={composer.sftp_protocol}
                    onChange={(e) => {
                      const protocol = e.target.value as
                        | "auto"
                        | "sftp"
                        | "scp";
                      setComposer({
                        ...composer,
                        sftp_protocol: protocol,
                        // SCP 无 sudo 提权路径，清掉冲突标记（同 Netcatty）。
                        sftp_sudo:
                          protocol === "scp" ? false : composer.sftp_sudo,
                      });
                    }}
                  >
                    <option value="auto">自动</option>
                    <option value="sftp">SFTP</option>
                    <option value="scp">SCP</option>
                  </select>
                </div>
                <div className="host-setting-row">
                  <span className="host-setting-label">sudo 模式</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={composer.sftp_sudo}
                    disabled={composer.sftp_protocol === "scp"}
                    className={`host-switch${composer.sftp_sudo ? " on" : ""}`}
                    onClick={() =>
                      setComposer({
                        ...composer,
                        sftp_sudo: !composer.sftp_sudo,
                      })
                    }
                  >
                    <span className="host-switch-knob" />
                  </button>
                </div>
                <div className="host-setting-row">
                  <span className="host-setting-label">文件名编码</span>
                  <select
                    value={composer.sftp_encoding}
                    onChange={(e) =>
                      setComposer({
                        ...composer,
                        sftp_encoding: e.target.value as
                          | "auto"
                          | "utf-8"
                          | "gb18030",
                      })
                    }
                  >
                    <option value="auto">自动</option>
                    <option value="utf-8">UTF-8</option>
                    <option value="gb18030">GB18030</option>
                  </select>
                </div>
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="terminal-square" size={13} />
                  <span>字符集 / 终端编码</span>
                </div>
                <div className="host-setting-row">
                  <span className="host-setting-label">终端编码</span>
                  <select
                    value={composer.terminal_encoding}
                    onChange={(e) =>
                      setComposer({
                        ...composer,
                        terminal_encoding: e.target.value as TerminalEncoding,
                      })
                    }
                  >
                    <option value="utf-8">UTF-8（默认）</option>
                    <option value="gb18030">GB18030（GBK / GB2312）</option>
                  </select>
                </div>
                <p className="host-setting-hint">
                  按主机保存在本机，与终端「更多 → 终端编码」共用；输出用对应字符集解码，输入交给后端重新编码。
                </p>
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="network" size={13} />
                  <span>代理</span>
                </div>
                <div className="host-setting-row">
                  <span className="host-setting-label">代理来源</span>
                  <select
                    value={composer.proxy_profile_id}
                    onChange={(e) =>
                      setComposer({ ...composer, proxy_profile_id: e.target.value })
                    }
                  >
                    <option value="">内联配置 / 直连</option>
                    {proxyProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}（{p.proxy_type.toUpperCase()} {p.host}:{p.port}）
                      </option>
                    ))}
                  </select>
                </div>
                {composer.proxy_profile_id ? (
                  <p className="host-setting-hint">
                    使用代理库条目；配置与密码在 Vault「代理」页统一维护，修改后所有引用主机即时生效。
                  </p>
                ) : (
                  <>
                    <div className="host-setting-row">
                      <span className="host-setting-label">代理类型</span>
                      <select
                        value={composer.proxy.type}
                        onChange={(e) =>
                          setComposer({
                            ...composer,
                            proxy: {
                              ...composer.proxy,
                              type: e.target.value as ProxyDraft["type"],
                            },
                          })
                        }
                      >
                        <option value="none">无（直连）</option>
                        <option value="http">HTTP 代理</option>
                        <option value="socks5">SOCKS5 代理</option>
                      </select>
                    </div>
                    {composer.proxy.type !== "none" && (
                      <>
                        <div className="host-setting-row">
                          <span className="host-setting-label">代理主机</span>
                          <input
                            value={composer.proxy.host}
                            placeholder="IP 或 主机名"
                            onChange={(e) =>
                              setComposer({
                                ...composer,
                                proxy: { ...composer.proxy, host: e.target.value },
                              })
                            }
                          />
                        </div>
                        <div className="host-setting-row">
                          <span className="host-setting-label">代理端口</span>
                          <input
                            type="number"
                            min={1}
                            max={65535}
                            inputMode="numeric"
                            value={composer.proxy.port}
                            placeholder={composer.proxy.type === "http" ? "8080" : "1080"}
                            onChange={(e) =>
                              setComposer({
                                ...composer,
                                proxy: { ...composer.proxy, port: e.target.value },
                              })
                            }
                          />
                        </div>
                        <div className="host-setting-row">
                          <span className="host-setting-label">代理用户名</span>
                          <input
                            value={composer.proxy.username}
                            placeholder="可选"
                            onChange={(e) =>
                              setComposer({
                                ...composer,
                                proxy: { ...composer.proxy, username: e.target.value },
                              })
                            }
                          />
                        </div>
                        <div className="host-setting-row">
                          <span className="host-setting-label">代理密码</span>
                          <input
                            type="password"
                            value={composer.proxy.password}
                            placeholder={
                              composerProxySecretRef.current
                                ? "已保存（留空保持不变）"
                                : "可选"
                            }
                            onChange={(e) =>
                              setComposer({
                                ...composer,
                                proxy: { ...composer.proxy, password: e.target.value },
                              })
                            }
                          />
                        </div>
                        <div className="host-setting-row">
                          <span className="host-setting-label">不使用代理</span>
                          <input
                            value={composer.proxy.noProxy}
                            placeholder="localhost, 127.0.0.1"
                            onChange={(e) =>
                              setComposer({
                                ...composer,
                                proxy: { ...composer.proxy, noProxy: e.target.value },
                              })
                            }
                          />
                        </div>
                        <p className="host-setting-hint">
                          逗号分隔的域名 / IP / host:port 不经代理。代理密码保存在系统密钥库，不写入主机档案。
                        </p>
                      </>
                    )}
                  </>
                )}
                <div
                  className="host-setting-row"
                  aria-disabled="true"
                  title="Group 表无 proxy 字段，分组级默认代理尚未移植。"
                  style={{ opacity: 0.55, cursor: "not-allowed" }}
                >
                  <span className="host-setting-label">分组级默认代理</span>
                  <span className="host-setting-hint">未移植</span>
                </div>
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="shield" size={13} />
                  <span>验证器 (TOTP)</span>
                </div>
                <div className="host-setting-row">
                  <span className="host-setting-label">
                    {totpConfigured ? "已保存 TOTP 密钥" : "为这台主机保存 TOTP 密钥"}
                  </span>
                  {totpConfigured ? (
                    <span className="host-totp-actions">
                      <button
                        type="button"
                        className="host-link-btn"
                        onClick={openTotpDialog}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="host-link-btn danger"
                        onClick={() => void removeTotp()}
                      >
                        移除验证器
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="host-link-btn"
                      onClick={openTotpDialog}
                    >
                      设置…
                    </button>
                  )}
                </div>
                <p className="host-setting-hint">
                  能打开这个保险库的人会同时得到验证码和密码。请只在个人设备上使用。
                </p>
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="terminal-square" size={13} />
                  <span>环境变量</span>
                  <span className="host-setting-hint" style={{ marginLeft: "auto" }}>
                    {composer.env_vars.length} 项
                  </span>
                </div>
                {composer.env_vars.map((env, index) => (
                  <div key={index} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input
                      placeholder="名称，如 LANG"
                      value={env.name}
                      style={{ flex: "0 0 40%" }}
                      onChange={(e) => {
                        const next = [...composer.env_vars];
                        next[index] = { ...next[index], name: e.target.value };
                        setComposer({ ...composer, env_vars: next });
                      }}
                    />
                    <input
                      placeholder="值"
                      value={env.value}
                      style={{ flex: 1, minWidth: 0 }}
                      onChange={(e) => {
                        const next = [...composer.env_vars];
                        next[index] = { ...next[index], value: e.target.value };
                        setComposer({ ...composer, env_vars: next });
                      }}
                    />
                    <button
                      type="button"
                      style={ENV_BTN_STYLE}
                      onClick={() =>
                        setComposer({
                          ...composer,
                          env_vars: composer.env_vars.filter((_, i) => i !== index),
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  style={ENV_BTN_STYLE}
                  onClick={() =>
                    setComposer({
                      ...composer,
                      env_vars: [...composer.env_vars, { name: "", value: "" }],
                    })
                  }
                >
                  + 添加变量
                </button>
                <p className="host-setting-hint">
                  连接时通过 SSH SetEnv 发送；远端 sshd 需在 AcceptEnv 放行对应变量
                  （OpenSSH 默认只放行 LANG / LC_*），否则会被静默丢弃。
                </p>
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="terminal-square" size={13} />
                  <span>启动命令</span>
                </div>
                <textarea
                  rows={3}
                  placeholder="连接成功后自动执行的命令"
                  value={composer.init_command}
                  onChange={(e) =>
                    setComposer({ ...composer, init_command: e.target.value })
                  }
                />
                <p className="host-setting-hint">
                  会话建立后自动发送到终端执行（换行结尾）。
                </p>
              </section>

              <section className="host-details-section">
                <div className="host-details-section-head">
                  <Icon name="shield" size={13} />
                  <span>高级字段（Netcatty 有，termX 置灰）</span>
                </div>
                <ul
                  className="host-setting-hint"
                  style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.8 }}
                >
                  <li>主题 / 字体 / 字号覆盖：终端外观目前只有全局设置，主机档案无对应后端字段（字符集已在上方支持）。</li>
                  <li>启动命令运行模式（逐行 / 等待提示符）：后端只按换行一次发送。</li>
                  <li>登录脚本 / 连接脚本 / 输出触发器：依赖脚本引擎（#13）。</li>
                  <li>Mosh / EternalTerminal / X11 转发：后端未实现对应传输。</li>
                  <li>设备类型 / OS 覆盖：仅影响 Netcatty 的展示与网络设备原始命令模式。</li>
                  <li>SSH 算法偏好：档案已有 `algorithms` 字段但编辑器未暴露；Keepalive / 连接与认证超时无主机级字段，沿用默认（30s / 3 次 + 全局超时）。</li>
                  <li>系统 SSH Agent 路径 / IdentitiesOnly：后端未实现对应开关（已支持 Agent 转发本身）。</li>
                </ul>
              </section>
            </div>

            <footer className="vault-composer-foot">
              <button
                className="vault-new-btn host-save-full"
                disabled={
                  composerBusy ||
                  !composer.name.trim() ||
                  !composer.host.trim()
                }
                onClick={() => void saveComposer()}
              >
                保存
              </button>
            </footer>
            </aside>
          </>
        )}

        {localPanel !== null && (
          <LocalShellPanel
            initial={localPanel === "new" ? null : localPanel}
            groups={groups}
            shells={discoveredShells}
            onClose={() => setLocalPanel(null)}
            onSaved={(profile, isNew, open) => {
              setLocalPanel(null);
              if (isNew) {
                setOrder((prev) => [...prev, profile.id]);
                setTags((prev) => ({
                  ...prev,
                  [profile.id]: [LOCAL_SHELL_HOST_TAG],
                }));
              }
              onDataChanged();
              showToast(isNew ? "已创建本地终端" : "已保存本地终端");
              if (open) onConnect(profile);
            }}
          />
        )}

        {serialPanel !== null && (
          <SerialHostPanel
            initial={serialPanel}
            onClose={() => setSerialPanel(null)}
            onSaved={() => {
              setSerialPanel(null);
              onDataChanged();
              showToast("已保存串口主机");
            }}
          />
        )}
      </div>

      {totpDialog && composer && (
        <div className="vault-modal-mask" onClick={() => setTotpDialog(null)}>
          <div
            className="vault-group-dialog vault-totp-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span>设置验证器</span>
              <button
                className="nc-icon-btn"
                title="关闭"
                onClick={() => setTotpDialog(null)}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <label className="host-totp-field">
              密钥或 otpauth URI
              <input
                autoFocus
                value={totpDialog.secret}
                placeholder="粘贴 otpauth://totp/... 或 Base32 密钥"
                onChange={(e) =>
                  setTotpDialog({ ...totpDialog, secret: e.target.value })
                }
              />
            </label>
            <div className="host-totp-import-row">
              <button type="button" disabled title="尚未实现">
                <Icon name="folder-input" size={14} />
                导入二维码图片
              </button>
              <button type="button" disabled title="尚未实现">
                <Icon name="monitor" size={14} />
                从屏幕扫描二维码
              </button>
            </div>
            <div className="host-setting-row">
              <span
                className="host-setting-label"
                title="每次连接只提交一次，且提示必须精确匹配 JumpServer、Google Authenticator PAM，或你填写的正则。"
              >
                在已知 TOTP 提示上自动提交
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={totpDialog.autoSubmit}
                className={`host-switch${totpDialog.autoSubmit ? " on" : ""}`}
                onClick={() =>
                  setTotpDialog({
                    ...totpDialog,
                    autoSubmit: !totpDialog.autoSubmit,
                  })
                }
              >
                <span className="host-switch-knob" />
              </button>
            </div>
            <label className="host-totp-field">
              自定义提示正则
              <input
                value={totpDialog.regex}
                placeholder="可选的 RE2 正则表达式"
                onChange={(e) =>
                  setTotpDialog({ ...totpDialog, regex: e.target.value })
                }
              />
            </label>
            <footer>
              <button
                className="vault-secondary-btn"
                onClick={() => setTotpDialog(null)}
              >
                取消
              </button>
              <button
                className="vault-new-btn"
                disabled={!totpDialog.secret.trim()}
                onClick={() => void saveTotpDialog()}
              >
                保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {testState && (
        <div className="vault-modal-mask" onClick={stopConnectionTest}>
          <div
            className="vault-group-dialog vault-test-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span>测试连接</span>
              <button
                className="nc-icon-btn"
                title="关闭"
                onClick={stopConnectionTest}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="host-test-body">
              {testState.status === "connecting" && (
                <>
                  <Icon name="loader" size={18} className="host-test-spin" />
                  <p>正在连接… {25 - testState.seconds} 秒后超时</p>
                </>
              )}
              {testState.status === "success" && (
                <>
                  <Icon name="check" size={18} className="host-test-ok" />
                  <p>连接成功</p>
                  <p className="host-test-hint">
                    主机已接受您的凭据。您可以关闭此窗口。
                  </p>
                </>
              )}
              {testState.status === "failed" && (
                <>
                  <Icon
                    name="alert-triangle"
                    size={18}
                    className="host-test-fail"
                  />
                  <p>连接失败。</p>
                  {testState.error && (
                    <p className="host-test-hint">{testState.error}</p>
                  )}
                </>
              )}
            </div>
            <footer>
              <button
                className="vault-secondary-btn"
                onClick={stopConnectionTest}
              >
                关闭
              </button>
              {testState.status === "failed" && (
                <button
                  className="vault-new-btn"
                  onClick={() => {
                    stopConnectionTest();
                    void startConnectionTest();
                  }}
                >
                  重试
                </button>
              )}
            </footer>
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          className="term-context-menu vault-context-menu vault-popmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {/* 条目顺序对齐 Netcatty 主机卡片右键菜单；按协议派生：
              本地终端无 SFTP/复制地址/复制账密，串口与 Telnet 无 SFTP。 */}
          {deriveHostContextMenuItems({
            protocol: ctxMenu.profile.protocol,
            host: ctxMenu.profile.host,
            pinned: pinnedIds.includes(ctxMenu.profile.id),
          })
            .filter((item) => item.id !== "sftp" || settings.showSftpTab)
            .map((item) => {
            const p = ctxMenu.profile;
            const close = () => setCtxMenu(null);
            if (item.id === "sftp") {
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    close();
                    onOpenSftp(p);
                  }}
                >
                  <Icon name={HOST_CONTEXT_MENU_ICON[item.id]} size={14} />
                  {item.label}
                </button>
              );
            }
            return (
              <button
                key={item.id}
                className={item.danger ? "danger" : undefined}
                onClick={() => {
                  switch (item.id) {
                    case "connect":
                      close();
                      onConnect(p);
                      break;
                    case "edit":
                      close();
                      if (p.protocol === "local") setLocalPanel(p);
                      else if (p.protocol === "serial") setSerialPanel(p);
                      else openComposerForEdit(p);
                      break;
                    case "duplicate":
                      close();
                      duplicateHost(p);
                      break;
                    case "copy-hostname":
                      close();
                      copyHostname(p);
                      break;
                    case "copy-credentials":
                      close();
                      void copyCredentials(p);
                      break;
                    case "pin":
                      togglePin(p.id);
                      break;
                    case "delete":
                      close();
                      setHostDelete(p);
                      break;
                  }
                }}
              >
                <Icon name={HOST_CONTEXT_MENU_ICON[item.id]} size={14} />
                {item.label}
              </button>
            );
          })}
        </div>
      )}

      {groupCtx && (
        <div
          className="term-context-menu vault-context-menu vault-popmenu"
          style={{ left: groupCtx.x, top: groupCtx.y }}
        >
          <button
            disabled
            title="termX 分组暂为单层，暂不支持子分组"
          >
            <Icon name="folder" size={14} />
            新建子分组
          </button>
          <button
            onClick={() => {
              const g = groupCtx.group;
              setGroupCtx(null);
              setGroupDialog({
                id: g.id,
                name: g.name,
                proxy_profile_id: g.proxy_profile_id ?? null,
              });
            }}
          >
            <Icon name="pencil" size={14} />
            分组设置
          </button>
          <div className="term-menu-sep" />
          <button
            className="danger"
            onClick={() => {
              const g = groupCtx.group;
              setGroupCtx(null);
              requestGroupDelete(g.id, g.name);
            }}
          >
            <Icon name="trash" size={14} />
            删除分组
          </button>
        </div>
      )}

      {khCtx && (
        <div
          className="term-context-menu vault-context-menu vault-popmenu"
          style={{ left: khCtx.x, top: khCtx.y }}
        >
          {!profiles.some(
            (p) =>
              p.host === khCtx.entry.host && p.port === khCtx.entry.port,
          ) && (
            <button
              onClick={() => {
                const e = khCtx.entry;
                setKhCtx(null);
                convertKnownHostToProfile(e);
              }}
            >
              <Icon name="arrow-right" size={14} />
              转换为主机
            </button>
          )}
          <button
            className="danger"
            onClick={() => {
              const e = khCtx.entry;
              setKhCtx(null);
              setKhDelete(e);
            }}
          >
            <Icon name="trash" size={14} />
            删除
          </button>
        </div>
      )}

      {khDelete && (
        <div className="modal-mask" onMouseDown={() => setKhDelete(null)}>
          <div
            className="modal kh-delete-modal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="kh-delete-title">
              <Icon name="alert-triangle" size={18} />
              删除“{khDelete.host}”？
            </h3>
            <p className="kh-delete-desc">此操作不可撤销。</p>
            <div className="modal-actions">
              <button onClick={() => setKhDelete(null)}>取消</button>
              <button className="danger" onClick={confirmDeleteKnownHost}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {kcCtx && (
        <div
          className="term-context-menu vault-context-menu vault-popmenu"
          style={{ left: kcCtx.x, top: kcCtx.y }}
        >
          <button
            disabled={!kcCtx.cred.username}
            onClick={() => {
              const c = kcCtx.cred;
              setKcCtx(null);
              copyKcPublicKey(c);
            }}
          >
            <Icon name="copy" size={14} />
            复制公钥
          </button>
          <button
            onClick={() => {
              const c = kcCtx.cred;
              setKcCtx(null);
              openKcEdit(c);
            }}
          >
            <Icon name="pencil" size={14} />
            编辑
          </button>
          <div className="term-menu-sep" />
          <button
            className="danger"
            onClick={() => {
              const c = kcCtx.cred;
              setKcCtx(null);
              setKcDelete(c);
            }}
          >
            <Icon name="trash" size={14} />
            删除
          </button>
        </div>
      )}

      {kcDelete && (
        <div className="modal-mask" onMouseDown={() => setKcDelete(null)}>
          <div
            className="modal kh-delete-modal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="kh-delete-title">
              <Icon name="alert-triangle" size={18} />
              删除“{kcDelete.name}”？
            </h3>
            <p className="kh-delete-desc">此操作不可撤销。</p>
            <div className="modal-actions">
              <button onClick={() => setKcDelete(null)}>取消</button>
              <button className="danger" onClick={confirmKcDeleteKey}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {hostDelete && (
        <div className="modal-mask" onMouseDown={() => setHostDelete(null)}>
          <div
            className="modal kh-delete-modal"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="kh-delete-title">
              <Icon name="alert-triangle" size={18} />
              删除主机“{hostDelete.name}”？
            </h3>
            <div className="modal-actions">
              <button onClick={() => setHostDelete(null)}>取消</button>
              <button
                className="danger"
                onClick={() => {
                  const p = hostDelete;
                  setHostDelete(null);
                  void performDeleteHost(p);
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {groupDelete && (
        <GroupDeleteDialog
          bulk={groupDelete.ids.length > 1}
          names={groupDelete.names}
          hostCount={groupDelete.hostIds.length}
          onCancel={() => setGroupDelete(null)}
          onConfirm={(withHosts) => void confirmGroupDelete(withHosts)}
        />
      )}

      {switcher && (
        <div className="vault-modal-mask" onClick={() => setSwitcher(false)}>
          <div
            className="vault-switcher"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="vault-switcher-head">
              <Icon name="search" size={14} />
              <input
                autoFocus
                value={switcherQuery}
                placeholder="快速切换主机…"
                onChange={(e) => setSwitcherQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSwitcher(false);
                  if (e.key === "Enter" && switcherHosts[0]) {
                    connectFromSwitcher(switcherHosts[0]);
                  }
                }}
              />
              <span className="vault-switcher-hint">Esc</span>
            </div>
            <div className="vault-switcher-list">
              {switcherHosts.length === 0 && (
                <div className="vault-switcher-empty">没有匹配的主机</div>
              )}
              {switcherHosts.slice(0, 40).map((p) => (
                <button
                  key={p.id}
                  onClick={() => connectFromSwitcher(p)}
                >
                  <DistroAvatar profile={p} size="sm" />
                  <span className="vault-switcher-main">
                    <strong>{p.name}</strong>
                    <span>{fullSubtitle(p)}</span>
                  </span>
                  <Icon name="terminal" size={13} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {groupDialog && (
        <div className="vault-modal-mask" onClick={() => setGroupDialog(null)}>
          <div
            className="vault-group-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <span>{groupDialog.id ? "分组设置" : "新建分组"}</span>
              <button
                className="nc-icon-btn"
                title="关闭"
                onClick={() => setGroupDialog(null)}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <input
              autoFocus
              value={groupDialog.name}
              placeholder="分组名称"
              onChange={(e) =>
                setGroupDialog({ ...groupDialog, name: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveGroupDialog();
                if (e.key === "Escape") setGroupDialog(null);
              }}
            />
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 12,
                color: "hsl(var(--muted-foreground))",
                marginTop: 8,
              }}
            >
              默认代理
              <select
                value={groupDialog.proxy_profile_id ?? ""}
                onChange={(e) =>
                  setGroupDialog({
                    ...groupDialog,
                    proxy_profile_id: e.target.value || null,
                  })
                }
                style={{
                  background: "hsl(var(--background))",
                  color: "hsl(var(--foreground))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  padding: "5px 8px",
                  fontSize: 13,
                }}
              >
                <option value="">直连（不继承代理）</option>
                {proxyProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}（{p.proxy_type}）
                  </option>
                ))}
              </select>
            </label>
            <div
              style={{
                fontSize: 11,
                color: "hsl(var(--muted-foreground))",
                marginTop: 6,
              }}
            >
              分组内主机未绑定代理时继承该默认代理；主机自身配置优先。
            </div>
            <footer>
              <button
                className="vault-secondary-btn"
                onClick={() => setGroupDialog(null)}
              >
                取消
              </button>
              <button className="vault-new-btn" onClick={() => void saveGroupDialog()}>
                保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {toast && <div className="vault-toast">{toast}</div>}
    </section>
  );
}
