use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use encoding_rs::{CoderResult, Encoding};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

use crate::error::{locked, AppError, AppResult};
use crate::terminal::serial_auto_login::{AutoLoginAction, SerialAutoLogin};

/// Serial output destined for the host. Mirrors `pty::PtyOut`, but kept as its
/// own type so the serial module carries no dependency on the pty module — two
/// unrelated transports shouldn't couple just to share a 2-variant enum. The
/// Tauri command turns these into `serial:data:<id>` / `serial:close:<id>`.
pub enum SerialOut {
    Data(Vec<u8>),
    Close,
    /// 自动登录状态变化："complete" | "cancelled" | "incomplete"。
    /// 命令层转为 `serial:auto_login:<id>`，载荷 `{"status": ...}`。
    AutoLogin(&'static str),
}

/// Sink the reader thread invokes for each chunk. The `&str` is the session id,
/// so one sink can serve any number of serial sessions (same shape as PtySink).
pub type SerialSink = Arc<dyn Fn(&str, SerialOut) + Send + Sync>;

/// Wire config from the frontend. Strings (not enums) for parity/flow because it
/// arrives as JSON; the string→enum mapping with fail-soft defaults lives here
/// (pure, unit-tested below). snake_case keys match the SerialProfile model and
/// the tab meta, so a saved profile's fields feed `serial_open` with no remap.
#[derive(Clone, serde::Deserialize)]
pub struct SerialConfig {
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    /// none | odd | even | mark | space。mark/space 超出 crate 表达能力：
    /// Windows 走原生 DCB，Linux 走 termios CMSPAR，macOS 打开前报错。
    #[serde(default)]
    pub parity: String,
    /// 1 | 1.5 | 2。1.5 仅 Windows（原生 DCB），其余平台打开前报错。
    #[serde(default = "default_stop_bits")]
    pub stop_bits: f64,
    #[serde(default)]
    pub flow_control: String,
    /// IXANY termios flag (unix only; Windows no-op). The rest of the Tabby-style
    /// settings live on SerialProfile and are applied in the frontend terminal.
    #[serde(default)]
    pub xany: bool,
    /// WHATWG/encoding_rs 字符集标签（如 "GBK"）；空 = 字节透传（默认，二进制安全）。
    #[serde(default)]
    pub charset: String,
    /// 自动登录凭据（仅会话级，不落库）。用户名非空 或 提供密码（含空串）即启用。
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

fn default_data_bits() -> u8 {
    8
}
fn default_stop_bits() -> f64 {
    1.0
}

/// 8 data bits is the universal default; anything unrecognized falls back to it
/// rather than erroring — the line should open on 8N1 even if the UI sends junk.
fn map_data_bits(n: u8) -> DataBits {
    match n {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

/// mark/space 在 crate 层面无对应项，映射为 None 打开，真实校验位由平台
/// 特化路径设置（Windows DCB / Linux CMSPAR）；macOS 在打开前被拒绝。
fn map_parity(s: &str) -> Parity {
    match s {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    }
}

/// 1.5 不会走到这里（平台特化路径先处理）；兜底按 1。
fn map_stop_bits(n: f64) -> StopBits {
    if n >= 2.0 {
        StopBits::Two
    } else {
        StopBits::One
    }
}

fn map_flow_control(s: &str) -> FlowControl {
    match s {
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    }
}

// Windows 全特性放行（原生 DCB 路径），此函数只在 linux/macos 闸门使用。
#[cfg(not(target_os = "windows"))]
fn feature_unsupported(feature: &str) -> AppError {
    AppError::pty(
        "serial_feature_unsupported",
        serde_json::json!({ "feature": feature }),
    )
}

/// 空标签 = 透传；无法识别的标签在打开前报错（不静默降级）。
fn resolve_charset(label: &str) -> AppResult<Option<&'static Encoding>> {
    let label = label.trim();
    if label.is_empty() {
        return Ok(None);
    }
    Encoding::for_label(label.as_bytes())
        .map(Some)
        .ok_or_else(|| {
            AppError::pty(
                "serial_charset_unsupported",
                serde_json::json!({ "charset": label }),
            )
        })
}

/// UTF-8 文本 → 线路字节。None = 透传。无法映射的字符以 `?` 替代
/// （每次写新建编码器：无状态编码完全等价，有状态编码按行重置可接受）。
fn encode_for_wire(charset: Option<&'static Encoding>, text: &str) -> Vec<u8> {
    let Some(enc) = charset else {
        return text.as_bytes().to_vec();
    };
    let mut encoder = enc.new_encoder();
    let mut out = Vec::with_capacity(text.len());
    let mut dst = [0u8; 4096];
    let mut char_buf = [0u8; 4];
    // 逐字符编码：不可映射字符的 '?' 替代位置才精确（整块编码只能从
    // had_errors 得知「块内有错」，替代符会漂到块尾）。交互式串口输入量小，
    // 开销可接受；有状态编码（ISO-2022-JP）靠末尾 flush 复位。
    for ch in text.chars() {
        let piece = ch.encode_utf8(&mut char_buf);
        let before = out.len();
        let mut errored = false;
        loop {
            let (result, _read, written, had_errors) =
                encoder.encode_from_utf8(piece, &mut dst, false);
            out.extend_from_slice(&dst[..written]);
            if had_errors {
                errored = true;
            }
            if matches!(result, CoderResult::InputEmpty) {
                break;
            }
        }
        if errored {
            // encoding_rs 对不可映射字符会输出 NCR（&#...;）并置 had_errors；
            // 丢弃 NCR，统一以 '?' 替代（对齐 Netcatty 的替换语义）。
            out.truncate(before);
            out.push(b'?');
        }
    }
    loop {
        let (result, _read, written, _had_errors) = encoder.encode_from_utf8("", &mut dst, true);
        out.extend_from_slice(&dst[..written]);
        if matches!(result, CoderResult::InputEmpty) {
            break;
        }
    }
    out
}

/// Trips the shared close flag when the last `SerialHandle` clone is dropped
/// (tab closed / window closed → handle removed from the session map). Unlike a
/// PTY there is no child process whose death yields EOF, and dropping the writer
/// fd does NOT close the reader's `try_clone`d fd — so the reader thread must be
/// told to stop explicitly. It checks the flag once per read cycle (≤ timeout).
struct CloseGuard {
    closed: Arc<AtomicBool>,
}

impl Drop for CloseGuard {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Relaxed);
    }
}

/// Serial session handle. Clone + Send + Sync, like `PtyHandle`. No `resize`:
/// a serial line has no rows/cols, so the frontend simply never calls it.
#[derive(Clone)]
pub struct SerialHandle {
    writer: Arc<Mutex<Box<dyn SerialPort>>>,
    /// Last clone dropped → guard drops → close flag set → reader thread exits.
    _guard: Arc<CloseGuard>,
    port_name: Arc<str>,
    session_id: Arc<str>,
    sink: SerialSink,
    detector: Arc<Mutex<Option<SerialAutoLogin>>>,
    charset: Option<&'static Encoding>,
}

/// Map any serial I/O failure (write / control-line / break) to a uniform error.
fn serial_op_err(e: impl std::fmt::Display) -> AppError {
    AppError::pty(
        "serial_op_failed",
        serde_json::json!({ "err": e.to_string() }),
    )
}

impl SerialHandle {
    /// 用户键入上行：先过自动登录检测器（裸 CR/LF 唤醒直通不取消；其余输入
    /// 取消自动登录并报一次 cancelled），再按会话字符集编码写线路。
    pub fn write(&self, data: &[u8]) -> AppResult<()> {
        let text = String::from_utf8_lossy(data);
        let actions = locked(&self.detector)?
            .as_mut()
            .map(|d| d.user_input(&text))
            .unwrap_or_default();
        for action in actions {
            self.dispatch(action)?;
        }
        let bytes = encode_for_wire(self.charset, &text);
        locked(&self.writer)?.write_all(&bytes).map_err(serial_op_err)
    }

