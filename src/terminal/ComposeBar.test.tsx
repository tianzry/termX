import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snippet } from "../backend/client";
import { ComposeBar } from "./ComposeBar";

function snippet(id: string, name: string, command = name): Snippet {
  return {
    id,
    name,
    command,
    description: "",
    package: "",
    tags: [],
    shortkey: "",
    no_auto_run: false,
    kind: "snippet",
    multi_line_run_mode: "paste",
    language: "",
    trigger: "manual",
    trigger_pattern: "",
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

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

  it("Shift+Enter 只发送光标所在行，其余内容留在草稿", () => {
    const { textarea, onChange, onSend } = renderBar({ value: "one\ntwo\nthree" });
    textarea.setSelectionRange(5, 5);
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledWith("two");
    expect(onChange).toHaveBeenLastCalledWith("one\nthree");
  });

  it("Ctrl+Enter 在光标处换行，不发送", () => {
    const { textarea, onChange, onSend } = renderBar({ value: "ab" });
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("a\nb");
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

describe("ComposeBar 快捷片段条", () => {
  const snippets = [
    snippet("s1", "df -h", "df -h"),
    snippet("s2", "uptime", "uptime"),
  ];

  it("单击片段直接发送执行，不改草稿", async () => {
    const onRunSnippet = vi.fn(() => true);
    const onChange = vi.fn();
    renderBar({ value: "draft", onChange, snippets, onRunSnippet });
    fireEvent.click(await screen.findByRole("button", { name: "uptime" }));
    expect(onRunSnippet).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s2", command: "uptime" }),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Shift+点击只插入草稿，不发送", async () => {
    const onRunSnippet = vi.fn(() => true);
    const onChange = vi.fn();
    renderBar({ value: "pwd", onChange, snippets, onRunSnippet });
    const chip = await screen.findByRole("button", { name: "uptime" });
    fireEvent.click(chip, { shiftKey: true });
    expect(onRunSnippet).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("pwd\nuptime");
  });

  it("未连接时单击片段退回插入草稿", async () => {
    const onRunSnippet = vi.fn(() => false);
    const onChange = vi.fn();
    renderBar({ value: "", onChange, snippets, onRunSnippet });
    fireEvent.click(await screen.findByRole("button", { name: "df -h" }));
    expect(onRunSnippet).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("df -h");
  });

  it("含 {{变量}} 的片段交给父级填值：单击=发送、Shift+单击=插入", async () => {
    const varsSnippets = [snippet("s3", "greet", "echo {{name}}")];
    const onRunSnippet = vi.fn(() => true);
    const onSnippetVariables = vi.fn();
    const onChange = vi.fn();
    renderBar({ value: "keep", onChange, snippets: varsSnippets, onRunSnippet, onSnippetVariables });
    const chip = await screen.findByRole("button", { name: "greet" });
    fireEvent.click(chip);
    expect(onSnippetVariables).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "s3" }),
      "send",
    );
    fireEvent.click(chip, { shiftKey: true });
    expect(onSnippetVariables).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "s3" }),
      "insert",
    );
    expect(onRunSnippet).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("管理浮层搜索过滤，点击行切换固定状态", async () => {
    const { container } = renderBar({ snippets });
    fireEvent.click(await screen.findByRole("button", { name: "管理快捷片段" }));
    const search = screen.getByRole("textbox", { name: "搜索片段" });
    fireEvent.change(search, { target: { value: "upt" } });
    const popover = container.querySelector(".term-compose-snippet-popover");
    expect(popover).not.toBeNull();
    expect(popover).toHaveTextContent("uptime");
    expect(popover).not.toHaveTextContent("df -h");
    fireEvent.click(
      within(popover as HTMLElement).getByRole("button", { name: "uptime" }),
    );
    // 取消固定后，顶部只剩 df -h 的 chip。
    await waitFor(() => {
      const chips = container.querySelectorAll(".term-compose-chip");
      expect(chips).toHaveLength(1);
      expect(chips[0]).toHaveTextContent("df -h");
    });
  });
});
