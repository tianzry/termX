/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 单测配置独立于 vite.config.ts：那份是 Tauri devServer 配置（端口 / HMR / watch），
// vitest 存在 vitest.config.ts 时优先读它，互不干扰。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // src-tauri 是 Rust 后端（其单测走 cargo test --lib），dist 是构建产物。
    exclude: ["node_modules/**", "dist/**", "src-tauri/**"],
    coverage: {
      // 只统计业务源码，排除测试自身与 setup，避免报告混入 jsdom 内部文件。
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.{test,spec}.{ts,tsx}"],
    },
  },
});
