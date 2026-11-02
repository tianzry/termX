import { describe, expect, it } from "vitest";
import { shellDisplayName } from "./shellName";

describe("shellDisplayName", () => {
  it("空值回退「本地终端」", () => {
    expect(shellDisplayName("")).toBe("本地终端");
    expect(shellDisplayName("   ")).toBe("本地终端");
  });

  it("Windows 系统 shell", () => {
    expect(shellDisplayName("C:\\Windows\\System32\\cmd.exe")).toBe("CMD");
    expect(shellDisplayName("cmd")).toBe("CMD");
    expect(shellDisplayName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
      "PowerShell 7",
    );
    expect(
      shellDisplayName(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe("Windows PowerShell");
    expect(shellDisplayName("C:\\Windows\\System32\\wsl.exe")).toBe("WSL");
  });

  it("按路径识别 Git Bash / Cygwin", () => {
    expect(shellDisplayName("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(
      "Git Bash",
    );
    expect(shellDisplayName("C:\\cygwin64\\bin\\bash.exe")).toBe("Cygwin");
    expect(shellDisplayName("/usr/bin/bash")).toBe("Bash");
  });

  it("其余取 basename 去扩展名", () => {
    expect(shellDisplayName("/bin/zsh")).toBe("zsh");
    expect(shellDisplayName("C:\\tools\\fish.exe")).toBe("fish");
    expect(shellDisplayName('"/opt/shells/nu"')).toBe("nu");
  });
});
