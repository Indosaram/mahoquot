import { defineConfig } from "@playwright/test";

const port = Number(process.env.MAHOQUOT_SITE_QA_PORT ?? 18848);
const baseURL = `http://127.0.0.1:${port}/mahoquot/`;

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL,
  },
  webServer: {
    command: `bun run preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