    fn dispatch(&self, action: AutoLoginAction) -> AppResult<()> {
        match action {
            AutoLoginAction::SendLine(line) => {
                let bytes = encode_for_wire(self.charset, &format!("{line}\r"));
                locked(&self.writer)?.write_all(&bytes).map_err(serial_op_err)?;
            }
            AutoLoginAction::Complete => {
                (self.sink)(&self.session_id, SerialOut::AutoLogin("complete"))
            }
            AutoLoginAction::Cancelled => {
                (self.sink)(&self.session_id, SerialOut::AutoLogin("cancelled"))
            }
            AutoLoginAction::Incomplete => {
                (self.sink)(&self.session_id, SerialOut::AutoLogin("incomplete"))
            }
        }
        Ok(())
    }

    /// Drive the DTR control line. Manual DTR/RTS toggling resets MCUs (Arduino
    /// auto-reset), enters bootloaders (the ESP32 DTR/RTS dance), and signals
    /// modems. `level` is the logical assert state (`true` = asserted).
    pub fn set_dtr(&self, level: bool) -> AppResult<()> {
        locked(&self.writer)?
            .write_data_terminal_ready(level)
            .map_err(serial_op_err)
    }

    /// Drive the RTS control line (see `set_dtr`).
    pub fn set_rts(&self, level: bool) -> AppResult<()> {
        locked(&self.writer)?
            .write_request_to_send(level)
            .map_err(serial_op_err)
    }

