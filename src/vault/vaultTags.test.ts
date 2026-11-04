import { describe, expect, it } from "vitest";
import {
  VAULT_TAGS_KEY,
  collectHostTags,
  matchesHostTags,
  readHostTags,
} from "./vaultTags";

const makeStorage = (raw: string | null) => ({
  getItem: (key: string) => (key === VAULT_TAGS_KEY ? raw : null),
});

describe("readHostTags", () => {
  it("解析标签表并丢弃非字符串项", () => {
    const tags = readHostTags(
      makeStorage(
        JSON.stringify({ p1: ["prod", 3, "web"], p2: "bad", p3: ["x"] }),
      ),
    );
    expect(tags).toEqual({ p1: ["prod", "web"], p3: ["x"] });
  });

  it("空值 / 损坏 JSON / 数组都回落空表", () => {
    expect(readHostTags(makeStorage(null))).toEqual({});
    expect(readHostTags(makeStorage("{"))).toEqual({});
    expect(readHostTags(makeStorage("[]"))).toEqual({});
    expect(readHostTags(null)).toEqual({});
  });
});

describe("collectHostTags / matchesHostTags", () => {
  const tags = { p1: ["prod", "web"], p2: ["prod"], p3: [] };

  it("只收集当前主机标签并去重排序", () => {
    expect(collectHostTags(tags, ["p1", "p2"])).toEqual(["prod", "web"]);
    expect(collectHostTags(tags, ["p3"])).toEqual([]);
  });

  it("选中标签需全部命中（与 Vault 页一致）", () => {
    expect(matchesHostTags(tags, "p1", [])).toBe(true);
    expect(matchesHostTags(tags, "p1", ["prod"])).toBe(true);
    expect(matchesHostTags(tags, "p1", ["prod", "web"])).toBe(true);
    expect(matchesHostTags(tags, "p2", ["prod", "web"])).toBe(false);
    expect(matchesHostTags(tags, "p3", ["prod"])).toBe(false);
  });
});
