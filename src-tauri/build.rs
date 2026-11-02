fn main() {
    tauri_build::build();
    // cargo test 的 harness exe 不走 tauri 打包的清单管线；而 rfd /
    // tauri-plugin-dialog 静态导入 comctl32 v6 的 TaskDialogIndirect，
    // 测试 exe 没有任何声明 Common-Controls v6 依赖的清单时，会在加载期
    // 直接崩在 STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)。
    // 注意：不能用 cargo:rustc-link-arg-tests——本包只有 lib 单元测试、
    // 没有 [[test]] 目标，cargo 会直接报错；GUI bin 已带 tauri 内嵌清单，
    // link.exe 会忽略该开关（仅告警），不受影响。
    #[cfg(windows)]
    println!(
        "cargo:rustc-link-arg=-MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}
