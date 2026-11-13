/**
 * 串口表单对照表（常量表驱动，纯逻辑，无 React / Tauri 依赖）。
 *
 * 依据 Netcatty `components/SerialConnectModal.tsx`（连接弹窗）与
 * `components/SerialHostDetailsPanel.tsx`（主机编辑面板）逐屏抄录：
 *
 * | # | 分组 | 字段 | 控件 | 默认值 | 文案 / 条件 |
 * |---|---|---|---|---|---|
 * | 1 | 串口 | 端口 | Combobox（可手输） | 首个枚举端口 | 标签「串口」；右上 ghost「刷新」；下方固定提示 namedPipeHint；非法端口红字 customPortPlaceholder |
 * | 2 | 串口 | 波特率 | Combobox（可手输） | 115200 | 命名管道时隐藏；非 12 档标准值提示 customBaudRate |
 * | 3 | 自动登录 | 用户名 / 密码 | Input / Input(password) | 空 | 仅主机编辑面板有；位置在波特率之后、高级之前（termX 无 host 模型，合并进本面板，见取舍） |
 * | 4 | 高级（默认收起） | 数据位 / 停止位 | Select ×2（2 列） | 8 / 1 | 命名管道时隐藏；1.5 停止位黄色警告 stopBits15Warning |
 * | 5 | 高级 | 校验位 | Select | none | 选项：无/偶/奇/Mark/Space |
 * | 6 | 高级 | 流控制 | Select | none | 选项：无 / XON/XOFF(软件) / RTS/CTS(硬件) |
 * | 7 | 高级 · 终端选项（分隔线） | 回退键 | Select | default | 默认（DEL 0x7F）/ Ctrl+H（BS 0x08）+ 说明 |
 * | 8 | 高级 · 终端选项 | 按字节退格 | 左标签+说明 / 右 checkbox | false | byteOrientedBackspace |
 * | 9 | 高级 · 终端选项 | 强制本地回显 | 左标签+说明 / 右 checkbox | false | localEcho |
 * | 10 | 高级 · 终端选项 | 行模式 | 左标签+说明 / 右 checkbox | false | lineMode |
 * | 11 | 高级 · 终端选项 | 字符编码 | Input（自由文本） | UTF-8 | 占位「字符集（例如 UTF-8）」 |
 * | 12 | 保存配置 | 保存为主机 + 名称 | 左标签+说明 / 右 checkbox + Input | 不勾选 / `Serial: <端口名>` | 仅 onSaveHost；termX 无 host 模型 → 本轮不复刻 |
 *
 * 按钮与禁用（Netcatty 弹窗 Footer）：`取消`(ghost) + 主按钮（连接 / 连接并保存），
 * `disabled = !(isPortValid && (isNamedPipe || isBaudRateValid))`。
 * termX 侧栏无取消入口，主按钮保持「打开串口」，禁用条件等价；命名管道因后端
 * crate 无法打开，termX 明确报错而不是假支持（见 serialPortError）。
 *
 * 桥接方法（Netcatty `window.netcatty`）→ termX 命令：
 * - `listSerialPorts()` → `serial_list_ports`
 * - `startSerialSession({...})` → `serial_open`（config 嵌套字段 snake_case）
 * - 写按键 → `serial_write`；`setDtr/setRts/sendBreak/close` 同名概念
 * - ymodem（`sendSerialYmodem` / `receiveSerialYmodem`）/ `serialEraseChar` 后端未实现，
 *   入口留待阶段 B 评估，不在本轮添加假按钮。
 */

import type { SerialConfig } from "../backend/client";
import {
  SERIAL_TERM_OPTS_DEFAULT,
  resolveSerialTermOpts,
  type SerialTermOpts,
} from "./serialStream";
import { BAUD_RATES, CHARSETS, isValidBaudRate, validatePortPath } from "./serialValidate";

export type SerialParity = "none" | "even" | "odd" | "mark" | "space";
/** Netcatty 取值；提交后端时映射为 none|software|hardware。 */
export type SerialFlowControl = "none" | "xon/xoff" | "rts/cts";
export type SerialBackspaceBehavior = "default" | "ctrl-h";

/** 表单值（camelCase，贴近 Netcatty SerialConfig；提交时转 snake_case）。 */
export interface SerialFormValues {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: SerialParity;
  flowControl: SerialFlowControl;
  localEcho: boolean;
  lineMode: boolean;
  backspaceBehavior: SerialBackspaceBehavior;
  byteOrientedBackspace: boolean;
  charset: string;
  /** 终端分组选项（XANY / 收发换行 / 慢速 / 输入输出模式），见 serialStream.ts。 */
  term: SerialTermOpts;
}

