import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 중(npm run dev)에는 API 요청을 로컬 서버(8000)로 넘긴다.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8000" } },
  build: { outDir: "dist", emptyOutDir: true },
});
