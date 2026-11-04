import { describe, expect, it } from "vitest";
import {
  INLINE_IMAGE_MAX_MEGAPIXELS_DEFAULT,
  INLINE_IMAGE_SEQUENCE_LIMIT_MB_DEFAULT,
  INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT,
  normalizeInlineImageMaxMegapixels,
  normalizeInlineImageSequenceLimitMb,
  normalizeInlineImageStorageLimitMb,
  resolveInlineImageAddonOptions,
  resolveInlineImagesEnabled,
} from "./inlineImages";

const base = {
  inlineImagesEnabled: true,
  inlineImageKittyEnabled: true,
  inlineImageSixelEnabled: true,
  inlineImageIipEnabled: true,
  inlineImageStorageLimitMb: INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT,
  inlineImageMaxMegapixels: INLINE_IMAGE_MAX_MEGAPIXELS_DEFAULT,
  inlineImageSequenceLimitMb: INLINE_IMAGE_SEQUENCE_LIMIT_MB_DEFAULT,
};

describe("resolveInlineImagesEnabled", () => {
  it("默认关闭：总开关关时不向远端声明图形能力", () => {
    expect(resolveInlineImagesEnabled(undefined)).toBe(false);
    expect(resolveInlineImagesEnabled({ ...base, inlineImagesEnabled: false })).toBe(false);
    expect(resolveInlineImageAddonOptions({ ...base, inlineImagesEnabled: false })).toBeNull();
  });

  it("总开关开但三个协议全关时不加载 addon", () => {
    expect(
      resolveInlineImageAddonOptions({
        ...base,
        inlineImageKittyEnabled: false,
        inlineImageSixelEnabled: false,
        inlineImageIipEnabled: false,
      }),
    ).toBeNull();
  });

  it("任一协议开启即启用", () => {
    expect(
      resolveInlineImagesEnabled({
        ...base,
        inlineImageKittyEnabled: false,
        inlineImageIipEnabled: false,
      }),
    ).toBe(true);
  });
});

describe("resolveInlineImageAddonOptions", () => {
  it("按协议开关生成 addon 参数，序列上限换算为字节", () => {
    const opts = resolveInlineImageAddonOptions({
      ...base,
      inlineImageKittyEnabled: false,
      inlineImageSequenceLimitMb: 8,
    })!;
    expect(opts.kittySupport).toBe(false);
    expect(opts.sixelSupport).toBe(true);
    expect(opts.iipSupport).toBe(true);
    expect(opts.sixelSizeLimit).toBe(8 * 1024 * 1024);
    expect(opts.iipSizeLimit).toBe(8 * 1024 * 1024);
    expect(opts.enableSizeReports).toBe(true);
    expect(opts.showPlaceholder).toBe(true);
    expect(opts.storageLimit).toBe(INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT);
    expect(opts.pixelLimit).toBe(INLINE_IMAGE_MAX_MEGAPIXELS_DEFAULT * 1024 * 1024);
  });

  it("上限越界时夹紧到合法区间", () => {
    const opts = resolveInlineImageAddonOptions({
      ...base,
      inlineImageStorageLimitMb: 9999,
      inlineImageMaxMegapixels: 0,
      inlineImageSequenceLimitMb: 0,
    })!;
    expect(opts.storageLimit).toBe(512);
    expect(opts.pixelLimit).toBe(1 * 1024 * 1024);
    expect(opts.sixelSizeLimit).toBe(1 * 1024 * 1024);
  });
});

describe("普通化函数", () => {
  it("非数字 / 非有限值回落默认，数字取整并夹紧", () => {
    expect(normalizeInlineImageStorageLimitMb("x")).toBe(INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT);
    expect(normalizeInlineImageStorageLimitMb(null)).toBe(INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT);
    expect(normalizeInlineImageStorageLimitMb(NaN)).toBe(INLINE_IMAGE_STORAGE_LIMIT_MB_DEFAULT);
    expect(normalizeInlineImageStorageLimitMb(10.6)).toBe(11);
    expect(normalizeInlineImageMaxMegapixels(-1)).toBe(1);
    expect(normalizeInlineImageSequenceLimitMb(999)).toBe(64);
  });
});
