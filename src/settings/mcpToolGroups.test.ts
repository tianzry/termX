import { describe, expect, it } from "vitest";
import { MCP_TOOL_GROUPS } from "./mcpToolGroups";
import { settingsT } from "./i18n";
import type { UiLanguage } from "./settingsModel";

/** 后端 guide.rs「可用工具（共 23 个）」全集；加工具时两头都要同步，漏一头这里就红。 */
const BACKEND_TOOLS = [
  "get_environment",
  "vault_hosts_list",
  "snippets_list",
  "terminal_execute",
  "session_open",
  "set_session_preamble",
  "session_close",
  "serial_write",
  "serial_read",
  "telnet_write",
  "telnet_read",
  "fs_read",
  "fs_grep",
  "fs_glob",
  "fs_patch",
  "fs_write",
  "sftp_put",
  "sftp_get",
  "fs_delete",
  "build_run",
  "term_run",
  "job_wait",
  "batch",
];

describe("MCP_TOOL_GROUPS", () => {
  const flat = MCP_TOOL_GROUPS.flatMap((g) => g.tools);

  it("覆盖后端 23 个工具全集，不多不少", () => {
    expect([...flat].sort()).toEqual([...BACKEND_TOOLS].sort());
  });

  it("工具名不重复（一个工具只属一个平面）", () => {
    expect(new Set(flat).size).toBe(flat.length);
  });

  it("term_run 单独归逃生平面，build 平面只剩 build_run", () => {
    const build = MCP_TOOL_GROUPS.find((g) => g.plane === "build");
    const escape = MCP_TOOL_GROUPS.find((g) => g.plane === "escape");
    expect(build?.tools).toEqual(["build_run"]);
    expect(escape?.tools).toEqual(["term_run"]);
  });

  it("每个平面在中英两种语言下都有非回退标签", () => {
    for (const lang of ["zh-CN", "en"] as UiLanguage[]) {
      for (const group of MCP_TOOL_GROUPS) {
        const key = `settings.ai.tools.plane.${group.plane}`;
        expect(settingsT(lang, key)).not.toBe(key);
      }
    }
  });
});
