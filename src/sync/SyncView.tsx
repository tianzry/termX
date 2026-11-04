/**
 * Vault「同步」页（P1 #15）。
 *
 * 后端 `commands/sync.rs` 已具备 GitHub / WebDAV 的元数据探测、推送、拉取与
 * 自动拉取；本页只做配置与操作入口。未移植的 provider（Google Drive /
 * OneDrive / S3）与 OAuth 设备码、冲突合并策略保持置灰并写明原因。
 *
 * 同步载荷使用本地「同步加密密码」加密；自动拉取会把密码存入 SecretStore。
 */

import { useEffect, useState, type CSSProperties } from "react";
import * as api from "../backend/client";
import type {
  SyncAutoPullStatus,
  SyncCheckResult,
  SyncProviderKey,
} from "../backend/client";
import { userVisibleError } from "../domain/sshErrors";
import {
  conflictBlocks,
  detectSyncConflict,
  normalizeGitHubRepo,
  normalizeWebdavUrl,
  summarizeRemote,
  type RemoteSummary,
  type SyncConflictKind,
} from "../domain/syncModel";
import { Icon } from "../ui/icons";

const panel: CSSProperties = {
  border: "1px solid hsl(var(--border))",
  borderRadius: 10,
  background: "hsl(var(--card))",
  padding: "14px 16px",
};

const muted: CSSProperties = {
  color: "hsl(var(--muted-foreground))",
  fontSize: 11,
};

const input: CSSProperties = {
  width: "100%",
  padding: "6px 9px",
  borderRadius: 6,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--input, var(--background)))",
  color: "hsl(var(--foreground))",
  fontSize: 12,
  boxSizing: "border-box",
};

const btn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "hsl(var(--secondary))",
  color: "hsl(var(--foreground))",
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const toneColor: Record<RemoteSummary["tone"], string> = {
  empty: "hsl(var(--muted-foreground))",
  error: "hsl(var(--destructive))",
  synced: "#34d399",
  newer: "#fbbf24",
  older: "#38bdf8",
};

function describeError(error: unknown): string {
  const text = String(error);
  if (text.includes("sync_password_empty")) return "请先填写同步加密密码。";
  if (text.includes("sync_auto_pull_password_missing")) return "自动拉取缺少密码，请重新开启。";
  if (text.includes("github_token_missing")) return "GitHub Token 未配置。";
  if (text.includes("github_repo_missing")) return "GitHub 仓库未配置。";
  if (text.includes("webdav_url_missing")) return "WebDAV 地址未配置。";
  if (text.includes("webdav_password_missing")) return "WebDAV 密码未配置。";
  if (text.includes("sync_backup_empty")) return "本地配置为空，没有可快照的内容。";
  if (text.includes("sync_backup_missing")) return "快照已失效，请刷新列表。";
  if (text.includes("github_repo_invalid")) return "仓库格式应为 owner/repo。";
  if (text.includes("401") || text.includes("unauthorized")) return "远端认证失败（Token / 密码无效）。";
  if (text.includes("404")) return "远端不存在：请确认仓库、分支或 WebDAV 路径。";
  return userVisibleError(text);
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "--";
  }
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "block", marginTop: 8 }}>
      <span style={{ ...muted, display: "block", marginBottom: 3 }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={input}
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  );
}

function ProviderStatus({ summary }: { summary: RemoteSummary }) {
  return (
    <div style={{ marginTop: 8, fontSize: 11, color: toneColor[summary.tone], lineHeight: 1.6 }}>
      <span style={{ fontWeight: 600 }}>{summary.label}</span>
      <span style={{ color: "hsl(var(--muted-foreground))" }}> · {summary.detail}</span>
    </div>
  );
}

