/**
 * MCP 对外工具矩阵的平面分组（设置 → AI 页展示）。
 *
 * 纯数据、无 React / IO 依赖，单独成模块便于单测钉住：这份清单是手维护的，
 * 历史上曾因新增工具漏更新而与后端 `mcp::tools::definitions` 漂移（少列
 * job_wait / set_session_preamble）。测试对照后端工具全集，加工具时若忘了
 * 更新这里会直接红。平面命名对齐后端 guide.rs：build_run 属「构建平面」，
 * term_run 属「逃生平面」（任意非交互命令），两者不再混为一组。
 */

export type McpToolPlane =
  | "control"
  | "transfer"
  | "build"
  | "escape"
  | "session"
  | "composite";

export const MCP_TOOL_GROUPS: Array<{ plane: McpToolPlane; tools: string[] }> = [
  { plane: "control", tools: ["fs_read", "fs_grep", "fs_glob", "fs_patch", "fs_write", "fs_delete"] },
  { plane: "transfer", tools: ["sftp_put", "sftp_get"] },
  { plane: "build", tools: ["build_run"] },
  { plane: "escape", tools: ["term_run"] },
  { plane: "session", tools: ["get_environment", "vault_hosts_list", "snippets_list", "terminal_execute", "session_open", "set_session_preamble", "session_close", "serial_write", "serial_read", "telnet_write", "telnet_read"] },
  { plane: "composite", tools: ["job_wait", "batch"] },
];
