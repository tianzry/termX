//! 对外 MCP（Settings → AI → 工具接入）模块。
//!
//! 参照实现：Netcatty `electron/bridges/mcpServerBridge.cjs`、
//! `electron/bridges/externalMcpController.cjs`、`electron/mcp/*`。
//! 移植方案与未实现清单见 `docs/mcp-port-plan.md`。

pub mod approval;
pub mod config;
pub mod guide;
pub mod server;
pub mod tools;
