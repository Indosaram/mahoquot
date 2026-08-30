import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const happyDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-12/logs-settings-happy",
);
const failureDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-12/logs-settings-failure",
);

const happyStats = {
  uptime_secs: 18_400,
  in_flight: 1,
  served: 5_210,
  failed_over: 4,
  refreshed: 12,
  ttft: { p50_ms: 85, p90_ms: 190, p99_ms: 380, samples: 100 },
  accounts: [],
};

const setupHappyMocks = async (page: Page) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-secret-qkey-12345");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });
  await page.route("**/admin/stats", (route) => route.fulfill({ json: happyStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        lines: [
          "2026-08-30T10:00:00Z [INFO] gateway listening on http://127.0.0.1:18801",
          "2026-08-30T10:00:01Z [INFO] pool initialized with 3 accounts",
          "2026-08-30T10:00:02Z [INFO] warmup dispatch complete for all available providers",
          "2026-08-30T10:00:05Z [INFO] telemetry aggregation cycle complete",
          "2026-08-30T10:00:10Z [INFO] incoming proxy request /v1/chat/completions -> routing: round-robin",
        ],
      },
    }),
  );
  await page.route(/\/v0\/management\/config\.yaml$/, (route) =>
    route.fulfill({
      body: "port: 18801\nrouting:\n  strategy: round-robin\nretries: 3\n",
      contentType: "application/yaml",
    }),
  );
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
      const url = route.request().url();
      if (url.endsWith("proxy-url")) return route.fulfill({ json: { "proxy-url": "" } });
      if (url.endsWith("routing/strategy")) return route.fulfill({ json: { strategy: "round-robin" } });
      if (url.endsWith("request-retry")) return route.fulfill({ json: { "request-retry": 3 } });
      return route.fulfill({ json: { "logging-to-file": false } });
    },
  );
};

test.describe("Task 12 Evidence Capture - Logs & Settings Surfaces", () => {
  test.beforeAll(async () => {
    await mkdir(happyDir, { recursive: true });
    await mkdir(failureDir, { recursive: true });
  });

  test("captures happy Logs and Settings scenarios at 1100x720 and 390x844", async ({ page }) => {
    await setupHappyMocks(page);

    // 1. Desktop 1100x720 Logs surface with raw log lines and bounded container
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=logs");
    await expect(page.locator(".logs-surface")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gateway logs" })).toBeVisible();
    await expect(page.getByText("gateway listening on http://127.0.0.1:18801")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "logs-desktop-1100x720.png") });

    // 2. Desktop 1100x720 Settings surface with all stacked cards
    await page.goto("/management.html?surface=settings");
    await expect(page.locator(".content.settings")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gateway process" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connection & access" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Proxy behavior" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Advanced YAML" })).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "settings-desktop-1100x720-dark.png") });

    // 3. Trigger YAML configuration editor drawer from Settings
    await page.getByRole("button", { name: "Open YAML editor" }).click();
    await expect(
      page.getByRole("complementary", { name: "Advanced configuration editor" }),
    ).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "settings-advanced-yaml-drawer-1100x720.png") });
    await page.getByRole("button", { name: "Close configuration editor" }).click();

    // 4. Switch theme to Light mode in Settings
    await page.getByLabel("Theme").selectOption("light");
    await page.screenshot({ path: resolve(happyDir, "settings-desktop-1100x720-light.png") });

    // 5. Mobile 390x844 Logs and Settings views
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html?surface=logs");
    await expect(page.locator(".logs-surface")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "logs-mobile-390x844.png") });

    await page.goto("/management.html?surface=settings");
    await expect(page.locator(".content.settings")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "settings-mobile-390x844.png") });
  });

  test("captures failure, stress, locked, and error scenarios for Logs and Settings", async ({ page }) => {
    // 1. 10,000 log lines content stress
    const highVolumeLogs = Array.from({ length: 10_000 }, (_, i) =>
      `[${String(i).padStart(6, "0")}] 2026-08-30T10:00:00Z gateway high-throughput relay metric sample id=${i}`,
    );

    await page.addInitScript(() => {
      localStorage.setItem("mahoquot.base", "");
      localStorage.setItem("mahoquot.key", "relay-test-key-with-an-extremely-long-256-bit-token-string-for-unbroken-wrapping-boundary-test");
      localStorage.setItem("mahoquot.mgmt", "management-test-key");
      window.open = () => null;
    });
    await page.route("**/admin/stats", (route) => route.fulfill({ json: happyStats }));
    await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { files: [] } }),
    );
    await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { lines: highVolumeLogs } }),
    );
    await page.route(/\/v0\/management\/config\.yaml$/, (route) =>
      route.fulfill({ body: "port: 18801\n", contentType: "application/yaml" }),
    );
    await page.route(
      /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
      (route) => route.fulfill({ json: { status: "ok" } }),
    );

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=logs");
    await expect(page.locator(".logs-surface pre")).toBeVisible();
    await expect(page.getByText("[009999] 2026-08-30T10:00:00Z gateway high-throughput")).toBeVisible();

    const noHOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    );
    expect(noHOverflow).toBe(true);
    await page.screenshot({ path: resolve(failureDir, "logs-stress-10000-lines-1100x720.png") });

    // 2. Settings with Malformed URL and Validation Error
    await page.goto("/management.html?surface=settings");
    const address = page.getByLabel("Gateway URL");
    await address.fill("malformed-invalid-url");
    await page.getByRole("button", { name: "Save & reconnect" }).click();
    await expect(page.getByText(/Gateway URL must be an absolute http:\/\/ or https:\/\/ URL/i).first()).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "settings-malformed-url-error.png") });

    // 3. Settings with Long API key and 390x844 responsive wrapping
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    );
    expect(mobileNoOverflow).toBe(true);
    await page.screenshot({ path: resolve(failureDir, "settings-long-key-mobile-390x844.png") });

    // 4. Locked Management / Offline State
    await page.route("**/admin/stats", (route) => route.abort("connectionrefused"));
    await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) => route.fulfill({ status: 401, body: "locked" }));
    await page.goto("/management.html?surface=logs");
    await expect(page.locator(".logs-surface")).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "logs-offline-error-state.png") });

    await page.goto("/management.html?surface=settings");
    await expect(page.locator(".content.settings")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gateway process" })).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "settings-offline-reconnectable-state.png") });
  });
});
