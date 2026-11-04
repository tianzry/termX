/**
 * SSH 输入兼容模式（逐字发送），对齐 Netcatty `Host.sshInputCompatibility`
 * 与 `docs/ssh-input-compatibility.md` 的四条规则：
 * 1. 多码点的 IME 文本 / 普通短粘贴按 Unicode 码点拆成多次写入；
 * 2. 明文粘贴超过 32 个码点、bracketed paste、确认分行粘贴保持原传输行为；
 * 3. 终端控制序列（CSI / OSC / SS3 / 单字符 ESC 序列）必须成组发送，
 *    否则拆开后会被远端解析成乱码（例如方向键 ESC [ A 拆成三段）；
 * 4. Unicode 码点保持原字节顺序（组合符、emoji 序列各自按码点拆分）。
 *
 * 纯函数、无副作用：TerminalPane 按主机快照决定是否启用本拆分。
 */

const ESC = 0x1b;
const BEL = 0x07;
/** 明文短粘贴的码点阈值：超过该长度保留一次性写（长粘贴不逐字发）。 */
export const COMPATIBLE_WRITE_CODE_POINT_LIMIT = 32;
/** CSI 序列的终止字节区间（ECMA-48：0x40–0x7e）。 */
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

/**
 * 老数据（null / undefined）SSH 主机视为开启（对齐 Netcatty sanitizeHost
 * 把缺失字段迁移成 true）；显式 false 保持标准模式。
 */
export function resolveInputCompatibility(
  value: boolean | null | undefined,
): boolean {
  return value ?? true;
}

/**
 * 把一次 xterm onData 的文本按兼容模式规则拆成多次写入的 chunk。
 * 返回空数组表示没有可写内容；`[data]` 表示保留原一次性传输行为。
 */
export function splitCompatibleWrites(data: string): string[] {
  if (data.length === 0) return [];
  // bracketed paste：远端按整段粘贴解析，拆开反而破坏协议边界。
  if (data.includes("\x1b[200~")) return [data];

  const codePoints = Array.from(data);
  // 长粘贴 / 大块输入保留原传输行为，避免把一次按键放大成上千次 IPC。
  if (codePoints.length > COMPATIBLE_WRITE_CODE_POINT_LIMIT) return [data];

  const chunks: string[] = [];
  let i = 0;
  while (i < codePoints.length) {
    const cp = codePoints[i];
    if (cp.charCodeAt(0) !== ESC) {
      // 普通字符（含中文、单个 emoji 码点）各自一段。
      chunks.push(cp);
      i += 1;
      continue;
    }

    const kind = codePoints[i + 1];
    if (kind === undefined) {
      chunks.push(cp);
      i += 1;
      continue;
    }

    if (kind === "[") {
      // CSI：ESC [ ... 终止字节（0x40–0x7e），整体一段。
      const end = scanCsiFinal(codePoints, i + 2);
      chunks.push(codePoints.slice(i, end).join(""));
      i = end;
      continue;
    }

    if (kind === "O") {
      // SS3：ESC O x，终止规则同 CSI。
      const end = scanCsiFinal(codePoints, i + 2);
      chunks.push(codePoints.slice(i, end).join(""));
      i = end;
      continue;
    }

    if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
      // OSC / DCS / APC / PM：读到 BEL 或 ST（ESC \）为止，含终止符。
      const end = scanStringTerminator(codePoints, i + 2);
      chunks.push(codePoints.slice(i, end).join(""));
      i = end;
      continue;
    }

    // 其余 ESC 序列（如 ESC 7 / ESC c）固定两个码点成组。
    chunks.push(cp + kind);
    i += 2;
  }
  return chunks;
}

/** 从 start 起找到 CSI/SS3 的终止字节（0x40–0x7e），返回区间右边界（不含）。 */
function scanCsiFinal(codePoints: string[], start: number): number {
  for (let j = start; j < codePoints.length; j += 1) {
    const code = codePoints[j].charCodeAt(0);
    if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) return j + 1;
  }
  // 未终止的序列：剩余部分原样作为一段，不丢弃。
  return codePoints.length;
}

/** 从 start 起找到 BEL 或 ESC \ 终止的字符串序列，返回区间右边界（含终止符）。 */
function scanStringTerminator(codePoints: string[], start: number): number {
  for (let j = start; j < codePoints.length; j += 1) {
    const code = codePoints[j].charCodeAt(0);
    if (code === BEL) return j + 1;
    if (code === ESC && codePoints[j + 1] === "\\") return j + 2;
  }
  return codePoints.length;
}
