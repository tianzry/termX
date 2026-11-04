//! TOTP（RFC 6238）：BASE32 secret + HMAC-SHA1，30s / 6 位。
//! 纯函数便于 RFC 测试向量单测；认证层只在 keyboard-interactive prompt 命中时调用。

use hmac::{Hmac, Mac};
use sha1::Sha1;

use crate::models::Profile;
use crate::state::AppState;

#[derive(Clone, Debug)]
pub struct TotpConfig {
    pub secret: String,
    pub auto_submit: bool,
    pub regex: Option<String>,
}

pub const DEFAULT_PERIOD: u64 = 30;
pub const DEFAULT_DIGITS: u32 = 6;

fn base32_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut cleaned = String::new();
    for ch in input.chars() {
        if ch.is_ascii_whitespace() || ch == '-' {
            continue;
        }
        let upper = ch.to_ascii_uppercase();
        if upper == '=' {
            break;
        }
        if !matches!(upper, 'A'..='Z' | '2'..='7') {
            return Err(format!("invalid base32 character: {ch}"));
        }
        cleaned.push(upper);
    }
    if cleaned.is_empty() {
        return Err("empty base32 secret".to_owned());
    }
    let mut out = Vec::with_capacity(cleaned.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for ch in cleaned.chars() {
        let value = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            '2'..='7' => ch as u32 - '2' as u32 + 26,
            _ => unreachable!(),
        };
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// RFC 6238 HOTP/TOTP；`unix_secs` 为 UNIX 秒。
pub fn totp_code(
    secret: &str,
    unix_secs: u64,
    period: u64,
    digits: u32,
) -> Result<String, String> {
    if digits == 0 || digits > 10 {
        return Err("digits must be 1..=10".to_owned());
    }
    let key = base32_decode(secret)?;
    let counter = unix_secs / period;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).map_err(|e| e.to_string())?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    let modulo = 10u32.pow(digits);
    Ok(format!("{:0width$}", binary % modulo, width = digits as usize))
}

pub fn totp_now(secret: &str, unix_secs: u64) -> Result<String, String> {
    totp_code(secret, unix_secs, DEFAULT_PERIOD, DEFAULT_DIGITS)
}

fn prompt_matches(configured: Option<&str>, prompt: &str) -> bool {
    let Some(pattern) = configured.map(str::trim).filter(|p| !p.is_empty()) else {
        return false;
    };
    regex::Regex::new(pattern)
        .map(|re| re.is_match(prompt))
        .unwrap_or_else(|_| prompt.to_ascii_lowercase().contains(&pattern.to_ascii_lowercase()))
}

/// 给定 keyboard-interactive prompts，返回自动回答；未命中验证器提示 → None。
/// 默认识别常见的验证码提示（code / OTP / 6 位），可用主机 `totp_regex` 覆盖。
pub fn answers_for_prompts(
    prompts: &[(String, bool)],
    config: &TotpConfig,
    unix_secs: u64,
) -> Option<Vec<String>> {
    let mut matched = false;
    let answers = prompts
        .iter()
        .map(|(prompt, _echo)| {
            let hit = prompt_matches(config.regex.as_deref(), prompt)
                || (!prompt.is_empty()
                    && {
                        let lower = prompt.to_ascii_lowercase();
                        lower.contains("verification code")
                            || lower.contains("verification")
                            || lower.contains("one-time")
                            || lower.contains("otp")
                            || lower.contains("authenticator")
                            || lower.contains("动态码")
                            || lower.contains("验证码")
                    });
            if hit {
                matched = true;
                totp_now(&config.secret, unix_secs).unwrap_or_default()
            } else {
                String::new()
            }
        })
        .collect::<Vec<_>>();
    if matched && config.auto_submit {
        Some(answers)
    } else {
        None
    }
}

/// 主机 SecretStore 里保存的验证器密钥 → 运行期配置。
pub fn config_from_store(state: &AppState, profile: &Profile) -> Option<TotpConfig> {
    let secret = state
        .secret_store
        .get(&crate::secret::totp_secret_key(&profile.id))
        .ok()
        .flatten()?;
    let secret = secret.trim();
    if secret.is_empty() {
        return None;
    }
    Some(TotpConfig {
        secret: secret.to_owned(),
        auto_submit: profile.totp_auto_submit,
        regex: profile.totp_regex.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 附录 B（SHA1，8 位，secret = "12345678901234567890" → BASE32）。
    #[test]
    fn rfc6238_sha1_vectors() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let vectors = [
            (59u64, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
            (20000000000, "65353130"),
        ];
        for (ts, expected) in vectors {
            assert_eq!(
                totp_code(secret, ts, 30, 8).as_deref(),
                Ok(expected),
                "timestamp {ts}"
            );
        }
    }

    #[test]
    fn prompt_matching_and_answers() {
        let cfg = TotpConfig {
            secret: "JBSWY3DPEHPK3PXP".to_owned(),
            auto_submit: true,
            regex: None,
        };
        let prompts = vec![("Verification code: ".to_owned(), true)];
        let answers = answers_for_prompts(&prompts, &cfg, 1_700_000_000).unwrap();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].len(), 6);
        let manual = TotpConfig {
            auto_submit: false,
            ..cfg
        };
        assert!(answers_for_prompts(&prompts, &manual, 1_700_000_000).is_none());
    }
}
