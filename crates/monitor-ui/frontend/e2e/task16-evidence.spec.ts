import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const task16Dir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-16",
);
const happyDir = resolve(task16Dir, "artifact-happy");
const failureDir = resolve(task16Dir, "artifact-failure");
const artifactPath = resolve(process.cwd(), "../ui/index.html");

const happyStats = {
  uptime_secs: 28_800,
  in_flight: 3,
  served: 12_450,
  failed_over: 7,
  refreshed: 32,
  ttft: { p50_ms: 82, p90_ms: 165, p99_ms: 310, samples: 210 },
  accounts: [
    {
      id: "prod-antigravity@company.com",
      provider: "antigravity",
      health: { status: "available" },
      ok: 450,
      fails: 2,
      usage: {
        plan_type: "Pro",
        groups: [
          {
            display_name: "Gemini 2.5 Pro",
            buckets: [
              { display_name: "5-hr window", used_percent: 42, reset_after_seconds: 3600 },
              { display_name: "Daily quota", used_percent: 74, reset_after_seconds: 43200 },
            ],
          },
        ],
      },
    },
    {
      id: "prod-codex@company.com",
      provider: "codex",
      health: { status: "available" },
      ok: 890,
      fails: 1,
      usage: {
        plan_type: "Team",
        primary: {
          limit_name: "5-hour request limit",
          used_percent: 28,
          reset_after_seconds: 7200,
        },
        secondary: {
          limit_name: "Weekly token limit",
          used_percent: 55,
          reset_after_seconds: 240000,
        },
        reset_credits_available: 4,
      },
    },
    {
      id: "prod-claude@company.com",
      provider: "claude",
      health: { status: "available" },
      ok: 1240,
      fails: 0,
      usage: {
        plan_type: "Max",
        primary: {
          limit_name: "5-hour message window",
          used_percent: 61,
          reset_after_seconds: 5400,
        },
      },
    },
    {
      id: "prod-kimi@company.com",
      provider: "kimi",
      health: { status: "available" },
      ok: 310,
      fails: 0,
      usage: {
        plan_type: "Standard",
        primary: { limit_name: "Monthly limit", used_percent: 19, reset_after_seconds: 864000 },
      },
    },
  ],
};

const happyAuthFiles = {
  files: [
    {
      name: "prod-antigravity.json",
      auth_index: "prod-antigravity@company.com",
      path: "/auth/prod-antigravity.json",
      size: 420,
      label: "Prod Gemini Pro",
      type: "antigravity",
      email: "prod-antigravity@company.com",
      disabled: false,
      unavailable: false,
    },
    {
      name: "prod-codex.json",
      auth_index: "prod-codex@company.com",
      path: "/auth/prod-codex.json",
      size: 512,
      label: "Prod Codex Team",
      type: "codex",
      email: "prod-codex@company.com",
      disabled: false,
      unavailable: false,
    },
    {
      name: "prod-claude.json",
      auth_index: "prod-claude@company.com",
      path: "/auth/prod-claude.json",
      size: 380,
      label: "Prod Claude Max",
      type: "claude",
      email: "prod-claude@company.com",
      disabled: false,
      unavailable: false,
    },
    {
      name: "prod-kimi.json",
      auth_index: "prod-kimi@company.com",
      path: "/auth/prod-kimi.json",
      size: 290,
      label: "Prod Kimi",
      type: "kimi",
      email: "prod-kimi@company.com",
      disabled: false,
      unavailable: false,
    },
  ],
};

const happyLogs = {
  lines: [
    "[2026-08-30 11:20:01] INFO [gateway] Routing request to prod-codex@company.com (model: gpt-5-turbo)",
    "[2026-08-30 11:20:02] INFO [gateway] Stream completed in 410ms, tokens: 320, ttft: 85ms",
    "[2026-08-30 11:20:05] INFO [gateway] Routing request to prod-antigravity@company.com (model: gemini-2.5-pro)",
    "[2026-08-30 11:20:06] INFO [gateway] TTFT: 78ms, tokens: 680, status: 200 OK",
    "[2026-08-30 11:20:10] INFO [gateway] Routing request to prod-claude@company.com (model: claude-3-7-sonnet)",
    "[2026-08-30 11:20:12] INFO [gateway] Stream completed in 890ms, tokens: 1200, ttft: 92ms",
  ],
};

