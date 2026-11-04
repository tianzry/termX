//! 终端输入编码转换（对照 Netcatty `electron/bridges/terminalEncoding.cjs`）。
//!
//! 前端按键文本始终以 UTF-8 字节发到后端；开启 GB18030 会话后，后端在写
//! 入远程通道前把 UTF-8 文本重新编码成 GB18030 字节，保证中文输入与回显
//! 一致。ASCII 控制字节（回车、方向键、Ctrl-C）保持单字节，不会被拓宽。
//!
//! 输出方向由前端 `TextDecoder("gb18030")` 解码（WebView 原生支持），
//! 后端不参与，避免在热路径上再做一次字符串解码。

use encoding_rs::GB18030;

/// 归一化编码标签：仅 `gb18030`（含 GBK / GB2312 别名）需要转换，其余
/// （UTF-8、缺省、未知）一律按 UTF-8 原样透传——与 Netcatty 的
/// `normalizeTerminalEncoding` 一致。
pub fn is_gb18030(encoding: Option<&str>) -> bool {
    let Some(raw) = encoding else { return false };
    let token: String = raw
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    // `zh_CN.GB18030@custom` 这类 locale 字符串过滤后仍包含 gb18030/gbk。
    matches!(
        token.as_str(),
        "gb18030" | "gbk" | "gb2312" | "cp936" | "ms936"
    ) || token.contains("gb18030")
        || token.contains("gbk")
        || token.contains("gb2312")
        || token.contains("cp936")
}

/// 按会话编码把前端 UTF-8 字节转成远程期望的字节。
pub fn encode_terminal_input(data: &[u8], encoding: Option<&str>) -> Vec<u8> {
    if !is_gb18030(encoding) {
        return data.to_vec();
    }
    let text = String::from_utf8_lossy(data);
    GB18030.encode(&text).0.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gb18030_labels_are_recognized() {
        for label in [
            "gb18030",
            "GB18030",
            "gbk",
            "GB2312",
            "cp936",
            "zh_CN.GB18030",
            "zh_CN.GB18030@custom",
        ] {
            assert!(is_gb18030(Some(label)), "{label} should map to gb18030");
        }
        for label in ["utf-8", "UTF8", "", "latin1"] {
            assert!(!is_gb18030(Some(label)), "{label} should stay utf-8");
        }
        assert!(!is_gb18030(None));
    }

    #[test]
    fn gb18030_input_is_reencoded() {
        let utf8 = "你好".as_bytes();
        let bytes = encode_terminal_input(utf8, Some("gb18030"));
        // GB18030 的「你」= 0xC4 0xE3，「好」= 0xBA 0xC3（与 UTF-8 不同）。
        assert_eq!(bytes, vec![0xC4, 0xE3, 0xBA, 0xC3]);
        assert_ne!(bytes, utf8.to_vec());
    }

    #[test]
    fn utf8_input_passes_through_unchanged() {
        let utf8 = "ls 你好\r".as_bytes();
        assert_eq!(encode_terminal_input(utf8, None), utf8.to_vec());
        assert_eq!(encode_terminal_input(utf8, Some("utf-8")), utf8.to_vec());
        assert_eq!(
            encode_terminal_input(utf8, Some("not-a-real-charset")),
            utf8.to_vec()
        );
    }

    #[test]
    fn control_bytes_stay_single_byte_under_gb18030() {
        let bytes = encode_terminal_input(b"\x1b[A\r\x03", Some("gb18030"));
        assert_eq!(bytes, vec![0x1b, 0x5b, 0x41, 0x0d, 0x03]);
    }
}
