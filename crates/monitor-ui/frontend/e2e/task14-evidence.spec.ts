import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const task14Dir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-14",
);
const happyDir = resolve(task14Dir, "overlays-happy");

const unbrokenToken =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFjY3Qta2V5LTk5OTk5OTk5OTk5OSJ9.eyJpc3MiOiJtYWhvcXVvdC1hdXRoLWRhZW1vbiIsImF1ZCI6ImFwaS5tYWhvcXVvdC5pbyIsInN1YiI6ImFjY3RfOTk5OTk5OTk5OTk5IiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

const accountsPayload = {
  uptime_secs: 18_400,
  in_flight: 2,
  served: 4_320,
  failed_over: 3,
  refreshed: 8,
  ttft: { p50_ms: 110, p90_ms: 220, p99_ms: 450, samples: 80 },
  accounts: [
    {
      id: "acc-codex-primary@example.com",
      provider: "codex",
      status: "active",
      quota: 88.5,
      rate_limited_until: null,
      cooldown_until: null,
      error_count: 0,
      consecutive_errors: 0,
      last_used: 1700000000,
      usage: {
        groups: [
          {
            display_name: "Code 5hr session",
            buckets: [{ used_percent: 45.2, label: "5h window" }],
          },
          {
            display_name: "Weekly quota",
            buckets: [{ used_percent: 78.0, label: "7d window" }],
          },
        ],
      },
    },
    {
      id: "acc-claude-backup@example.com",
      provider: "claude",
      status: "active",
      quota: 40.0,
      rate_limited_until: null,
      cooldown_until: null,
      error_count: 0,
      consecutive_errors: 0,
      last_used: 1700000050,
      usage: {
        groups: [
          {
            display_name: "Sonnet 5hr pool",
            buckets: [{ used_percent: 25.0, label: "5h window" }],
          },
        ],
      },
    },
  ],
};

const longYamlPayload = Array.from(
  { length: 150 },
  (_, i) =>
    `stress_config_section_${i}:\n  account_token: "tok_unbroken_${unbrokenToken.slice(0, 180)}_${i}"\n  routing_metadata:\n    endpoint_url: "https://extreme-scale-cluster-gateway-node-${i}.${unbrokenToken.slice(0, 80)}.internal.net/v1/stream"\n    retry_limit: 10\n`,
).join("\n");

const setupMocks = async (page: Page) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-secret-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });

  await page.route("**/admin/stats", (route) => route.fulfill({ json: accountsPayload }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        files: [
          {
            name: "codex-runtime.json",
            path: "/auth/codex-runtime.json",
            type: "codex",
            email: "acc-codex-primary@example.com",
            disabled: false,
          },
        ],
      },
    }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        lines: [
          "2026-08-30T10:00:00Z [INFO] gateway listening on http://127.0.0.1:18801",
          "2026-08-30T10:00:01Z [INFO] overlay layer containment verified",
        ],
      },
    }),
  );
  await page.route(/\/v0\/management\/config\.yaml$/, (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      body: longYamlPayload,
      contentType: "application/yaml",
    });
  });
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
      const url = route.request().url();
      if (url.endsWith("proxy-url")) return route.fulfill({ json: { "proxy-url": "" } });
      if (url.endsWith("routing/strategy"))
        return route.fulfill({ json: { strategy: "round-robin" } });
      if (url.endsWith("request-retry")) return route.fulfill({ json: { "request-retry": 3 } });
      return route.fulfill({ json: { "logging-to-file": false } });
    },
  );
};

