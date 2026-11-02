import { describe, expect, it } from "vitest";
import { toHostKeyInfo, type HostKeyPromptPayload } from "./hostKey";

describe("toHostKeyInfo", () => {
  it("把后端 snake_case 载荷映射为前端 camelCase 字段", () => {
    const payload: HostKeyPromptPayload = {
      host: "example.com",
      port: 2222,
      key_type: "ssh-ed25519",
      fingerprint: "SHA256:abc",
      status: "unknown",
      known_fingerprint: "SHA256:old",
    };
    expect(toHostKeyInfo(payload)).toEqual({
      hostname: "example.com",
      port: 2222,
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:abc",
      status: "unknown",
      knownFingerprint: "SHA256:old",
    });
  });

  it("port 缺失时回退 22", () => {
    // 运行时载荷可能缺字段，这里故意构造不完整载荷验证兜底。
    const payload = {
      host: "h",
      key_type: "ssh-rsa",
      fingerprint: "f",
    } as HostKeyPromptPayload;
    expect(toHostKeyInfo(payload).port).toBe(22);
  });
});
