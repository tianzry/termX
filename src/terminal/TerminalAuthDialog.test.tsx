import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalAuthDialog, type TerminalAuthDialogProps } from "./TerminalAuthDialog";

function makeProps(overrides: Partial<TerminalAuthDialogProps> = {}): TerminalAuthDialogProps {
  return {
    authMethod: "password",
    setAuthMethod: vi.fn(),
    authUsername: "root",
    setAuthUsername: vi.fn(),
    authPassword: "",
    setAuthPassword: vi.fn(),
    authKeyId: null,
    setAuthKeyId: vi.fn(),
    authPassphrase: "",
    setAuthPassphrase: vi.fn(),
    showAuthPassphrase: false,
    setShowAuthPassphrase: vi.fn(),
    showAuthPassword: false,
    setShowAuthPassword: vi.fn(),
    authRetryMessage: null,
    keys: [],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    isValid: true,
    ...overrides,
  };
}

describe("TerminalAuthDialog", () => {
  it("展示认证失败重试提示", () => {
    render(<TerminalAuthDialog {...makeProps({ authRetryMessage: "认证失败，请重试" })} />);
    expect(screen.getByText("认证失败，请重试")).toBeInTheDocument();
  });

  it("表单无效时禁用提交且 Enter 不触发提交", () => {
    const onSubmit = vi.fn();
    render(<TerminalAuthDialog {...makeProps({ isValid: false, onSubmit })} />);
    expect(screen.getByRole("button", { name: "继续" })).toBeDisabled();
    fireEvent.keyDown(screen.getByPlaceholderText("输入密码"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("有效时 Enter 与「继续」按钮都提交，caret「继续并保存」也提交", () => {
    const onSubmit = vi.fn();
    render(<TerminalAuthDialog {...makeProps({ onSubmit })} />);
    fireEvent.keyDown(screen.getByPlaceholderText("输入密码"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    // 分体按钮 caret 打开上拉菜单，「继续并保存」走 onSubmit（写回凭据槽位）。
    fireEvent.click(screen.getByRole("button", { name: "继续并保存" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "继续并保存" }));
    expect(onSubmit).toHaveBeenCalledTimes(3);
  });

  it("切到密钥方式且无密钥凭据时显示空态、口令输入禁用", () => {
    render(<TerminalAuthDialog {...makeProps({ authMethod: "key" })} />);
    expect(
      screen.getByText("暂无密钥，请先在钥匙串中添加。"),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("可选：所选私钥的密码短语"),
    ).toBeDisabled();
  });

  it("下拉选择密钥后回调所选 id", () => {
    const setAuthKeyId = vi.fn();
    render(
      <TerminalAuthDialog
        {...makeProps({
          authMethod: "key",
          setAuthKeyId,
          keys: [{ id: "k1", label: "id_ed25519", type: "key", username: "root" }],
        })}
      />,
    );
    // 字段 label 是「选择密钥」，下拉触发按钮文案是「选择 SSH密钥」（netcatty
    // hostForm.auth.selectKey 原文），用 role 精确定位按钮。
    fireEvent.click(screen.getByRole("button", { name: "选择 SSH密钥" }));
    fireEvent.click(screen.getByText("id_ed25519"));
    expect(setAuthKeyId).toHaveBeenCalledWith("k1");
  });

  it("「关闭」触发 onCancel", () => {
    const onCancel = vi.fn();
    render(<TerminalAuthDialog {...makeProps({ onCancel })} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
