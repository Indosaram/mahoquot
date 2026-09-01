import { defineConfig } from "@playwright/test";

export default defineConfig({
  // primitive-showcase.spec.ts targets the QA harness artifact; run it with
  // `bunx playwright test -c playwright.qa.config.ts` (serves qa.html on :4188).
  testIgnore: ["**/primitive-showcase.spec.ts"],
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun e2e/server.ts",
    url: "http://127.0.0.1:4173/management.html",
    reuseExistingServer: false,
  },
});
