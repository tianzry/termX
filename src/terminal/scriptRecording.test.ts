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
