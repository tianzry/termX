// 会话日志 ANSI → span 的低依赖渲染器（阶段 B）。
//
// 只处理"看得懂的部分"：SGR 颜色 / 强调、`\r` 覆盖、退格忽略；其余 CSI
// （清屏、光标移动、私有模式等）整段丢弃，绝不把转义字符漏成乱码。
// 明确不做时间轴回放（changelogs 已留档），这是静态文本视图。

export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

/** 16 色终端调色板（VS Code 常用默认值）。 */
const PALETTE: string[] = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

/** SGR 参数 → 新样式（就地修改）。未知参数忽略；0 全重置。 */
function applySgr(style: Style, params: string): void {
  const codes = params.split(";").map((part) => {
    const n = Number(part);
    return part.trim() === "" || !Number.isFinite(n) ? 0 : n;
  });
  for (const code of codes) {
    if (code === 0) {
      delete style.fg;
      delete style.bg;
      style.bold = false;
      style.italic = false;
      style.underline = false;
      style.dim = false;
      style.inverse = false;
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.inverse = true;
    } else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) {
      style.italic = false;
    } else if (code === 24) {
      style.underline = false;
    } else if (code === 27) {
      style.inverse = false;
    } else if (code >= 30 && code <= 37) {
      style.fg = PALETTE[code - 30];
    } else if (code === 39) {
      delete style.fg;
    } else if (code >= 40 && code <= 47) {
      style.bg = PALETTE[code - 40];
    } else if (code === 49) {
      delete style.bg;
    } else if (code >= 90 && code <= 97) {
      style.fg = PALETTE[code - 90 + 8];
    } else if (code >= 100 && code <= 107) {
      style.bg = PALETTE[code - 100 + 8];
    }
  }
}

/**
 * 解析 ANSI 文本为带样式的 span 列表。
 *
 * `\r` 语义按终端"行内覆盖"处理：丢弃本行已累计的 span，但保留当前样式
 * （真实终端里 SGR 状态跨 CR 延续）。退格 `\b` 直接忽略。
 */
export function parseAnsi(input: string): AnsiSpan[] {
  // CRLF 是换行而不是"覆盖"：先归一，再让裸 \r 走行内覆盖逻辑。
  const text = input.replace(/\r\n/g, "\n");
  const spans: AnsiSpan[] = [];
  const style: Style = {};
  let buffer = "";
  /** 当前行在 spans 中的起点，`\r` 时回退到这里。 */
  let lineStart = 0;

  const flush = () => {
    if (!buffer) return;
    spans.push({
      text: buffer,
      fg: style.fg,
      bg: style.bg,
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
      dim: style.dim,
      inverse: style.inverse,
    });
    buffer = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "[") {
        // CSI：参数字节（0x30-0x3F）→ 中间字节（0x20-0x2F）→ 终止字节（0x40-0x7E）。
        let j = i + 2;
        while (j < text.length && /[0-9;?<=>]/.test(text[j])) j += 1;
        while (j < text.length && /[ -/]/.test(text[j])) j += 1;
        const final = text[j];
        if (final === "m") {
          flush();
          applySgr(style, text.slice(i + 2, j));
        }
        // 其余 CSI（清屏 / 光标 / 私有模式）整段丢弃。
        i = j < text.length ? j + 1 : text.length;
        continue;
      }
      if (next === "]") {
        // OSC：跳到 BEL 或 ST（ESC \），整段丢弃（标题 / 超链接等）。
        let j = i + 2;
        while (j < text.length) {
          if (text[j] === "\x07") {
            j += 1;
            break;
          }
          if (text[j] === "\x1b" && text[j + 1] === "\\") {
            j += 2;
            break;
          }
          j += 1;
        }
        i = j;
        continue;
      }
      // 其余两字节转义（如 ESC(B 字符集）：丢掉 ESC 与其后的一个字符。
      i += 2;
      continue;
    }

    if (ch === "\r") {
      // 行内覆盖：清掉本行已产出的 span 与未落盘的 buffer。
      spans.length = lineStart;
      buffer = "";
      i += 1;
      continue;
    }

    if (ch === "\n") {
      buffer += "\n";
      flush();
      lineStart = spans.length;
      i += 1;
      continue;
    }

    if (ch === "\b") {
      // 静态视图不支持光标后退；退格忽略（不显示乱码）。
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return spans;
}
