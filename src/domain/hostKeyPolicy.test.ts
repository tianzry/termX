import { describe, expect, it } from "vitest";
import {
  hostKeyPolicyFromProfile,
  hostKeyPolicyLabel,
  hostKeyPolicyToProfile,
} from "./hostKeyPolicy";

describe("hostKeyPolicy", () => {
  it("老数据 / 空值回落跟随全局", () => {
    expect(hostKeyPolicyFromProfile(null)).toBe("default");
    expect(hostKeyPolicyFromProfile(undefined)).toBe("default");
    expect(hostKeyPolicyFromProfile("")).toBe("default");
    expect(hostKeyPolicyFromProfile("nonsense")).toBe("default");
  });

  it("保留 verify / skip", () => {
    expect(hostKeyPolicyFromProfile("verify")).toBe("verify");
    expect(hostKeyPolicyFromProfile("skip")).toBe("skip");
  });

  it("跟随全局写回 null，其余原样", () => {
    expect(hostKeyPolicyToProfile("default")).toBeNull();
    expect(hostKeyPolicyToProfile("verify")).toBe("verify");
    expect(hostKeyPolicyToProfile("skip")).toBe("skip");
  });

  it("一行式文案带全局当前值", () => {
    expect(hostKeyPolicyLabel("default", true)).toBe("跟随全局（当前校验）");
    expect(hostKeyPolicyLabel("default", false)).toBe("跟随全局（当前跳过）");
    expect(hostKeyPolicyLabel("verify", false)).toBe("始终校验");
    expect(hostKeyPolicyLabel("skip", true)).toBe("跳过校验");
  });
});
