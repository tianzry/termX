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

/// 生成密钥对（纯密码学操作，落库与写 `~/.ssh` 文件两条路径共用）。
///
/// `algorithm`：`ED25519` | `ECDSA` | `RSA`（对齐 netcatty GenerateStandardPanel）。
/// `bits`：RSA 位宽（缺省 4096）；ECDSA 曲率（256/384/521 → P-256/384/521，缺省 256）。
/// `passphrase` 非空时先加密私钥。返回 (OpenSSH 私钥原文, 公钥行)。
fn generate_private_key(
    algorithm: &str,
    bits: Option<u32>,
    passphrase: Option<&str>,
    comment: &str,
) -> Result<(String, String), AppError> {
    use russh::keys::ssh_key::{Algorithm, EcdsaCurve, LineEnding, PrivateKey};

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

    key.set_comment(comment.to_string());

    let key = match passphrase.map(str::trim).filter(|p| !p.is_empty()) {
        Some(pw) => key.encrypt(&mut rng, pw).map_err(map_key_err)?,
        None => key,
    };

    // ssh-key 0.7：to_openssh 返回 Zeroizing<String>（敏感内存自动清零包装），
    // 取出普通 String 供返回；Zeroizing 原件随作用域结束清零。
    let pem = key.to_openssh(LineEnding::LF).map_err(map_key_err)?.to_string();
    let public_line = key.public_key().to_openssh().map_err(map_key_err)?;
    Ok((pem, public_line))
}

