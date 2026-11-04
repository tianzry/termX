import { describe, expect, it } from "vitest";
import {
  OSC7_MARKER_START,
  buildOsc7SetupPlan,
  osc7ReloadCommand,
  parseOsc7Cwd,
  parseOsc7SetupResult,
} from "./osc7";

describe("parseOsc7Cwd", () => {
  it("解析 file://host/path", () => {
    expect(parseOsc7Cwd("file://myhost/home/user")).toBe("/home/user");
    expect(parseOsc7Cwd("file:///tmp")).toBe("/tmp");
  });

  it("百分号编码会被还原", () => {
    expect(parseOsc7Cwd("file://host/home/user/a%20b")).toBe("/home/user/a b");
  });

  it("非法负载返回 null", () => {
    expect(parseOsc7Cwd("")).toBeNull();
    expect(parseOsc7Cwd("http://host/path")).toBeNull();
  });

  it("原始（未转义）路径也兼容", () => {
    expect(parseOsc7Cwd("file://host/home/用户/项目")).toBe("/home/用户/项目");
    expect(parseOsc7Cwd("file://host/home/user/a%b")).toBe("/home/user/a%b");
  });
});

describe("buildOsc7SetupPlan", () => {
  it("包含三个 shell 分支与幂等标记", () => {
    const plan = buildOsc7SetupPlan();
    expect(plan.command).toContain("bash|zsh|fish");
    expect(plan.command).toContain(OSC7_MARKER_START);
    expect(plan.command).toContain("grep -Fq");
    expect(plan.command).toContain("__TERMX_OSC7_SHELL__");
  });

  it("单引号安全：脚本块不会提前闭合", () => {
    const plan = buildOsc7SetupPlan();
    // 钩子里的 printf 格式用了单引号，必须被转义成 '\'' 形式。
    expect(plan.command).toContain("'\\''");
  });
});

describe("parseOsc7SetupResult / osc7ReloadCommand", () => {
  it("读取 shell 与配置文件", () => {
    const out =
      "__TERMX_OSC7_SHELL__=zsh\n__TERMX_OSC7_CONFIG__=/home/u/.zshrc\n";
    expect(parseOsc7SetupResult(out)).toEqual({
      shell: "zsh",
      config: "/home/u/.zshrc",
    });
  });

  it("按 shell 返回重载命令，未知回退 bash", () => {
    expect(osc7ReloadCommand("zsh")).toContain(".zshrc");
    expect(osc7ReloadCommand("fish")).toContain("config.fish");
    expect(osc7ReloadCommand("nonsense")).toContain(".bashrc");
    expect(osc7ReloadCommand(null)).toContain(".bashrc");
  });
});
