//! 对外 MCP 暴露的工具面。
//!
//! Netcatty 侧由 `electron/capabilities/catalog/*.cjs` 驱动（40+ 工具，渐进式加载）。
//! termX 本阶段只移植「已存在可复用执行链路」的 5 个工具，其余在
//! `docs/mcp-port-plan.md` 里列为未实现并说明缺口，绝不注册空转工具。
//!
//! 返回结构统一为 `{code, message, hint, ...数据}`：
//! - 只读工具保留原有字段（sessions / hostCount / hosts / snippets），不破坏已验证客户端；
//! - `hint` 永远说明 agent 下一步该做什么，便于失败自纠。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::audit::change_entry;
use super::config::{McpConfig, PermissionMode};
use super::runtime_state;
use super::server::McpRuntime;
use crate::commands::{lifecycle, plugin};
use crate::state::{AppState, SessionKind, SessionOwner};

const HINT_SESSION_ID: &str =
    "先调用 get_environment 获取当前活跃会话，用返回的 sessions[].id 作为 sessionId；不要臆造 id。";
const HINT_PERMISSION: &str = "写操作受「设置 → AI → 工具接入」权限档位约束：observer 只读拒绝、confirm 需用户在 termX 弹窗中允许、auto 直接放行。";
/// 非 SSH 会话（串口 / Telnet）没有 SFTP 与 exec 通道时的 agent 自纠指引。
const HINT_SSH_ONLY: &str = "该工具需要 SSH 会话的 SFTP / exec 通道，串口（serial）与 Telnet 会话不提供；请改传 get_environment 里 kind 为 ssh 的 sessions[].id，或让用户在 termX 中建立 SSH 连接。";

/// `batch` 允许组合的工具：只读 + 非破坏性写原语。
const BATCH_TOOLS: &[&str] = &["fs_read", "fs_grep", "fs_glob", "fs_patch", "fs_write"];
const MAX_BATCH_OPS: usize = 50;

pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

impl ToolResult {
    fn ok(message: impl Into<String>, hint: impl Into<String>, data: Value) -> Self {
        Self {
            text: envelope("ok", message, hint, Some(data)).to_string(),
            is_error: false,
        }
    }

    fn err(code: &str, message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            text: envelope(code, message, hint, None).to_string(),
            is_error: true,
        }
    }

    /// 失败但仍需回逐项结果（批量/传输部分失败时调用方要看到哪几项成功）。
    fn err_with_data(
        code: &str,
        message: impl Into<String>,
        hint: impl Into<String>,
        data: Value,
    ) -> Self {
        Self {
            text: envelope(code, message, hint, Some(data)).to_string(),
            is_error: true,
        }
    }
}

/// 统一信封：`{code, message, hint}`；成功时把业务字段平铺进来。
fn envelope(
    code: &str,
    message: impl Into<String>,
    hint: impl Into<String>,
    data: Option<Value>,
) -> Value {
    let mut out = json!({
        "code": code,
        "message": message.into(),
        "hint": hint.into()
    });
    if let (Some(Value::Object(extra)), Some(map)) = (data, out.as_object_mut()) {
        for (key, value) in extra {
            map.insert(key, value);
        }
    }
    out
}

fn internal_error(e: impl std::fmt::Display) -> ToolResult {
    ToolResult::err(
        "internal_error",
        format!("{e}"),
        "稍后重试；若持续失败，请在 termX 中查看日志。",
    )
}

fn schema(props: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false,
    })
}

/// 远端文件类工具统一 schema：`sessionId` 与 `hostId` 二选一。
fn remote_schema(props: Value, required: &[&str]) -> Value {
    let mut value = schema(props, required);
    value["anyOf"] = json!([
        { "required": ["sessionId"] },
        { "required": ["hostId"] }
    ]);
    value
}

fn remote_args_common(props: &mut serde_json::Map<String, Value>) {
    props.insert(
        "sessionId".to_string(),
        json!({
            "type": "string",
            "description": "get_environment 返回的 sessions[].id（与 hostId 二选一）"
        }),
    );
    props.insert(
        "hostId".to_string(),
        json!({
            "type": "string",
            "description": "vault 主机 id；无就绪会话时自动按档案建连（与 sessionId 二选一）"
        }),
    );
}

fn tool_error(e: crate::error::AppError) -> ToolResult {
    let hint = match e.code() {
        "mcp_unsupported_session_kind" => HINT_SSH_ONLY,
        "mcp_session_not_ready" => {
            "该 sessionId 是 SSH 会话但尚未 ready（建连中或已关闭）；先 get_environment 确认 phase=ready 再重试。"
        }
        _ => "按 code 修正参数；会话/主机相关错误先调用 get_environment 确认。",
    };
    ToolResult::err(e.code(), e.to_string(), hint)
}

/// 远端只读文件工具的统一构造：`sessionId` / `hostId` 二选一。
fn file_tool(name: &str, description: &str, extra: Value, required: &[&str]) -> Value {
    remote_file_tool(name, description, extra, required, true)
}

