// Snippets 导入导出（P0 #5 阶段 B）。
// 格式对齐 Netcatty `domain/snippetTransfer.ts`：kind="netcatty.snippets"，
// version 1/2/3 均可导入，导出写 3；条目用 label（termX 内部字段名 name）。
// 仅迁移 termX 已支持的字段（targets / trigger / language 等留档不导入）。
// 纯逻辑、无 IO；单测见 snippetsTransfer.test.ts。
import type { Snippet } from "../backend/client";
import { normalizeLineEndings } from "./snippetsModel";

export const SNIPPET_EXPORT_KIND = "netcatty.snippets" as const;
export const SNIPPET_EXPORT_VERSION = 3 as const;

export type SnippetImportConflictAction = "skip" | "overwrite";

export type SnippetExportItem = {
  label: string;
  command: string;
  tags?: string[];
  package?: string;
  shortkey?: string;
  noAutoRun?: boolean;
  multiLineRunMode?: "paste" | "lineDelay";
  kind?: "snippet" | "script";
  description?: string;
};

export type SnippetExportPayload = {
  kind: typeof SNIPPET_EXPORT_KIND;
  version: number;
  exportedAt: string;
  snippetPackages: string[];
  snippets: SnippetExportItem[];
};

export type SnippetImportStats = {
  imported: number;
  overwritten: number;
  skipped: number;
  conflicts: number;
};

export type SnippetImportMergeResult = {
  snippets: Snippet[];
  stats: SnippetImportStats;
};

const ACCEPTED_VERSIONS = [1, 2, 3];

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 去重 + 去空白，忽略非字符串项。 */
function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

const toExportItem = (s: Snippet): SnippetExportItem => ({
  label: s.name,
  command: s.command,
  tags: [...s.tags],
  package: s.package,
  ...(s.shortkey ? { shortkey: s.shortkey } : {}),
  ...(s.no_auto_run ? { noAutoRun: true } : {}),
  ...(s.multi_line_run_mode === "paste" || s.multi_line_run_mode === "lineDelay"
    ? { multiLineRunMode: s.multi_line_run_mode }
    : {}),
  ...(s.kind === "script" ? { kind: "script" as const } : {}),
  ...(s.description ? { description: s.description } : {}),
});

export function buildSnippetExportPayload(
  snippets: Snippet[],
  exportedAt = new Date().toISOString(),
): SnippetExportPayload {
  return {
    kind: SNIPPET_EXPORT_KIND,
    version: SNIPPET_EXPORT_VERSION,
    exportedAt,
    snippetPackages: collectPackages(snippets.map((s) => s.package)),
    snippets: snippets.map(toExportItem),
  };
}

