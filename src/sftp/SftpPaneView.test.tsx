/** 右键菜单回归：行右键不得被列表容器的空白菜单覆盖。 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SftpPaneView } from "./SftpPaneView";

vi.mock("../backend/client", () => ({
  localListDir: vi.fn(),
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
});
