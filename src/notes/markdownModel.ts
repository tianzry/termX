/**
 * Notes 阶段 B：低依赖 Markdown 预览 + 格式工具栏（纯逻辑）。
 *
 * 对照 Netcatty `components/notes/NoteToolbar.tsx` / `InlineMarkdownEditor.tsx`：
 * Netcatty 用 MDXEditor 做所见即所得（live / source / preview 三模式），
 * termX 明确不引入重依赖，改为「Markdown 原文 textarea + 预览切换 + 最小工具栏」，
 * 支持 Netcatty 笔记里实际用到的语法：标题 / 加粗 / 斜体 / 代码 / 链接 /
 * 无序列表 / 有序列表 / 引用 / 代码块 / 分隔线。
 *
 * 预览按块 + 行内 token 渲染为 React 元素（不走 dangerouslySetInnerHTML），
 * 笔记正文完全由用户输入，避免 XSS 面。
 */

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "hr" };

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

/** 行内语法：加粗 > 斜体 > 代码 > 链接（顺序决定匹配优先级）。 */
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) {
      tokens.push({ type: "text", text: text.slice(last, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith("**")) {
      tokens.push({ type: "bold", text: raw.slice(2, -2) });
    } else if (raw.startsWith("`")) {
      tokens.push({ type: "code", text: raw.slice(1, -1) });
    } else if (raw.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw);
      if (link) tokens.push({ type: "link", text: link[1], href: link[2] });
      else tokens.push({ type: "text", text: raw });
    } else {
      tokens.push({ type: "italic", text: raw.slice(1, -1) });
    }
    last = match.index + raw.length;
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) });
  return tokens.length ? tokens : [{ type: "text", text }];
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*(#{1,3})\s+/.test(line) ||
    /^\s*---+\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*```/.test(line)
  );
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过闭合围栏
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: body.join(" ").trim() });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const ordered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || ordered.test(line)) {
      const orderedList = ordered.test(line);
      const re = orderedList ? ordered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(re.exec(lines[i])![1].trim());
        i += 1;
      }
      blocks.push({ type: "list", ordered: orderedList, items });
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      body.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", text: body.join(" ") });
  }
  return blocks;
}

export type MarkdownAction =
  | "h1"
  | "h2"
  | "h3"
  | "bold"
  | "italic"
  | "bullet"
  | "ordered"
  | "quote"
  | "code";

export interface MarkdownEditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  let to = text.indexOf("\n", end);
  if (to === -1) to = text.length;
  return [from, to];
}

/** 在选区内加/去行首前缀；已带同类前缀的行视为取消。 */
function toggleLinePrefix(
  text: string,
  start: number,
  end: number,
  prefix: string,
  strip: RegExp,
): MarkdownEditResult {
  const [from, to] = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const allPrefixed = lines.every((line) => strip.test(line));
  const next = lines
    .map((line) => (allPrefixed ? line.replace(strip, "") : `${prefix}${line.replace(strip, "")}`))
    .join("\n");
  return {
    text: text.slice(0, from) + next + text.slice(to),
    selectionStart: from + next.length,
    selectionEnd: from + next.length,
  };
}

/** 标题：先剥掉已有 1–3 级前缀再套目标级别（再次点击同级不会误删标题）。 */
function setHeadingLevel(
  text: string,
  start: number,
  end: number,
  prefix: string,
): MarkdownEditResult {
  const [from, to] = lineRange(text, start, end);
  const next = text
    .slice(from, to)
    .split("\n")
    .map((line) => `${prefix}${line.replace(/^#{1,3}\s+/, "")}`)
    .join("\n");
  return {
    text: text.slice(0, from) + next + text.slice(to),
    selectionStart: from + next.length,
    selectionEnd: from + next.length,
  };
}

/**
 * 工具栏动作：返回新正文与光标位置。
 * 选区为空时插入占位词，方便用户直接输入；有选区时包裹或逐行加前缀。
 */
export function applyMarkdownAction(
  text: string,
  start: number,
  end: number,
  action: MarkdownAction,
): MarkdownEditResult {
  const selection = text.slice(start, end);
  const wrap = (left: string, right: string, placeholder: string): MarkdownEditResult => {
    const body = selection || placeholder;
    return {
      text: text.slice(0, start) + left + body + right + text.slice(end),
      selectionStart: start + left.length,
      selectionEnd: start + left.length + body.length,
    };
  };

  switch (action) {
    case "bold":
      return wrap("**", "**", "加粗文本");
    case "italic":
      return wrap("*", "*", "斜体文本");
    case "code":
      return selection.includes("\n")
        ? wrap("```\n", "\n```", "代码")
        : wrap("`", "`", "代码");
    case "h1":
      return setHeadingLevel(text, start, end, "# ");
    case "h2":
      return setHeadingLevel(text, start, end, "## ");
    case "h3":
      return setHeadingLevel(text, start, end, "### ");
    case "bullet":
      return toggleLinePrefix(text, start, end, "- ", /^\s*[-*+]\s+/);
    case "ordered":
      return toggleLinePrefix(text, start, end, "1. ", /^\s*\d+[.)]\s+/);
    case "quote":
      return toggleLinePrefix(text, start, end, "> ", /^\s*>\s?/);
    default:
      return { text, selectionStart: start, selectionEnd: end };
  }
}

/** 在光标处插入 Markdown 链接（用于「插入主机链接」）。 */
export function insertMarkdownLink(
  text: string,
  start: number,
  end: number,
  label: string,
  href: string,
): MarkdownEditResult {
  const link = `[${label}](${href})`;
  const body = text.slice(start, end);
  const next = body ? `${link} ${body}` : link;
  return {
    text: text.slice(0, start) + next + text.slice(end),
    selectionStart: start + next.length,
    selectionEnd: start + next.length,
  };
}

// ── 导入 / 导出（对齐 Netcatty domain/notes.ts 的导出命名与导入取标题规则）──

const UNSAFE_FILENAME = /[<>:"/\\|?*]/g;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const CONTROL_CHARS = /[\u0000-\u001f]/g;

/** 导出文件名：去掉非法字符 / 控制符 / 结尾点号，保留 Windows 保留名保护。 */
export function sanitizeNoteFileName(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "")
    .replace(CONTROL_CHARS, "-")
    .replace(UNSAFE_FILENAME, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  const dot = safe.indexOf(".");
  const stem = (dot >= 0 ? safe.slice(0, dot) : safe).trimEnd();
  const ext = dot >= 0 ? safe.slice(dot) : "";
  const fixed = RESERVED_WINDOWS_NAMES.test(stem) ? `${stem}_${ext}` : safe;
  return fixed.slice(0, 120) || fallback;
}

/**
 * 导入标题：显式 `title:` frontmatter > 首个 `# 标题` > 文件名（去扩展名）。
 * 与 Netcatty `deriveNoteImportTitle` 同序。
 */
export function deriveImportedTitle(fileName: string, content: string): string {
  const frontmatter = /^\s*---\s*\n([\s\S]*?)\n---/.exec(content);
  const explicit = frontmatter
    ? /^\s*title\s*:\s*(.+)$/m.exec(frontmatter[1])?.[1]
    : undefined;
  if (explicit?.trim()) return explicit.trim().replace(/^["']|["']$/g, "");

  const heading = /^\s*#\s+(.+)$/m.exec(content)?.[1];
  if (heading?.trim()) return heading.trim();

  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.(md|markdown|txt)$/i, "").trim() || "导入的笔记";
}

/** 「全部导出」时每条笔记的相对路径：`<group>/<title>.md`，重名自动加 -2。 */
export function buildNoteExportFiles(
  notes: { title: string; group: string | null; content: string }[],
): { path: string; content: string }[] {
  const used = new Set<string>();
  return notes.map((note, index) => {
    const base = sanitizeNoteFileName(note.title, `note-${index + 1}`);
    const dir = (note.group ?? "")
      .split("/")
      .filter(Boolean)
      .map((part) => sanitizeNoteFileName(part, "folder"))
      .join("/");
    let path = `${dir ? `${dir}/` : ""}${base}.md`;
    let suffix = 2;
    while (used.has(path.toLowerCase())) {
      path = `${dir ? `${dir}/` : ""}${base}-${suffix}.md`;
      suffix += 1;
    }
    used.add(path.toLowerCase());
    return { path, content: note.content };
  });
}
