import { createRoot } from "react-dom/client";
import App from "./App";
import { AppLockGate } from "./appLock/AppLockGate";
import { reconcileSessions } from "./backend/client";
import "./styles.css";

// 注意：不加 <React.StrictMode>。StrictMode 在 dev 模式会双跑 effect，
// 导致本地 PTY 被 spawn 两次，主干链路还没跑通前先避开这个坑。

async function bootstrap() {
  // 页面重载后前端会丢失全部会话引用，但后端会话（尤其串口的独占句柄）
  // 仍挂在上一代页面上。渲染工作区前先按空列表回收，避免重载后重连
  // COM4 等端口时被旧句柄拒绝；Workspace 的自动恢复连接在这之后才会发起。
  try {
    await reconcileSessions([]);
  } catch {
    // 非 Tauri 环境（纯浏览器调试）或后端未就绪时忽略。
  }
  createRoot(document.getElementById("root")!).render(
    <>
      <App />
      {/* 应用锁遮罩（#23）：锁定后覆盖全应用，口令正确才卸载。 */}
      <AppLockGate />
    </>,
  );
}

void bootstrap();
