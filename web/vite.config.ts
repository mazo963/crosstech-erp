import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages 等のサブパス配信でも動くよう相対パスにする
export default defineConfig({ base: "./", plugins: [react()], build: { chunkSizeWarningLimit: 1300 } }); // PDF用の別ファイルは約1.1MB（使うときだけ読み込む）