/** 默认值逐项对齐 Netcatty SerialConnectModal（字符集默认 UTF-8）。 */
export const SERIAL_FORM_DEFAULTS: SerialFormValues = {
  port: "",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
  localEcho: false,
  lineMode: false,
  backspaceBehavior: "default",
  byteOrientedBackspace: false,
  charset: "UTF-8",
  term: { ...SERIAL_TERM_OPTS_DEFAULT },
};

export const SERIAL_DATA_BITS: Array<5 | 6 | 7 | 8> = [5, 6, 7, 8];
export const SERIAL_STOP_BITS: Array<1 | 1.5 | 2> = [1, 1.5, 2];
export const SERIAL_PARITY_OPTIONS: Array<{ value: SerialParity; label: string }> = [
  { value: "none", label: "无" },
  { value: "even", label: "偶校验" },
  { value: "odd", label: "奇校验" },
  { value: "mark", label: "Mark" },
  { value: "space", label: "Space" },
];
export const SERIAL_FLOW_CONTROL_OPTIONS: Array<{
  value: SerialFlowControl;
  label: string;
}> = [
  { value: "none", label: "无" },
  { value: "xon/xoff", label: "XON/XOFF (软件)" },
  { value: "rts/cts", label: "RTS/CTS (硬件)" },
];
export const SERIAL_BACKSPACE_OPTIONS: Array<{
  value: SerialBackspaceBehavior;
  label: string;
}> = [
  { value: "default", label: "DEL (0x7f)" },
  { value: "ctrl-h", label: "BS (0x08)" },
];

/** 字符编码自由输入的可选建议（Netcatty 用纯文本框，这里用 datalist 保留可枚举性）。 */
export const SERIAL_CHARSET_SUGGESTIONS = CHARSETS.filter((c) => c !== "");

/** 界面文案（逐字取自 Netcatty zh-CN i18n）。 */
export const SERIAL_TEXT = {
  title: "连接串口",
  description: "配置串口连接参数",
  port: "串口",
  refresh: "刷新",
  selectPort: "选择串口...",
  noPorts: "未检测到串口设备。请连接设备后刷新。",
  namedPipeHint:
    "Windows 虚拟机控制台：输入 \\\\.\\pipe\\name。虚拟机需作为服务端创建管道，波特率和串口帧设置不生效。",
  customPortPlaceholder: "例如 /dev/ttys001 或 COM1",
  baudRate: "波特率",
  baudRatePlaceholder: "选择或输入波特率...",
  baudRateEmpty: "输入自定义波特率",
  customBaudRate: "使用自定义波特率",
  advanced: "高级",
  dataBits: "数据位",
  stopBits: "停止位",
  stopBits15Warning: "1.5 停止位在 Windows 下可能不被所有设备支持",
  parity: "校验位",
  flowControl: "流控制",
  backspaceBehavior: "退格键发送",
  backspaceBehaviorDesc: "如果网络设备不响应默认回退键，请改用 BS (0x08)。",
  byteOrientedBackspace: "按字节退格",
  byteOrientedBackspaceDesc:
    "发送与字符字节数相同的 DEL，使设备删除整个多字节字符（适用于按字节删除的设备）。若为逐字符删除的行编辑器（如 Linux readline），请关闭。",
  localEcho: "强制本地回显",
  localEchoDesc: "本地回显输入字符（用于没有远程回显的设备）",
  lineMode: "行模式",
  lineModeDesc: "缓冲输入，按回车后发送（而不是逐字符发送）",
  charset: "字符编码",
  charsetPlaceholder: "字符集（例如 UTF-8）",
  connect: "连接",
  autoLoginUsername: "自动登录用户名",
  autoLoginPassword: "密码",
  autoLoginUsernamePlaceholder: "留空则不启用",
  autoLoginPasswordPlaceholder: "可为空（空密码设备）",
  saveHost: "保存配置",
  saveHostDesc: "将此串口配置保存到主机列表以便快速访问",
  autoLog: "自动记录会话日志",
  autoLogDesc:
    "本次连接写入一份可打印纯文本 .log；目录与命名在「设置 → 终端 → 会话日志」。保存为主机后以主机面板的开关为准。",
  hostName: "配置名称",
  hostNamePlaceholder: "例如 Arduino Uno",
  connectAndSave: "连接并保存",
} as const;

/** 12 档常用波特率，可自定义任意正整数。 */
export const SERIAL_BAUD_RATES = BAUD_RATES;