/// 远端文件工具通用构造。`read_only=false` 时标注可写，供审批卡片区分。
fn remote_file_tool(
    name: &str,
    description: &str,
    extra: Value,
    required: &[&str],
    read_only: bool,
) -> Value {
    let mut props = match extra {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    remote_args_common(&mut props);
    json!({
        "name": name,
        "description": description,
        "inputSchema": remote_schema(Value::Object(props), required),
        "annotations": { "readOnlyHint": read_only, "destructiveHint": !read_only }
    })
}

pub fn definitions() -> Value {
    let mut list = json!([
        {
            "name": "get_environment",
            "description": "只读。返回当前会话（id / kind / phase / hostId / origin）与已保存主机清单（hosts），并标注 cacheable / ttl。\
    何时用：会话开始时先调用它拿 sessionId 或 hostId；文件类工具可直接传 hostId，无就绪会话时会自动建连。\
    何时不用：只需要主机清单时也可用 vault_hosts_list；不要用它轮询等待新会话。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "vault_hosts_list",
            "description": "只读。返回已保存主机的 id / name / host / port / groupId，不含密码、密钥等凭据。\
    何时用：需要知道用户保存了哪些主机、该选哪台时。\
    何时不用：获取当前活跃会话用 get_environment；本工具不会打开连接，也不会执行命令。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "snippets_list",
            "description": "只读。返回已保存代码片段的 id / name / package / command / description；命令文本可能含敏感信息。\
    何时用：需要复用用户预置的命令或脚本时。\
    何时不用：不要用本工具执行命令；执行请用 terminal_execute。",
            "inputSchema": schema(json!({}), &[]),
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "terminal_execute",
            "description": "写操作。在 get_environment 返回的某个已打开 SSH 会话中执行一条命令，返回 stdout / stderr / exitCode。\
    何时用：需要与目标主机的现有 SSH 会话交互、查看输出或运行命令时。\
    何时不用：只查询会话 / 主机清单时用只读工具；没有 sessionId 时不要调用；串口 / Telnet 没有 exec 通道（返回 mcp_unsupported_session_kind），只能发字节。\
    受权限档位与命令黑名单约束。",
            "inputSchema": schema(
                json!({
                    "sessionId": {
                        "type": "string",
                        "description": "get_environment 返回的 sessions[].id",
                        "examples": ["ssh-1a2b3c", "serial-7f00aa"]
                    },
                    "command": {
                        "type": "string",
                        "description": "要执行的单条非空命令",
                        "examples": ["uname -a", "df -h", "systemctl status nginx"]
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 1000,
                        "maximum": 600000,
                        "default": 30000,
                        "description": "可选。执行超时毫秒，默认 30000"
                    }
                }),
                &["sessionId", "command"]
            ),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        },
        {
            "name": "session_close",
            "description": "写操作。关闭 get_environment 返回的指定会话。\
    何时用：你打开且任务已完成的会话，或明确需要释放会话资源时。\
    何时不用：用户正在使用的会话不要关闭；会话不存在时先 get_environment 确认。\
    受权限档位约束。",
            "inputSchema": schema(
                json!({
                    "sessionId": {
                        "type": "string",
                        "description": "get_environment 返回的 sessions[].id",
                        "examples": ["ssh-1a2b3c"]
                    }
                }),
                &["sessionId"]
            ),
            "annotations": { "readOnlyHint": false, "destructiveHint": true }
        }
    ]);
    let items = list
        .as_array_mut()
        .expect("definitions is always a JSON array");

    items.push(file_tool(
        "fs_read",
        "只读。按行开窗读取远端文本文件，返回 lines / totalLines / size / mtime / truncated / nextCursor；走 SFTP 直读，不产生 base64。\
何时用：查看源码、日志、配置；先用 fs_grep 定位再读。\
何时不用：不要整读大文件（用 startLine 翻页）；二进制文件会被拒绝。\
sessionId 与 hostId 二选一；hostId 无就绪会话时按 vault 档案自动建连。",
        json!({
            "path": {
                "type": "string",
                "description": "远端路径，支持 ~ 与相对 workspace 根的路径"
            },
            "startLine": { "type": "integer", "minimum": 1, "default": 1 },
            "maxLines": { "type": "integer", "minimum": 1, "maximum": 2000, "default": 200 },
            "numbered": { "type": "boolean", "default": true, "description": "是否带行号" }
        }),
        &["path"],
    ));

    items.push(file_tool(
        "fs_grep",
        "只读。按 glob + 正则搜索 workspace，返回 matches[{path,line,text}] / total / truncated / nextCursor。\
何时用：定位符号、报错、配置项，再配合 fs_read 开窗。\
何时不用：已知精确路径时直接 fs_read；远端缺 python3 会返回 mcp_missing_interpreter。\
sessionId 与 hostId 二选一。",
        json!({
            "pattern": { "type": "string", "description": "搜索内容或正则" },
            "path": { "type": "string", "description": "搜索根，默认 workspace 根" },
            "glob": { "type": "string", "default": "*", "description": "文件过滤，如 **/*.c" },
            "regex": { "type": "boolean", "default": true },
            "ignoreCase": { "type": "boolean", "default": false },
            "contextLines": { "type": "integer", "minimum": 0, "maximum": 3, "default": 0 },
            "maxResults": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
            "cursor": {
                "type": "integer",
                "minimum": 0,
                "default": 0,
                "description": "上一页返回的 nextCursor"
            }
        }),
        &["pattern"],
    ));

    items.push(file_tool(
        "fs_glob",
        "只读。按 glob 递归列举 workspace 内文件，返回 matches[{path,size}] / total / truncated / nextCursor。\
何时用：了解目录结构、列出某类文件后批量处理。\
何时不用：需要内容匹配用 fs_grep；不要用它列举整个 home 根。\
sessionId 与 hostId 二选一。",
        json!({
            "pattern": { "type": "string", "description": "glob，如 **/*.c" },
            "path": { "type": "string", "description": "搜索根，默认 workspace 根" },
            "maxResults": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
            "cursor": { "type": "integer", "minimum": 0, "default": 0 }
        }),
        &["pattern"],
    ));

    items.push(remote_file_tool(
        "fs_patch",
        "写操作。按 oldText/newText 做精确替换，可一次改多个文件的多个片段；支持 dryRun 只回 unified diff。\
何时用：已用 fs_read 看过上下文、需要做小范围修改时；先 dryRun 再落盘。\
何时不用：整体覆盖用 fs_write；oldText 必须唯一（不唯一会回候选行号，要求 replaceAll 或加长上下文）。\
受权限档位约束；sessionId 与 hostId 二选一。",
        json!({
            "edits": {
                "type": "array",
                "minItems": 1,
                "maxItems": 20,
                "description": "要修改的文件列表",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "远端文件路径" },
                        "ops": {
                            "type": "array",
                            "minItems": 1,
                            "description": "按顺序应用的替换操作",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "oldText": { "type": "string", "description": "原文片段，必须能匹配" },
                                    "newText": { "type": "string", "description": "替换后的文本" },
                                    "replaceAll": {
                                        "type": "boolean",
                                        "default": false,
                                        "description": "true 时替换全部命中（默认要求唯一）"
                                    }
                                },
                                "required": ["oldText", "newText"]
                            }
                        }
                    },
                    "required": ["path", "ops"]
                }
            },
            "dryRun": {
                "type": "boolean",
                "default": false,
                "description": "只返回 diff，不写入文件"
            }
        }),
        &["edits"],
        false,
    ));

    items.push(remote_file_tool(
        "fs_write",
        "写操作。新建或整体覆盖一个小文本文件（≤512 KiB），走 SFTP 直写，返回 size / sha256 / created。\
何时用：从零生成脚本、配置等小文件；或确知需要整体覆盖时（显式 overwrite=true）。\
何时不用：大文件用 sftp_put；改局部内容用 fs_patch；不要用它覆盖未确认的现有文件。\
受权限档位约束；sessionId 与 hostId 二选一。",
        json!({
            "path": { "type": "string", "description": "远端路径，支持 ~ 与相对 workspace 根的路径" },
            "content": { "type": "string", "description": "完整文件内容（UTF-8）" },
            "overwrite": {
                "type": "boolean",
                "default": false,
                "description": "目标已存在时必须显式置 true"
            }
        }),
        &["path", "content"],
        false,
    ));

    items.push(remote_file_tool(
        "sftp_put",
        "写操作。把本地文件/目录流式上传到远端，只回 path / size / sha256，不回文件内容。\
何时用：上传源码树、构建脚本等大文件或整目录（recursive=true）；token 成本与文件大小无关。\
何时不用：小文本用 fs_write；改局部用 fs_patch；本地路径必须是绝对路径。\
受权限档位约束；sessionId 与 hostId 二选一。",
        json!({
            "items": {
                "type": "array",
                "minItems": 1,
                "maxItems": 2000,
                "items": {
                    "type": "object",
                    "properties": {
                        "localPath": { "type": "string", "description": "本地绝对路径（文件或目录）" },
                        "remotePath": { "type": "string", "description": "远端目标路径，支持 ~ 与相对 workspace 根" }
                    },
                    "required": ["localPath", "remotePath"]
                }
            },
            "overwrite": { "type": "boolean", "default": false, "description": "远端已存在时必须显式置 true" },
            "recursive": { "type": "boolean", "default": false, "description": "目录递归上传" }
        }),
        &["items"],
        false,
    ));

    items.push(remote_file_tool(
        "sftp_get",
        "写操作。把远端文件/目录流式下载到本地，只回 path / size / sha256，不回文件内容。\
何时用：下载编译产物、日志归档等；recursive=true 可整目录拉回。\
何时不用：只需要查看内容用 fs_read 开窗；本地路径必须是绝对路径且默认不覆盖已存在文件。\
受权限档位约束；sessionId 与 hostId 二选一。",
        json!({
            "items": {
                "type": "array",
                "minItems": 1,
                "maxItems": 2000,
                "items": {
                    "type": "object",
                    "properties": {
                        "remotePath": { "type": "string", "description": "远端源路径，支持 ~ 与相对 workspace 根" },
                        "localPath": { "type": "string", "description": "本地目标绝对路径（文件或目录）" }
                    },
                    "required": ["remotePath", "localPath"]
                }
            },
            "overwrite": { "type": "boolean", "default": false, "description": "本地已存在时必须显式置 true" },
            "recursive": { "type": "boolean", "default": false, "description": "目录递归下载" }
        }),
        &["items"],
        false,
    ));

    items.push(remote_file_tool(
        "fs_delete",
        "写操作（两次确认）。先 dryRun=true 列出将删对象并返回 confirmToken；核对后以 dryRun=false + confirmToken 真正删除。\
何时用：清理构建产物、临时文件、确认无用的文件；目录必须 recursive=true。\
何时不用：不确定内容时先用 fs_glob / fs_read；token 5 分钟过期且绑定会话与路径集合，不要臆造或复用。\
受权限档位约束；sessionId 与 hostId 二选一。",
        json!({
            "paths": {
                "type": "array",
                "minItems": 1,
                "maxItems": 200,
                "items": { "type": "string" },
                "description": "远端路径列表，支持 ~ 与相对 workspace 根"
            },
            "recursive": {
                "type": "boolean",
                "default": false,
                "description": "允许删除目录（递归）"
            },
            "dryRun": {
                "type": "boolean",
                "default": true,
                "description": "默认 true：只返回待删清单与 confirmToken"
            },
            "confirmToken": {
                "type": "string",
                "description": "dryRun 返回的 token，dryRun=false 时必填"
            }
        }),
        &["paths"],
        false,
    ));

    items.push(remote_file_tool(
        "build_run",
        "写操作。在远端非交互执行构建命令：cwd 限定 workspace 内，stdout/stderr 各取尾部 maxOutputBytes，另回总量与 exitCode；可选 teeToRemoteFile 把完整日志落到远端文件。\
何时用：sftp_put 上传源码后直接 make/cmake/gcc/cargo/npm；失败先看 stderrTail，再 fs_read fullLog 开窗。\
何时不用：需要交互式终端时用 term_run；只读命令用 term_run 即可；不要在这里做文件读写（用 fs_* 工具）。\
只拦真正破坏性命令（rm -rf /、mkfs、dd 写块设备等），不套终端黑名单。",
        json!({
            "command": { "type": "string", "description": "要执行的构建命令（可多行）" },
            "cwd": { "type": "string", "description": "工作目录，默认 workspace 根" },
            "timeoutMs": {
                "type": "integer",
                "minimum": 1000,
                "maximum": 600000,
                "default": 120000
            },
            "maxOutputBytes": {
                "type": "integer",
                "minimum": 256,
                "maximum": 65536,
                "default": 16384,
                "description": "stdout / stderr 各自保留的尾部字节数"
            },
            "teeToRemoteFile": {
                "type": "string",
                "description": "可选：把完整日志写到该远端路径（workspace 内）"
            }
        }),
        &["command"],
        false,
    ));

    items.push(remote_file_tool(
        "term_run",
        "写操作。逃生平面：在远端非交互执行一条命令，返回 stdoutTail / stderrTail / exitCode / totalBytes。\
何时用：只需要跑命令看结果，或 build_run 不适用的场景（版本探测、git status 等）。\
何时不用：文件查阅/编辑/传输用 fs_* 与 sftp_*；不要用它做文件语义操作。\
只拦真正破坏性命令，不套全量终端黑名单；受权限档位约束。",
        json!({
            "command": { "type": "string", "description": "要执行的命令（可多行）" },
            "timeoutMs": {
                "type": "integer",
                "minimum": 1000,
                "maximum": 600000,
                "default": 30000
            },
            "maxOutputBytes": {
                "type": "integer",
                "minimum": 256,
                "maximum": 65536,
                "default": 16384
            }
        }),
        &["command"],
        false,
    ));

    items.push(remote_file_tool(
        "batch",
        "写操作（复合）。按顺序执行 1–50 个只读/写原语，把「搜索 → 读 → 改」压成一次 MCP 调用；每个 op 独立审批、独立返回。\
何时用：定位代码后连续 grep/read/patch；减少往返与 schema 开销。\
何时不用：破坏性操作（fs_delete / term_run / build_run / sftp_*）必须单独调用；不要嵌套 batch。\
op.args 未带 sessionId / hostId 时自动继承顶层值；stopOnError 默认 true。",
        json!({
            "ops": {
                "type": "array",
                "minItems": 1,
                "maxItems": 50,
                "items": {
                    "type": "object",
                    "properties": {
                        "tool": {
                            "type": "string",
                            "enum": ["fs_read", "fs_grep", "fs_glob", "fs_patch", "fs_write"],
                            "description": "允许组合的工具"
                        },
                        "args": { "type": "object", "description": "该工具的参数" }
                    },
                    "required": ["tool"]
                }
            },
            "stopOnError": {
                "type": "boolean",
                "default": true,
                "description": "遇到失败即停止后续 op"
            }
        }),
        &["ops"],
        false,
    ));

    list
}

