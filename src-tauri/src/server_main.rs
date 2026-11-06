//! `termx-server` — headless ws server entry point. Reuses the termx engine via
//! `termx_lib::server`; the IDEA plugin (or a dev script) spawns this and reads
//! the `{"port":..,"token":..}` line it prints on stdout to point the frontend.

#[cfg(desktop)]
fn main() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    if let Err(e) = rt.block_on(termx_lib::server::run()) {
        eprintln!("termx-server failed: {e}");
        std::process::exit(1);
    }
}

#[cfg(mobile)]
fn main() {
    eprintln!("termx-server is only supported on desktop platforms");
    std::process::exit(1);
}
