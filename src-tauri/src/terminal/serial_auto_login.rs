//! 串口自动登录 — 监视输出流中的 `login:` / `Password:` 提示符并注入配置的
//! 凭据。状态机语义对齐 Netcatty `telnetAutoLogin.cjs`（重写而非复制）。
//! 纯逻辑：无 I/O、无定时器 —— 串口读循环对每个输出块调 `feed`，对每次读
//! 超时（100ms tick）调 `check_expiry`，因此静默设备也能按时过期。
//!
//! 与 Netcatty 的有意偏差（已记录）：
//! - 不用墙钟定时器，过期由读循环 tick 驱动；
//! - 完成（complete）之后用户输入不再补发 "cancelled"（属噪音）。

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;

/// 提示符匹配保留的输出尾部长度。
const TAIL_LIMIT: usize = 2048;
/// 每行参与提示符匹配的最大长度（对齐参考实现 slice(-320)）。
const PROMPT_LINE_LIMIT: usize = 320;
/// 命令提示符只看短行 —— 以 ">" 结尾的超长 banner 行不是 shell 提示符。
const COMMAND_PROMPT_MAX_LEN: usize = 200;

fn ansi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))").unwrap()
    })
}

fn last_login_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[\s(\[])(?:last|previous)\s+login(?:\s*[:：>])?\s*$").unwrap()
    })
}

fn username_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[^A-Za-z0-9])(?:user\s*name|username|login|logon|account|userid|user\s*id|user|用户名|帐号|账号|登录|登入)(?:\s*[:：>])?\s*$").unwrap()
    })
}

fn password_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[^A-Za-z0-9])(?:password|passwd|passcode|passphrase|pass\s*phrase|pin|密码|口令)(?:\s*[:：>])?\s*$").unwrap()
    })
}

fn continue_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:press|hit)\s+(?:[<\[(]?\s*)?(?:return|enter|any\s+key|space)\b(?:\s*[>\]\)])?.*(?:continue|get\s+started|start|begin|started)?\.?\s*$").unwrap()
    })
}

fn command_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[$#>]\s*$").unwrap())
}

fn trailing_ws_nl_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]+\n").unwrap())
}

fn strip_ansi(text: &str) -> String {
    ansi_re().replace_all(text, "").into_owned()
}

/// 去 ANSI、CR→LF、行尾空白归一，供提示符行匹配。
fn normalize_prompt_tail(text: &str) -> String {
    let stripped = strip_ansi(text);
    let cr = stripped.replace('\r', "\n");
    trailing_ws_nl_re().replace_all(&cr, "\n").into_owned()
}

/// 取字符串末尾 `n` 个字符（对齐 JS 的 slice(-n)）。
fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        s.to_owned()
    } else {
        s.chars().skip(count - n).collect()
    }
}

fn last_prompt_line(text: &str) -> String {
    let normalized = normalize_prompt_tail(text);
    // 尾部换行会让「最后一行」是空串而漏掉提示（设备打完提示才换行等待）；
    // 裁掉行尾空白后取最后一个非空行。
    let last = normalized.trim_end().split('\n').next_back().unwrap_or("");
    tail_chars(last, PROMPT_LINE_LIMIT)
}

fn prompt_lines(text: &str) -> Vec<String> {
    normalize_prompt_tail(text)
        .split('\n')
        .map(|l| tail_chars(l, PROMPT_LINE_LIMIT))
        .collect()
}

fn is_continue_prompt(text: &str) -> bool {
    continue_re().is_match(&last_prompt_line(text))
}

fn is_username_prompt(text: &str) -> bool {
    let line = last_prompt_line(text);
    !last_login_re().is_match(&line) && username_re().is_match(&line)
}

fn is_password_prompt(text: &str) -> bool {
    password_re().is_match(&last_prompt_line(text))
}

