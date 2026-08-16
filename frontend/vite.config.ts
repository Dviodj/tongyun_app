import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发模式下将 /api 请求代理到本地 Python 桥接服务（backend/backend.py）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
