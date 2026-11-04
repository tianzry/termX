//! 真实 SSH mock 服务端验证：keyboard-interactive 收到验证码提示后，
//! 用生产 `totp::answers_for_prompts` 自动计算并回答，服务端校验通过。
//! 需先安装 paramiko；默认脚本路径 `../evidence/mock-totp-sshd.py`，
//! 可用 `TERMX_MOCK_TOTP_SCRIPT` 覆盖。该用例标 `#[ignore]`，避免常规测试依赖 Python。
use std::process::{Child, Command};
use std::time::Duration;

use rssh_lib::totp::{answers_for_prompts, TotpConfig};

struct AcceptAnyHostKey;

impl russh::client::Handler for AcceptAnyHostKey {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        _key: &russh::keys::ssh_key::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(true) }
    }
}

fn spawn_mock(port: u16) -> Child {
    let script = std::env::var("TERMX_MOCK_TOTP_SCRIPT").unwrap_or_else(|_| {
        let mut path = std::env::current_exe().expect("current_exe");
        for _ in 0..4 {
            path.pop();
        }
        path.push("evidence/mock-totp-sshd.py");
        path.to_string_lossy().to_string()
    });
    Command::new("python")
        .arg(&script)
        .arg(port.to_string())
        .spawn()
        .expect("spawn mock TOTP ssh server")
}

#[tokio::test]
#[ignore = "requires paramiko mock SSH server"]
async fn totp_auto_answer_succeeds_against_mock_server() {
    let port: u16 = 2299;
    let mut child = spawn_mock(port);
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let config = std::sync::Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect(config, ("127.0.0.1", port), AcceptAnyHostKey)
        .await
        .expect("connect mock server");

    let cfg = TotpConfig {
        secret: "JBSWY3DPEHPK3PXP".to_owned(),
        auto_submit: true,
        regex: None,
    };

    let mut response = session
        .authenticate_keyboard_interactive_start("root", None)
        .await
        .expect("start keyboard-interactive");
    loop {
        match response {
            russh::client::KeyboardInteractiveAuthResponse::Success => break,
            russh::client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                let _ = child.kill();
                panic!("server rejected the auto-filled TOTP code");
            }
            russh::client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let pairs: Vec<(String, bool)> = prompts
                    .iter()
                    .map(|p| (p.prompt.clone(), p.echo))
                    .collect();
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                let answers = answers_for_prompts(&pairs, &cfg, now)
                    .expect("prompts must be recognized as an OTP challenge");
                response = session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .expect("respond to OTP prompt");
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}
