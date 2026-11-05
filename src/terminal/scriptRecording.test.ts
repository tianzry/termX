import { describe, expect, it, beforeEach } from "vitest";
import {
  activeScriptRecordingSession,
  appendKeystrokes,
  beginScriptRecording,
  buildScriptCommand,
  createScriptRecordingBuffer,
  endScriptRecording,
} from "./scriptRecording";

describe("script recording input buffer", () => {
  it("records a submitted command and clears the line", () => {
    const buf = createScriptRecordingBuffer(0);
    appendKeystrokes(buf, "ls -la", 10);
    const step = appendKeystrokes(buf, "\r", 20);
    expect(step).toEqual({ command: "ls -la", delayMs: 0 });
    expect(buf.line).toBe("");
  });

  it("ignores empty submissions but keeps comments", () => {
    const buf = createScriptRecordingBuffer(0);
    expect(appendKeystrokes(buf, "\r", 5)).toBeNull();
    appendKeystrokes(buf, "# hi", 10);
    const step = appendKeystrokes(buf, "\r", 20);
    expect(step).toEqual({ command: "# hi", delayMs: 0 });
    expect(buf.steps).toHaveLength(1);
  });

  it("tracks delay between submissions", () => {
    const buf = createScriptRecordingBuffer(0);
    appendKeystrokes(buf, "a\r", 100);
    appendKeystrokes(buf, "b\r", 2100);
    expect(buf.steps[1]).toEqual({ command: "b", delayMs: 2000 });
  });

  it("handles backspace and ctrl-c", () => {
    const buf = createScriptRecordingBuffer(0);
    appendKeystrokes(buf, "abc\u007f", 10);
    expect(buf.line).toBe("ab");
    appendKeystrokes(buf, "x\u0003", 20);
    expect(buf.line).toBe("");
  });

  it("skips arrow key escape sequences", () => {
    const buf = createScriptRecordingBuffer(0);
    appendKeystrokes(buf, "ab\u001b[D", 10);
    expect(buf.line).toBe("ab");
  });

  it("单独按 ESC 后继续输入不会吞掉下一个字符", () => {
    const buf = createScriptRecordingBuffer(0);
    appendKeystrokes(buf, "ab\u001b", 10);
    expect(buf.line).toBe("ab");
    expect(buf.pendingEscape).toBe("\u001b");
    appendKeystrokes(buf, "ls", 11);
    expect(buf.line).toBe("abls");
    expect(buf.pendingEscape).toBe("");
  });

  it("bracketed paste 多行内容按一条完整命令记录", () => {
    const buf = createScriptRecordingBuffer(0);
    // 粘贴期间的换行不是提交，不应产生多条记录。
    expect(
      appendKeystrokes(buf, "\u001b[200~echo a\necho b\u001b[201~", 10),
    ).toBeNull();
    expect(buf.line).toBe("echo a\necho b");
    expect(buf.steps).toHaveLength(0);
    // Enter 提交整段，作为一条多行命令。
    expect(appendKeystrokes(buf, "\r", 20)).toEqual({
      command: "echo a\necho b",
      delayMs: 0,
    });
    expect(buf.steps).toHaveLength(1);
  });

  it("粘贴内容跨 chunk：200~ 与 201~ 分别到达仍合成一条", () => {
    const buf = createScriptRecordingBuffer(0);
    appendKeystrokes(buf, "\u001b[200~aws s3\nls -l\u001b[20", 10);
    expect(appendKeystrokes(buf, "1~", 11)).toBeNull();
    expect(buf.line).toBe("aws s3\nls -l");
    expect(appendKeystrokes(buf, "\r", 12)?.command).toBe("aws s3\nls -l");
  });

  it("粘贴内容里的 CRLF 归一为 LF，且可继续追加输入", () => {
    const buf = createScriptRecordingBuffer(0);
    appendKeystrokes(buf, "\u001b[200~cd /tmp\r\npwd\r\u001b[201~", 10);
    expect(buf.line).toBe("cd /tmp\npwd\n");
    appendKeystrokes(buf, "&& ls", 11);
    expect(buf.line).toBe("cd /tmp\npwd\n&& ls");
    expect(appendKeystrokes(buf, "\r", 20)?.command).toBe("cd /tmp\npwd\n&& ls");
  });

  it("builds a script with sleeps for long gaps", () => {
    const text = buildScriptCommand([
      { command: "cd /tmp", delayMs: 0 },
      { command: "ls", delayMs: 3000 },
    ]);
    expect(text).toBe("cd /tmp\nsleep 3.0\nls");
  });
});

describe("global script recording slot", () => {
  beforeEach(() => {
    if (activeScriptRecordingSession()) {
      endScriptRecording(activeScriptRecordingSession() as string);
    }
  });

  it("allows only one session at a time", () => {
    expect(beginScriptRecording("s1")).toBe(true);
    expect(beginScriptRecording("s2")).toBe(false);
    expect(activeScriptRecordingSession()).toBe("s1");
    endScriptRecording("s1");
    expect(beginScriptRecording("s2")).toBe(true);
  });
});
