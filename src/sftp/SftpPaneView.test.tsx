/** 右键菜单回归：行右键不得被列表容器的空白菜单覆盖。 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SftpPaneView } from "./SftpPaneView";

vi.mock("../backend/client", () => ({
  localListDir: vi.fn(),
  localRename: vi.fn(),
  onSftpTransferUpdated: vi.fn(async () => () => {}),
}));

import * as api from "../backend/client";

const LOCAL = {
  kind: "local" as const,
  label: "本地",
  path: "C:\\tmp",
  os: "windows" as const,
};

beforeEach(() => {
  vi.mocked(api.localRename).mockReset();
  vi.mocked(api.localListDir).mockResolvedValue([
    {
      name: "sample.tar.gz",
      kind: "file",
      size: 118,
      mtime: 0,
      hidden: false,
    },
  ]);
});

describe("SftpPaneView 右键菜单", () => {
  it("行右键显示行菜单，且不被列表空白菜单覆盖", async () => {
    render(<SftpPaneView connection={LOCAL} onPathChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("sample.tar.gz")).toBeInTheDocument());

    fireEvent.contextMenu(
      document.querySelector('[data-sftp-row="sample.tar.gz"]') as HTMLElement,
    );

    expect(screen.getByText("解压到当前目录")).toBeInTheDocument();
    expect(screen.queryByText("刷新")).not.toBeInTheDocument();
  });

  it("空白区右键显示空白菜单", async () => {
    render(<SftpPaneView connection={LOCAL} onPathChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("sample.tar.gz")).toBeInTheDocument());

    fireEvent.contextMenu(document.querySelector(".nc-sftp-pane-list") as HTMLElement);

    expect(screen.getByText("刷新")).toBeInTheDocument();
    expect(screen.queryByText("解压到当前目录")).not.toBeInTheDocument();
  });

  it("重命名名称未变时视为取消，不发请求、不报错", async () => {
    render(<SftpPaneView connection={LOCAL} onPathChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("sample.tar.gz")).toBeInTheDocument());

    fireEvent.contextMenu(
      document.querySelector('[data-sftp-row="sample.tar.gz"]') as HTMLElement,
    );
    fireEvent.click(screen.getByText("重命名"));
    // 输入框保留原名，直接确认 → 取消（对齐 Netcatty）。
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));

    expect(api.localRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("SftpPaneView 大目录虚拟滚动", () => {
  it("超过阈值只渲染视口窗口，滚动后换窗口", async () => {
    vi.mocked(api.localListDir).mockResolvedValue(
      Array.from({ length: 500 }, (_, i) => ({
        name: `f${i}.txt`,
        kind: "file" as const,
        size: 1,
        mtime: 0,
        hidden: false,
      })),
    );
    render(<SftpPaneView connection={LOCAL} onPathChange={() => {}} />);
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-sftp-row]').length,
      ).toBeGreaterThan(0),
    );
    // 1 万行时代全量渲染会卡死；虚拟滚动只应挂载视口 + overscan。
    expect(document.querySelectorAll('[data-sftp-row]').length).toBeLessThan(500);

    const names = () =>
      [...document.querySelectorAll('[data-sftp-row]')].map((r) =>
        r.getAttribute("data-sftp-row"),
      );
    const before = names();
    const list = document.querySelector(".nc-sftp-pane-list") as HTMLElement;
    list.scrollTop = 28 * 200;
    fireEvent.scroll(list);
    await waitFor(() => expect(names()).not.toEqual(before));
    const maxIndex = Math.max(
      ...names().map((n) => Number((n || "").match(/^f(\d+)\.txt$/)?.[1] ?? -1)),
    );
    expect(maxIndex).toBeGreaterThan(150);
  });
});
