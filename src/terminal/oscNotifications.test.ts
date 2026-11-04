import { describe, expect, it } from "vitest";
import {
  Osc99Assembler,
  parseOsc777Payload,
  parseOsc9Payload,
  resolveOscNotificationPresentation,
  sanitizeOscNotificationText,
  shouldShowOscNotification,
} from "./oscNotifications";

describe("parseOsc9Payload", () => {
  it("普通文本作为正文，忽略 ConEmu 进度命令", () => {
    expect(parseOsc9Payload("Build finished")?.body).toBe("Build finished");
    expect(parseOsc9Payload("4;0;Building")).toBeNull();
    expect(parseOsc9Payload("  ")).toBeNull();
  });
});

describe("parseOsc777Payload", () => {
  it("解析 notify;title;body 与省略标题", () => {
    expect(parseOsc777Payload("notify;Claude;Needs approval")).toMatchObject({
      title: "Claude",
      body: "Needs approval",
      protocol: "osc777",
    });
    expect(parseOsc777Payload("notify;Done")?.body).toBe("Done");
    expect(parseOsc777Payload("something-else")).toBeNull();
  });
});

describe("Osc99Assembler", () => {
  it("分片 title/body 在 d=1 时给出完整通知", () => {
    const assembler = new Osc99Assembler();
    expect(assembler.consume("i=1:d=0;Hello")).toBeNull();
    expect(assembler.consume("i=1:p=body:d=0; world")).toBeNull();
    const result = assembler.consume("i=1:p=body:d=1;!");
    expect(result).toMatchObject({ title: "Hello", body: " world!", protocol: "osc99" });
  });
});

describe("通知展示与开关", () => {
  it("空标题回落默认标题，正文缺失时用标题补位", () => {
    const p = resolveOscNotificationPresentation({ title: "", body: "Job done", protocol: "osc9" }, "termX");
    expect(p).toEqual({ title: "termX", body: "Job done" });
  });

  it("mode=unfocused 仅在窗口失焦时显示", () => {
    expect(shouldShowOscNotification("off", true)).toBe(false);
    expect(shouldShowOscNotification("always", true)).toBe(true);
    expect(shouldShowOscNotification("unfocused", false)).toBe(true);
    expect(shouldShowOscNotification("unfocused", true)).toBe(false);
  });

  it("清洗控制字符并按上限截断", () => {
    const text = sanitizeOscNotificationText(`a\u0000b\u001b[31m`, 8);
    expect(text).toBe("ab[31m");
    expect(sanitizeOscNotificationText("x".repeat(20), 5)).toBe("xxxx…");
  });
});
