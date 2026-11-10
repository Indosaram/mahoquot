import { defineConfig } from "../../crates/monitor-ui/frontend/node_modules/vitest/dist/config.js";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  test: {
    include: ["src/__tests__/review-20261025-site-fixes.test.tsx"],
    testTimeout: 5000,
  },
});
