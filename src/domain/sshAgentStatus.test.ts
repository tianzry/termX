import { describe, expect, it } from "vitest";
import type { SshAgentStatus } from "../backend/client";
import { agentKindLabel, describeAgentStatus } from "./sshAgentStatus";

function status(partial: Partial<SshAgentStatus>): SshAgentStatus {
  return {
    running: false,
    kind: "none",
    path: "",
    identity_count: 0,
    error: null,
    ...partial,
  };
}

describe("describeAgentStatus", () => {
  it("named-pipe 运行中：标题运行中，明细展示 kind + 管道路径", () => {
    const text = describeAgentStatus(
      status({
        running: true,
        kind: "named-pipe",
        path: "\\\\.\\pipe\\openssh-ssh-agent",
        identity_count: 2,
      }),
    );
    expect(text.title).toBe("运行中");
    expect(text.detail).toBe("命名管道 · \\\\.\\pipe\\openssh-ssh-agent");
  });

  it("未运行且带 error：明细给简短错误原因", () => {
    const text = describeAgentStatus(
      status({
        running: false,
        kind: "unix-socket",
        path: "/tmp/agent.sock",
        error: "connection refused",
      }),
    );
    expect(text.title).toBe("未运行");
    expect(text.detail).toBe("connection refused");
  });

  it("pageant 运行中：path 恒为 pageant，明细不重复拼接", () => {
    const text = describeAgentStatus(
      status({ running: true, kind: "pageant", path: "pageant", identity_count: 1 }),
    );
    expect(text.title).toBe("运行中");
    expect(text.detail).toBe("Pageant");
  });

  it("unix-socket 运行中：明细展示 kind + socket 路径", () => {
    const text = describeAgentStatus(
      status({ running: true, kind: "unix-socket", path: "/tmp/ssh-agent.sock" }),
    );
    expect(text.detail).toBe("Unix Socket · /tmp/ssh-agent.sock");
  });

  it("未运行且无 error：提示未发现可用 agent", () => {
    const text = describeAgentStatus(status({ running: false, kind: "none" }));
    expect(text.title).toBe("未运行");
    expect(text.detail).toBe("未发现可用的 SSH Agent");
  });
});

describe("agentKindLabel", () => {
  it("覆盖全部 kind", () => {
    expect(agentKindLabel("unix-socket")).toBe("Unix Socket");
    expect(agentKindLabel("named-pipe")).toBe("命名管道");
    expect(agentKindLabel("pageant")).toBe("Pageant");
    expect(agentKindLabel("none")).toBe("无");
  });
});
