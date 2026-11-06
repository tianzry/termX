/**
 * 终端动作文案单一来源（#213）。
 *
 * 工具栏 / More 菜单 / 右键菜单此前各自写了一份中文，改动时容易只改一处；
 * 这里按动作 id 收敛，渲染层只引用常量，不再出现第二份文案。
 */

import type { TerminalToolbarAction } from "./toolbarLayout";
import type { TerminalContextMenuAction } from "./contextMenuLayout";

export interface TerminalActionText {
  /** 菜单行文本 / aria-label。 */
  label: string;
  /** 按钮 title（tooltip）。 */
  title: string;
}

/** 右侧工具栏内联按钮。 */
export const TERMINAL_TOOLBAR_TEXT: Record<TerminalToolbarAction, TerminalActionText> = {
  highlight: { label: "关键词高亮", title: "主机关键词高亮" },
  sftp: { label: "打开 SFTP", title: "打开 SFTP" },
  compose: { label: "撰写栏", title: "撰写栏" },
  search: { label: "终端搜索", title: "终端搜索" },
  sessionLog: { label: "会话日志", title: "记录会话日志" },
  scripts: { label: "运行脚本", title: "运行脚本（发送到当前会话）" },
  notes: { label: "笔记", title: "笔记面板" },
};

/** More（⋮）菜单条目。 */
export const TERMINAL_MORE_TEXT = {
  history: { label: "命令历史", title: "命令历史" },
  osc7: { label: "配置目录追踪", title: "配置目录追踪" },
  terminalSettings: { label: "终端设置", title: "终端设置（外观 / 字体 / 行为）" },
  encoding: { label: "终端编码", title: "终端编码" },
} as const;

/** 「录制脚本」随录制状态切换文案（开始 / 停止），仍收敛在本文件。 */
export function terminalRecordingText(active: boolean): TerminalActionText {
  return active
    ? { label: "停止录制", title: "停止录制并保存到脚本库" }
    : { label: "开始录制", title: "开始录制脚本" };
}

/** 右键菜单文案（对照 Netcatty i18n `terminal.menu.*`）。 */
export const TERMINAL_CONTEXT_MENU_TEXT: Record<TerminalContextMenuAction, string> = {
  copy: "复制",
  paste: "粘贴",
  selectAll: "全选",
  openSftp: TERMINAL_TOOLBAR_TEXT.sftp.label,
  reconnect: "重新连接",
  splitHorizontal: "水平分屏",
  splitVertical: "垂直分屏",
  clearBuffer: "清空缓冲区",
  closeTerminal: "关闭终端",
};
