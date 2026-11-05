import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposeBar } from "./ComposeBar";

function renderBar(overrides: Partial<React.ComponentProps<typeof ComposeBar>> = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn(() => true);
  const onClose = vi.fn();
  const props: React.ComponentProps<typeof ComposeBar> = {
    value: "",
    onChange,
    onSend,
    onClose,
    history: [],
    connected: true,
    ...overrides,
  };
  const view = render(<ComposeBar {...props} />);
  const textarea = screen.getByRole("textbox", { name: "撰写栏" }) as HTMLTextAreaElement;
  return { ...view, props, onChange, onSend, onClose, textarea };
}

describe("ComposeBar", () => {
  it("挂载后自动聚焦输入框", async () => {
    const { textarea } = renderBar();
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it("Enter 发送成功：记录内容并清空草稿", () => {
    const { textarea, onChange, onSend } = renderBar({ value: "ls -la" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("ls -la");
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("发送被拒绝时保留草稿", () => {
    const onSend = vi.fn(() => false);
    const { textarea, onChange } = renderBar({ value: "keep-me", onSend });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("keep-me");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("未连接时 Enter 不发送、不清空", () => {
    const onSend = vi.fn(() => true);
    const { textarea, onChange } = renderBar({
      value: "draft",
      connected: false,
      onSend,
    });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Shift+Enter 仅换行，不发送", () => {
    const { textarea, onSend } = renderBar({ value: "a" });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("输入法组合态 Enter 不发送", () => {
    const { textarea, onSend } = renderBar({ value: "中文" });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Escape 与关闭按钮只收起，不清空草稿", () => {
    const { textarea, onClose, onChange } = renderBar({ value: "draft-keep" });
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "关闭撰写栏" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("↑ 在首行翻阅历史，回到草稿时恢复原文", () => {
    const onChange = vi.fn();
    const { textarea } = renderBar({
      value: "draft",
      onChange,
      history: ["one", "two"],
    });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("two");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("one");
  });
});