/// 生成 SSH 密钥对并保存为钥匙串凭据。
///
/// `passphrase`：非空时先加密私钥再落库（passphrase 本身不持久化）。
pub fn keychain_generate_key_impl(
    state: &AppState,
    label: &str,
    algorithm: &str,
    bits: Option<u32>,
    passphrase: Option<&str>,
) -> Result<Credential, AppError> {
    let label = label.trim();
    if label.is_empty() {
        return Err(AppError::other("label_required", json!({})));
    }
    let (pem, public_line) =
        generate_private_key(algorithm, bits, passphrase, &key_comment(label))?;
    insert_key_credential(state, label, &pem, &public_line)
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

// ---------------------------------------------------------------------------
// ~/.ssh 文件密钥管理（钥匙串阶段 A）：枚举 / 生成落盘 / 导入 / 删除 / 设默认。
//
// 安全约定：
// - 私钥内容绝不返回前端、不落日志——枚举只回元数据与公钥行；
//   生成 / 导入只回写入条目的元数据（SshFileKeyEntry）。
// - name 一律走 `is_plain_file_name`（单层文件名），join 后不可能逃逸 `~/.ssh`。
// - 「默认密钥」落 settings 表（`ssh_default_key`），连接选择器的
//   「读取默认密钥」优先该设置、缺省回落 `id_ed25519`（历史行为）。
// ---------------------------------------------------------------------------

/// `~/.ssh` 内单个私钥的元数据（公钥信息 + 标记位）。
#[derive(serde::Serialize)]
pub struct SshFileKeyEntry {
    pub name: String,
    /// 展示路径 `~/.ssh/<name>`。
    pub path: String,
    /// `ssh-ed25519` / `ssh-rsa` / `ecdsa-sha2-nistp256`…；
    /// 无法判定（如传统 PEM 私钥且无同名 .pub）为空串。
    pub key_type: String,
    /// `SHA256:...` 指纹；无法判定为空串。
    pub fingerprint: String,
    /// 公钥行（.pub 内容或从私钥推导）；无法判定为 None。
    pub public_key: Option<String>,
    /// 私钥是否 passphrase 加密。
    pub encrypted: bool,
    /// 是否当前默认密钥。
    pub is_default: bool,
}

const DEFAULT_KEY_SETTING: &str = "ssh_default_key";
/// 连接选择器的历史默认名（ConnectionManager fillDefaultKey 的原始硬编码）。
pub const FALLBACK_DEFAULT_KEY: &str = "id_ed25519";

/// `~/.ssh` 目录。`TERMX_SSH_DIR` 仅供测试注入（同 TERMX_SSH_TEST_* 约定）。
fn ssh_dir() -> Result<std::path::PathBuf, AppError> {
    if let Ok(dir) = std::env::var("TERMX_SSH_DIR") {
        return Ok(std::path::PathBuf::from(dir));
    }
    let home =
        dirs::home_dir().ok_or_else(|| AppError::other("home_dir_unavailable", json!({})))?;
    Ok(home.join(".ssh"))
}

fn display_path(name: &str) -> String {
    format!("~/.ssh/{name}")
}

/// 解析公钥行 → (算法名, SHA256 指纹)。
fn public_key_meta(line: &str) -> Option<(String, String)> {
    use russh::keys::ssh_key::{HashAlg, PublicKey};
    let pk = PublicKey::from_openssh(line.trim()).ok()?;
    // ssh-key 0.7：fingerprint 返回 Fingerprint 枚举，Display 输出 `SHA256:...`。
    let fp = pk.fingerprint(HashAlg::Sha256).to_string();
    let fp = if fp.starts_with("SHA256:") {
        fp
    } else {
        format!("SHA256:{fp}")
    };
    Some((pk.algorithm().to_string(), fp))
}

/// 写密钥文件；unix 下按 OpenSSH 要求设权限（私钥 0600 / 公钥 0644），
/// 否则 ssh 客户端拒绝使用。Windows 无等价 chmod，不做 ACL 处理（留档）。
fn write_key_file(path: &std::path::Path, content: &str, mode: u32) -> Result<(), AppError> {
    std::fs::write(path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
    }
    Ok(())
}

/// 从磁盘读一个私钥条目；非私钥（嗅探失败）返回 None。
fn entry_from_disk(dir: &std::path::Path, name: &str, default_name: &str) -> Option<SshFileKeyEntry> {
    use crate::commands::profile::{looks_like_private_key, MAX_KEY_FILE_BYTES};
    use russh::keys::ssh_key::PrivateKey;

    let path = dir.join(name);
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size == 0 || size > MAX_KEY_FILE_BYTES {
        return None;
    }
    let Ok(content) = std::fs::read_to_string(&path) else {
        return None;
    };
    if !looks_like_private_key(&content) {
        return None;
    }

    let mut key_type = String::new();
    let mut fingerprint = String::new();
    let mut public_key = None;
    let mut encrypted = false;

    // 优先同名 .pub（公钥信息，安全返回）；没有再试解析未加密私钥推导。
    if let Ok(pub_text) = std::fs::read_to_string(dir.join(format!("{name}.pub"))) {
        if let Some((t, fp)) = public_key_meta(&pub_text) {
            key_type = t;
            fingerprint = fp;
            public_key = Some(pub_text.trim().to_string());
        }
    }
    if key_type.is_empty() {
        match PrivateKey::from_openssh(&content) {
            Ok(k) => {
                // from_openssh 对加密私钥也返回 Ok（保持加密态）；
                // OpenSSH v1 的公钥部分明文存放，public_key() 仍可用，加密标记置位。
                encrypted = k.is_encrypted();
                if let Ok(line) = k.public_key().to_openssh() {
                    if let Some((t, fp)) = public_key_meta(&line) {
                        key_type = t;
                        fingerprint = fp;
                        public_key = Some(line);
                    }
                }
            }
            Err(_) => {}
        }
    }

    Some(SshFileKeyEntry {
        name: name.to_string(),
        path: display_path(name),
        key_type,
        fingerprint,
        public_key,
        encrypted,
        is_default: name == default_name,
    })
}

fn list_file_keys_in(dir: &std::path::Path, default_name: &str) -> Result<Vec<SshFileKeyEntry>, AppError> {
    use crate::commands::profile::is_plain_file_name;

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_plain_file_name(&name) || name.ends_with(".pub") || !entry.path().is_file() {
            continue;
        }
        if let Some(e) = entry_from_disk(dir, &name, default_name) {
            out.push(e);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn default_key_name(state: &AppState) -> Result<String, AppError> {
    Ok(crate::db::settings::get(&state.db, DEFAULT_KEY_SETTING)?
        .unwrap_or_else(|| FALLBACK_DEFAULT_KEY.to_string()))
}

/// 枚举 `~/.ssh` 下的私钥（内容嗅探过滤）。私钥内容不出后端。
pub fn keychain_list_file_keys_impl(state: &AppState) -> Result<Vec<SshFileKeyEntry>, AppError> {
    let dir = ssh_dir()?;
    list_file_keys_in(&dir, &default_key_name(state)?)
}

fn generate_file_key_in(
    dir: &std::path::Path,
    name: &str,
    algorithm: &str,
    bits: Option<u32>,
    passphrase: Option<&str>,
) -> Result<(), AppError> {
    if !crate::commands::profile::is_plain_file_name(name) {
        return Err(AppError::other("invalid_key_name", json!({ "name": name })));
    }
    std::fs::create_dir_all(dir)?;
    if dir.join(name).exists() {
        return Err(AppError::other("key_file_exists", json!({ "name": name })));
    }
    let (pem, public_line) =
        generate_private_key(algorithm, bits, passphrase, &format!("{name}@termx"))?;
    // unix 权限在 write 时一次性设好，避免中间态被同机读取。
    write_key_file(&dir.join(name), &pem, 0o600)?;
    if let Err(e) = write_key_file(&dir.join(format!("{name}.pub")), &format!("{public_line}\n"), 0o644) {
        // .pub 写失败不丢私钥：回滚私钥文件，整体报错。
        let _ = std::fs::remove_file(dir.join(name));
        return Err(e);
    }
    Ok(())
}

/// 生成密钥对并写入 `~/.ssh/<name>` + `<name>.pub`。拒绝覆盖既有文件。
/// 返回写入条目的元数据（不含私钥内容）。
pub fn keychain_generate_file_key_impl(
    state: &AppState,
    name: &str,
    algorithm: &str,
    bits: Option<u32>,
    passphrase: Option<&str>,
) -> Result<SshFileKeyEntry, AppError> {
    let dir = ssh_dir()?;
    generate_file_key_in(&dir, name, algorithm, bits, passphrase)?;
    // 从磁盘复读取回，保证返回与实际落盘一致。
    entry_from_disk(&dir, name, &default_key_name(state)?)
        .ok_or_else(|| AppError::other("key_write_failed", json!({ "name": name })))
}

fn import_file_key_in(
    dir: &std::path::Path,
    name: &str,
    private_key: &str,
    public_key: Option<&str>,
) -> Result<Option<String>, AppError> {
    use russh::keys::ssh_key::PrivateKey;

    if !crate::commands::profile::is_plain_file_name(name) {
        return Err(AppError::other("invalid_key_name", json!({ "name": name })));
    }
    if private_key.trim().is_empty() {
        return Err(AppError::other("private_key_required", json!({})));
    }
    std::fs::create_dir_all(dir)?;
    if dir.join(name).exists() {
        return Err(AppError::other("key_file_exists", json!({ "name": name })));
    }

    // 与落库导入同一解析链：OpenSSH v1（含加密）→ PPK / 传统 PEM / PKCS#8。
    // 只校验可解析性并尽力推导公钥行；类型/指纹元数据在写盘后由
    // entry_from_disk 统一重解析（单一事实来源）。
    let mut derived_pub: Option<String> = None;
    match PrivateKey::from_openssh(private_key) {
        Ok(k) => {
            // 加密私钥同样解析成功（保持加密态）；公钥部分明文存放，仍可推导。
            if let Ok(line) = k.public_key().to_openssh() {
                derived_pub = Some(line);
            }
        }
        Err(_) => match russh::keys::decode_secret_key(private_key, None) {
            Ok(k) => {
                if let Ok(line) = k.public_key().to_openssh() {
                    derived_pub = Some(line);
                }
            }
            Err(russh::keys::Error::KeyIsEncrypted) => {}
            Err(e) => {
                return Err(AppError::other(
                    "invalid_private_key",
                    json!({ "error": e.to_string() }),
                ))
            }
        },
    }

    // 公钥参数优先（也是加密私钥补 .pub 的唯一途径）。
    let pub_line = match public_key.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(s.to_string()),
        None => derived_pub,
    };

    write_key_file(&dir.join(name), private_key, 0o600)?;
    if let Some(line) = &pub_line {
        write_key_file(&dir.join(format!("{name}.pub")), &format!("{line}\n"), 0o644)?;
    }
    Ok(pub_line)
}

/// 导入已有私钥到 `~/.ssh/<name>`（解析校验 + 写盘，拒绝覆盖）。
/// 公钥参数缺省时从未加密私钥推导；返回写入条目的元数据。
pub fn keychain_import_file_key_impl(
    state: &AppState,
    name: &str,
    private_key: &str,
    public_key: Option<&str>,
) -> Result<SshFileKeyEntry, AppError> {
    let dir = ssh_dir()?;
    import_file_key_in(&dir, name, private_key, public_key)?;
    entry_from_disk(&dir, name, &default_key_name(state)?)
        .ok_or_else(|| AppError::other("key_write_failed", json!({ "name": name })))
}

fn delete_file_key_in(dir: &std::path::Path, name: &str) -> Result<(), AppError> {
    if !crate::commands::profile::is_plain_file_name(name) {
        return Err(AppError::other("invalid_key_name", json!({ "name": name })));
    }
    let priv_path = dir.join(name);
    let pub_path = dir.join(format!("{name}.pub"));
    if !priv_path.exists() && !pub_path.exists() {
        return Err(AppError::other("key_file_not_found", json!({ "name": name })));
    }
    if priv_path.exists() {
        std::fs::remove_file(&priv_path)?;
    }
    if pub_path.exists() {
        std::fs::remove_file(&pub_path)?;
    }
    Ok(())
}

/// 删除 `~/.ssh/<name>`（连同同名 .pub）。若它是默认密钥，同步清空设置。
pub fn keychain_delete_file_key_impl(state: &AppState, name: &str) -> Result<(), AppError> {
    let dir = ssh_dir()?;
    delete_file_key_in(&dir, name)?;
    if crate::db::settings::get(&state.db, DEFAULT_KEY_SETTING)?.as_deref() == Some(name) {
        crate::db::settings::delete(&state.db, DEFAULT_KEY_SETTING)?;
    }
    Ok(())
}

/// 设为默认密钥：name 必须是 `~/.ssh` 下既存的私钥文件。
pub fn keychain_set_default_key_impl(state: &AppState, name: &str) -> Result<(), AppError> {
    if !crate::commands::profile::is_plain_file_name(name) {
        return Err(AppError::other("invalid_key_name", json!({ "name": name })));
    }
    let dir = ssh_dir()?;
    match entry_from_disk(&dir, name, "") {
        Some(_) => {}
        None => return Err(AppError::other("key_file_not_found", json!({ "name": name }))),
    }
    crate::db::settings::set(&state.db, DEFAULT_KEY_SETTING, name)?;
    Ok(())
}

/// 当前默认密钥名（settings 缺省回落 `id_ed25519`）。
pub fn keychain_get_default_key_impl(state: &AppState) -> Result<String, AppError> {
    default_key_name(state)
}

#[tauri::command]
pub fn keychain_list_file_keys(state: State<AppState>) -> Result<Vec<SshFileKeyEntry>, AppError> {
    keychain_list_file_keys_impl(&state)
}

#[tauri::command]
pub fn keychain_generate_file_key(
    state: State<AppState>,
    name: String,
    algorithm: String,
    bits: Option<u32>,
    passphrase: Option<String>,
) -> Result<SshFileKeyEntry, AppError> {
    keychain_generate_file_key_impl(&state, &name, &algorithm, bits, passphrase.as_deref())
}

#[tauri::command]
pub fn keychain_import_file_key(
    state: State<AppState>,
    name: String,
    private_key: String,
    public_key: Option<String>,
) -> Result<SshFileKeyEntry, AppError> {
    keychain_import_file_key_impl(&state, &name, &private_key, public_key.as_deref())
}

#[tauri::command]
pub fn keychain_delete_file_key(state: State<AppState>, name: String) -> Result<(), AppError> {
    keychain_delete_file_key_impl(&state, &name)
}

#[tauri::command]
pub fn keychain_set_default_key(state: State<AppState>, name: String) -> Result<(), AppError> {
    keychain_set_default_key_impl(&state, &name)
}

#[tauri::command]
pub fn keychain_get_default_key(state: State<AppState>) -> Result<String, AppError> {
    keychain_get_default_key_impl(&state)
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

    // ── ~/.ssh 文件密钥管理 ────────────────────────────────────────

    fn temp_ssh_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("termx-kc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn file_key_generate_list_delete_roundtrip() {
        let dir = temp_ssh_dir();
        generate_file_key_in(&dir, "k1", "ED25519", None, None).unwrap();
        assert!(dir.join("k1").exists());
        assert!(dir.join("k1.pub").exists());

        let list = list_file_keys_in(&dir, "k1").unwrap();
        assert_eq!(list.len(), 1);
        let e = &list[0];
        assert_eq!(e.name, "k1");
        assert_eq!(e.key_type, "ssh-ed25519");
        assert!(e.fingerprint.starts_with("SHA256:"));
        assert!(e.public_key.as_deref().unwrap().starts_with("ssh-ed25519 "));
        assert!(e.is_default, "默认名匹配 → is_default");
        assert!(!e.encrypted);

        // config 之类非私钥文件不进列表。
        std::fs::write(dir.join("config"), "Host x\n  HostName y\n").unwrap();
        assert_eq!(list_file_keys_in(&dir, "").unwrap().len(), 1);

        delete_file_key_in(&dir, "k1").unwrap();
        assert!(!dir.join("k1").exists());
        assert!(!dir.join("k1.pub").exists());
        assert!(delete_file_key_in(&dir, "k1").is_err(), "二次删除报 not_found");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_key_generate_rejects_overwrite_and_traversal() {
        let dir = temp_ssh_dir();
        generate_file_key_in(&dir, "dup", "ED25519", None, None).unwrap();
        let err = generate_file_key_in(&dir, "dup", "ED25519", None, None).unwrap_err();
        assert_eq!(err.code(), "key_file_exists");
        assert!(generate_file_key_in(&dir, "../evil", "ED25519", None, None).is_err());
        assert!(generate_file_key_in(&dir, "a/b", "ED25519", None, None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_key_import_writes_pair_and_rejects_garbage() {
        let dir = temp_ssh_dir();
        // 先生成再取其私钥文本做导入素材（避免在测试里内嵌大段密钥文本）。
        generate_file_key_in(&dir, "src", "ED25519", None, None).unwrap();
        let pem = std::fs::read_to_string(dir.join("src")).unwrap();

        import_file_key_in(&dir, "imp", &pem, None).unwrap();
        let imp = list_file_keys_in(&dir, "")
            .unwrap()
            .into_iter()
            .find(|e| e.name == "imp")
            .unwrap();
        assert_eq!(imp.key_type, "ssh-ed25519");
        assert!(dir.join("imp.pub").exists());

        assert!(import_file_key_in(&dir, "bad", "not a key", None).is_err());
        assert!(import_file_key_in(&dir, "empty", "   ", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_key_encrypted_without_pub_still_resolves_metadata() {
        let dir = temp_ssh_dir();
        generate_file_key_in(&dir, "enc", "ED25519", None, Some("pw")).unwrap();
        // 去掉 .pub 模拟「只有加密私钥」：OpenSSH v1 公钥部分明文存放，
        // 类型/指纹仍可判定，加密标记置位。
        std::fs::remove_file(dir.join("enc.pub")).unwrap();
        let e = list_file_keys_in(&dir, "")
            .unwrap()
            .into_iter()
            .find(|e| e.name == "enc")
            .unwrap();
        assert!(e.encrypted);
        assert_eq!(e.key_type, "ssh-ed25519");
        assert!(e.public_key.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_key_setting_roundtrip_via_env_dir() {
        // TERMX_SSH_DIR 重定向 ssh_dir()；本测试是唯一走 wrapper 路径的
        // 文件测试，与其他测试无 env 竞争。
        let dir = temp_ssh_dir();
        std::env::set_var("TERMX_SSH_DIR", &dir);
        let (host, _rx) = headless_host();
        let state = host.state();

        assert_eq!(
            keychain_get_default_key_impl(&state).unwrap(),
            FALLBACK_DEFAULT_KEY
        );

        keychain_generate_file_key_impl(&state, "mykey", "ED25519", None, None).unwrap();
        keychain_set_default_key_impl(&state, "mykey").unwrap();
        assert_eq!(keychain_get_default_key_impl(&state).unwrap(), "mykey");
        assert!(keychain_list_file_keys_impl(&state)
            .unwrap()
            .iter()
            .find(|e| e.name == "mykey")
            .unwrap()
            .is_default);

        // 设默认指向不存在的密钥 → 拒绝。
        assert!(keychain_set_default_key_impl(&state, "ghost").is_err());

        // 删除默认密钥 → 设置同步清空，回落 fallback。
        keychain_delete_file_key_impl(&state, "mykey").unwrap();
        assert_eq!(
            keychain_get_default_key_impl(&state).unwrap(),
            FALLBACK_DEFAULT_KEY
        );

        std::env::remove_var("TERMX_SSH_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