    /// Send a serial BREAK: hold the line in the break condition ~250ms, then
    /// release. Devices that watch for it (U-Boot, kernel SysRq-over-serial,
    /// telco gear) treat it as an attention/interrupt. The writer lock is held
    /// across the pulse so no bytes interleave — a break mid-frame is meaningless.
    pub fn send_break(&self) -> AppResult<()> {
        let port = locked(&self.writer)?;
        port.set_break().map_err(serial_op_err)?;
        std::thread::sleep(Duration::from_millis(250));
        port.clear_break().map_err(serial_op_err)
    }

    /// Port path actually opened (e.g. `/dev/cu.usbserial-1420`, `COM3`).
    pub fn port_name(&self) -> &str {
        &self.port_name
    }
}

/// 枚举到的串口（含厂商/序列号/VID/PID/类型），供前端下拉展示。
#[derive(Clone, Debug, serde::Serialize)]
pub struct PortInfo {
    pub path: String,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    /// usb | pci | bluetooth | ""（未知）
    pub port_type: String,
}

/// Serial ports available on this machine (`/dev/cu.usbserial-*`, `COM3`, …).
/// Enumeration failure (no permission / platform quirk) degrades to an empty
/// list rather than erroring — the UI shows "no ports" and the user can retry.
pub fn available_ports() -> Vec<PortInfo> {
    let ports = serialport::available_ports()
        .map(|list| list.into_iter().map(port_info_from).collect::<Vec<_>>())
        .unwrap_or_default();
    prefer_callout_ports(ports)
}

fn port_info_from(p: serialport::SerialPortInfo) -> PortInfo {
    use serialport::SerialPortType;
    // crate 4.9 的 SerialPortInfo 只有 port_name + port_type；USB 元数据
    // （厂商/序列号/VID/PID）在 UsbPort(UsbPortInfo) 变体里。
    let (port_type, manufacturer, serial_number, vendor_id, product_id) = match p.port_type {
        SerialPortType::UsbPort(usb) => (
            "usb".to_string(),
            usb.manufacturer,
            usb.serial_number,
            Some(usb.vid),
            Some(usb.pid),
        ),
        SerialPortType::PciPort => ("pci".to_string(), None, None, None, None),
        SerialPortType::BluetoothPort => ("bluetooth".to_string(), None, None, None, None),
        SerialPortType::Unknown => (String::new(), None, None, None, None),
    };
    PortInfo {
        path: p.port_name,
        manufacturer,
        serial_number,
        vendor_id,
        product_id,
        port_type,
    }
}

/// macOS exposes BOTH device nodes for every serial port: the call-out
/// `/dev/cu.*` and the dial-in `/dev/tty.*`. For an interactive terminal you
/// always want `cu.*` — opening `tty.*` blocks waiting for carrier-detect (DCD).
/// Drop the `tty.*` twins so the picker shows one usable entry per device
/// instead of a doubled list with a hang-trap in it.
#[cfg(target_os = "macos")]
fn prefer_callout_ports(mut ports: Vec<PortInfo>) -> Vec<PortInfo> {
    // Drop a dial-in node only when its call-out twin was also enumerated:
    // `/dev/tty.foo` is dropped iff `/dev/cu.foo` exists. A device that exposes
    // only `tty.*` (no cu twin) is still shown rather than silently hidden.
    let callouts: std::collections::HashSet<String> = ports
        .iter()
        .filter_map(|p| p.path.strip_prefix("/dev/cu.").map(str::to_owned))
        .collect();
    ports.retain(|p| match p.path.strip_prefix("/dev/tty.") {
        Some(name) => !callouts.contains(name),
        None => true,
    });
    ports
}

/// Non-macOS: device nodes aren't duplicated this way, so pass through.
#[cfg(not(target_os = "macos"))]
fn prefer_callout_ports(ports: Vec<PortInfo>) -> Vec<PortInfo> {
    ports
}

/// Open a serial port and spawn a reader thread that pushes bytes to `sink`.
/// Returns `(session_id, handle)`.
fn open_err(port: &str, e: serialport::Error) -> AppError {
    AppError::pty(
        "serial_open_failed",
        serde_json::json!({ "port": port, "err": e.to_string() }),
    )
}

fn build_port(port: &str, cfg: &SerialConfig) -> serialport::SerialPortBuilder {
    serialport::new(port, cfg.baud_rate)
        .data_bits(map_data_bits(cfg.data_bits))
        .parity(map_parity(&cfg.parity))
        .stop_bits(map_stop_bits(cfg.stop_bits))
        .flow_control(map_flow_control(&cfg.flow_control))
        // Read timeout paces the reader loop and lets it notice unplug + honor the
        // close flag. NOT a data deadline — on TimedOut we just loop again.
        .timeout(Duration::from_millis(100))
}

/// 平台能力闸门：1.5 停止位仅 Windows；mark/space 校验 macOS 不支持。
#[cfg(target_os = "windows")]
fn check_platform_support(_cfg: &SerialConfig) -> AppResult<()> {
    Ok(()) // mark/space + 1.5 走原生 DCB
}

#[cfg(target_os = "linux")]
fn check_platform_support(cfg: &SerialConfig) -> AppResult<()> {
    if cfg.stop_bits == 1.5 {
        return Err(feature_unsupported("stop_bits_1_5"));
    }
    Ok(()) // mark/space 走 termios CMSPAR
}

#[cfg(target_os = "macos")]
fn check_platform_support(cfg: &SerialConfig) -> AppResult<()> {
    if cfg.stop_bits == 1.5 {
        return Err(feature_unsupported("stop_bits_1_5"));
    }
    if cfg.parity == "mark" || cfg.parity == "space" {
        return Err(feature_unsupported("mark_space_parity"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_port(port: &str, cfg: &SerialConfig) -> AppResult<Box<dyn SerialPort>> {
    if cfg.parity == "mark" || cfg.parity == "space" || cfg.stop_bits == 1.5 {
        open_native_dcb(port, cfg)
    } else {
        open_via_crate(port, cfg)
    }
}

#[cfg(not(target_os = "windows"))]
fn open_port(port: &str, cfg: &SerialConfig) -> AppResult<Box<dyn SerialPort>> {
    open_via_crate(port, cfg)
}

/// Open the port and, on unix, apply termios flags the crate can't express:
/// IXANY (`xany`) and mark/space parity (CMSPAR, Linux only).
#[cfg(unix)]
fn open_via_crate(port: &str, cfg: &SerialConfig) -> AppResult<Box<dyn SerialPort>> {
    use std::os::unix::io::AsRawFd;
    let tty = build_port(port, cfg)
        .open_native()
        .map_err(|e| open_err(port, e))?;
    let needs_cmspar = cfg.parity == "mark" || cfg.parity == "space";
    if cfg.xany || needs_cmspar {
        // SAFETY: fd is valid for these calls; tcgetattr/tcsetattr touch only `t`.
        unsafe {
            let fd = tty.as_raw_fd();
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut t) == 0 {
                if cfg.xany {
                    t.c_iflag |= libc::IXANY;
                }
                apply_mark_space(&mut t, &cfg.parity);
                let _ = libc::tcsetattr(fd, libc::TCSANOW, &t);
            }
        }
    }
    Ok(Box::new(tty))
}

/// Linux: CMSPAR 给出 mark/space 校验（crate 无此表达）。
#[cfg(target_os = "linux")]
fn apply_mark_space(t: &mut libc::termios, parity: &str) {
    match parity {
        "mark" => t.c_cflag |= libc::PARENB | libc::PARODD | libc::CMSPAR,
        "space" => {
            t.c_cflag |= libc::PARENB | libc::CMSPAR;
            t.c_cflag &= !libc::PARODD;
        }
        _ => {}
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn apply_mark_space(_t: &mut libc::termios, _parity: &str) {
    // macOS 在 check_platform_support 已拒绝 mark/space。
}

/// Windows: IXANY has no DCB equivalent exposed by the serialport crate, so the
/// `xany` flag is a no-op. Documented limitation.
#[cfg(not(unix))]
fn open_via_crate(port: &str, cfg: &SerialConfig) -> AppResult<Box<dyn SerialPort>> {
    // IXANY 无 DCB 等价，Windows 下显式消费该字段（文档化 no-op），
    // 避免「field never read」警告并保持跨平台配置形状一致。
    let _xany = cfg.xany;
    build_port(port, cfg).open().map_err(|e| open_err(port, e))
}

/// mark/space 校验或 1.5 停止位：crate 均无法表达，改用原生 Win32 打开并自组
/// DCB。全程镜像 crate 自身的打开序列（dcb::init + 各 setter + COMMTIMEOUTS）。
#[cfg(target_os = "windows")]
fn open_native_dcb(port: &str, cfg: &SerialConfig) -> AppResult<Box<dyn SerialPort>> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::Devices::Communication::{
        GetCommState, SetCommState, SetCommTimeouts, COMMTIMEOUTS, DCB, EVENPARITY, MARKPARITY,
        NOPARITY, ODDPARITY, ONE5STOPBITS, ONESTOPBIT, SPACEPARITY, TWOSTOPBITS,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
    };

    let fail = |e: std::io::Error| -> AppError {
        AppError::pty(
            "serial_open_failed",
            serde_json::json!({ "port": port, "err": e.to_string() }),
        )
    };

    // CreateFileW 对 COMn 需要 \\.\ 前缀（高编号必须，统一加；已带前缀的直通）。
    let dev_path = if port.starts_with('\\') {
        port.to_string()
    } else {
        format!("\\\\.\\{port}")
    };
    let wide: Vec<u16> = std::ffi::OsStr::new(&dev_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            0 as HANDLE,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(fail(std::io::Error::last_os_error()));
    }
    // 所有权移入 COMPort 之前，任何错误路径都要关掉句柄。
    struct Guard(HANDLE);
    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    let guard = Guard(handle);

    let mut dcb: DCB = unsafe { std::mem::zeroed() };
    dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
    if unsafe { GetCommState(handle, &mut dcb) } == 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }

    // 镜像 crate dcb::init —— 那些不受线路参数影响的固定字段。
    dcb.XonChar = 17;
    dcb.XoffChar = 19;
    dcb.ErrorChar = 0;
    dcb.EofChar = 26;
    set_dcb_bit(&mut dcb, 0, true); // fBinary
    set_dcb_bit(&mut dcb, 3, false); // fOutxDsrFlow
    dcb._bitfield &= !(0b11 << 4); // fDtrControl = Disable
    set_dcb_bit(&mut dcb, 6, false); // fDsrSensitivity
    set_dcb_bit(&mut dcb, 10, false); // fErrorChar
    set_dcb_bit(&mut dcb, 11, false); // fNull
    set_dcb_bit(&mut dcb, 14, false); // fAbortOnError

    dcb.BaudRate = cfg.baud_rate;
    dcb.ByteSize = cfg.data_bits.clamp(5, 8);
    dcb.Parity = match cfg.parity.as_str() {
        "odd" => ODDPARITY,
        "even" => EVENPARITY,
        "mark" => MARKPARITY,
        "space" => SPACEPARITY,
        _ => NOPARITY,
    };
    let parity = dcb.Parity;
    set_dcb_bit(&mut dcb, 1, parity != NOPARITY); // fParity
    dcb.StopBits = if cfg.stop_bits == 1.5 {
        ONE5STOPBITS
    } else if cfg.stop_bits >= 2.0 {
        TWOSTOPBITS
    } else {
        ONESTOPBIT
    };

    // 流控 —— 镜像 crate dcb::set_flow_control。
    match cfg.flow_control.as_str() {
        "software" => {
            set_dcb_bit(&mut dcb, 2, false); // fOutxCtsFlow
            dcb._bitfield &= !(0b11 << 12); // fRtsControl = Disable
            set_dcb_bit(&mut dcb, 8, true); // fOutX
            set_dcb_bit(&mut dcb, 9, true); // fInX
        }
        "hardware" => {
            set_dcb_bit(&mut dcb, 2, true); // fOutxCtsFlow
            dcb._bitfield &= !(0b11 << 12);
            dcb._bitfield |= 0b01 << 12; // fRtsControl = Enable
            set_dcb_bit(&mut dcb, 8, false);
            set_dcb_bit(&mut dcb, 9, false);
        }
        _ => {
            set_dcb_bit(&mut dcb, 2, false);
            dcb._bitfield &= !(0b11 << 12);
            set_dcb_bit(&mut dcb, 8, false);
            set_dcb_bit(&mut dcb, 9, false);
        }
    }

    if unsafe { SetCommState(handle, &mut dcb) } == 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }

    // from_raw_handle 不会设置 COMMTIMEOUTS；读循环依赖 100ms 读超时 pacing，
    // 必须显式设置（值与 crate set_timeout 一致）。
    let timeouts = COMMTIMEOUTS {
        ReadIntervalTimeout: u32::MAX,
        ReadTotalTimeoutMultiplier: u32::MAX,
        ReadTotalTimeoutConstant: 100,
        WriteTotalTimeoutMultiplier: 0,
        WriteTotalTimeoutConstant: 100,
    };
    if unsafe { SetCommTimeouts(handle, &timeouts) } == 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }

    std::mem::forget(guard); // 句柄所有权移入 COMPort
    let com = unsafe { serialport::COMPort::from_raw_handle(handle as RawHandle) };
    Ok(Box::new(com))
}

#[cfg(target_os = "windows")]
fn set_dcb_bit(dcb: &mut windows_sys::Win32::Devices::Communication::DCB, bit: u32, on: bool) {
    if on {
        dcb._bitfield |= 1 << bit;
    } else {
        dcb._bitfield &= !(1 << bit);
    }
}

fn detector_check(
    det: &Arc<Mutex<Option<SerialAutoLogin>>>,
    f: impl FnOnce(&mut SerialAutoLogin) -> Vec<AutoLoginAction>,
) -> Vec<AutoLoginAction> {
    match det.lock() {
        Ok(mut g) => g.as_mut().map(f).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 读线程侧执行检测器动作：凭据直接写线路（不过检测器），状态推给 sink。
fn dispatch_actions(
    actions: Vec<AutoLoginAction>,
    writer: &Arc<Mutex<Box<dyn SerialPort>>>,
    sink: &SerialSink,
    sid: &str,
    charset: Option<&'static Encoding>,
) {
    for action in actions {
        match action {
            AutoLoginAction::SendLine(line) => {
                let bytes = encode_for_wire(charset, &format!("{line}\r"));
                if let Ok(mut w) = writer.lock() {
                    let _ = w.write_all(&bytes);
                }
            }
            AutoLoginAction::Complete => sink(sid, SerialOut::AutoLogin("complete")),
            AutoLoginAction::Cancelled => sink(sid, SerialOut::AutoLogin("cancelled")),
            AutoLoginAction::Incomplete => sink(sid, SerialOut::AutoLogin("incomplete")),
        }
    }
}

pub fn open(
    session_id: String,
    port: &str,
    cfg: SerialConfig,
    sink: SerialSink,
) -> AppResult<(String, SerialHandle)> {
    let charset = resolve_charset(&cfg.charset)?;
    check_platform_support(&cfg)?;
    let opened = open_port(port, &cfg)?;

    // Separate read handle so the blocking read (up to the timeout) doesn't hold
    // the writer's lock. try_clone dups the underlying fd / handle.
    let mut reader = opened.try_clone().map_err(|e| {
        AppError::pty(
            "serial_op_failed",
            serde_json::json!({ "err": e.to_string() }),
        )
    })?;

    let closed = Arc::new(AtomicBool::new(false));
    let reader_closed = closed.clone();

    let detector = Arc::new(Mutex::new(SerialAutoLogin::new(cfg.username, cfg.password)));
    let reader_detector = detector.clone();

    let writer: Arc<Mutex<Box<dyn SerialPort>>> = Arc::new(Mutex::new(opened));
    let reader_writer = writer.clone();
    let reader_sink = sink.clone();
    let sid = session_id.clone();

    // Reader thread: serial RX → sink. Exits on close flag or fatal IO error.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut decoder = charset.map(|e| e.new_decoder());
        let mut text = String::new();
        loop {
            if reader_closed.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    // 无字节：仍要驱动自动登录过期检查（静默设备）。
                    let actions = detector_check(&reader_detector, SerialAutoLogin::check_expiry);
                    dispatch_actions(actions, &reader_writer, &reader_sink, &sid, charset);
                    continue;
                }
                Ok(n) => {
                    let chunk = &buf[..n];
                    // 有字符集 → 增量解码为 UTF-8（事件契约不变，前端仍收 UTF-8）；
                    // 透传 → 原样字节，检测器按 lossy UTF-8 观察。
                    let (emit, decoded): (Vec<u8>, String) = match decoder.as_mut() {
                        Some(dec) => {
                            text.clear();
                            let mut rest = chunk;
                            loop {
                                let (result, read, _bad) =
                                    dec.decode_to_string(rest, &mut text, false);
                                rest = &rest[read..];
                                if matches!(result, CoderResult::InputEmpty) {
                                    break;
                                }
                            }
                            let emit = text.as_bytes().to_vec();
                            (emit, text.clone())
                        }
                        None => (chunk.to_vec(), String::from_utf8_lossy(chunk).into_owned()),
                    };
                    let actions = detector_check(&reader_detector, |d| d.feed(&decoded));
                    reader_sink(&sid, SerialOut::Data(emit));
                    dispatch_actions(actions, &reader_writer, &reader_sink, &sid, charset);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    let actions = detector_check(&reader_detector, SerialAutoLogin::check_expiry);
                    dispatch_actions(actions, &reader_writer, &reader_sink, &sid, charset);
                    continue;
                }
                Err(_) => break, // port gone (unplugged) / fatal IO error
            }
        }
        reader_sink(&sid, SerialOut::Close);
    });