fn is_command_prompt(text: &str) -> bool {
    let line = last_prompt_line(text);
    let line = line.trim_end();
    if line.is_empty() || line.chars().count() > COMMAND_PROMPT_MAX_LEN {
        return false;
    }
    if last_login_re().is_match(line) {
        return false;
    }
    if username_re().is_match(line) {
        return false;
    }
    if password_re().is_match(line) {
        return false;
    }
    if continue_re().is_match(line) {
        return false;
    }
    command_re().is_match(line)
}

/// 最后一个 Password 行之前是否存在用户名提示行（设备把两个提示印在同一屏）。
fn has_username_prompt_before_password(text: &str) -> bool {
    let lines = prompt_lines(text);
    let Some(last_pw) = lines.iter().rposition(|l| password_re().is_match(l)) else {
        return false;
    };
    lines[..last_pw]
        .iter()
        .any(|l| !last_login_re().is_match(l) && username_re().is_match(l))
}

/// 裸 CR/LF（唤醒静默控制台）不视为人工接管。
fn is_wake_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
}

/// 检测器对调用方的动作。`SendLine` 只带内容，行尾 `\r` 由调用方追加
/// （以便走字符集编码）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoLoginAction {
    SendLine(String),
    Complete,
    Cancelled,
    Incomplete,
}

pub struct SerialAutoLogin {
    username: String,
    password: String,
    has_password: bool,
    tail: String,
    sent_wake: bool,
    sent_username: bool,
    sent_password: bool,
    disabled: bool,
    completed: bool,
    user_input_notified: bool,
    incomplete_notified: bool,
    started_at: Instant,
    timeout: Duration,
}

impl SerialAutoLogin {
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