test.describe("Task 14 - OverlayLayer Containment and Evidence Capture", () => {
  test.beforeAll(async () => {
    await mkdir(task14Dir, { recursive: true });
    await mkdir(happyDir, { recursive: true });
  });

  test("desktop overlay containment: onboarding drawer, YAML drawer, context menu", async ({
    page,
  }) => {
    await setupMocks(page);
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html");

    // 1. Navigate to Accounts and scroll workspace
    await page.getByRole("button", { name: "Accounts" }).click();
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = 300;
    });

    // 2. Open Onboarding Drawer via Add account
    const addAccountBtn = page.getByRole("button", { name: "Add account" });
    await expect(addAccountBtn).toBeVisible();
    await addAccountBtn.click();

    // Verify OverlayLayer backdrop & drawer bounds
    const backdrop = page.locator(".layout-overlay-layer.drawer-backdrop");
    const onboardingDrawer = page.locator(".drawer.onboarding-drawer");
    await expect(backdrop).toBeVisible();
    await expect(onboardingDrawer).toBeVisible();

    const backdropBox = await backdrop.boundingBox();
    expect(backdropBox).not.toBeNull();
    expect(backdropBox?.x).toBe(0);
    expect(backdropBox?.y).toBe(0);
    expect(backdropBox?.width).toBeGreaterThanOrEqual(1000);
    expect(backdropBox?.height).toBe(720);

    const drawerBox = await onboardingDrawer.boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(drawerBox?.y).toBe(0);
    expect(drawerBox?.height).toBe(720);
    expect((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0)).toBeLessThanOrEqual(1100);

    // Search provider input focus reachability
    const searchInput = page.getByRole("textbox", { name: "Search providers" });
    await expect(searchInput).toBeVisible();
    await searchInput.focus();
    await expect(searchInput).toBeFocused();

    await page.screenshot({
      path: `${happyDir}/01-onboarding-drawer.png`,
      fullPage: false,
    });

    // Close onboarding drawer
    const closeOnboarding = page.getByRole("button", { name: "Close onboarding" });
    await expect(closeOnboarding).toBeVisible();
    await closeOnboarding.click();
    await expect(backdrop).toHaveCount(0);
    await expect(onboardingDrawer).toHaveCount(0);

    // 3. Open YAML Drawer from Settings
    await page.getByRole("button", { name: "Settings" }).click();
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main) main.scrollTop = 400;
    });

    const openYamlBtn = page.getByRole("button", { name: "Open YAML editor" });
    await expect(openYamlBtn).toBeVisible();
    await openYamlBtn.click();

    const yamlBackdrop = page.locator(".layout-overlay-layer.drawer-backdrop");
    const configDrawer = page.locator(".drawer.config-drawer");
    await expect(yamlBackdrop).toBeVisible();
    await expect(configDrawer).toBeVisible();

    const yamlBackdropBox = await yamlBackdrop.boundingBox();
    expect(yamlBackdropBox).not.toBeNull();
    expect(yamlBackdropBox?.x).toBe(0);
    expect(yamlBackdropBox?.y).toBe(0);
    expect(yamlBackdropBox?.height).toBe(720);

    const configBox = await configDrawer.boundingBox();
    expect(configBox).not.toBeNull();
    expect(configBox?.y).toBe(0);
    expect(configBox?.height).toBe(720);

    const yamlTextarea = page.getByRole("textbox", { name: "Raw configuration YAML" });
    await expect(yamlTextarea).toBeVisible();
    await yamlTextarea.focus();
    await expect(yamlTextarea).toBeFocused();

    await page.screenshot({
      path: `${happyDir}/02-config-yaml-drawer.png`,
      fullPage: false,
    });

    // Cancel / Close YAML drawer
    const cancelBtn = page.getByRole("button", { name: "Cancel" });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await expect(yamlBackdrop).toHaveCount(0);
    await expect(configDrawer).toHaveCount(0);

    // 4. Open Account Custom Context Menu
    await page.getByRole("button", { name: "Accounts" }).click();
    const targetAccountCard = page.locator(".account-card").first();
    await expect(targetAccountCard).toBeVisible();
    await targetAccountCard.click({ button: "right", position: { x: 80, y: 30 } });

    const contextMenu = page.locator(".context-menu");
    await expect(contextMenu).toBeVisible();

    const menuBox = await contextMenu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox?.x).toBeGreaterThanOrEqual(0);
    expect(menuBox?.y).toBeGreaterThanOrEqual(0);
    expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(1100);
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(720);

    const copyNameItem = page.getByRole("menuitem", { name: "Copy account name" });
    await expect(copyNameItem).toBeVisible();

    await page.screenshot({
      path: `${happyDir}/03-account-context-menu.png`,
      fullPage: false,
    });

    // 5. Dismiss context menu via Escape
    await page.keyboard.press("Escape");
    await expect(contextMenu).toHaveCount(0);

    await page.screenshot({
      path: `${happyDir}/05-overlay-closed-restored.png`,
      fullPage: false,
    });
  });

  test("mobile 390x844 responsive overlay stress: internal scrolling and containment", async ({
    page,
  }) => {
    await setupMocks(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html");

    // 1. Onboarding drawer under mobile viewport
    await page.getByRole("button", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Add account" }).click();

    const onboardingBackdrop = page.locator(".layout-overlay-layer.drawer-backdrop");
    const onboardingDrawer = page.locator(".drawer.onboarding-drawer");
    await expect(onboardingBackdrop).toBeVisible();
    await expect(onboardingDrawer).toBeVisible();

    // Mobile onboarding must scroll internally and keep no horizontal document overflow
    const mobileOnboardingGeometry = await page.evaluate(() => {
      const doc = document.documentElement;
      const drawer = document.querySelector(".drawer.onboarding-drawer");
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        drawerScrollHeight: drawer?.scrollHeight ?? 0,
        drawerClientHeight: drawer?.clientHeight ?? 0,
        drawerOverflowY: drawer ? window.getComputedStyle(drawer).overflowY : "",
      };
    });

    expect(mobileOnboardingGeometry.scrollWidth).toBe(mobileOnboardingGeometry.clientWidth);
    expect(["auto", "scroll"]).toContain(mobileOnboardingGeometry.drawerOverflowY);

    await page.getByRole("button", { name: "Close onboarding" }).click();
    await expect(onboardingDrawer).toHaveCount(0);

    // 2. YAML drawer under mobile viewport with 150 sections of unbroken tokens
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Open YAML editor" }).click();

    const configBackdrop = page.locator(".layout-overlay-layer.drawer-backdrop");
    const configDrawer = page.locator(".drawer.config-drawer");
    await expect(configBackdrop).toBeVisible();
    await expect(configDrawer).toBeVisible();

    const mobileConfigGeometry = await page.evaluate(() => {
      const doc = document.documentElement;
      const drawer = document.querySelector(".drawer.config-drawer");
      const textarea = drawer?.querySelector("textarea");
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        drawerScrollHeight: drawer?.scrollHeight ?? 0,
        drawerClientHeight: drawer?.clientHeight ?? 0,
        textareaScrollHeight: textarea?.scrollHeight ?? 0,
        textareaClientHeight: textarea?.clientHeight ?? 0,
      };
    });

    expect(mobileConfigGeometry.scrollWidth).toBe(mobileConfigGeometry.clientWidth);
    expect(mobileConfigGeometry.textareaScrollHeight).toBeGreaterThan(
      mobileConfigGeometry.textareaClientHeight,
    );

    // Close action is reachable and functional
    const closeConfigBtn = page.getByRole("button", { name: "Close configuration editor" });
    await expect(closeConfigBtn).toBeVisible();

    await page.screenshot({
      path: `${task14Dir}/overlays-stress.png`,
      fullPage: false,
    });

    await closeConfigBtn.click();
    await expect(configDrawer).toHaveCount(0);
  });
});