    let id = session_id;
    let handle = SerialHandle {
        writer,
        _guard: Arc::new(CloseGuard { closed }),
        port_name: Arc::from(port),
        session_id: Arc::from(id.as_str()),
        sink,
        detector,
        charset,
    };

    Ok((id, handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_bits_maps_known_and_defaults_junk_to_eight() {
        assert!(matches!(map_data_bits(5), DataBits::Five));
        assert!(matches!(map_data_bits(6), DataBits::Six));
        assert!(matches!(map_data_bits(7), DataBits::Seven));
        assert!(matches!(map_data_bits(8), DataBits::Eight));
        assert!(matches!(map_data_bits(0), DataBits::Eight));
        assert!(matches!(map_data_bits(99), DataBits::Eight));
    }

    #[test]
    fn parity_maps_known_and_defaults_unknown_to_none() {
        assert!(matches!(map_parity("odd"), Parity::Odd));
        assert!(matches!(map_parity("even"), Parity::Even));
        assert!(matches!(map_parity("none"), Parity::None));
        assert!(matches!(map_parity(""), Parity::None));
        assert!(matches!(map_parity("garbage"), Parity::None));
        // mark/space 由平台特化路径处理，crate 层按 None 打开
        assert!(matches!(map_parity("mark"), Parity::None));
        assert!(matches!(map_parity("space"), Parity::None));
    }

    #[test]
    fn stop_bits_maps_two_else_one() {
        assert!(matches!(map_stop_bits(2.0), StopBits::Two));
        assert!(matches!(map_stop_bits(1.0), StopBits::One));
        // 1.5 不会到达 crate 路径（原生/报错），兜底按 1
        assert!(matches!(map_stop_bits(1.5), StopBits::One));
        assert!(matches!(map_stop_bits(0.0), StopBits::One));
    }

    #[test]
    fn flow_control_maps_known_and_defaults_unknown_to_none() {
        assert!(matches!(
            map_flow_control("software"),
            FlowControl::Software
        ));
        assert!(matches!(
            map_flow_control("hardware"),
            FlowControl::Hardware
        ));
        assert!(matches!(map_flow_control("none"), FlowControl::None));
        assert!(matches!(map_flow_control("xyz"), FlowControl::None));
    }

    #[test]
    fn charset_resolves_labels_and_rejects_garbage() {
        assert!(resolve_charset("").unwrap().is_none());
        assert!(resolve_charset("   ").unwrap().is_none());
        assert_eq!(resolve_charset("GBK").unwrap().unwrap().name(), "GBK");
        assert_eq!(resolve_charset("gbk").unwrap().unwrap().name(), "GBK");
        assert_eq!(
            resolve_charset("nope-123").unwrap_err().code(),
            "serial_charset_unsupported"
        );
    }

    #[test]
    fn encode_for_wire_passthrough_and_gbk() {
        assert_eq!(encode_for_wire(None, "A中"), "A中".as_bytes());
        let gbk = resolve_charset("GBK").unwrap().unwrap();
        assert_eq!(encode_for_wire(Some(gbk), "A中"), b"A\xD6\xD0");
    }

    #[test]
    fn encode_for_wire_unmappable_becomes_question_mark() {
        let gbk = resolve_charset("GBK").unwrap().unwrap();
        // 😀 不在 GBK 字符集内 → 以 '?' 替代，不产生 NCR 垃圾
        assert_eq!(encode_for_wire(Some(gbk), "A\u{1F600}B"), b"A?B");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_drops_tty_only_when_cu_twin_exists() {
        fn pi(path: &str) -> PortInfo {
            PortInfo {
                path: path.into(),
                manufacturer: None,
                serial_number: None,
                vendor_id: None,
                product_id: None,
                port_type: String::new(),
            }
        }
        let got = prefer_callout_ports(vec![
            pi("/dev/cu.usbserial-1"),
            pi("/dev/tty.usbserial-1"), // twin of a listed cu → dropped
            pi("/dev/tty.orphan"),      // no cu twin → kept (not hidden)
            pi("/dev/cu.standalone"),
        ]);
        let paths: Vec<&str> = got.iter().map(|p| p.path.as_str()).collect();
        assert!(paths.contains(&"/dev/cu.usbserial-1"));
        assert!(!paths.contains(&"/dev/tty.usbserial-1"));
        assert!(paths.contains(&"/dev/tty.orphan"));
        assert!(paths.contains(&"/dev/cu.standalone"));
    }

    /// 用 socat 起一对虚拟 null-modem（`pty,raw,link=`），返回子进程和两端路径。
    /// socat 不可用或超时未就绪时返回 None（测试据此跳过，不抛错）。
    ///
    /// 说明：`serialport::available_ports()` 走 `/sys/class/tty` 枚举，不会列出
    /// `/dev/pts/*` 虚拟串口，所以本测试直接按路径 `open`，绕开 UI 的下拉枚举，
    /// 只验证「打开→双向字节流」这条核心链路。
    #[cfg(unix)]
    fn spawn_virtual_serial_pair() -> Option<(std::process::Child, String, String)> {
        let has_socat = std::process::Command::new("socat")
            .arg("-V")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_socat {
            return None;
        }
        let suffix = std::process::id();
        let path_a = format!("/tmp/termx_ser_a_{suffix}");
        let path_b = format!("/tmp/termx_ser_b_{suffix}");
        let _ = std::fs::remove_file(&path_a);
        let _ = std::fs::remove_file(&path_b);
        let mut child = std::process::Command::new("socat")
            .args([
                "-d",
                "-d",
                &format!("pty,raw,echo=0,link={path_a}"),
                "pty,raw,echo=0,link={path_b}",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        for _ in 0..100 {
            if std::path::Path::new(&path_a).exists() && std::path::Path::new(&path_b).exists() {
                return Some((child, path_a, path_b));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        None
    }

    #[cfg(unix)]
    #[test]
    fn serial_pty_roundtrip() {
        let Some((mut child, path_a, path_b)) = spawn_virtual_serial_pair() else {
            eprintln!("skip: socat 不可用，无法创建虚拟串口对");
            return;
        };
        use std::os::unix::fs::OpenOptionsExt;

        let (tx, rx) = std::sync::mpsc::channel::<SerialOut>();
        let sink: SerialSink = Arc::new(move |_sid, out| {
            let _ = tx.send(out);
        });

        let cfg = SerialConfig {
            baud_rate: 115200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1.0,
            flow_control: "none".into(),
            xany: false,
            charset: String::new(),
            username: None,
            password: None,
        };
        let (id, handle) = open("ser-test".into(), &path_a, cfg, sink)
            .expect("打开虚拟串口 slave 应成功");
        assert_eq!(id, "ser-test");

        // 对端（另一个 pty slave）以非阻塞方式打开，便于轮询读。
        let mut peer = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path_b)
            .expect("打开对端 pty 应成功");

        // 方向 1：对端写入 → backend reader 读到并推给 sink。
        peer.write_all(b"\x01ping\x02").unwrap();
        let mut got = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(SerialOut::Data(d)) => {
                    got.extend_from_slice(&d);
                    if got.windows(4).any(|w| w == b"ping") {
                        break;
                    }
                }
                Ok(SerialOut::Close) => break,
                Ok(SerialOut::AutoLogin(_)) => {}
                Err(_) => continue,
            }
        }
        assert!(
            got.windows(4).any(|w| w == b"ping"),
            "backend 未读到对端写入的数据: {got:?}"
        );

        // 方向 2：backend 写入 → 对端读到相同字节。
        handle.write(b"\x03world\x04").unwrap();
        let mut buf = [0u8; 64];
        let mut n = 0;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            match peer.read(&mut buf) {
                Ok(k) => {
                    n = k;
                    break;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
        assert_eq!(&buf[..n], b"\x03world\x04", "对端读到的字节与写入不一致");

        // 控制线在 pty 上可能不被底层支持，只验证不 panic / 不崩。
        let _ = handle.set_dtr(true);
        let _ = handle.set_rts(true);
        let _ = handle.set_dtr(false);
        let _ = handle.set_rts(false);

        drop(handle);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(&path_a);
        let _ = std::fs::remove_file(&path_b);
    }
}
