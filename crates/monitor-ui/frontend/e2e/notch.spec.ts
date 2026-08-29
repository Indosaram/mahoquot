import { mkdir } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

const evidenceDir = "/tmp/quotio-notch-qa";

const deterministicStats = {
  uptime_secs: 7_200,
  in_flight: 2,
  served: 840,
  failed_over: 4,
  refreshed: 18,
  ttft: { p50_ms: 95, p90_ms: 180, p99_ms: 320, samples: 42 },
  accounts: [
    {
      id: "notch-codex@example.com",
      provider: "codex",
      health: { status: "available" },
      ok: 120,
      fails: 1,
      usage: {
        primary: { used_percent: 35, reset_after_seconds: 1800 },
        reset_credits_available: 2,
      },
    },
    {
      id: "notch-claude@example.com",
      provider: "claude",
      health: { status: "available" },
      ok: 85,
      fails: 0,
      usage: {
        primary: { used_percent: 60, reset_after_seconds: 7200 },
        reset_credits_available: 0,
      },
    },
    {
      id: "notch-cooldown@example.com",
      provider: "antigravity",
      health: { status: "cooldown" },
      reset_at_unix_ms: Date.now() + 300_000,
      ok: 12,
      fails: 3,
      usage: { groups: [{ display_name: "Gemini Pro", buckets: [{ used_percent: 88 }] }] },
    },
  ],
};

const installMocks = async (page: Page) => {
  await page.addInitScript(() => {
    localStorage.setItem("quotio.base", "");
    localStorage.setItem("quotio.key", "relay-test-key");
    localStorage.setItem("quotio.mgmt", "management-test-key");
    window.open = () => null;
  });
  await page.route("**/admin/stats", (route) => route.fulfill({ json: deterministicStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: ["gateway ready"] } }),
  );
};

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
});

test("compact notch surface renders live summary and account rows", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 480 });
  await installMocks(page);
  await page.goto("/management.html?surface=notch");

  const notchSurface = page.locator('[data-quotio-surface="notch"]');
  await expect(notchSurface).toBeVisible();

  // Expect live summary and account rows
  await expect(notchSurface.locator('[data-testid="notch-summary"], .notch-summary, [data-component="summary"]')).toBeVisible();
  await expect(notchSurface.getByText("notch-codex@example.com")).toBeVisible();
  await expect(notchSurface.getByText("notch-claude@example.com")).toBeVisible();
  await expect(notchSurface.getByText("notch-cooldown@example.com")).toBeVisible();

  await page.screenshot({ path: `${evidenceDir}/notch-panel.png` });
});
