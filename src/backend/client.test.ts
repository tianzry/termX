import { beforeEach, describe, expect, it, vi } from "vitest";

// 前端测试不接触真实 Tauri 运行时：invoke/listen 全部 mock，
// 只验证桥接层的参数形状与编解码（R1 的唯一 IO 边界）。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  bytesToText,
  decodeBase64,
  localHome,
  localListDir,
  localListDrives,
  localMkdir,
  localReadFile,
  localRealpath,
  localRemove,
  localRename,
  localStat,
  localWriteFile,
  onAuthPrompt,
  onSftpQueueChanged,
  onSftpTransferUpdated,
  onTerminalData,
  ptySpawn,
  pickManualSessionLogPath,
  sftpLstat,
  sftpRealpath,
  sftpResolveConflict,
  sessionLogStatus,
  startSessionLog,
  stopSessionLog,
  sftpTransferEnqueue,
  sftpTransferPause,
  sftpTransferSetConcurrency,
  sshAgentStatus,
  sshConnect,
  sshDisconnect,
  sshWrite,
} from "./client";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockedListen = listen as unknown as ReturnType<typeof vi.fn>;

/** 用 jsdom 自带的 btoa 构造 base64（先经 TextEncoder 转 UTF-8 字节）。 */
const b64Of = (text: string): string =>
  btoa(String.fromCharCode(...Array.from(new TextEncoder().encode(text))));

describe("字节编解码", () => {
  it("decodeBase64 + bytesToText 还原 UTF-8 多字节文本", () => {
    const bytes = decodeBase64(b64Of("你好 termX"));
    expect(bytesToText(Array.from(bytes))).toBe("你好 termX");
  });
});

describe("invoke 参数形状", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it("sshConnect 传入可注入的 sessionId（同时作为 prompt key 与 logSessionId）", async () => {
    mockedInvoke.mockResolvedValue("sid-1");
    const sid = await sshConnect("profile-1", 80, 24, "sid-1", { password: "pw" });
    expect(sid).toBe("sid-1");
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_connect", {
      profileId: "profile-1",
      logSessionId: "sid-1",
      cols: 80,
      rows: 24,
      sessionId: "sid-1",
      authOverride: { password: "pw" },
    });
  });

  it("sshConnect 不带 authOverride 时传 null 而非 undefined", async () => {
    mockedInvoke.mockResolvedValue("sid-2");
    await sshConnect("profile-1", 80, 24, "sid-2");
    const args = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(args.authOverride).toBeNull();
  });

  it("sshWrite 上行把文本转成 UTF-8 number 数组并透传编码", async () => {
    await sshWrite("sid-1", "AB中");
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_write", {
      sessionId: "sid-1",
      data: [65, 66, 228, 184, 173],
      encoding: null,
    });
    await sshWrite("sid-1", "AB中", "gb18030");
    expect(mockedInvoke).toHaveBeenLastCalledWith("ssh_write", {
      sessionId: "sid-1",
      data: [65, 66, 228, 184, 173],
      encoding: "gb18030",
    });
  });

  it("ptySpawn 显式传 sessionId: null（由后端分配）", async () => {
    await ptySpawn(120, 30);
    expect(mockedInvoke).toHaveBeenCalledWith("pty_spawn", {
      cols: 120,
      rows: 30,
      sessionId: null,
      shell: null,
      args: null,
      startDir: null,
    });
  });

  it("ptySpawn 本地主机透传 shell / args / startDir", async () => {
    await ptySpawn(80, 24, {
      shell: "wsl.exe",
      args: ["-d", "Ubuntu"],
      startDir: "~",
    });
    expect(mockedInvoke).toHaveBeenCalledWith("pty_spawn", {
      cols: 80,
      rows: 24,
      sessionId: null,
      shell: "wsl.exe",
      args: ["-d", "Ubuntu"],
      startDir: "~",
    });
  });

  it("sshDisconnect 带 tabId: null 兜底", async () => {
    await sshDisconnect("sid-1");
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_disconnect", {
      sessionId: "sid-1",
      tabId: null,
    });
  });

  it("sshAgentStatus 无参调用，返回形状原样透传（后端不抛错）", async () => {
    const payload = {
      running: true,
      kind: "named-pipe",
      path: "\\\\.\\pipe\\openssh-ssh-agent",
      identity_count: 3,
      error: null,
    };
    mockedInvoke.mockResolvedValue(payload);
    await expect(sshAgentStatus()).resolves.toEqual(payload);
    expect(mockedInvoke).toHaveBeenCalledWith("ssh_agent_status");
  });

  it("invoke 拒绝时原样抛出后端错误（供上层 decodeAppError 解析）", async () => {
    const raw = '__rssh_err__|{"code":"ssh_auth_failed"}';
    mockedInvoke.mockRejectedValue(new Error(raw));
    await expect(sshConnect("p", 80, 24, "sid-x")).rejects.toThrow(raw);
  });
});

