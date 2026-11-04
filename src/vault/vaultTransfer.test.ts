import { describe, expect, it } from "vitest";
import type { Credential, Group, Profile } from "../backend/client";
import {
  applyImportedHost,
  buildVaultExport,
  credentialFromImportedHost,
  findConflicts,
  hostConflictKey,
  importedHostToProfile,
  parseVaultImport,
  VAULT_EXPORT_KIND,
  VAULT_EXPORT_VERSION,
} from "./vaultTransfer";

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "web",
    host: "10.0.0.1",
    port: 22,
    credential_id: "c1",
    bastion_profile_id: null,
    init_command: null,
    group_id: null,
    agent_forwarding: false,
    ...over,
  };
}

function group(over: Partial<Group> = {}): Group {
  return {
    id: "g1",
    name: "生产",
    color: "#f00",
    sort_order: 0,
    ...over,
  };
}

function credential(over: Partial<Credential> = {}): Credential {
  return {
    id: "c1",
    name: "root@web",
    username: "root",
    type: "password",
    secret: "should-never-be-exported",
    save_to_remote: false,
    ...over,
  };
}

describe("buildVaultExport", () => {
  it("输出版本化 JSON，只含非敏感字段", () => {
    const text = buildVaultExport(
      [profile({ icon_color: "#0af", init_command: "cd /srv" })],
      [group()],
      {
        credentials: [credential()],
        tags: { p1: ["prod", "web"] },
      },
      "2026-11-05T00:00:00.000Z",
    );
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload.kind).toBe(VAULT_EXPORT_KIND);
    expect(payload.version).toBe(VAULT_EXPORT_VERSION);
    expect(payload.exportedAt).toBe("2026-11-05T00:00:00.000Z");
    expect(payload.groups).toEqual([
      { id: "g1", name: "生产", color: "#f00", sort_order: 0 },
    ]);
    expect(payload.hosts).toEqual([
      {
        id: "p1",
        name: "web",
        host: "10.0.0.1",
        port: 22,
        group_id: null,
        username: "root",
        auth_method: "password",
        init_command: "cd /srv",
        icon_color: "#0af",
        tags: ["prod", "web"],
      },
    ]);
    expect(text).not.toContain("should-never-be-exported");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("private_key");
  });
});

describe("parseVaultImport", () => {
  it("非法 JSON / 非对象 / 版本不符 / 缺 hosts 都给出错误", () => {
    expect(parseVaultImport("{").errors).toEqual(["文件不是合法 JSON"]);
    expect(parseVaultImport("[]").errors).toEqual(["文件内容不是主机导出格式"]);
    expect(parseVaultImport(JSON.stringify({ version: 2, hosts: [] })).ok).toBe(
      false,
    );
    expect(
      parseVaultImport(
        JSON.stringify({ kind: VAULT_EXPORT_KIND, version: 1 }),
      ).errors,
    ).toEqual(["导入文件没有 hosts 列表"]);
  });

  it("逐条校验必填字段与端口范围，丢弃未知字段", () => {
    const result = parseVaultImport(
      JSON.stringify({
        kind: VAULT_EXPORT_KIND,
        version: 1,
        groups: [{ id: "g1", name: "生产", unknown: true }],
        hosts: [
          {
            name: "web",
            host: "10.0.0.1",
            port: "22",
            password: "leak",
            private_key: "leak",
            extra: "drop-me",
          },
          { name: "bad-port", host: "10.0.0.2", port: 70000 },
          { host: "10.0.0.3", port: 22 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({
      name: "web",
      host: "10.0.0.1",
      port: 22,
      auth_method: "none",
      protocol: "ssh",
    });
    expect(result.hosts[0]).not.toHaveProperty("password");
    expect(result.hosts[0]).not.toHaveProperty("private_key");
    expect(result.hosts[0]).not.toHaveProperty("extra");
    expect(result.groups).toEqual([
      { id: "g1", name: "生产", color: "", sort_order: 0 },
    ]);
    expect(result.errors).toHaveLength(2);
  });

  it("合法导入返回 ok + 归一后的主机", () => {
    const result = parseVaultImport(
      buildVaultExport(
        [profile({ protocol: "local", local_shell: "bash" })],
        [],
        {},
        "2026-11-05T00:00:00.000Z",
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.hosts[0]).toMatchObject({
      name: "web",
      host: "10.0.0.1",
      port: 22,
      protocol: "local",
      local_shell: "bash",
    });
  });
});

describe("findConflicts", () => {
  it("按 name + host + port 识别冲突（忽略大小写）", () => {
    const parsed = parseVaultImport(
      JSON.stringify({
        version: 1,
        hosts: [
          { name: "WEB", host: "10.0.0.1", port: 22 },
          { name: "db", host: "10.0.0.2", port: 22 },
        ],
      }),
    ).hosts;
    const conflicts = findConflicts(parsed, [
      profile({ id: "old", name: "web", host: "10.0.0.1", port: 22 }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].existing.id).toBe("old");
    expect(hostConflictKey(parsed[0])).toBe("web|10.0.0.1|22");
  });
});

describe("导入构造", () => {
  const host = parseVaultImport(
    JSON.stringify({
      version: 1,
      hosts: [
        {
          name: "web",
          host: "10.0.0.1",
          port: 22,
          username: "root",
          auth_method: "key",
          icon_color: "#0af",
          init_command: "cd /srv",
        },
      ],
    }),
  ).hosts[0];

  it("凭据只有用户名 / 类型，secret 为空", () => {
    const cred = credentialFromImportedHost(host, "new-cred");
    expect(cred).toMatchObject({
      id: "new-cred",
      username: "root",
      type: "key",
      secret: null,
    });
  });

  it("新档案与原档案的必填字段齐备", () => {
    const p = importedHostToProfile(host, "new-cred", "g9", "new-id");
    expect(p).toMatchObject({
      id: "new-id",
      name: "web",
      host: "10.0.0.1",
      port: 22,
      credential_id: "new-cred",
      group_id: "g9",
      init_command: "cd /srv",
      icon_color: "#0af",
    });
  });

  it("覆盖沿用本地 id / 凭据，只刷新可迁移字段", () => {
    const existing = profile({
      id: "local",
      credential_id: "keep-me",
      bastion_profile_id: "jump",
    });
    const next = applyImportedHost(existing, host, null);
    expect(next).toMatchObject({
      id: "local",
      credential_id: "keep-me",
      bastion_profile_id: "jump",
      name: "web",
      host: "10.0.0.1",
      port: 22,
      group_id: null,
    });
  });
});
