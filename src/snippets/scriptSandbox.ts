// 脚本沙箱：源码包装 + 全局屏蔽（防呆，不是安全边界）。
//
// 包装规则与 Netcatty `scriptRuntime.cjs` 的 `wrapScriptSource` 对齐：
// - 以 `(async () => {` / `(async function () {` 开头：原样执行；
// - 含 `function main()`：包裹后 `await main()`；
// - 其它：`(async () => { ... })()`。
//
// 全局屏蔽：把 `fetch / XMLHttpRequest / WebSocket / indexedDB / importScripts /
// eval / Function` 作为工厂函数参数传入 `undefined`，用户代码里的同名标识符
// 会解析到参数而不是全局对象。
// 注意：Worker 不是安全边界，`globalThis` 仍可拿到真正的全局对象；这层只做
// 防呆（避免无意识发网络请求 / 动态执行），不能防御恶意脚本。

/** 以参数形式置空的全局名（顺序即工厂函数参数顺序）。 */
export const SHADOWED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "indexedDB",
  "importScripts",
  "eval",
  "Function",
] as const;

const MAIN_FUNCTION_PATTERN = /\basync\s+function\s+main\s*\(/m;
const SYNC_MAIN_FUNCTION_PATTERN = /\bfunction\s+main\s*\(/m;
const ASYNC_IIFE_PATTERN =
  /^\(\s*async\s*\(\s*\)\s*=>/m;
const ASYNC_FUNCTION_IIFE_PATTERN = /^\(\s*async\s+function\s*\(\s*\)\s*\{/m;

function stripTrailingSemicolon(source: string): string {
  return source.replace(/;\s*$/, "");
}

function stripTrailingAwaitMain(source: string): string {
  return source.replace(/\n\s*;?\s*await\s+main\s*\(\s*\)\s*;?\s*$/m, "").trimEnd();
}

/**
 * 按三种规则包装用户源码，返回一个可直接求值的表达式。
 * 生成的外层 async 箭头带 `"use strict"`；工厂函数本身必须保持非严格模式，
 * 否则参数名 `eval` 会直接抛 SyntaxError。
 */
export function wrapScriptSource(source: string): string {
  const trimmed = String(source ?? "").trim();
  if (!trimmed) throw new Error("Script content is empty");

  if (ASYNC_IIFE_PATTERN.test(trimmed) || ASYNC_FUNCTION_IIFE_PATTERN.test(trimmed)) {
    return `(async () => {\n"use strict";\nreturn await (${stripTrailingSemicolon(trimmed)});\n})()`;
  }

  if (MAIN_FUNCTION_PATTERN.test(trimmed) || SYNC_MAIN_FUNCTION_PATTERN.test(trimmed)) {
    const body = stripTrailingAwaitMain(trimmed);
    const invokeMain = MAIN_FUNCTION_PATTERN.test(body)
      ? "await main();"
      : "await Promise.resolve(main());";
    return `(async () => {\n"use strict";\n${body}\n${invokeMain}\n})()`;
  }

  return `(async () => {\n"use strict";\n${trimmed}\n})()`;
}

/**
 * 把源码编译成可直接调用的 runner。
 * 返回的函数接收 `nct`，并在调用前把受控全局以 `undefined` 注入。
 */
export function compileScriptRunner(source: string): (nct: unknown) => Promise<unknown> {
  const expression = wrapScriptSource(source);
  const params = ["nct", ...SHADOWED_GLOBALS].join(", ");
  // eslint-disable-next-line no-new-func -- 沙箱本身就是用 Function 构造隔离执行体
  const factory = new Function(params, `return (${expression});`) as (
    nct: unknown,
    ...blocked: undefined[]
  ) => Promise<unknown>;

  return (nct: unknown) =>
    factory(nct, ...SHADOWED_GLOBALS.map(() => undefined));
}
