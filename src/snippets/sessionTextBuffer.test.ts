import { describe, expect, it, vi } from "vitest";
import { SessionTextBuffer } from "./sessionTextBuffer";

function createBuffer(maxChars?: number) {
  return new SessionTextBuffer({ pollMs: 10, maxChars });
}

describe("SessionTextBuffer 追加与游标", () => {
  it("追加输出、忽略空块，getText 返回保留文本", () => {
    const buffer = createBuffer();
    buffer.append("hello ");
    buffer.append("");
    buffer.append("world");
    expect(buffer.getText()).toBe("hello world");
    expect(buffer.getLength()).toBe(11);
    expect(buffer.getCursor()).toBe(0);
  });

  it("consumeThrough 只前进不后退，并按绝对偏移截断", () => {
    const buffer = createBuffer();
    buffer.append("abc");
    buffer.consumeThrough(2);
    expect(buffer.getCursor()).toBe(2);
    buffer.consumeThrough(0);
    expect(buffer.getCursor()).toBe(2);
    buffer.consumeThrough(999);
    expect(buffer.getCursor()).toBe(3);
  });

  it("markSendStart + consumeThrough 只消费发送前的缓冲", async () => {
    const buffer = createBuffer();
    buffer.append("before");
    const before = buffer.markSendStart();
    buffer.append(" after");
    buffer.consumeThrough(before);
    expect(buffer.getCursor()).toBe(before);
    // 发送之后的内容仍可等待。
    await expect(buffer.waitForText("after", 30)).resolves.toBe("after");
  });

  it("已消费的历史文本不再参与等待", async () => {
    const buffer = createBuffer();
    buffer.append("OLD\n");
    buffer.consumeAll();
    await expect(buffer.waitForText("OLD", 30)).rejects.toThrow(
      "waitForText timed out after 30ms",
    );
  });

  it("clear 清空文本与游标", () => {
    const buffer = createBuffer();
    buffer.append("abc");
    buffer.consumeThrough(2);
    buffer.clear();
    expect(buffer.getText()).toBe("");
    expect(buffer.getCursor()).toBe(0);
  });
});

