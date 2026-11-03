use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

use crate::error::AppResult;
use crate::models::CastHeader;

/// 会话级手动录制（阶段 B）：写句柄与元数据放在同一个值里，由
/// `SessionHandle.recorder_slot` 共享给 SSH session_task 与命令层。
/// 自动录制同样走这个结构，因此"开始 / 停止"对两种来源一视同仁。
pub struct ActiveRecording {
    pub recorder: Recorder,
    pub path: PathBuf,
    /// 开始时刻（Unix 毫秒），供前端工具栏状态提示。
    pub started_at_ms: i64,
    pub title: String,
}

impl ActiveRecording {
    pub fn new(path: PathBuf, cols: u32, rows: u32, title: String) -> AppResult<Self> {
        let recorder = Recorder::new(path.clone(), cols, rows)?;
        Ok(Self {
            recorder,
            path,
            started_at_ms: chrono::Utc::now().timestamp_millis(),
            title,
        })
    }
}

/// asciicast v2 录制器。
///
/// PTY/SSH 把字节流按内核缓冲随便切，多字节 UTF-8 字符可能横跨 chunk。
/// 直接 `from_utf8_lossy` 会把半个字符替换成 U+FFFD，导致 top/less 这类
/// 输出 box-drawing 字符的全屏命令回放时乱码。
/// 这里用 `pending` 缓冲尾部不完整字节，下次拼回去再写。
pub struct Recorder {
    writer: BufWriter<File>,
    start: Instant,
    pending: Vec<u8>,
}

impl Recorder {
    pub fn new(path: PathBuf, cols: u32, rows: u32) -> AppResult<Self> {
        // Recordings can contain sensitive terminal output. Create the file
        // 0600 on Unix so it's owner-only from birth (no 0644→chmod TOCTOU),
        // matching how `master.key` is written. The recordings dir is already
        // 0700; this is defense in depth.
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(&path)?;
        let mut writer = BufWriter::new(file);

        let header = CastHeader {
            version: 2,
            width: cols,
            height: rows,
            timestamp: chrono::Utc::now().timestamp(),
        };
        let header_json = serde_json::to_string(&header).map_err(|e| {
            crate::error::AppError::other(
                "recorder_init_failed",
                serde_json::json!({ "err": e.to_string() }),
            )
        })?;
        writeln!(writer, "{header_json}")?;

        Ok(Self {
            writer,
            start: Instant::now(),
            pending: Vec::new(),
        })
    }

    /// 记录一个输出事件（原始字节）。
    pub fn record(&mut self, data: &[u8]) -> AppResult<()> {
        self.pending.extend_from_slice(data);
        let split = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) => match e.error_len() {
                // 尾部多字节字符被截断：留到下次再拼。
                None => e.valid_up_to(),
                // 真正的非法字节：整段 lossy 写出，让 U+FFFD 出现在该出现的位置。
                Some(_) => self.pending.len(),
            },
        };
        if split == 0 {
            return Ok(());
        }

        let elapsed = self.start.elapsed().as_secs_f64();
        let chunk = String::from_utf8_lossy(&self.pending[..split]);
        let event = serde_json::json!([elapsed, "o", chunk.as_ref()]);
        writeln!(self.writer, "{event}")?;
        self.pending.drain(..split);
        Ok(())
    }

    /// 刷新并关闭录制。残留的 pending 字节按 lossy 写出。
    pub fn finish(mut self) -> AppResult<()> {
        if !self.pending.is_empty() {
            let elapsed = self.start.elapsed().as_secs_f64();
            let chunk = String::from_utf8_lossy(&self.pending);
            let event = serde_json::json!([elapsed, "o", chunk.as_ref()]);
            writeln!(self.writer, "{event}")?;
            self.pending.clear();
        }
        self.writer.flush()?;
        Ok(())
    }
}

// ── 手动会话日志（文本）──────────────────────────────────────────
//
// 与 asciicast 录制器完全独立：这里产出用户可读的文本日志（raw / txt / html），
// 由用户在开始前通过系统保存对话框选择目标路径。之所以不复用 `Recorder`：
// asciicast 是「日志库」的自动录制产物（.cast），手动会话日志是 Netcatty
// `sessionLog` 的对应能力（纯文本文件），两者必须能同时开启、互不抢占。

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextLogFormat {
    /// 保留 ANSI 控制序列原样。
    Raw,
    /// 去掉 ANSI 控制序列的纯文本。
    Text,
    /// 去掉 ANSI 后转义的 HTML，外层包 `<pre>`。
    Html,
}

