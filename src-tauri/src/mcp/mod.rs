//! 对外 MCP（Settings → AI → 工具接入）模块。
//!
//! 参照实现：Netcatty `electron/bridges/mcpServerBridge.cjs`、
//! `electron/bridges/externalMcpController.cjs`、`electron/mcp/*`。
//! 移植方案与未实现清单见 `docs/mcp-port-plan.md`。
//! 文件原语整改方案见 `docs/mcp-refactor.md`。

pub mod approval;
pub mod audit;
pub mod blocklist;
pub mod config;
pub mod fs;
pub mod grants;
pub mod guide;
pub mod permissions;
pub mod runtime_state;
pub mod server;
pub mod tools;