export function SyncView({ onAfterPull }: { onAfterPull?: () => void | Promise<void> }) {
  const [githubEnabled, setGithubEnabled] = useState(true);
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [githubToken, setGithubToken] = useState("");
  const [webdavEnabled, setWebdavEnabled] = useState(false);
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUser, setWebdavUser] = useState("");
  const [webdavPassword, setWebdavPassword] = useState("");
  const [syncPassword, setSyncPassword] = useState("");
  const [check, setCheck] = useState<SyncCheckResult | null>(null);
  const [auto, setAuto] = useState<SyncAutoPullStatus>({ github: false, webdav: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [backups, setBackups] = useState<api.SyncBackupEntry[]>([]);
  const [snapBusy, setSnapBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    provider: SyncProviderKey;
    direction: "push" | "pull";
    kind: SyncConflictKind;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [
          gEnabled,
          gRepo,
          gBranch,
          gToken,
          wEnabled,
          wUrl,
          wUser,
          wPassword,
          autoStatus,
          gSnapshot,
        ] = await Promise.all([
          api.getSetting("sync_github_enabled"),
          api.getSetting("github_repo"),
          api.getSetting("github_branch"),
          api.getSetting("github_token"),
          api.getSetting("sync_webdav_enabled"),
          api.getSetting("webdav_url"),
          api.getSetting("webdav_username"),
          api.getSetting("webdav_password"),
          api.getSyncAutoPullStatus(),
          api.listSyncBackups(),
        ]);
        if (cancelled) return;
        setBackups(gSnapshot);
        setGithubEnabled(gEnabled !== "0");
        setGithubRepo(gRepo ?? "");
        setGithubBranch(gBranch ?? "main");
        setGithubToken(gToken ?? "");
        setWebdavEnabled(wEnabled === "1");
        setWebdavUrl(wUrl ?? "");
        setWebdavUser(wUser ?? "");
        setWebdavPassword(wPassword ?? "");
        setAuto(autoStatus);
      } catch (e) {
        if (!cancelled) setMessage({ tone: "error", text: describeError(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setMessage(null);
    try {
      await task();
    } catch (e) {
      setMessage({ tone: "error", text: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function refreshCheck() {
    let result: SyncCheckResult;
    try {
      result = await api.syncCheck();
      setCheck(result);
      setAuto(await api.getSyncAutoPullStatus());
    } catch {
      result = await api.syncCheckRemotes();
      setCheck(result);
    }
    // 后端在开启自动拉取时可能已导入远端配置，需要让 Vault 重新加载主机/分组。
    if (result.github.pulled || result.webdav.pulled) await onAfterPull?.();
    return result;
  }

  async function saveGithub() {
    await run("save-github", async () => {
      const repo = normalizeGitHubRepo(githubRepo);
      await Promise.all([
        api.setSetting("sync_github_enabled", githubEnabled ? "1" : "0"),
        api.setSetting("github_repo", repo),
        api.setSetting("github_branch", githubBranch.trim() || "main"),
        api.setSetting("github_token", githubToken.trim()),
      ]);
      setGithubRepo(repo);
      setMessage({ tone: "ok", text: "GitHub 配置已保存（Token 存入 SecretStore）。" });
      await refreshCheck();
    });
  }

  async function saveWebdav() {
    await run("save-webdav", async () => {
      const url = normalizeWebdavUrl(webdavUrl);
      await Promise.all([
        api.setSetting("sync_webdav_enabled", webdavEnabled ? "1" : "0"),
        api.setSetting("webdav_url", url),
        api.setSetting("webdav_username", webdavUser.trim()),
        api.setSetting("webdav_password", webdavPassword),
      ]);
      setWebdavUrl(url);
      setMessage({ tone: "ok", text: "WebDAV 配置已保存（密码存入 SecretStore）。" });
      await refreshCheck();
    });
  }

  async function refreshBackups() {
    try {
      setBackups(await api.listSyncBackups());
    } catch {
      /* 列表失败不阻塞主流程，下次操作会再拉一次 */
    }
  }

  /** 推送/拉取前先探测远端；有破坏性冲突时弹窗，不直接执行。 */
  async function conflictBlocksAction(
    provider: SyncProviderKey,
    direction: "push" | "pull",
  ): Promise<boolean> {
    const result = await api.syncCheckRemotes();
    setCheck(result);
    const local = result.local;
    const remote = provider === "github" ? result.github.remote : result.webdav.remote;
    const kind = detectSyncConflict(local, remote);
    if (conflictBlocks(kind, direction)) {
      setConflict({ provider, direction, kind });
      return true;
    }
    return false;
  }

  async function push(provider: SyncProviderKey, confirmed = false) {
    await run(`push-${provider}`, async () => {
      if (!syncPassword) throw new Error("sync_password_empty");
      if (!confirmed && (await conflictBlocksAction(provider, "push"))) return;
      if (provider === "github") await api.githubPush(syncPassword);
      else await api.webdavPush(syncPassword);
      setMessage({
        tone: "ok",
        text: `已推送到 ${provider === "github" ? "GitHub" : "WebDAV"}。`,
      });
      await refreshCheck();
      await refreshBackups();
    });
  }

  async function pull(provider: SyncProviderKey, confirmed = false) {
    await run(`pull-${provider}`, async () => {
      if (!syncPassword) throw new Error("sync_password_empty");
      if (!confirmed && (await conflictBlocksAction(provider, "pull"))) return;
      if (provider === "github") await api.githubPull(syncPassword);
      else await api.webdavPull(syncPassword);
      setMessage({
        tone: "ok",
        text: `已从 ${provider === "github" ? "GitHub" : "WebDAV"} 拉取并导入配置（拉取前已自动创建本地快照）。`,
      });
      await refreshCheck();
      await refreshBackups();
      await onAfterPull?.();
    });
  }

  async function resolveConflict(action: "push" | "pull" | "cancel") {
    const current = conflict;
    setConflict(null);
    if (!current || action === "cancel") return;
    if (action === "push") await push(current.provider, true);
    else await pull(current.provider, true);
  }

  async function snapshot() {
    await run("snapshot", async () => {
      await api.createSyncBackup("manual");
      await refreshBackups();
      setMessage({ tone: "ok", text: "已创建本地快照（加密存入 SecretStore）。" });
    });
  }

  async function restoreSnapshot(id: string) {
    if (snapBusy) return;
    setSnapBusy(id);
    setMessage(null);
    try {
      await api.restoreSyncBackup(id);
      await refreshCheck();
      await refreshBackups();
      await onAfterPull?.();
      setMessage({ tone: "ok", text: "已从本地快照恢复配置（恢复前自动保留了当前状态）。" });
    } catch (e) {
      setMessage({ tone: "error", text: describeError(e) });
    } finally {
      setSnapBusy(null);
    }
  }

  async function removeSnapshot(id: string) {
    if (snapBusy) return;
    if (!window.confirm("删除这份本地快照？此操作不可撤销。")) return;
    setSnapBusy(id);
    try {
      await api.deleteSyncBackup(id);
      await refreshBackups();
    } catch (e) {
      setMessage({ tone: "error", text: describeError(e) });
    } finally {
      setSnapBusy(null);
    }
  }

  async function clearSnapshots() {
    if (snapBusy || !backups.length) return;
    if (!window.confirm(`清空全部 ${backups.length} 份本地快照？此操作不可撤销。`)) return;
    setSnapBusy("*");
    try {
      await api.clearSyncBackups();
      await refreshBackups();
      setMessage({ tone: "ok", text: "已清空本地快照。" });
    } catch (e) {
      setMessage({ tone: "error", text: describeError(e) });
    } finally {
      setSnapBusy(null);
    }
  }

  async function toggleAuto(provider: SyncProviderKey, next: boolean) {
    await run(`auto-${provider}`, async () => {
      if (next && !syncPassword) throw new Error("sync_password_empty");
      await api.setSyncAutoPull(provider, next, next ? syncPassword : undefined);
      setAuto(await api.getSyncAutoPullStatus());
      setMessage({
        tone: "ok",
        text: next
          ? "已开启自动拉取：启动时会先探测远端，远端更新则自动拉取。"
          : "已关闭自动拉取。",
      });
    });
  }

  const localVersion = check?.local.version ?? null;
  const githubSummary = summarizeRemote(check?.github, localVersion);
  const webdavSummary = summarizeRemote(check?.webdav, localVersion);
  const actionDisabled = busy !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>同步</div>
        <span style={{ ...muted }}>
          本地配置版本 {localVersion != null ? `v${localVersion}` : "未探测"}
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 220 }}>
          <input
            type="password"
            value={syncPassword}
            onChange={(e) => setSyncPassword(e.target.value)}
            placeholder="同步加密密码（推送/拉取必填）"
            style={{ ...input, flex: 1 }}
            autoComplete="new-password"
          />
        </div>
        <button
          style={btn}
          disabled={actionDisabled}
          onClick={() => run("check", async () => {
            const result = await refreshCheck();
            setMessage({
              tone: "ok",
              text: `已探测：本地 v${result.local.version}。`,
            });
          })}
        >
          <Icon name="refresh" size={13} /> {busy === "check" ? "探测中…" : "检查远端"}
        </button>
        <button
          style={btn}
          disabled={actionDisabled}
          onClick={() => run("refresh", async () => {
            await api.syncRefreshLocalMetadata();
            await refreshCheck();
            setMessage({ tone: "ok", text: "已刷新本地同步元数据。" });
          })}
        >
          刷新本地版本
        </button>
      </div>

      {message && (
        <div
          style={{
            padding: "7px 10px",
            borderRadius: 7,
            fontSize: 12,
            lineHeight: 1.5,
            color: message.tone === "ok" ? "#34d399" : "hsl(var(--destructive))",
            background:
              message.tone === "ok"
                ? "rgba(52, 211, 153, 0.08)"
                : "hsl(var(--destructive) / 0.08)",
          }}
        >
          {message.text}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12 }}>
        <div style={panel}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="globe" size={15} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>GitHub Gist / 仓库</span>
            <label style={{ ...muted, marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}>
              <input
                type="checkbox"
                checked={githubEnabled}
                onChange={(e) => setGithubEnabled(e.target.checked)}
              />
              启用
            </label>
          </div>
          <Field label="仓库（owner/repo）" value={githubRepo} onChange={setGithubRepo} placeholder="owner/repo" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="分支" value={githubBranch} onChange={setGithubBranch} placeholder="main" />
            <Field
              label="Token（PAT）"
              value={githubToken}
              onChange={setGithubToken}
              type="password"
              placeholder="ghp_…"
            />
          </div>
          <ProviderStatus summary={githubSummary} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button style={btn} disabled={actionDisabled} onClick={saveGithub}>
              保存
            </button>
            <button style={btn} disabled={actionDisabled || !githubEnabled} onClick={() => push("github")}>
              推送
            </button>
            <button style={btn} disabled={actionDisabled || !githubEnabled} onClick={() => pull("github")}>
              拉取
            </button>
            <label style={{ ...muted, display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
              <input
                type="checkbox"
                checked={auto.github}
                disabled={actionDisabled}
                onChange={(e) => void toggleAuto("github", e.target.checked)}
              />
              启动时自动拉取
            </label>
          </div>
        </div>

        <div style={panel}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="cloud" size={15} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>WebDAV</span>
            <label style={{ ...muted, marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}>
              <input
                type="checkbox"
                checked={webdavEnabled}
                onChange={(e) => setWebdavEnabled(e.target.checked)}
              />
              启用
            </label>
          </div>
          <Field
            label="地址"
            value={webdavUrl}
            onChange={setWebdavUrl}
            placeholder="https://dav.example.com/remote.php/dav/files/me"
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="用户名" value={webdavUser} onChange={setWebdavUser} />
            <Field
              label="密码"
              value={webdavPassword}
              onChange={setWebdavPassword}
              type="password"
            />
          </div>
          <ProviderStatus summary={webdavSummary} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button style={btn} disabled={actionDisabled} onClick={saveWebdav}>
              保存
            </button>
            <button style={btn} disabled={actionDisabled || !webdavEnabled} onClick={() => push("webdav")}>
              推送
            </button>
            <button style={btn} disabled={actionDisabled || !webdavEnabled} onClick={() => pull("webdav")}>
              拉取
            </button>
            <label style={{ ...muted, display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}>
              <input
                type="checkbox"
                checked={auto.webdav}
                disabled={actionDisabled}
                onChange={(e) => void toggleAuto("webdav", e.target.checked)}
              />
              启动时自动拉取
            </label>
          </div>
        </div>
      </div>

      <div style={panel}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Icon name="history" size={15} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>本地快照</span>
          <span style={muted}>拉取 / 恢复前自动创建，最多保留 20 份</span>
          <div style={{ flex: 1 }} />
          <button style={btn} disabled={actionDisabled || snapBusy !== null} onClick={snapshot}>
            立即创建快照
          </button>
          <button
            style={btn}
            disabled={actionDisabled || snapBusy !== null || backups.length === 0}
            onClick={clearSnapshots}
          >
            清空
          </button>
        </div>
        {backups.length === 0 ? (
          <div style={{ ...muted, marginTop: 10 }}>暂无快照。推送/拉取出现冲突或恢复前会自动保存当前状态。</div>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {backups.map((b) => (
              <div
                key={b.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 8px",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12 }}>
                    {b.reason === "manual" ? "手动快照" : "保护性快照"} · v{b.sync_version} ·{" "}
                    {formatTime(b.created_at_ms)}
                  </div>
                  <div style={{ ...muted, marginTop: 2 }}>
                    {b.host_count} 主机 · {b.credential_count} 凭据 · {b.forward_count} 转发 ·{" "}
                    {b.snippet_count} 片段 · {(b.size_bytes / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button
                  style={btn}
                  disabled={snapBusy !== null}
                  onClick={() => void restoreSnapshot(b.id)}
                >
                  {snapBusy === b.id ? "恢复中…" : "恢复"}
                </button>
                <button
                  style={btn}
                  disabled={snapBusy !== null}
                  onClick={() => void removeSnapshot(b.id)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ ...panel, opacity: 0.75 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "hsl(var(--muted-foreground))" }}>未移植（Netcatty 有，termX 置灰）</div>
        <div style={{ ...muted, marginTop: 6, lineHeight: 1.8 }}>
          Google Drive / OneDrive / S3 等其他 provider（后端仅 GitHub + WebDAV）；
          OAuth 设备码登录（当前用 PAT / 用户名密码）；逐类目同步开关；「打开备份目录」（快照加密存放在
          SecretStore 而非明文文件）。冲突已提供双方版本对比与二选一覆盖，逐条目的三向合并仍未实现。
          <br />
          自动拉取会把同步密码存入 SecretStore（与主机凭据同一套加密存储）；关闭即删除该密码。
        </div>
      </div>

      {conflict && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: "rgba(0, 0, 0, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 440,
              maxWidth: "92vw",
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 12,
              padding: "16px 18px",
              boxShadow: "0 18px 48px rgba(0, 0, 0, 0.45)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="shield" size={15} />
              检测到同步冲突
            </div>
            <div style={{ ...muted, marginTop: 8, lineHeight: 1.7, fontSize: 12 }}>
              {(() => {
                const remote =
                  conflict.provider === "github" ? check?.github.remote : check?.webdav.remote;
                const local = check?.local;
                if (conflict.kind === "diverged") {
                  return `本地与远端都是 v${local?.version ?? "?"}，但内容摘要不同：两端在同一版本上各自修改过。`;
                }
                const newer =
                  conflict.kind === "remote_newer"
                    ? `远端 v${remote?.version} 高于本地 v${local?.version}`
                    : `本地 v${local?.version} 高于远端 v${remote?.version}`;
                return `${newer}。`;
              })()}
              <br />
              {conflict.direction === "push"
                ? "继续推送会用本地配置覆盖远端。"
                : "继续拉取会用远端配置覆盖本地同名条目；拉取前会自动创建本地快照。"}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <button style={btn} onClick={() => void resolveConflict("cancel")}>
                取消
              </button>
              {conflict.direction === "push" ? (
                <>
                  <button style={btn} onClick={() => void resolveConflict("pull")}>
                    改用远端（拉取）
                  </button>
                  <button
                    style={{ ...btn, borderColor: "hsl(var(--destructive))", color: "hsl(var(--destructive))" }}
                    onClick={() => void resolveConflict("push")}
                  >
                    覆盖远端并推送
                  </button>
                </>
              ) : (
                <>
                  <button style={btn} onClick={() => void resolveConflict("push")}>
                    改为推送本地
                  </button>
                  <button
                    style={{ ...btn, borderColor: "hsl(var(--destructive))", color: "hsl(var(--destructive))" }}
                    onClick={() => void resolveConflict("pull")}
                  >
                    继续拉取
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