impl TextLogFormat {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "raw" => Some(Self::Raw),
            "txt" => Some(Self::Text),
            "html" => Some(Self::Html),
            _ => None,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Raw => "log",
            Self::Text => "txt",
            Self::Html => "html",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Text => "txt",
            Self::Html => "html",
        }
    }
}

/// 会话日志状态：路径 + 开始时间，供工具栏显示「录制中」。
pub struct ActiveTextLog {
    pub recorder: TextLogRecorder,
    pub path: PathBuf,
    pub started_at_ms: i64,
    pub format: TextLogFormat,
}

impl ActiveTextLog {
    pub fn new(
        path: PathBuf,
        format: TextLogFormat,
        timestamps: bool,
    ) -> AppResult<Self> {
        let recorder = TextLogRecorder::new(path.clone(), format, timestamps)?;
        Ok(Self {
            recorder,
            path,
            started_at_ms: chrono::Utc::now().timestamp_millis(),
            format,
        })
    }
}

pub struct TextLogRecorder {
    writer: BufWriter<File>,
    format: TextLogFormat,
    timestamps: bool,
    start: Instant,
    pending: Vec<u8>,
    at_line_start: bool,
}

impl TextLogRecorder {
    pub fn new(path: PathBuf, format: TextLogFormat, timestamps: bool) -> AppResult<Self> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(&path)?;
        let mut writer = BufWriter::new(file);
        if format == TextLogFormat::Html {
            writeln!(
                writer,
                "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>session log</title></head><body><pre>"
            )?;
        }
        Ok(Self {
            writer,
            format,
            timestamps,
            start: Instant::now(),
            pending: Vec::new(),
            at_line_start: true,
        })
    }

    /// 与 asciicast 录制器相同的 UTF-8 跨 chunk 处理，但写文本而不是 JSON 事件。
    pub fn record(&mut self, data: &[u8]) -> AppResult<()> {
        self.pending.extend_from_slice(data);
        let split = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) => match e.error_len() {
                None => e.valid_up_to(),
                Some(_) => self.pending.len(),
            },
        };
        if split == 0 {
            return Ok(());
        }
        let chunk = String::from_utf8_lossy(&self.pending[..split]).into_owned();
        self.write_chunk(&chunk)?;
        self.pending.drain(..split);
        Ok(())
    }

    fn write_chunk(&mut self, chunk: &str) -> AppResult<()> {
        let cleaned = match self.format {
            TextLogFormat::Raw => chunk.to_string(),
            TextLogFormat::Text | TextLogFormat::Html => strip_ansi(chunk),
        };
        let body = if self.format == TextLogFormat::Html {
            escape_html(&cleaned)
        } else {
            cleaned
        };
        if self.timestamps {
            for piece in split_keep_newlines(&body) {
                if piece.is_empty() {
                    continue;
                }
                if self.at_line_start && !piece.starts_with('\n') {
                    let elapsed = self.start.elapsed();
                    write!(
                        self.writer,
                        "[{:02}:{:02}:{:02}.{:03}] ",
                        elapsed.as_secs() / 3600,
                        (elapsed.as_secs() / 60) % 60,
                        elapsed.as_secs() % 60,
                        elapsed.subsec_millis(),
                    )?;
                }
                self.writer.write_all(piece.as_bytes())?;
                self.at_line_start = piece.ends_with('\n');
            }
        } else {
            self.writer.write_all(body.as_bytes())?;
        }
        Ok(())
    }

    pub fn finish(mut self) -> AppResult<()> {
        if !self.pending.is_empty() {
            let chunk = String::from_utf8_lossy(&self.pending).into_owned();
            self.write_chunk(&chunk)?;
            self.pending.clear();
        }
        if self.format == TextLogFormat::Html {
            writeln!(self.writer, "</pre></body></html>")?;
        }
        self.writer.flush()?;
        Ok(())
    }

    pub fn extension(format: TextLogFormat) -> &'static str {
        format.extension()
    }
}

