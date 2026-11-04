//! SFTP 传输队列（阶段 A 后端）：队列中心 / 并发 / 暂停恢复 / 优先级 / 冲突决策。
//!
//! 入口见 [`transfer_center`]。引擎函数（enqueue / pause / resume / …）由
//! lib.rs `generate_handler!` 的 Tauri command 与 server.rs dispatcher 双注册
//! 共用（R4 / INV-4），事件命名遵循 `<domain>:<event>:<id>`（R2）：
//! - `sftp:progress:<transfer_id>` —— 复用既有流式进度（upload/download_streaming 发出）；
//! - `sftp:transfer_updated:<transfer_id>` —— 单项状态变化，payload = TransferItem；
//! - `sftp:queue_changed` —— 结构性变化（入队 / 清理 / 重排），payload = 全量快照。

pub mod archive;
pub mod transfer_center;
