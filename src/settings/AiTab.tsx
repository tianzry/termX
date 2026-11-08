/**
 * 设置 → AI → 工具接入（对外 MCP）。
 *
 * 结构对照 Netcatty ExternalMcpCard + ExternalMcpHttpSection：
 * - 三档权限（observer / confirm / auto）；confirm 的写操作走主窗审批浮层；
 * - 命令黑名单（正则层）与许可记忆表（Confirm 放行规则）同在 AI 页维护。
 */

import { useEffect, useRef, useState } from "react";
import {
  mcpBlocklistGet,
  mcpBlocklistReset,
  mcpBlocklistSet,
  mcpClientConfig,
  mcpGrantRemove,
  mcpGrantsExport,
  mcpGrantsImport,
  mcpGrantsSave,
  mcpGuide,
  mcpRotateToken,
  mcpSetConfig,
  mcpStatus,
  type McpConfigPatch,
  type McpGuideBlock,
  type McpPermissionMode,
  type McpStatus,
  type PermissionGrant,
} from "../backend/client";
import { decodeAppError, userVisibleError } from "../domain/sshErrors";
import { Icon } from "../ui/icons";
import { settingsT } from "./i18n";
import { useSettings } from "./settingsStore";

type SnippetKind = "codex" | "claude" | "json";

const SNIPPET_KINDS: SnippetKind[] = ["codex", "claude", "json"];

const PERMISSION_MODES: Array<{ value: McpPermissionMode; label: string; desc: string }> = [
  { value: "observer", label: "settings.ai.permission.observer", desc: "settings.ai.permission.observer.desc" },
  { value: "confirm", label: "settings.ai.permission.confirm", desc: "settings.ai.permission.confirm.desc" },
  { value: "auto", label: "settings.ai.permission.auto", desc: "settings.ai.permission.auto.desc" },
];

/** 从 Tauri 错误信封中取出后端给的 message（mcp_invalid_config 携带 code/message）。 */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const decoded = decodeAppError(raw);
  const message = decoded.params?.message;
  if (typeof message === "string" && message) return message;
  return userVisibleError(raw);
}

function maskToken(token: string): string {
  return "•".repeat(Math.min(token.length, 24));
}

function StatusPill({ status }: { status: McpStatus | null }) {
  const s = useSettings();
  const t = (k: string) => settingsT(s.language, k);
  const phase = status?.error
    ? "error"
    : status?.running
      ? "running"
      : status?.enabled
        ? "starting"
        : "inactive";
  return (
    <span className={`nc-mcp-status is-${phase}`} role="status">
      <span className="nc-mcp-status-dot" />
      {t(`settings.ai.status.${phase}`)}
    </span>
  );
}