/// 按换行切分但保留 `\n`，让时间戳能逐行加前缀。
fn split_keep_newlines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            out.push(&text[start..=idx]);
            start = idx + 1;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// 去掉 CSI / OSC / 其它 ANSI 转义序列，保留可见字符与换行。
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... final byte 0x40..=0x7e
            Some('[') => {
                chars.next();
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL 或 ST（ESC \）结束
            Some(']') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' {
                        if matches!(chars.peek(), Some('\\')) {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            // 其它双字节转义（ESC ( X 之类）直接吞两个字符。
            _ => {
                chars.next();
            }
        }
    }
    out
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// 读取 cast 文件并按行解析为 (header_json, event_jsons)。
    fn parse_cast(path: &std::path::Path) -> (Value, Vec<Value>) {
        let body = std::fs::read_to_string(path).unwrap();
        let mut lines = body.lines().filter(|l| !l.is_empty());
        let header: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        let events: Vec<Value> = lines
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect();
        (header, events)
    }

    /// 提取所有事件的 stdout 字符串拼接。
    fn cat_outputs(events: &[Value]) -> String {
        events
            .iter()
            .filter(|e| e[1] == "o")
            .map(|e| e[2].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn active_recording_carries_path_title_and_start_time() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("manual.cast");
        let started = chrono::Utc::now().timestamp_millis();
        let mut active = ActiveRecording::new(p.clone(), 100, 30, "prod".into()).unwrap();
        assert_eq!(active.path, p);
        assert_eq!(active.title, "prod");
        assert!(active.started_at_ms >= started);
        active.recorder.record(b"hi").unwrap();
        active.recorder.finish().unwrap();
    }

    #[test]
    fn header_has_v2_shape() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.cast");
        let r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.finish().unwrap();
        let (header, events) = parse_cast(&p);
        assert_eq!(header["version"], 2);
        assert_eq!(header["width"], 80);
        assert_eq!(header["height"], 24);
        assert!(header["timestamp"].is_i64());
        assert!(events.is_empty());
    }

    #[test]
    fn ascii_recorded_inline() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("b.cast");
        let mut r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.record(b"hello").unwrap();
        r.finish().unwrap();
        let (_h, events) = parse_cast(&p);
        assert_eq!(cat_outputs(&events), "hello");
    }

    #[test]
    fn split_utf8_recovered_across_chunks() {
        // "中" = E4 B8 AD（3 字节），分两次喂入。最终输出必须完整无损。
        // 这个测试**只**看 finish 后的最终状态——BufWriter 中间不刷盘，
        // record 之间读文件不可靠。
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("c.cast");
        let mut r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.record(&[0xE4, 0xB8]).unwrap();
        r.record(&[0xAD]).unwrap();
        r.finish().unwrap();
        let (_h, events) = parse_cast(&p);
        assert_eq!(cat_outputs(&events), "中");
    }

    #[test]
    fn split_utf8_count_distinguishes_buffering() {
        // 如果实现没缓冲不完整 UTF-8，半中字会立刻 lossy → 多产一个事件。
        // 缓冲版：半中字(无事件) + 余字(1 事件) + 'x'(1 事件) = 2 事件
        // 不缓冲：半中字(1 lossy 事件) + 余字(1 事件) + 'x'(1 事件) = 3 事件
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("d.cast");
        let mut r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.record(&[0xE4, 0xB8]).unwrap();
        r.record(&[0xAD]).unwrap();
        r.record(b"x").unwrap();
        r.finish().unwrap();
        let (_h, events) = parse_cast(&p);
        assert_eq!(events.len(), 2, "events: {events:?}");
        assert_eq!(cat_outputs(&events), "中x");
    }

    #[test]
    fn ascii_then_split_utf8_split_then_complete() {
        // 头有 ASCII + 尾不完整：split=valid_up_to() 让 ASCII 当场写出，
        // 尾巴留到下次。最终拼回完整。
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("e.cast");
        let mut r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.record(b"ab\xE4\xB8").unwrap();
        r.record(&[0xAD]).unwrap();
        r.finish().unwrap();
        let (_h, events) = parse_cast(&p);
        assert_eq!(cat_outputs(&events), "ab中");
    }

    #[test]
    fn truly_invalid_byte_lossy_inline() {
        // 0xFF 是真正非法 UTF-8 起始 — 不应该缓冲，立即 lossy 写出
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("e.cast");
        let mut r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.record(&[0xFF, b'x']).unwrap();
        r.finish().unwrap();
        let (_h, events) = parse_cast(&p);
        let out = cat_outputs(&events);
        assert!(out.contains('\u{FFFD}'));
        assert!(out.contains('x'));
    }

    #[test]
    fn finish_flushes_residual_pending_lossy() {
        // 只写半个多字节字符然后 finish — pending 必须 lossy 出来，不能丢
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.cast");
        let mut r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.record(&[0xE4, 0xB8]).unwrap(); // 半个"中"
        r.finish().unwrap();
        let (_h, events) = parse_cast(&p);
        assert!(!events.is_empty());
        // lossy → U+FFFD
        assert!(cat_outputs(&events).contains('\u{FFFD}'));
    }

    #[test]
    fn event_timestamps_monotonic() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("g.cast");
        let mut r = Recorder::new(p.clone(), 80, 24).unwrap();
        r.record(b"first").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        r.record(b"second").unwrap();
        r.finish().unwrap();
        let (_h, events) = parse_cast(&p);
        let stamps: Vec<f64> = events.iter().map(|e| e[0].as_f64().unwrap()).collect();
        assert!(stamps.len() >= 2);
        for w in stamps.windows(2) {
            assert!(w[1] >= w[0], "timestamps not monotonic: {stamps:?}");
        }
        // 不断言具体 sleep 时长——CI sleep 精度受 OS 调度影响易 flaky，
        // 单调 + 非负就够了（thread::sleep 5ms 只是保证两个事件时间不同）。
        assert!(stamps[0] >= 0.0);
    }

    // ── 文本会话日志 ──────────────────────────────────────────────

    #[test]
    fn strip_ansi_removes_csi_and_osc_keeps_text() {
        let input = "\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}ok\n";
        assert_eq!(strip_ansi(input), "red ok\n");
    }

    #[test]
    fn strip_ansi_handles_osc_terminated_by_st() {
        // OSC 以 ST（ESC \）结束时不能吞掉其后的全部输出。
        let input = "\u{1b}]0;title\u{1b}\\visible\n";
        assert_eq!(strip_ansi(input), "visible\n");
    }

    #[test]
    fn text_log_strips_ansi_for_txt_format() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.txt");
        let mut r = TextLogRecorder::new(p.clone(), TextLogFormat::Text, false).unwrap();
        r.record(b"\x1b[32mhello\x1b[0m").unwrap();
        r.finish().unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hello");
    }

    #[test]
    fn text_log_raw_keeps_ansi() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.log");
        let mut r = TextLogRecorder::new(p.clone(), TextLogFormat::Raw, false).unwrap();
        r.record(b"\x1b[32mhello").unwrap();
        r.finish().unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("\x1b[32m"));
    }

    #[test]
    fn text_log_html_escapes_and_wraps_pre() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.html");
        let mut r = TextLogRecorder::new(p.clone(), TextLogFormat::Html, false).unwrap();
        r.record(b"<b>x</b>").unwrap();
        r.finish().unwrap();
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.starts_with("<!doctype html>"));
        assert!(body.contains("&lt;b&gt;x&lt;/b&gt;"));
        assert!(body.ends_with("</pre></body></html>\n"));
    }

    #[test]
    fn text_log_timestamps_prefix_each_line() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.log");
        let mut r = TextLogRecorder::new(p.clone(), TextLogFormat::Raw, true).unwrap();
        r.record(b"a\nb\nc").unwrap();
        r.finish().unwrap();
        let body = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 3);
        for line in &lines {
            assert!(line.starts_with('['), "line missing timestamp: {line}");
        }
        assert!(lines[0].ends_with("a"));
        assert!(lines[1].ends_with("b"));
    }

    #[test]
    fn text_log_split_utf8_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("u.txt");
        let mut r = TextLogRecorder::new(p.clone(), TextLogFormat::Text, false).unwrap();
        r.record(&[0xE4, 0xB8]).unwrap();
        r.record(&[0xAD]).unwrap();
        r.finish().unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "中");
    }
}
