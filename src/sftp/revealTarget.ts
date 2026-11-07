/**
 * 「打开目标目录」的跨组件分发（对齐 Netcatty `netcatty:open-sftp-transfer-target`）。
 *
 * - 下载/本地目标：直接交给系统文件管理器（`local_open_path` 会先校验目录存在，
 *   被移动/删除时返回可读错误）。
 * - 上传/远端目标：由当前打开的 SFTP 面板处理（按 `sftp_id` 匹配并跳转到目标
 *   目录）。没有匹配面板时明确提示，而不是静默失败。
 */

import * as api from "../backend/client";
import type { TransferItem } from "../backend/client";
import { transferTargetDir, transferTargetPath } from "../domain/transferQueue";

/** 返回 true 表示该面板认领了这次请求（已开始导航）。 */
type RevealHandler = (item: TransferItem) => boolean;

const handlers = new Set<RevealHandler>();

export function registerSftpTargetReveal(handler: RevealHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export type RevealResult =
  | { status: "ok" }
  | { status: "error"; message: string }
  | { status: "no-pane"; message: string };

export async function revealTransferTarget(
  item: TransferItem,
): Promise<RevealResult> {
  const target = transferTargetPath(item);
  const dir = transferTargetDir(item);
  if (!target || !dir) {
    return { status: "error", message: "目标路径无效，无法打开目录" };
  }

  if (item.direction === "download") {
    try {
      await api.localOpenPath(dir);
      return { status: "ok" };
    } catch {
      return {
        status: "error",
        message: "无法打开目标目录（目录可能已被移动或删除）",
      };
    }
  }

  for (const handler of handlers) {
    if (handler(item)) return { status: "ok" };
  }
  return {
    status: "no-pane",
    message: "目标目录所属的 SFTP 会话未打开，请先打开该会话的 SFTP 面板",
  };
}
