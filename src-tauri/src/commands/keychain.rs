//! 钥匙串（Vault → 钥匙串）：SSH 密钥的生成 / 导入。
//!
//! 复用 `credentials` 表，不新增表：
//! - `credential_type = key`；
//! - `secret` 走 SecretStore（`cred:<id>:secret`），存 OpenSSH 私钥原文；
//! - **`username` 字段存 SSH 公钥行**（`ssh-ed25519 AAAA… comment`）——
//!   这是钥匙串条目的内部约定（对齐 netcatty SSHKey.publicKey 的存放需求），
//!   密钥凭据的登录名一律取自主机档案，不从这里读。
//!
//! passphrase 不持久化（与凭据面板约定一致）：生成时若提供 passphrase，
//! 只用于加密私钥后落库；连接时照旧走终端交互输入。

use serde_json::json;
use tauri::State;

use crate::error::AppError;
use crate::models::{Credential, CredentialType};
use crate::state::AppState;

/// 对齐 netcatty generateKeyPair 的 comment 约定（`${label}@netcatty`）。
fn key_comment(label: &str) -> String {
    format!("{label}@termx")
}

fn map_key_err(e: impl std::fmt::Display) -> AppError {
    AppError::other("key_generation_failed", json!({ "error": e.to_string() }))
}

fn insert_key_credential(
    state: &AppState,
    label: &str,
    private_pem: &str,
    public_line: &str,
) -> Result<Credential, AppError> {
    let cred = Credential {
        id: uuid::Uuid::new_v4().to_string(),
        name: label.to_string(),
        // 内部约定：钥匙串条目的 username 存公钥行，见模块头注释。
        username: public_line.to_string(),
        credential_type: CredentialType::Key,
        secret: None,
        save_to_remote: false,
    };
    crate::db::credential::insert(&state.db, &cred)?;
    state
        .secret_store
        .set(&crate::secret::cred_secret_key(&cred.id), private_pem)?;
    Ok(cred)
}

/// 生成 SSH 密钥对并保存为钥匙串凭据。
///
/// `algorithm`：`ED25519` | `ECDSA` | `RSA`（对齐 netcatty GenerateStandardPanel）。
/// `bits`：RSA 位宽（缺省 4096）；ECDSA 曲率（256/384/521 → P-256/384/521，缺省 256）。
/// `passphrase`：非空时先加密私钥再落库（passphrase 本身不持久化）。
pub fn keychain_generate_key_impl(
    state: &AppState,
    label: &str,
    algorithm: &str,
    bits: Option<u32>,
    passphrase: Option<&str>,
) -> Result<Credential, AppError> {
    use russh::keys::ssh_key::{Algorithm, EcdsaCurve, LineEnding, PrivateKey};

    let label = label.trim();
    if label.is_empty() {
        return Err(AppError::other("label_required", json!({})));
    }

    let mut rng = rand::rng();
    let mut key = match algorithm {
        "ED25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519),
        "ECDSA" => {
            let curve = match bits.unwrap_or(256) {
                384 => EcdsaCurve::NistP384,
                521 => EcdsaCurve::NistP521,
                _ => EcdsaCurve::NistP256,
            };
            PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve })
        }
        "RSA" => {
            let bits = usize::try_from(bits.unwrap_or(4096)).unwrap_or(4096);
            if bits == 4096 {
                PrivateKey::random(&mut rng, Algorithm::Rsa { hash: None })
            } else {
                // ssh-key 的 PrivateKey::random 对 RSA 固定 4096 位，
                // 其余位宽走 RsaKeypair::random 指定位宽再组装。
                let kp = russh::keys::ssh_key::private::RsaKeypair::random(&mut rng, bits)
                    .map_err(map_key_err)?;
                PrivateKey::try_from(russh::keys::ssh_key::private::KeypairData::from(kp))
            }
        }
        _ => {
            return Err(AppError::other(
                "unsupported_algorithm",
                json!({ "algorithm": algorithm }),
            ))
        }
    }
    .map_err(map_key_err)?;

    key.set_comment(key_comment(label));

    let key = match passphrase.map(str::trim).filter(|p| !p.is_empty()) {
        Some(pw) => key.encrypt(&mut rng, pw).map_err(map_key_err)?,
        None => key,
    };

    let pem = key.to_openssh(LineEnding::LF).map_err(map_key_err)?;
    let public_line = key.public_key().to_openssh().map_err(map_key_err)?;

    insert_key_credential(state, label, pem.as_str(), &public_line)
}

#[tauri::command]
pub fn keychain_generate_key(
    state: State<AppState>,
    label: String,
    algorithm: String,
    bits: Option<u32>,
    passphrase: Option<String>,
) -> Result<Credential, AppError> {
    keychain_generate_key_impl(&state, &label, &algorithm, bits, passphrase.as_deref())
}

