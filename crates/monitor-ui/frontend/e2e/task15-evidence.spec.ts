import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const task15Dir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-15",
);
const responsiveDir = resolve(task15Dir, "responsive-matrix");
const stressDir = resolve(task15Dir, "stress-matrix");

const viewports = [
  { name: "390", width: 390, height: 844 },
  { name: "760", width: 760, height: 844 },
  { name: "900", width: 900, height: 720 },
  { name: "1100", width: 1100, height: 720 },
  { name: "1440", width: 1440, height: 900 },
] as const;

const surfaces = ["overview", "accounts", "logs", "settings"] as const;

const unbroken256 =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFjY3Qta2V5LTk5OTk5OTk5OTk5OSJ9.eyJpc3MiOiJtYWhvcXVvdC1hdXRoLWRhZW1vbiIsImF1ZCI6ImFwaS5tYWhvcXVvdC5pbyIsInN1YiI6ImFjY3RfOTk5OTk5OTk5OTk5IiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE4MDAwMDAwMDB9.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_EXTREME_STRESS_TOKEN_PADDING_TO_EXCEED_256_BYTES_SAFE_WRAP_BOUNDARY_1234567890";

const standardStats = {
  uptime_secs: 42_500,
  in_flight: 4,
  served: 18_420,
  failed_over: 7,
  refreshed: 32,
  ttft: { p50_ms: 95, p90_ms: 210, p99_ms: 430, samples: 120 },
  accounts: [
    {
      id: "acc-codex-primary@enterprise-cluster-alpha.internal.net",
      provider: "codex",
      status: "active",
      quota: 82.5,
      rate_limited_until: null,
      cooldown_until: null,
      error_count: 0,
      consecutive_errors: 0,
      last_used: 1700000000,
      usage: {
        plan_type: "team",
        groups: [
          {
            display_name: "Code Completion 5hr",
            buckets: [{ used_percent: 62.4, label: "5h window", reset_after_seconds: 7200 }],
          },
          {
            display_name: "Weekly Account Quota",
            buckets: [{ used_percent: 81.0, label: "7d window", reset_after_seconds: 184000 }],
          },
        ],
      },
    },
    {
      id: "acc-claude-backup@organization-backup-failover.corp.internal",
      provider: "claude",
      status: "active",
      quota: 35.0,
      rate_limited_until: null,
      cooldown_until: null,
      error_count: 0,
      consecutive_errors: 0,
      last_used: 1700000100,
      usage: {
        plan_type: "pro",
        groups: [
          {
            display_name: "Sonnet 3.5 Operational Bucket",
            buckets: [{ used_percent: 35.0, label: "5h window", reset_after_seconds: 3600 }],
          },
        ],
      },
    },
    {
      id: "acc-antigravity-pool@gemini-ultra-resilience.system.internal",
      provider: "antigravity",
      status: "active",
      quota: 12.0,
      rate_limited_until: null,
      cooldown_until: null,
      error_count: 0,
      consecutive_errors: 0,
      last_used: 1700000200,
      usage: {
        groups: [
          {
            display_name: "Gemini 2.0 Flash Quota",
            buckets: [{ used_percent: 12.0, label: "1d window", reset_after_seconds: 43200 }],
          },
        ],
      },
    },
  ],
};

const standardCredentials = {
  files: [
    {
      name: "acc-codex-primary.json",
      path: "/auth/acc-codex-primary.json",
      type: "codex",
      email: "acc-codex-primary@enterprise-cluster-alpha.internal.net",
      disabled: false,
    },
    {
      name: "acc-claude-backup.json",
      path: "/auth/acc-claude-backup.json",
      type: "claude",
      email: "acc-claude-backup@organization-backup-failover.corp.internal",
      disabled: false,
    },
    {
      name: "acc-antigravity-pool.json",
      path: "/auth/acc-antigravity-pool.json",
      type: "antigravity",
      email: "acc-antigravity-pool@gemini-ultra-resilience.system.internal",
      disabled: false,
    },
  ],
};

