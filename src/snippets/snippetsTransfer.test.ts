import { describe, expect, it } from "vitest";
import type { Snippet } from "../backend/client";
import {
  buildSnippetExportPayload,
  collectPackages,
  describeImportStats,
  mergeSnippetImport,
  parseSnippetImportPayload,
  SNIPPET_EXPORT_KIND,
  SNIPPET_EXPORT_VERSION,
} from "./snippetsTransfer";

function snip(over: Partial<Snippet> = {}): Snippet {
  return {
    id: "id-1",
    name: "磁盘用量",
    command: "df -h",
    description: "",
    package: "",
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "",
    multi_line_run_mode: "",
    language: "",
    trigger: "",
    trigger_pattern: "",
    ...over,
  };
}

describe("collectPackages", () => {
  it("展开父级路径、去重并按字母序", () => {
    expect(collectPackages(["ops/db", "ops/web/deep", "ops", ""])).toEqual([
      "ops",
      "ops/db",
      "ops/web",
      "ops/web/deep",
    ]);
  });
});

describe("buildSnippetExportPayload", () => {
  it("输出 Netcatty 传输格式（kind / version 3 / label 字段）", () => {
    const payload = buildSnippetExportPayload(
      [
        snip({ id: "a", name: "磁盘", command: "df -h", package: "ops/linux" }),
        snip({
          id: "b",
          name: "巡检",
          command: "set -e\nuptime",
          kind: "script",
          no_auto_run: true,
          multi_line_run_mode: "lineDelay",
          shortkey: "F3",
          description: "每日巡检",
          tags: ["daily"],
        }),
      ],
      "2026-11-03T00:00:00.000Z",
    );
    expect(payload.kind).toBe(SNIPPET_EXPORT_KIND);
    expect(payload.version).toBe(SNIPPET_EXPORT_VERSION);
    expect(payload.exportedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(payload.snippetPackages).toEqual(["ops", "ops/linux"]);
    expect(payload.snippets[0]).toMatchObject({
      label: "磁盘",
      command: "df -h",
      package: "ops/linux",
      tags: [],
    });
    expect(payload.snippets[0].noAutoRun).toBeUndefined();
    expect(payload.snippets[1]).toMatchObject({
      label: "巡检",
      kind: "script",
      noAutoRun: true,
      multiLineRunMode: "lineDelay",
      shortkey: "F3",
      description: "每日巡检",
      tags: ["daily"],
    });
  });
});

describe("parseSnippetImportPayload", () => {
  it("非法 JSON / 错误标识 / 错误版本 / 缺列表均报错", () => {
    expect(() => parseSnippetImportPayload("{")).toThrow("合法 JSON");
    expect(() =>
      parseSnippetImportPayload(JSON.stringify({ kind: "other", version: 3, snippets: [] })),
    ).toThrow("缺少 netcatty.snippets");
    expect(() =>
      parseSnippetImportPayload(
        JSON.stringify({ kind: SNIPPET_EXPORT_KIND, version: 9, snippets: [] }),
      ),
    ).toThrow("不支持的导入版本");
    expect(() =>
      parseSnippetImportPayload(JSON.stringify({ kind: SNIPPET_EXPORT_KIND, version: 3 })),
    ).toThrow("没有 snippets 列表");
  });

  it("接受 version 1 / 2 的旧导出", () => {
    for (const version of [1, 2]) {
      const p = parseSnippetImportPayload(
        JSON.stringify({
          kind: SNIPPET_EXPORT_KIND,
          version,
          snippets: [{ label: "a", command: "df -h" }],
        }),
      );
      expect(p.version).toBe(version);
      expect(p.snippets).toHaveLength(1);
    }
  });

  it("宽松校验：缺 label 用命令首行兜底，command 为空则丢弃，未知字段忽略", () => {
    const p = parseSnippetImportPayload(
      JSON.stringify({
        kind: SNIPPET_EXPORT_KIND,
        version: 3,
        snippets: [
          { command: "  df -h  " },
          { label: "空命令", command: "   " },
          {
            label: "带不支持字段",
            command: "uptime",
            targets: ["host-1"],
            trigger: "onConnect",
            multiLineRunMode: "bogus",
            kind: "bogus",
          },
        ],
      }),
    );
    expect(p.snippets).toHaveLength(2);
    expect(p.snippets[0].label).toBe("df -h");
    expect(p.snippets[1].label).toBe("带不支持字段");
    expect(p.snippets[1].multiLineRunMode).toBeUndefined();
    expect(p.snippets[1].kind).toBeUndefined();
  });

  it("支持裸数组（旧格式）", () => {
    const p = parseSnippetImportPayload(
      JSON.stringify([{ label: "a", command: "ls" }, { label: "b", command: "pwd" }]),
    );
    expect(p.snippets.map((s) => s.command)).toEqual(["ls", "pwd"]);
  });

  it("支持多个导出对象组成的数组（合并）", () => {
    const one = {
      kind: SNIPPET_EXPORT_KIND,
      version: 3,
      snippets: [{ label: "a", command: "ls", package: "ops" }],
    };
    const two = {
      kind: SNIPPET_EXPORT_KIND,
      version: 3,
      snippets: [{ label: "b", command: "pwd", package: "ops/db" }],
    };
    const p = parseSnippetImportPayload(JSON.stringify([one, two]));
    expect(p.snippets).toHaveLength(2);
    expect(p.snippetPackages).toEqual(["ops", "ops/db"]);
  });
});

describe("mergeSnippetImport", () => {
  const existing = [
    snip({ id: "local-1", command: "df -h", name: "本地磁盘" }),
    snip({ id: "local-2", command: "uptime", name: "本地 uptime" }),
  ];
  const payload = (() => {
    const p = parseSnippetImportPayload(
      JSON.stringify({
        kind: SNIPPET_EXPORT_KIND,
        version: 3,
        snippetPackages: ["ops"],
        snippets: [
          { label: "导入磁盘", command: "df -h" },
          { label: "新命令", command: "free -h" },
        ],
      }),
    );
    return p;
  })();

  it("skip：同命令保留本地、统计冲突与跳过", () => {
    const r = mergeSnippetImport({
      existing,
      payload,
      conflictAction: "skip",
      createId: () => "new-id",
    });
    expect(r.snippets).toHaveLength(3);
    expect(r.snippets[0].name).toBe("本地磁盘");
    expect(r.snippets[2]).toMatchObject({ id: "new-id", name: "新命令" });
    expect(r.stats).toEqual({ imported: 1, overwritten: 0, skipped: 1, conflicts: 1 });
  });

  it("overwrite：覆盖内容但沿用本地 id", () => {
    const r = mergeSnippetImport({
      existing,
      payload,
      conflictAction: "overwrite",
      createId: () => "new-id",
    });
    expect(r.snippets[0]).toMatchObject({ id: "local-1", name: "导入磁盘", command: "df -h" });
    expect(r.stats).toEqual({ imported: 1, overwritten: 1, skipped: 0, conflicts: 1 });
  });

  it("字段镜像：noAutoRun → no_auto_run，kind/multiLineRunMode 归一", () => {
    const p = parseSnippetImportPayload(
      JSON.stringify({
        kind: SNIPPET_EXPORT_KIND,
        version: 3,
        snippets: [
          {
            label: "s",
            command: "set -e\nuptime",
            noAutoRun: true,
            kind: "script",
            multiLineRunMode: "lineDelay",
            description: "d",
            tags: ["t1"],
          },
        ],
      }),
    );
    const r = mergeSnippetImport({
      existing: [],
      payload: p,
      conflictAction: "skip",
      createId: () => "id-9",
    });
    expect(r.snippets[0]).toEqual({
      id: "id-9",
      name: "s",
      command: "set -e\nuptime",
      description: "d",
      package: "",
      tags: ["t1"],
      shortkey: "",
      no_auto_run: true,
      kind: "script",
      multi_line_run_mode: "lineDelay",
      language: "",
      trigger: "",
      trigger_pattern: "",
    });
  });

  it("往返一致：导出 → 解析 → 合并到空库 保留核心字段", () => {
    const original = [
      snip({
        name: "多行脚本",
        command: "a\nb",
        package: "ops",
        tags: ["x"],
        shortkey: "F4",
        description: "desc",
        kind: "script",
        multi_line_run_mode: "lineDelay",
        language: "javascript",
        trigger: "onOutput",
        trigger_pattern: "sudo.*password",
      }),
    ];
    const p = parseSnippetImportPayload(JSON.stringify(buildSnippetExportPayload(original)));
    const r = mergeSnippetImport({
      existing: [],
      payload: p,
      conflictAction: "skip",
      createId: () => "id-r",
    });
    expect(r.snippets[0]).toMatchObject({
      name: "多行脚本",
      command: "a\nb",
      package: "ops",
      tags: ["x"],
      shortkey: "F4",
      description: "desc",
      kind: "script",
      multi_line_run_mode: "lineDelay",
      language: "javascript",
      trigger: "onOutput",
      trigger_pattern: "sudo.*password",
    });
  });
});

describe("describeImportStats", () => {
  it("只展示非零项", () => {
    expect(
      describeImportStats({ imported: 2, overwritten: 0, skipped: 0, conflicts: 0 }),
    ).toBe("新增 2");
    expect(
      describeImportStats({ imported: 1, overwritten: 2, skipped: 3, conflicts: 5 }),
    ).toBe("新增 1，覆盖 2，跳过 3");
  });
});