/** Netcatty `isWindowsNamedPipePath`：`\\.\pipe\name` 或 `\\?\pipe\name`。 */
export function isWindowsNamedPipePath(value: string): boolean {
  return /^\\\\[.?]\\pipe\\[^\r\n\0]+$/i.test(value);
}

/** Netcatty `isSerialEndpointPath`：/dev/*、COMn、\\.\COMn、Windows 命名管道。 */
export function isSerialEndpointPath(value: string): boolean {
  return (
    value.startsWith("/dev/") ||
    /^COM\d+$/i.test(value) ||
    /^\\\\\.\\COM\d+$/i.test(value) ||
    isWindowsNamedPipePath(value)
  );
}

/** 非标准波特率提示条件（Netcatty：>0 且不在 12 档内）。 */
export function isCustomBaudRate(baudRate: number): boolean {
  return baudRate > 0 && !SERIAL_BAUD_RATES.includes(baudRate);
}

/**
 * 端口错误文案；空串 = 通过。
 * 与 Netcatty 的差异：命名管道在 Netcatty 由 Electron 桥接实现，termX 串口 crate
 * 无法打开，故明确报错（不假装可选）。
 */
export function serialPortError(port: string): string | undefined {
  const trimmed = port.trim();
  if (!trimmed) return "请选择或输入串口";
  return validatePortPath(trimmed) || undefined;
}

/** 表单字段错误：port / baudRate 两处，供 UI 红字与禁用条件共用。 */
export interface SerialFormErrors {
  port?: string;
  baudRate?: string;
}

export function serialFormErrors(values: SerialFormValues): SerialFormErrors {
  const errors: SerialFormErrors = {};
  const portError = serialPortError(values.port);
  if (portError) errors.port = portError;
  if (!isValidBaudRate(String(values.baudRate))) {
    errors.baudRate = "波特率必须是正整数";
  }
  return errors;
}

/** 主按钮禁用条件：Netcatty `!(isPortValid && (isNamedPipe || isBaudRateValid))`，termX 无命名管道支持。 */
export function isSerialConnectDisabled(values: SerialFormValues): boolean {
  if (isWindowsNamedPipePath(values.port.trim())) return true;
  return Boolean(serialPortError(values.port)) || !isValidBaudRate(String(values.baudRate));
}

/** 默认值合并：缺字段回落到 Netcatty 默认值，非法枚举回落到默认项。 */
export function resolveSerialForm(
  saved?: Partial<SerialFormValues> | null,
): SerialFormValues {
  const merged: SerialFormValues = { ...SERIAL_FORM_DEFAULTS, ...(saved ?? {}) };
  if (!SERIAL_DATA_BITS.includes(merged.dataBits)) {
    merged.dataBits = SERIAL_FORM_DEFAULTS.dataBits;
  }
  if (!SERIAL_STOP_BITS.includes(merged.stopBits)) {
    merged.stopBits = SERIAL_FORM_DEFAULTS.stopBits;
  }
  if (!SERIAL_PARITY_OPTIONS.some((o) => o.value === merged.parity)) {
    merged.parity = SERIAL_FORM_DEFAULTS.parity;
  }
  if (!SERIAL_FLOW_CONTROL_OPTIONS.some((o) => o.value === merged.flowControl)) {
    merged.flowControl = SERIAL_FORM_DEFAULTS.flowControl;
  }
  if (merged.backspaceBehavior !== "ctrl-h") {
    merged.backspaceBehavior = "default";
  }
  if (!merged.charset) merged.charset = SERIAL_FORM_DEFAULTS.charset;
  merged.term = resolveSerialTermOpts(merged.term);
  // 输入模式与 lineMode 同源：行模式 = 缓冲输入，其余逐字符。
  merged.lineMode = merged.term.input_mode === "line";
  return merged;
}

/** 串口主机档案快照（Profile 的 serial_* 列），写入时由表单生成。 */
export interface SerialProfileSnapshot {
  serial_port: string;
  serial_baud: number;
  serial_data_bits: number;
  serial_parity: string;
  serial_stop_bits: number;
  serial_flow: string;
  serial_local_echo: boolean;
  serial_line_mode: boolean;
  serial_backspace: string;
  serial_byte_backspace: boolean;
  serial_charset: string;
  serial_term_opts: SerialTermOpts | null;
}

/** 表单 → Profile 串口列（flow / backspace 存界面取值，连接时再映射后端）。 */
export function serialProfileSnapshot(
  values: SerialFormValues,
): SerialProfileSnapshot {
  return {
    serial_port: values.port.trim(),
    serial_baud: values.baudRate,
    serial_data_bits: values.dataBits,
    serial_parity: values.parity,
    serial_stop_bits: values.stopBits,
    serial_flow: values.flowControl,
    serial_local_echo: values.localEcho,
    serial_line_mode: values.lineMode,
    serial_backspace: values.backspaceBehavior,
    serial_byte_backspace: values.byteOrientedBackspace,
    serial_charset: values.charset.trim(),
    serial_term_opts: { ...values.term },
  };
}