describe("事件订阅", () => {
  beforeEach(() => mockedListen.mockReset());

  it("onTerminalData 监听 <domain>:data:<id> 并解码 base64 下行载荷", async () => {
    let event = "";
    let handler: (ev: { payload: string }) => void = () => {};
    mockedListen.mockImplementation((ev: string, h: unknown) => {
      event = ev;
      handler = h as (ev: { payload: string }) => void;
      return Promise.resolve(() => {});
    });
    const received: Uint8Array[] = [];
    await onTerminalData("ssh", "sid-9", (bytes) => received.push(bytes));
    expect(event).toBe("ssh:data:sid-9");
    handler({ payload: b64Of("hi") });
    expect(bytesToText(Array.from(received[0]))).toBe("hi");
  });

  it("onAuthPrompt 监听 ssh:auth_prompt:<id> 并透传载荷", async () => {
    let event = "";
    let handler: (ev: { payload: unknown }) => void = () => {};
    mockedListen.mockImplementation((ev: string, h: unknown) => {
      event = ev;
      handler = h as (ev: { payload: unknown }) => void;
      return Promise.resolve(() => {});
    });
    const prompts: unknown[] = [];
    await onAuthPrompt("sid-9", (p) => prompts.push(p));
    expect(event).toBe("ssh:auth_prompt:sid-9");
    const payload = {
      name: "kb",
      instructions: "",
      prompts: [{ prompt: "Password: ", echo: false }],
    };
    handler({ payload });
    expect(prompts).toEqual([payload]);
  });
});

describe("本地文件系统 / SFTP 新封装的参数形状", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it("localHome / localListDrives 无参", async () => {
    await localHome();
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_home");
    await localListDrives();
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_list_drives");
  });

  it("localListDir / localRealpath / localMkdir 传 path", async () => {
    await localListDir("C:\\tmp");
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_list_dir", {
      path: "C:\\tmp",
    });
    await localRealpath("/a");
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_realpath", {
      path: "/a",
    });
    await localMkdir("/a/b");
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_mkdir", {
      path: "/a/b",
    });
  });

  it("localStat follow 缺省传 null，显式 false 透传", async () => {
    await localStat("/a");
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_stat", {
      path: "/a",
      follow: null,
    });
    await localStat("/a", false);
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_stat", {
      path: "/a",
      follow: false,
    });
  });

  it("localRename 传 oldPath / newPath", async () => {
    await localRename("/a", "/b");
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_rename", {
      oldPath: "/a",
      newPath: "/b",
    });
  });

  it("localRemove 守卫 expectedType 恒传", async () => {
    await localRemove("/a", "file");
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_remove", {
      path: "/a",
      expectedType: "file",
    });
  });

  it("localReadFile maxBytes 缺省传 null，给值透传", async () => {
    await localReadFile("/a");
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_read_file", {
      path: "/a",
      maxBytes: null,
    });
    await localReadFile("/a", 1024);
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_read_file", {
      path: "/a",
      maxBytes: 1024,
    });
  });

  it("localWriteFile 把 Uint8Array 转成 number 数组", async () => {
    await localWriteFile("/a", Uint8Array.from([1, 2]));
    expect(mockedInvoke).toHaveBeenLastCalledWith("local_write_file", {
      path: "/a",
      data: [1, 2],
    });
  });

  it("sftpLstat / sftpRealpath 传 sftpId + path", async () => {
    await sftpLstat("s1", "/x");
    expect(mockedInvoke).toHaveBeenLastCalledWith("sftp_lstat", {
      sftpId: "s1",
      path: "/x",
    });
    await sftpRealpath("s1", ".");
    expect(mockedInvoke).toHaveBeenLastCalledWith("sftp_realpath", {
      sftpId: "s1",
      path: ".",
    });
  });
});

