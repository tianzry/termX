#[cfg(desktop)]
pub mod cli;
pub mod app_lock;
pub mod command_block;
pub mod discovery;
pub mod external;
pub mod forward;
pub mod group;
pub mod keychain;
pub mod lifecycle;
pub mod localfs;
pub mod monitor;
pub mod notes;
pub mod plugin;
pub mod profile;
pub mod proxy;
#[cfg(desktop)]
pub mod pty;
#[cfg(desktop)]
pub mod serial;
pub mod session;
pub mod session_logs;
pub mod settings;
pub mod sftp;
pub mod sync;
pub mod telnet;
pub mod update;
#[cfg(desktop)]
pub mod window;
