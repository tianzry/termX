// Vault 主机标签（本地持久化）的共享读取逻辑。
// 标签不落后端 DB：VaultView 编辑、终端侧栏筛选都读同一份 localStorage，
// 避免两处各写一份 key 或解析规则后走偏。
export const VAULT_TAGS_KEY = "termx.vault.tags.v1";

export type HostTagMap = Record<string, string[]>;

/** 读取 localStorage 的标签表；损坏 / 非对象时回落空表。 */
export function readHostTags(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): HostTagMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(VAULT_TAGS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: HostTagMap = {};
    for (const [id, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) {
        out[id] = list.filter((t): t is string => typeof t === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 当前主机集合里出现过的全部标签（去重 + 中文本地化排序）。 */
export function collectHostTags(
  tags: HostTagMap,
  profileIds: string[],
): string[] {
  const names = new Set<string>();
  for (const id of profileIds) {
    for (const tag of tags[id] ?? []) {
      if (tag.trim()) names.add(tag);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 与 Vault 主机页一致的筛选语义：选中标签需全部命中。 */
export function matchesHostTags(
  tags: HostTagMap,
  profileId: string,
  selected: string[],
): boolean {
  if (selected.length === 0) return true;
  const own = tags[profileId] ?? [];
  return selected.every((tag) => own.includes(tag));
}