fn summarize_command(command: &str) -> String {
    const MAX_CHARS: usize = 200;
    let trimmed = command.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        trimmed.to_string()
    } else {
        let head: String = trimmed.chars().take(MAX_CHARS).collect();
        format!("{head}…")
    }
}

/// `fs_patch` / `fs_write` 审批摘要中展示的目标路径（最多 3 个）。
fn summarize_paths(paths: &[String]) -> String {
    const MAX_SHOWN: usize = 3;
    let mut summary = paths
        .iter()
        .take(MAX_SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > MAX_SHOWN {
        summary.push_str(&format!(" 等 {} 个文件", paths.len()));
    }
    summary
}

/// 从 `fs_patch` 参数里收集目标路径，审批摘要用。
fn patch_targets(args: &Value) -> Vec<String> {
    args.get("edits")
        .and_then(Value::as_array)
        .map(|edits| {
            edits
                .iter()
                .filter_map(|edit| edit.get("path").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn transfer_count(args: &Value) -> usize {
    args.get("items")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

/// 传输结果统一收口：逐项写审计，回 `results[]` + ok/failed 计数。
fn transfer_result(
    tool: &str,
    session_id: &str,
    results: Vec<super::fs::transfer::TransferOutcome>,
) -> ToolResult {
    let mut items = Vec::with_capacity(results.len());
    let mut ok = 0usize;
    for outcome in &results {
        if outcome.ok {
            ok += 1;
            runtime_state::record_audit(change_entry(
                tool,
                Some(session_id),
                Some(&outcome.remote_path),
                Some(outcome.size),
                Some(&outcome.sha256),
                "applied",
            ));
        }
        items.push(outcome.to_json());
    }
    let failed = results.len() - ok;
    let data = json!({ "results": items, "ok": ok, "failed": failed });
    if failed == 0 {
        ToolResult::ok(
            "传输完成",
            "需要校验时对比返回的 sha256；目录已按文件逐项返回。",
            data,
        )
    } else if ok == 0 {
        ToolResult::err_with_data(
            "transfer_failed",
            format!("{failed} 项全部失败"),
            "按 results[].code 修正：已存在时置 overwrite=true；目录置 recursive=true；本地路径必须是绝对路径。",
            data,
        )
    } else {
        ToolResult::err_with_data(
            "transfer_partial",
            format!("{ok} 项成功，{failed} 项失败"),
            "按 results[].code 修正失败项后只重传这部分。",
            data,
        )
    }
}

/// 写操作审批：auto 直接放行；observer 直接拒绝；confirm 先查许可记忆表，再走 UI 审批。
#[allow(clippy::too_many_arguments)]
async fn approval_gate(
    cfg: &McpConfig,
    rt: &Arc<McpRuntime>,
    app: &AppHandle,
    gen: u64,
    disconnected: Arc<AtomicBool>,
    tool: &str,
    args_summary: String,
    args: Value,
    session_id: Option<String>,
    target_label: Option<String>,
) -> Result<(), ToolResult> {
    match cfg.permission_mode {
        PermissionMode::Auto => Ok(()),
        PermissionMode::Observer => Err(ToolResult::err(
            "permission_denied",
            "当前权限档位为 observer，写操作被拒绝",
            HINT_PERMISSION,
        )),
        PermissionMode::Confirm => {
            let allowed = rt
                .request_approval(
                    app,
                    gen,
                    tool,
                    args_summary,
                    args,
                    session_id,
                    target_label,
                    disconnected,
                )
                .await;
            if allowed {
                Ok(())
            } else {
                Err(ToolResult::err(
                    "permission_denied",
                    format!("{tool} 的审批被拒绝、超时或客户端已断开"),
                    HINT_PERMISSION,
                ))
            }
        }
    }
}

fn session_meta(
    state: &AppState,
    session_id: &str,
) -> Result<(SessionOwner, SessionKind), ToolResult> {
    let registry = state.lock_sessions().map_err(|e| internal_error(e))?;
    match registry.get(session_id) {
        Some(record) => Ok((record.owner.clone(), record.kind)),
        None => Err(ToolResult::err(
            "session_not_found",
            format!("找不到会话 {session_id}"),
            "重新调用 get_environment 获取当前活跃会话 id；会话可能已关闭。",
        )),
    }
}

fn environment(state: &AppState) -> Result<Value, ToolResult> {
    let registry = state.lock_sessions().map_err(|e| internal_error(e))?;
    let handles = crate::error::locked(&state.sessions).map_err(internal_error)?;
    let mut sessions = Vec::new();
    for (id, record) in registry.iter() {
        sessions.push(json!({
            "id": id,
            "kind": record.kind.as_str(),
            "phase": match record.phase {
                crate::state::SessionPhase::Pending => "pending",
                crate::state::SessionPhase::Ready => "ready",
                crate::state::SessionPhase::Closed => "closed",
            },
            "hostId": handles.get(id).map(|handle| handle.profile_id().to_string()),
            "origin": match &record.owner {
                SessionOwner::Headless(_) => "mcp",
                SessionOwner::Window(_) => "user",
            },
        }));
    }
    drop(handles);
    drop(registry);
    let hosts = crate::db::profile::list(&state.db).map_err(internal_error)?;
    let host_items: Vec<Value> = hosts
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "host": p.host,
                "port": p.port,
                "groupId": p.group_id,
            })
        })
        .collect();
    Ok(json!({
        "sessions": sessions,
        "hosts": host_items,
        "hostCount": hosts.len(),
        "cacheable": true,
        "ttl": 30,
    }))
}

pub async fn call_tool(
    state: &AppState,
    cfg: &McpConfig,
    rt: &Arc<McpRuntime>,
    app: &AppHandle,
    gen: u64,
    disconnected: Arc<AtomicBool>,
    name: &str,
    args: &Value,
) -> ToolResult {
    match name {
        "batch" => {
            let ops = match args.get("ops").and_then(Value::as_array) {
                Some(list) if !list.is_empty() => list,
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 ops",
                        "ops 必须是 1–50 个 {tool, args} 对象。",
                    )
                }
            };
            if ops.len() > MAX_BATCH_OPS {
                return ToolResult::err(
                    "mcp_too_many_items",
                    format!("ops 超过上限 {MAX_BATCH_OPS}"),
                    "拆分为多次 batch 调用。",
                );
            }
            let stop_on_error = args
                .get("stopOnError")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let inherit_session = args.get("sessionId").and_then(Value::as_str);
            let inherit_host = args.get("hostId").and_then(Value::as_str);
            let mut results = Vec::with_capacity(ops.len());
            let mut failed = 0usize;
            for op in ops {
                let tool = op
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let mut op_args = op.get("args").cloned().unwrap_or_else(|| json!({}));
                if !op_args.is_object() {
                    op_args = json!({});
                }
                if op_args.get("sessionId").is_none() && op_args.get("hostId").is_none() {
                    if let Some(session_id) = inherit_session {
                        op_args["sessionId"] = json!(session_id);
                    } else if let Some(host_id) = inherit_host {
                        op_args["hostId"] = json!(host_id);
                    }
                }
                let outcome = if BATCH_TOOLS.contains(&tool.as_str()) {
                    Box::pin(call_tool(
                        state,
                        cfg,
                        rt,
                        app,
                        gen,
                        disconnected.clone(),
                        &tool,
                        &op_args,
                    ))
                    .await
                } else {
                    ToolResult::err(
                        "batch_tool_not_allowed",
                        format!("batch 不支持工具：{tool}"),
                        "仅允许 fs_read / fs_grep / fs_glob / fs_patch / fs_write；其余请单独调用。",
                    )
                };
                if outcome.is_error {
                    failed += 1;
                }
                let parsed = serde_json::from_str::<Value>(&outcome.text).unwrap_or(Value::Null);
                results.push(json!({
                    "tool": tool,
                    "isError": outcome.is_error,
                    "result": parsed,
                }));
                if outcome.is_error && stop_on_error {
                    break;
                }
            }
            let data = json!({ "results": results, "failed": failed });
            if failed == 0 {
                ToolResult::ok(
                    "batch 执行完成",
                    "结果按 ops 顺序返回；失败项会带 code。",
                    data,
                )
            } else {
                ToolResult::err_with_data(
                    "batch_partial",
                    format!("{failed} 个 op 失败"),
                    "按 results[].result.code 修正失败步骤后重跑。",
                    data,
                )
            }
        }
        "get_environment" => match environment(state) {
            Ok(v) => ToolResult::ok(
                "已返回当前环境快照",
                "用 sessions[].id 作为 terminal_execute / session_close 的 sessionId；phase 为 ready 的会话才能执行命令。",
                v,
            ),
            Err(e) => e,
        },
        "vault_hosts_list" => match crate::db::profile::list(&state.db) {
            Ok(list) => {
                let items: Vec<Value> = list
                    .iter()
                    .map(|p| {
                        json!({
                            "id": p.id,
                            "name": p.name,
                            "host": p.host,
                            "port": p.port,
                            "groupId": p.group_id,
                        })
                    })
                    .collect();
                ToolResult::ok(
                    "已返回已保存主机清单",
                    "这些主机尚未打开连接；要执行命令需先在 termX 中打开会话，再调用 get_environment。",
                    json!({ "hosts": items }),
                )
            }
            Err(e) => internal_error(e),
        },
        "snippets_list" => match crate::db::snippet::load(&state.data_dir) {
            Ok(list) => {
                let items: Vec<Value> = list
                    .iter()
                    .map(|s| {
                        json!({
                            "id": s.id,
                            "name": s.name,
                            "package": s.package,
                            "command": s.command,
                            "description": s.description,
                        })
                    })
                    .collect();
                ToolResult::ok(
                    "已返回已保存代码片段",
                    "找到目标命令后，用 terminal_execute 在指定会话中执行。",
                    json!({ "snippets": items }),
                )
            }
            Err(e) => internal_error(e),
        },
        "fs_read" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            match super::fs::read::fs_read(state, &session.session_id, args, &jail_root).await {
                Ok(out) => ToolResult::ok(
                    "已读取文件窗口",
                    "内容未读完时带 startLine = nextCursor 继续；大文件先用 fs_grep 定位。",
                    json!({
                        "path": out.path,
                        "lines": out.lines,
                        "totalLines": out.total_lines,
                        "size": out.size,
                        "mtime": out.mtime,
                        "truncated": out.truncated,
                        "nextCursor": out.next_cursor,
                    }),
                ),
                Err(e) => tool_error(e),
            }
        }
        "fs_grep" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            match super::fs::grep::fs_grep(
                state,
                &session.session_id,
                &session.profile_id,
                &session.handle,
                args,
                &jail_root,
            )
            .await
            {
                Ok(out) => ToolResult::ok(
                    "搜索完成",
                    "继续翻页传 cursor = nextCursor；定位后用 fs_read 开窗看上下文。",
                    json!({
                        "matches": out.matches,
                        "total": out.total,
                        "truncated": out.truncated,
                        "nextCursor": out.next_cursor,
                    }),
                ),
                Err(e) => tool_error(e),
            }
        }
        "fs_glob" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            match super::fs::glob::fs_glob(state, &session.session_id, args, &jail_root).await {
                Ok(out) => ToolResult::ok(
                    "已列举文件",
                    "继续翻页传 cursor = nextCursor；需要内容匹配改用 fs_grep。",
                    json!({
                        "matches": out.matches,
                        "total": out.total,
                        "truncated": out.truncated,
                        "nextCursor": out.next_cursor,
                    }),
                ),
                Err(e) => tool_error(e),
            }
        }
        "fs_patch" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            let targets = patch_targets(args);
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "fs_patch",
                format!("修改 {}", summarize_paths(&targets)),
                args.clone(),
                Some(session.session_id.clone()),
                Some(session.profile_id.clone()),
            )
            .await
            {
                runtime_state::record_audit(change_entry(
                    "fs_patch",
                    Some(&session.session_id),
                    None,
                    None,
                    None,
                    "denied",
                ));
                return e;
            }
            let dry_run = args
                .get("dryRun")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            match super::fs::patch::fs_patch(
                state,
                &session.session_id,
                &session.profile_id,
                &session.handle,
                args,
                &jail_root,
            )
            .await
            {
                Ok(results) => {
                    let items: Vec<Value> = results
                        .iter()
                        .map(|item| {
                            runtime_state::record_audit(change_entry(
                                "fs_patch",
                                Some(&session.session_id),
                                Some(&item.path),
                                None,
                                Some(&item.sha256),
                                if dry_run { "dry_run" } else { "applied" },
                            ));
                            json!({
                                "path": item.path,
                                "applied": item.applied,
                                "sha256": item.sha256,
                                "diff": item.diff,
                            })
                        })
                        .collect();
                    ToolResult::ok(
                        if dry_run {
                            "已生成 diff（未写入）"
                        } else {
                            "替换已写入"
                        },
                        if dry_run {
                            "确认 diff 无误后以 dryRun=false 再次调用落盘。"
                        } else {
                            "需要验证时用 fs_read 查看改动位置；no_match / ambiguous 时按返回的 lines 调整 oldText。"
                        },
                        json!({ "dryRun": dry_run, "results": items }),
                    )
                }
                Err(e) => tool_error(e),
            }
        }
        "fs_write" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            let target = args
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "fs_write",
                format!("写入 {target}"),
                args.clone(),
                Some(session.session_id.clone()),
                Some(session.profile_id.clone()),
            )
            .await
            {
                runtime_state::record_audit(change_entry(
                    "fs_write",
                    Some(&session.session_id),
                    Some(&target),
                    None,
                    None,
                    "denied",
                ));
                return e;
            }
            match super::fs::write::fs_write(state, &session.session_id, args, &jail_root).await {
                Ok(out) => {
                    runtime_state::record_audit(change_entry(
                        "fs_write",
                        Some(&session.session_id),
                        Some(&out.path),
                        Some(out.size),
                        Some(&out.sha256),
                        "applied",
                    ));
                    ToolResult::ok(
                        "文件已写入",
                        "需要校验时用 fs_read 或对比 sha256；大文件改用 sftp_put。",
                        json!({
                            "path": out.path,
                            "size": out.size,
                            "sha256": out.sha256,
                            "created": out.created,
                        }),
                    )
                }
                Err(e) => tool_error(e),
            }
        }
        "sftp_put" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            let count = transfer_count(args);
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "sftp_put",
                format!("上传 {count} 项到远端"),
                args.clone(),
                Some(session.session_id.clone()),
                Some(session.profile_id.clone()),
            )
            .await
            {
                runtime_state::record_audit(change_entry(
                    "sftp_put",
                    Some(&session.session_id),
                    None,
                    None,
                    None,
                    "denied",
                ));
                return e;
            }
            match super::fs::transfer::sftp_put(
                app,
                state,
                &session.session_id,
                args,
                &jail_root,
            )
            .await
            {
                Ok(results) => transfer_result("sftp_put", &session.session_id, results),
                Err(e) => tool_error(e),
            }
        }
        "sftp_get" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            let count = transfer_count(args);
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "sftp_get",
                format!("下载 {count} 项到本地"),
                args.clone(),
                Some(session.session_id.clone()),
                Some(session.profile_id.clone()),
            )
            .await
            {
                runtime_state::record_audit(change_entry(
                    "sftp_get",
                    Some(&session.session_id),
                    None,
                    None,
                    None,
                    "denied",
                ));
                return e;
            }
            match super::fs::transfer::sftp_get(
                app,
                state,
                &session.session_id,
                args,
                &jail_root,
            )
            .await
            {
                Ok(results) => transfer_result("sftp_get", &session.session_id, results),
                Err(e) => tool_error(e),
            }
        }
        "fs_delete" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            let dry_run = args
                .get("dryRun")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let count = args
                .get("paths")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            // dry-run 只是预览，不触发审批；真正删除才走权限闸门。
            if !dry_run {
                if let Err(e) = approval_gate(
                    cfg,
                    rt,
                    app,
                    gen,
                    disconnected.clone(),
                    "fs_delete",
                    format!("删除 {count} 项（recursive）"),
                    args.clone(),
                    Some(session.session_id.clone()),
                    Some(session.profile_id.clone()),
                )
                .await
                {
                    runtime_state::record_audit(change_entry(
                        "fs_delete",
                        Some(&session.session_id),
                        None,
                        None,
                        None,
                        "denied",
                    ));
                    return e;
                }
            }
            match super::fs::delete::fs_delete(state, &session.session_id, args, &jail_root).await {
                Ok(outcome) => {
                    for entry in &outcome.entries {
                        runtime_state::record_audit(change_entry(
                            "fs_delete",
                            Some(&session.session_id),
                            Some(&entry.path),
                            Some(entry.size),
                            None,
                            if outcome.dry_run { "dry_run" } else { "applied" },
                        ));
                    }
                    let items: Vec<Value> =
                        outcome.entries.iter().map(|entry| entry.to_json()).collect();
                    let data = if outcome.dry_run {
                        json!({
                            "dryRun": true,
                            "wouldDelete": items,
                            "confirmToken": outcome.confirm_token,
                            "expiresInSec": runtime_state::DELETE_TOKEN_TTL.as_secs(),
                        })
                    } else {
                        json!({ "dryRun": false, "deleted": items })
                    };
                    ToolResult::ok(
                        if outcome.dry_run {
                            "删除计划已生成（未删除任何文件）"
                        } else {
                            "已删除"
                        },
                        if outcome.dry_run {
                            "核对 wouldDelete 后，以 dryRun=false + confirmToken 再调用执行。"
                        } else {
                            "删除不可恢复；如需确认目录状态可再用 fs_glob。"
                        },
                        data,
                    )
                }
                Err(e) => tool_error(e),
            }
        }
        "build_run" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let jail_root = super::config::workspace_root(&state.db);
            let command = match args
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
            {
                Some(value) if !value.is_empty() => value.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 command",
                        "command 必须是非空字符串，例如 \"make -j8\"。",
                    )
                }
            };
            if let Some(reason) = super::policy::destructive_reason(&command) {
                return ToolResult::err(
                    "mcp_command_destructive",
                    format!("命令命中破坏性策略：{reason}"),
                    "改用 typed 文件工具或更具体的命令；确需执行请在 termX 终端手动操作。",
                );
            }
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "build_run",
                summarize_command(&command),
                args.clone(),
                Some(session.session_id.clone()),
                Some(session.profile_id.clone()),
            )
            .await
            {
                return e;
            }
            match super::fs::build::fs_build_run(
                state,
                &session.session_id,
                &session.handle,
                args,
                &jail_root,
            )
            .await
            {
                Ok(out) => ToolResult::ok(
                    if out.exit_code == Some(0) {
                        "构建成功"
                    } else {
                        "构建结束（exitCode 非 0）"
                    },
                    "失败先看 stderrTail；完整日志用 fullLog 配 fs_read 开窗；产物用 sftp_get 下载。",
                    json!({
                        "exitCode": out.exit_code,
                        "stdoutTail": out.stdout_tail,
                        "stderrTail": out.stderr_tail,
                        "stdoutBytes": out.stdout_bytes,
                        "stderrBytes": out.stderr_bytes,
                        "totalBytes": out.stdout_bytes + out.stderr_bytes,
                        "truncated": out.truncated,
                        "fullLog": out.full_log,
                        "teeFailed": out.tee_failed,
                        "cwd": out.cwd,
                    }),
                ),
                Err(e) => tool_error(e),
            }
        }
        "term_run" => {
            let session = match super::fs::session::resolve(app, state, args).await {
                Ok(value) => value,
                Err(e) => return tool_error(e),
            };
            let command = match args
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
            {
                Some(value) if !value.is_empty() => value.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 command",
                        "command 必须是非空字符串，例如 \"uname -a\"。",
                    )
                }
            };
            if let Some(reason) = super::policy::destructive_reason(&command) {
                return ToolResult::err(
                    "mcp_command_destructive",
                    format!("命令命中破坏性策略：{reason}"),
                    "改用 typed 文件工具或更具体的命令；确需执行请在 termX 终端手动操作。",
                );
            }
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "term_run",
                summarize_command(&command),
                args.clone(),
                Some(session.session_id.clone()),
                Some(session.profile_id.clone()),
            )
            .await
            {
                return e;
            }
            let timeout = args
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(30_000)
                .clamp(1_000, 600_000);
            let max_output = args
                .get("maxOutputBytes")
                .and_then(Value::as_u64)
                .unwrap_or(16 * 1024)
                .clamp(256, 64 * 1024) as usize;
            match crate::ssh::client::exec_once(
                &session.handle,
                &command,
                Duration::from_millis(timeout),
                false,
            )
            .await
            {
                Ok(out) => {
                    let (stdout_tail, out_cut) = super::fs::tail_bytes(&out.stdout, max_output);
                    let (stderr_tail, err_cut) = super::fs::tail_bytes(&out.stderr, max_output);
                    ToolResult::ok(
                        "命令执行完成",
                        "exitCode 非 0 时先看 stderrTail；需要完整输出时缩小范围分次执行。",
                        json!({
                            "exitCode": out.exit_code,
                            "stdoutTail": stdout_tail,
                            "stderrTail": stderr_tail,
                            "stdoutBytes": out.stdout.len(),
                            "stderrBytes": out.stderr.len(),
                            "totalBytes": out.stdout.len() + out.stderr.len(),
                            "truncated": out_cut || err_cut,
                        }),
                    )
                }
                Err(e) => tool_error(e),
            }
        }
        "terminal_execute" => {
            let session_id = match args.get("sessionId").and_then(Value::as_str) {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 sessionId",
                        HINT_SESSION_ID,
                    )
                }
            };
            let command = match args.get("command").and_then(Value::as_str) {
                Some(v) if !v.trim().is_empty() => v.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 command",
                        "command 必须是非空字符串，例如 \"uname -a\"。",
                    )
                }
            };
            let timeout = args.get("timeoutMs").and_then(Value::as_u64);
            // 传输判定先于黑名单与审批：terminal_execute 只复用 SSH 的 exec 通道，
            // 串口 / Telnet 没有 exitCode 语义，直接回明确错误码，不弹审批。
            let (owner, kind) = match session_meta(state, &session_id) {
                Ok(v) => v,
                Err(e) => return e,
            };
            if kind != SessionKind::Ssh {
                return ToolResult::err(
                    "mcp_unsupported_session_kind",
                    format!(
                        "会话 {session_id} 的类型是 {}，terminal_execute 只支持 SSH 会话",
                        kind.as_str()
                    ),
                    HINT_SSH_ONLY,
                );
            }
            // 正则层黑名单（Netcatty `commandBlocklist.json` 默认清单 + 用户规则）。
            let blocklist = super::blocklist::load(&state.db);
            if let Some(rule) = super::blocklist::first_match(&blocklist, &command) {
                return ToolResult::err(
                    "command_blocked",
                    format!("命令被命令黑名单拦截：命中规则 \"{rule}\""),
                    "改用等价但更具体的命令，或请用户在「设置 → AI → 命令黑名单」中调整规则。",
                );
            }
            let blacklist = match crate::ai::command_blacklist::load(&state.db) {
                Ok(bl) => bl,
                Err(e) => return internal_error(e),
            };
            if let Err(e) = crate::ai::sanitize::validate_with(&command, &blacklist) {
                return ToolResult::err(
                    "command_blocked",
                    format!("命令被黑名单拦截：{e:?}"),
                    "改用等价但更具体的命令，或请用户在设置中调整命令黑名单。",
                );
            }
            let target_label = Some(format!("{} · {}", kind.as_str(), session_id));
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "terminal_execute",
                summarize_command(&command),
                args.clone(),
                Some(session_id.clone()),
                target_label,
            )
            .await
            {
                return e;
            }
            match plugin::plugin_exec_impl(state, &owner, session_id, command, timeout).await {
                Ok(out) => ToolResult::ok(
                    "命令执行完成",
                    "如需在同一会话继续执行，复用相同的 sessionId；任务结束调用 session_close。",
                    json!({
                        "stdout": out.stdout,
                        "stderr": out.stderr,
                        "exitCode": out.exit_code,
                    }),
                ),
                Err(e) => ToolResult::err(
                    e.code(),
                    e.to_string(),
                    "确认会话仍处于 ready 且命令语法正确后重试；会话断开时重新 get_environment。",
                ),
            }
        }
        "session_close" => {
            let session_id = match args.get("sessionId").and_then(Value::as_str) {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => {
                    return ToolResult::err(
                        "missing_argument",
                        "缺少必填参数 sessionId",
                        HINT_SESSION_ID,
                    )
                }
            };
            let (owner, kind) = match session_meta(state, &session_id) {
                Ok(v) => v,
                Err(e) => return e,
            };
            let target_label = Some(format!("{} · {}", kind.as_str(), session_id));
            if let Err(e) = approval_gate(
                cfg,
                rt,
                app,
                gen,
                disconnected.clone(),
                "session_close",
                format!("关闭会话 {session_id}"),
                args.clone(),
                Some(session_id.clone()),
                target_label,
            )
            .await
            {
                return e;
            }
            match lifecycle::close_resource(state, &session_id, kind, &owner) {
                Ok(()) => ToolResult::ok(
                    "会话已关闭",
                    "如需再次连接，请先在 termX 中重新打开会话，再调用 get_environment。",
                    json!({ "closed": session_id }),
                ),
                Err(e) => ToolResult::err(
                    "close_failed",
                    e.to_string(),
                    "重新 get_environment 确认会话是否仍存在；若已关闭可忽略。",
                ),
            }
        }
        _ => ToolResult::err(
            "unknown_tool",
            format!("未知工具：{name}"),
            "调用 tools/list 查看可用工具；文件类操作优先用 fs_read / fs_grep / fs_glob / fs_patch / sftp_put / sftp_get，终端交互用 terminal_execute。",
        ),
    }
}

