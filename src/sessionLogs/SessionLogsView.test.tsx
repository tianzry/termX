import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLog } from "../backend/client";

const api = vi.hoisted(() => ({
  listSessionLogs: vi.fn(),
  getSessionLog: vi.fn(),
  openSessionLog: vi.fn(),
  revealSessionLog: vi.fn(),
  pickSessionLogExportFile: vi.fn(),
  exportSessionLogToFile: vi.fn(),
  deleteSessionLog: vi.fn(),
}));

vi.mock("../backend/client", () => api);

import { SessionLogsView } from "./SessionLogsView";

const log: SessionLog = {
  id: "log:big.log",
  session_id: "s1",
  host_id: null,
  host_name: "129",
  title: "big",
  format: "text",
  path: "big.log",
  started_at: new Date("2026-11-08T08:50:47").getTime(),
  ended_at: new Date("2026-11-08T09:00:47").getTime(),
  duration_ms: 600_000,
  size_bytes: 5_784_162,
  event_count: 1,
  status: "complete",
};

describe("会话日志列表：不渲染正文，单击只选中", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listSessionLogs.mockResolvedValue([log]);
  });

  it("行展示文件名/主机/开始/结束/时长/大小，且点击不打开正文", async () => {
    render(<SessionLogsView />);
    const name = await screen.findByText("big.log");

    const row = name.closest(".session-logs-row") as HTMLElement;
    expect(within(row).getByText("129")).toBeTruthy();
    expect(within(row).getAllByText("2026-11-08")).toHaveLength(2);
    expect(within(row).getByText("5.5 MiB")).toBeTruthy();

    const started = performance.now();
    fireEvent.click(row);
    const elapsed = performance.now() - started;

    expect(row.className).toContain("selected");
    // 行单击绝不触发打开 / 读取正文。
    expect(api.openSessionLog).not.toHaveBeenCalled();
    expect(api.getSessionLog).not.toHaveBeenCalled();
    // 无 I/O 的选中应远低于一帧的耗时级别（放宽到 50ms 防止 CI 抖动）。
    expect(elapsed).toBeLessThan(50);
  });

  it("操作列四个按钮各自走对应后端能力", async () => {
    api.openSessionLog.mockResolvedValue(undefined);
    api.revealSessionLog.mockResolvedValue(undefined);
    api.pickSessionLogExportFile.mockResolvedValue("C:\\tmp\\big.txt");
    api.exportSessionLogToFile.mockResolvedValue(undefined);
    api.deleteSessionLog.mockResolvedValue(undefined);

    render(<SessionLogsView />);
    await screen.findByText("big.log");

    fireEvent.click(screen.getByLabelText("系统打开"));
    await waitFor(() => expect(api.openSessionLog).toHaveBeenCalledWith(log.id));

    fireEvent.click(screen.getByLabelText("打开所在文件夹"));
    await waitFor(() => expect(api.revealSessionLog).toHaveBeenCalledWith(log.id));

    fireEvent.click(screen.getByLabelText("导出"));
    await waitFor(() =>
      expect(api.exportSessionLogToFile).toHaveBeenCalledWith(
        log.id,
        "txt",
        "C:\\tmp\\big.txt",
      ),
    );

    fireEvent.click(screen.getByLabelText("删除"));
    fireEvent.click(await screen.findByText("删除", { selector: "button" }));
    await waitFor(() => expect(api.deleteSessionLog).toHaveBeenCalledWith(log.id));
    expect(api.listSessionLogs).toHaveBeenCalledTimes(2);
  });
});
