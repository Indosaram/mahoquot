import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, ".tmp/monitor-ui-qa"),
    emptyOutDir: true,
    cssMinify: true,
    minify: true,
    rollupOptions: {
      input: path.resolve(__dirname, "qa.html"),
      output: {
        manualChunks: undefined,
      },
    },
  },
});
