import { describe, expect, it } from "vitest";
import {
  collectLeaves,
  defaultTitle,
  firstLeafId,
  makeLeaf,
  removeLeaf,
  replaceLeaf,
  splitLeaf,
  updateRatio,
  type LeafNode,
  type PaneNode,
} from "./workspaceModel";

const leaf = (id: string): LeafNode => ({ type: "leaf", id });

describe("splitLeaf", () => {
  it("把目标叶子替换为 1:1 切分", () => {
    const target = leaf("a");
    const fresh = leaf("b");
    const next = splitLeaf(target, "a", "horizontal", fresh);
    expect(next.type).toBe("split");
    if (next.type !== "split") throw new Error("unreachable");
    expect(next.dir).toBe("horizontal");
    expect(next.ratio).toBe(0.5);
    expect(next.a).toBe(target);
    expect(next.b).toBe(fresh);
  });

  it("id 不匹配时原样返回", () => {
    const target = leaf("a");
    expect(splitLeaf(target, "nope", "vertical", leaf("b"))).toBe(target);
  });

  it("嵌套树里精准切分目标分支，未触及分支保持同一引用", () => {
    const a = leaf("a");
    const b = leaf("b");
    const root: PaneNode = { type: "split", id: "root", dir: "horizontal", ratio: 0.5, a, b };
    const next = splitLeaf(root, "b", "vertical", leaf("c"));
    expect(next).not.toBe(root);
    if (next.type !== "split") throw new Error("unreachable");
    expect(next.a).toBe(a);
    expect(next.b.type).toBe("split");
  });
});

describe("removeLeaf", () => {
  it("删除根叶子返回 null", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("删除一侧后提升另一侧", () => {
    const a = leaf("a");
    const b = leaf("b");
    const root: PaneNode = { type: "split", id: "root", dir: "horizontal", ratio: 0.5, a, b };
    expect(removeLeaf(root, "a")).toBe(b);
  });

  it("id 不匹配时原样返回", () => {
    const a = leaf("a");
    expect(removeLeaf(a, "zz")).toBe(a);
  });
});

describe("updateRatio", () => {
  const a = leaf("a");
  const b = leaf("b");
  const root: PaneNode = { type: "split", id: "s1", dir: "horizontal", ratio: 0.5, a, b };

  it("更新指定切分的比例", () => {
    const next = updateRatio(root, "s1", 0.7);
    if (next.type !== "split") throw new Error("unreachable");
    expect(next.ratio).toBe(0.7);
  });

  it("比例夹取在 0.15 ~ 0.85", () => {
    const lo = updateRatio(root, "s1", 0.01);
    const hi = updateRatio(root, "s1", 0.99);
    if (lo.type !== "split" || hi.type !== "split") throw new Error("unreachable");
    expect(lo.ratio).toBe(0.15);
    expect(hi.ratio).toBe(0.85);
  });
});

describe("collectLeaves / firstLeafId / replaceLeaf", () => {
  const a = leaf("a");
  const b = leaf("b");
  const c = leaf("c");
  const inner: PaneNode = { type: "split", id: "s2", dir: "vertical", ratio: 0.5, a: b, b: c };
  const root: PaneNode = { type: "split", id: "s1", dir: "horizontal", ratio: 0.5, a, b: inner };

  it("按渲染顺序（深度优先、先 a 后 b）收集叶子", () => {
    expect(collectLeaves(root).map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect(firstLeafId(root)).toBe("a");
  });

  it("replaceLeaf 替换指定窗格", () => {
    const next = replaceLeaf(root, "b", leaf("z"));
    expect(collectLeaves(next).map((l) => l.id)).toEqual(["a", "z", "c"]);
  });
});

describe("makeLeaf / defaultTitle", () => {
  it("makeLeaf 生成唯一 id", () => {
    expect(makeLeaf().id).not.toBe(makeLeaf().id);
  });

  it("SSH 用档案名、PTY 用序号作默认标题", () => {
    expect(defaultTitle({ kind: "ssh", profileId: "p1", name: "prod-web" }, 3)).toBe("prod-web");
    expect(defaultTitle({ kind: "pty" }, 3)).toBe("本地终端 3");
  });

  it("PTY 带显示名（本地 shell 主机）时优先用显示名", () => {
    expect(defaultTitle({ kind: "pty", name: "Git Bash" }, 3)).toBe("Git Bash");
  });

  it("串口标签默认标题为端口名", () => {
    const session = {
      port: "COM3",
      config: {
        baud_rate: 115200,
        data_bits: 8 as const,
        parity: "none" as const,
        stop_bits: 1 as const,
        flow_control: "none" as const,
        charset: "UTF-8",
      },
      lineMode: false,
      localEcho: false,
      backspaceBehavior: "default" as const,
      byteOrientedBackspace: false,
    };
    expect(defaultTitle({ kind: "serial", session }, 3)).toBe("串口 COM3");
    expect(defaultTitle({ kind: "serial", session, name: "开发板" }, 3)).toBe("开发板");
  });
});
