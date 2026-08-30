import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const happyDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-13/reassembly-happy",
);
const failureDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-13/reassembly-failure",
);

const happyStats = {
  uptime_secs: 14_250,
  in_flight: 2,
  served: 4_892,
  failed_over: 18,
  refreshed: 45,
  ttft: { p50_ms: 95, p90_ms: 210, p99_ms: 430, samples: 140 },
  accounts: [
    {
      id: "bob.antigravity@studio.dev",
      provider: "antigravity",
      health: { status: "available" },
      ok: 180,
      fails: 3,
      usage: {
        plan_type: "Pro",
        groups: [
          {
            display_name: "Gemini 2.5 Flash",
            buckets: [{ display_name: "Minute Window", used_percent: 15, reset_after_seconds: 45 }],
          },
          {
            display_name: "Gemini 2.5 Pro",
            buckets: [{ display_name: "Daily Quota", used_percent: 82, reset_after_seconds: 28000 }],
          },
        ],
      },
    },
    {
      id: "alice@company.com",
      provider: "codex",
      health: { status: "available" },
      ok: 240,
      fails: 1,
      usage: {
        plan_type: "Team Tier",
        primary: { limit_name: "5-hour request limit", used_percent: 32, reset_after_seconds: 4200 },
        secondary: { limit_name: "Weekly token limit", used_percent: 68, reset_after_seconds: 180000 },
        reset_credits_available: 2,
      },
    },
    {
      id: "carol@claude.ai",
      provider: "claude",
      health: { status: "available" },
      ok: 520,
      fails: 0,
      usage: {
        plan_type: "Max",
        primary: { limit_name: "5-hour message window", used_percent: 45, reset_after_seconds: 7200 },
      },
    },
  ],
};

const happyCredentials = {
  files: [
    {
      name: "bob-antigravity.json",
      auth_index: "bob.antigravity@studio.dev",
      path: "/auth/bob-antigravity.json",
      size: 310,
      label: "Bob Gemini Pro",
      type: "antigravity",
      email: "bob.antigravity@studio.dev",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
    {
      name: "alice-codex.json",
      auth_index: "alice@company.com",
      path: "/auth/alice-codex.json",
      size: 240,
      label: "Alice Codex Team",
      type: "codex",
      email: "alice@company.com",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
    {
      name: "carol-claude.json",
      auth_index: "carol@claude.ai",
      path: "/auth/carol-claude.json",
      size: 290,
      label: "Carol Claude Max",
      type: "claude",
      email: "carol@claude.ai",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
  ],
};

const setupHappyMocks = async (page: Page) => {
  await page.addInitScript(() => {
    const handlers = new Map<string, Set<(message: { payload: unknown }) => void>>();
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-secret-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-secret-test-key");
    window.open = () => null;
    Object.assign(window, {
      __TAURI__: {
        core: { invoke: async () => undefined },
        event: {
          listen: async (event: string, handler: (message: { payload: unknown }) => void) => {
            const listeners = handlers.get(event) ?? new Set();
            listeners.add(handler);
            handlers.set(event, listeners);
            return () => listeners.delete(handler);
          },
        },
      },
      __emitNotchEvent: (event: string, payload: unknown) => {
        for (const handler of handlers.get(event) ?? []) handler({ payload });
      },
    });
  });

  await page.route("**/admin/stats", (route) => route.fulfill({ json: happyStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true } });
    if (route.request().method() === "DELETE") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: happyCredentials });
  });
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        lines: [
          "2026-08-30T10:00:00Z [INFO] mahoquot gateway listening on http://127.0.0.1:18801",
          "2026-08-30T10:00:01Z [INFO] pool initialized with 3 providers and 3 active accounts",
          "2026-08-30T10:00:02Z [INFO] cross-surface telemetry aggregation initialized",
          "2026-08-30T10:00:05Z [INFO] warmup dispatch complete for all available accounts",
          "2026-08-30T10:00:10Z [INFO] routing strategy: round-robin, max retries: 3",
        ],
      },
    }),
  );
  await page.route(/\/v0\/management\/config\.yaml$/, (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      body: "port: 18801\nrouting:\n  strategy: round-robin\nretries: 3\ntelemetry: true\n",
      contentType: "application/yaml",
    });
  });
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
      if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true } });
      const url = route.request().url();
      if (url.endsWith("proxy-url")) return route.fulfill({ json: { "proxy-url": "" } });
      if (url.endsWith("routing/strategy")) return route.fulfill({ json: { strategy: "round-robin" } });
      if (url.endsWith("request-retry")) return route.fulfill({ json: { "request-retry": 3 } });
      return route.fulfill({ json: { "logging-to-file": false } });
    },
  );
};