export function AiTab() {
  const s = useSettings();
  const t = (k: string, p?: Record<string, string | number>) => settingsT(s.language, k, p);

  const [status, setStatus] = useState<McpStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [portDraft, setPortDraft] = useState("");
  const [addressDraft, setAddressDraft] = useState("");
  const [clientHostDraft, setClientHostDraft] = useState("");
  const editingRef = useRef(false);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [snippetKind, setSnippetKind] = useState<SnippetKind>("codex");
  const [snippet, setSnippet] = useState("");
  const [snippetLoading, setSnippetLoading] = useState(false);
  const [snippetError, setSnippetError] = useState<string | null>(null);

  // 接入指南：后端 `mcp::guide` 与 initialize.instructions 同源，前端只展示与复制。
  const [guide, setGuide] = useState<McpGuideBlock[]>([]);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);

  // 命令黑名单（正则层，对齐 Netcatty SafetySettings）。
  const [blocklist, setBlocklist] = useState<string[]>([]);
  const [blocklistBusy, setBlocklistBusy] = useState(false);
  const [blocklistError, setBlocklistError] = useState<string | null>(null);
  const [addBlocklistOpen, setAddBlocklistOpen] = useState(false);
  const [blocklistDraft, setBlocklistDraft] = useState("");

  // 许可记忆表（Confirm 放行规则，对齐 Netcatty PermissionGrantsSettings）。
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  const [grantsBusy, setGrantsBusy] = useState(false);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [grantEditor, setGrantEditor] = useState<{
    capabilityId: string;
    commandPattern: string;
    note: string;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  // 页面挂载时拉一次配置，之后每 3 秒静默轮询；卸载清理定时器。
  useEffect(() => {
    let alive = true;
    let inFlight = false;

    const refresh = async (quiet: boolean) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await mcpStatus();
        if (!alive) return;
        setStatus(next);
        setGrants(next.grants ?? []);
        if (!editingRef.current) {
          setPortDraft(String(next.port));
          setAddressDraft(next.listenAddress);
          setClientHostDraft(next.clientHost);
        }
      } catch (error) {
        if (alive && !quiet) setActionError(describeError(error));
      } finally {
        inFlight = false;
      }
    };

    void refresh(false);
    const timer = window.setInterval(() => void refresh(true), 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // 连接详情展开时按片段类型拉取；token 轮换 / 端口变化后自动刷新。
  useEffect(() => {
    if (!detailsOpen || !status?.running) return;
    let alive = true;
    setSnippetLoading(true);
    setSnippetError(null);
    mcpClientConfig(snippetKind)
      .then((text) => {
        if (alive) setSnippet(text);
      })
      .catch((error) => {
        if (alive) setSnippetError(describeError(error));
      })
      .finally(() => {
        if (alive) setSnippetLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [detailsOpen, snippetKind, status?.running, status?.url, status?.bearerToken]);

  // 服务运行 / 轮换 token 后重新生成指南，保证复制出来的 URL 与 token 是最新的。
  useEffect(() => {
    if (!status?.running) {
      setGuide([]);
      return;
    }
    let alive = true;
    setGuideLoading(true);
    setGuideError(null);
    mcpGuide()
      .then((blocks) => {
        if (alive) setGuide(blocks);
      })
      .catch((error) => {
        if (alive) setGuideError(describeError(error));
      })
      .finally(() => {
        if (alive) setGuideLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [status?.running, status?.url, status?.bearerToken]);

  // 命令黑名单只加载一次；写操作在后端持久化，返回最新清单。
  useEffect(() => {
    let alive = true;
    mcpBlocklistGet()
      .then((list) => {
        if (alive) setBlocklist(list);
      })
      .catch((error) => {
        if (alive) setBlocklistError(describeError(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  const apply = async (patch: McpConfigPatch, key: string) => {
    setActionError(null);
    setPending(key);
    try {
      const next = await mcpSetConfig(patch);
      setStatus(next);
      if (!editingRef.current) {
        setPortDraft(String(next.port));
        setAddressDraft(next.listenAddress);
        setClientHostDraft(next.clientHost);
      }
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setPending(null);
    }
  };

  const commitPort = () => {
    const parsed = Number.parseInt(portDraft, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      setActionError(t("settings.ai.port.invalid"));
      if (status) setPortDraft(String(status.port));
      return;
    }
    if (parsed === status?.port) return;
    void apply({ port: parsed }, "port");
  };

  const commitAddress = () => {
    const trimmed = addressDraft.trim();
    if (trimmed === status?.listenAddress) return;
    void apply({ listenAddress: trimmed }, "address");
  };

  const commitClientHost = () => {
    const trimmed = clientHostDraft.trim();
    if (trimmed === (status?.clientHost ?? "")) return;
    void apply({ clientHost: trimmed }, "clientHost");
  };

  const rotateToken = async () => {
    setActionError(null);
    setPending("rotate");
    try {
      setStatus(await mcpRotateToken());
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setPending(null);
    }
  };

  const addBlocklistRule = async () => {
    const pattern = blocklistDraft.trim();
    if (!pattern) return;
    try {
      new RegExp(pattern, "i");
    } catch {
      setBlocklistError(t("settings.ai.blocklist.dialog.invalid", { pattern }));
      return;
    }
    setBlocklistBusy(true);
    setBlocklistError(null);
    try {
      const next = await mcpBlocklistSet([...blocklist, pattern]);
      setBlocklist(next);
      setAddBlocklistOpen(false);
      setBlocklistDraft("");
    } catch (error) {
      setBlocklistError(describeError(error));
    } finally {
      setBlocklistBusy(false);
    }
  };

  const removeBlocklistRule = async (index: number) => {
    setBlocklistBusy(true);
    setBlocklistError(null);
    try {
      setBlocklist(await mcpBlocklistSet(blocklist.filter((_, i) => i !== index)));
    } catch (error) {
      setBlocklistError(describeError(error));
    } finally {
      setBlocklistBusy(false);
    }
  };

  const restoreBlocklist = async () => {
    setBlocklistBusy(true);
    setBlocklistError(null);
    try {
      setBlocklist(await mcpBlocklistReset());
    } catch (error) {
      setBlocklistError(describeError(error));
    } finally {
      setBlocklistBusy(false);
    }
  };

  const removeGrant = async (grantId: string) => {
    setGrantsBusy(true);
    setGrantsError(null);
    try {
      setGrants(await mcpGrantRemove(grantId));
    } catch (error) {
      setGrantsError(describeError(error));
    } finally {
      setGrantsBusy(false);
    }
  };

  const saveGrant = async () => {
    if (!grantEditor) return;
    const capabilityId = grantEditor.capabilityId.trim();
    if (!capabilityId) {
      setGrantsError(t("settings.ai.grants.col.capability"));
      return;
    }
    const commandPattern = grantEditor.commandPattern.trim();
    const note = grantEditor.note.trim();
    const next: PermissionGrant = {
      id: `grant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      capabilityId,
      sessionPattern: "*",
      createdAt: Date.now(),
      ...(commandPattern ? { commandPattern } : {}),
      ...(note ? { note } : {}),
    };
    setGrantsBusy(true);
    setGrantsError(null);
    try {
      setGrants(await mcpGrantsSave([...grants, next]));
      setGrantEditor(null);
    } catch (error) {
      setGrantsError(describeError(error));
    } finally {
      setGrantsBusy(false);
    }
  };

  const importGrants = async () => {
    setGrantsBusy(true);
    setImportError(null);
    try {
      setGrants(await mcpGrantsImport(importText));
      setImportOpen(false);
      setImportText("");
    } catch (error) {
      setImportError(describeError(error));
    } finally {
      setGrantsBusy(false);
    }
  };

  const exportGrants = async () => {
    setGrantsError(null);
    try {
      const json = await mcpGrantsExport();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = t("settings.ai.grants.export.file");
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setGrantsError(describeError(error));
    }
  };

  const copy = (key: string, value: string) => {
    navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(key);
        window.setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {});
  };

  const copyButton = (key: string, value: string, disabled: boolean) => (
    <button
      type="button"
      className="nc-set-btn is-secondary is-sm"
      disabled={disabled}
      onClick={() => copy(key, value)}
    >
      <Icon name={copied === key ? "check" : "copy"} size={14} />
      {copied === key ? t("settings.ai.copied") : t("settings.ai.copy")}
    </button>
  );

  const errorText = status?.error ?? actionError;

  return (
    <div className="nc-set-page">
      <section className="nc-set-section">
        <div className="nc-mcp-head">
          <div className="nc-mcp-head-text">
            <h3 className="nc-set-section-title">{t("settings.ai.title")}</h3>
            <p className="nc-set-row-desc">{t("settings.ai.desc")}</p>
          </div>
          <StatusPill status={status} />
        </div>

        {errorText && (
          <div className="nc-mcp-error" role="alert">
            <span>{errorText}</span>
            {status?.errorCode && (
              <span className="nc-mcp-error-code">
                {t("settings.ai.errorCode")}: {status.errorCode}
              </span>
            )}
          </div>
        )}

        <div className="nc-set-card">
          <div className="nc-set-row">
            <div className="nc-set-row-text">
              <div className="nc-set-row-title">{t("settings.ai.enable")}</div>
              <div className="nc-set-row-desc">{t("settings.ai.enable.desc")}</div>
            </div>
            <div className="nc-set-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(status?.enabled)}
                aria-label={t("settings.ai.enable")}
                className={"nc-set-toggle" + (status?.enabled ? " is-on" : "")}
                disabled={!status || pending === "enabled"}
                onClick={() => void apply({ enabled: !status?.enabled }, "enabled")}
              >
                <span className="nc-set-toggle-knob" />
              </button>
            </div>
          </div>

          <div className="nc-set-row nc-mcp-row-block">
            <div className="nc-set-row-text">
              <div className="nc-set-row-title">{t("settings.ai.permission.title")}</div>
              <div className="nc-set-row-desc">{t("settings.ai.permission.desc")}</div>
            </div>
            <div className="nc-mcp-modes" role="radiogroup" aria-label={t("settings.ai.permission.title")}>
              {PERMISSION_MODES.map((mode) => {
                const active = (status?.permissionMode ?? "confirm") === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={"nc-mcp-mode" + (active ? " is-active" : "")}
                    disabled={!status || pending === "permission"}
                    onClick={() => void apply({ permissionMode: mode.value }, "permission")}
                  >
                    <span className="nc-mcp-mode-radio" aria-hidden="true" />
                    <span className="nc-mcp-mode-text">
                      <span className="nc-mcp-mode-title">{t(mode.label)}</span>
                      <span className="nc-mcp-mode-desc">{t(mode.desc)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="nc-set-row">
            <div className="nc-set-row-text">
              <div className="nc-set-row-title">{t("settings.ai.port")}</div>
              <div className="nc-set-row-desc">{t("settings.ai.port.desc")}</div>
            </div>
            <div className="nc-set-row-control">
              <input
                type="number"
                className="nc-set-input nc-set-input-num"
                aria-label={t("settings.ai.port")}
                min={1024}
                max={65535}
                value={portDraft}
                disabled={!status || pending === "port"}
                onFocus={() => {
                  editingRef.current = true;
                }}
                onBlur={() => {
                  editingRef.current = false;
                  commitPort();
                }}
                onChange={(event) => setPortDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </div>

          <div className="nc-set-row">
            <div className="nc-set-row-text">
              <div className="nc-set-row-title">{t("settings.ai.listenAddress")}</div>
              <div className="nc-set-row-desc">{t("settings.ai.listenAddress.desc")}</div>
            </div>
            <div className="nc-set-row-control">
              <input
                type="text"
                className="nc-set-input"
                aria-label={t("settings.ai.listenAddress")}
                value={addressDraft}
                disabled={!status || pending === "address"}
                onFocus={() => {
                  editingRef.current = true;
                }}
                onBlur={() => {
                  editingRef.current = false;
                  commitAddress();
                }}
                onChange={(event) => setAddressDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </div>

          <div className="nc-set-row">
            <div className="nc-set-row-text">
              <div className="nc-set-row-title">{t("settings.ai.allowCustomBind")}</div>
              <div className="nc-set-row-desc">{t("settings.ai.allowCustomBind.desc")}</div>
            </div>
            <div className="nc-set-row-control">
              <input
                type="checkbox"
                className="nc-mcp-checkbox"
                aria-label={t("settings.ai.allowCustomBind")}
                checked={Boolean(status?.allowCustomBind)}
                disabled={!status || pending === "bind"}
                onChange={(event) => void apply({ allowCustomBind: event.currentTarget.checked }, "bind")}
              />
            </div>
          </div>

          <div className="nc-set-row">
            <div className="nc-set-row-text">
              <div className="nc-set-row-title">{t("settings.ai.clientHost")}</div>
              <div className="nc-set-row-desc">{t("settings.ai.clientHost.desc")}</div>
            </div>
            <div className="nc-set-row-control">
              <input
                type="text"
                className="nc-set-input"
                aria-label={t("settings.ai.clientHost")}
                placeholder={t("settings.ai.clientHost.placeholder")}
                value={clientHostDraft}
                disabled={!status || pending === "clientHost"}
                onFocus={() => {
                  editingRef.current = true;
                }}
                onBlur={() => {
                  editingRef.current = false;
                  commitClientHost();
                }}
                onChange={(event) => setClientHostDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </div>
        </div>

        {status?.running && (
          <p className="nc-set-hint">
            {t("settings.ai.status.toolCount", { count: status.toolCount })}
          </p>
        )}
      </section>

      <section className="nc-set-section">
        <div className="nc-mcp-head">
          <div>
            <h2 className="nc-set-section-title">{t("settings.ai.blocklist")}</h2>
            <p className="nc-set-section-desc">{t("settings.ai.blocklist.desc")}</p>
          </div>
          <button
            type="button"
            className="nc-set-btn is-sm"
            disabled={blocklistBusy}
            onClick={() => void restoreBlocklist()}
          >
            <Icon name="refresh" size={14} />
            {t("settings.ai.blocklist.restore")}
          </button>
        </div>

        <div className="nc-set-card nc-safety-card">
          {blocklist.length === 0 && (
            <p className="nc-set-hint">{t("settings.ai.blocklist.empty")}</p>
          )}
          {blocklist.map((pattern, index) => (
            <div className="nc-safety-rule" key={`${index}:${pattern}`}>
              <input
                className="nc-set-input nc-safety-input"
                value={pattern}
                readOnly
                aria-label={`${t("settings.ai.blocklist")} ${index + 1}`}
                title={pattern}
              />
              <button
                type="button"
                className="nc-safety-remove"
                aria-label={t("settings.ai.blocklist.delete")}
                title={t("settings.ai.blocklist.delete")}
                disabled={blocklistBusy}
                onClick={() => void removeBlocklistRule(index)}
              >
                ×
              </button>
            </div>
          ))}
          <div className="nc-safety-foot">
            <button
              type="button"
              className="nc-set-btn is-sm is-ghost"
              onClick={() => {
                setBlocklistError(null);
                setBlocklistDraft("");
                setAddBlocklistOpen(true);
              }}
            >
              {t("settings.ai.blocklist.add")}
            </button>
            <span className="nc-set-hint">{t("settings.ai.blocklist.note")}</span>
          </div>
          {blocklistError && <p className="nc-mcp-error">{blocklistError}</p>}
        </div>
      </section>

      <section className="nc-set-section">
        <h2 className="nc-set-section-title">{t("settings.ai.grants")}</h2>
        <div className="nc-set-card">
          <div className="nc-set-row nc-mcp-row-block">
            <div className="nc-set-row-text">
              <div className="nc-set-row-title">{t("settings.ai.grants.card")}</div>
              <div className="nc-set-row-desc">{t("settings.ai.grants.desc")}</div>
            </div>
            <div className="nc-grant-actions">
              <button
                type="button"
                className="nc-set-btn is-sm"
                disabled={grantsBusy}
                onClick={() =>
                  setGrantEditor({ capabilityId: "terminal_execute", commandPattern: "", note: "" })
                }
              >
                {t("settings.ai.grants.add")}
              </button>
              <button
                type="button"
                className="nc-set-btn is-sm is-ghost"
                disabled={grantsBusy}
                onClick={() => {
                  setImportError(null);
                  setImportText("");
                  setImportOpen(true);
                }}
              >
                {t("settings.ai.grants.import")}
              </button>
              <button
                type="button"
                className="nc-set-btn is-sm is-ghost"
                disabled={grantsBusy || grants.length === 0}
                onClick={() => void exportGrants()}
              >
                {t("settings.ai.grants.export")}
              </button>
            </div>
          </div>

          {grants.length === 0 ? (
            <p className="nc-set-hint nc-grant-empty">{t("settings.ai.grants.empty")}</p>
          ) : (
            <div className="nc-grant-table" role="table">
              <div className="nc-grant-row nc-grant-head" role="row">
                <span role="columnheader">{t("settings.ai.grants.col.capability")}</span>
                <span role="columnheader">{t("settings.ai.grants.col.command")}</span>
                <span role="columnheader">{t("settings.ai.grants.col.note")}</span>
                <span role="columnheader" aria-label={t("settings.ai.grants.delete")} />
              </div>
              {grants.map((grant) => (
                <div className="nc-grant-row" role="row" key={grant.id}>
                  <span role="cell" className="nc-grant-cell">
                    <code>{grant.capabilityId}</code>
                  </span>
                  <span role="cell" className="nc-grant-cell">
                    {grant.commandPattern ? (
                      <code>{grant.commandPattern}</code>
                    ) : (
                      <span className="nc-grant-empty-cell">
                        {t("settings.ai.grants.allCommands")}
                      </span>
                    )}
                  </span>
                  <span role="cell" className="nc-grant-cell nc-grant-note">
                    {grant.note ?? ""}
                  </span>
                  <span role="cell" className="nc-grant-cell">
                    <button
                      type="button"
                      className="nc-safety-remove"
                      aria-label={t("settings.ai.grants.delete")}
                      title={t("settings.ai.grants.delete")}
                      disabled={grantsBusy}
                      onClick={() => void removeGrant(grant.id)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {grantsError && <p className="nc-mcp-error">{grantsError}</p>}
        </div>
      </section>

      {status?.running && (
        <details
          className="nc-mcp-details"
          open={detailsOpen}
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        >
          <summary className="nc-set-section-title nc-mcp-summary">{t("settings.ai.details")}</summary>
          <div className="nc-set-card">
            <div className="nc-mcp-copy-row">
              <div className="nc-mcp-copy-label">{t("settings.ai.url")}</div>
              <div className="nc-mcp-copy-line">
                <code className="nc-mcp-code-block">{status.url ?? t("settings.ai.unavailable")}</code>
                <div className="nc-mcp-copy-actions">
                  {copyButton("url", status.url ?? "", !status.url)}
                </div>
              </div>
            </div>

            <div className="nc-mcp-copy-row">
              <div className="nc-mcp-copy-label">{t("settings.ai.token")}</div>
              <div className="nc-mcp-copy-line">
                <code className="nc-mcp-code-block">
                  {status.bearerToken ? maskToken(status.bearerToken) : t("settings.ai.unavailable")}
                </code>
                <div className="nc-mcp-copy-actions">
                  {copyButton("token", status.bearerToken ?? "", !status.bearerToken)}
                  <button
                    type="button"
                    className="nc-set-btn is-sm"
                    disabled={pending === "rotate"}
                    onClick={() => void rotateToken()}
                  >
                    <Icon name="refresh" size={14} />
                    {t("settings.ai.token.rotate")}
                  </button>
                </div>
              </div>
              <div className="nc-set-row-desc">{t("settings.ai.token.rotate.desc")}</div>
            </div>

            <div className="nc-mcp-snippet">
              <div className="nc-mcp-snippet-tabs" role="tablist" aria-label={t("settings.ai.details")}>
                {SNIPPET_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="tab"
                    aria-selected={snippetKind === kind}
                    className={
                      "nc-set-btn is-sm " + (snippetKind === kind ? "is-primary" : "is-ghost")
                    }
                    onClick={() => setSnippetKind(kind)}
                  >
                    {t(`settings.ai.snippet.${kind}`)}
                  </button>
                ))}
                {copyButton("snippet", snippet, snippetLoading || !snippet)}
              </div>
              {snippetError ? (
                <p className="nc-mcp-error" role="alert">
                  {snippetError}
                </p>
              ) : (
                <pre className="nc-mcp-code-block">
                  {snippetLoading ? t("settings.ai.snippet.loading") : snippet || t("settings.ai.unavailable")}
                </pre>
              )}
            </div>
          </div>
        </details>
      )}

      {status?.running && (
        <section className="nc-set-section">
          <div className="nc-mcp-head">
            <div className="nc-mcp-head-text">
              <h3 className="nc-set-section-title">{t("settings.ai.guide")}</h3>
              <p className="nc-set-row-desc">{t("settings.ai.guide.desc")}</p>
            </div>
          </div>
          <div className="nc-set-card">
            {guideError && (
              <p className="nc-mcp-error" role="alert">
                {guideError}
              </p>
            )}
            {guideLoading && guide.length === 0 && (
              <p className="nc-set-hint">{t("settings.ai.guide.loading")}</p>
            )}
            <div className="nc-mcp-guide" data-testid="mcp-guide">
              {guide.map((block) => (
                <div key={block.id} className="nc-mcp-guide-block" data-guide-id={block.id}>
                  <div className="nc-mcp-guide-head">
                    <span className="nc-mcp-copy-label">{block.title}</span>
                    {copyButton(`guide:${block.id}`, block.content, !block.content)}
                  </div>
                  <pre
                    className={
                      "nc-mcp-code-block nc-mcp-guide-code" +
                      (block.id === "systemPrompt" || block.id === "tools" ? " is-prose" : "")
                    }
                  >
                    {block.content}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
      {addBlocklistOpen && (
        <div
          className="nc-set-modal-backdrop"
          role="presentation"
          onMouseDown={() => setAddBlocklistOpen(false)}
        >
          <div
            className="nc-set-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("settings.ai.blocklist.dialog.title")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="nc-set-modal-title">{t("settings.ai.blocklist.dialog.title")}</div>
            <div className="nc-set-field">
              <label className="nc-set-field-label" htmlFor="ai-blocklist-pattern">
                {t("settings.ai.blocklist")}
              </label>
              <input
                id="ai-blocklist-pattern"
                className="nc-set-input"
                autoFocus
                value={blocklistDraft}
                placeholder={t("settings.ai.blocklist.dialog.placeholder")}
                onChange={(event) => setBlocklistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addBlocklistRule();
                }}
              />
            </div>
            {blocklistError && <p className="nc-set-field-error">{blocklistError}</p>}
            <div className="nc-set-modal-actions">
              <button
                type="button"
                className="nc-set-btn is-sm is-ghost"
                onClick={() => setAddBlocklistOpen(false)}
              >
                {t("settings.ai.blocklist.dialog.cancel")}
              </button>
              <button
                type="button"
                className="nc-set-btn is-sm is-primary"
                disabled={blocklistBusy || !blocklistDraft.trim()}
                onClick={() => void addBlocklistRule()}
              >
                {t("settings.ai.blocklist.dialog.ok")}
              </button>
            </div>
          </div>
        </div>
      )}

      {grantEditor && (
        <div
          className="nc-set-modal-backdrop"
          role="presentation"
          onMouseDown={() => setGrantEditor(null)}
        >
          <div
            className="nc-set-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("settings.ai.grants.dialog.title")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="nc-set-modal-title">{t("settings.ai.grants.dialog.title")}</div>
            <div className="nc-set-field">
              <label className="nc-set-field-label" htmlFor="ai-grant-capability">
                {t("settings.ai.grants.dialog.capability")}
              </label>
              <select
                id="ai-grant-capability"
                className="nc-set-input"
                value={grantEditor.capabilityId}
                onChange={(event) =>
                  setGrantEditor({ ...grantEditor, capabilityId: event.target.value })
                }
              >
                {["terminal_execute", "session_close", "get_environment", "vault_hosts_list", "snippets_list"].map(
                  (tool) => (
                    <option key={tool} value={tool}>
                      {tool}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div className="nc-set-field">
              <label className="nc-set-field-label" htmlFor="ai-grant-command">
                {t("settings.ai.grants.dialog.command")}
              </label>
              <input
                id="ai-grant-command"
                className="nc-set-input"
                autoFocus
                value={grantEditor.commandPattern}
                placeholder="git status *"
                onChange={(event) =>
                  setGrantEditor({ ...grantEditor, commandPattern: event.target.value })
                }
              />
              <span className="nc-set-field-hint">{t("settings.ai.grants.dialog.commandHint")}</span>
            </div>
            <div className="nc-set-field">
              <label className="nc-set-field-label" htmlFor="ai-grant-note">
                {t("settings.ai.grants.dialog.note")}
              </label>
              <input
                id="ai-grant-note"
                className="nc-set-input"
                value={grantEditor.note}
                onChange={(event) => setGrantEditor({ ...grantEditor, note: event.target.value })}
              />
            </div>
            {grantsError && <p className="nc-set-field-error">{grantsError}</p>}
            <div className="nc-set-modal-actions">
              <button
                type="button"
                className="nc-set-btn is-sm is-ghost"
                onClick={() => setGrantEditor(null)}
              >
                {t("settings.ai.grants.dialog.cancel")}
              </button>
              <button
                type="button"
                className="nc-set-btn is-sm is-primary"
                disabled={grantsBusy}
                onClick={() => void saveGrant()}
              >
                {t("settings.ai.grants.dialog.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div
          className="nc-set-modal-backdrop"
          role="presentation"
          onMouseDown={() => setImportOpen(false)}
        >
          <div
            className="nc-set-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t("settings.ai.grants.import.title")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="nc-set-modal-title">{t("settings.ai.grants.import.title")}</div>
            <p className="nc-set-row-desc">{t("settings.ai.grants.import.desc")}</p>
            <textarea
              className="nc-set-textarea is-full"
              rows={10}
              autoFocus
              value={importText}
              placeholder={t("settings.ai.grants.import.placeholder")}
              onChange={(event) => {
                setImportText(event.target.value);
                setImportError(null);
              }}
            />
            {importError && <p className="nc-set-field-error">{importError}</p>}
            <div className="nc-set-modal-actions">
              <button
                type="button"
                className="nc-set-btn is-sm is-ghost"
                onClick={() => setImportOpen(false)}
              >
                {t("settings.ai.grants.dialog.cancel")}
              </button>
              <button
                type="button"
                className="nc-set-btn is-sm is-primary"
                disabled={grantsBusy || !importText.trim()}
                onClick={() => void importGrants()}
              >
                {t("settings.ai.grants.import.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