    /// 凭据为空（用户名空 且 未提供密码）→ 返回 None，自动登录整体关闭。
    /// `Some("")` 的密码算「有密码」（空密码设备存在）。
    pub fn new(username: Option<String>, password: Option<String>) -> Option<Self> {
        Self::with_timeout(username, password, Self::DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(
        username: Option<String>,
        password: Option<String>,
        timeout: Duration,
    ) -> Option<Self> {
        let username = username.map(|u| u.trim().to_owned()).unwrap_or_default();
        let has_password = password.is_some();
        if username.is_empty() && !has_password {
            return None;
        }
        Some(Self {
            username,
            password: password.unwrap_or_default(),
            has_password,
            tail: String::new(),
            sent_wake: false,
            sent_username: false,
            sent_password: false,
            disabled: false,
            completed: false,
            user_input_notified: false,
            incomplete_notified: false,
            started_at: Instant::now(),
            timeout,
        })
    }

    fn expired(&self) -> bool {
        // `>=` 让 timeout=0 确定性地表示「立即过期」，测试不依赖真实时间流逝。
        self.started_at.elapsed() >= self.timeout
    }

    /// 测试钩子：强制立即过期（配合 `>=` 判定，无需等待真实时间）。
    #[cfg(test)]
    fn force_expire(&mut self) {
        self.timeout = Duration::ZERO;
    }

    fn push_tail(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.tail.push_str(text);
        let count = self.tail.chars().count();
        if count > TAIL_LIMIT {
            let cut = count - TAIL_LIMIT;
            let byte_idx = self
                .tail
                .char_indices()
                .nth(cut)
                .map(|(i, _)| i)
                .unwrap_or(self.tail.len());
            self.tail = self.tail[byte_idx..].to_owned();
        }
    }

    fn notify_incomplete(&mut self, out: &mut Vec<AutoLoginAction>) {
        if self.incomplete_notified || self.completed {
            return;
        }
        self.incomplete_notified = true;
        out.push(AutoLoginAction::Incomplete);
    }

    fn complete_if_ready(&mut self, out: &mut Vec<AutoLoginAction>) {
        if (self.sent_password || self.sent_username) && is_command_prompt(&self.tail) {
            self.disabled = true;
            if !self.completed {
                self.completed = true;
                out.push(AutoLoginAction::Complete);
            }
        }
    }

    /// 喂入一段输出文本（已按会话字符集解码为 UTF-8）。
    pub fn feed(&mut self, text: &str) -> Vec<AutoLoginAction> {
        let mut out = Vec::new();
        if self.expired() {
            self.disabled = true;
            // 过期后继续观察：慢启动设备可能在窗口过后才印出首个登录提示。
            // 只报告待答提示，绝不在此发凭据。
            self.push_tail(text);
            if is_username_prompt(&self.tail) || is_password_prompt(&self.tail) {
                self.notify_incomplete(&mut out);
            }
            return out;
        }
        if self.disabled {
            return out;
        }

        self.push_tail(text);
        self.complete_if_ready(&mut out);
        if self.disabled {
            return out;
        }

        if !self.sent_wake && is_continue_prompt(&self.tail) {
            self.sent_wake = true;
            out.push(AutoLoginAction::SendLine(String::new()));
            return out;
        }

        if !self.sent_username
            && (!self.username.is_empty() || self.has_password)
            && (is_username_prompt(&self.tail) || has_username_prompt_before_password(&self.tail))
        {
            self.sent_username = true;
            out.push(AutoLoginAction::SendLine(self.username.clone()));
            self.complete_if_ready(&mut out);
        }

        if !self.disabled && !self.sent_password && self.has_password && is_password_prompt(&self.tail)
        {
            self.sent_password = true;
            out.push(AutoLoginAction::SendLine(self.password.clone()));
            self.complete_if_ready(&mut out);
        }

        // 设备要密码但没配：上报停滞，避免调用方把后续命令当密码喂进去。
        if !self.disabled && !self.completed && !self.has_password && is_password_prompt(&self.tail)
        {
            self.notify_incomplete(&mut out);
        }
        out
    }

    /// 用户键入。裸 CR/LF 唤醒不取消；其余输入取消并报告一次。
    /// 已 disabled/completed 时静默（偏差：完成后不补发 cancelled）。
    pub fn user_input(&mut self, data: &str) -> Vec<AutoLoginAction> {
        let mut out = Vec::new();
        if self.disabled || self.completed {
            return out;
        }
        if is_wake_input(data)
            && !self.sent_username
            && !self.sent_password
            && !is_username_prompt(&self.tail)
            && !is_password_prompt(&self.tail)
        {
            return out; // 唤醒静默控制台，不是接管
        }
        self.disabled = true;
        if !self.user_input_notified {
            self.user_input_notified = true;
            out.push(AutoLoginAction::Cancelled);
        }
        out
    }

    /// 读循环 tick 驱动的过期检查（替代 Netcatty 的 setTimeout）。
    pub fn check_expiry(&mut self) -> Vec<AutoLoginAction> {
        let mut out = Vec::new();
        if self.completed || self.disabled || !self.expired() {
            return out;
        }
        self.disabled = true;
        if (self.sent_password || self.sent_username)
            && (is_username_prompt(&self.tail) || is_password_prompt(&self.tail))
        {
            self.notify_incomplete(&mut out);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det() -> SerialAutoLogin {
        SerialAutoLogin::with_timeout(
            Some("admin".into()),
            Some("secret".into()),
            Duration::from_secs(60),
        )
        .unwrap()
    }

    #[test]
    fn disabled_without_credentials() {
        assert!(SerialAutoLogin::new(None, None).is_none());
        assert!(SerialAutoLogin::new(Some("   ".into()), None).is_none());
        assert!(SerialAutoLogin::new(Some("u".into()), None).is_some());
        // 空密码也算「有密码」
        assert!(SerialAutoLogin::new(None, Some(String::new())).is_some());
    }

    #[test]
    fn full_login_flow_completes() {
        let mut d = det();
        assert_eq!(d.feed("router login: "), vec![AutoLoginAction::SendLine("admin".into())]);
        assert_eq!(d.feed("Password: "), vec![AutoLoginAction::SendLine("secret".into())]);
        assert_eq!(d.feed("\r\nrouter# "), vec![AutoLoginAction::Complete]);
        // 完成后静默
        assert!(d.feed("more output").is_empty());
        assert!(d.user_input("x").is_empty());
    }

    #[test]
    fn wake_input_does_not_cancel() {
        let mut d = det();
        assert!(d.user_input("\r").is_empty());
        assert!(d.user_input("\r\n").is_empty());
        // 仍然武装：登录提示照常应答
        assert_eq!(d.feed("login: "), vec![AutoLoginAction::SendLine("admin".into())]);
    }

    #[test]
    fn typed_input_cancels_once() {
        let mut d = det();
        assert_eq!(d.user_input("x"), vec![AutoLoginAction::Cancelled]);
        assert!(d.user_input("y").is_empty());
        assert!(d.feed("login: ").is_empty());
    }

    #[test]
    fn wake_at_prompt_is_takeover() {
        let mut d = det();
        let _ = d.feed("login: "); // 已发用户名
        // 提示符前的回车不再是「唤醒」，视为接管
        assert_eq!(d.user_input("\r"), vec![AutoLoginAction::Cancelled]);
    }

    #[test]
    fn expiry_reports_incomplete_when_prompt_pending() {
        let mut d = SerialAutoLogin::with_timeout(
            Some("admin".into()),
            Some("wrong".into()),
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            d.feed("login: "),
            vec![AutoLoginAction::SendLine("admin".into())]
        );
        assert_eq!(
            d.feed("Password: "),
            vec![AutoLoginAction::SendLine("wrong".into())]
        );
        // 设备拒绝凭据后重新印出登录提示并静默
        assert!(d.feed("\r\nlogin: ").is_empty());
        d.force_expire();
        assert_eq!(d.check_expiry(), vec![AutoLoginAction::Incomplete]);
        assert!(d.check_expiry().is_empty());
    }

    #[test]
    fn expiry_without_credentials_sent_is_silent() {
        let mut d = SerialAutoLogin::with_timeout(
            Some("admin".into()),
            None,
            Duration::from_millis(0),
        )
        .unwrap();
        assert!(d.check_expiry().is_empty());
        // 过期后出现的提示只报 incomplete，不发凭据
        assert_eq!(d.feed("login: "), vec![AutoLoginAction::Incomplete]);
    }

    #[test]
    fn continue_prompt_sends_empty_line() {
        let mut d = det();
        assert_eq!(
            d.feed("Press RETURN to continue\n"),
            vec![AutoLoginAction::SendLine(String::new())]
        );
    }

    #[test]
    fn ansi_is_stripped_before_matching() {
        let mut d = det();
        assert_eq!(
            d.feed("\x1b[1;32mlogin: \x1b[0m"),
            vec![AutoLoginAction::SendLine("admin".into())]
        );
    }

    #[test]
    fn password_prompt_without_password_reports_incomplete() {
        let mut d = SerialAutoLogin::with_timeout(
            Some("admin".into()),
            None,
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(d.feed("login: "), vec![AutoLoginAction::SendLine("admin".into())]);
        assert_eq!(d.feed("Password: "), vec![AutoLoginAction::Incomplete]);
    }

    #[test]
    fn last_login_banner_is_not_a_username_prompt() {
        let mut d = det();
        assert!(d.feed("Last login: Wed Oct 1 12:00:00 on tty1\r\n").is_empty());
    }

    #[test]
    fn command_prompt_alone_does_not_complete() {
        let mut d = det();
        // 未发任何凭据时，命令提示符不触发 complete
        assert!(d.feed("root@dev:~# ").is_empty());
    }

    #[test]
    fn username_and_password_in_one_chunk() {
        let mut d = det();
        assert_eq!(
            d.feed("Username: \r\nPassword: "),
            vec![
                AutoLoginAction::SendLine("admin".into()),
                AutoLoginAction::SendLine("secret".into()),
            ]
        );
    }

    #[test]
    fn prompt_helpers_classify() {
        assert!(is_username_prompt("login:"));
        assert!(is_username_prompt("用户名："));
        assert!(!is_username_prompt("Last login: x"));
        assert!(is_password_prompt("Password:"));
        assert!(is_password_prompt("口令"));
        assert!(is_command_prompt("# "));
        assert!(is_command_prompt("user@host:~$"));
        assert!(!is_command_prompt("Password:"));
        assert!(is_continue_prompt("Press any key to continue"));
    }
}
