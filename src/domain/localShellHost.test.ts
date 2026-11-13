import { describe, expect, it } from "vitest";
import type { DiscoveredShell, Profile } from "../backend/client";
import {
  createLocalShellHost,
  getLocalShellHostSubtitle,
  getVaultHostRowSubtitle,
  LOCAL_SHELL_HOST_TAG,
  resolveHostDefaultLocalShell,
  resolveShellSetting,
} from "./localShellHost";

const SHELLS: DiscoveredShell[] = [
  {
    id: "cmd",
    name: "CMD",
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [],
    icon: "cmd",
    is_default: false,
  },
  {
    id: "pwsh",
    name: "PowerShell 7",
    command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: ["-NoLogo"],
    icon: "pwsh",
    is_default: true,
  },
  {
    id: "wsl-ubuntu",
    name: "Ubuntu (WSL)",
    command: "C:\\Windows\\System32\\wsl.exe",
    args: ["-d", "Ubuntu"],
    icon: "ubuntu",
    is_default: false,
  },
];

function localProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "l1",
    name: "项目 A · CMD",
    host: "localhost",
    port: 22,
    credential_id: "",
    bastion_profile_id: null,
    init_command: null,
    group_id: null,
    agent_forwarding: false,
    protocol: "local",
    local_shell: null,
    local_shell_args: null,
    local_shell_name: null,
    local_shell_icon: null,
    local_start_dir: null,
    ...overrides,
  };
}

describe("createLocalShellHost", () => {
  it("名称回退链：输入 → shell 显示名 → Local Shell", () => {
    expect(createLocalShellHost({ name: " 项目 A · CMD " }).name).toBe(
      "项目 A · CMD",
    );
    expect(createLocalShellHost({ shellName: "CMD" }).name).toBe("CMD");
    expect(createLocalShellHost({}).name).toBe("Local Shell");
  });

  it("host 固定 localhost、protocol 固定 local、凭据为空", () => {
    const p = createLocalShellHost({ name: "x" });
    expect(p.host).toBe("localhost");
    expect(p.protocol).toBe("local");
    expect(p.credential_id).toBe("");
  });

  it("空 shell 存 undefined；参数/目录去空白后空值不入库", () => {
    const p = createLocalShellHost({
      shell: "   ",
      shellArgs: [],
      startDir: "  ",
      groupId: "  ",
    });
    expect(p.local_shell).toBeUndefined();
    expect(p.local_shell_args).toBeUndefined();
    expect(p.local_start_dir).toBeUndefined();
    expect(p.group_id).toBeNull();
  });

  it("保留选中 shell 的元数据快照", () => {
    const p = createLocalShellHost({
      id: "keep",
      name: "WSL",
      shell: "wsl-ubuntu",
      shellArgs: ["-d", "Ubuntu"],
      shellName: "Ubuntu (WSL)",
      shellIcon: "ubuntu",
      startDir: "~/proj",
      groupId: "g1",
    });
    expect(p.id).toBe("keep");
    expect(p.local_shell).toBe("wsl-ubuntu");
    expect(p.local_shell_args).toEqual(["-d", "Ubuntu"]);
    expect(p.local_shell_name).toBe("Ubuntu (WSL)");
    expect(p.local_shell_icon).toBe("ubuntu");
    expect(p.local_start_dir).toBe("~/proj");
    expect(p.group_id).toBe("g1");
  });

  it("自动会话日志：开启落 true，未开启落 null（跟随全局设置）", () => {
    expect(createLocalShellHost({ autoSessionLog: true }).auto_session_log).toBe(
      true,
    );
    expect(createLocalShellHost({}).auto_session_log).toBeNull();
    expect(createLocalShellHost({ autoSessionLog: false }).auto_session_log).toBeNull();
  });

  it("未给 id 时生成 local- 前缀新 id", () => {
    const a = createLocalShellHost({});
    const b = createLocalShellHost({});
    expect(a.id).toMatch(/^local-/);
    expect(a.id).not.toBe(b.id);
  });

  it("LOCAL_SHELL_HOST_TAG 常量为 local", () => {
    expect(LOCAL_SHELL_HOST_TAG).toBe("local");
  });
});

