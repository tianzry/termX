import { describe, expect, it } from "vitest";
import { isFindShortcut, linkModifierAllows } from "./linkActivation";

const noMods = { ctrlKey: false, altKey: false, metaKey: false };

describe("linkModifierAllows", () => {
  it("none 直接点击即可激活", () => {
    expect(linkModifierAllows("none", noMods)).toBe(true);
    expect(linkModifierAllows(undefined, noMods)).toBe(true);
  });

  it("ctrl / alt / meta 只在对应键按下时激活", () => {
    expect(linkModifierAllows("ctrl", { ...noMods, ctrlKey: true })).toBe(true);
    expect(linkModifierAllows("ctrl", { ...noMods, altKey: true })).toBe(false);
    expect(linkModifierAllows("alt", { ...noMods, altKey: true })).toBe(true);
    expect(linkModifierAllows("alt", { ...noMods, ctrlKey: true })).toBe(false);
    expect(linkModifierAllows("meta", { ...noMods, metaKey: true })).toBe(true);
    expect(linkModifierAllows("meta", { ...noMods })).toBe(false);
  });
});

describe("isFindShortcut", () => {
  const base = { key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

  it("识别 Ctrl+F 与 Cmd+F", () => {
    expect(isFindShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isFindShortcut({ ...base, metaKey: true })).toBe(true);
  });

  it("排除错误组合与普通 f 键", () => {
    expect(isFindShortcut(base)).toBe(false);
    expect(isFindShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isFindShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(false);
    expect(isFindShortcut({ ...base, ctrlKey: true, key: "g" })).toBe(false);
  });
});
