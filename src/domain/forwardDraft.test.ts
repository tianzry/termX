import { describe, expect, it } from "vitest";
import { sshProfiles, validateForwardDraft, type ForwardDraft } from "./forwardDraft";
import type { ForwardRule, Profile } from "../backend/client";

const rule = (patch: Partial<ForwardRule> = {}): ForwardRule => ({
  type: "local",
  local_port: 18022,
  remote_host: "127.0.0.1",
  remote_port: 22,
  ...patch,
});

const draft = (patch: Partial<ForwardDraft> = {}): ForwardDraft => ({
  name: "跳板",
  profile_id: "p1",
  rules: [rule()],
  auto_start: false,
  auto_reconnect: null,
  ...patch,
});

const profile = (id: string, protocol: Profile["protocol"]): Profile =>
  ({ id, name: id, protocol }) as Profile;

describe("validateForwardDraft", () => {
  it("完整草稿通过", () => {
    expect(validateForwardDraft(draft())).toBeNull();
  });

  it("名称 / 档案 / 规则缺一不可", () => {
    expect(validateForwardDraft(draft({ name: "  " }))).toBe("请填写转发名称");
    expect(validateForwardDraft(draft({ profile_id: "" }))).toBe("请选择 SSH 会话档案");
    expect(validateForwardDraft(draft({ rules: [] }))).toBe("请至少添加一条转发规则");
  });

  it("本地端口 0 视为自动分配，超范围报错", () => {
    expect(validateForwardDraft(draft({ rules: [rule({ local_port: 0 })] }))).toBeNull();
    const bad = validateForwardDraft(draft({ rules: [rule({ local_port: 70000 })] }));
    expect(bad).toContain("本地端口");
  });

  it("local / remote 必须有远端主机与端口，dynamic 不需要", () => {
    for (const type of ["local", "remote"] as const) {
      expect(
        validateForwardDraft(draft({ rules: [rule({ type, remote_host: "" })] })),
      ).toContain("远端主机");
      expect(
        validateForwardDraft(draft({ rules: [rule({ type, remote_port: 0 })] })),
      ).toContain("远端端口");
    }
    expect(
      validateForwardDraft(
        draft({ rules: [rule({ type: "dynamic", remote_host: "", remote_port: 0 })] }),
      ),
    ).toBeNull();
  });

  it("监听地址允许为空与常见地址，拒绝空白 / 斜杠", () => {
    expect(validateForwardDraft(draft({ rules: [rule({ bind_address: "" })] }))).toBeNull();
    expect(
      validateForwardDraft(draft({ rules: [rule({ bind_address: "0.0.0.0" })] })),
    ).toBeNull();
    expect(
      validateForwardDraft(draft({ rules: [rule({ bind_address: "::1" })] })),
    ).toBeNull();
    expect(
      validateForwardDraft(draft({ rules: [rule({ bind_address: "127.0.0.1 80" })] })),
    ).toContain("监听地址");
  });

  it("错误信息带规则序号", () => {
    expect(validateForwardDraft(draft({ rules: [rule(), rule({ remote_port: 0 })] }))).toBe(
      "规则 2：远端端口需在 1-65535",
    );
  });
});

describe("sshProfiles", () => {
  it("过滤本地 shell 档案，保留 SSH 档案", () => {
    const list = [profile("ssh-1", "ssh"), profile("local-1", "local")];
    expect(sshProfiles(list).map((p) => p.id)).toEqual(["ssh-1"]);
  });
});
