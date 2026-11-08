import { describe, expect, it } from "vitest";
import { SHADOWED_GLOBALS, compileScriptRunner, wrapScriptSource } from "./scriptSandbox";

function createNct() {
  const logs: string[] = [];
  return {
    logs,
    nct: {
      log(message: unknown) {
        logs.push(String(message ?? ""));
      },
    },
  };
}

describe("wrapScriptSource 三种包装规则", () => {
  it("以 (async () => { 开头的源码原样执行并 await", async () => {
    const { logs, nct } = createNct();
    await compileScriptRunner("(async () => {\n  nct.log('iife');\n})();")(nct);
    expect(logs).toEqual(["iife"]);
  });

  it("含 async function main() 时包裹后 await main()", async () => {
    const { logs, nct } = createNct();
    await compileScriptRunner("async function main() {\n  nct.log('main');\n}")(nct);
    expect(logs).toEqual(["main"]);
  });

  it("含同步 function main() 时同样包裹并调用", async () => {
    const { logs, nct } = createNct();
    await compileScriptRunner("function main() {\n  nct.log('sync-main');\n}")(nct);
    expect(logs).toEqual(["sync-main"]);
  });

  it("已写 await main() 时不会重复调用", async () => {
    const { logs, nct } = createNct();
    await compileScriptRunner(
      "async function main() {\n  nct.log('once');\n}\nawait main();",
    )(nct);
    expect(logs).toEqual(["once"]);
  });

  it("其它源码作为普通脚本体执行，支持顶层 await", async () => {
    const { logs, nct } = createNct();
    await compileScriptRunner(
      "await Promise.resolve();\nnct.log('plain');",
    )(nct);
    expect(logs).toEqual(["plain"]);
  });

  it("空源码抛错", () => {
    expect(() => wrapScriptSource("   \n")).toThrow("Script content is empty");
    expect(() => compileScriptRunner("")).toThrow("Script content is empty");
  });

  it("包装后的表达式保留严格模式", () => {
    expect(wrapScriptSource("nct.log('x')")).toContain('"use strict"');
  });
});

describe("compileScriptRunner 全局屏蔽", () => {
  it("fetch / XMLHttpRequest / WebSocket / indexedDB / importScripts / eval / Function 均为 undefined", async () => {
    const { logs, nct } = createNct();
    const names = SHADOWED_GLOBALS.map((name) => JSON.stringify(name)).join(", ");
    await compileScriptRunner(
      `const names = [${names}];
nct.log(names.map((name) => String(eval ? "no" : "undefined")).join(","));
nct.log(String(fetch));
nct.log(String(XMLHttpRequest));
nct.log(String(WebSocket));
nct.log(String(indexedDB));
nct.log(String(importScripts));
nct.log(String(eval));
nct.log(String(Function));`,
    )(nct);
    expect(logs).toEqual([
      "undefined,undefined,undefined,undefined,undefined,undefined,undefined",
      ...Array.from({ length: 7 }, () => "undefined"),
    ]);
  });

  it("调用被屏蔽的 fetch 会抛 TypeError，而不是悄悄发请求", async () => {
    const { nct } = createNct();
    await expect(
      compileScriptRunner("fetch('https://example.com')(nct.log('should-not-run'))")(nct),
    ).rejects.toThrow(TypeError);
  });

  it("用户代码运行在严格模式（未绑定 this 为 undefined）", async () => {
    const { logs, nct } = createNct();
    await compileScriptRunner(
      "nct.log((function () { return this === undefined; })() ? 'strict' : 'sloppy');",
    )(nct);
    expect(logs).toEqual(["strict"]);
  });

  it("抛出的错误带原始 message，便于宿主序列化", async () => {
    const { nct } = createNct();
    await expect(compileScriptRunner("throw new Error('boom')")(nct)).rejects.toThrow("boom");
  });
});