/** 分组路径（含父级，如 "ops/db" → ["ops", "ops/db"]），字母序去重。 */
export function collectPackages(packages: string[]): string[] {
  const out = new Set<string>();
  for (const raw of packages) {
    const path = raw.trim();
    if (!path) continue;
    const parts = path.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      out.add(acc);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

const fallbackLabel = (command: string): string => {
  const first = normalizeLineEndings(command).split("\n").find((l) => l.trim());
  return first?.trim().slice(0, 80) || "未命名片段";
};

/** 单条导入项校验：command 必须非空字符串；其余字段宽松回落。 */
function sanitizeImportItem(value: unknown): SnippetExportItem | null {
  if (!isObjectRecord(value)) return null;
  if (typeof value.command !== "string" || !value.command.trim()) return null;
  const label =
    typeof value.label === "string" && value.label.trim()
      ? value.label.trim()
      : fallbackLabel(value.command);
  const shortkey = typeof value.shortkey === "string" ? value.shortkey.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const packagePath = typeof value.package === "string" ? value.package.trim() : "";
  return {
    label,
    command: value.command,
    tags: Array.isArray(value.tags) ? uniqueStrings(value.tags) : [],
    package: packagePath,
    ...(shortkey ? { shortkey } : {}),
    ...(value.noAutoRun === true ? { noAutoRun: true } : {}),
    ...(value.multiLineRunMode === "lineDelay" || value.multiLineRunMode === "paste"
      ? { multiLineRunMode: value.multiLineRunMode }
      : {}),
    ...(value.kind === "script" ? { kind: "script" as const } : {}),
    ...(description ? { description } : {}),
  };
}

function parsePayloadObject(parsed: Record<string, unknown>): SnippetExportPayload {
  if (parsed.kind !== SNIPPET_EXPORT_KIND) {
    throw new Error("不支持的文件格式：缺少 netcatty.snippets 标识");
  }
  const version = parsed.version;
  if (typeof version !== "number" || !ACCEPTED_VERSIONS.includes(version)) {
    throw new Error(`不支持的导入版本：${String(version)}（支持 1~3）`);
  }
  if (!Array.isArray(parsed.snippets)) {
    throw new Error("导入文件没有 snippets 列表");
  }
  const snippets = parsed.snippets
    .map(sanitizeImportItem)
    .filter((item): item is SnippetExportItem => Boolean(item));
  const declared = Array.isArray(parsed.snippetPackages)
    ? uniqueStrings(parsed.snippetPackages)
    : [];
  return {
    kind: SNIPPET_EXPORT_KIND,
    version,
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
    snippetPackages: collectPackages([
      ...declared,
      ...snippets.map((s) => s.package || ""),
    ]),
    snippets,
  };
}

/**
 * 解析导入文本。支持三种输入（对齐 Netcatty）：
 * - 完整导出对象；
 * - 条目数组（旧格式 / 手写）；
 * - 多个导出对象组成的数组（多文件合并）。
 */
export function parseSnippetImportPayload(jsonString: string): SnippetExportPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error("文件不是合法 JSON");
  }

  if (Array.isArray(parsed)) {
    const nested = parsed.filter(isObjectRecord).filter((i) => Array.isArray(i.snippets));
    if (nested.length > 0 && nested.length === parsed.length) {
      const payloads = nested.map(parsePayloadObject);
      const snippets = payloads.flatMap((p) => p.snippets);
      return {
        kind: SNIPPET_EXPORT_KIND,
        version: SNIPPET_EXPORT_VERSION,
        exportedAt: "",
        snippetPackages: collectPackages([
          ...payloads.flatMap((p) => p.snippetPackages),
          ...snippets.map((s) => s.package || ""),
        ]),
        snippets,
      };
    }
    const snippets = parsed
      .map(sanitizeImportItem)
      .filter((item): item is SnippetExportItem => Boolean(item));
    if (snippets.length === 0) throw new Error("导入文件没有可用的片段");
    return {
      kind: SNIPPET_EXPORT_KIND,
      version: SNIPPET_EXPORT_VERSION,
      exportedAt: "",
      snippetPackages: collectPackages(snippets.map((s) => s.package || "")),
      snippets,
    };
  }

  if (!isObjectRecord(parsed)) throw new Error("文件内容不是片段导出格式");
  return parsePayloadObject(parsed);
}

function toImportedSnippet(item: SnippetExportItem, id: string): Snippet {
  return {
    id,
    name: item.label,
    command: item.command,
    description: item.description ?? "",
    package: item.package ?? "",
    tags: item.tags ?? [],
    shortkey: item.shortkey ?? "",
    no_auto_run: item.noAutoRun === true,
    kind: item.kind === "script" ? "script" : "",
    multi_line_run_mode: item.multiLineRunMode === "lineDelay" ? "lineDelay" : "",
  };
}

/**
 * 合并导入。冲突按 command 判定（对齐 Netcatty mergeSnippetImportPayload）：
 * skip = 保留本地，overwrite = 用导入项覆盖但仍沿用本地 id。
 */
export function mergeSnippetImport({
  existing,
  payload,
  conflictAction,
  createId,
}: {
  existing: Snippet[];
  payload: SnippetExportPayload;
  conflictAction: SnippetImportConflictAction;
  createId: () => string;
}): SnippetImportMergeResult {
  const next = [...existing];
  const commandToIndex = new Map<string, number>();
  next.forEach((s, i) => {
    if (!commandToIndex.has(s.command)) commandToIndex.set(s.command, i);
  });

  const stats: SnippetImportStats = {
    imported: 0,
    overwritten: 0,
    skipped: 0,
    conflicts: 0,
  };

  for (const item of payload.snippets) {
    const idx = commandToIndex.get(item.command);
    if (idx !== undefined) {
      stats.conflicts += 1;
      if (conflictAction === "skip") {
        stats.skipped += 1;
        continue;
      }
      const local = next[idx];
      next[idx] = toImportedSnippet(item, local.id);
      stats.overwritten += 1;
      continue;
    }
    const imported = toImportedSnippet(item, createId());
    commandToIndex.set(imported.command, next.length);
    next.push(imported);
    stats.imported += 1;
  }

  return { snippets: next, stats };
}

/** 导入结果提示文案（统一出口，便于测试）。 */
export function describeImportStats(stats: SnippetImportStats): string {
  const parts = [`新增 ${stats.imported}`];
  if (stats.overwritten) parts.push(`覆盖 ${stats.overwritten}`);
  if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
  return parts.join("，");
}
