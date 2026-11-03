import { describe, expect, it } from "vitest";
import type { Profile } from "../backend/client";
import {
  applyMarkdownAction,
  buildNoteExportFiles,
  deriveImportedTitle,
  parseInline,
  parseMarkdown,
  sanitizeNoteFileName,
} from "./markdownModel";
import { collectNoteGroups, findProfileForHostLink } from "./notesModel";

describe("markdownModel", () => {
  it("块解析：标题 / 列表 / 引用 / 代码块 / 分隔线", () => {
    const blocks = parseMarkdown(
      "# 标题\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用\n\n```ts\nconst a = 1;\n```\n\n---\n",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "list",
      "list",
      "quote",
      "code",
      "hr",
    ]);
    expect(blocks[1]).toEqual({ type: "list", ordered: false, items: ["一", "二"] });
    expect(blocks[2]).toEqual({ type: "list", ordered: true, items: ["甲", "乙"] });
    expect(blocks[4]).toEqual({ type: "code", lang: "ts", text: "const a = 1;" });
  });

  it("行内解析：加粗 / 斜体 / 代码 / 链接", () => {
    expect(parseInline("**粗** 和 *斜* 与 `code` 及 [文档](https://a.b)")).toEqual([
      { type: "bold", text: "粗" },
      { type: "text", text: " 和 " },
      { type: "italic", text: "斜" },
      { type: "text", text: " 与 " },
      { type: "code", text: "code" },
      { type: "text", text: " 及 " },
      { type: "link", text: "文档", href: "https://a.b" },
    ]);
  });

  it("工具栏加粗包裹选区并保持选中", () => {
    const result = applyMarkdownAction("hello world", 6, 11, "bold");
    expect(result.text).toBe("hello **world**");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("world");
  });

  it("工具栏列表可切换（二次点击移除前缀）", () => {
    const once = applyMarkdownAction("a\nb", 0, 3, "bullet");
    expect(once.text).toBe("- a\n- b");
    const twice = applyMarkdownAction(once.text, 0, once.text.length, "bullet");
    expect(twice.text).toBe("a\nb");
  });

  it("标题动作会替换已有标题级别", () => {
    const result = applyMarkdownAction("## 旧标题", 0, 0, "h1");
    expect(result.text).toBe("# 旧标题");
  });

  it("导出文件名清洗与 Windows 保留名", () => {
    expect(sanitizeNoteFileName('a/b:c*"d?', "note")).toBe("a-b-c--d-");
    expect(sanitizeNoteFileName("CON", "note")).toBe("CON_");
    expect(sanitizeNoteFileName("   ", "note")).toBe("note");
  });

  it("导入标题优先级：frontmatter > 首个 H1 > 文件名", () => {
    expect(
      deriveImportedTitle("x.md", "---\ntitle: 显式标题\n---\n# 正文标题"),
    ).toBe("显式标题");
    expect(deriveImportedTitle("x.md", "# 正文标题\n内容")).toBe("正文标题");
    expect(deriveImportedTitle("C:\\notes\\巡检.md", "内容")).toBe("巡检");
  });

  it("全部导出按分组落目录且重名去重", () => {
    const files = buildNoteExportFiles([
      { title: "巡检", group: "ops/db", content: "a" },
      { title: "巡检", group: "ops/db", content: "b" },
      { title: "", group: null, content: "c" },
    ]);
    expect(files.map((file) => file.path)).toEqual([
      "ops/db/巡检.md",
      "ops/db/巡检-2.md",
      "note-3.md",
    ]);
  });

  it("分组汇总含父路径并按层级排序", () => {
    expect(
      collectNoteGroups([
        { group: "ops/db" } as never,
        { group: "work" } as never,
      ]),
    ).toEqual(["ops", "work", "ops/db"]);
  });

  it("ssh 主机链接按 host/port 找到档案", () => {
    const profiles = [
      {
        id: "p1",
        name: "129",
        host: "10.0.0.129",
        port: 22,
        credential_id: "c1",
      } as Profile,
      { id: "p2", name: "other", host: "10.0.0.9", port: 22, credential_id: "c2" } as Profile,
    ];
    expect(findProfileForHostLink(profiles, "ssh://root@10.0.0.129:22")?.id).toBe("p1");
    expect(findProfileForHostLink(profiles, "ssh://10.0.0.9")?.id).toBe("p2");
    expect(findProfileForHostLink(profiles, "ssh://10.0.0.9:22")?.id).toBe("p2");
  });
});