pub fn resources() -> Value {
    json!([
        {
            "uri": "termx://environment",
            "name": "termX environment",
            "description": "当前活跃会话与主机数量（等同 get_environment 的只读快照）",
            "mimeType": "application/json"
        }
    ])
}

pub fn read_resource(state: &AppState, uri: &str) -> ToolResult {
    match uri {
        "termx://environment" => match environment(state) {
            Ok(v) => ToolResult::ok(
                "已返回当前环境快照",
                "该资源等同 get_environment；需要执行命令时改用 terminal_execute。",
                v,
            ),
            Err(e) => e,
        },
        _ => ToolResult::err(
            "unknown_resource",
            format!("未知资源：{uri}"),
            "可用资源：termx://environment。",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_keeps_business_fields_and_unified_shape() {
        let ok = envelope(
            "ok",
            "done",
            "next",
            Some(json!({ "sessions": [], "hostCount": 3 })),
        );
        assert_eq!(ok["code"], "ok");
        assert_eq!(ok["message"], "done");
        assert_eq!(ok["hint"], "next");
        assert_eq!(ok["hostCount"], 3);
        assert!(ok["sessions"].is_array());

        let err = envelope("session_not_found", "missing", "retry", None);
        assert_eq!(err["code"], "session_not_found");
        assert_eq!(err.as_object().map(|m| m.len()), Some(3));
    }

    #[test]
    fn definitions_cover_all_tools_with_full_schemas() {
        let defs = definitions();
        let list = defs.as_array().unwrap();
        assert_eq!(list.len(), 16);
        for tool in list {
            let name = tool["name"].as_str().unwrap();
            let desc = tool["description"].as_str().unwrap();
            assert!(desc.contains("何时用"), "{name} 缺少何时用");
            assert!(desc.contains("何时不用"), "{name} 缺少何时不用");
            let schema = &tool["inputSchema"];
            assert_eq!(schema["type"], "object");
            assert!(schema["properties"].is_object());
            assert!(schema["required"].is_array());
        }
        let exec = list
            .iter()
            .find(|t| t["name"] == "terminal_execute")
            .unwrap();
        let props = &exec["inputSchema"]["properties"];
        assert_eq!(props["sessionId"]["type"], "string");
        assert!(props["sessionId"]["examples"].is_array());
        assert_eq!(props["timeoutMs"]["type"], "integer");
        assert_eq!(
            exec["inputSchema"]["required"],
            json!(["sessionId", "command"])
        );

        let read = list.iter().find(|t| t["name"] == "fs_read").unwrap();
        assert_eq!(read["annotations"]["readOnlyHint"], true);
        assert!(read["inputSchema"]["anyOf"].is_array());
        assert_eq!(read["inputSchema"]["required"], json!(["path"]));
        assert!(read["inputSchema"]["properties"]["hostId"].is_object());

        let patch = list.iter().find(|t| t["name"] == "fs_patch").unwrap();
        assert_eq!(patch["annotations"]["readOnlyHint"], false);
        assert_eq!(patch["inputSchema"]["required"], json!(["edits"]));
        assert_eq!(
            patch["inputSchema"]["properties"]["edits"]["items"]["required"],
            json!(["path", "ops"])
        );
        let write = list.iter().find(|t| t["name"] == "fs_write").unwrap();
        assert_eq!(write["annotations"]["readOnlyHint"], false);
        assert_eq!(write["inputSchema"]["required"], json!(["path", "content"]));

        for name in ["sftp_put", "sftp_get"] {
            let tool = list.iter().find(|t| t["name"] == name).unwrap();
            assert_eq!(tool["annotations"]["readOnlyHint"], false, "{name}");
            assert_eq!(tool["inputSchema"]["required"], json!(["items"]), "{name}");
            let expected: &[&str] = if name == "sftp_put" {
                &["localPath", "remotePath"]
            } else {
                &["remotePath", "localPath"]
            };
            assert_eq!(
                tool["inputSchema"]["properties"]["items"]["items"]["required"],
                json!(expected),
                "{name}"
            );
        }

        let delete = list.iter().find(|t| t["name"] == "fs_delete").unwrap();
        assert_eq!(delete["annotations"]["readOnlyHint"], false);
        assert_eq!(delete["annotations"]["destructiveHint"], true);
        assert_eq!(delete["inputSchema"]["required"], json!(["paths"]));
        assert_eq!(
            delete["inputSchema"]["properties"]["dryRun"]["default"],
            true
        );

        let batch = list.iter().find(|t| t["name"] == "batch").unwrap();
        assert_eq!(batch["inputSchema"]["required"], json!(["ops"]));
        assert_eq!(
            batch["inputSchema"]["properties"]["ops"]["items"]["properties"]["tool"]["enum"],
            json!(["fs_read", "fs_grep", "fs_glob", "fs_patch", "fs_write"])
        );
    }

    #[test]
    fn read_only_tools_keep_original_fields() {
        let ok = ToolResult::ok("msg", "hint", json!({ "sessions": [], "hostCount": 1 }));
        assert!(!ok.is_error);
        let parsed: Value = serde_json::from_str(&ok.text).unwrap();
        assert!(parsed["sessions"].is_array());
        assert_eq!(parsed["hostCount"], 1);
    }

    #[test]
    fn unsupported_session_kind_keeps_code_and_points_agent_to_ssh() {
        let result = tool_error(crate::error::AppError::config(
            "mcp_unsupported_session_kind",
            json!({ "id": "serial-1", "kind": "serial" }),
        ));
        assert!(result.is_error);
        let parsed: Value = serde_json::from_str(&result.text).unwrap();
        assert_eq!(parsed["code"], "mcp_unsupported_session_kind");
        assert!(parsed["message"]
            .as_str()
            .unwrap()
            .contains("mcp_unsupported_session_kind"));
        let hint = parsed["hint"].as_str().unwrap();
        assert!(hint.contains("SSH"));
        assert!(hint.contains("serial"));
        assert!(hint.contains("Telnet"));
    }
}
