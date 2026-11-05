import { beforeEach, describe, expect, it } from "vitest";
import {
  COMMAND_HISTORY_MAX,
  COMMAND_HISTORY_STORAGE_KEY,
  appendCommandHistory,
  clearCommandHistory,
  deleteCommandHistoryEntry,
  filterCommandHistory,
  normalizeHistoryCommand,
  parseCommandHistory,
  readCommandHistory,
  recordCommandHistory,
  type CommandHistoryEntry,
} from "./commandHistoryModel";

function entry(
  command: string,
  hostId: string,
  timestamp: number,
  count = 1,
  id = `${hostId}:${command}`,
): CommandHistoryEntry {
  return { id, command, hostId, hostLabel: hostId, timestamp, count };
}

describe("normalizeHistoryCommand", () => {
  it("去掉行尾 CR/LF 与首尾空白，空命令丢弃", () => {
    expect(normalizeHistoryCommand("ls -la\r\n")).toBe("ls -la");
    expect(normalizeHistoryCommand("  git status  ")).toBe("git status");
    expect(normalizeHistoryCommand("echo 'a\nb'")).toBe("echo 'a\nb'");
    expect(normalizeHistoryCommand("\r\n")).toBeNull();
    expect(normalizeHistoryCommand("   ")).toBeNull();
  });
});

describe("appendCommandHistory", () => {
  it("同主机同命令去重：次数 +1、时间更新、置顶", () => {
    const list = [entry("ls", "h1", 100, 2)];
    const next = appendCommandHistory(list, {
      command: "ls\r",
      hostId: "h1",
      hostLabel: "h1",
      timestamp: 200,
      id: "new-id",
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "h1:ls",
      command: "ls",
      count: 3,
      timestamp: 200,
    });
  });

  it("不同主机同命令不去重，新命令插到最前", () => {
    const list = [entry("ls", "h1", 100)];
    const next = appendCommandHistory(list, {
      command: "ls",
      hostId: "h2",
      hostLabel: "h2",
      timestamp: 200,
      id: "h2:ls",
    });
    expect(next.map((item) => item.id)).toEqual(["h2:ls", "h1:ls"]);
  });

  it("超过上限裁剪最旧记录，空命令不写入", () => {
    const list = Array.from({ length: COMMAND_HISTORY_MAX }, (_, index) =>
      entry(`cmd-${index}`, "h1", index),
    );
    const next = appendCommandHistory(list, {
      command: "fresh",
      hostId: "h1",
      hostLabel: "h1",
      timestamp: 9999,
      id: "fresh",
    });
    expect(next).toHaveLength(COMMAND_HISTORY_MAX);
    expect(next[0].command).toBe("fresh");
    expect(next.some((item) => item.command === `cmd-${COMMAND_HISTORY_MAX - 1}`)).toBe(false);

    expect(
      appendCommandHistory([], {
        command: "  \r\n",
        hostId: "h1",
        hostLabel: "h1",
        timestamp: 1,
        id: "empty",
      }),
    ).toEqual([]);
  });
});

describe("filterCommandHistory", () => {
  const list = [
    entry("git status", "h1", 300),
    entry("ls -la", "h1", 200),
    entry("docker ps", "h2", 100),
  ];

  it("按主机范围过滤", () => {
    expect(
      filterCommandHistory(list, { query: "", scope: "host", hostId: "h1" }).map(
        (item) => item.command,
      ),
    ).toEqual(["git status", "ls -la"]);
  });

  it("全部范围 + 搜索命令或主机名，大小写不敏感", () => {
    expect(
      filterCommandHistory(list, { query: "DOCKER", scope: "all", hostId: "h1" }).map(
        (item) => item.command,
      ),
    ).toEqual(["docker ps"]);
    expect(
      filterCommandHistory(list, { query: "h2", scope: "all", hostId: "h1" }).map(
        (item) => item.command,
      ),
    ).toEqual(["docker ps"]);
  });
});

describe("parseCommandHistory", () => {
  it("容错非法 JSON / 非数组 / 缺字段，并按时间倒序", () => {
    expect(parseCommandHistory(null)).toEqual([]);
    expect(parseCommandHistory("not-json")).toEqual([]);
    expect(parseCommandHistory("{}")).toEqual([]);
    expect(
      parseCommandHistory(
        JSON.stringify([
          { id: "a", command: "ls", hostId: "h1", timestamp: 100, count: 1 },
          { id: "b" },
          "garbage",
          { id: "c", command: "pwd", hostId: "h1", timestamp: 300 },
        ]),
      ).map((item) => item.id),
    ).toEqual(["c", "a"]);
  });

  it("缺失 count / hostLabel 回落安全值", () => {
    const parsed = parseCommandHistory(
      JSON.stringify([{ id: "x", command: "top", hostId: "h1", timestamp: 5 }]),
    );
    expect(parsed[0].count).toBe(1);
    expect(parsed[0].hostLabel).toBe("h1");
  });
});

describe("localStorage 持久化", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("record / read / delete / clear 可跨实例读取（相当于重启后保留）", () => {
    recordCommandHistory({
      command: "uname -a",
      hostId: "h1",
      hostLabel: "129",
      id: "c1",
    });
    recordCommandHistory({
      command: "uname -a",
      hostId: "h1",
      hostLabel: "129",
      id: "c2",
    });
    const stored = readCommandHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].count).toBe(2);
    expect(stored[0].hostLabel).toBe("129");

    deleteCommandHistoryEntry(stored[0].id);
    expect(readCommandHistory()).toEqual([]);

    recordCommandHistory({ command: "pwd", hostId: "h1", hostLabel: "129", id: "c3" });
    clearCommandHistory();
    expect(window.localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY)).toBe("[]");
    expect(readCommandHistory()).toEqual([]);
  });
});
