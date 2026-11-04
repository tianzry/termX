import { describe, expect, it } from "vitest";
import {
  looksLikePrompt,
  parseScriptBlocks,
  runScriptBlocks,
} from "./scriptRunner";

describe("parseScriptBlocks", () => {
  it("普通行聚合为命令块，等待指令切块", () => {
    const blocks = parseScriptBlocks(
      ["echo one", "echo two", "#@wait-text READY", "echo done"].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "command", text: "echo one\necho two" },
      { kind: "wait-text", text: "READY", timeoutMs: 30000 },
      { kind: "command", text: "echo done" },
    ]);
  });

  it("等待指令支持毫秒超时", () => {
    const blocks = parseScriptBlocks("#@wait-prompt 5000\n#@wait-regex ^OK$ 8000");
    expect(blocks).toEqual([
      { kind: "wait-prompt", timeoutMs: 5000 },
      { kind: "wait-regex", pattern: "^OK$", timeoutMs: 8000 },
    ]);
  });

  it("未知指令保留为命令行，不静默丢弃", () => {
    const blocks = parseScriptBlocks("#@dialog hello\n#@wait-prompt");
    expect(blocks).toEqual([
      { kind: "command", text: "#@dialog hello" },
      { kind: "wait-prompt", timeoutMs: 30000 },
    ]);
  });
});

describe("looksLikePrompt", () => {
  it("识别 # / $ / % 结尾的最后一行", () => {
    expect(looksLikePrompt("user@host:~$ ")).toBe(true);
    expect(looksLikePrompt("root@host:~#")).toBe(true);
    expect(looksLikePrompt("user@host:~$ echo hi\nhi")).toBe(false);
  });
});

describe("runScriptBlocks", () => {
  it("命令发送后等待文本命中再继续", async () => {
    let buffer = "";
    const written: string[] = [];
    const handle = runScriptBlocks(
      parseScriptBlocks("echo one\n#@wait-text READY\necho two"),
      {
        write: (t) => {
          written.push(t);
          if (t.includes("echo one")) {
            setTimeout(() => {
              buffer += "one\nREADY\n";
            }, 20);
          }
        },
        readBuffer: () => buffer,
        pollMs: 10,
      },
    );
    await handle.done;
    expect(written[0]).toBe("echo one\r");
    expect(written[1]).toBe("echo two\r");
  });

  it("等待超时抛错并可取消", async () => {
    const handle = runScriptBlocks(
      parseScriptBlocks("#@wait-text NEVER 1000"),
      { write: () => {}, readBuffer: () => "", pollMs: 10 },
    );
    await expect(handle.done).rejects.toThrow(/等待超时/);

    const cancelled = runScriptBlocks(
      parseScriptBlocks("#@wait-text NEVER 5000"),
      { write: () => {}, readBuffer: () => "", pollMs: 20 },
    );
    cancelled.cancel();
    await expect(cancelled.done).resolves.toBeUndefined();
  });
});
