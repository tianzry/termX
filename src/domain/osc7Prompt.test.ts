import { beforeEach, describe, expect, it } from "vitest";
import {
  dismissOsc7Prompt,
  isOsc7PromptDismissed,
  osc7PromptDismissedKey,
} from "./osc7Prompt";

describe("osc7Prompt 每主机记忆", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("未取消过的主机不记忆", () => {
    expect(isOsc7PromptDismissed("p1")).toBe(false);
  });

  it("取消后按主机记住且互不串台", () => {
    dismissOsc7Prompt("p1");
    expect(isOsc7PromptDismissed("p1")).toBe(true);
    expect(isOsc7PromptDismissed("p2")).toBe(false);
  });

  it("存储键带前缀避免与其它键冲突", () => {
    expect(osc7PromptDismissedKey("p9")).toBe("termx.osc7prompt.dismissed.p9");
  });
});