describe("SessionTextBuffer 等待", () => {
  it("waitForText 命中后返回文本，游标推进到命中末尾", async () => {
    const buffer = createBuffer();
    buffer.append("one\nREADY\ntwo");
    await expect(buffer.waitForText("READY", 30)).resolves.toBe("READY");
    expect(buffer.getCursor()).toBe("one\nREADY".length);
    await expect(buffer.waitForText("two", 30)).resolves.toBe("two");
  });

  it("waitForText 等待后续输出（append 立即唤醒等待）", async () => {
    const buffer = createBuffer();
    const pending = buffer.waitForText("READY", 500);
    setTimeout(() => buffer.append("one\nREADY\n"), 20);
    await expect(pending).resolves.toBe("READY");
  });

  it("waitForText 超时抛出带标签的错误", async () => {
    const buffer = createBuffer();
    await expect(buffer.waitForText("NOPE", 40)).rejects.toThrow(
      "waitForText timed out after 40ms",
    );
  });

  it("isAborted 为真时立即以 Script stopped 结束等待", async () => {
    const buffer = createBuffer();
    const pending = buffer.waitForText("READY", 500, () => true);
    await expect(pending).rejects.toThrow("Script stopped");
  });

  it("abortWaiters 拒绝未完成的等待", async () => {
    const buffer = createBuffer();
    const pending = buffer.waitForText("READY", 500);
    buffer.abortWaiters();
    await expect(pending).rejects.toThrow("Script stopped");
  });

  it("waitForRegex 返回匹配文本，非法正则视为不匹配", async () => {
    const buffer = createBuffer();
    const pending = buffer.waitForRegex("^OK$", 200);
    setTimeout(() => buffer.append("line\nOK\n"), 20);
    await expect(pending).resolves.toBe("OK");

    await expect(buffer.waitForRegex("[", 40)).rejects.toThrow(
      "waitForRegex timed out after 40ms",
    );
  });

  it("waitForRegex 命中多行文本里靠后的匹配", async () => {
    const buffer = createBuffer();
    buffer.append("first\nsecond\nthird");
    await expect(buffer.waitForRegex("second", 30)).resolves.toBe("second");
    expect(buffer.getCursor()).toBe("first\nsecond".length);
  });

  it("waitForPrompt 识别 # / $ / % 结尾的提示符", async () => {
    for (const prompt of ["user@host:~$ ", "root@host:/#", "bash% "]) {
      const buffer = createBuffer();
      buffer.append(`output\n${prompt}`);
      await expect(buffer.waitForPrompt(30)).resolves.toMatch(/[#$%]/);
    }
  });

  it("waitForPrompt 不把命令输出中间的行当提示符", async () => {
    const buffer = createBuffer();
    buffer.append("$ echo hi\nhi\n");
    // 末尾是 "hi\n"，不满足提示符规则。
    await expect(buffer.waitForPrompt(40)).rejects.toThrow(
      "waitForPrompt timed out after 40ms",
    );
  });

  it("waitForAny 返回命中的模式下标", async () => {
    const buffer = createBuffer();
    buffer.append("READY\nDone");
    await expect(buffer.waitForAny(["NOPE", "READY", "Done"], 30)).resolves.toBe(1);
    await expect(buffer.waitForAny(["Done"], 30)).resolves.toBe(0);
  });

  it("waitForAny 拒绝空模式数组", async () => {
    const buffer = createBuffer();
    await expect(buffer.waitForAny([], 30)).rejects.toThrow(
      "waitForAny requires a non-empty patterns array",
    );
  });

  it("waitForAny 在等待期间命中后续输出", async () => {
    const buffer = createBuffer();
    const pending = buffer.waitForAny(["OK", "ERROR"], 500);
    setTimeout(() => buffer.append("ERROR: boom"), 20);
    await expect(pending).resolves.toBe(1);
  });
});

describe("SessionTextBuffer 尾部保留", () => {
  it("超过 maxChars 时裁剪旧文本并回退游标", () => {
    const buffer = createBuffer(100);
    buffer.append("x".repeat(60));
    buffer.consumeThrough(50);
    buffer.append("y".repeat(60));
    const text = buffer.getText();
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith("y".repeat(60))).toBe(true);
    // 裁剪了 cut 个字符，游标同步回退（不会超过当前文本长度）。
    expect(buffer.getCursor()).toBeLessThanOrEqual(buffer.getLength());
    expect(buffer.getCursor()).toBeGreaterThanOrEqual(0);
  });

  it("裁剪后新输出仍可等待", async () => {
    const buffer = createBuffer(100);
    buffer.append("old".repeat(50));
    buffer.append("NEW-MARKER");
    await expect(buffer.waitForText("NEW-MARKER", 30)).resolves.toBe("NEW-MARKER");
  });

  it("dispose 拒绝等待并清空缓冲", async () => {
    const buffer = createBuffer();
    buffer.append("abc");
    const pending = buffer.waitForText("READY", 500);
    buffer.dispose();
    await expect(pending).rejects.toThrow("Session output buffer disposed");
    expect(buffer.getText()).toBe("");
  });
});

describe("SessionTextBuffer 不依赖轮询的即时命中", () => {
  it("flush 在 append 时立刻完成等待（不等待下一个 poll）", async () => {
    vi.useFakeTimers();
    try {
      const buffer = new SessionTextBuffer({ pollMs: 60_000 });
      let settled = false;
      const pending = buffer.waitForText("READY", 60_000).then((value) => {
        settled = true;
        return value;
      });
      buffer.append("READY");
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await expect(pending).resolves.toBe("READY");
    } finally {
      vi.useRealTimers();
    }
  });
});
