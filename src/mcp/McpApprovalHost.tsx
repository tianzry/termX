/**
 * 外部 MCP 审批浮层（confirm 档位）。
 *
 * 对齐 Netcatty `components/ai/ExternalMcpApprovalsHost.tsx`：
 * - 常驻主窗右下角，监听主进程广播的待审批项；
 * - 允许一次 / 一律许可（沉淀放行规则）/ 拒绝；
 * - 超时、客户端断开、服务重启由后端直接结算，前端只按 cleared 事件移除。
 */

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  mcpApprovalPending,
  mcpApprovalResolve,
  type McpApprovalDecision,
  type McpApprovalRequest,
} from "../backend/client";
import { settingsT } from "../settings/i18n";
import { useSettings } from "../settings/settingsStore";

type ClearPayload = { approvalIds?: string[]; reason?: string };

export function McpApprovalHost() {
  const { language } = useSettings();
  const t = (key: string, params?: Record<string, string | number>) =>
    settingsT(language, key, params);
  const [items, setItems] = useState<McpApprovalRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** 仅用于驱动倒计时重渲染。 */
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const unsubs: UnlistenFn[] = [];
    const keep = (u: UnlistenFn) => {
      if (alive) unsubs.push(u);
      else u();
    };
    const remove = (ids: string[]) => {
      if (ids.length === 0) return;
      setItems((prev) => prev.filter((item) => !ids.includes(item.approvalId)));
    };

    void listen<McpApprovalRequest>("mcp:approval-request", (event) => {
      setError("");
      setItems((prev) =>
        prev.some((item) => item.approvalId === event.payload.approvalId)
          ? prev
          : [...prev, event.payload],
      );
    }).then(keep);

    void listen<ClearPayload>("mcp:approval-cleared", (event) => {
      remove(event.payload.approvalIds ?? []);
    }).then(keep);

    // 浮层晚于事件挂载 / 热更新后重连时，拉取当前挂起项补齐。
    void mcpApprovalPending()
      .then((list) => {
        if (alive) setItems(list);
      })
      .catch(() => {});

    return () => {
      alive = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [items.length]);

  if (items.length === 0) return null;

  const decide = async (item: McpApprovalRequest, decision: McpApprovalDecision) => {
    setBusy(item.approvalId);
    setError("");
    try {
      const ok = await mcpApprovalResolve(item.approvalId, decision);
      if (!ok) setError(t("mcp.approval.settled"));
      setItems((prev) => prev.filter((x) => x.approvalId !== item.approvalId));
    } catch (e) {
      setError(
        t("mcp.approval.submitFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mcp-approval-host" role="region" aria-live="polite">
      {items.map((item) => {
        const remaining = Math.max(
          0,
          Math.ceil((item.createdAtMs + item.timeoutMs - Date.now()) / 1000),
        );
        const disabled = busy === item.approvalId;
        return (
          <div className="mcp-approval-card" key={item.approvalId} role="alertdialog">
            <div className="mcp-approval-head">
              <span className="mcp-approval-title">{t("mcp.approval.title")}</span>
              <span className="mcp-approval-count">
                {t("mcp.approval.count", { count: items.length })} ·{" "}
                {t("mcp.approval.timeout", { seconds: remaining })}
              </span>
            </div>
            <div className="mcp-approval-tool">
              {t("mcp.approval.tool")}
              <code>{item.toolName}</code>
            </div>
            <div className="mcp-approval-meta">
              {t("mcp.approval.target")}:{" "}
              {item.targetLabel || item.sessionId || t("mcp.approval.unknownTarget")}
            </div>
            <pre className="mcp-approval-args">{item.argsSummary}</pre>
            {error && <div className="mcp-approval-error">{error}</div>}
            <div className="mcp-approval-actions">
              <button
                type="button"
                className="nc-set-btn is-primary"
                disabled={disabled}
                onClick={() => void decide(item, "once")}
              >
                {t("mcp.approval.allowOnce")}
              </button>
              <button
                type="button"
                className="nc-set-btn is-secondary"
                disabled={disabled}
                title={t("mcp.approval.alwaysAllowHint")}
                onClick={() => void decide(item, "always")}
              >
                {t("mcp.approval.alwaysAllow")}
              </button>
              <button
                type="button"
                className="nc-set-btn"
                disabled={disabled}
                onClick={() => void decide(item, "reject")}
              >
                {t("mcp.approval.reject")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
