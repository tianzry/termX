import { describe, expect, it } from "vitest";
import {
  EMPTY_PROXY_DRAFT,
  proxyDraftError,
  proxyDraftFromProfile,
  proxyPasswordToSave,
  proxyProfileFields,
} from "./proxyForm";

describe("proxyForm", () => {
  it("none 清空全部代理字段", () => {
    expect(proxyProfileFields(EMPTY_PROXY_DRAFT)).toEqual({
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_no_proxy: null,
    });
    expect(proxyDraftError(EMPTY_PROXY_DRAFT)).toBeNull();
  });

  it("http / socks5 落库 host/port/username/no_proxy", () => {
    expect(
      proxyProfileFields({
        type: "http",
        host: " 127.0.0.1 ",
        port: "7897",
        username: "u",
        password: "p",
        noProxy: " localhost ",
      }),
    ).toEqual({
      proxy_type: "http",
      proxy_host: "127.0.0.1",
      proxy_port: 7897,
      proxy_username: "u",
      proxy_no_proxy: "localhost",
    });
  });

  it("校验 host / port / 密码配用户名", () => {
    const base = { ...EMPTY_PROXY_DRAFT, type: "socks5" as const };
    expect(proxyDraftError({ ...base, host: "", port: "1080" })).toBe("请填写代理主机");
    expect(proxyDraftError({ ...base, host: "10.0.0.1", port: "" })).toBe(
      "代理端口需在 1–65535 之间",
    );
    expect(proxyDraftError({ ...base, host: "10.0.0.1", port: "70000" })).toBe(
      "代理端口需在 1–65535 之间",
    );
    expect(
      proxyDraftError({ ...base, host: "10.0.0.1", port: "1080", password: "x" }),
    ).toBe("填写代理密码时请同时填写用户名");
    expect(proxyDraftError({ ...base, host: "10.0.0.1", port: "1080" })).toBeNull();
  });

  it("从 Profile 回填；未知类型视为 none", () => {
    expect(
      proxyDraftFromProfile({
        proxy_type: "socks5",
        proxy_host: "10.0.0.1",
        proxy_port: 1080,
        proxy_username: "u",
        proxy_no_proxy: "internal",
      }),
    ).toEqual({
      type: "socks5",
      host: "10.0.0.1",
      port: "1080",
      username: "u",
      password: "",
      noProxy: "internal",
    });
    expect(
      proxyDraftFromProfile({
        proxy_type: null,
        proxy_host: "10.0.0.1",
        proxy_port: 1080,
        proxy_username: "u",
        proxy_no_proxy: "internal",
      }),
    ).toEqual({ ...EMPTY_PROXY_DRAFT });
  });

  it("密码保存策略：留空保持、无用户名清除、none 清除", () => {
    const d = {
      ...EMPTY_PROXY_DRAFT,
      type: "http" as const,
      host: "h",
      port: "1",
      username: "u",
    };
    expect(proxyPasswordToSave(d, true)).toBeUndefined();
    expect(proxyPasswordToSave(d, false)).toBeNull();
    expect(proxyPasswordToSave({ ...d, password: "new" }, true)).toBe("new");
    expect(proxyPasswordToSave({ ...d, username: "", password: "new" }, true)).toBeNull();
    expect(proxyPasswordToSave({ ...d, type: "none" }, true)).toBeNull();
  });
});
