import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// 注意：不加 <React.StrictMode>。StrictMode 在 dev 模式会双跑 effect，
// 导致本地 PTY 被 spawn 两次，主干链路还没跑通前先避开这个坑。
createRoot(document.getElementById("root")!).render(<App />);