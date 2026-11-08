/**
 * 设置 → AI → 工具接入（对外 MCP）。
 *
 * 结构对照 Netcatty ExternalMcpCard + ExternalMcpHttpSection：
 * - 三档权限（observer / confirm / auto）；confirm 的写操作走主窗审批浮层；
 * - 「始终允许」按工具粒度持久化在设置 KV，可在本页撤销。
 */

import { useEffect, useRef, useState } from "react";
import {
  mcpApprovalRevoke,
  mcpClientConfig,
  mcpRotateToken,
  mcpSetConfig,
  mcpStatus,
  type McpConfigPatch,
  type McpPermissionMode,
  type McpStatus,
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

  const revokeAllowedTool = async (tool: string) => {
    setActionError(null);
    setPending(`revoke:${tool}`);
    try {
      const tools = await mcpApprovalRevoke(tool);
      setStatus((prev) => (prev ? { ...prev, allowedTools: tools } : prev));
    } catch (error) {
      setActionError(describeError(error));
    } finally {
      setPending(null);
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

          {status?.permissionMode === "confirm" && (status.allowedTools?.length ?? 0) > 0 && (
            <div className="nc-set-row nc-mcp-row-block">
              <div className="nc-set-row-text">
                <div className="nc-set-row-title">{t("settings.ai.permission.allowed")}</div>
                <div className="nc-set-row-desc">{t("settings.ai.permission.confirm.desc")}</div>
              </div>
              <div className="nc-mcp-allowed-list">
                {status.allowedTools.map((tool) => (
                  <span key={tool} className="nc-mcp-allowed-chip">
                    <code>{tool}</code>
                    <button
                      type="button"
                      className="nc-mcp-allowed-revoke"
                      aria-label={t("settings.ai.permission.revoke", { tool })}
                      title={t("settings.ai.permission.revoke", { tool })}
                      disabled={pending === `revoke:${tool}`}
                      onClick={() => void revokeAllowedTool(tool)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

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

      {status?.running && (
        <details
          className="nc-mcp-details"
          open={detailsOpen}
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        >
          <summary className="nc-set-section-title nc-mcp-summary">{t("settings.ai.details")}</summary>
          <div className="nc-set-card">
            <div className="nc-mcp-copy-row">
              <div className="nc-mcp-copy-text">
                <div className="nc-mcp-copy-label">{t("settings.ai.url")}</div>
                <code className="nc-mcp-code-block">{status.url ?? t("settings.ai.unavailable")}</code>
              </div>
              {copyButton("url", status.url ?? "", !status.url)}
            </div>

            <div className="nc-mcp-copy-row">
              <div className="nc-mcp-copy-text">
                <div className="nc-mcp-copy-label">{t("settings.ai.token")}</div>
                <code className="nc-mcp-code-block">
                  {status.bearerToken ? maskToken(status.bearerToken) : t("settings.ai.unavailable")}
                </code>
                <div className="nc-set-row-desc">{t("settings.ai.token.rotate.desc")}</div>
              </div>
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
    </div>
  );
}