const standardLogs = [
  "[2026-08-30T10:00:00.120Z] [INFO] mahoquot gateway daemon listening on 127.0.0.1:18801",
  "[2026-08-30T10:00:01.002Z] [INFO] loaded 3 credential files from /auth directory",
  "[2026-08-30T10:00:02.450Z] [INFO] warm-up probe dispatched for provider codex -> 200 OK (84ms)",
  "[2026-08-30T10:00:03.110Z] [INFO] routing strategy active: round-robin with failover threshold 3",
  "[2026-08-30T10:00:15.890Z] [INFO] telemetry snapshot synced: 18420 served, 4 in flight",
];

const setupMockGateway = async (
  page: Page,
  options?: {
    stats?: any;
    credentials?: any;
    logs?: string[];
    configYaml?: string;
    locked?: boolean;
  },
) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-secret-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });

  await page.route("**/admin/stats", (route) =>
    route.fulfill({ json: options?.stats ?? standardStats }),
  );
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) => {
    if (options?.locked) return route.fulfill({ status: 401, body: "locked" });
    if (route.request().method() === "DELETE") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: options?.credentials ?? standardCredentials });
  });
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) => {
    if (options?.locked) return route.fulfill({ status: 401, body: "locked" });
    return route.fulfill({ json: { lines: options?.logs ?? standardLogs } });
  });
  await page.route(/\/v0\/management\/config\.yaml$/, (route) => {
    if (options?.locked) return route.fulfill({ status: 401, body: "locked" });
    if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      body:
        options?.configYaml ??
        "port: 18801\nrouting:\n  strategy: round-robin\n  retry: 3\nlogging:\n  to_file: true\n",
      contentType: "application/yaml",
    });
  });
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
      if (options?.locked) return route.fulfill({ status: 401, body: "locked" });
      if (route.request().method() === "PUT") return route.fulfill({ json: { status: "ok" } });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("proxy-url")) return route.fulfill({ json: { "proxy-url": "" } });
      if (path.endsWith("routing/strategy")) {
        return route.fulfill({ json: { strategy: "round-robin" } });
      }
      if (path.endsWith("request-retry")) {
        return route.fulfill({ json: { "request-retry": 3 } });
      }
      return route.fulfill({ json: { "logging-to-file": true } });
    },
  );
};

test.describe("Task 15 - Responsive Matrix (20 captures minimum across 4 surfaces x 5 viewports)", () => {
  const recordedMeasurements: Record<string, any> = {};

  test.beforeAll(async () => {
    await mkdir(responsiveDir, { recursive: true });
    await mkdir(stressDir, { recursive: true });
  });

  test.afterAll(async () => {
    await writeFile(
      resolve(task15Dir, "measurements.json"),
      JSON.stringify(recordedMeasurements, null, 2),
      "utf8",
    );
  });

  for (const vp of viewports) {
    for (const surface of surfaces) {
      test(`captures ${surface} surface at ${vp.width}x${vp.height} (${vp.name}) with zero horizontal overflow`, async ({
        page,
      }) => {
        await setupMockGateway(page);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto("/management.html");

        // Navigate to the target surface
        if (vp.width <= 760) {
          await page.getByLabel("Mobile navigation").getByText(surface, { exact: true }).click();
        } else {
          await page.getByLabel("Primary navigation").getByText(surface, { exact: false }).click();
        }

        // Wait for surface heading/content to render
        await expect(page.locator("h1")).toContainText(
          surface.charAt(0).toUpperCase() + surface.slice(1),
        );

        // Measure document overflow and scroll ownership
        const metrics = await page.evaluate((surf) => {
          const doc = document.documentElement;
          const main = document.querySelector("main");
          const mainStyle = main ? window.getComputedStyle(main) : null;
          const pre = document.querySelector(".logs-surface pre");
          const preStyle = pre ? window.getComputedStyle(pre) : null;

          return {
            surface: surf,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            documentScrollWidth: doc.scrollWidth,
            documentClientWidth: doc.clientWidth,
            horizontalOverflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
            mainScrollOwner: {
              overflowY: mainStyle?.overflowY,
              minHeight: mainStyle?.minHeight,
              minWidth: mainStyle?.minWidth,
              scrollHeight: main?.scrollHeight,
              clientHeight: main?.clientHeight,
            },
            logsInnerScrollOwner:
              surf === "logs" && pre
                ? {
                    overflowY: preStyle?.overflowY,
                    overflowX: preStyle?.overflowX,
                    scrollHeight: pre.scrollHeight,
                    clientHeight: pre.clientHeight,
                  }
                : null,
          };
        }, surface);

        // Assert 0 horizontal overflow
        expect(
          metrics.horizontalOverflow,
          `Zero horizontal document overflow on ${surface} at ${vp.width}x${vp.height}`,
        ).toBe(0);

        // Assert main is the vertical scroll owner
        expect(metrics.mainScrollOwner.overflowY).toBe("auto");

        const shotPath = resolve(responsiveDir, `${surface}-${vp.name}.png`);
        await page.screenshot({ path: shotPath, fullPage: false });

        recordedMeasurements[`responsive_${surface}_${vp.name}`] = metrics;
      });
    }
  }
});