/** Profile 串口列（或旧库 NULL）→ 表单值；缺省项回落到 SERIAL_FORM_DEFAULTS。 */
export function serialFormFromProfile(
  profile: SerialProfileSnapshotLike & { host?: string },
): SerialFormValues {
  const saved: Partial<SerialFormValues> = {};
  const port = profile.serial_port ?? profile.host ?? "";
  if (port) saved.port = port;
  if (typeof profile.serial_baud === "number") saved.baudRate = profile.serial_baud;
  if (SERIAL_DATA_BITS.includes(profile.serial_data_bits as 5 | 6 | 7 | 8)) {
    saved.dataBits = profile.serial_data_bits as 5 | 6 | 7 | 8;
  }
  if (SERIAL_STOP_BITS.includes(profile.serial_stop_bits as 1 | 1.5 | 2)) {
    saved.stopBits = profile.serial_stop_bits as 1 | 1.5 | 2;
  }
  if (SERIAL_PARITY_OPTIONS.some((o) => o.value === profile.serial_parity)) {
    saved.parity = profile.serial_parity as SerialParity;
  }
  if (SERIAL_FLOW_CONTROL_OPTIONS.some((o) => o.value === profile.serial_flow)) {
    saved.flowControl = profile.serial_flow as SerialFlowControl;
  }
  if (typeof profile.serial_local_echo === "boolean") {
    saved.localEcho = profile.serial_local_echo;
  }
  if (typeof profile.serial_line_mode === "boolean") {
    saved.lineMode = profile.serial_line_mode;
  }
  if (profile.serial_backspace === "ctrl-h") {
    saved.backspaceBehavior = "ctrl-h";
  }
  if (typeof profile.serial_byte_backspace === "boolean") {
    saved.byteOrientedBackspace = profile.serial_byte_backspace;
  }
  // 老档案没有 serial_term_opts 列的值：serial_line_mode=true 等价行模式。
  if (!profile.serial_term_opts && profile.serial_line_mode === true) {
    saved.term = { ...SERIAL_TERM_OPTS_DEFAULT, input_mode: "line" };
  }
  if (profile.serial_charset) saved.charset = profile.serial_charset;
  if (profile.serial_term_opts) saved.term = profile.serial_term_opts;
  return resolveSerialForm(saved);
}

/** Profile 串口列的宽松输入（后端返回 number / boolean，旧库可能为 null）。 */
export interface SerialProfileSnapshotLike {
  serial_port?: string | null;
  serial_baud?: number | null;
  serial_data_bits?: number | null;
  serial_parity?: string | null;
  serial_stop_bits?: number | null;
  serial_flow?: string | null;
  serial_local_echo?: boolean | null;
  serial_line_mode?: boolean | null;
  serial_backspace?: string | null;
  serial_byte_backspace?: boolean | null;
  serial_charset?: string | null;
  serial_term_opts?: SerialTermOpts | null;
}

/** Netcatty 流控取值 → termX 后端取值。 */
export function serialFlowControlToBackend(
  value: SerialFlowControl,
): "none" | "software" | "hardware" {
  if (value === "xon/xoff") return "software";
  if (value === "rts/cts") return "hardware";
  return "none";
}

/** 端口显示名：取路径末段（`/dev/ttyUSB0` → `ttyUSB0`，`COM3` → `COM3`）。 */
export function serialPortDisplayName(port: string): string {
  const trimmed = port.trim();
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

/**
 * 表单 → 后端 SerialConfig（嵌套字段 snake_case，见 R3）。
 * 自动登录任一非空即带上；空密码是有效的串口凭据。
 */
export function toSerialConfig(
  values: SerialFormValues,
  autoLogin?: { username?: string; password?: string },
): SerialConfig {
  const username = autoLogin?.username?.trim() ?? "";
  const password = autoLogin?.password ?? "";
  const config: SerialConfig = {
    baud_rate: values.baudRate,
    data_bits: values.dataBits,
    parity: values.parity,
    stop_bits: values.stopBits,
    flow_control: serialFlowControlToBackend(values.flowControl),
    charset: values.charset.trim(),
    xany: values.term.xany,
  };
  if (username !== "" || password !== "") {
    config.username = username;
    config.password = password;
  }
  return config;
}
