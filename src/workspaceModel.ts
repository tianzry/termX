/**
 * 工作区数据模型（对标 netcatty 的 workspace 领域模型）。
 *
 * - `Tab` = 一个标签，持有唯一「连接器」+ 一棵「分屏树」；
 * - 分屏树是二叉树：叶子是一格终端，节点是一次切分（方向 + 比例）；
 * - 同一标签内新增窗格复用该标签的连接器（SSH 用同一档案新建会话）。
 *
 * 全部是纯函数，便于持久化（localStorage）与单元验证。
 */

import type { SerialConfig } from "./backend/client";
import type { SerialBackspaceBehavior } from "./domain/serialFormConfig";

export type SplitDir = "horizontal" | "vertical";

/** 串口标签的连接参数（对齐 Netcatty SerialConfig；不含任何凭据）。 */
export interface SerialSessionConfig {
  port: string;
  config: SerialConfig;
  lineMode: boolean;
  localEcho: boolean;
  backspaceBehavior: SerialBackspaceBehavior;
  byteOrientedBackspace: boolean;
}

/** Telnet 标签的连接参数（对齐 Netcatty host 的 protocol=telnet；凭据可选）。 */
export interface TelnetSessionConfig {
  host: string;
  port: number;
  /** 发送回车时使用的行结束符（NVT 默认 CRLF）。 */
  inputNewline: "crlf" | "lf" | "cr";
  /** 自动登录用户名；与 password 都为空则不启用。 */
  username?: string;
  /** 自动登录密码；空串表示空密码设备（仍需填写用户名才启用）。 */
  password?: string;
}

export type Connector =
  | {
      kind: "pty";
      /** 本地 shell 主机：shell 命令快照；缺省 = 后端默认 shell。 */
      shell?: string;
      /** 本地 shell 主机：shell 启动参数快照。 */
      args?: string[];
      /** 本地 shell 主机：启动目录（`~` 由后端展开为主目录）。 */
      startDir?: string;
      /** 本地 shell 主机：显示名（标签标题）。 */
      name?: string;
    }
  | { kind: "ssh"; profileId: string; name: string }
  | { kind: "serial"; session: SerialSessionConfig; name?: string }
  | { kind: "telnet"; session: TelnetSessionConfig; name?: string };

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

/**
 * 窗格矩形（相对标签视图的比例，0~1）。
 *
 * 分屏渲染不再把终端组件嵌在布局树里：布局只产出每格的位置/尺寸，
 * 所有 TerminalPane 以 paneId 为 key 平铺在同一个容器中。这样 split /
 * close 改变树形状时，既有窗格的 React 实例不会被卸载重建（不重连）。
 */
export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PanePlacement {
  paneId: string;
  rect: PaneRect;
}

export interface SplitterPlacement {
  splitId: string;
  dir: SplitDir;
  /** 分隔条所在边界（left/top 为比例坐标）。 */
  rect: PaneRect;
}

/** 把分屏树展开为「窗格矩形 + 分隔条矩形」，深度优先先 a 后 b。 */
export function layoutPanePlacements(
  node: PaneNode,
  rect: PaneRect = { left: 0, top: 0, width: 1, height: 1 },
): { panes: PanePlacement[]; splitters: SplitterPlacement[] } {
  if (node.type === "leaf") {
    return { panes: [{ paneId: node.id, rect }], splitters: [] };
  }
  const horizontal = node.dir === "horizontal";
  const ratio = Math.min(0.85, Math.max(0.15, node.ratio));
  const aRect: PaneRect = horizontal
    ? { ...rect, width: rect.width * ratio }
    : { ...rect, height: rect.height * ratio };
  const bRect: PaneRect = horizontal
    ? {
        left: rect.left + rect.width * ratio,
        top: rect.top,
        width: rect.width * (1 - ratio),
        height: rect.height,
      }
    : {
        left: rect.left,
        top: rect.top + rect.height * ratio,
        width: rect.width,
        height: rect.height * (1 - ratio),
      };
  // 分隔条的 rect 覆盖整个切分区域（用于拖拽时换算比例），
  // 渲染层只取边界坐标 + 主轴长度。
  const splitterRect: PaneRect = horizontal
    ? {
        left: rect.left + rect.width * ratio,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }
    : {
        left: rect.left,
        top: rect.top + rect.height * ratio,
        width: rect.width,
        height: rect.height,
      };
  const a = layoutPanePlacements(node.a, aRect);
  const b = layoutPanePlacements(node.b, bRect);
  return {
    panes: [...a.panes, ...b.panes],
    splitters: [
      { splitId: node.id, dir: node.dir, rect: splitterRect },
      ...a.splitters,
      ...b.splitters,
    ],
  };
}

export function defaultTitle(
  connector: Connector,
  ptySeq: number,
): string {
  if (connector.kind === "ssh") return connector.name;
  if (connector.kind === "serial") {
    return connector.name || `串口 ${connector.session.port || ""}`.trim();
  }
  if (connector.kind === "telnet") {
    return connector.name || `Telnet ${connector.session.host}`.trim();
  }
  return connector.name || `本地终端 ${ptySeq}`;
}
