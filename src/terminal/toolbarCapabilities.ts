/**
 * 终端工具栏的「类型 × 功能」派生（对照 Netcatty `TerminalToolbar.availableIds`）。
 *
 * 规则来源（Netcatty 源码）：
 * - `sftp` / `configureOsc7`：`hidesSftp = serial || plugin`，故 SSH / 本地 / Telnet 均有；
 * - `history`：排除 local / serial / plugin / telnet，仅 SSH；
 * - `encoding`：`!local && !mosh && !et && !plugin`，故 SSH / Telnet / 串口均有；
 * - `ymodem`：仅 serial（termX 以拖放 / 右键触发，工具栏无按钮）；
 * - `browser`：仅 ssh / mosh / local —— termX 已按用户要求删除该功能；
 * - `highlight` / `compose` / `search` / `sessionLog` / `scripts` / `terminalSettings`
 *   对所有类型可见。
 *
 * termX 的落地差异（不支持的能力直接不显示，而不是置灰）：
 * - SFTP / 端口转发依赖已建立的 SSH 会话（后端 SftpHandle），仅 SSH 显示；
 * - 系统监控与 OSC 7 追踪依赖 SSH exec 通道，仅 SSH 显示；
 * - 终端编码后端只接了 SSH / Telnet 的输入转码，串口编码固定在连接表单。
 */

export type TerminalKind = "ssh" | "pty" | "serial" | "telnet";
export type TerminalStatus = "connecting" | "connected" | "disconnected";

export interface ToolbarCapabilities {
  /** 左侧：命令历史（仅 SSH）。 */
  history: boolean;
  /** 左侧：系统监控（仅 SSH）。 */
  systemMonitor: boolean;
  /** 左侧：复制主机地址（本地终端没有远端主机）。 */
  copyHost: boolean;
  /** 右侧：SFTP（termX 仅 SSH 会话可开）。 */
  sftp: boolean;
  /** 右侧：端口转发（仅 SSH）。 */
  forward: boolean;
  /** 右侧：关键词高亮（所有类型）。 */
  highlight: boolean;
  /** 右侧：撰写栏（所有类型）。 */
  compose: boolean;
  /** 右侧：终端搜索（所有类型）。 */
  search: boolean;
  /** 右侧：手动会话日志（所有类型，后端四类都有文本日志槽）。 */
  sessionLog: boolean;
  /** 右侧：运行脚本（所有类型）。 */
  scripts: boolean;
  /** 更多菜单：命令历史（仅 SSH）。 */
  menuHistory: boolean;
  /** 更多菜单：目录追踪（仅 SSH）。 */
  menuOsc7: boolean;
  /** 更多菜单：终端设置（所有类型）。 */
  menuTerminalSettings: boolean;
  /** 更多菜单：脚本录制（所有类型）。 */
  menuRecording: boolean;
  /** 更多菜单：终端编码（SSH / Telnet）。 */
  menuEncoding: boolean;
}

export function deriveToolbarCapabilities(kind: TerminalKind): ToolbarCapabilities {
  const ssh = kind === "ssh";
  return {
    history: ssh,
    systemMonitor: ssh,
    copyHost: kind !== "pty",
    sftp: ssh,
    forward: ssh,
    highlight: true,
    compose: true,
    search: true,
    sessionLog: true,
    scripts: true,
    menuHistory: ssh,
    menuOsc7: ssh,
    menuTerminalSettings: true,
    menuRecording: true,
    menuEncoding: kind === "ssh" || kind === "telnet",
  };
}