describe("getLocalShellHostSubtitle / getVaultHostRowSubtitle", () => {
  it("串口主机副标题显示串口路径与波特率（旧库回落到 host）", () => {
    expect(
      getVaultHostRowSubtitle({
        protocol: "serial",
        local_shell_name: null,
        host: "COM3",
        serial_port: "COM3",
        serial_baud: 115200,
      }),
    ).toBe("COM3 · 115200 bps");
    expect(
      getVaultHostRowSubtitle({
        protocol: "serial",
        local_shell_name: null,
        host: "/dev/ttyUSB0",
        serial_port: null,
        serial_baud: null,
      }),
    ).toBe("/dev/ttyUSB0");
  });

  it("本地主机副标题 = 保存的 shell 名，缺省回退「本地终端」", () => {
    expect(
      getLocalShellHostSubtitle({ local_shell_name: "CMD" }),
    ).toBe("CMD");
    expect(getLocalShellHostSubtitle({ local_shell_name: null })).toBe(
      "本地终端",
    );
    expect(getLocalShellHostSubtitle({ local_shell_name: "  " })).toBe(
      "本地终端",
    );
  });

  it("行副标题按 protocol 分流", () => {
    expect(
      getVaultHostRowSubtitle(
        { protocol: "local", local_shell_name: "Git Bash" },
        { sshSubtitle: "root@1.2.3.4" },
      ),
    ).toBe("Git Bash");
    expect(
      getVaultHostRowSubtitle(
        { protocol: "ssh", local_shell_name: null },
        { sshSubtitle: "root@1.2.3.4" },
      ),
    ).toBe("root@1.2.3.4");
    expect(
      getVaultHostRowSubtitle({ protocol: "local", local_shell_name: null }),
    ).toBe("本地终端");
  });
});

describe("resolveShellSetting", () => {
  it("空值返 null（= 系统默认）", () => {
    expect(resolveShellSetting("", SHELLS)).toBeNull();
  });

  it("按发现 id 匹配：命令 + 自带参数", () => {
    expect(resolveShellSetting("pwsh", SHELLS)).toEqual({
      command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: ["-NoLogo"],
    });
    expect(resolveShellSetting("cmd", SHELLS)).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    });
  });

  it("customArgs 优先于发现列表自带参数", () => {
    expect(resolveShellSetting("wsl-ubuntu", SHELLS, ["-d", "Debian"])).toEqual({
      command: "C:\\Windows\\System32\\wsl.exe",
      args: ["-d", "Debian"],
    });
  });

  it("非 id = 自定义命令透传；无 customArgs 不带参数", () => {
    expect(resolveShellSetting("/usr/local/bin/fish", SHELLS)).toEqual({
      command: "/usr/local/bin/fish",
      args: undefined,
    });
    expect(resolveShellSetting("bash", SHELLS, ["--login", "-i"])).toEqual({
      command: "bash",
      args: ["--login", "-i"],
    });
  });
});

describe("resolveHostDefaultLocalShell", () => {
  const ctx = {
    discoveredShells: SHELLS,
    resolveShellSetting,
    terminalSettings: { localShell: "pwsh" },
  };

  it("非 local 主机原样返回", () => {
    const ssh = localProfile({ protocol: "ssh", local_shell: null });
    expect(resolveHostDefaultLocalShell(ssh, ctx)).toBe(ssh);
  });

  it("主机未选 shell → 用设置里的 shell 解析", () => {
    const got = resolveHostDefaultLocalShell(localProfile(), ctx);
    expect(got.local_shell).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(got.local_shell_args).toEqual(["-NoLogo"]);
    expect(got.local_shell_name).toBe("PowerShell 7");
    expect(got.local_shell_icon).toBe("pwsh");
  });

  it("主机已选 shell → 用主机自己的快照解析，名称不被覆盖", () => {
    const got = resolveHostDefaultLocalShell(
      localProfile({
        local_shell: "wsl-ubuntu",
        local_shell_args: ["-d", "Ubuntu"],
        local_shell_name: "我的 Ubuntu",
        local_shell_icon: "ubuntu",
      }),
      ctx,
    );
    expect(got.local_shell).toBe("C:\\Windows\\System32\\wsl.exe");
    expect(got.local_shell_args).toEqual(["-d", "Ubuntu"]);
    expect(got.local_shell_name).toBe("我的 Ubuntu");
  });

  it("启动目录回退链：主机 → 设置 → '~'", () => {
    expect(
      resolveHostDefaultLocalShell(localProfile(), ctx).local_start_dir,
    ).toBe("~");
    expect(
      resolveHostDefaultLocalShell(localProfile(), {
        ...ctx,
        terminalSettings: { localShell: "pwsh", localStartDir: "/data" },
      }).local_start_dir,
    ).toBe("/data");
    expect(
      resolveHostDefaultLocalShell(
        localProfile({ local_start_dir: "~/proj" }),
        ctx,
      ).local_start_dir,
    ).toBe("~/proj");
  });

  it("主机与设置都为空 → shell 保持空串（后端默认）", () => {
    const got = resolveHostDefaultLocalShell(localProfile(), {
      discoveredShells: SHELLS,
      resolveShellSetting,
    });
    expect(got.local_shell).toBe("");
    expect(got.local_shell_args).toBeUndefined();
  });
});
