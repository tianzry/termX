import { describe, expect, it } from "vitest";
import {
  SSH_KEY_ALGORITHMS,
  RSA_BIT_OPTIONS,
  ECDSA_CURVE_OPTIONS,
  isValidSshKeyName,
  keyTypeLabel,
  defaultKeyName,
} from "./keychainModel";

describe("keychainModel", () => {
  it("名称校验与后端 is_plain_file_name 同规则", () => {
    expect(isValidSshKeyName("id_ed25519")).toBe(true);
    expect(isValidSshKeyName("my-key.prod")).toBe(true);
    expect(isValidSshKeyName("")).toBe(false);
    expect(isValidSshKeyName(".")).toBe(false);
    expect(isValidSshKeyName("..")).toBe(false);
    expect(isValidSshKeyName("../evil")).toBe(false);
    expect(isValidSshKeyName("a/b")).toBe(false);
    expect(isValidSshKeyName("a\\b")).toBe(false);
    expect(isValidSshKeyName("a..b")).toBe(false);
    expect(isValidSshKeyName("a\nb")).toBe(false);
  });

  it("keyTypeLabel 映射算法名到友好标签", () => {
    expect(keyTypeLabel("ssh-ed25519")).toBe("Ed25519");
    expect(keyTypeLabel("ssh-rsa")).toBe("RSA");
    expect(keyTypeLabel("ecdsa-sha2-nistp256")).toBe("ECDSA P-256");
    expect(keyTypeLabel("ecdsa-sha2-nistp521")).toBe("ECDSA P-521");
    expect(keyTypeLabel("")).toBe("未知");
    // 未收录的类型原样透传，不吞信息。
    expect(keyTypeLabel("sk-ssh-ed25519@openssh.com")).toBe("sk-ssh-ed25519@openssh.com");
  });

  it("defaultKeyName 遵循 OpenSSH 惯例", () => {
    expect(defaultKeyName("ED25519")).toBe("id_ed25519");
    expect(defaultKeyName("ECDSA")).toBe("id_ecdsa");
    expect(defaultKeyName("RSA")).toBe("id_rsa");
  });

  it("生成选项对齐 netcatty 生成面板", () => {
    expect([...SSH_KEY_ALGORITHMS]).toEqual(["ED25519", "ECDSA", "RSA"]);
    expect([...RSA_BIT_OPTIONS]).toEqual([4096, 2048]);
    expect([...ECDSA_CURVE_OPTIONS]).toEqual([256, 384, 521]);
  });
});
