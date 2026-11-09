//! Shell Discovery — 跨平台 shell 检测（对齐 Netcatty shellDiscovery.cjs）。
//!
//! Windows: CMD / Windows PowerShell / PowerShell 7 / WSL 发行版 / Git Bash /
//! Cygwin，注册表访问走 `reg.exe` 子进程（无原生依赖）；失败项静默跳过。
//! Unix/macOS: 读 `/etc/shells`，`$SHELL` 缺失时补到列表头，`$SHELL`（否则
//! 首个）标记 is_default。
//!
//! 结果首次调用后进程内缓存（与 Netcatty 一致）——装新 shell 后重启 app 生效；
//! 设置页的"刷新"走另一条 `refresh_shells` 路径，不受此缓存影响。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::models::DiscoveredShell;

/// 外部子进程（reg / where / wsl）超时 —— 与 Netcatty EXEC_OPTS.timeout 一致。
const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(5);

static CACHED_SHELLS: OnceLock<Vec<DiscoveredShell>> = OnceLock::new();

/// 统一发现入口：当前平台可用的全部 shell，首次调用后缓存。
pub fn discover() -> Vec<DiscoveredShell> {
    CACHED_SHELLS
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            {
                discover_windows_shells()
            }
            #[cfg(not(target_os = "windows"))]
            {
                discover_unix_shells()
            }
        })
        .clone()
}

// ---------------------------------------------------------------------------
// 子进程工具
// ---------------------------------------------------------------------------

/// 运行命令拿 stdout，带超时（超时杀进程返 None）。输出都很小（KB 级），
/// 退出后再读 stdout 不会死锁。非零退出码 / spawn 失败 / 超时一律 None ——
/// 调用方按"该项检测失败，静默跳过"处理。
fn run_capture(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW —— 对齐 Netcatty windowsHide: true，
        // 不让 reg/wsl 探测弹出控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = Vec::new();
                if let Some(mut stdout) = child.stdout.take() {
                    use std::io::Read;
                    if stdout.read_to_end(&mut out).is_err() {
                        return None;
                    }
                }
                return Some(out);
            }
            Ok(None) => {
                if start.elapsed() > SUBPROCESS_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return None,
        }
    }
}

