import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpApprovalHost } from "./McpApprovalHost";
import * as api from "../backend/client";

const listeners = vi.hoisted(
  () => new Map<string, (event: { payload: unknown }) => void>(),
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

vi.mock("../backend/client", () => ({
  mcpApprovalPending: vi.fn(),
  mcpApprovalResolve: vi.fn(),
}));

vi.mock("../settings/settingsStore", () => ({
  useSettings: () => ({ language: "zh" }),
}));

const pending = {
  approvalId: "a1",
  toolName: "terminal_execute",
  argsSummary: "whoami",
  sessionId: "sess-1",
  targetLabel: "ssh · sess-1",
  timeoutMs: 110_000,
  createdAtMs: Date.now(),
};

beforeEach(() => {
  listeners.clear();
  vi.mocked(api.mcpApprovalPending).mockResolvedValue([pending]);
  vi.mocked(api.mcpApprovalResolve).mockResolvedValue(true);
});

describe("McpApprovalHost", () => {
  it("展示待审批项并提交「允许一次」", async () => {
    render(<McpApprovalHost />);

    expect(await screen.findByText("terminal_execute")).toBeTruthy();
    expect(screen.getByText("whoami")).toBeTruthy();
    expect(screen.getByText(/ssh · sess-1/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await waitFor(() =>
      expect(api.mcpApprovalResolve).toHaveBeenCalledWith("a1", "once"),
    );
    await waitFor(() => expect(screen.queryByText("terminal_execute")).toBeNull());
  });

  it("「一律许可」沉淀放行规则并提交 always", async () => {
    render(<McpApprovalHost />);
    await screen.findByText("terminal_execute");

    fireEvent.click(screen.getByRole("button", { name: "一律许可" }));
    await waitFor(() =>
      expect(api.mcpApprovalResolve).toHaveBeenCalledWith("a1", "always"),
    );
  });

  it("「拒绝」提交，并响应 cleared 事件移除卡片", async () => {
    render(<McpApprovalHost />);
    await screen.findByText("terminal_execute");

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(api.mcpApprovalResolve).toHaveBeenCalledWith("a1", "reject"),
    );

    act(() => {
      listeners.get("mcp:approval-cleared")?.({
        payload: { approvalIds: ["a1"], reason: "timeout" },
      });
    });
    await waitFor(() => expect(screen.queryByText("terminal_execute")).toBeNull());
  });
});
