/**
 * 串口参数选项与校验（纯逻辑，无 DOM / Tauri 依赖，vitest 覆盖）。
 * 选项集对齐 Netcatty SerialConnectModal：12 档常用波特率 + 自定义正整数、
 * 数据位 5-8、停止位 1/1.5/2、校验含 mark/space、字符集默认透传。
 */

/** 常用波特率（12 档）；也允许自定义任意正整数。 */
export const BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800,
  921600,
];

/**
 * 后端接受的字符集标签（encoding_rs / WHATWG 标签）。
 * 空串 = 字节透传（默认，二进制安全）。注意 WHATWG 规范中 "iso-8859-1"
 * 标签实际映射到 windows-1252，故列表直接用 windows-1252 避免误导。
 */
export const CHARSETS = [
  "",
  "UTF-8",
  "GBK",
  "GB18030",
  "Big5",
  "windows-1252",
  "windows-1251",
  "IBM866",
  "KOI8-R",
  "Shift_JIS",
  "EUC-JP",
  "ISO-2022-JP",
  "EUC-KR",
  "UTF-16LE",
  "UTF-16BE",
];

/** 波特率必须是正整数（自定义档）。 */
export function isValidBaudRate(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

/**
 * 校验手动输入的端口路径；返回中文错误，空串 = 通过。
 * 接受 COMn / \\\\.\\COMn / /dev/*；命名管道明确拒绝（crate 打不开，
 * 不做假功能）。
 */
export function validatePortPath(path: string): string {
  const p = path.trim();
  if (!p) return "请输入串口路径";
  if (/^COM\d+$/i.test(p)) return "";
  if (/^\\\\\.\\COM\d+$/i.test(p)) return "";
  if (/^\/dev\/\S+$/.test(p)) return "";
  if (/^\\\\\.\\pipe\\/i.test(p)) {
    return "不支持命名管道：串口驱动无法打开该路径";
  }
  return "无法识别的串口路径（支持 COMn、\\\\.\\COMn、/dev/*）";
}
