/**
 * 工作区数据模型（对标 netcatty 的 workspace 领域模型）。
 *
 * - `Tab` = 一个标签，持有唯一「连接器」+ 一棵「分屏树」；
 * - 分屏树是二叉树：叶子是一格终端，节点是一次切分（方向 + 比例）；
 * - 同一标签内新增窗格复用该标签的连接器（SSH 用同一档案新建会话）。
 *
 * 全部是纯函数，便于持久化（localStorage）与单元验证。
 */

export type SplitDir = "horizontal" | "vertical";

export type Connector =
  | { kind: "pty" }
  | { kind: "ssh"; profileId: string; name: string };

export interface LeafNode {
  type: "leaf";
  id: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  /** horizontal = 左右并排；vertical = 上下堆叠。 */
  dir: SplitDir;
  /** 第一格占主轴的比例，0.15 ~ 0.85。 */
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = LeafNode | SplitNode;

export interface Tab {
  id: string;
  title: string;
  layout: PaneNode;
  connector: Connector;
}

/**
 * 生成随机 id。`crypto.randomUUID()` 仅在安全上下文可用：
 * Tauri 的 WebView 满足，但浏览器里用 http://localhost:1420 调试时不是，
 * 因此回退到时间戳 + 随机数，保证开发环境也能操作。
 */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeLeaf(): LeafNode {
  return { type: "leaf", id: newId() };
}

/** 把 `leafId` 对应的叶子替换成「原叶子 | 新叶子」的切分。 */
export function splitLeaf(
  node: PaneNode,
  leafId: string,
  dir: SplitDir,
  leaf: LeafNode,
): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== leafId) return node;
    return { type: "split", id: newId(), dir, ratio: 0.5, a: node, b: leaf };
  }
  const a = splitLeaf(node.a, leafId, dir, leaf);
  if (a !== node.a) return { ...node, a };
  const b = splitLeaf(node.b, leafId, dir, leaf);
  if (b !== node.b) return { ...node, b };
  return node;
}

/** 删除叶子；该格是树根时返回 null，单边剩空时提升另一边。 */
export function removeLeaf(node: PaneNode, leafId: string): PaneNode | null {
  if (node.type === "leaf") return node.id === leafId ? null : node;
  const a = removeLeaf(node.a, leafId);
  const b = removeLeaf(node.b, leafId);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

export function replaceLeaf(
  node: PaneNode,
  leafId: string,
  next: PaneNode,
): PaneNode {
  if (node.type === "leaf") return node.id === leafId ? next : node;
  const a = replaceLeaf(node.a, leafId, next);
  if (a !== node.a) return { ...node, a };
  const b = replaceLeaf(node.b, leafId, next);
  if (b !== node.b) return { ...node, b };
  return node;
}

export function updateRatio(
  node: PaneNode,
  splitId: string,
  ratio: number,
): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) {
    return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  }
  const a = updateRatio(node.a, splitId, ratio);
  if (a !== node.a) return { ...node, a };
  const b = updateRatio(node.b, splitId, ratio);
  if (b !== node.b) return { ...node, b };
  return node;
}

/** 按渲染顺序（深度优先、先 a 后 b）收集叶子。 */
export function collectLeaves(node: PaneNode): LeafNode[] {
  if (node.type === "leaf") return [node];
  return [...collectLeaves(node.a), ...collectLeaves(node.b)];
}

export function firstLeafId(node: PaneNode): string {
  return collectLeaves(node)[0].id;
}

export function defaultTitle(
  connector: Connector,
  ptySeq: number,
): string {
  return connector.kind === "ssh" ? connector.name : `本地终端 ${ptySeq}`;
}
