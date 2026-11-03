/**
 * 内置编辑器纯逻辑（阶段 A）：可编辑性判定（扩展名 + 字节采样）、
 * 编码解码（BOM 探测 + UTF-8 严格解码 + gb18030 回退，对齐 Netcatty
 * lib/readTextFile.ts）、尺寸上限。组件在 src/editor/EditorDialog.tsx。
 */

/** 内置编辑器文件大小上限：10 MiB（对齐 Netcatty MAX_BUILTIN_SFTP_EDITOR_BYTES）。 */
export const MAX_EDITOR_BYTES = 10 * 1024 * 1024;

/** NUL 采样窗口：头部 8 KiB 内出现 0x00 即判二进制。 */
const BINARY_SAMPLE_WINDOW = 8192;

/**
 * 常见二进制扩展名（入口过滤，对齐 Netcatty isKnownBinaryFile 的语义；
 * 清单为通用事实性数据，独立维护）。
 */
const BINARY_EXTENSIONS = new Set([
  // 图片
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "psd", "svgz",
  // 压缩 / 归档
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "lz4",
  // 可执行 / 目标
  "exe", "dll", "so", "dylib", "o", "a", "obj", "class", "wasm", "bin", "msi",
  // 媒体
  "mp3", "mp4", "avi", "mkv", "mov", "wmv", "flac", "wav", "ogg", "webm",
  // 文档 / 字体
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "ttf", "otf", "woff", "woff2", "eot",
  // 数据库 / 容器
  "db", "sqlite", "sqlite3", "iso", "img", "dmg", "vmdk",
  // 其他
  "pyc", "pyo", "jar", "war",
]);

/** 取小写扩展名（无扩展名返回空串）。 */
export function fileExtension(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) return "";
  return base.slice(idx + 1).toLowerCase();
}

/** 扩展名命中已知二进制清单（入口过滤，先于字节采样）。 */
export function isKnownBinaryFile(name: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtension(name));
}

/** 字节采样判定：头部窗口内出现 NUL 即视为二进制（扩展名未命中时的兜底）。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SAMPLE_WINDOW);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * 解码为文本（对齐 Netcatty readTextFile）：
 * 1. BOM 探测：UTF-16LE / UTF-16BE / UTF-8 BOM（剥 BOM）；
 * 2. 无 BOM：UTF-8 严格解码，失败回退 gb18030。
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  }
  const body = bytes.subarray(offset);
  if (offset === 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return new TextDecoder("gb18030").decode(body);
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

/** 保存回写编码：统一 UTF-8（不带 BOM）。 */
export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 尺寸上限断言（超限抛中文错误，由 UI toast/错误条展示）。 */
export function assertEditorSize(size: number): void {
  if (Number.isFinite(size) && size > MAX_EDITOR_BYTES) {
    throw new Error(
      "文件过大（超过 10 MiB），请用下载后以其他应用打开。",
    );
  }
}

/** 文件监视 stat 快照（mtime 为 unix 秒；0 = 不可用）。 */
export interface EditorStat {
  mtime: number;
  size: number;
}

/**
 * 外部修改检测的纯比较（阶段 B 监视回写）：
 * size 变化必判变；mtime 双方可用时不同即判变
 * （部分文件系统 mtime 粒度粗，size 作兜底判据）。
 */
export function statChanged(base: EditorStat, cur: EditorStat): boolean {
  if (base.size !== cur.size) return true;
  if (base.mtime > 0 && cur.mtime > 0 && base.mtime !== cur.mtime) return true;
  return false;
}
