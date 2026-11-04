/**
 * 终端内嵌图片（Kitty graphics / SIXEL / iTerm IIP）设置解析。
 *
 * 对齐 Netcatty `domain/terminalInlineImages.ts`：三类协议都由 `@xterm/addon-image`
 * 解码渲染，addon 把解码后的位图放在终端缓冲之外，因此这里的每个上限都是内存闸门：
 * - `storageLimit`：单个终端图片 FIFO 缓存上限（MB，RGBA8888）；
 * - `pixelLimit`：单张图解码后的像素上限（解码期间最多同时持有两份像素缓冲）；
 * - `sequenceLimitBytes`：原始转义序列在解码前的长度上限，超限直接拒绝，不分配内存。
 */

export const INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT = 128;
export const INLINE_IMAGE_STORAGE_LIMIT_MB_MIN = 8;
export const INLINE_IMAGE_STORAGE_LIMIT_MB_MAX = 512;

export const INLINE_IMAGE_MAX_MEGAPIXELS_DEFAULT = 16;
export const INLINE_IMAGE_MAX_MEGAPIXELS_MIN = 1;
export const INLINE_IMAGE_MAX_MEGAPIXELS_MAX = 64;

export const INLINE_IMAGE_SEQUENCE_LIMIT_MB_DEFAULT = 24;
export const INLINE_IMAGE_SEQUENCE_LIMIT_MB_MIN = 1;
export const INLINE_IMAGE_SEQUENCE_LIMIT_MB_MAX = 64;

const BYTES_PER_MB = 1024 * 1024;
const PIXELS_PER_MEGAPIXEL = 1024 * 1024;

/** 终端设置里与内嵌图片相关的子集（structural，避免 domain 依赖渲染层）。 */
export type InlineImageSettings = {
  inlineImagesEnabled: boolean;
  inlineImageKittyEnabled: boolean;
  inlineImageSixelEnabled: boolean;
  inlineImageIipEnabled: boolean;
  inlineImageStorageLimitMb: number;
  inlineImageMaxMegapixels: number;
  inlineImageSequenceLimitMb: number;
};

/** `@xterm/addon-image` 的构造参数（与 IImageAddonOptions 结构一致）。 */
export type InlineImageAddonOptions = {
  enableSizeReports: boolean;
  pixelLimit: number;
  storageLimit: number;
  showPlaceholder: boolean;
  sixelSupport: boolean;
  sixelSizeLimit: number;
  iipSupport: boolean;
  iipSizeLimit: number;
  kittySupport: boolean;
  kittySizeLimit: number;
};

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeInlineImageStorageLimitMb(value: unknown): number {
  return clampInteger(
    value,
    INLINE_IMAGE_STORAGE_LIMIT_MB_MIN,
    INLINE_IMAGE_STORAGE_LIMIT_MB_MAX,
    INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT,
  );
}

export function normalizeInlineImageMaxMegapixels(value: unknown): number {
  return clampInteger(
    value,
    INLINE_IMAGE_MAX_MEGAPIXELS_MIN,
    INLINE_IMAGE_MAX_MEGAPIXELS_MAX,
    INLINE_IMAGE_MAX_MEGAPIXELS_DEFAULT,
  );
}

export function normalizeInlineImageSequenceLimitMb(value: unknown): number {
  return clampInteger(
    value,
    INLINE_IMAGE_SEQUENCE_LIMIT_MB_MIN,
    INLINE_IMAGE_SEQUENCE_LIMIT_MB_MAX,
    INLINE_IMAGE_SEQUENCE_LIMIT_MB_DEFAULT,
  );
}

/** 总开关开且至少启用一个协议时，才加载 addon（否则不向远端声明图形能力）。 */
export function resolveInlineImagesEnabled(
  settings?: Partial<InlineImageSettings> | null,
): boolean {
  if (settings?.inlineImagesEnabled !== true) return false;
  return (
    settings.inlineImageKittyEnabled === true ||
    settings.inlineImageSixelEnabled === true ||
    settings.inlineImageIipEnabled === true
  );
}

/** 生成 addon 参数；返回 null 表示完全不加载 addon。 */
export function resolveInlineImageAddonOptions(
  settings?: Partial<InlineImageSettings> | null,
): InlineImageAddonOptions | null {
  if (!resolveInlineImagesEnabled(settings)) return null;
  const sequenceLimitBytes =
    normalizeInlineImageSequenceLimitMb(settings?.inlineImageSequenceLimitMb) * BYTES_PER_MB;
  return {
    // 图片生产者需要 CSI 14/16/18 t 来按网格尺寸输出。
    enableSizeReports: true,
    pixelLimit:
      normalizeInlineImageMaxMegapixels(settings?.inlineImageMaxMegapixels) * PIXELS_PER_MEGAPIXEL,
    storageLimit: normalizeInlineImageStorageLimitMb(settings?.inlineImageStorageLimitMb),
    showPlaceholder: true,
    sixelSupport: settings?.inlineImageSixelEnabled === true,
    sixelSizeLimit: sequenceLimitBytes,
    iipSupport: settings?.inlineImageIipEnabled === true,
    iipSizeLimit: sequenceLimitBytes,
    kittySupport: settings?.inlineImageKittyEnabled === true,
    kittySizeLimit: sequenceLimitBytes,
  };
}
