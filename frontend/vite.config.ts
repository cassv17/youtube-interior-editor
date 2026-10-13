import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 중(npm run dev)에는 API 요청을 로컬 서버(8000)로 넘긴다.
// 체험 배포본(npm run build:demo)은 서버 없이 동작하며 샘플 영상(demo-public)만 함께 담는다.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8000" } },
  publicDir: mode === "demo" ? "demo-public" : false,
  build: { outDir: mode === "demo" ? "dist-demo" : "dist", emptyOutDir: true },
}));