const emitNotchEvent = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ({ event, payload }) =>
      (
        window as unknown as {
          __emitNotchEvent: (event: string, payload: unknown) => void;
        }
      ).__emitNotchEvent?.(event, payload),
    { event, payload },
  );

test.describe("Task 13 Evidence Capture - Reassembly & State Ownership", () => {
  test.beforeAll(async () => {
    await mkdir(happyDir, { recursive: true });
    await mkdir(failureDir, { recursive: true });
  });

  test("captures comprehensive happy narrative across all surfaces and interactions", async ({
    page,
  }) => {
    await setupHappyMocks(page);

    // 1. Desktop 1100x720 Overview surface
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=overview");
    await expect(page.locator(".content.overview")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Telemetry range" })).toBeVisible();
    await expect(page.getByText("4.9K")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "01-overview-desktop-1100x720.png") });

    // 2. Mobile 390x844 Overview surface
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html?surface=overview");
    await expect(page.locator(".content.overview")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "02-overview-mobile-390x844.png") });

    // 3. Desktop 1100x720 Accounts surface
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=accounts");
    await expect(page.locator(".content.accounts")).toBeVisible();
    await expect(page.getByText("Bob Gemini Pro")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "03-accounts-desktop-1100x720.png") });

    // 4. Mobile 390x844 Accounts surface
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html?surface=accounts");
    await expect(page.locator(".content.accounts")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "04-accounts-mobile-390x844.png") });

    // 5. Switch to Codex tab and perform Account Warm Action Mutation
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=accounts");
    const codexTab = page.locator(".provider-tab").filter({ hasText: "Codex" });
    await codexTab.click();
    await expect(page.getByText("Alice Codex Team")).toBeVisible();
    const warmButton = page.getByRole("button", { name: "Warm up" }).first();
    await warmButton.click();
    await expect(page.getByRole("status")).toHaveText("Warm-up requested — active now.");
    await page.screenshot({ path: resolve(happyDir, "05-accounts-warmed-action.png") });

    // 6. Account Reorder via Keyboard Handle
    const reorderHandle = page.getByRole("button", { name: "Reorder Alice Codex Team" });
    await reorderHandle.focus();
    await page.keyboard.press("ArrowDown");
    await page.screenshot({ path: resolve(happyDir, "06-accounts-reordered.png") });

    // 7. Desktop 1100x720 Logs surface
    await page.goto("/management.html?surface=logs");
    await expect(page.locator(".logs-surface")).toBeVisible();
    await expect(page.getByText("mahoquot gateway listening on http://127.0.0.1:18801")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "07-logs-desktop-1100x720.png") });

    // 8. Mobile 390x844 Logs surface
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html?surface=logs");
    await expect(page.locator(".logs-surface")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "08-logs-mobile-390x844.png") });

    // 9. Desktop 1100x720 Settings surface
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=settings");
    await expect(page.locator(".content.settings")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "09-settings-desktop-1100x720.png") });

    // 10. Mobile 390x844 Settings surface
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html?surface=settings");
    await expect(page.locator(".content.settings")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "10-settings-mobile-390x844.png") });

    // 11. Settings Mutation and Save
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=settings");
    await page.getByRole("button", { name: "Save & reconnect" }).click();
    await expect(page.getByRole("status")).toHaveText("Connection saved — active now for this console.");
    await page.screenshot({ path: resolve(happyDir, "11-settings-saved-feedback.png") });

    // 12. Onboarding Drawer Open
    await page.goto("/management.html?surface=accounts");
    await page.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("complementary", { name: "Provider onboarding" })).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "12-onboarding-drawer-open.png") });
    await page.getByRole("button", { name: "Close onboarding" }).click();

    // 13. Config YAML Drawer Open
    await page.goto("/management.html?surface=settings");
    await page.getByRole("button", { name: "Open YAML editor" }).click();
    await expect(page.getByRole("complementary", { name: "Advanced configuration editor" })).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "13-config-yaml-drawer-open.png") });
    await page.getByRole("button", { name: "Close configuration editor" }).click();

    // 14. Context Menu Open
    await page.goto("/management.html?surface=accounts");
    const accountCard = page.locator(".account-card").first();
    await accountCard.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Copy account name" })).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "14-context-menu-open.png") });

    // 15. Notch Expanded & Tooltip
    await page.goto("/management.html?surface=notch");
    await expect(page.locator(".notch-shell")).toBeVisible();
    await emitNotchEvent(page, "notch-hover", true);
    const antigravityRing = page.locator('[data-testid="notch-ring-antigravity"]');
    await expect(antigravityRing).toBeVisible();
    await antigravityRing.hover();
    await expect(page.locator('[data-testid="notch-tooltip-antigravity"]')).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "15-notch-expanded-tooltip.png") });
  });

  test("captures failure, offline, and isolation scenarios", async ({ page }) => {
    await page.addInitScript(() => {
      const handlers = new Map<string, Set<(message: { payload: unknown }) => void>>();
      localStorage.setItem("mahoquot.base", "");
      localStorage.setItem("mahoquot.key", "relay-secret-test-key");
      localStorage.setItem("mahoquot.mgmt", "management-secret-test-key");
      window.open = () => null;
      Object.assign(window, {
        __TAURI__: {
          core: { invoke: async () => undefined },
          event: {
            listen: async (event: string, handler: (message: { payload: unknown }) => void) => {
              const listeners = handlers.get(event) ?? new Set();
              listeners.add(handler);
              handlers.set(event, listeners);
              return () => listeners.delete(handler);
            },
          },
        },
        __emitNotchEvent: (event: string, payload: unknown) => {
          for (const handler of handlers.get(event) ?? []) handler({ payload });
        },
      });
    });

    // 1. Offline Overview surface keeps nav and shell intact
    await page.route("**/admin/stats", (route) => route.abort("connectionrefused"));
    await page.route("**/admin/accounts/**", (route) => route.abort("connectionrefused"));
    await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
      route.abort("connectionrefused"),
    );
    await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
      route.abort("connectionrefused"),
    );
    await page.route(/\/v0\/management\/config\.yaml$/, (route) =>
      route.abort("connectionrefused"),
    );

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html?surface=overview");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".content.overview")).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "01-offline-overview-nav-intact.png") });

    // 2. Offline Accounts surface displays empty state without crashing
    await page.goto("/management.html?surface=accounts");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.getByText("No accounts or credentials found.")).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "02-offline-accounts-intact.png") });

    // 3. Locked / Error Logs surface displays warning state panel
    await page.route("**/admin/stats", (route) => route.fulfill({ json: happyStats }));
    await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
      route.fulfill({ status: 401, body: "locked" }),
    );
    await page.goto("/management.html?surface=logs");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".logs-surface")).toBeVisible();
    await expect(page.locator(".state-panel.warning")).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "03-offline-logs-state-panel.png") });

    // 4. Offline Settings surface keeps reconnect fields and start gateway button
    await page.route("**/admin/stats", (route) => route.abort("connectionrefused"));
    await page.goto("/management.html?surface=settings");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save & reconnect" })).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "04-offline-settings-reconnect-preserved.png") });

    // 5. Offline Notch surface shows clean empty ring without loading app shell
    await page.goto("/management.html?surface=notch");
    await expect(page.locator(".notch-shell")).toBeVisible();
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await emitNotchEvent(page, "notch-hover", true);
    const emptyRing = page.locator('[data-testid="notch-empty-ring"]');
    await expect(emptyRing).toBeVisible();
    await emptyRing.hover();
    await expect(page.locator('[data-testid="notch-tooltip-empty"]')).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "05-offline-notch-empty-isolated.png") });
  });
});