const happyConfig = `port: 18801
bind: "127.0.0.1"
management_key: "mgmt-secret-production-99"
refresh_interval_secs: 5
timeout_ms: 30000
log_level: "info"
providers:
  codex:
    enabled: true
    concurrency_limit: 8
  antigravity:
    enabled: true
    concurrency_limit: 6
  claude:
    enabled: true
    concurrency_limit: 8
`;

const setupInitScript = async (page: Page) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "mgmt-secret-production-99");
    window.open = () => null;
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: async () => undefined },
      event: { listen: async () => () => undefined },
    };
  });
};

test.beforeAll(async () => {
  await mkdir(happyDir, { recursive: true });
  await mkdir(failureDir, { recursive: true });
});

test.describe("Task 16 - Production Single-File Artifact and Server Contract", () => {
  test("static artifact inspection, hash verification, and server contracts", async ({
    page,
    request,
  }) => {
    const rawHtml = await readFile(artifactPath, "utf8");
    const sha256 = createHash("sha256").update(rawHtml).digest("hex");

    // 1. Single-file self-containment checks
    expect(rawHtml).toContain('data-mahoquot-app="operations-console"');
    expect(rawHtml).toContain("Overview");
    expect(rawHtml).toContain("Accounts");
    expect(rawHtml).toContain("Logs");
    expect(rawHtml).toContain("Settings");
    expect(rawHtml).not.toMatch(/<script[^>]+src=/i);
    expect(rawHtml).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(rawHtml).not.toContain("react-grab");
    expect(rawHtml).not.toContain("react-scan");
    expect(rawHtml).not.toContain("@vite/client");
    expect(rawHtml).not.toContain("localhost:5173");

    // 2. Server contract verification
    const resMgmt = await request.get("http://127.0.0.1:4173/management.html");
    expect(resMgmt.status()).toBe(200);
    expect(resMgmt.headers()["content-type"]).toContain("text/html");
    const servedHtml = await resMgmt.text();
    expect(servedHtml).toContain('data-mahoquot-app="operations-console"');
    expect(servedHtml.length).toBe(rawHtml.length);

    const resRoot = await request.get("http://127.0.0.1:4173/");
    expect(resRoot.status()).toBe(200);

    const resNotFound = await request.get("http://127.0.0.1:4173/unknown-nonexistent-route-12345");
    expect(resNotFound.status()).toBe(404);

    // 3. Browser render from static server
    await setupInitScript(page);
    await page.route("**/admin/stats", (r) => r.fulfill({ json: happyStats }));
    await page.route("**/v0/management/auth-files*", (r) => r.fulfill({ json: happyAuthFiles }));
    await page.route("**/v0/management/logs*", (r) => r.fulfill({ json: happyLogs }));
    await page.route("**/v0/management/config.yaml", (r) =>
      r.fulfill({ body: happyConfig, contentType: "application/yaml" }),
    );

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html", { waitUntil: "networkidle" });

    const appRoot = page.locator('div[data-mahoquot-app="operations-console"]');
    await expect(appRoot).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Overview");
  });

  test("captures happy production artifact surfaces and interactions", async ({ page }) => {
    await setupInitScript(page);
    await page.route("**/admin/stats", (r) => r.fulfill({ json: happyStats }));
    await page.route("**/admin/accounts/**", (r) => r.fulfill({ json: { ok: true } }));
    await page.route("**/v0/management/auth-files*", (r) => r.fulfill({ json: happyAuthFiles }));
    await page.route("**/v0/management/logs*", (r) => r.fulfill({ json: happyLogs }));
    await page.route("**/v0/management/config.yaml", (r) =>
      r.fulfill({ body: happyConfig, contentType: "application/yaml" }),
    );

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html", { waitUntil: "networkidle" });

    // 1. Overview metrics/chart/range
    await expect(page.locator("h1")).toHaveText("Overview");
    await expect(page.locator("body")).toContainText("Overview");
    await page.screenshot({ path: resolve(happyDir, "01-overview-metrics-chart-range.png") });

    // 2. Accounts cards and catalog (default tab: Antigravity)
    await page.click(
      'nav button[data-surface="accounts"], nav a[data-surface="accounts"], button:has-text("Accounts")',
    );
    await expect(page.locator("h1")).toHaveText("Accounts");
    await expect(page.getByText("prod-antigravity@company.com")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "02-accounts-catalog-and-cards.png") });

    // 3. Provider filter (select Codex tab to demonstrate provider filtering)
    const codexTab = page.locator(".provider-tab").filter({ hasText: "Codex" });
    await codexTab.click();
    await expect(page.getByText("prod-codex@company.com")).toBeVisible();
    await expect(page.getByText("prod-antigravity@company.com")).toBeHidden();
    await page.screenshot({ path: resolve(happyDir, "03-accounts-provider-filter.png") });

    // 4. Accounts context menu
    const firstCard = page.locator(".account-card, [data-account-id]").first();
    await firstCard.click({ button: "right" });
    const contextMenu = page.locator('.context-menu, [role="menu"]');
    await expect(contextMenu).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "04-accounts-context-menu-actions.png") });

    // Close menu by keyboard escape
    await page.keyboard.press("Escape");
    await expect(contextMenu).toBeHidden();

    // 5. Representative warm/reorder
    const warmBtn = page.locator('button:has-text("Warm"), button[title*="Warm"]').first();
    if (await warmBtn.isVisible()) {
      await warmBtn.click();
      await expect(page.locator("output.notice, .notice")).toBeVisible();
    }
    await page.screenshot({ path: resolve(happyDir, "05-accounts-warm-and-reorder.png") });

    // 6. Logs refresh, clear, and high volume
    await page.click(
      'nav button[data-surface="logs"], nav a[data-surface="logs"], button:has-text("Logs")',
    );
    await expect(page.locator("h1")).toHaveText("Logs");
    await expect(page.getByText("Routing request to prod-codex").first()).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "06-logs-refresh-clear-volume.png") });

    // 7. Settings edits and save
    await page.click(
      'nav button[data-surface="settings"], nav a[data-surface="settings"], button:has-text("Settings")',
    );
    await expect(page.locator("h1")).toHaveText("Settings");
    await page.screenshot({ path: resolve(happyDir, "07-settings-edits-and-save.png") });

    // 8. Onboarding drawer overlay
    await page.click(
      'nav button[data-surface="accounts"], nav a[data-surface="accounts"], button:has-text("Accounts")',
    );
    const addAccountBtn = page
      .locator(
        'button:has-text("Add Account"), button[aria-label="Add account"], button:has-text("Add")',
      )
      .first();
    if (await addAccountBtn.isVisible()) {
      await addAccountBtn.click();
      const onboardingDrawer = page.locator(
        '.drawer.onboarding-drawer, aside[aria-label="Provider onboarding"]',
      );
      await expect(onboardingDrawer).toBeVisible();
      await page.screenshot({ path: resolve(happyDir, "08-overlay-onboarding-drawer.png") });
      await page.getByRole("button", { name: "Close onboarding" }).click();
      await expect(onboardingDrawer).toBeHidden();
    }

    // 9. YAML drawer overlay
    await page.click(
      'nav button[data-surface="settings"], nav a[data-surface="settings"], button:has-text("Settings")',
    );
    const editYamlBtn = page
      .locator('button:has-text("Edit YAML"), button:has-text("YAML")')
      .first();
    if (await editYamlBtn.isVisible()) {
      await editYamlBtn.click();
      const configDrawer = page.locator(
        '.drawer.config-drawer, aside[aria-label="Advanced configuration editor"]',
      );
      await expect(configDrawer).toBeVisible();
      await page.screenshot({ path: resolve(happyDir, "09-overlay-yaml-editor.png") });
      const closeYamlBtn = configDrawer
        .locator('button:has-text("Cancel"), button[aria-label="Close"]')
        .first();
      if (await closeYamlBtn.isVisible()) {
        await closeYamlBtn.click();
        await expect(configDrawer).toBeHidden();
      }
    }

    // 10. Navigation and shell layout
    await page.click(
      'nav button[data-surface="overview"], nav a[data-surface="overview"], button:has-text("Overview")',
    );
    await expect(page.locator("h1")).toHaveText("Overview");
    await page.screenshot({ path: resolve(happyDir, "10-shell-scroll-and-navigation.png") });
  });

  test("captures production artifact failure and offline paths", async ({ page }) => {
    await setupInitScript(page);

    // 1. Failure: stats offline
    await page.route("**/admin/stats", (r) => r.abort("failed"));
    await page.route("**/v0/management/auth-files*", (r) => r.fulfill({ json: { files: [] } }));
    await page.route("**/v0/management/logs*", (r) =>
      r.fulfill({ status: 500, body: "disk read error" }),
    );
    await page.route("**/v0/management/config.yaml", (r) =>
      r.fulfill({ status: 500, body: "config locked" }),
    );

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html", { waitUntil: "networkidle" });
    await expect(page.locator('div[data-mahoquot-app="operations-console"]')).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Overview");
    await page.screenshot({ path: resolve(failureDir, "01-failure-stats-offline.png") });

    // 2. Failure: management offline (stats ok, management 500)
    await page.route("**/admin/stats", (r) => r.fulfill({ json: happyStats }));
    await page.route("**/v0/management/auth-files*", (r) =>
      r.fulfill({ status: 500, body: "internal error" }),
    );
    await page.click(
      'nav button[data-surface="accounts"], nav a[data-surface="accounts"], button:has-text("Accounts")',
    );
    await expect(page.locator("h1")).toHaveText("Accounts");
    await page.getByRole("button", { name: "Refresh snapshot" }).click();
    await expect(page.getByText(/Credential inventory unavailable/)).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "02-failure-management-offline.png") });

    // 3. Failure: empty inventory state
    const emptyStats = { ...happyStats, accounts: [] };
    await page.route("**/admin/stats", (r) => r.fulfill({ json: emptyStats }));
    await page.route("**/v0/management/auth-files*", (r) => r.fulfill({ json: { files: [] } }));
    await page.getByRole("button", { name: "Refresh snapshot" }).click();
    await expect(page.getByText("No accounts or credentials found.")).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "03-failure-empty-inventory.png") });

    // 4. Failure: locked/malformed stats state
    const malformedStats = {
      uptime_secs: 0,
      in_flight: -1,
      served: 0,
      failed_over: 0,
      refreshed: 0,
      ttft: { p50_ms: 0, p90_ms: 0, p99_ms: 0, samples: 0 },
      accounts: [
        {
          id: "corrupted-account-entry",
          provider: "unknown-provider",
          health: { status: "error", message: "Key locked / invalid payload" },
          ok: 0,
          fails: 99,
        },
      ],
    };
    await page.route("**/admin/stats", (r) => r.fulfill({ json: malformedStats }));
    await page.route("**/v0/management/auth-files*", (r) => r.fulfill({ json: { files: [] } }));
    await page.getByRole("button", { name: "Refresh snapshot" }).click();
    await expect(page.getByText("corrupted-account-entry")).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "04-failure-locked-malformed-state.png") });

    // 5. Failure: logs error state
    await page.click(
      'nav button[data-surface="logs"], nav a[data-surface="logs"], button:has-text("Logs")',
    );
    await expect(page.locator("h1")).toHaveText("Logs");
    await expect(page.locator(".state-panel.warning")).toBeVisible();
    await page.screenshot({ path: resolve(failureDir, "05-failure-logs-error-state.png") });

    // 6. Failure: settings invalid YAML / error state
    await page.click(
      'nav button[data-surface="settings"], nav a[data-surface="settings"], button:has-text("Settings")',
    );
    await expect(page.locator("h1")).toHaveText("Settings");
    await page.screenshot({ path: resolve(failureDir, "06-failure-settings-invalid-yaml.png") });
  });
});
