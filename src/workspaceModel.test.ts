import { describe, expect, it } from "vitest";
import {
  collectLeaves,
  defaultTitle,
  firstLeafId,
  layoutPanePlacements,
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

describe("layoutPanePlacements", () => {
  it("单叶占满整个视图", () => {
    const result = layoutPanePlacements(leaf("a"));
    expect(result.panes).toEqual([
      { paneId: "a", rect: { left: 0, top: 0, width: 1, height: 1 } },
    ]);
    expect(result.splitters).toEqual([]);
  });

  it("左右分屏按比例切分，分隔条落在边界", () => {
    const root: PaneNode = {
      type: "split",
      id: "s1",
      dir: "horizontal",
      ratio: 0.4,
      a: leaf("a"),
      b: leaf("b"),
    };
    const result = layoutPanePlacements(root);
    expect(result.panes.map((p) => p.paneId)).toEqual(["a", "b"]);
    expect(result.panes[0].rect).toEqual({ left: 0, top: 0, width: 0.4, height: 1 });
    expect(result.panes[1].rect.left).toBeCloseTo(0.4);
    expect(result.panes[1].rect.width).toBeCloseTo(0.6);
    expect(result.splitters[0]).toMatchObject({
      splitId: "s1",
      dir: "horizontal",
      rect: { left: 0.4, top: 0, width: 1, height: 1 },
    });
  });

  it("上下分屏与嵌套切分的矩形和分隔条位置正确", () => {
    const root: PaneNode = {
      type: "split",
      id: "s1",
      dir: "vertical",
      ratio: 0.5,
      a: leaf("a"),
      b: {
        type: "split",
        id: "s2",
        dir: "horizontal",
        ratio: 0.5,
        a: leaf("b"),
        b: leaf("c"),
      },
    };
    const result = layoutPanePlacements(root);
    expect(result.panes.map((p) => p.paneId)).toEqual(["a", "b", "c"]);
    expect(result.panes[0].rect).toEqual({ left: 0, top: 0, width: 1, height: 0.5 });
    expect(result.panes[1].rect).toMatchObject({
      left: 0,
      top: 0.5,
      width: 0.5,
      height: 0.5,
    });
    expect(result.panes[2].rect.left).toBeCloseTo(0.5);
    expect(result.splitters.map((s) => s.splitId)).toEqual(["s1", "s2"]);
    expect(result.splitters[0].rect).toMatchObject({ left: 0, top: 0.5, width: 1 });
    expect(result.splitters[1].rect.left).toBeCloseTo(0.5);
    expect(result.splitters[1].rect.top).toBeCloseTo(0.5);
  });

  it("split/close 后既有 pane id 保持不变（实例可复用）", () => {
    const original = leaf("a");
    const split = splitLeaf(original, "a", "horizontal", leaf("b"));
    expect(layoutPanePlacements(split).panes.map((p) => p.paneId)).toEqual([
      "a",
      "b",
    ]);
    const closed = removeLeaf(split, "b");
    expect(closed).toBe(original);
    expect(layoutPanePlacements(closed!).panes.map((p) => p.paneId)).toEqual(["a"]);
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

  it("Telnet 标签默认标题为主机名", () => {
    const session = { host: "10.0.0.5", port: 23, inputNewline: "crlf" as const };
    expect(defaultTitle({ kind: "telnet", session }, 3)).toBe("Telnet 10.0.0.5");
    expect(defaultTitle({ kind: "telnet", session, name: "交换机" }, 3)).toBe(
      "交换机",
    );
  });
});
