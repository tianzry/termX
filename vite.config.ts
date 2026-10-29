import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 与 rssh 前端一致：xterm 6.0 的 requestMode 用 es2021 logical-assignment，
  // esbuild 降级到 es2020 会丢掉 `let` 声明导致运行时 ReferenceError。
  // 必须把 target 抬到 es2021（WKWebView 原生支持）。
  build: {
    target: "es2021",
  },
  server: {
    host: host || false,
    port: 1420,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});