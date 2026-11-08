import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScriptRunPanel, type TmxScriptViewState } from "./ScriptRunPanel";

function state(overrides: Partial<TmxScriptViewState> = {}): TmxScriptViewState {
  return {
    runId: "run-1",
    name: "巡检",
    status: "running",
    logs: ["→ sendLine: uname -a"],
    ...overrides,
  };
}

describe("ScriptRunPanel", () => {
  it("运行中：显示名称与状态，可停止但不可关闭", () => {
    const onStop = vi.fn();
    const onDismiss = vi.fn();
    render(<ScriptRunPanel state={state()} onStop={onStop} onDismiss={onDismiss} />);

    expect(screen.getByText(/「巡检」运行中/)).toBeTruthy();
    const stop = screen.getByRole("button", { name: "停止" });
    const dismiss = screen.getByRole("button", { name: "关闭" });
    expect(stop).toBeEnabled();
    expect(dismiss).toBeDisabled();

    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("结束后可关闭，并展示失败原因与日志", () => {
    const onDismiss = vi.fn();
    render(
      <ScriptRunPanel
        state={state({ status: "failed", error: "没有心跳", logs: ["开始", "失败"] })}
        onStop={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText(/「巡检」失败/)).toBeTruthy();
    expect(screen.getByText("没有心跳")).toBeTruthy();
    expect(screen.getByLabelText("脚本日志").textContent).toContain("开始");

    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
