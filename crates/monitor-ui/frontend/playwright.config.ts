import { defineConfig } from "@playwright/test";

const port = Number(process.env.MAHOQUOT_E2E_PORT ?? 18847);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  // primitive-showcase.spec.ts targets the QA harness artifact; run it with
  // `bunx playwright test -c playwright.qa.config.ts` (serves qa.html on :4188).
  testIgnore: ["**/primitive-showcase.spec.ts"],
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun e2e/server.ts",
    url: `${baseURL}/management.html`,
    reuseExistingServer: false,
  },
});