fn run_capture_text(program: &str, args: &[&str]) -> Option<String> {
    run_capture(program, args).map(|b| String::from_utf8_lossy(&b).into_owned())
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// 解析 `reg query` 输出中的值行，形如：
/// `    InstallPath    REG_SZ    C:\Program Files\Git`
/// 对齐 Netcatty 正则 `^\s+.+?\s+REG_\w+\s+(.+)$`：行必须以空白开头，
/// REG_ 类型 token 之后的剩余部分即值（值本身可含空格）。
#[cfg(target_os = "windows")]
fn parse_reg_value_line(line: &str) -> Option<String> {
    if !line.starts_with(char::is_whitespace) {
        return None;
    }
    let reg_pos = line.find("REG_")?;
    // REG_ 前必须有值名（`.+?\s+`）——即 REG_ 不能紧跟行首空白。
    if line[..reg_pos].trim().is_empty() {
        return None;
    }
    let after = &line[reg_pos..];
    let tok_end = after.find(|c: char| c.is_whitespace())?;
    // 类型 token 必须形如 REG_SZ / REG_EXPAND_SZ / REG_DWORD……（全字母数字下划线）
    if !after[..tok_end]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    let value = after[tok_end..].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// 查询注册表键的某个值；value_name 为空 = 查默认值（`/ve`）。
#[cfg(target_os = "windows")]
fn reg_query_value(key_path: &str, value_name: &str) -> Option<String> {
    let output = if value_name.is_empty() {
        run_capture_text("reg", &["query", key_path, "/ve"])?
    } else {
        run_capture_text("reg", &["query", key_path, "/v", value_name])?
    };
    for line in output.split(['\r', '\n']) {
        if let Some(v) = parse_reg_value_line(line) {
            return Some(v);
        }
    }
    None
}

/// 枚举注册表键下的直接子键（完整路径列表）。
#[cfg(target_os = "windows")]
fn reg_enum_subkeys(key_path: &str) -> Vec<String> {
    let Some(output) = run_capture_text("reg", &["query", key_path]) else {
        return Vec::new();
    };
    let parent = key_path.to_lowercase();
    output
        .split(['\r', '\n'])
        .filter_map(|line| {
            let trimmed = line.trim();
            let lower = trimmed.to_lowercase();
            if lower.starts_with("hk")
                && lower != parent
                && lower.starts_with(&format!("{parent}\\"))
            {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Windows App Execution Alias（MSIX/Store 安装）路径判定 ——
/// %LOCALAPPDATA%\Microsoft\WindowsApps 下的 reparse point，
/// `Path::exists()` 会失败但 spawn 能正常拉起打包应用。
#[cfg(target_os = "windows")]
fn is_windows_app_execution_alias_path(file_path: &str) -> bool {
    let Some(local_app_data) = std::env::var("LOCALAPPDATA").ok() else {
        return false;
    };
    let normalize = |p: &str| {
        p.replace('\\', "/")
            .split('/')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("/")
            .to_lowercase()
    };
    let alias_dir = format!("{}/microsoft/windowsapps/", normalize(&local_app_data));
    normalize(file_path).starts_with(&alias_dir)
}

/// `where.exe` 在 PATH 上找可执行文件。普通可执行文件优先；
/// WindowsApps 别名只作最后兜底（对齐 Netcatty findExecutableOnPath）。
#[cfg(target_os = "windows")]
fn find_executable_on_path(name: &str) -> Option<String> {
    let result = run_capture_text("where.exe", &[name])?;
    let mut alias_candidate: Option<String> = None;
    for candidate in result
        .split(['\r', '\n'])
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
    {
        if is_windows_app_execution_alias_path(candidate) {
            if alias_candidate.is_none() {
                alias_candidate = Some(candidate.to_string());
            }
            continue;
        }
        if !Path::new(candidate).exists() {
            continue;
        }
        return Some(candidate.to_string());
    }
    alias_candidate
}

/// WSL 发行版名 → 图标标识（对齐 Netcatty mapWslDistroIcon）。
#[cfg(target_os = "windows")]
fn map_wsl_distro_icon(distro_name: &str) -> String {
    let lower = distro_name.to_lowercase();
    if lower.contains("ubuntu") {
        return "ubuntu".into();
    }
    if lower.contains("debian") {
        return "debian".into();
    }
    if lower.contains("kali") {
        return "kali".into();
    }
    if lower.contains("alpine") {
        return "alpine".into();
    }
    if lower.contains("opensuse") || lower.contains("suse") {
        return "opensuse".into();
    }
    if lower.contains("fedora") {
        return "fedora".into();
    }
    if lower.contains("arch") {
        return "arch".into();
    }
    if lower.contains("oracle") {
        return "oracle".into();
    }
    "linux".into()
}

#[cfg(target_os = "windows")]
fn wsl_distro_id(distro_name: &str) -> String {
    let slug: String = distro_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    format!("wsl-{slug}")
}

#[cfg(target_os = "windows")]
fn detect_cmd() -> Option<DiscoveredShell> {
    let com_spec = std::env::var("ComSpec").ok().filter(|s| !s.is_empty());
    let command = match com_spec.as_deref() {
        Some(p) if Path::new(p).exists() => p.to_string(),
        // ComSpec 缺失或指向不存在的文件 → 裸名，Windows 自己解析。
        _ => "cmd.exe".to_string(),
    };
    Some(DiscoveredShell {
        id: "cmd".into(),
        name: "CMD".into(),
        command,
        args: Vec::new(),
        icon: "cmd".into(),
        is_default: false,
    })
}

#[cfg(target_os = "windows")]
fn detect_powershell() -> Option<DiscoveredShell> {
    if let Some(found) = find_executable_on_path("powershell") {
        return Some(DiscoveredShell {
            id: "powershell".into(),
            name: "Windows PowerShell".into(),
            command: found,
            args: vec!["-NoLogo".into()],
            icon: "powershell".into(),
            is_default: false,
        });
    }
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let fallback = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if fallback.exists() {
        return Some(DiscoveredShell {
            id: "powershell".into(),
            name: "Windows PowerShell".into(),
            command: fallback.to_string_lossy().into_owned(),
            args: vec!["-NoLogo".into()],
            icon: "powershell".into(),
            is_default: false,
        });
    }
    None
}

#[cfg(target_os = "windows")]
fn detect_pwsh() -> Option<DiscoveredShell> {
    let make = |command: String| DiscoveredShell {
        id: "pwsh".into(),
        name: "PowerShell 7".into(),
        command,
        args: vec!["-NoLogo".into()],
        icon: "pwsh".into(),
        is_default: false,
    };
    // 1. where.exe
    if let Some(found) = find_executable_on_path("pwsh") {
        return Some(make(found));
    }
    // 2. 注册表 App Paths（默认值）
    if let Some(reg_path) = reg_query_value(
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe",
        "",
    ) {
        if Path::new(&reg_path).exists() {
            return Some(make(reg_path));
        }
    }
    // 3. 常见安装路径兜底
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let fallback = PathBuf::from(program_files)
        .join("PowerShell")
        .join("7")
        .join("pwsh.exe");
    if fallback.exists()
        && fallback
            .to_string_lossy()
            .to_lowercase()
            .contains("powershell")
    {
        return Some(make(fallback.to_string_lossy().into_owned()));
    }
    None
}

#[cfg(target_os = "windows")]
fn detect_wsl_distros() -> Vec<DiscoveredShell> {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let wsl_exe = PathBuf::from(&system_root).join("System32").join("wsl.exe");
    let dir_is_system32 = wsl_exe
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_lowercase().ends_with("system32"))
        .unwrap_or(false);
    if !wsl_exe.exists() || !dir_is_system32 {
        return Vec::new();
    }
    let wsl_exe_str = wsl_exe.to_string_lossy().into_owned();
    let mut distros: Vec<DiscoveredShell> = Vec::new();

    // 首选 `wsl.exe -l -q`：多数 Windows build 输出 UTF-16LE（字节流含 0x00），
    // 探测到 NUL 即按 UTF-16LE 解码，否则按 UTF-8。
    if let Some(buf) = run_capture(&wsl_exe_str, &["-l", "-q"]) {
        let is_utf16 = buf.len() >= 2 && buf.contains(&0x00);
        let output = if is_utf16 {
            let units: Vec<u16> = buf
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(&buf).into_owned()
        };
        for name in output
            .split(['\r', '\n'])
            .map(|l| l.replace('\0', "").trim().to_string())
            .filter(|l| !l.is_empty())
        {
            distros.push(DiscoveredShell {
                id: wsl_distro_id(&name),
                name: format!("{name} (WSL)"),
                command: wsl_exe_str.clone(),
                args: vec!["-d".into(), name.clone()],
                icon: map_wsl_distro_icon(&name),
                is_default: false,
            });
        }
        if !distros.is_empty() {
            return distros;
        }
    }

    // 兜底：枚举 Lxss 注册表子键读 DistributionName。
    for subkey in reg_enum_subkeys("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss") {
        let Some(distro_name) = reg_query_value(&subkey, "DistributionName") else {
            continue;
        };
        distros.push(DiscoveredShell {
            id: wsl_distro_id(&distro_name),
            name: format!("{distro_name} (WSL)"),
            command: wsl_exe_str.clone(),
            args: vec!["-d".into(), distro_name.clone()],
            icon: map_wsl_distro_icon(&distro_name),
            is_default: false,
        });
    }
    distros
}

#[cfg(target_os = "windows")]
fn detect_git_bash() -> Option<DiscoveredShell> {
    let make = |command: String| DiscoveredShell {
        id: "git-bash".into(),
        name: "Git Bash".into(),
        command,
        args: vec!["--login".into(), "-i".into()],
        icon: "git-bash".into(),
        is_default: false,
    };
    if let Some(install_path) = reg_query_value("HKLM\\SOFTWARE\\GitForWindows", "InstallPath") {
        let bash_exe = PathBuf::from(install_path).join("bin").join("bash.exe");
        if bash_exe.exists() {
            return Some(make(bash_exe.to_string_lossy().into_owned()));
        }
    }
    for root in [
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into()),
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into()),
    ] {
        let candidate = PathBuf::from(root).join("Git").join("bin").join("bash.exe");
        if candidate.exists() {
            return Some(make(candidate.to_string_lossy().into_owned()));
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn detect_cygwin() -> Option<DiscoveredShell> {
    let make = |command: String| DiscoveredShell {
        id: "cygwin".into(),
        name: "Cygwin".into(),
        command,
        args: vec!["--login".into(), "-i".into()],
        icon: "cygwin".into(),
        is_default: false,
    };
    let root_dir = reg_query_value("HKLM\\SOFTWARE\\Cygwin\\setup", "rootdir")
        .or_else(|| reg_query_value("HKLM\\SOFTWARE\\WOW6432Node\\Cygwin\\setup", "rootdir"));
    if let Some(root_dir) = root_dir {
        let bash_exe = PathBuf::from(root_dir).join("bin").join("bash.exe");
        if bash_exe.exists() {
            return Some(make(bash_exe.to_string_lossy().into_owned()));
        }
    }
    let fallback = "C:\\cygwin64\\bin\\bash.exe";
    if Path::new(fallback).exists() {
        return Some(make(fallback.into()));
    }
    None
}

/// Windows 全量发现：顺序 cmd → powershell → pwsh → WSL 发行版 → Git Bash →
/// Cygwin；默认标记优先级 pwsh > powershell > cmd（恰一个 is_default）。
#[cfg(target_os = "windows")]
fn discover_windows_shells() -> Vec<DiscoveredShell> {
    let mut shells: Vec<DiscoveredShell> = Vec::new();
    if let Some(cmd) = detect_cmd() {
        shells.push(cmd);
    }
    if let Some(powershell) = detect_powershell() {
        shells.push(powershell);
    }
    if let Some(pwsh) = detect_pwsh() {
        shells.push(pwsh);
    }
    shells.extend(detect_wsl_distros());
    if let Some(git_bash) = detect_git_bash() {
        shells.push(git_bash);
    }
    if let Some(cygwin) = detect_cygwin() {
        shells.push(cygwin);
    }
    for preferred in ["pwsh", "powershell", "cmd"] {
        if let Some(s) = shells.iter_mut().find(|s| s.id == preferred) {
            s.is_default = true;
            break;
        }
    }
    shells
}

// ---------------------------------------------------------------------------
// Unix / macOS
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "windows"))]
fn map_unix_shell_name(basename: &str) -> String {
    match basename {
        "zsh" => "Zsh",
        "bash" => "Bash",
        "fish" => "Fish",
        "sh" => "sh",
        "ksh" => "Ksh",
        "tcsh" => "Tcsh",
        "csh" => "Csh",
        "dash" => "Dash",
        "nu" => "Nushell",
        "pwsh" => "PowerShell",
        other => other,
    }
    .to_string()
}

#[cfg(not(target_os = "windows"))]
fn map_unix_shell_icon(basename: &str) -> String {
    match basename {
        "zsh" => "zsh",
        "bash" => "bash",
        "fish" => "fish",
        "nu" => "nushell",
        "pwsh" => "pwsh",
        // sh / ksh / tcsh / csh / dash 及未知 shell 一律 terminal
        _ => "terminal",
    }
    .to_string()
}

/// 需要 `-l`（login）启动的 shell（对齐 Netcatty isLoginShell）。
#[cfg(not(target_os = "windows"))]
fn is_login_shell(basename: &str) -> bool {
    matches!(basename, "bash" | "zsh" | "fish" | "ksh" | "sh")
}

/// 路径 → id slug：去首部 `/`，分隔符换 `-`（对齐 Netcatty 去重名逻辑）。
#[cfg(not(target_os = "windows"))]
fn path_slug(shell_path: &str) -> String {
    shell_path
        .trim_start_matches('/')
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn basename_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Unix 全量发现：/etc/shells 去注释 → 存在性 + realpath 去重 →
/// 同名 basename 用路径 slug 消歧 → $SHELL 缺失补头 → $SHELL（否则首个）默认。
#[cfg(not(target_os = "windows"))]
fn discover_unix_shells() -> Vec<DiscoveredShell> {
    use std::collections::{HashMap, HashSet};

    let mut shells: Vec<DiscoveredShell> = Vec::new();
    let mut seen_real: HashSet<PathBuf> = HashSet::new();

    let mut etc_shell_paths: Vec<String> = Vec::new();
    if let Ok(content) = std::fs::read_to_string("/etc/shells") {
        etc_shell_paths = content
            .split(['\r', '\n'])
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect();
    }

    let mut valid_paths: Vec<String> = Vec::new();
    for shell_path in etc_shell_paths {
        if !Path::new(&shell_path).exists() {
            continue;
        }
        let real = std::fs::canonicalize(&shell_path).unwrap_or_else(|_| PathBuf::from(&shell_path));
        if !seen_real.insert(real) {
            continue;
        }
        valid_paths.push(shell_path);
    }

    // basename 计数：>1 时 id 用路径 slug、name 带路径消歧。
    let mut base_count: HashMap<String, usize> = HashMap::new();
    for shell_path in &valid_paths {
        *base_count.entry(basename_of(shell_path)).or_insert(0) += 1;
    }

    for shell_path in &valid_paths {
        let base = basename_of(shell_path);
        let needs_disambiguation = base_count.get(&base).copied().unwrap_or(0) > 1;
        let args: Vec<String> = if is_login_shell(&base) {
            vec!["-l".into()]
        } else {
            Vec::new()
        };
        shells.push(DiscoveredShell {
            id: if needs_disambiguation {
                path_slug(shell_path)
            } else {
                base.clone()
            },
            name: if needs_disambiguation {
                format!("{} ({})", map_unix_shell_name(&base), shell_path)
            } else {
                map_unix_shell_name(&base)
            },
            command: shell_path.clone(),
            args,
            icon: map_unix_shell_icon(&base),
            is_default: false,
        });
    }

    // $SHELL 不在列表里 → 补到最前。
    if let Ok(env_shell) = std::env::var("SHELL") {
        let env_shell = env_shell.trim().to_string();
        if !env_shell.is_empty() && Path::new(&env_shell).exists() {
            let env_real =
                std::fs::canonicalize(&env_shell).unwrap_or_else(|_| PathBuf::from(&env_shell));
            if !seen_real.contains(&env_real) {
                let base = basename_of(&env_shell);
                let has_duplicate = shells
                    .iter()
                    .any(|s| basename_of(&s.command) == base);
                shells.insert(
                    0,
                    DiscoveredShell {
                        id: if has_duplicate {
                            path_slug(&env_shell)
                        } else {
                            base.clone()
                        },
                        name: if has_duplicate {
                            format!("{} ({})", map_unix_shell_name(&base), env_shell)
                        } else {
                            map_unix_shell_name(&base)
                        },
                        command: env_shell.clone(),
                        args: if is_login_shell(&base) {
                            vec!["-l".into()]
                        } else {
                            Vec::new()
                        },
                        icon: map_unix_shell_icon(&base),
                        is_default: false,
                    },
                );
            }
        }
    }

    // 默认：$SHELL 精确匹配（路径或 basename==id），否则首个。
    if let Ok(env_shell) = std::env::var("SHELL") {
        let env_shell = env_shell.trim().to_string();
        if !env_shell.is_empty() {
            let base = basename_of(&env_shell);
            if let Some(s) = shells.iter_mut().find(|s| s.command == env_shell) {
                s.is_default = true;
            } else if let Some(s) = shells.iter_mut().find(|s| s.id == base) {
                s.is_default = true;
            }
        }
    }
    if !shells.is_empty() && !shells.iter().any(|s| s.is_default) {
        shells[0].is_default = true;
    }

    shells
}

// ---------------------------------------------------------------------------
// 纯逻辑单测（不依赖本机装了什么 shell）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_reg_value_line_matches_regedit_output() {
        let line = "    InstallPath    REG_SZ    C:\\Program Files\\Git";
        assert_eq!(
            parse_reg_value_line(line).as_deref(),
            Some("C:\\Program Files\\Git")
        );
        // 值含空格照常；REG_EXPAND_SZ 类型也认。
        let expand = "    (默认)    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe";
        assert_eq!(
            parse_reg_value_line(expand).as_deref(),
            Some("%SystemRoot%\\system32\\cmd.exe")
        );
        // 键标题行（无缩进）不是值行。
        assert_eq!(parse_reg_value_line("HKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows"), None);
        // 空值 / 无 REG_ token 的行返 None。
        assert_eq!(parse_reg_value_line("    NoValueHere"), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn wsl_distro_id_slugs_non_alphanumerics() {
        assert_eq!(wsl_distro_id("Ubuntu-22.04"), "wsl-ubuntu-22-04");
        assert_eq!(wsl_distro_id("Debian"), "wsl-debian");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn map_wsl_distro_icon_falls_back_to_linux() {
        assert_eq!(map_wsl_distro_icon("Ubuntu-22.04"), "ubuntu");
        assert_eq!(map_wsl_distro_icon("openSUSE-Leap-15.4"), "opensuse");
        assert_eq!(map_wsl_distro_icon("SomeCustomDistro"), "linux");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cmd_always_discovered() {
        // CMD 探测不依赖任何外部条件 —— Windows 上必有。
        let cmd = detect_cmd().expect("cmd detection should never fail on Windows");
        assert_eq!(cmd.id, "cmd");
        assert!(cmd.args.is_empty());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unix_name_icon_login_mappings() {
        assert_eq!(map_unix_shell_name("zsh"), "Zsh");
        assert_eq!(map_unix_shell_name("nu"), "Nushell");
        assert_eq!(map_unix_shell_name("weird"), "weird");
        assert_eq!(map_unix_shell_icon("fish"), "fish");
        assert_eq!(map_unix_shell_icon("dash"), "terminal");
        assert!(is_login_shell("bash"));
        assert!(!is_login_shell("nu"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn path_slug_strips_leading_slash_and_separators() {
        assert_eq!(path_slug("/usr/local/bin/bash"), "usr-local-bin-bash");
        assert_eq!(path_slug("/bin/sh"), "bin-sh");
    }

    #[test]
    fn discover_returns_consistent_cache() {
        // 缓存语义：两次调用结果一致（同进程内发现列表不变）。
        assert_eq!(discover(), discover());
    }
}
