/**
 * 云同步纯逻辑（P1 #15）：仓库/端点输入规范化、远端状态判定。
 * 只描述后端已经具备的 GitHub / WebDAV 两种 provider；未移植项由 UI 置灰。
 */

import type { SyncProviderObservation } from "../backend/client";

export type RemoteTone = "empty" | "error" | "synced" | "newer" | "older";

export interface RemoteSummary {
  tone: RemoteTone;
  label: string;
  detail: string;
}

/** GitHub 仓库支持 `owner/repo`，也接受粘贴的 github.com URL 或 .git 后缀。 */
export function normalizeGitHubRepo(input: string): string {
  let value = input.trim();
  value = value.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = value.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : value;
}

/** WebDAV 端点缺协议时补 https；保留用户输入的路径。 */
export function normalizeWebdavUrl(input: string): string {
  const value = input.trim();
  if (!value) return value;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** 比较本地与远端版本；远端缺失或版本相同都视为已同步。 */
export function remoteIsNewer(
  localVersion: number | null | undefined,
  remoteVersion: number | null | undefined,
): boolean {
  return (
    localVersion != null &&
    remoteVersion != null &&
    Number.isFinite(localVersion) &&
    Number.isFinite(remoteVersion) &&
    remoteVersion > localVersion
  );
}

export function summarizeRemote(
  observation: SyncProviderObservation | null | undefined,
  localVersion: number | null | undefined,
): RemoteSummary {
  if (!observation || (!observation.remote && !observation.error)) {
    return {
      tone: "empty",
      label: "未配置",
      detail: "填写凭据并保存后可探测远端版本。",
    };
  }
  if (observation.error) {
    return {
      tone: "error",
      label: "探测失败",
      detail: observation.error,
    };
  }
  const remoteVersion = observation.remote?.version;
  if (remoteIsNewer(localVersion, remoteVersion)) {
    return {
      tone: "newer",
      label: "远端更新",
      detail: `远端 v${remoteVersion} 高于本地 v${localVersion}。`,
    };
  }
  if (localVersion != null && remoteVersion != null && remoteVersion < localVersion) {
    return {
      tone: "older",
      label: "本地更新",
      detail: `本地 v${localVersion} 高于远端 v${remoteVersion}，可推送。`,
    };
  }
  return {
    tone: "synced",
    label: "已同步",
    detail: `本地与远端均为 v${remoteVersion ?? localVersion ?? "?"}。`,
  };
}