/// 导入已有私钥：解析校验 + 落库。`public_key` 为空时从私钥推导公钥行。
///
/// 解析顺序与连接认证路径保持一致的宽容度：
/// 1. `PrivateKey::from_openssh` —— OpenSSH v1（含加密条目，公钥区明文可解析）；
/// 2. `russh::keys::decode_secret_key` —— PPK / 传统 PEM / PKCS#8（未加密）。
pub fn keychain_import_key_impl(
    state: &AppState,
    label: &str,
    private_key: &str,
    public_key: Option<&str>,
) -> Result<Credential, AppError> {
    use russh::keys::ssh_key::PrivateKey;

    let label = label.trim();
    if label.is_empty() {
        return Err(AppError::other("label_required", json!({})));
    }
    if private_key.trim().is_empty() {
        return Err(AppError::other("private_key_required", json!({})));
    }

    let parsed = match PrivateKey::from_openssh(private_key) {
        Ok(k) => k,
        Err(_) => russh::keys::decode_secret_key(private_key, None).map_err(|e| {
            AppError::other("invalid_private_key", json!({ "error": e.to_string() }))
        })?,
    };

    let public_line = match public_key.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => parsed.public_key().to_openssh().map_err(map_key_err)?,
    };

    insert_key_credential(state, label, private_key, &public_line)
}

#[tauri::command]
pub fn keychain_import_key(
    state: State<AppState>,
    label: String,
    private_key: String,
    public_key: Option<String>,
) -> Result<Credential, AppError> {
    keychain_import_key_impl(&state, &label, &private_key, public_key.as_deref())
}

#[cfg(test)]
mod tests {
    //! 钥匙串生成 / 导入：内存 Db + DbStore，走 test_support::headless_host()。
    use super::*;
    use crate::ssh::test_support::headless_host;

    #[test]
    fn generate_ed25519_stores_secret_and_public_key() {
        let (host, _rx) = headless_host();
        let state = host.state();

        let cred = keychain_generate_key_impl(&state, "My Key", "ED25519", None, None).unwrap();
        assert_eq!(cred.name, "My Key");
        assert!(matches!(cred.credential_type, CredentialType::Key));
        assert!(cred.username.starts_with("ssh-ed25519 "));
        assert!(cred.username.ends_with("My Key@termx"));
        assert!(cred.secret.is_none(), "返回体不带 secret");

        let secret = state
            .secret_store
            .get(&crate::secret::cred_secret_key(&cred.id))
            .unwrap()
            .expect("secret 已写入 SecretStore");
        assert!(secret.contains("-----BEGIN OPENSSH PRIVATE KEY-----"));
        // 落库私钥可被连接认证路径原样解析。
        russh::keys::decode_secret_key(&secret, None).unwrap();
    }

    #[test]
    fn generate_rsa_2048_honors_bits() {
        let (host, _rx) = headless_host();
        let state = host.state();

        let cred = keychain_generate_key_impl(&state, "rsa", "RSA", Some(2048), None).unwrap();
        assert!(cred.username.starts_with("ssh-rsa "));
    }

    #[test]
    fn generate_with_passphrase_stores_encrypted_key() {
        let (host, _rx) = headless_host();
        let state = host.state();

        let cred = keychain_generate_key_impl(
            &state,
            "enc",
            "ED25519",
            None,
            Some("hunter42"),
        )
        .unwrap();
        let secret = state
            .secret_store
            .get(&crate::secret::cred_secret_key(&cred.id))
            .unwrap()
            .unwrap();
        // 加密条目：无 passphrase 解析报 KeyIsEncrypted。
        assert!(matches!(
            russh::keys::decode_secret_key(&secret, None),
            Err(russh::keys::Error::KeyIsEncrypted)
        ));
        russh::keys::decode_secret_key(&secret, Some("hunter42")).unwrap();
    }

    #[test]
    fn generate_rejects_empty_label_and_unknown_algorithm() {
        let (host, _rx) = headless_host();
        let state = host.state();

        assert!(keychain_generate_key_impl(&state, "  ", "ED25519", None, None).is_err());
        assert!(keychain_generate_key_impl(&state, "k", "DSA-NOT", None, None).is_err());
    }

    #[test]
    fn import_roundtrips_a_generated_key_and_rejects_garbage() {
        let (host, _rx) = headless_host();
        let state = host.state();

        let gen = keychain_generate_key_impl(&state, "src", "ED25519", None, None).unwrap();
        let pem = state
            .secret_store
            .get(&crate::secret::cred_secret_key(&gen.id))
            .unwrap()
            .unwrap();

        let imported =
            keychain_import_key_impl(&state, "imported", &pem, None).unwrap();
        assert_eq!(imported.username, gen.username, "公钥行从私钥推导一致");

        assert!(keychain_import_key_impl(&state, "bad", "not a key", None).is_err());
        assert!(keychain_import_key_impl(&state, "", &pem, None).is_err());
        assert!(keychain_import_key_impl(&state, "x", "  ", None).is_err());
    }
}
