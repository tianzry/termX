/**
 * 分屏回归：split / close 不得卸载既有窗格。
 *
 * 根因回顾：旧实现把 TerminalPane 嵌在递归布局树里，split（叶→div.split）
 * 或 close（div.split→叶）会改变同一位置的 React 元素类型，导致既有终端被
 * 卸载重建，onReady 再次触发 connect() → 后端重复 ssh_connect / 丢 scrollback。
 * 现在终端以 paneId 为 key 平铺在 `.pane-layer`，这里用 mock 组件统计挂载次数来锁住行为。
 */
import { act, render, waitFor } from "@testing-library/react";
import { createRef, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace, type WorkspaceHandle } from "./Workspace";

const { mountCounts } = vi.hoisted(() => ({
  mountCounts: new Map<string, number>(),
}));

vi.mock("./TerminalPane", () => ({
  TerminalPane: ({ paneId }: { paneId: string }) => {
    // 只在真正挂载时计数；组件函数体每次渲染都会执行，不能直接计数。
    useEffect(() => {
      mountCounts.set(paneId, (mountCounts.get(paneId) ?? 0) + 1);
    }, [paneId]);
    return <div data-testid={`pane-${paneId}`} />;
  },
}));

function paneIds(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='pane-']")).map(
    (node) => node.getAttribute("data-testid")!.slice("pane-".length),
  );
}

describe("Workspace 分屏实例稳定性", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mountCounts.clear();
  });

  it("分屏只挂载新窗格，原窗格实例不重建；关闭新窗格也不影响原窗格", async () => {
    const ref = createRef<WorkspaceHandle>();
    render(
      <Workspace
        ref={ref}
        onActivePane={() => {}}
        onStatus={() => {}}
      />,
    );

    act(() => ref.current!.newTab({ kind: "pty" }));
    await waitFor(() => expect(paneIds()).toHaveLength(1));
    const firstPaneId = paneIds()[0];
    expect(mountCounts.get(firstPaneId)).toBe(1);

    act(() => ref.current!.split("horizontal"));
    await waitFor(() => expect(paneIds()).toHaveLength(2));

    const newPaneId = paneIds().find((id) => id !== firstPaneId)!;
    expect(newPaneId).toBeTruthy();
    // 原窗格仍是第一次挂载的实例，没有因为布局树变化被卸载重建。
    expect(mountCounts.get(firstPaneId)).toBe(1);
    expect(mountCounts.get(newPaneId)).toBe(1);

    // closeActivePane 关闭的是分屏后激活的新窗格。
    act(() => ref.current!.closePane());
    await waitFor(() => expect(paneIds()).toEqual([firstPaneId]));
    expect(mountCounts.get(firstPaneId)).toBe(1);
    expect(mountCounts.get(newPaneId)).toBe(1);
  });

  it("上下分屏与再次分屏同样不重建既有窗格", async () => {
    const ref = createRef<WorkspaceHandle>();
    render(
      <Workspace
        ref={ref}
        onActivePane={() => {}}
        onStatus={() => {}}
      />,
    );

    act(() => ref.current!.newTab({ kind: "pty" }));
    await waitFor(() => expect(paneIds()).toHaveLength(1));
    const firstPaneId = paneIds()[0];

    act(() => ref.current!.split("vertical"));
    await waitFor(() => expect(paneIds()).toHaveLength(2));
    const secondPaneId = paneIds().find((id) => id !== firstPaneId)!;
    expect(mountCounts.get(firstPaneId)).toBe(1);

    act(() => ref.current!.split("horizontal"));
    await waitFor(() => expect(paneIds()).toHaveLength(3));
    expect(mountCounts.get(firstPaneId)).toBe(1);
    expect(mountCounts.get(secondPaneId)).toBe(1);
  });
});
