//! 远端能力探测（解释器 / diff），按 profile 缓存 30min。
//!
//! `fs_grep` 与 `fs_patch` 复用 AI 面板的 python3 / perl 脚本；这里只负责
//! 探一次并缓存（TTL 过期后下一次调用自动重探，覆盖远端二进制安装/卸载），
//! 避免每次工具调用都跑 `command -v`。

use std::time::Duration;

use serde::Serialize;

use crate::error::AppResult;
use crate::ssh::client::{exec_once, SshHandle};

use super::super::runtime_state;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCaps {
    pub python3: bool,
    pub perl: bool,
    pub diff: bool,
    /// ripgrep：fs_grep 首选原生快路径（并行扫描，远快于 python 单线程）。
    pub rg: bool,
    /// GNU/BSD grep：无 rg 无 python3 时的原生兜底。
    pub grep: bool,
}

impl RemoteCaps {
    /// 首选解释器（python3 优先，perl 兜底）。
    pub fn interpreter(&self) -> Option<&'static str> {
        if self.python3 {
            Some("python3")
        } else if self.perl {
            Some("perl")
        } else {
            None
        }
    }
}

const PROBE: &str = "command -v python3 >/dev/null 2>&1 && echo py3; \
                     command -v perl >/dev/null 2>&1 && echo perl; \
                     command -v diff >/dev/null 2>&1 && echo diff; \
                     command -v rg >/dev/null 2>&1 && echo rg; \
                     command -v grep >/dev/null 2>&1 && echo grep";

pub async fn detect(ssh: &SshHandle, profile_id: &str) -> AppResult<RemoteCaps> {
    if let Some(cached) = runtime_state::cached_caps(profile_id) {
        return Ok(cached);
    }
    let out = exec_once(ssh, PROBE, Duration::from_secs(10), false).await?;
    let has = |tag: &str| out.stdout.lines().any(|line| line.trim() == tag);
    let caps = RemoteCaps {
        python3: has("py3"),
        perl: has("perl"),
        diff: has("diff"),
        rg: has("rg"),
        grep: has("grep"),
    };
    runtime_state::store_caps(profile_id, caps);
    Ok(caps)
}
