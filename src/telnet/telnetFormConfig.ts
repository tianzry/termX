/**
 * Telnet 连接弹窗的字段常量与纯函数（对照 Netcatty 的 Telnet 协议连接流程）。
 *
 * Netcatty 没有独立的 Telnet 弹窗：Telnet 是 host 的协议之一，走
 * QuickConnectWizard（模态）的协议卡片 → 用户名 → 认证三步。termX 保留
 * 独立「Telnet」入口，单步弹窗的壳与串口弹窗一致；字段只保留后端
 * `telnet_open` 支持的 host / port / 换行风格（凭据走终端内交互登录）。
 */

import type { TelnetSessionConfig } from "../workspaceModel";

export type TelnetNewline = TelnetSessionConfig["inputNewline"];

export interface TelnetFormValues {
  host: string;
  port: string;
  inputNewline: TelnetNewline;
}

export const TELNET_TEXT = {
  title: "连接 Telnet",
  description: "配置 Telnet 连接参数",
  host: "主机",
  hostPlaceholder: "主机名或 IP 地址",
  port: "端口",
  portPlaceholder: "23",
  advanced: "高级",
  newline: "换行风格",
  newlineDesc: "发送回车时使用的行结束符（Telnet NVT 默认 CRLF）。",
  cancel: "取消",
  connect: "连接",
} as const;

export const TELNET_NEWLINE_OPTIONS: ReadonlyArray<{
  value: TelnetNewline;
  label: string;
}> = [
  { value: "crlf", label: "CRLF（默认）" },
  { value: "lf", label: "LF" },
  { value: "cr", label: "CR" },
];

export const TELNET_DEFAULT_PORT = 23;

/** 弹窗初始值（端口默认 23，与 Netcatty Telnet 卡片一致）。 */
export function resolveTelnetForm(
  host = "",
  port: number = TELNET_DEFAULT_PORT,
): TelnetFormValues {
  return { host, port: String(port), inputNewline: "crlf" };
}

export function telnetFormErrors(values: TelnetFormValues): {
  host?: string;
  port?: string;
} {
  const errors: { host?: string; port?: string } = {};
  if (!values.host.trim()) errors.host = "请填写主机";
  const portText = values.port.trim();
  if (!portText) {
    errors.port = "请填写端口";
  } else if (!/^\d+$/.test(portText)) {
    errors.port = "端口必须是整数";
  } else {
    const port = Number(portText);
    if (port < 1 || port > 65535) errors.port = "端口范围 1–65535";
  }
  return errors;
}

export function isTelnetConnectDisabled(values: TelnetFormValues): boolean {
  const errors = telnetFormErrors(values);
  return Boolean(errors.host || errors.port);
}

export function toTelnetSession(values: TelnetFormValues): TelnetSessionConfig {
  return {
    host: values.host.trim(),
    port: Number(values.port.trim()),
    inputNewline: values.inputNewline,
  };
}
