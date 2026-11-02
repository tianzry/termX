// 测试环境初始化：由 vitest.config.ts 的 setupFiles 引入。
// 1. 注册 jest-dom 匹配器（toBeInTheDocument / toBeDisabled 等），供 RTL 组件测试使用；
// 2. vitest 未开 globals，RTL 不会自动卸载组件，必须手动 cleanup，
//    否则多个用例的渲染会叠在同一个 document.body 上互相污染。
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