describe("SFTP 传输队列命令与事件", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
    mockedListen.mockReset();
    mockedListen.mockResolvedValue(() => {});
  });

  it("sftpTransferEnqueue 以 { items } 传入，嵌套字段保持 snake_case（R3）", async () => {
    mockedInvoke.mockResolvedValue([]);
    await sftpTransferEnqueue([
      {
        sftp_id: "s1",
        direction: "upload",
        local_path: "C:\\a.txt",
        remote_path: "/a.txt",
        size: 10,
        priority: "high",
      },
    ]);
    expect(mockedInvoke).toHaveBeenCalledWith("sftp_transfer_enqueue", {
      items: [
        {
          sftp_id: "s1",
          direction: "upload",
          local_path: "C:\\a.txt",
          remote_path: "/a.txt",
          size: 10,
          priority: "high",
        },
      ],
    });
  });

  it("pause / set_concurrency / resolve_conflict 顶层参数走 camelCase", async () => {
    await sftpTransferPause("t1");
    expect(mockedInvoke).toHaveBeenLastCalledWith("sftp_transfer_pause", {
      transferId: "t1",
    });
    await sftpTransferSetConcurrency(4);
    expect(mockedInvoke).toHaveBeenLastCalledWith("sftp_transfer_set_concurrency", {
      concurrency: 4,
    });
    await sftpResolveConflict("t1", "rename", true);
    expect(mockedInvoke).toHaveBeenLastCalledWith("sftp_transfer_resolve_conflict", {
      transferId: "t1",
      action: "rename",
      applyToAll: true,
    });
  });

  it("事件订阅键与约定一致（queue_changed / transfer_updated:<id>）", async () => {
    await onSftpQueueChanged(() => {});
    expect(mockedListen).toHaveBeenLastCalledWith(
      "sftp:queue_changed",
      expect.any(Function),
    );
    await onSftpTransferUpdated("t9", () => {});
    expect(mockedListen).toHaveBeenLastCalledWith(
      "sftp:transfer_updated:t9",
      expect.any(Function),
    );
  });
});

describe("会话日志录制命令", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it("start_session_log 传 sessionId / title / cols / rows", async () => {
    await startSessionLog("s1", "prod", 120, 30);
    expect(mockedInvoke).toHaveBeenLastCalledWith("start_session_log", {
      sessionId: "s1",
      title: "prod",
      cols: 120,
      rows: 30,
    });
  });

  it("stop_session_log 只传 sessionId", async () => {
    await stopSessionLog("s1");
    expect(mockedInvoke).toHaveBeenLastCalledWith("stop_session_log", {
      sessionId: "s1",
    });
  });

  it("session_log_status 拒绝时向上抛出（由调用方静默处理）", async () => {
    mockedInvoke.mockRejectedValueOnce("session_not_found");
    await expect(sessionLogStatus("s1")).rejects.toBe("session_not_found");
    expect(mockedInvoke).toHaveBeenLastCalledWith("session_log_status", {
      sessionId: "s1",
    });
  });
});

describe("手动会话日志保存路径", () => {
  const mockedSave = saveFileDialog as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedSave.mockReset();
    mockedSave.mockResolvedValue("C:\\Users\\x\\a.txt");
  });

  it("默认路径落在应用 recordings 目录", async () => {
    mockedInvoke.mockResolvedValueOnce("C:\\Users\\x\\.rssh\\recordings");
    await pickManualSessionLogPath("129_2026-11-03T23-43-06.txt", "txt");
    expect(mockedSave).toHaveBeenLastCalledWith({
      title: "保存会话日志",
      defaultPath: "C:\\Users\\x\\.rssh\\recordings\\129_2026-11-03T23-43-06.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
  });

  it("recordings 目录不可用时退回主目录", async () => {
    mockedInvoke
      .mockRejectedValueOnce("recordings_dir_unavailable")
      .mockResolvedValueOnce("C:\\Users\\x");
    await pickManualSessionLogPath("a.txt", "txt");
    expect(mockedSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: "C:\\Users\\x\\a.txt" }),
    );
  });

  it("两个目录都不可用时退回仅文件名", async () => {
    mockedInvoke.mockRejectedValue("home_dir_unavailable");
    await pickManualSessionLogPath("a.txt", "txt");
    expect(mockedSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultPath: "a.txt" }),
    );
  });
});