test.describe("Task 15 - Content Stress Matrix", () => {
  const stressMeasurements: Record<string, any> = {};

  test.afterAll(async () => {
    const existingPath = resolve(task15Dir, "measurements.json");
    let prev = {};
    try {
      const content = await import(existingPath, { with: { type: "json" } });
      prev = content.default;
    } catch {
      // ignore
    }
    await writeFile(
      resolve(task15Dir, "measurements.json"),
      JSON.stringify({ ...prev, ...stressMeasurements }, null, 2),
      "utf8",
    );
  });

  test("Stress 1: Empty state across Overview, Accounts, and Logs", async ({ page }) => {
    const emptyStats = {
      uptime_secs: 100,
      in_flight: 0,
      served: 0,
      failed_over: 0,
      refreshed: 0,
      ttft: null,
      accounts: [],
    };
    const emptyCreds = { files: [] };
    const emptyLogs: string[] = [];

    await setupMockGateway(page, {
      stats: emptyStats,
      credentials: emptyCreds,
      logs: emptyLogs,
    });

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html");

    // Overview empty
    await expect(page.getByText("No requests yet")).toBeVisible();
    await page.screenshot({
      path: resolve(stressDir, "empty-state-overview.png"),
      fullPage: false,
    });

    // Accounts empty
    await page.getByLabel("Primary navigation").getByText("Accounts").click();
    await expect(page.getByText("No accounts or credentials found.")).toBeVisible();
    await page.screenshot({
      path: resolve(stressDir, "empty-state-accounts.png"),
      fullPage: false,
    });

    // Logs empty
    await page.getByLabel("Primary navigation").getByText("Logs").click();
    await expect(page.getByText("No log lines returned.")).toBeVisible();
    await page.screenshot({
      path: resolve(stressDir, "empty-state-logs.png"),
      fullPage: false,
    });

    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    stressMeasurements["stress_empty_states"] = m;
  });

  test("Stress 2: 40-character long labels and emails on Accounts and Settings", async ({
    page,
  }) => {
    const longLabelStats = {
      uptime_secs: 10_000,
      in_flight: 1,
      served: 500,
      failed_over: 0,
      refreshed: 1,
      ttft: { p50_ms: 100, p90_ms: 200, p99_ms: 300, samples: 10 },
      accounts: [
        {
          id: "extremely-long-enterprise-account-label-testing-containment-bounds-40chars@example.com",
          provider: "codex",
          status: "active",
          quota: 75.0,
          rate_limited_until: null,
          cooldown_until: null,
          error_count: 0,
          consecutive_errors: 0,
          last_used: 1700000000,
          usage: {
            groups: [
              {
                display_name: "Extended Custom Organizational Quota Tier Alpha",
                buckets: [{ used_percent: 75.0, label: "5h window" }],
              },
            ],
          },
        },
      ],
    };
    const longCreds = {
      files: [
        {
          name: "extremely-long-enterprise-account-label-testing-containment-bounds-40chars.json",
          path: "/auth/long.json",
          type: "codex",
          email:
            "extremely-long-enterprise-account-label-testing-containment-bounds-40chars@example.com",
          disabled: false,
        },
      ],
    };

    await setupMockGateway(page, {
      stats: longLabelStats,
      credentials: longCreds,
    });

    await page.setViewportSize({ width: 760, height: 844 });
    await page.goto("/management.html");

    // Accounts
    await page.getByLabel("Mobile navigation").getByText("accounts").click();
    await expect(page.locator(".account-card")).toBeVisible();
    await page.screenshot({
      path: resolve(stressDir, "long-labels-accounts.png"),
      fullPage: false,
    });

    // Settings
    await page.getByLabel("Mobile navigation").getByText("settings").click();
    await expect(page.locator(".settings-card").first()).toBeVisible();
    await page.screenshot({
      path: resolve(stressDir, "long-labels-settings.png"),
      fullPage: false,
    });

    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    stressMeasurements["stress_long_labels"] = m;
  });

  test("Stress 3: 256-character unbroken tokens and JWT credentials", async ({ page }) => {
    const tokenStats = {
      uptime_secs: 20_000,
      in_flight: 2,
      served: 1_000,
      failed_over: 0,
      refreshed: 2,
      ttft: { p50_ms: 100, p90_ms: 200, p99_ms: 300, samples: 20 },
      accounts: [
        {
          id: `unbroken_token_${unbroken256}`,
          provider: "claude",
          status: "active",
          quota: 50.0,
          rate_limited_until: null,
          cooldown_until: null,
          error_count: 0,
          consecutive_errors: 0,
          last_used: 1700000000,
          usage: {
            groups: [
              {
                display_name: `Group_${unbroken256.slice(0, 50)}`,
                buckets: [{ used_percent: 50.0, label: unbroken256.slice(0, 30) }],
              },
            ],
          },
        },
      ],
    };

    await setupMockGateway(page, {
      stats: tokenStats,
      credentials: {
        files: [
          {
            name: `file_${unbroken256.slice(0, 60)}.json`,
            path: `/auth/file_${unbroken256.slice(0, 60)}.json`,
            type: "claude",
            email: `email_${unbroken256.slice(0, 50)}@example.com`,
            disabled: false,
          },
        ],
      },
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html");

    await page.getByLabel("Mobile navigation").getByText("accounts").click();
    await expect(page.locator(".account-card")).toBeVisible();

    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      accountCardWidth: document.querySelector(".account-card")?.getBoundingClientRect().width,
    }));

    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    await page.screenshot({
      path: resolve(stressDir, "unbroken-tokens-256char.png"),
      fullPage: false,
    });
    stressMeasurements["stress_unbroken_tokens_256"] = m;
  });

  test("Stress 4: Many accounts and multiple quota rows per card", async ({ page }) => {
    const manyAccounts = Array.from({ length: 12 }, (_, i) => ({
      id: `acc-pool-member-${i}@cluster-prod.corp.internal`,
      provider: "codex",
      health: { status: "available" },
      ok: 100 + i,
      fails: 0,
      quota: 10.0 * (i + 1),
      usage: {
        groups: [
          {
            display_name: `Primary Window ${i + 1}`,
            buckets: [{ used_percent: 25.0 * ((i % 4) + 1), label: "5h window" }],
          },
          {
            display_name: `Secondary Pool ${i + 1}`,
            buckets: [{ used_percent: 15.0 * ((i % 5) + 1), label: "7d window" }],
          },
          {
            display_name: `Burst Quota ${i + 1}`,
            buckets: [{ used_percent: 5.0 * ((i % 6) + 1), label: "30d window" }],
          },
        ],
      },
    }));

    await setupMockGateway(page, {
      stats: {
        uptime_secs: 50_000,
        in_flight: 8,
        served: 30_000,
        failed_over: 15,
        refreshed: 50,
        ttft: { p50_ms: 100, p90_ms: 220, p99_ms: 400, samples: 200 },
        accounts: manyAccounts,
      },
      credentials: {
        files: manyAccounts.map((a, i) => ({
          name: `account-${i}.json`,
          auth_index: a.id,
          path: `/auth/account-${i}.json`,
          size: 200,
          label: `Account Pool Member ${i}`,
          type: "codex",
          email: a.id,
          disabled: false,
          unavailable: false,
          runtime_only: false,
        })),
      },
    });

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html");
    await page.getByLabel("Primary navigation").getByText("Accounts").click();

    const count = await page.locator(".account-card").count();
    expect(count).toBe(12);

    const m = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        mainScrollHeight: main?.scrollHeight,
        mainClientHeight: main?.clientHeight,
        mainIsScrollOwner: (main?.scrollHeight ?? 0) > (main?.clientHeight ?? 0),
      };
    });

    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    expect(m.mainIsScrollOwner).toBe(true);

    await page.screenshot({
      path: resolve(stressDir, "many-accounts-many-quota-rows.png"),
      fullPage: false,
    });
    stressMeasurements["stress_many_accounts_quota_rows"] = m;
  });

  test("Stress 5: 10,000 high-volume log lines and inner log containment", async ({ page }) => {
    const tenKLogs = Array.from(
      { length: 10_000 },
      (_, i) =>
        `[${i.toString().padStart(6, "0")}] gateway event ${i} request_id=req_${i} payload=${unbroken256.slice(0, 48)}`,
    );

    await setupMockGateway(page, { logs: tenKLogs });
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/management.html");

    await page.getByLabel("Primary navigation").getByText("Logs").click();
    const logPre = page.locator(".logs-surface pre");
    await expect(logPre).toBeVisible();
    await expect(page.getByText("[009999] gateway event 9999")).toBeVisible();

    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const main = document.querySelector("main");
      return {
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
        docScrollHeight: doc.scrollHeight,
        docClientHeight: doc.clientHeight,
        mainScrollHeight: main?.scrollHeight,
        mainClientHeight: main?.clientHeight,
      };
    });

    expect(m.docScrollWidth).toBeLessThanOrEqual(m.docClientWidth);
    expect(m.docScrollHeight).toBeLessThanOrEqual(m.docClientHeight);

    await page.screenshot({
      path: resolve(stressDir, "10k-logs-containment.png"),
      fullPage: false,
    });
    stressMeasurements["stress_10k_logs_containment"] = m;
  });

  test("Stress 6: Disabled, warning, and error states", async ({ page }) => {
    const errorStats = {
      uptime_secs: 5_000,
      in_flight: 0,
      served: 120,
      failed_over: 8,
      refreshed: 10,
      ttft: { p50_ms: 250, p90_ms: 600, p99_ms: 1200, samples: 30 },
      accounts: [
        {
          id: "acc-cooldown@example.com",
          provider: "kiro",
          health: { status: "cooldown" },
          ok: 10,
          fails: 2,
          reset_at_unix_ms: Date.now() + 600_000,
          usage: {
            groups: [
              {
                display_name: "Cooldown Limit",
                buckets: [{ used_percent: 98.0, label: "5h window" }],
              },
            ],
          },
        },
        {
          id: "acc-disabled@example.com",
          provider: "zcode",
          health: { status: "error" },
          ok: 0,
          fails: 10,
          last_error: { unix_ms: Date.now(), status: 401, message: "Provider authentication rejected credentials" },
          usage: {
            groups: [],
          },
        },
      ],
    };

    const creds = {
      files: [
        {
          name: "acc-cooldown.json",
          auth_index: "acc-cooldown@example.com",
          path: "/auth/acc-cooldown.json",
          size: 200,
          label: "Kiro Cooldown Account",
          type: "kiro",
          email: "acc-cooldown@example.com",
          disabled: false,
          unavailable: false,
          runtime_only: false,
        },
        {
          name: "acc-disabled.json",
          auth_index: "acc-disabled@example.com",
          path: "/auth/acc-disabled.json",
          size: 200,
          label: "ZCode Disabled Account",
          type: "zcode",
          email: "acc-disabled@example.com",
          disabled: true,
          unavailable: true,
          runtime_only: false,
        },
      ],
    };

    await setupMockGateway(page, {
      stats: errorStats,
      credentials: creds,
    });

    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto("/management.html");

    await page.getByLabel("Primary navigation").getByText("Accounts").click();
    await expect(page.locator(".account-card")).toHaveCount(1);

    // Switch to zcode tab to verify second account card
    await page.locator(".provider-tab").filter({ hasText: /zcode/i }).click();
    await expect(page.locator(".account-card")).toHaveCount(1);

    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);

    await page.screenshot({
      path: resolve(stressDir, "disabled-error-states.png"),
      fullPage: false,
    });
    stressMeasurements["stress_disabled_error_states"] = m;
  });

  test("Stress 7: Overlay long content stress (Onboarding and YAML Editor)", async ({ page }) => {
    const longYamlPayload = Array.from(
      { length: 120 },
      (_, i) =>
        `stress_section_${i}:\n  token_key: "tok_${unbroken256.slice(0, 160)}_${i}"\n  endpoint_cluster_url: "https://extreme-scale-cluster-${i}.${unbroken256.slice(0, 60)}.internal.net/v1/stream"\n  max_retries: 5\n`,
    ).join("\n");

    await setupMockGateway(page, { configYaml: longYamlPayload });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/management.html");

    // 1. Onboarding drawer long content
    await page.getByLabel("Mobile navigation").getByText("accounts").click();
    await page.getByRole("button", { name: "Add account" }).click();

    const onboardingDrawer = page.locator(".drawer.onboarding-drawer");
    await expect(onboardingDrawer).toBeVisible();

    const mOnboard = await page.evaluate(() => {
      const doc = document.documentElement;
      const drawer = document.querySelector(".drawer.onboarding-drawer");
      return {
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
        drawerScrollHeight: drawer?.scrollHeight,
        drawerClientHeight: drawer?.clientHeight,
        drawerIsScrollOwner: (drawer?.scrollHeight ?? 0) >= (drawer?.clientHeight ?? 0),
      };
    });

    expect(mOnboard.docScrollWidth).toBeLessThanOrEqual(mOnboard.docClientWidth);
    await page.screenshot({
      path: resolve(stressDir, "overlay-long-content-onboarding.png"),
      fullPage: false,
    });

    await page.getByRole("button", { name: "Close onboarding" }).click();
    await expect(onboardingDrawer).toHaveCount(0);

    // 2. YAML Drawer with extreme unbroken YAML
    await page.getByLabel("Mobile navigation").getByText("settings").click();
    await page.getByRole("button", { name: "Open YAML editor" }).click();

    const configDrawer = page.locator(".drawer.config-drawer");
    await expect(configDrawer).toBeVisible();

    const mYaml = await page.evaluate(() => {
      const doc = document.documentElement;
      const drawer = document.querySelector(".drawer.config-drawer");
      const textarea = document.querySelector("textarea");
      return {
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
        drawerScrollHeight: drawer?.scrollHeight,
        drawerClientHeight: drawer?.clientHeight,
        textareaScrollHeight: textarea?.scrollHeight,
      };
    });

    expect(mYaml.docScrollWidth).toBeLessThanOrEqual(mYaml.docClientWidth);
    await page.screenshot({
      path: resolve(stressDir, "overlay-long-content-yaml.png"),
      fullPage: false,
    });

    await page.getByRole("button", { name: "Close configuration editor" }).click();
    await expect(configDrawer).toHaveCount(0);

    stressMeasurements["stress_overlays_long_content"] = {
      onboarding: mOnboard,
      yaml: mYaml,
    };
  });
});
