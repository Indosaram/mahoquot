import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const happyDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-11/accounts-happy",
);
const stressDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-11/accounts-stress",
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
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });
  await page.route("**/admin/stats", (route) => route.fulfill({ json: happyStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: happyCredentials }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: ["gateway ready"] } }),
  );
  await page.route(/\/v0\/management\/config\.yaml$/, (route) =>
    route.fulfill({
      body: "port: 18801\nrouting:\n  strategy: round-robin\n",
      contentType: "application/yaml",
    }),
  );
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => route.fulfill({ json: { status: "ok" } }),
  );
};

test.describe("Task 11 Evidence Capture", () => {
  test.beforeAll(async () => {
    await mkdir(happyDir, { recursive: true });
    await mkdir(stressDir, { recursive: true });
  });

  test("captures happy accounts scenarios across desktop and compact viewports", async ({ page }) => {
    await setupHappyMocks(page);

    // 1. Desktop 1440x900 full accounts view (antigravity selected by default)
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("http://127.0.0.1:4173/management.html?surface=accounts");
    await expect(page.locator(".accounts")).toBeVisible();
    await expect(page.getByText("Bob Gemini Pro")).toBeVisible();
    await expect(page.getByText("Gemini 2.5 Flash")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "accounts-desktop-1440x900-antigravity.png") });

    // 2. Select Codex provider tab with multiple quota windows and actions
    const codexTab = page.locator(".provider-tab").filter({ hasText: "Codex" });
    await codexTab.click();
    await expect(page.getByText("Alice Codex Team")).toBeVisible();
    await expect(page.getByText("5-hour request")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "accounts-desktop-1440x900-codex.png") });

    // 3. Medium 1100x720 view
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.screenshot({ path: resolve(happyDir, "accounts-desktop-1100x720.png") });

    // 4. Select Claude provider tab
    const claudeTab = page.locator(".provider-tab").filter({ hasText: "Claude" });
    await claudeTab.click();
    await expect(page.getByText("Carol Claude Max")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "accounts-provider-filter-claude.png") });

    // Switch back to Codex for action verification
    await codexTab.click();
    await expect(page.getByText("Alice Codex Team")).toBeVisible();

    // 5. Remove confirmation prompt state
    const removeBtn = page.getByRole("button", { name: /Remove Alice Codex Team/i });
    await removeBtn.click();
    await expect(page.getByRole("button", { name: /Confirm removing/i })).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "accounts-remove-confirmation.png") });

    // Cancel remove
    await page.getByRole("button", { name: /Cancel removing/i }).click();

    // 6. Onboarding drawer with brand logos & search
    await page.getByRole("button", { name: /Add account/i }).click();
    await expect(page.locator(".drawer.onboarding-drawer")).toBeVisible();
    await page.screenshot({ path: resolve(happyDir, "accounts-onboarding-drawer.png") });

    // Close onboarding drawer
    await page.getByRole("button", { name: "Close onboarding" }).click();
  });

  test("captures stress, failure, and edge-case account scenarios", async ({ page }) => {
    const stressStats = {
      uptime_secs: 100,
      in_flight: 0,
      served: 0,
      failed_over: 0,
      refreshed: 0,
      ttft: { p50_ms: 0, p90_ms: 0, p99_ms: 0, samples: 0 },
      accounts: [
        {
          id: "extremely-long-unbroken-user-account-identifier-that-could-overflow-the-card-container-boundary@domain-with-very-long-subdomain.enterprise.company.com",
          provider: "codex",
          health: { status: "available" },
          ok: 1,
          fails: 0,
          usage: null,
        },
        {
          id: "failed-auth@domain.com",
          provider: "codex",
          health: { status: "error" },
          ok: 0,
          fails: 12,
          last_error: { unix_ms: Date.now(), status: 401, message: "OAuth token revoked or expired by upstream identity provider" },
        },
      ],
    };

    const stressCredentials = {
      files: [
        {
          name: "extremely-long.json",
          auth_index: "extremely-long",
          path: "/auth/extremely-long.json",
          size: 512,
          label: "extremely-long-unbroken-user-account-identifier-that-could-overflow-the-card-container-boundary@domain-with-very-long-subdomain.enterprise.company.com",
          type: "codex",
          email: "extremely-long-unbroken-user-account-identifier-that-could-overflow-the-card-container-boundary@domain-with-very-long-subdomain.enterprise.company.com",
          disabled: false,
          unavailable: false,
          runtime_only: false,
        },
        {
          name: "failed-auth.json",
          auth_index: "failed-auth",
          path: "/auth/failed-auth.json",
          size: 256,
          label: "Failed Auth Account",
          type: "codex",
          email: "failed-auth@domain.com",
          disabled: false,
          unavailable: false,
          runtime_only: false,
        },
        {
          name: "credential-only-unloaded.json",
          auth_index: "unloaded@test.com",
          path: "/auth/credential-only-unloaded.json",
          size: 150,
          label: "Unloaded Credential",
          type: "zcode",
          email: "unloaded@test.com",
          disabled: true,
          unavailable: true,
          runtime_only: false,
        },
      ],
    };

    await page.addInitScript(() => {
      localStorage.setItem("mahoquot.base", "");
      localStorage.setItem("mahoquot.key", "relay-test-key");
      localStorage.setItem("mahoquot.mgmt", "management-test-key");
      window.open = () => null;
    });
    await page.route("**/admin/stats", (route) => route.fulfill({ json: stressStats }));
    await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
    await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
      route.fulfill({ json: stressCredentials }),
    );
    await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { lines: [] } }),
    );
    await page.route(/\/v0\/management\/config\.yaml$/, (route) =>
      route.fulfill({
        body: "port: 18801\nrouting:\n  strategy: round-robin\n",
        contentType: "application/yaml",
      }),
    );
    await page.route(
      /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
      (route) => route.fulfill({ json: { status: "ok" } }),
    );

    // 1. Desktop long unbroken strings and error states
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("http://127.0.0.1:4173/management.html?surface=accounts");
    await expect(page.locator(".accounts")).toBeVisible();
    await expect(page.getByText(/OAuth token revoked/)).toBeVisible();
    await page.screenshot({ path: resolve(stressDir, "accounts-stress-errors-longtext-1440x900.png") });

    // 2. Mobile 390x844 responsive stress
    await page.setViewportSize({ width: 390, height: 844 });
    const isOverflowing = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(isOverflowing).toBe(false);
    await page.screenshot({ path: resolve(stressDir, "accounts-stress-mobile-390x844.png") });

    // 3. Credential-only state on Zcode tab
    const zcodeTab = page.locator(".provider-tab").filter({ hasText: "Zcode" });
    await zcodeTab.click();
    await expect(page.getByText(/could not load it into the runtime pool/)).toBeVisible();
    await page.screenshot({ path: resolve(stressDir, "accounts-credential-only-zcode.png") });
  });

  test("captures completely empty inventory state", async ({ page }) => {
    const emptyStats = {
      uptime_secs: 0,
      in_flight: 0,
      served: 0,
      failed_over: 0,
      refreshed: 0,
      ttft: { p50_ms: 0, p90_ms: 0, p99_ms: 0, samples: 0 },
      accounts: [],
    };
    const emptyCredentials = { files: [] };

    await page.addInitScript(() => {
      localStorage.setItem("mahoquot.base", "");
      localStorage.setItem("mahoquot.key", "relay-test-key");
      localStorage.setItem("mahoquot.mgmt", "management-test-key");
      window.open = () => null;
    });
    await page.route("**/admin/stats", (route) => route.fulfill({ json: emptyStats }));
    await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
      route.fulfill({ json: emptyCredentials }),
    );
    await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { lines: [] } }),
    );
    await page.route(/\/v0\/management\/config\.yaml$/, (route) =>
      route.fulfill({
        body: "port: 18801\nrouting:\n  strategy: round-robin\n",
        contentType: "application/yaml",
      }),
    );
    await page.route(
      /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
      (route) => route.fulfill({ json: { status: "ok" } }),
    );

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("http://127.0.0.1:4173/management.html?surface=accounts");
    await expect(page.getByText("No accounts or credentials found.")).toBeVisible();
    await page.screenshot({ path: resolve(stressDir, "accounts-empty-inventory-1100x720.png") });
  });
});
